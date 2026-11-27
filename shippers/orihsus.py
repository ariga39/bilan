#!/usr/bin/env python3
"""Push OpenCode Go usage and per-key quota history from orihsus.

Upstream sources (read-only, never modified by this shipper)
------------------------------------------------------------
``orihsus`` appends two independent JSONL logs:

* ``audit.jsonl`` — one ``AuditRecord`` per gateway request. The caller identity
  is ``gateway_key`` (not a physical machine); token columns may be JSON
  ``null`` when the request never produced usage or the upstream omitted an
  optional counter. Every canonical line is one HTTP request.

* ``usage/YYYY-MM-DD.jsonl`` — one ``UsageKeySnapshot`` per successful
  five-minute usage poll, keyed by the upstream key's 12-hex
  ``key_fingerprint``. Each line carries ``rolling`` / ``weekly`` / ``monthly``
  window snapshots (``status``, ``percent``, ``resetsAt``). Failed polls are
  never written upstream, so this shipper must never invent an ``error``
  observation for a poll it cannot see.

Mapping onto bilan's unified Push contract
------------------------------------------
Usage buckets (``audit.jsonl``)::

    source          = "opencode"
    account         = "default"
    actor_kind      = "identity"
    actor_id        = AuditRecord.gateway_key (or "unknown" when null)
    model           = AuditRecord.model (or "unknown" when null)
    effort          = "" (orihsus has no reasoning-effort dimension)
    bucket_start    = the complete touched UTC hour
    unit_kind       = "request"
    accounting_basis= "orihsus-audit-v1"

The four core token columns (``input``, ``cached``, ``uncached``, ``output``)
are always reported together by a successful upstream response. Missing any of
them marks one ``coverage_gaps`` unit. ``cache_write`` and ``reasoning`` are
optional upstream counters: a missing value stays ``NULL`` and does not, by
itself, make the bucket partial. Explicit zeros are recorded values and remain
distinct from ``NULL``.

Quota observations (``usage/YYYY-MM-DD.jsonl``)::

    sample_id       = deterministic key from fingerprint + sampled_at + content
    source          = "opencode"
    account         = key_fingerprint
    observer_machine= configured shipper value (default "unknown")
    status          = "ok" when at least one window is reported, else "empty"
    windows[]       = bucket_id = key_fingerprint, slot = rolling/weekly/monthly

A successful poll whose windows are all unreported becomes an ``empty``
observation with no windows; it is *not* converted into 0%/100%. A window that
is absent from a later successful sample is simply omitted, so the read surface
can never derive a ghost window from an older sample. Two samples in the same
second remain distinct through the deterministic content hash.

Durability model
----------------
The local state file persists the next monotonic ``batch_seq``, the consumed
byte cursor for ``audit.jsonl``, one byte cursor per daily usage file, and the
exact in-flight envelope. The envelope is written to disk before the HTTP
attempt. A timeout or lost ACK therefore retries the identical payload with the
identical ``batch_seq``; only an exact HTTP 200 ACK advances the cursors.
Offline backlogs across several daily files are consumed in bounded batches
because every file has its own durable cursor.

Streaming and the active-hour anchor
------------------------------------
Both logs are streamed in bounded chunks, so peak memory follows the number of
distinct usage buckets or the payload size rather than the number of historical
lines. The audit state remembers ``audit_active_hour`` and its earliest byte
offset; append-only ticks rebuild only the touched hours from that anchor, while
an older late record falls back to an exact stream from byte 0. Audit and quota
cursors are bound to the file generation ``(st_dev, st_ino)``; a rotation or
truncation is logged and restarted instead of locking the shipper up.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

if __package__:
    from .common import (  # type: ignore[import-not-found]
        MAX_PAYLOAD_ROWS,
        SCHEMA_VERSION,
        HTTPPushError,
        InstanceLock,
        LockHeldError,
        ShipperError,
        atomic_write_json,
        canonical_json_bytes,
        inspect_source,
        iter_log_lines,
        load_json_file,
        parse_utc_timestamp,
        post_envelope,
        utc_hour_start,
        utc_now_iso,
    )
else:
    from common import (  # type: ignore[no-redef]
        MAX_PAYLOAD_ROWS,
        SCHEMA_VERSION,
        HTTPPushError,
        InstanceLock,
        LockHeldError,
        ShipperError,
        atomic_write_json,
        canonical_json_bytes,
        inspect_source,
        iter_log_lines,
        load_json_file,
        parse_utc_timestamp,
        post_envelope,
        utc_hour_start,
        utc_now_iso,
    )

STATE_VERSION = 4
DEFAULT_PRODUCER_ID = "orihsus-main"
SOURCE = "opencode"
ACCOUNTING_BASIS = "orihsus-audit-v1"
SOURCE_VERSION = "1"
DEFAULT_INTERVAL_SECONDS = 300
DEFAULT_OBSERVER_MACHINE = "unknown"
MAX_BATCH_SEQ = 2**31 - 1

USAGE_FILE_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2})\.jsonl$")
WINDOW_SLOTS = ("rolling", "weekly", "monthly")

# (payload column, AuditRecord field, counted column, required for completeness)
TOKEN_COLUMNS = (
    ("input_tokens", "input_tokens", "input_counted", True),
    ("cached_tokens", "cached_tokens", "cached_counted", True),
    ("uncached_tokens", "uncached_tokens", "uncached_counted", True),
    ("cache_write_tokens", "cache_write_tokens", "cache_write_counted", False),
    ("output_tokens", "output_tokens", "output_counted", True),
    ("reasoning_tokens", "reasoning_tokens", "reasoning_counted", False),
)


# -- small value helpers -----------------------------------------------------


def _iso_seconds(value: datetime) -> str:
    """Render a parsed instant as the canonical UTC second-precision form."""

    return value.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def _optional_utc(value: Any) -> Optional[str]:
    """Canonicalize an optional upstream timestamp, or return ``None``."""

    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return _iso_seconds(parse_utc_timestamp(value))
    except ValueError:
        return None


def _token_value(value: Any) -> Optional[int]:
    """Return a non-negative integer token count, or ``None`` when absent."""

    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0:
        return None
    return value


def _identity(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value
    return "unknown"


def _model(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value
    return "unknown"


def _percent(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0.0 or number > 100.0:
        return None
    return number


def _window_status(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    if normalized == "ok":
        return "ok"
    if normalized in ("rate-limited", "rate_limited", "limited"):
        return "limited"
    if normalized in ("cooldown", "cooling-down", "cooling_down"):
        return "cooldown"
    return "unknown"


# -- audit.jsonl -> usage buckets -------------------------------------------


def _new_audit_accumulator() -> Dict[str, Any]:
    accumulator: Dict[str, Any] = {
        "unit_count": 0,
        "coverage_gaps": 0,
    }
    for payload_column, _record_field, counted_column, _required in TOKEN_COLUMNS:
        accumulator[payload_column] = None
        accumulator[counted_column] = 0
    return accumulator


def _canonical_audit_record(raw: bytes) -> Optional[dict[str, Any]]:
    """Parse one complete audit line, accepting only canonical records."""

    if raw.endswith(b"\r"):
        raw = raw[:-1]
    if not raw.strip():
        return None
    try:
        record = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    request_id = record.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        return None
    status = record.get("status")
    if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
        return None
    try:
        parse_utc_timestamp(record.get("timestamp"))
    except ValueError:
        return None
    return record


def _record_hour(record: dict[str, Any]) -> str:
    return utc_hour_start(parse_utc_timestamp(record["timestamp"]))


def _accumulate_audit_record(
    groups: Dict[tuple[str, str, str], Dict[str, Any]],
    hour: str,
    record: dict[str, Any],
) -> None:
    key = (hour, _identity(record.get("gateway_key")), _model(record.get("model")))
    accumulator = groups.get(key)
    if accumulator is None:
        accumulator = _new_audit_accumulator()
        groups[key] = accumulator

    accumulator["unit_count"] += 1
    missing_required = False
    for payload_column, record_field, counted_column, required in TOKEN_COLUMNS:
        value = _token_value(record.get(record_field))
        if value is None:
            if required:
                missing_required = True
            continue
        current = accumulator[payload_column]
        accumulator[payload_column] = value if current is None else current + value
        accumulator[counted_column] += 1
    if missing_required:
        accumulator["coverage_gaps"] += 1


def _rows_from_audit_groups(
    groups: Dict[tuple[str, str, str], Dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for (hour, actor_id, model), accumulator in sorted(groups.items()):
        row: Dict[str, Any] = {
            "source": SOURCE,
            "account": "default",
            "actor_kind": "identity",
            "actor_id": actor_id,
            "model": model,
            "effort": "",
            "bucket_start": hour,
            "unit_kind": "request",
            "unit_count": accumulator["unit_count"],
            "coverage_gaps": accumulator["coverage_gaps"],
            "accounting_basis": ACCOUNTING_BASIS,
            "source_version": SOURCE_VERSION,
        }
        for payload_column, _record_field, counted_column, _required in TOKEN_COLUMNS:
            row[payload_column] = accumulator[payload_column]
            row[counted_column] = accumulator[counted_column]
        rows.append(row)
    return rows


def aggregate_audit_records(
    records: Iterable[dict[str, Any]],
    touched_hours: Optional[set[str]] = None,
) -> list[dict[str, Any]]:
    """Aggregate canonical audit records into complete UTC-hour buckets.

    ``touched_hours`` restricts output to the hours newly observed, while every
    record in those hours (including earlier lines already consumed) is included
    so each pushed bucket is complete rather than a delta.
    """

    groups: Dict[tuple[str, str, str], Dict[str, Any]] = {}
    for record in records:
        hour = _record_hour(record)
        if touched_hours is not None and hour not in touched_hours:
            continue
        _accumulate_audit_record(groups, hour, record)
    return _rows_from_audit_groups(groups)


def _iter_audit_records(
    audit_path: str, start: int, extent: int
) -> Iterable[dict[str, Any]]:
    for _line_start, _line_end, raw in iter_log_lines(audit_path, start, extent):
        record = _canonical_audit_record(raw)
        if record is not None:
            yield record


def _aggregate_audit_window(
    audit_path: str,
    start: int,
    extent: int,
    touched_hours: set[str],
) -> tuple[list[dict[str, Any]], Dict[str, int]]:
    groups: Dict[tuple[str, str, str], Dict[str, Any]] = {}
    first_offsets: Dict[str, int] = {}
    for line_start, _line_end, raw in iter_log_lines(audit_path, start, extent):
        record = _canonical_audit_record(raw)
        if record is None:
            continue
        hour = _record_hour(record)
        # Keep every hour's first offset so a late-only fallback scan can
        # preserve the prior latest hour and its true earliest contribution.
        first_offsets.setdefault(hour, line_start)
        if hour not in touched_hours:
            continue
        _accumulate_audit_record(groups, hour, record)
    return _rows_from_audit_groups(groups), first_offsets


def _require_audit_log(audit_path: str) -> None:
    """Refuse to run when the audit source is absent or not a regular file."""

    if not os.path.exists(audit_path):
        raise ShipperError("audit log not found; refusing to send a heartbeat")
    if not os.path.isfile(audit_path):
        raise ShipperError("audit log path is not a file")


def _warn(message: str) -> None:
    print("orihsus-shipper: %s" % message, file=sys.stderr)


def _capture_audit_work(
    audit_path: str,
    state: Dict[str, Any],
    extent: int,
) -> tuple[list[dict[str, Any]], Optional[Dict[str, Any]]]:
    """Aggregate the touched audit hours from the captured complete-line extent.

    Returns the rows and the new position to commit once those rows are ACKed
    (``None`` when no source bytes were captured). The anchor only moves to the
    earliest byte offset that contributes to the new active hour.
    """

    cursor = state["audit_cursor"]
    if extent <= cursor:
        return [], None
    touched_hours = {
        _record_hour(record) for record in _iter_audit_records(audit_path, cursor, extent)
    }
    active_hour = state["audit_active_hour"]
    anchor = state["audit_active_hour_offset"]
    if not touched_hours:
        return [], {
            "cursor": extent,
            "active_hour": active_hour,
            "active_hour_offset": anchor,
            "file_id": state["audit_file_id"],
        }

    start = anchor if active_hour is not None and min(touched_hours) >= active_hour else 0
    rows, first_offsets = _aggregate_audit_window(audit_path, start, extent, touched_hours)
    # Anchor on the latest hour known so far at its earliest contribution. A
    # multi-hour bootstrap must not anchor warm ticks to the oldest hour.
    new_active_hour = max(first_offsets)
    new_anchor = first_offsets[new_active_hour]
    if active_hour is not None and active_hour > new_active_hour:
        new_active_hour = active_hour
        new_anchor = anchor
    return rows, {
        "cursor": extent,
        "active_hour": new_active_hour,
        "active_hour_offset": new_anchor,
        "file_id": state["audit_file_id"],
    }


# -- usage/YYYY-MM-DD.jsonl -> quota observations ---------------------------


def _key_alias(value: Any) -> Optional[str]:
    """Return the upstream display alias, never key material.

    ``usage/YYYY-MM-DD.jsonl`` contains a redacted key fingerprint and may
    optionally carry ``key_alias``. Raw keys are never read or accepted here.
    """

    if not isinstance(value, str):
        return None
    alias = value.strip()
    if not alias or len(alias) > 128:
        return None
    return alias


def _window_row(
    fingerprint: str,
    slot: str,
    window: dict[str, Any],
    label: Optional[str],
) -> Optional[dict[str, Any]]:
    """Map one upstream window, or return ``None`` when it was not reported."""

    used = _percent(window.get("percent"))
    status = _window_status(window.get("status"))
    resets_at = _optional_utc(window.get("resetsAt"))
    if used is None and status is None and resets_at is None:
        # A successful poll may still omit a window entirely. Omitting it here
        # is what makes a disappeared window vanish on the read surface.
        return None
    return {
        "bucket_id": fingerprint,
        "slot": slot,
        "label": label,
        "used_percent": used,
        "remaining_percent": None if used is None else round(100.0 - used, 6),
        "status": status,
        "resets_at": resets_at,
    }


def _sample_id(fingerprint: str, sampled_at: str, record: dict[str, Any]) -> str:
    """Build a deterministic sample ID that survives same-second polls.

    The content hash distinguishes two polls taken in the same second (or even
    at the same millisecond) while remaining stable across a replay or a host
    migration that copies the same log.
    """

    digest = hashlib.sha256(canonical_json_bytes(record)).hexdigest()[:16]
    return "opencode:%s:%s:%s" % (fingerprint, sampled_at, digest)


def _parse_usage_line(
    raw: bytes,
    interval_seconds: int,
    observer_machine: str,
) -> Optional[dict[str, Any]]:
    """Parse one usage-history line into a quota observation, if canonical."""

    if raw.endswith(b"\r"):
        raw = raw[:-1]
    if not raw.strip():
        return None
    try:
        record = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(record, dict):
        return None
    fingerprint = record.get("key_fingerprint")
    if not isinstance(fingerprint, str) or not fingerprint.strip():
        return None
    fingerprint = fingerprint.strip()
    try:
        sampled_at = _iso_seconds(parse_utc_timestamp(record.get("timestamp")))
    except ValueError:
        return None
    label = _key_alias(record.get("key_alias"))

    windows = []
    for slot in WINDOW_SLOTS:
        window = record.get(slot)
        if not isinstance(window, dict):
            continue
        row = _window_row(fingerprint, slot, window, label)
        if row is not None:
            windows.append(row)

    return {
        "sample_id": _sample_id(fingerprint, sampled_at, record),
        "source": SOURCE,
        "account": fingerprint,
        "observer_machine": observer_machine,
        "sampled_at": sampled_at,
        "interval_seconds": interval_seconds,
        "status": "ok" if windows else "empty",
        "time_anomaly": None,
        "error_summary": None,
        "windows": windows,
    }


def _usage_files(usage_dir: str) -> list[tuple[str, str]]:
    """Return strictly daily ``YYYY-MM-DD.jsonl`` files in deterministic order."""

    try:
        entries = os.listdir(usage_dir)
    except FileNotFoundError:
        return []
    files = []
    for name in entries:
        match = USAGE_FILE_PATTERN.match(name)
        if match is None:
            continue
        path = os.path.join(usage_dir, name)
        if not os.path.isfile(path):
            continue
        files.append((match.group(1), path))
    files.sort(key=lambda item: item[0])
    return files


def _prepare_usage_files(
    usage_dir: str,
    cursors: Dict[str, int],
    files: Dict[str, list[int]],
) -> list[tuple[str, str, int, int]]:
    """Reset rotated daily files and capture their complete-line extents.

    Returns ``(day, path, cursor, extent)`` for every file with unread complete
    lines. Rotated or truncated files are warned about and restarted from zero.
    """

    prepared: list[tuple[str, str, int, int]] = []
    for day, path in _usage_files(usage_dir):
        cursor = cursors.get(day, 0)
        try:
            info = os.stat(path)
        except FileNotFoundError:
            continue
        identity = [info.st_dev, info.st_ino]
        previous = files.get(day)
        restarted = cursor > info.st_size or (
            previous is not None and list(previous) != identity
        )
        if restarted:
            _warn(
                "usage file %s.jsonl was rotated or truncated; restarting from byte 0" % day
            )
            cursor = 0
            cursors[day] = 0
        extent, identity, shrank = inspect_source(path, cursor, None)
        if shrank:
            _warn(
                "usage file %s.jsonl was rotated or truncated; restarting from byte 0" % day
            )
            cursor = 0
            cursors[day] = 0
            extent, identity, _ = inspect_source(path, 0, None)
        files[day] = identity
        if extent > cursor:
            prepared.append((day, path, cursor, extent))
    return prepared


def _iter_quota_items(
    prepared: Iterable[tuple[str, str, int, int]],
    interval_seconds: int,
    observer_machine: str,
) -> Iterable[tuple[Optional[dict[str, Any]], str, int]]:
    """Stream usage lines as ``(observation_or_none, day, line_end)``.

    A ``None`` observation still consumed a complete line (malformed or
    unknown); its cursor advance belongs to the batch that is being filled.
    """

    for day, path, cursor, extent in prepared:
        for _line_start, line_end, raw in iter_log_lines(path, cursor, extent):
            yield (
                _parse_usage_line(raw, interval_seconds, observer_machine),
                day,
                line_end,
            )


# -- durable state & transport ----------------------------------------------


def _default_state_path(audit_path: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(audit_path)), ".bilan-orihsus-state.json")


def _validate_cursors(value: Any, label: str) -> Dict[str, int]:
    if not isinstance(value, dict):
        raise ShipperError("invalid %s in shipper state" % label)
    validated: Dict[str, int] = {}
    for day, cursor in value.items():
        if not isinstance(day, str) or not day:
            raise ShipperError("invalid %s in shipper state" % label)
        if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
            raise ShipperError("invalid %s in shipper state" % label)
        validated[day] = cursor
    return validated


def _normalize_identity(value: Any) -> Optional[list[int]]:
    if value is None:
        return None
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 2
        or any(isinstance(part, bool) or not isinstance(part, int) for part in value)
    ):
        raise ShipperError("invalid file identity in shipper state")
    return [int(value[0]), int(value[1])]


def _normalize_files(value: Any) -> Dict[str, list[int]]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ShipperError("invalid usage file identities in shipper state")
    normalized: Dict[str, list[int]] = {}
    for day, identity in value.items():
        if not isinstance(day, str) or not day:
            raise ShipperError("invalid usage file identities in shipper state")
        normalized_identity = _normalize_identity(identity)
        if normalized_identity is None:
            raise ShipperError("invalid usage file identities in shipper state")
        normalized[day] = normalized_identity
    return normalized


def _normalize_anchor(active: Any, offset: Any, cursor: int) -> tuple[Optional[str], int]:
    if active is not None and not isinstance(active, str):
        raise ShipperError("invalid audit active hour in shipper state")
    if (
        isinstance(offset, bool)
        or not isinstance(offset, int)
        or offset < 0
        or offset > cursor
        or (active is None and offset != 0)
    ):
        raise ShipperError("invalid audit active hour anchor in shipper state")
    return active, offset


def _load_state(state_path: str, producer_id: str) -> Dict[str, Any]:
    raw = load_json_file(state_path)
    if raw is None:
        return {
            "version": STATE_VERSION,
            "producer_id": producer_id,
            "batch_seq": 0,
            "audit_cursor": 0,
            "audit_active_hour": None,
            "audit_active_hour_offset": 0,
            "audit_file_id": None,
            "usage_cursors": {},
            "usage_files": {},
            "pending": None,
        }
    if not isinstance(raw, dict) or raw.get("version") not in (3, STATE_VERSION):
        raise ShipperError("unsupported shipper state version")
    if raw.get("producer_id") != producer_id:
        raise ShipperError(
            "state file belongs to producer %r, not %r; use a separate state file"
            % (raw.get("producer_id"), producer_id)
        )
    batch_seq = raw.get("batch_seq")
    audit_cursor = raw.get("audit_cursor")
    if isinstance(batch_seq, bool) or not isinstance(batch_seq, int) or batch_seq < 0:
        raise ShipperError("invalid batch_seq in shipper state")
    if isinstance(audit_cursor, bool) or not isinstance(audit_cursor, int) or audit_cursor < 0:
        raise ShipperError("invalid audit_cursor in shipper state")

    # v3 kept full-prefix hashes and an in-flight extent. They are obsolete;
    # the cursor, active anchor, and durable outbox remain authoritative.
    raw["version"] = STATE_VERSION
    raw.pop("audit_prefix_sha256", None)
    raw.pop("audit_inflight_extent_cursor", None)
    raw.pop("audit_inflight_extent_sha256", None)
    active, offset = _normalize_anchor(
        raw.get("audit_active_hour"), raw.get("audit_active_hour_offset", 0), audit_cursor
    )
    raw["audit_active_hour"] = active
    raw["audit_active_hour_offset"] = offset
    raw["audit_file_id"] = _normalize_identity(raw.get("audit_file_id"))
    raw["usage_cursors"] = _validate_cursors(raw.get("usage_cursors"), "usage_cursors")
    raw["usage_files"] = _normalize_files(raw.get("usage_files"))

    pending = raw.get("pending")
    if pending is not None:
        if not isinstance(pending, dict):
            raise ShipperError("invalid pending outbox in shipper state")
        pending_seq = pending.get("batch_seq")
        pending_audit_cursor = pending.get("audit_cursor_after")
        payload = pending.get("payload")
        if (
            isinstance(pending_seq, bool)
            or not isinstance(pending_seq, int)
            or pending_seq <= batch_seq
            or isinstance(pending_audit_cursor, bool)
            or not isinstance(pending_audit_cursor, int)
            or pending_audit_cursor < audit_cursor
            or not isinstance(payload, dict)
        ):
            raise ShipperError("invalid pending outbox in shipper state")
        if payload.get("batch_seq") != pending_seq:
            raise ShipperError("pending outbox batch_seq does not match its payload")
        for obsolete in (
            "audit_prefix_sha256_after",
            "audit_extent_cursor",
            "audit_extent_sha256",
        ):
            pending.pop(obsolete, None)
        pending_active, pending_offset = _normalize_anchor(
            pending.get("audit_active_hour"),
            pending.get("audit_active_hour_offset", 0),
            pending_audit_cursor,
        )
        pending["audit_active_hour"] = pending_active
        pending["audit_active_hour_offset"] = pending_offset
        pending["audit_file_id"] = _normalize_identity(pending.get("audit_file_id"))
        pending["usage_cursors_after"] = _validate_cursors(
            pending.get("usage_cursors_after"), "usage_cursors_after"
        )
        pending["usage_files_after"] = _normalize_files(pending.get("usage_files_after"))
    return raw


def _save_state(state_path: str, state: Dict[str, Any]) -> None:
    atomic_write_json(state_path, state)


def _envelope(
    batch_seq: int,
    usage_buckets: list[dict[str, Any]],
    quota_observations: list[dict[str, Any]],
) -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "batch_seq": batch_seq,
        "usage_buckets": usage_buckets,
        "quota_observations": quota_observations,
        "balance_snapshots": [],
    }


def _send_once(endpoint: str, token: str, payload: Dict[str, Any], timeout: float) -> None:
    post_envelope(endpoint, token, payload, timeout_seconds=timeout)


def _apply_pending(state: Dict[str, Any]) -> None:
    pending = state["pending"]
    state["batch_seq"] = pending["batch_seq"]
    state["audit_cursor"] = pending["audit_cursor_after"]
    state["audit_active_hour"] = pending.get("audit_active_hour")
    state["audit_active_hour_offset"] = pending.get("audit_active_hour_offset", 0)
    state["audit_file_id"] = pending.get("audit_file_id")
    state["usage_cursors"] = dict(pending["usage_cursors_after"])
    state["usage_files"] = dict(pending.get("usage_files_after") or {})
    state["pending"] = None


def _send_pending(
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    timeout: float,
    quiet: bool,
) -> bool:
    """Replay the persisted envelope verbatim before the sources are read."""

    pending = state["pending"]
    sequence = pending["batch_seq"]
    try:
        _send_once(endpoint, token, pending["payload"], timeout)
    except HTTPPushError as exc:
        print(
            "orihsus-shipper: pending batch_seq %d not acknowledged: %s" % (sequence, exc),
            file=sys.stderr,
        )
        return False
    _apply_pending(state)
    _save_state(state_path, state)
    if not quiet:
        payload = pending["payload"]
        buckets = len(payload.get("usage_buckets") or [])
        observations = len(payload.get("quota_observations") or [])
        if buckets or observations:
            print(
                "orihsus-shipper: ACKed pending batch_seq %d (%d bucket(s), %d observation(s))"
                % (sequence, buckets, observations)
            )
        else:
            print("orihsus-shipper: ACKed pending heartbeat batch_seq %d" % sequence)
    return True


def _send_batch(
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    usage_rows: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    audit_after: Optional[Dict[str, Any]],
    usage_cursors_after: Dict[str, int],
    usage_files_after: Dict[str, list[int]],
    timeout: float,
    quiet: bool,
) -> bool:
    sequence = state["batch_seq"] + 1
    if sequence > MAX_BATCH_SEQ:
        raise ShipperError("batch_seq exceeded the supported integer range")
    pending = {
        "batch_seq": sequence,
        "payload": _envelope(sequence, usage_rows, observations),
        "audit_cursor_after": (
            audit_after["cursor"] if audit_after is not None else state["audit_cursor"]
        ),
        "audit_active_hour": (
            audit_after["active_hour"]
            if audit_after is not None
            else state["audit_active_hour"]
        ),
        "audit_active_hour_offset": (
            audit_after["active_hour_offset"]
            if audit_after is not None
            else state["audit_active_hour_offset"]
        ),
        "audit_file_id": (
            audit_after["file_id"] if audit_after is not None else state["audit_file_id"]
        ),
        "usage_cursors_after": dict(usage_cursors_after),
        "usage_files_after": dict(usage_files_after),
        "created_at": utc_now_iso(),
    }
    state["pending"] = pending
    # Persist the exact in-flight batch before the first network attempt.
    _save_state(state_path, state)

    try:
        _send_once(endpoint, token, pending["payload"], timeout)
    except HTTPPushError as exc:
        print(
            "orihsus-shipper: batch_seq %d not acknowledged: %s" % (sequence, exc),
            file=sys.stderr,
        )
        return False
    _apply_pending(state)
    _save_state(state_path, state)
    if not quiet:
        if usage_rows or observations:
            print(
                "orihsus-shipper: sent %d usage bucket(s) and %d quota observation(s) as batch_seq %d"
                % (len(usage_rows), len(observations), sequence)
            )
        else:
            print("orihsus-shipper: sent idle heartbeat as batch_seq %d" % sequence)
    return True


def _ship_work(
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    audit_rows: list[dict[str, Any]],
    audit_after: Optional[Dict[str, Any]],
    quota_items: Iterable[tuple[Optional[dict[str, Any]], str, int]],
    cursors: Dict[str, int],
    files: Dict[str, list[int]],
    timeout: float,
    quiet: bool,
) -> tuple[bool, bool]:
    """Pack audit rows and streamed quota observations into contract batches.

    Only a batch's exact payload and its cursor advances are persisted before
    the request, so an ACK (or a duplicate replay) moves every offset safely.
    """

    audit_index = 0
    usage_chunk: list[dict[str, Any]] = []
    observation_chunk: list[dict[str, Any]] = []
    seen: set[str] = set()
    used = 0
    cursor_updates: Dict[str, int] = {}
    audit_committed = False
    sent_any = False

    def flush() -> bool:
        nonlocal audit_index, usage_chunk, observation_chunk, seen, used
        nonlocal cursor_updates, cursors, audit_committed, sent_any
        target = (
            audit_after
            if audit_after is not None and not audit_committed and audit_index >= len(audit_rows)
            else None
        )
        merged_cursors = dict(cursors)
        merged_cursors.update(cursor_updates)
        rows = list(usage_chunk)
        observations = list(observation_chunk)

        if not rows and not observations:
            # Only complete non-canonical or duplicate lines were consumed.
            # Nothing needs delivery, so advancing local offsets is safe.
            changed = (
                target is not None
                or merged_cursors != state["usage_cursors"]
                or files != state["usage_files"]
            )
            cursors = merged_cursors
            if changed:
                state["usage_cursors"] = dict(merged_cursors)
                state["usage_files"] = dict(files)
                if target is not None:
                    state["audit_cursor"] = target["cursor"]
                    state["audit_active_hour"] = target["active_hour"]
                    state["audit_active_hour_offset"] = target["active_hour_offset"]
                    state["audit_file_id"] = target["file_id"]
                    audit_committed = True
                _save_state(state_path, state)
            usage_chunk = []
            observation_chunk = []
            seen = set()
            used = 0
            cursor_updates = {}
            return True

        if not _send_batch(
            endpoint,
            token,
            state_path,
            state,
            rows,
            observations,
            target,
            merged_cursors,
            files,
            timeout,
            quiet,
        ):
            return False
        sent_any = True
        if target is not None:
            audit_committed = True
        cursors = merged_cursors
        usage_chunk = []
        observation_chunk = []
        seen = set()
        used = 0
        cursor_updates = {}
        return True

    quota_iter = iter(quota_items)
    pending_item: Optional[tuple[Optional[dict[str, Any]], str, int]] = None
    quota_done = False
    while True:
        if audit_index < len(audit_rows) and used < MAX_PAYLOAD_ROWS:
            usage_chunk.append(audit_rows[audit_index])
            audit_index += 1
            used += 1
            continue
        if pending_item is None and not quota_done:
            try:
                pending_item = next(quota_iter)
            except StopIteration:
                quota_done = True
        if pending_item is None:
            if audit_index < len(audit_rows):
                # The quota stream is exhausted but audit rows still need room.
                if not flush():
                    return False, sent_any
                continue
            break
        observation, day, line_end = pending_item
        if observation is None or observation["sample_id"] in seen:
            # Consumed but not deliverable; its offset belongs to this batch.
            cursor_updates[day] = line_end
            pending_item = None
            continue
        cost = 1 + len(observation.get("windows") or [])
        if used + cost > MAX_PAYLOAD_ROWS:
            if not flush():
                return False, sent_any
            continue
        observation_chunk.append(observation)
        seen.add(observation["sample_id"])
        used += cost
        cursor_updates[day] = line_end
        pending_item = None

    if not flush():
        return False, sent_any
    return True, sent_any


def run_once(
    audit_path: str,
    usage_dir: str,
    state_path: str,
    producer_id: str,
    endpoint: str,
    token: str,
    interval_seconds: int,
    observer_machine: str,
    heartbeat: bool,
    timeout: float,
    quiet: bool = False,
) -> bool:
    state = _load_state(state_path, producer_id)

    pending_acked = False
    if state["pending"] is not None:
        if not _send_pending(endpoint, token, state_path, state, timeout, quiet):
            return False
        pending_acked = True

    # The immutable outbox is replayed before the audit source is touched, so
    # a missing or rotated input cannot block an already-built batch.
    _require_audit_log(audit_path)

    extent, identity, restarted = inspect_source(
        audit_path, state["audit_cursor"], state["audit_file_id"]
    )
    if restarted:
        _warn("audit log was rotated or truncated; restarting from byte 0")
        state["audit_cursor"] = 0
        state["audit_active_hour"] = None
        state["audit_active_hour_offset"] = 0
        extent, identity, _ = inspect_source(audit_path, 0, identity)
        state["audit_file_id"] = identity
        # Persist the generation change before any later failure or idle run.
        _save_state(state_path, state)
    else:
        state["audit_file_id"] = identity

    usage_rows, audit_after = _capture_audit_work(audit_path, state, extent)

    cursors = dict(state["usage_cursors"])
    files = dict(state["usage_files"])
    prepared = _prepare_usage_files(usage_dir, cursors, files)
    ok, sent_any = _ship_work(
        endpoint,
        token,
        state_path,
        state,
        usage_rows,
        audit_after,
        _iter_quota_items(prepared, interval_seconds, observer_machine),
        cursors,
        files,
        timeout,
        quiet,
    )
    if not ok:
        return False
    # An ACKed pending batch already refreshed producer liveness for this run.
    if sent_any or pending_acked or not heartbeat:
        return True
    # Use the offsets _ship_work may have advanced locally (for consumed
    # non-canonical or duplicate lines) instead of the pre-run copies.
    return _send_batch(
        endpoint,
        token,
        state_path,
        state,
        [],
        [],
        None,
        dict(state["usage_cursors"]),
        dict(state["usage_files"]),
        timeout,
        quiet,
    )


# -- command line -----------------------------------------------------------


def _read_token(argument: Optional[str], token_file: Optional[str]) -> Optional[str]:
    if argument:
        return argument
    if token_file:
        try:
            with open(token_file, "r", encoding="utf-8") as handle:
                token = handle.readline().strip()
        except OSError as exc:
            raise ShipperError("cannot read token file: %s" % exc.__class__.__name__) from exc
        return token or None
    return os.environ.get("BILAN_INGEST_TOKEN") or None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Push orihsus OpenCode Go usage and per-key quota history to bilan-ingest.",
    )
    parser.add_argument(
        "--audit-file",
        required=True,
        help="path to orihsus's audit.jsonl",
    )
    parser.add_argument(
        "--usage-dir",
        required=True,
        help="path to orihsus's usage/ directory of YYYY-MM-DD.jsonl files",
    )
    parser.add_argument(
        "--state-file",
        help="durable cursor/outbox path (default: next to audit.jsonl)",
    )
    parser.add_argument(
        "--producer-id",
        default=DEFAULT_PRODUCER_ID,
        help="stable logical producer identity, never a hostname (default: %(default)s)",
    )
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("BILAN_INGEST_URL"),
        help="bilan-ingest POST /api/v1/ingest URL (or BILAN_INGEST_URL)",
    )
    parser.add_argument(
        "--token",
        help="scoped Bearer token (or BILAN_INGEST_TOKEN; prefer --token-file)",
    )
    parser.add_argument(
        "--token-file",
        help="file containing the scoped Bearer token on its first line",
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=DEFAULT_INTERVAL_SECONDS,
        help="configured usage-poll interval for staleness (default: %(default)s)",
    )
    parser.add_argument(
        "--observer-machine",
        default=DEFAULT_OBSERVER_MACHINE,
        help="host label recorded on quota observations (default: %(default)s)",
    )
    parser.add_argument(
        "--no-heartbeat",
        action="store_true",
        help="do not send an empty liveness envelope when there is no new data",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="HTTP timeout in seconds (default: %(default)s)",
    )
    parser.add_argument("--quiet", action="store_true", help="suppress success messages")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.endpoint:
        parser.error("--endpoint or BILAN_INGEST_URL is required")
    if not args.endpoint.lower().startswith(("http://", "https://")):
        parser.error("--endpoint must be an http(s) URL")
    if not args.producer_id.strip():
        parser.error("--producer-id must not be empty")
    if args.interval_seconds <= 0:
        parser.error("--interval-seconds must be positive")
    if not args.observer_machine.strip():
        parser.error("--observer-machine must not be empty")
    try:
        token = _read_token(args.token, args.token_file)
    except ShipperError as exc:
        print("orihsus-shipper: %s" % exc, file=sys.stderr)
        return 1
    if not token:
        parser.error("--token, --token-file, or BILAN_INGEST_TOKEN is required")

    audit_path = os.path.abspath(args.audit_file)
    usage_dir = os.path.abspath(args.usage_dir)
    state_path = os.path.abspath(args.state_file or _default_state_path(audit_path))
    lock_path = state_path + ".lock"

    try:
        with InstanceLock(lock_path):
            ok = run_once(
                audit_path=audit_path,
                usage_dir=usage_dir,
                state_path=state_path,
                producer_id=args.producer_id,
                endpoint=args.endpoint,
                token=token,
                interval_seconds=args.interval_seconds,
                observer_machine=args.observer_machine.strip(),
                heartbeat=not args.no_heartbeat,
                timeout=args.timeout,
                quiet=args.quiet,
            )
    except LockHeldError as exc:
        print("orihsus-shipper: %s" % exc, file=sys.stderr)
        return 1
    except ShipperError as exc:
        print("orihsus-shipper: %s" % exc, file=sys.stderr)
        return 1
    except OSError as exc:
        print("orihsus-shipper: local I/O failure: %s" % exc.__class__.__name__, file=sys.stderr)
        return 1
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
