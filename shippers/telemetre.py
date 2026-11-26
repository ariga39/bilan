#!/usr/bin/env python3
"""Push AGY and Codex quota observations from telemetre's centre SQLite.

Upstream source (read-only, never modified by this shipper)
-----------------------------------------------------------
``telemetre`` stores sanitized quota samples in a centre SQLite database with
two tables:

* ``quota_samples`` — one row per provider attempt. ``status`` is either
  ``success`` or ``failure``; ``time_anomaly`` is a 0/1 flag for a sample taken
  further ahead of its receive time than telemetre's clock-skew tolerance.
* ``quota_windows`` — one row per collected window, linked by ``sample_id``.
  ``remaining_display`` is the sanitized percentage remaining, ``anomalies`` is
  a JSON list of source problems (for example ``missing_remaining`` or
  ``remaining_out_of_range``), and ``slot``/``limit_id`` may be NULL for AGY.

The shipper opens the database with ``mode=ro`` and never writes to it.

Mapping onto bilan's unified Push contract
------------------------------------------
Only ``provider IN ('agy', 'codex')`` quota observations are shipped. AGY token
usage is deliberately absent because telemetre does not collect it.

::

    sample_id        = telemetre sample_id (stable across retries)
    source           = provider
    account          = telemetre account
    observer_machine = telemetre machine
    sampled_at       = canonical UTC second-precision timestamp
    status           = "ok"    for a successful sample with windows
                       "empty" for a successful sample with no windows
                       "error" for a failed sample (no windows, sanitized error)
    time_anomaly     = "future_sampled_at" when the centre flagged the sample
    error_summary    = safe error code only for failures (never raw detail)

AGY windows use the upstream model group as ``bucket_id`` and the upstream
bucket id (``five-hour``, ``weekly``, ...) as ``slot``. Codex windows use
``limit_id`` as ``bucket_id`` and ``primary``/``secondary`` as ``slot``. Missing
upstream identities fall back to the group/bucket values and finally to a
deterministic ordinal, so the required D1 ``(bucket_id, slot)`` key is never
empty and no collected window is dropped. Per-window upstream details and
anomaly codes are retained in bounded ``meta_json``.

Null semantics are preserved: a missing remaining value, reset time, or window
duration stays ``null`` and is never turned into ``0%``/``100%``. A success
sample with no windows becomes an ``empty`` observation; a failure becomes an
``error`` observation with no readings. Same-second and late-arriving samples
remain distinct because samples are consumed in centre insertion order
(``rowid``) rather than by a ``sampled_at`` timestamp cursor.

Durability model
----------------
The local state file persists the next monotonic ``batch_seq``, the consumed
centre ``rowid`` plus the sample id at that cursor, and the exact in-flight
envelope. The envelope is written to disk before the HTTP attempt, so a timeout
or lost ACK retries the identical payload with the identical ``batch_seq``.
Only an exact HTTP 200 ACK advances the cursor. A cursor whose row disappeared
or moved (for example after a database rebuild) falls back to a full idempotent
rescan; D1's immutable observation keys make that replay harmless.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

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
        utc_now_iso,
    )

STATE_VERSION = 1
DEFAULT_PRODUCER_ID = "telemetre-quota"
SUPPORTED_PROVIDERS = ("agy", "codex")
DEFAULT_DATABASE = "~/.local/state/telemetre/quota.sqlite3"
DEFAULT_STATE_NAME = ".bilan-telemetre-state.json"
MAX_BATCH_SEQ = 2**31 - 1
MAX_META_JSON = 2048
MAX_LABEL = 128
MAX_BUCKET_ID = 128
MAX_SLOT = 64

_SAMPLE_COLUMNS = """
    rowid AS row_id,
    sample_id,
    provider,
    account,
    machine,
    sampled_at,
    received_at,
    status,
    error_kind,
    error_detail,
    empty_windows,
    time_anomaly,
    interval_seconds
"""

_WINDOW_COLUMNS = """
    ordinal,
    group_name,
    bucket_id,
    limit_id,
    slot,
    window_raw,
    window_minutes,
    remaining_value,
    remaining_unit,
    remaining_display,
    reset_raw,
    reset_at,
    anomalies
"""


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


def _clean_text(value: Any, maximum: int) -> Optional[str]:
    """Return a stripped, bounded string or ``None`` when it is not usable."""

    if isinstance(value, str):
        text = value.strip()
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        text = str(value)
    else:
        return None
    if not text:
        return None
    return text[:maximum]


def _finite_number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _percent(value: Any) -> Optional[float]:
    number = _finite_number(value)
    if number is None or number < 0.0 or number > 100.0:
        return None
    return number


def _positive_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value <= 0:
        return None
    return value


def _optional_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value <= 0:
        return None
    return value


def _json_load(value: Any, default: Any = None) -> Any:
    if not isinstance(value, str):
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _json_list(value: Any) -> list[str]:
    loaded = _json_load(value, [])
    if not isinstance(loaded, list):
        return []
    return [item for item in loaded if isinstance(item, str) and item]


SAFE_ERROR_CODES = frozenset(
    {
        "timeout",
        "http_error",
        "transport_error",
        "invalid_response",
        "unknown",
        "upstream_error",
    }
)
ERROR_CODE_ALIASES = {
    "spawn_error": "transport_error",
    "not_authenticated": "upstream_error",
    "provider_error": "upstream_error",
    "exit_code": "upstream_error",
    "invalid_json": "invalid_response",
    "unrecognized_structure": "invalid_response",
    "protocol_error": "invalid_response",
    "invalid_window": "invalid_response",
    "invalid_observation": "invalid_response",
    "unsupported_provider": "upstream_error",
    "invalid_sampled_at": "invalid_response",
    "unrecognized_status": "invalid_response",
}


def _safe_error_code(kind: Any) -> str:
    """Map telemetre's failure kind to a bounded, non-sensitive category.

    Raw ``error_detail`` text is deliberately never sent: DESIGN §9 requires
    operational errors in ``quota_observations.error_summary`` to be sanitized
    so upstream response bodies and secrets cannot leak into D1.
    """

    code = kind.strip().lower() if isinstance(kind, str) else ""
    if not code:
        return "unknown"
    mapped = ERROR_CODE_ALIASES.get(code, code)
    return mapped if mapped in SAFE_ERROR_CODES else "upstream_error"


def _time_anomaly(value: Any) -> Optional[str]:
    """Map telemetre's future-clock flag without inventing a reading."""

    if value in (None, 0, "0", False, ""):
        return None
    return "future_sampled_at"


# -- centre SQLite (read-only) ------------------------------------------------


def _open_database(database_path: str) -> sqlite3.Connection:
    if not os.path.isfile(database_path):
        raise ShipperError("telemetre centre database not found: %s" % database_path)
    uri = Path(database_path).resolve().as_uri() + "?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=5.0)
    except sqlite3.Error as exc:
        raise ShipperError(
            "cannot open telemetre centre database read-only: %s" % exc.__class__.__name__
        ) from exc
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA query_only = ON")
    return connection


def _require_schema(connection: sqlite3.Connection) -> None:
    tables = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    missing = {"quota_samples", "quota_windows"} - tables
    if missing:
        raise ShipperError(
            "telemetre centre schema is missing %s" % ", ".join(sorted(missing))
        )


def _cursor_row(
    connection: sqlite3.Connection, row_id: int, sample_id: Optional[str]
) -> Optional[str]:
    """Return the sample id still stored at ``row_id`` when it is unchanged."""

    if row_id <= 0:
        return None
    row = connection.execute(
        "SELECT sample_id FROM quota_samples WHERE rowid = ?", (row_id,)
    ).fetchone()
    if row is None:
        return None
    current = row["sample_id"]
    if sample_id is not None and current != sample_id:
        return None
    return str(current)


# -- window mapping -----------------------------------------------------------


def _slot_with_suffix(base: str, suffix: str) -> str:
    """Return a non-empty slot no longer than the D1 contract limit."""

    if len(suffix) >= MAX_SLOT:
        # Keep collision handling deterministic even for an absurd ordinal
        # counter whose decimal suffix would not fit in the slot column.
        suffix = "#" + hashlib.sha256(suffix.encode("utf-8")).hexdigest()[: MAX_SLOT - 1]
    available = MAX_SLOT - len(suffix)
    candidate = ((base[:available] if available > 0 else "") + suffix)[:MAX_SLOT]
    return candidate or suffix[:MAX_SLOT] or "slot"


def _unique_window_key(
    bucket_id: str,
    slot: str,
    seen: Dict[tuple[str, str], int],
) -> tuple[str, str]:
    """Keep the required ``(bucket_id, slot)`` pair unique without dropping rows."""

    # A NULL upstream slot falls back to the source bucket id, which may be up
    # to 128 characters. Bound that fallback before the first uniqueness lookup
    # so the first emitted window satisfies the 64-character contract too.
    slot = _slot_with_suffix(slot, "")
    key = (bucket_id, slot)
    if key not in seen:
        seen[key] = 1
        return key
    seen[key] += 1
    counter = seen[key]
    while True:
        candidate = _slot_with_suffix(slot, "#%d" % counter)
        candidate_key = (bucket_id, candidate)
        if candidate_key not in seen:
            seen[candidate_key] = 1
            return candidate_key
        counter += 1


def _window_label(provider: str, window_raw: Any, group: Optional[str], bucket_id: str) -> Optional[str]:
    if provider != "codex":
        # AGY model groups are the bucket identity, so the human window label
        # ("5h", "7d") is the useful display alias.
        return _clean_text(window_raw, MAX_LABEL)
    if group is not None and group != bucket_id:
        return _clean_text(group, MAX_LABEL)
    return None


def _bounded_meta(meta: Dict[str, Any]) -> Optional[str]:
    """Encode non-sensitive window metadata within the contract length."""

    compact = {key: value for key, value in meta.items() if value not in (None, "", [])}
    if not compact:
        return None
    encoded = canonical_json_bytes(compact).decode("utf-8")
    if len(encoded) <= MAX_META_JSON:
        return encoded
    for key in (
        "window",
        "remaining_value",
        "remaining_unit",
        "limit_id",
        "group",
        "source_slot",
        "source_bucket_id",
    ):
        compact.pop(key, None)
        encoded = canonical_json_bytes(compact).decode("utf-8")
        if len(encoded) <= MAX_META_JSON:
            return encoded
    anomalies = compact.get("anomalies")
    while isinstance(anomalies, list) and anomalies:
        anomalies.pop()
        encoded = canonical_json_bytes(compact).decode("utf-8")
        if len(encoded) <= MAX_META_JSON:
            return encoded
    return None


def _map_window(
    provider: str,
    window: sqlite3.Row,
    ordinal: int,
    seen: Dict[tuple[str, str], int],
) -> dict[str, Any]:
    group = _clean_text(window["group_name"], MAX_BUCKET_ID)
    source_bucket = _clean_text(window["bucket_id"], MAX_BUCKET_ID)
    limit_id = _clean_text(window["limit_id"], MAX_BUCKET_ID)
    source_slot = _clean_text(window["slot"], MAX_SLOT)
    window_raw = _json_load(window["window_raw"])

    if provider == "codex":
        bucket_id = limit_id or group or source_bucket or ("limit-%d" % (ordinal + 1))
        slot = source_slot or source_bucket or ("slot-%d" % (ordinal + 1))
    else:
        bucket_id = group or source_bucket or ("group-%d" % (ordinal + 1))
        slot = source_slot or source_bucket or ("slot-%d" % (ordinal + 1))

    bucket_id, slot = _unique_window_key(bucket_id, slot, seen)
    label = _window_label(provider, window_raw, group, bucket_id)

    remaining = _percent(window["remaining_display"])
    used = None if remaining is None else round(100.0 - remaining, 6)
    if used is not None and not 0.0 <= used <= 100.0:
        used = None

    anomalies = _json_list(window["anomalies"])
    if window["remaining_display"] is not None and remaining is None:
        if "remaining_out_of_range" not in anomalies:
            anomalies.append("remaining_out_of_range")

    reset_at = _optional_utc(window["reset_at"])
    duration = _positive_int(window["window_minutes"])

    meta = {
        "group": group,
        "limit_id": limit_id,
        "source_bucket_id": source_bucket,
        "source_slot": source_slot,
        "window": window_raw if isinstance(window_raw, (str, int, float)) else None,
        "remaining_value": _finite_number(window["remaining_value"]),
        "remaining_unit": _clean_text(window["remaining_unit"], 64),
        "anomalies": anomalies,
    }

    return {
        "bucket_id": bucket_id,
        "slot": slot,
        "label": label,
        "used_percent": used,
        "remaining_percent": remaining,
        "status": None,
        "resets_at": reset_at,
        "window_duration_mins": duration,
        "meta_json": _bounded_meta(meta),
    }


def _windows_for(
    connection: sqlite3.Connection, provider: str, sample_id: str
) -> list[dict[str, Any]]:
    rows = connection.execute(
        "SELECT %s FROM quota_windows WHERE sample_id = ? ORDER BY ordinal ASC"
        % _WINDOW_COLUMNS,
        (sample_id,),
    ).fetchall()
    seen: Dict[tuple[str, str], int] = {}
    return [
        _map_window(provider, row, ordinal, seen)
        for ordinal, row in enumerate(rows)
    ]


def _map_observation(
    connection: sqlite3.Connection, row: sqlite3.Row
) -> dict[str, Any]:
    provider = str(row["provider"] or "").strip().lower()
    sample_id = str(row["sample_id"])
    account = _clean_text(row["account"], 128) or "default"
    machine = _clean_text(row["machine"], 128) or "unknown"
    interval = _optional_int(row["interval_seconds"])

    sampled_at = _optional_utc(row["sampled_at"])
    if sampled_at is None:
        # A malformed timestamp must not block the whole backlog. Preserve the
        # sample as an explicit error using its receive time, never a fake
        # reading.
        sampled_at = _optional_utc(row["received_at"]) or utc_now_iso()
        return {
            "sample_id": sample_id,
            "source": provider,
            "account": account,
            "observer_machine": machine,
            "sampled_at": sampled_at,
            "interval_seconds": interval,
            "status": "error",
            "time_anomaly": "invalid_sampled_at",
            "error_summary": _safe_error_code("invalid_sampled_at"),
            "windows": [],
        }

    raw_status = str(row["status"] or "")
    if raw_status == "failure":
        return {
            "sample_id": sample_id,
            "source": provider,
            "account": account,
            "observer_machine": machine,
            "sampled_at": sampled_at,
            "interval_seconds": interval,
            "status": "error",
            "time_anomaly": _time_anomaly(row["time_anomaly"]),
            "error_summary": _safe_error_code(row["error_kind"]),
            "windows": [],
        }

    windows = _windows_for(connection, provider, sample_id)
    status = "ok" if windows else "empty"
    if raw_status != "success":
        # Unknown statuses are surfaced rather than silently treated as a
        # successful reading.
        status = "error"
        return {
            "sample_id": sample_id,
            "source": provider,
            "account": account,
            "observer_machine": machine,
            "sampled_at": sampled_at,
            "interval_seconds": interval,
            "status": "error",
            "time_anomaly": _time_anomaly(row["time_anomaly"]),
            "error_summary": _safe_error_code("unrecognized_status"),
            "windows": [],
        }

    return {
        "sample_id": sample_id,
        "source": provider,
        "account": account,
        "observer_machine": machine,
        "sampled_at": sampled_at,
        "interval_seconds": interval,
        "status": status,
        "time_anomaly": _time_anomaly(row["time_anomaly"]),
        "error_summary": None,
        "windows": windows,
    }


def _read_new_observations(
    connection: sqlite3.Connection,
    cursor_row_id: int,
    cursor_sample_id: Optional[str],
) -> tuple[list[tuple[int, str, dict[str, Any]]], int, Optional[str], bool]:
    """Read observations inserted after the durable cursor.

    Returns ``(observations, cursor_row_id_after, cursor_sample_id_after,
    rescanned)``. Insertion order (``rowid``) is the only ordering that keeps
    late-arriving older samples and same-second samples from being skipped.
    """

    rescanned = False
    if cursor_row_id > 0:
        current = _cursor_row(connection, cursor_row_id, cursor_sample_id)
        if current is None:
            cursor_row_id = 0
            cursor_sample_id = None
            rescanned = True

    rows = connection.execute(
        "SELECT %s FROM quota_samples WHERE rowid > ? ORDER BY rowid ASC" % _SAMPLE_COLUMNS,
        (cursor_row_id,),
    ).fetchall()
    if not rows:
        return [], cursor_row_id, cursor_sample_id, rescanned

    observations: list[tuple[int, str, dict[str, Any]]] = []
    for row in rows:
        provider = str(row["provider"] or "").strip().lower()
        if provider not in SUPPORTED_PROVIDERS:
            continue
        observations.append((int(row["row_id"]), str(row["sample_id"]), _map_observation(connection, row)))

    return (
        observations,
        int(rows[-1]["row_id"]),
        str(rows[-1]["sample_id"]),
        rescanned,
    )


# -- durable state & transport ----------------------------------------------


def _default_state_path(database_path: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(database_path)), DEFAULT_STATE_NAME)


def _load_state(state_path: str, producer_id: str) -> Dict[str, Any]:
    raw = load_json_file(state_path)
    if raw is None:
        return {
            "version": STATE_VERSION,
            "producer_id": producer_id,
            "batch_seq": 0,
            "cursor_rowid": 0,
            "cursor_sample_id": None,
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
    cursor_row_id = raw.get("cursor_rowid")
    cursor_sample_id = raw.get("cursor_sample_id")
    if isinstance(batch_seq, bool) or not isinstance(batch_seq, int) or batch_seq < 0:
        raise ShipperError("invalid batch_seq in shipper state")
    if (
        isinstance(cursor_row_id, bool)
        or not isinstance(cursor_row_id, int)
        or cursor_row_id < 0
    ):
        raise ShipperError("invalid cursor_rowid in shipper state")
    if cursor_sample_id is not None and (
        not isinstance(cursor_sample_id, str) or not cursor_sample_id
    ):
        raise ShipperError("invalid cursor_sample_id in shipper state")

    pending = raw.get("pending")
    if pending is not None:
        if not isinstance(pending, dict):
            raise ShipperError("invalid pending outbox in shipper state")
        pending_seq = pending.get("batch_seq")
        pending_cursor = pending.get("cursor_rowid_after")
        pending_sample = pending.get("cursor_sample_id_after")
        payload = pending.get("payload")
        if (
            isinstance(pending_seq, bool)
            or not isinstance(pending_seq, int)
            or pending_seq <= batch_seq
            or isinstance(pending_cursor, bool)
            or not isinstance(pending_cursor, int)
            or pending_cursor < cursor_row_id
            or (pending_sample is not None and (
                not isinstance(pending_sample, str) or not pending_sample
            ))
            or not isinstance(payload, dict)
        ):
            raise ShipperError("invalid pending outbox in shipper state")
        if payload.get("batch_seq") != pending_seq:
            raise ShipperError("pending outbox batch_seq does not match its payload")
    return raw


def _save_state(state_path: str, state: Dict[str, Any]) -> None:
    atomic_write_json(state_path, state)


def _envelope(batch_seq: int, observations: list[dict[str, Any]]) -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "batch_seq": batch_seq,
        "usage_buckets": [],
        "quota_observations": observations,
        "balance_snapshots": [],
    }


def _chunks(
    observations: list[tuple[int, str, dict[str, Any]]],
    scanned_row_id: int,
    scanned_sample_id: Optional[str],
) -> list[tuple[list[dict[str, Any]], int, Optional[str]]]:
    """Split observations into contract-sized batches counting child windows."""

    chunks: list[tuple[list[dict[str, Any]], int, Optional[str]]] = []
    current: list[dict[str, Any]] = []
    budget = MAX_PAYLOAD_ROWS
    last_row_id = 0
    last_sample_id: Optional[str] = None
    for row_id, sample_id, observation in observations:
        cost = 1 + len(observation.get("windows") or [])
        if cost > MAX_PAYLOAD_ROWS:
            raise ShipperError(
                "quota observation %s has %d windows and exceeds the %d-row contract"
                % (sample_id, len(observation.get("windows") or []), MAX_PAYLOAD_ROWS)
            )
        if current and cost > budget:
            chunks.append((current, last_row_id, last_sample_id))
            current = []
            budget = MAX_PAYLOAD_ROWS
        current.append(observation)
        budget -= cost
        last_row_id = row_id
        last_sample_id = sample_id
    if current:
        chunks.append((current, last_row_id, last_sample_id))

    if not chunks:
        return []
    # The final batch consumes every scanned row, including providers that are
    # not shipped, so a trailing unrelated row cannot pin the cursor forever.
    final_observations, _final_row_id, _final_sample_id = chunks[-1]
    chunks[-1] = (final_observations, scanned_row_id, scanned_sample_id)
    return chunks


def _send_once(endpoint: str, token: str, payload: Dict[str, Any], timeout: float) -> None:
    post_envelope(endpoint, token, payload, timeout_seconds=timeout)


def _ack_pending(
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    timeout: float,
    quiet: bool,
) -> bool:
    pending = state["pending"]
    sequence = pending["batch_seq"]
    try:
        _send_once(endpoint, token, pending["payload"], timeout)
    except HTTPPushError as exc:
        print(
            "telemetre-shipper: pending batch_seq %d not acknowledged: %s"
            % (sequence, exc),
            file=sys.stderr,
        )
        return False
    state["batch_seq"] = sequence
    state["cursor_rowid"] = pending["cursor_rowid_after"]
    state["cursor_sample_id"] = pending["cursor_sample_id_after"]
    state["pending"] = None
    _save_state(state_path, state)
    if not quiet:
        observations = len(pending["payload"].get("quota_observations") or [])
        if observations:
            print(
                "telemetre-shipper: ACKed pending batch_seq %d (%d observation(s))"
                % (sequence, observations)
            )
        else:
            print("telemetre-shipper: ACKed pending heartbeat batch_seq %d" % sequence)
    return True


def _send_chunks(
    chunks: list[tuple[list[dict[str, Any]], int, Optional[str]]],
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    timeout: float,
    quiet: bool,
) -> bool:
    for observations, cursor_row_id_after, cursor_sample_id_after in chunks:
        sequence = state["batch_seq"] + 1
        if sequence > MAX_BATCH_SEQ:
            raise ShipperError("batch_seq exceeded the supported integer range")
        pending = {
            "batch_seq": sequence,
            "payload": _envelope(sequence, observations),
            "cursor_rowid_after": cursor_row_id_after,
            "cursor_sample_id_after": cursor_sample_id_after,
            "created_at": utc_now_iso(),
        }
        state["pending"] = pending
        # Persist the exact in-flight batch before the first network attempt.
        _save_state(state_path, state)

        try:
            _send_once(endpoint, token, pending["payload"], timeout)
        except HTTPPushError as exc:
            print(
                "telemetre-shipper: batch_seq %d not acknowledged: %s"
                % (sequence, exc),
                file=sys.stderr,
            )
            return False

        state["batch_seq"] = sequence
        state["cursor_rowid"] = cursor_row_id_after
        state["cursor_sample_id"] = cursor_sample_id_after
        state["pending"] = None
        _save_state(state_path, state)
        if not quiet:
            if observations:
                print(
                    "telemetre-shipper: sent %d quota observation(s) as batch_seq %d"
                    % (len(observations), sequence)
                )
            else:
                print("telemetre-shipper: sent idle heartbeat as batch_seq %d" % sequence)
    return True


def run_once(
    database_path: str,
    state_path: str,
    producer_id: str,
    endpoint: str,
    token: str,
    heartbeat: bool,
    timeout: float,
    quiet: bool = False,
) -> bool:
    state = _load_state(state_path, producer_id)

    pending_acked = False
    if state["pending"] is not None:
        if not _ack_pending(endpoint, token, state_path, state, timeout, quiet):
            return False
        pending_acked = True

    connection = _open_database(database_path)
    try:
        _require_schema(connection)
        observations, scanned_row_id, scanned_sample_id, rescanned = (
            _read_new_observations(
                connection, state["cursor_rowid"], state["cursor_sample_id"]
            )
        )
    finally:
        connection.close()

    if rescanned:
        print(
            "telemetre-shipper: cursor row is missing or changed; replaying the centre database",
            file=sys.stderr,
        )
        # Persist the invalidation before the replay attempt. If that attempt
        # loses its ACK, the durable cursor is already reset instead of still
        # pointing into the old database.
        state["cursor_rowid"] = 0
        state["cursor_sample_id"] = None
        _save_state(state_path, state)

    chunks = _chunks(observations, scanned_row_id, scanned_sample_id)
    if chunks:
        return _send_chunks(
            chunks, endpoint, token, state_path, state, timeout, quiet
        )

    # No shippable observations. Advance over scanned non-quota rows locally so
    # they are not rescanned forever.
    cursor_moved = (
        scanned_row_id != state["cursor_rowid"]
        or scanned_sample_id != state["cursor_sample_id"]
    )
    # An ACKed pending batch already refreshed producer liveness for this run.
    if heartbeat and not pending_acked:
        chunk = [([], scanned_row_id, scanned_sample_id)]
        return _send_chunks(
            chunk, endpoint, token, state_path, state, timeout, quiet
        )
    if cursor_moved:
        state["cursor_rowid"] = scanned_row_id
        state["cursor_sample_id"] = scanned_sample_id
        _save_state(state_path, state)
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


def _default_database() -> str:
    return os.environ.get("TELEMETRE_QUOTA_DB") or os.path.expanduser(DEFAULT_DATABASE)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Push telemetre AGY and Codex quota observations to bilan-ingest.",
    )
    parser.add_argument(
        "--database",
        default=_default_database(),
        help="telemetre centre quota SQLite path (or TELEMETRE_QUOTA_DB; default: %(default)s)",
    )
    parser.add_argument(
        "--state-file",
        help="durable cursor/outbox path (default: next to the centre database)",
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
    if not args.database.strip():
        parser.error("--database or TELEMETRE_QUOTA_DB is required")
    try:
        token = _read_token(args.token, args.token_file)
    except ShipperError as exc:
        print("telemetre-shipper: %s" % exc, file=sys.stderr)
        return 1
    if not token:
        parser.error("--token, --token-file, or BILAN_INGEST_TOKEN is required")

    database_path = os.path.abspath(os.path.expanduser(args.database))
    state_path = os.path.abspath(
        args.state_file or _default_state_path(database_path)
    )
    lock_path = state_path + ".lock"

    try:
        with InstanceLock(lock_path):
            ok = run_once(
                database_path=database_path,
                state_path=state_path,
                producer_id=args.producer_id,
                endpoint=args.endpoint,
                token=token,
                heartbeat=not args.no_heartbeat,
                timeout=args.timeout,
                quiet=args.quiet,
            )
    except LockHeldError as exc:
        print("telemetre-shipper: %s" % exc, file=sys.stderr)
        return 1
    except ShipperError as exc:
        print("telemetre-shipper: %s" % exc, file=sys.stderr)
        return 1
    except sqlite3.Error as exc:
        print(
            "telemetre-shipper: telemetre centre database failure: %s"
            % exc.__class__.__name__,
            file=sys.stderr,
        )
        return 1
    except OSError as exc:
        print(
            "telemetre-shipper: local I/O failure: %s" % exc.__class__.__name__,
            file=sys.stderr,
        )
        return 1
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
