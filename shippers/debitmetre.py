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
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Iterable, Optional

if __package__:
    from .common import (  # type: ignore[import-not-found]
        HTTPPushError,
        InstanceLock,
        LockHeldError,
        ShipperError,
        atomic_write_json,
        envelope,
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
        load_json_file,
        parse_utc_timestamp,
        post_envelope,
        split_payload_rows,
        utc_hour_start,
        utc_now_iso,
    )

STATE_VERSION = 1
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


def _iter_file_records(usage_path: str) -> Iterable[dict[str, Any]]:
    """Yield canonical records from only newline-terminated lines.

    Debitmetre always terminates every JSONL record with ``\\n``. An unfinished
    trailing line may be a concurrent write, so it is left for a later tick.
    """

    try:
        handle = open(usage_path, "rb")
    except FileNotFoundError:
        return
    with handle:
        for raw in handle:
            if not raw.endswith(b"\n"):
                break
            record = _canonical_record(raw)
            if record is not None:
                yield record


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
        timestamp = parse_utc_timestamp(record.get("timestamp"))
        hour = utc_hour_start(timestamp)
        if touched_hours is not None and hour not in touched_hours:
            continue
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
            continue

        missing_field = False
        for payload_column, usage_field, counted_column in TOKEN_COLUMNS:
            value = _token_value(usage.get(usage_field))
            if value is None:
                missing_field = True
            else:
                _add_token(accumulator, payload_column, counted_column, value)
        if missing_field:
            accumulator["coverage_gaps"] += 1

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


def build_touched_hour_rows(usage_path: str, touched_hours: set[str]) -> list[dict[str, Any]]:
    return aggregate_records(_iter_file_records(usage_path), touched_hours)


def build_all_rows(usage_path: str) -> list[dict[str, Any]]:
    return aggregate_records(_iter_file_records(usage_path))


def _read_appended_records(usage_path: str, cursor: int) -> tuple[list[dict[str, Any]], int, bool]:
    """Read complete appended lines and return (records, new_cursor, reset)."""

    try:
        size = os.path.getsize(usage_path)
    except FileNotFoundError:
        return [], cursor, False
    reset = False
    if cursor > size:
        # The log was rotated or truncated; safely replay the replacement.
        cursor = 0
        reset = True
        size = os.path.getsize(usage_path)

    with open(usage_path, "rb") as handle:
        handle.seek(cursor)
        appended = handle.read()

    last_newline = appended.rfind(b"\n")
    if last_newline < 0:
        return [], cursor, reset
    complete = appended[: last_newline + 1]
    records = []
    for raw in complete.split(b"\n"):
        if not raw:
            continue
        record = _canonical_record(raw)
        if record is not None:
            records.append(record)
    return records, cursor + len(complete), reset


def _default_state_path(usage_path: str) -> str:
    return os.path.join(os.path.dirname(os.path.abspath(usage_path)), ".bilan-debitmetre-state.json")


def _require_usage_log(usage_path: str) -> None:
    if not os.path.exists(usage_path):
        raise ShipperError("usage log not found; refusing to send a heartbeat")
    if not os.path.isfile(usage_path):
        raise ShipperError("usage log path is not a file")


def _load_state(state_path: str, producer_id: str) -> Dict[str, Any]:
    raw = load_json_file(state_path)
    if raw is None:
        return {
            "version": STATE_VERSION,
            "producer_id": producer_id,
            "batch_seq": 0,
            "cursor": 0,
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
    cursor = raw.get("cursor")
    if isinstance(batch_seq, bool) or not isinstance(batch_seq, int) or batch_seq < 0:
        raise ShipperError("invalid batch_seq in shipper state")
    if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
        raise ShipperError("invalid cursor in shipper state")
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
    return raw


def _save_state(state_path: str, state: Dict[str, Any]) -> None:
    atomic_write_json(state_path, state)


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
            "created_at": utc_now_iso(),
        }
        state["pending"] = pending
        # Persist the exact in-flight batch before the first network attempt.
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
    _require_usage_log(usage_path)
    state = _load_state(state_path, producer_id)

    pending_acked = False
    if state["pending"] is not None:
        if not _send_pending(endpoint, token, state_path, state, timeout, quiet):
            return False
        pending_acked = True

    if backfill:
        rows = build_all_rows(usage_path)
        if not rows:
            print("debitmetre-shipper: backfill found no canonical usage records", file=sys.stderr)
            return True
        # Backfill replays the whole file; it never moves the incremental cursor.
        return _send_rows(
            rows,
            state["cursor"],
            endpoint,
            token,
            state_path,
            state,
            timeout,
            quiet,
        )

    records, next_cursor, reset = _read_appended_records(usage_path, state["cursor"])
    if reset:
        print(
            "debitmetre-shipper: usage file shrank below the saved cursor; replaying it",
            file=sys.stderr,
        )

    touched_hours = {_record_hour(record) for record in records}
    rows = build_touched_hour_rows(usage_path, touched_hours) if touched_hours else []

    if rows:
        return _send_rows(
            rows,
            next_cursor,
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
            [],
            next_cursor,
            endpoint,
            token,
            state_path,
            state,
            timeout,
            quiet,
        )
    return True


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
