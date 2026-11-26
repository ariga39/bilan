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
Offline backlogs across several daily files are consumed in one tick because
every file has its own durable cursor.
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
        load_json_file,
        parse_utc_timestamp,
        post_envelope,
        utc_hour_start,
        utc_now_iso,
    )

STATE_VERSION = 3
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


def _read_audit_records_to_extent(audit_path: str, extent: int) -> list[dict[str, Any]]:
    """Read canonical records from the captured complete-line extent only."""

    try:
        size = os.path.getsize(audit_path)
    except FileNotFoundError as exc:
        raise ShipperError("audit log disappeared while aggregating") from exc
    if extent > size:
        raise ShipperError(
            "audit log is shorter than the captured extent; "
            "refusing to aggregate a replacement"
        )
    remaining = extent
    buffer = b""
    records: list[dict[str, Any]] = []
    with open(audit_path, "rb") as handle:
        while remaining > 0:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ShipperError(
                    "audit log ended before the captured extent; "
                    "refusing to aggregate a replacement"
                )
            remaining -= len(chunk)
            buffer += chunk
            while True:
                newline = buffer.find(b"\n")
                if newline < 0:
                    break
                raw, buffer = buffer[:newline], buffer[newline + 1 :]
                record = _canonical_audit_record(raw)
                if record is not None:
                    records.append(record)
    return records


def _record_hour(record: dict[str, Any]) -> str:
    return utc_hour_start(parse_utc_timestamp(record["timestamp"]))


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


EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def _is_sha256_hex(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _require_audit_log(audit_path: str) -> None:
    """Refuse to run when the audit source is absent or not a regular file."""

    if not os.path.exists(audit_path):
        raise ShipperError("audit log not found; refusing to send a heartbeat")
    if not os.path.isfile(audit_path):
        raise ShipperError("audit log path is not a file")


def _prefix_sha256(audit_path: str, size: int) -> str:
    """Hash exactly the consumed audit prefix so rewrites fail closed."""

    digest = hashlib.sha256()
    remaining = size
    try:
        with open(audit_path, "rb") as handle:
            while remaining > 0:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ShipperError(
                        "audit log ended before the saved cursor; "
                        "refusing to replay complete hourly totals"
                    )
                digest.update(chunk)
                remaining -= len(chunk)
    except FileNotFoundError as exc:
        raise ShipperError(
            "audit log disappeared; refusing to replay complete hourly totals"
        ) from exc
    return digest.hexdigest()


def _verify_audit_prefix(audit_path: str, cursor: int, expected: str) -> None:
    try:
        size = os.path.getsize(audit_path)
    except FileNotFoundError as exc:
        raise ShipperError(
            "audit log disappeared; refusing to replay complete hourly totals"
        ) from exc
    if cursor > size:
        raise ShipperError(
            "audit log shrank below the saved cursor; refusing to replay because "
            "complete hourly totals could be overwritten"
        )
    actual = _prefix_sha256(audit_path, cursor)
    if actual != expected:
        raise ShipperError(
            "audit log prefix changed below the saved cursor; refusing to replay because "
            "complete hourly totals could be overwritten"
        )


def _read_appended_audit(
    audit_path: str,
    cursor: int,
) -> tuple[list[dict[str, Any]], int, str]:
    """Read complete appended audit lines and return (records, new_cursor, new_hash)."""

    try:
        size = os.path.getsize(audit_path)
    except FileNotFoundError as exc:
        raise ShipperError("audit log disappeared while reading") from exc
    if cursor > size:
        raise ShipperError(
            "audit log shrank below the saved cursor; refusing to replay because "
            "complete hourly totals could be overwritten"
        )

    try:
        with open(audit_path, "rb") as handle:
            handle.seek(cursor)
            appended = handle.read()
    except FileNotFoundError as exc:
        raise ShipperError("audit log disappeared while reading") from exc

    last_newline = appended.rfind(b"\n")
    if last_newline < 0:
        return [], cursor, _prefix_sha256(audit_path, cursor)
    complete = appended[: last_newline + 1]
    records = []
    for raw in complete.split(b"\n"):
        if not raw:
            continue
        record = _canonical_audit_record(raw)
        if record is not None:
            records.append(record)
    next_cursor = cursor + len(complete)
    return records, next_cursor, _prefix_sha256(audit_path, next_cursor)


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


def _read_appended_usage(
    path: str,
    cursor: int,
    interval_seconds: int,
    observer_machine: str,
) -> tuple[list[dict[str, Any]], int, bool]:
    """Read complete appended usage lines and return (observations, cursor, reset)."""

    try:
        size = os.path.getsize(path)
    except FileNotFoundError:
        return [], cursor, False
    reset = False
    if cursor > size:
        cursor = 0
        reset = True
        size = os.path.getsize(path)

    try:
        with open(path, "rb") as handle:
            handle.seek(cursor)
            appended = handle.read()
    except FileNotFoundError:
        return [], cursor, reset

    last_newline = appended.rfind(b"\n")
    if last_newline < 0:
        return [], cursor, reset
    complete = appended[: last_newline + 1]
    observations = []
    for raw in complete.split(b"\n"):
        if not raw:
            continue
        observation = _parse_usage_line(raw, interval_seconds, observer_machine)
        if observation is not None:
            observations.append(observation)
    return observations, cursor + len(complete), reset


def _read_usage_backlog(
    usage_dir: str,
    cursors: Dict[str, int],
    interval_seconds: int,
    observer_machine: str,
) -> tuple[list[dict[str, Any]], Dict[str, int], list[str]]:
    """Read every daily file from its own cursor, covering an offline backlog."""

    observations: list[dict[str, Any]] = []
    updated = dict(cursors)
    reset_days: list[str] = []
    for day, path in _usage_files(usage_dir):
        records, next_cursor, reset = _read_appended_usage(
            path,
            cursors.get(day, 0),
            interval_seconds,
            observer_machine,
        )
        updated[day] = next_cursor
        if reset:
            reset_days.append(day)
        observations.extend(records)
    observations.sort(key=lambda item: (item["sampled_at"], item["sample_id"]))
    return observations, updated, reset_days


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


def _load_state(state_path: str, producer_id: str) -> Dict[str, Any]:
    raw = load_json_file(state_path)
    if raw is None:
        return {
            "version": STATE_VERSION,
            "producer_id": producer_id,
            "batch_seq": 0,
            "audit_cursor": 0,
            "audit_prefix_sha256": EMPTY_SHA256,
            "audit_inflight_extent_cursor": None,
            "audit_inflight_extent_sha256": None,
            "usage_cursors": {},
            "pending": None,
        }
    if not isinstance(raw, dict) or raw.get("version") != STATE_VERSION:
        raise ShipperError("unsupported shipper state version")
    if raw.get("producer_id") != producer_id:
        raise ShipperError(
            "state file belongs to producer %r, not %r; use a separate state file"
            % (raw.get("producer_id"), producer_id)
        )
    batch_seq = raw.get("batch_seq")
    audit_cursor = raw.get("audit_cursor")
    audit_prefix = raw.get("audit_prefix_sha256")
    if isinstance(batch_seq, bool) or not isinstance(batch_seq, int) or batch_seq < 0:
        raise ShipperError("invalid batch_seq in shipper state")
    if isinstance(audit_cursor, bool) or not isinstance(audit_cursor, int) or audit_cursor < 0:
        raise ShipperError("invalid audit_cursor in shipper state")
    if not _is_sha256_hex(audit_prefix):
        raise ShipperError("invalid audit_prefix_sha256 in shipper state")
    if audit_cursor == 0 and audit_prefix != EMPTY_SHA256:
        raise ShipperError("audit_prefix_sha256 does not match the empty cursor")
    inflight_cursor = raw.get("audit_inflight_extent_cursor")
    inflight_hash = raw.get("audit_inflight_extent_sha256")
    if (inflight_cursor is None) != (inflight_hash is None):
        raise ShipperError("invalid audit in-flight extent in shipper state")
    if inflight_cursor is not None:
        if (
            isinstance(inflight_cursor, bool)
            or not isinstance(inflight_cursor, int)
            or inflight_cursor < audit_cursor
            or not _is_sha256_hex(inflight_hash)
        ):
            raise ShipperError("invalid audit in-flight extent in shipper state")
    _validate_cursors(raw.get("usage_cursors"), "usage_cursors")

    pending = raw.get("pending")
    if pending is not None:
        if not isinstance(pending, dict):
            raise ShipperError("invalid pending outbox in shipper state")
        pending_seq = pending.get("batch_seq")
        pending_audit_cursor = pending.get("audit_cursor_after")
        pending_audit_prefix = pending.get("audit_prefix_sha256_after")
        pending_extent_cursor = pending.get("audit_extent_cursor")
        pending_extent_prefix = pending.get("audit_extent_sha256")
        payload = pending.get("payload")
        if (
            isinstance(pending_seq, bool)
            or not isinstance(pending_seq, int)
            or pending_seq <= batch_seq
            or isinstance(pending_audit_cursor, bool)
            or not isinstance(pending_audit_cursor, int)
            or pending_audit_cursor < 0
            or not _is_sha256_hex(pending_audit_prefix)
            or isinstance(pending_extent_cursor, bool)
            or not isinstance(pending_extent_cursor, int)
            or pending_extent_cursor < pending_audit_cursor
            or not _is_sha256_hex(pending_extent_prefix)
            or not isinstance(payload, dict)
        ):
            raise ShipperError("invalid pending outbox in shipper state")
        _validate_cursors(pending.get("usage_cursors_after"), "usage_cursors_after")
        if payload.get("batch_seq") != pending_seq:
            raise ShipperError("pending outbox batch_seq does not match its payload")
    return raw


def _save_state(state_path: str, state: Dict[str, Any]) -> None:
    atomic_write_json(state_path, state)


def _clear_audit_inflight(state: Dict[str, Any]) -> None:
    state["audit_inflight_extent_cursor"] = None
    state["audit_inflight_extent_sha256"] = None


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


def _split_payload(
    usage_rows: list[dict[str, Any]],
    observations: list[dict[str, Any]],
) -> list[tuple[list[dict[str, Any]], list[dict[str, Any]]]]:
    """Split work into contract-sized chunks counting observation windows."""

    chunks: list[tuple[list[dict[str, Any]], list[dict[str, Any]]]] = []
    usage_index = 0
    observation_index = 0
    while usage_index < len(usage_rows) or observation_index < len(observations):
        budget = MAX_PAYLOAD_ROWS
        usage_chunk: list[dict[str, Any]] = []
        observation_chunk: list[dict[str, Any]] = []
        while usage_index < len(usage_rows) and budget >= 1:
            usage_chunk.append(usage_rows[usage_index])
            usage_index += 1
            budget -= 1
        while observation_index < len(observations):
            observation = observations[observation_index]
            cost = 1 + len(observation.get("windows") or [])
            if cost > budget:
                break
            observation_chunk.append(observation)
            observation_index += 1
            budget -= cost
        chunks.append((usage_chunk, observation_chunk))
    return chunks or [([], [])]


def _send_once(endpoint: str, token: str, payload: Dict[str, Any], timeout: float) -> None:
    post_envelope(endpoint, token, payload, timeout_seconds=timeout)


def _send_pending(
    audit_path: str,
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    timeout: float,
    quiet: bool,
) -> bool:
    pending = state["pending"]
    sequence = pending["batch_seq"]
    # The payload was built from the full consumed audit extent. It must still
    # be the same source before a retry can be sent.
    _verify_audit_prefix(
        audit_path,
        pending["audit_extent_cursor"],
        pending["audit_extent_sha256"],
    )
    try:
        _send_once(endpoint, token, pending["payload"], timeout)
    except HTTPPushError as exc:
        print(
            "orihsus-shipper: pending batch_seq %d not acknowledged: %s" % (sequence, exc),
            file=sys.stderr,
        )
        return False
    # Do not advance to an extent that changed after the request was sent.
    _verify_audit_prefix(
        audit_path,
        pending["audit_extent_cursor"],
        pending["audit_extent_sha256"],
    )
    state["batch_seq"] = sequence
    state["audit_cursor"] = pending["audit_cursor_after"]
    state["audit_prefix_sha256"] = pending["audit_prefix_sha256_after"]
    if (
        state["audit_cursor"] == pending["audit_extent_cursor"]
        and state["audit_prefix_sha256"] == pending["audit_extent_sha256"]
    ):
        _clear_audit_inflight(state)
    else:
        state["audit_inflight_extent_cursor"] = pending["audit_extent_cursor"]
        state["audit_inflight_extent_sha256"] = pending["audit_extent_sha256"]
    state["usage_cursors"] = dict(pending["usage_cursors_after"])
    state["pending"] = None
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


def _send_rows(
    audit_path: str,
    usage_rows: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    audit_extent_cursor: int,
    audit_extent_sha256: str,
    usage_cursors_after: Dict[str, int],
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    timeout: float,
    quiet: bool,
) -> bool:
    batches = _split_payload(usage_rows, observations)
    for index, (usage_chunk, observation_chunk) in enumerate(batches):
        sequence = state["batch_seq"] + 1
        if sequence > MAX_BATCH_SEQ:
            raise ShipperError("batch_seq exceeded the supported integer range")
        is_last = index == len(batches) - 1
        pending = {
            "batch_seq": sequence,
            "payload": _envelope(sequence, usage_chunk, observation_chunk),
            "audit_cursor_after": (
                audit_extent_cursor if is_last else state["audit_cursor"]
            ),
            "audit_prefix_sha256_after": (
                audit_extent_sha256 if is_last else state["audit_prefix_sha256"]
            ),
            # Every chunk was derived from the same full consumed extent. Persist
            # and verify that extent even when this chunk does not advance the
            # cursor yet, so a lost ACK cannot retry against a changed source.
            "audit_extent_cursor": audit_extent_cursor,
            "audit_extent_sha256": audit_extent_sha256,
            "usage_cursors_after": (
                dict(usage_cursors_after) if is_last else dict(state["usage_cursors"])
            ),
            "created_at": utc_now_iso(),
        }
        state["pending"] = pending
        # Persist the exact in-flight batch before the first network attempt.
        _save_state(state_path, state)

        _verify_audit_prefix(audit_path, audit_extent_cursor, audit_extent_sha256)
        try:
            _send_once(endpoint, token, pending["payload"], timeout)
        except HTTPPushError as exc:
            print(
                "orihsus-shipper: batch_seq %d not acknowledged: %s" % (sequence, exc),
                file=sys.stderr,
            )
            return False
        _verify_audit_prefix(audit_path, audit_extent_cursor, audit_extent_sha256)

        state["batch_seq"] = sequence
        state["audit_cursor"] = pending["audit_cursor_after"]
        state["audit_prefix_sha256"] = pending["audit_prefix_sha256_after"]
        if (
            state["audit_cursor"] == audit_extent_cursor
            and state["audit_prefix_sha256"] == audit_extent_sha256
        ):
            _clear_audit_inflight(state)
        else:
            state["audit_inflight_extent_cursor"] = audit_extent_cursor
            state["audit_inflight_extent_sha256"] = audit_extent_sha256
        state["usage_cursors"] = dict(pending["usage_cursors_after"])
        state["pending"] = None
        _save_state(state_path, state)
        if not quiet:
            if usage_chunk or observation_chunk:
                print(
                    "orihsus-shipper: sent %d usage bucket(s) and %d quota observation(s) as batch_seq %d"
                    % (len(usage_chunk), len(observation_chunk), sequence)
                )
            else:
                print("orihsus-shipper: sent idle heartbeat as batch_seq %d" % sequence)
    return True


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
    _require_audit_log(audit_path)
    state = _load_state(state_path, producer_id)
    _verify_audit_prefix(audit_path, state["audit_cursor"], state["audit_prefix_sha256"])
    inflight_cursor = state["audit_inflight_extent_cursor"]
    if inflight_cursor is not None:
        _verify_audit_prefix(
            audit_path,
            inflight_cursor,
            state["audit_inflight_extent_sha256"],
        )

    pending_acked = False
    if state["pending"] is not None:
        if not _send_pending(audit_path, endpoint, token, state_path, state, timeout, quiet):
            return False
        pending_acked = True

    records, next_audit_cursor, next_audit_prefix = _read_appended_audit(
        audit_path, state["audit_cursor"]
    )
    inflight_cursor = state["audit_inflight_extent_cursor"]
    if inflight_cursor is not None and next_audit_cursor < inflight_cursor:
        raise ShipperError(
            "audit log no longer covers the in-flight extent; refusing to aggregate a replacement"
        )
    if next_audit_cursor != state["audit_cursor"] or inflight_cursor is not None:
        # Persist the full extent before aggregation so a crash after a partial
        # multi-chunk ACK still protects every already-committed batch.
        _verify_audit_prefix(audit_path, next_audit_cursor, next_audit_prefix)
        state["audit_inflight_extent_cursor"] = next_audit_cursor
        state["audit_inflight_extent_sha256"] = next_audit_prefix
        _save_state(state_path, state)
    touched_hours = {_record_hour(record) for record in records}
    usage_rows = (
        aggregate_audit_records(
            _read_audit_records_to_extent(audit_path, next_audit_cursor),
            touched_hours,
        )
        if touched_hours
        else []
    )
    if touched_hours:
        # The source may have been rewritten while rows were aggregated. Never
        # send a possibly incomplete complete-hour total in that case.
        _verify_audit_prefix(audit_path, next_audit_cursor, next_audit_prefix)

    observations, next_usage_cursors, reset_days = _read_usage_backlog(
        usage_dir,
        state["usage_cursors"],
        interval_seconds,
        observer_machine,
    )
    for day in reset_days:
        print(
            "orihsus-shipper: usage file %s.jsonl shrank below the saved cursor; replaying it"
            % day,
            file=sys.stderr,
        )

    if usage_rows or observations:
        return _send_rows(
            audit_path,
            usage_rows,
            observations,
            next_audit_cursor,
            next_audit_prefix,
            next_usage_cursors,
            endpoint,
            token,
            state_path,
            state,
            timeout,
            quiet,
        )
    # An ACKed pending batch already refreshed producer liveness for this run.
    if heartbeat and not pending_acked:
        return _send_rows(
            audit_path,
            [],
            [],
            next_audit_cursor,
            next_audit_prefix,
            next_usage_cursors,
            endpoint,
            token,
            state_path,
            state,
            timeout,
            quiet,
        )
    return True


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
