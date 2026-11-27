#!/usr/bin/env python3
"""Push Codex token-usage facts from debitmetre's canonical JSONL audit.

The upstream ``debitmetre`` gateway appends one ``AuditRecord`` per accepted
request to ``usage.jsonl``. This shipper reads only that append-only file and
maps its facts onto bilan's unified ``usage_buckets`` Push contract:

    source          = "codex"
    account         = "default"
    actor_kind      = "machine"
    actor_id        = AuditRecord.machine_id
    model           = AuditRecord.model (or "unknown" when not reported)
    effort          = AuditRecord.reasoning_effort (or "" when not declared)
    bucket_start    = the complete touched UTC hour
    unit_kind       = "request"
    unit_count      = accepted audit records in the bucket
    coverage_gaps   = records missing one or more mapped token fields

Token columns are summed independently; a field absent from every record in a
bucket stays JSON ``null`` while an explicitly recorded zero stays ``0``. Each
``*_counted`` column records how many units contributed a non-null value.

Durability model
----------------
The local state file persists the next monotonic ``batch_seq``, the consumed
byte cursor, and the exact in-flight envelope. The envelope is written to disk
before the HTTP attempt. A timeout or lost ACK therefore retries the identical
payload with the identical ``batch_seq``; only a 2xx ACK advances the cursor.
The state file doubles as the logical ``producer_id`` identity so a migrated
host can keep the same dataset identity.

Streaming and the active-hour anchor
------------------------------------
Reads are streamed in bounded chunks, so peak memory follows the number of
distinct buckets rather than the number of historical lines. The state also
remembers ``active_hour`` and ``active_hour_offset`` -- the earliest byte offset
that contributes to the current active UTC hour. A normal append-only tick reads
only ``[active_hour_offset, extent)`` to rebuild the touched hours; an older
late record falls back to an exact stream from byte 0. The cursor and anchor are
bound to the file generation ``(st_dev, st_ino)``: a rotation or truncation is
logged and restarted from zero rather than locking the shipper up.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Iterable, Iterator, Optional

if __package__:
    from .common import (  # type: ignore[import-not-found]
        HTTPPushError,
        InstanceLock,
        LockHeldError,
        ShipperError,
        atomic_write_json,
        envelope,
        inspect_source,
        iter_log_lines,
        load_json_file,
        parse_utc_timestamp,
        post_envelope,
        split_payload_rows,
        utc_hour_start,
        utc_now_iso,
    )
else:
    from common import (  # type: ignore[no-redef]
        HTTPPushError,
        InstanceLock,
        LockHeldError,
        ShipperError,
        atomic_write_json,
        envelope,
        inspect_source,
        iter_log_lines,
        load_json_file,
        parse_utc_timestamp,
        post_envelope,
        split_payload_rows,
        utc_hour_start,
        utc_now_iso,
    )

STATE_VERSION = 2
DEFAULT_PRODUCER_ID = "debitmetre-main"
ACCOUNTING_BASIS = "debitmetre-audit-v1"
MAX_BATCH_SEQ = 2**31 - 1

# (payload column, AuditRecord usage field, counted column)
TOKEN_COLUMNS = (
    ("input_tokens", "input_total", "input_counted"),
    ("cached_tokens", "cache_read", "cached_counted"),
    ("uncached_tokens", "uncached", "uncached_counted"),
    ("cache_write_tokens", "cache_write", "cache_write_counted"),
    ("output_tokens", "output_total", "output_counted"),
    ("reasoning_tokens", "reasoning", "reasoning_counted"),
)


def _new_accumulator() -> Dict[str, Any]:
    accumulator: Dict[str, Any] = {
        "unit_count": 0,
        "coverage_gaps": 0,
    }
    for payload_column, _usage_field, counted_column in TOKEN_COLUMNS:
        accumulator[payload_column] = None
        accumulator[counted_column] = 0
    return accumulator


def _token_value(value: Any) -> Optional[int]:
    """Return a non-negative integer token count, or ``None`` when absent."""

    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0:
        return None
    return value


def _add_token(accumulator: Dict[str, Any], payload_column: str, counted_column: str, value: int) -> None:
    current = accumulator[payload_column]
    accumulator[payload_column] = value if current is None else current + value
    accumulator[counted_column] += 1


def _label_model(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value
    return "unknown"


def _label_effort(value: Any) -> str:
    if isinstance(value, str):
        return value
    return ""


def _machine_id(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value
    return "unknown"


def _canonical_record(raw: bytes) -> Optional[dict[str, Any]]:
    """Parse one complete JSONL line, accepting only canonical audit records."""

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
    if record.get("schema_version") != 1 or record.get("kind") != "request":
        return None
    try:
        parse_utc_timestamp(record.get("timestamp"))
    except ValueError:
        return None
    return record


def _record_hour(record: dict[str, Any]) -> str:
    return utc_hour_start(parse_utc_timestamp(record["timestamp"]))


def _accumulate_record(
    groups: Dict[tuple[str, str, str, str], Dict[str, Any]],
    hour: str,
    record: dict[str, Any],
) -> None:
    key = (
        hour,
        _machine_id(record.get("machine_id")),
        _label_model(record.get("model")),
        _label_effort(record.get("reasoning_effort")),
    )
    accumulator = groups.get(key)
    if accumulator is None:
        accumulator = _new_accumulator()
        groups[key] = accumulator

    accumulator["unit_count"] += 1
    usage = record.get("usage")
    if not isinstance(usage, dict):
        accumulator["coverage_gaps"] += 1
        return

    missing_field = False
    for payload_column, usage_field, counted_column in TOKEN_COLUMNS:
        value = _token_value(usage.get(usage_field))
        if value is None:
            missing_field = True
        else:
            _add_token(accumulator, payload_column, counted_column, value)
    if missing_field:
        accumulator["coverage_gaps"] += 1


def _rows_from_groups(
    groups: Dict[tuple[str, str, str, str], Dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for (hour, machine, model, effort), accumulator in sorted(groups.items()):
        row: Dict[str, Any] = {
            "source": "codex",
            "account": "default",
            "actor_kind": "machine",
            "actor_id": machine,
            "model": model,
            "effort": effort,
            "bucket_start": hour,
            "unit_kind": "request",
            "unit_count": accumulator["unit_count"],
            "coverage_gaps": accumulator["coverage_gaps"],
            "accounting_basis": ACCOUNTING_BASIS,
            "source_version": "1",
        }
        for payload_column, _usage_field, counted_column in TOKEN_COLUMNS:
            row[payload_column] = accumulator[payload_column]
            row[counted_column] = accumulator[counted_column]
        rows.append(row)
    return rows


def aggregate_records(
    records: Iterable[dict[str, Any]],
    touched_hours: Optional[set[str]] = None,
) -> list[dict[str, Any]]:
    """Aggregate canonical audit records into complete UTC-hour buckets.

    ``touched_hours`` restricts output to the hours newly observed, while every
    record in those hours (including earlier lines already consumed) is included
    so each pushed bucket is complete rather than a delta.
    """

    groups: Dict[tuple[str, str, str, str], Dict[str, Any]] = {}
    for record in records:
        hour = utc_hour_start(parse_utc_timestamp(record.get("timestamp")))
        if touched_hours is not None and hour not in touched_hours:
            continue
        _accumulate_record(groups, hour, record)
    return _rows_from_groups(groups)


def _iter_records(usage_path: str, start: int, extent: int) -> Iterator[dict[str, Any]]:
    for _line_start, _line_end, raw in iter_log_lines(usage_path, start, extent):
        record = _canonical_record(raw)
        if record is not None:
            yield record


def _touched_hours(usage_path: str, start: int, extent: int) -> set[str]:
    return {_record_hour(record) for record in _iter_records(usage_path, start, extent)}


def _aggregate_window(
    usage_path: str,
    start: int,
    extent: int,
    touched_hours: set[str],
) -> tuple[list[dict[str, Any]], Dict[str, int]]:
    """Stream ``[start, extent)`` into the touched buckets.

    Returns the complete rows and the first byte offset seen for every touched
    hour, so the anchor can move to the earliest contribution of a new active
    hour without ever advancing past an existing one.
    """

    groups: Dict[tuple[str, str, str, str], Dict[str, Any]] = {}
    first_offsets: Dict[str, int] = {}
    for line_start, _line_end, raw in iter_log_lines(usage_path, start, extent):
        record = _canonical_record(raw)
        if record is None:
            continue
        hour = _record_hour(record)
        # Keep every hour's first offset so a late-only fallback scan can
        # preserve the prior latest hour and its true earliest contribution.
        first_offsets.setdefault(hour, line_start)
        if hour not in touched_hours:
            continue
        _accumulate_record(groups, hour, record)
    return _rows_from_groups(groups), first_offsets


def _default_state_path(usage_path: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(usage_path)), ".bilan-debitmetre-state.json")


def _require_usage_log(usage_path: str) -> None:
    if not os.path.exists(usage_path):
        raise ShipperError("usage log not found; refusing to send a heartbeat")
    if not os.path.isfile(usage_path):
        raise ShipperError("usage log path is not a file")


def _warn(message: str) -> None:
    print("debitmetre-shipper: %s" % message, file=sys.stderr)


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


def _normalize_anchor(active: Any, offset: Any, cursor: int) -> tuple[Optional[str], int]:
    if active is not None and not isinstance(active, str):
        raise ShipperError("invalid active hour in shipper state")
    if (
        isinstance(offset, bool)
        or not isinstance(offset, int)
        or offset < 0
        or offset > cursor
        or (active is None and offset != 0)
    ):
        raise ShipperError("invalid active hour anchor in shipper state")
    return active, offset


def _load_state(state_path: str, producer_id: str) -> Dict[str, Any]:
    raw = load_json_file(state_path)
    if raw is None:
        return {
            "version": STATE_VERSION,
            "producer_id": producer_id,
            "batch_seq": 0,
            "cursor": 0,
            "active_hour": None,
            "active_hour_offset": 0,
            "file_id": None,
            "pending": None,
            "backfill": None,
        }
    if not isinstance(raw, dict) or raw.get("version") not in (1, STATE_VERSION):
        raise ShipperError("unsupported shipper state version")
    if raw.get("producer_id") != producer_id:
        raise ShipperError(
            "state file belongs to producer %r, not %r; use a separate state file"
            % (raw.get("producer_id"), producer_id)
        )
    batch_seq = raw.get("batch_seq")
    cursor = raw.get("cursor")
    if isinstance(batch_seq, bool) or not isinstance(batch_seq, int) or batch_seq < 0:
        raise ShipperError("invalid batch_seq in shipper state")
    if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
        raise ShipperError("invalid cursor in shipper state")

    # v1 kept a full-prefix checkpoint. The digest is obsolete; the cursor and
    # the outbox remain authoritative.
    raw["version"] = STATE_VERSION
    raw.pop("source_checkpoint", None)
    raw.pop("source_extent", None)
    active, offset = _normalize_anchor(
        raw.get("active_hour"), raw.get("active_hour_offset", 0), cursor
    )
    raw["active_hour"] = active
    raw["active_hour_offset"] = offset
    raw["file_id"] = _normalize_identity(raw.get("file_id"))

    pending = raw.get("pending")
    if pending is not None:
        if not isinstance(pending, dict):
            raise ShipperError("invalid pending outbox in shipper state")
        pending_seq = pending.get("batch_seq")
        pending_cursor = pending.get("cursor_after")
        payload = pending.get("payload")
        if (
            isinstance(pending_seq, bool)
            or not isinstance(pending_seq, int)
            or pending_seq <= batch_seq
            or isinstance(pending_cursor, bool)
            or not isinstance(pending_cursor, int)
            or pending_cursor < 0
            or not isinstance(payload, dict)
        ):
            raise ShipperError("invalid pending outbox in shipper state")
        if payload.get("batch_seq") != pending_seq:
            raise ShipperError("pending outbox batch_seq does not match its payload")
        pending.pop("source_checkpoint", None)
        pending.pop("source_extent", None)
        pending_active, pending_offset = _normalize_anchor(
            pending.get("active_hour"), pending.get("active_hour_offset", 0), pending_cursor
        )
        pending["active_hour"] = pending_active
        pending["active_hour_offset"] = pending_offset
        pending["file_id"] = _normalize_identity(pending.get("file_id"))
        backfill_index = pending.get("backfill_index")
        if backfill_index is not None and (
            isinstance(backfill_index, bool)
            or not isinstance(backfill_index, int)
            or backfill_index < 0
        ):
            raise ShipperError("invalid pending backfill index in shipper state")

    backfill = raw.get("backfill")
    if backfill is not None:
        if not isinstance(backfill, dict):
            raise ShipperError("invalid backfill state in shipper state")
        backfill_extent = backfill.get("source_extent")
        next_batch = backfill.get("next_batch")
        total_batches = backfill.get("total_batches")
        if (
            isinstance(backfill_extent, bool)
            or not isinstance(backfill_extent, int)
            or backfill_extent < 0
            or isinstance(next_batch, bool)
            or not isinstance(next_batch, int)
            or next_batch < 0
            or isinstance(total_batches, bool)
            or not isinstance(total_batches, int)
            or total_batches < 1
            or next_batch > total_batches
        ):
            raise ShipperError("invalid backfill state in shipper state")
        backfill["file_id"] = _normalize_identity(backfill.get("file_id"))
        pending_index = pending.get("backfill_index") if isinstance(pending, dict) else None
        if pending_index is not None and pending_index >= total_batches:
            raise ShipperError("invalid pending backfill index in shipper state")
    return raw


def _save_state(state_path: str, state: Dict[str, Any]) -> None:
    atomic_write_json(state_path, state)


def _backfill_rows(usage_path: str, extent: int) -> list[dict[str, Any]]:
    return aggregate_records(_iter_records(usage_path, 0, extent))


def _run_backfill(
    endpoint: str,
    token: str,
    state_path: str,
    usage_path: str,
    state: Dict[str, Any],
    timeout: float,
    quiet: bool,
    batches: Optional[list[list[dict[str, Any]]]] = None,
) -> bool:
    backfill = state.get("backfill")
    if not isinstance(backfill, dict):
        return True
    if backfill["next_batch"] >= backfill["total_batches"]:
        state["backfill"] = None
        _save_state(state_path, state)
        return True

    if batches is None:
        # Aggregation is deterministic for a stable extent, so an interrupted
        # multi-batch backfill resumes by rebuilding the same batches. The
        # initial run passes them in to avoid aggregating the log twice.
        batches = split_payload_rows(_backfill_rows(usage_path, backfill["source_extent"]))
    if len(batches) != backfill["total_batches"]:
        _warn("backfill source changed; dropping the interrupted backfill")
        state["backfill"] = None
        _save_state(state_path, state)
        return True

    for index in range(backfill["next_batch"], len(batches)):
        batch = batches[index]
        sequence = state["batch_seq"] + 1
        if sequence > MAX_BATCH_SEQ:
            raise ShipperError("batch_seq exceeded the supported integer range")
        pending = {
            "batch_seq": sequence,
            "payload": envelope(sequence, batch),
            "cursor_after": state["cursor"],
            "active_hour": state["active_hour"],
            "active_hour_offset": state["active_hour_offset"],
            "file_id": state["file_id"],
            "backfill_index": index,
            "created_at": utc_now_iso(),
        }
        state["pending"] = pending
        _save_state(state_path, state)

        try:
            _send_once(endpoint, token, pending["payload"], timeout)
        except HTTPPushError as exc:
            print(
                "debitmetre-shipper: backfill batch_seq %d (chunk %d/%d) not acknowledged: %s"
                % (sequence, index + 1, backfill["total_batches"], exc),
                file=sys.stderr,
            )
            return False

        state["batch_seq"] = sequence
        state["pending"] = None
        backfill["next_batch"] = index + 1
        if backfill["next_batch"] >= backfill["total_batches"]:
            state["backfill"] = None
        _save_state(state_path, state)
        if not quiet:
            print(
                "debitmetre-shipper: sent %d usage bucket(s) as backfill batch_seq %d (chunk %d/%d)"
                % (len(batch), sequence, index + 1, backfill["total_batches"])
            )
    return True


def _send_once(endpoint: str, token: str, payload: Dict[str, Any], timeout: float) -> None:
    post_envelope(endpoint, token, payload, timeout_seconds=timeout)


def _send_pending(
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    timeout: float,
    quiet: bool,
) -> bool:
    """Replay the persisted envelope verbatim before the source is inspected."""

    pending = state["pending"]
    sequence = pending["batch_seq"]
    try:
        _send_once(endpoint, token, pending["payload"], timeout)
    except HTTPPushError as exc:
        print(
            "debitmetre-shipper: pending batch_seq %d not acknowledged: %s" % (sequence, exc),
            file=sys.stderr,
        )
        return False

    state["batch_seq"] = sequence
    state["cursor"] = pending["cursor_after"]
    state["active_hour"] = pending.get("active_hour")
    state["active_hour_offset"] = pending.get("active_hour_offset", 0)
    state["file_id"] = pending.get("file_id")
    backfill_index = pending.get("backfill_index")
    if backfill_index is not None:
        backfill = state.get("backfill")
        if isinstance(backfill, dict):
            backfill["next_batch"] = max(backfill["next_batch"], backfill_index + 1)
            if backfill["next_batch"] >= backfill["total_batches"]:
                state["backfill"] = None
    state["pending"] = None
    _save_state(state_path, state)
    if not quiet:
        count = len(pending["payload"].get("usage_buckets") or [])
        if count:
            print("debitmetre-shipper: ACKed pending batch_seq %d (%d bucket(s))" % (sequence, count))
        else:
            print("debitmetre-shipper: ACKed pending heartbeat batch_seq %d" % sequence)
    return True


def _send_rows(
    rows: list[dict[str, Any]],
    cursor_after: int,
    active_hour: Optional[str],
    active_hour_offset: int,
    file_id: Optional[list[int]],
    endpoint: str,
    token: str,
    state_path: str,
    state: Dict[str, Any],
    timeout: float,
    quiet: bool,
) -> bool:
    batches = split_payload_rows(rows)
    for index, batch in enumerate(batches):
        sequence = state["batch_seq"] + 1
        if sequence > MAX_BATCH_SEQ:
            raise ShipperError("batch_seq exceeded the supported integer range")
        is_last = index == len(batches) - 1
        pending = {
            "batch_seq": sequence,
            "payload": envelope(sequence, batch),
            "cursor_after": cursor_after if is_last else state["cursor"],
            "active_hour": active_hour if is_last else state["active_hour"],
            "active_hour_offset": active_hour_offset if is_last else state["active_hour_offset"],
            "file_id": file_id,
            "created_at": utc_now_iso(),
        }
        state["pending"] = pending
        # Persist the exact in-flight batch and the source position it consumes
        # before the first network attempt.
        _save_state(state_path, state)

        try:
            _send_once(endpoint, token, pending["payload"], timeout)
        except HTTPPushError as exc:
            print(
                "debitmetre-shipper: batch_seq %d not acknowledged: %s" % (sequence, exc),
                file=sys.stderr,
            )
            return False

        state["batch_seq"] = sequence
        state["cursor"] = pending["cursor_after"]
        state["active_hour"] = pending["active_hour"]
        state["active_hour_offset"] = pending["active_hour_offset"]
        state["file_id"] = pending["file_id"]
        state["pending"] = None
        _save_state(state_path, state)
        if not quiet:
            if batch:
                print(
                    "debitmetre-shipper: sent %d usage bucket(s) as batch_seq %d"
                    % (len(batch), sequence)
                )
            else:
                print("debitmetre-shipper: sent idle heartbeat as batch_seq %d" % sequence)
    return True


def run_once(
    usage_path: str,
    state_path: str,
    producer_id: str,
    endpoint: str,
    token: str,
    backfill: bool,
    heartbeat: bool,
    timeout: float,
    quiet: bool = False,
) -> bool:
    state = _load_state(state_path, producer_id)
    had_backfill = state.get("backfill") is not None

    pending_acked = False
    if state["pending"] is not None:
        if not _send_pending(endpoint, token, state_path, state, timeout, quiet):
            return False
        pending_acked = True

    # The immutable outbox is replayed before the source is touched, so a
    # missing or rotated input cannot block an already-built batch.
    _require_usage_log(usage_path)

    source_reset = False
    extent, identity, restarted = inspect_source(
        usage_path, state["cursor"], state["file_id"]
    )
    if restarted:
        _warn("usage log was rotated or truncated; restarting from byte 0")
        state["cursor"] = 0
        state["active_hour"] = None
        state["active_hour_offset"] = 0
        state["backfill"] = None
        extent, identity, _ = inspect_source(usage_path, 0, identity)
        state["file_id"] = identity
        # Persist the new generation and the discarded interrupted backfill
        # before any later failure or early return can keep the old state.
        _save_state(state_path, state)
        source_reset = True
    else:
        state["file_id"] = identity

    if state.get("backfill") is not None:
        backfill_state = state["backfill"]
        if backfill_state.get("file_id") not in (None, identity) or os.path.getsize(
            usage_path
        ) < backfill_state["source_extent"]:
            _warn("backfill source was rotated or truncated; restarting")
            state["backfill"] = None
            _save_state(state_path, state)
            source_reset = True
        else:
            backfill_state["file_id"] = identity
            return _run_backfill(
                endpoint,
                token,
                state_path,
                usage_path,
                state,
                timeout,
                quiet,
            )
    if had_backfill and state.get("backfill") is None and not source_reset:
        # A pending batch completed the durable backfill operation; normal
        # shipping resumes on the next tick. A source reset falls through so
        # the replacement generation is processed immediately instead of
        # repeating the same reset on every run.
        return True

    if backfill:
        rows = _backfill_rows(usage_path, extent)
        if not rows:
            _warn("backfill found no canonical usage records")
            return True
        batches = split_payload_rows(rows)
        state["backfill"] = {
            "source_extent": extent,
            "next_batch": 0,
            "total_batches": len(batches),
            "file_id": identity,
        }
        _save_state(state_path, state)
        # A backfill operation is durable: normal periodic runs resume it until
        # every chunk of this stable source extent has been acknowledged.
        return _run_backfill(
            endpoint,
            token,
            state_path,
            usage_path,
            state,
            timeout,
            quiet,
            batches=batches,
        )

    cursor = state["cursor"]
    if extent <= cursor:
        # Idle tick: no source bytes beyond the cursor, so never touch history.
        if heartbeat and not pending_acked:
            return _send_rows(
                [],
                cursor,
                state["active_hour"],
                state["active_hour_offset"],
                identity,
                endpoint,
                token,
                state_path,
                state,
                timeout,
                quiet,
            )
        return True

    touched_hours = _touched_hours(usage_path, cursor, extent)
    if not touched_hours:
        if heartbeat and not pending_acked:
            return _send_rows(
                [],
                extent,
                state["active_hour"],
                state["active_hour_offset"],
                identity,
                endpoint,
                token,
                state_path,
                state,
                timeout,
                quiet,
            )
        return True

    active_hour = state["active_hour"]
    anchor = state["active_hour_offset"]
    # Monotonic appends let the scan start at the active hour; an older late
    # record triggers the exact full stream fallback.
    start = anchor if active_hour is not None and min(touched_hours) >= active_hour else 0
    rows, first_offsets = _aggregate_window(usage_path, start, extent, touched_hours)
    # The anchor follows the latest hour known so far, at its earliest
    # contribution. A multi-hour bootstrap therefore anchors at the final hour
    # instead of dragging every warm tick back across the whole history.
    new_active_hour = max(first_offsets)
    new_anchor = first_offsets[new_active_hour]
    if active_hour is not None and active_hour > new_active_hour:
        # A fallback window always covers the prior maximum, but never move the
        # known state backwards if it cannot.
        new_active_hour = active_hour
        new_anchor = anchor
    return _send_rows(
        rows,
        extent,
        new_active_hour,
        new_anchor,
        identity,
        endpoint,
        token,
        state_path,
        state,
        timeout,
        quiet,
    )


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
        description="Push debitmetre Codex usage.jsonl facts to bilan-ingest.",
    )
    parser.add_argument(
        "--usage-file",
        required=True,
        help="path to debitmetre's canonical usage.jsonl",
    )
    parser.add_argument(
        "--state-file",
        help="durable cursor/outbox path (default: next to usage.jsonl)",
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
        "--backfill",
        action="store_true",
        help="re-send every complete UTC-hour bucket from the whole log without moving the cursor",
    )
    parser.add_argument(
        "--no-heartbeat",
        action="store_true",
        help="do not send an empty liveness envelope when there is no new usage",
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
    try:
        token = _read_token(args.token, args.token_file)
    except ShipperError as exc:
        print("debitmetre-shipper: %s" % exc, file=sys.stderr)
        return 1
    if not token:
        parser.error("--token, --token-file, or BILAN_INGEST_TOKEN is required")

    usage_path = os.path.abspath(args.usage_file)
    state_path = os.path.abspath(args.state_file or _default_state_path(usage_path))
    lock_path = state_path + ".lock"

    try:
        with InstanceLock(lock_path):
            ok = run_once(
                usage_path=usage_path,
                state_path=state_path,
                producer_id=args.producer_id,
                endpoint=args.endpoint,
                token=token,
                backfill=args.backfill,
                heartbeat=not args.no_heartbeat,
                timeout=args.timeout,
                quiet=args.quiet,
            )
    except LockHeldError as exc:
        print("debitmetre-shipper: %s" % exc, file=sys.stderr)
        return 1
    except ShipperError as exc:
        print("debitmetre-shipper: %s" % exc, file=sys.stderr)
        return 1
    except OSError as exc:
        print("debitmetre-shipper: local I/O failure: %s" % exc.__class__.__name__, file=sys.stderr)
        return 1
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
