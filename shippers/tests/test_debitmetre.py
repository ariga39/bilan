"""Behavior tests for the standalone debitmetre shipper CLI.

Every test drives the real command line against a local HTTP ingest endpoint.
The mock endpoint enforces the replay contract (monotonic batch sequence,
duplicate no-op, stale conflict) and records the exact request bytes so retries
can be compared byte-for-byte.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator, Optional

from shippers import debitmetre as shipper_module
from shippers.tests.support import measure_peak_bytes, measure_read_bytes

SHIPPER = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "debitmetre.py"))
INGEST_PATH = "/api/v1/ingest"
TOKEN = "test-scoped-token"


def _usage(**overrides: Any) -> dict[str, Optional[int]]:
    usage: dict[str, Optional[int]] = {
        "input_total": 100,
        "uncached": 40,
        "cache_read": 50,
        "cache_write": 10,
        "output_total": 20,
        "reasoning": 5,
        "total": 125,
    }
    usage.update(overrides)
    return usage


_DEFAULT = object()


def audit_record(
    timestamp: str,
    *,
    machine_id: str = "machine-a",
    model: Optional[str] = "gpt-5",
    reasoning_effort: Optional[str] = "high",
    usage: Any = _DEFAULT,
    accounting_quality: str = "complete",
    schema_version: int = 1,
    kind: str = "request",
) -> dict[str, Any]:
    return {
        "schema_version": schema_version,
        "kind": kind,
        "event_id": "event-" + timestamp,
        "timestamp": timestamp,
        "machine_id": machine_id,
        "operation": "response",
        "upstream_status": 200,
        "outcome": "completed",
        "model": model,
        "accounting_quality": accounting_quality,
        "metering_error": None,
        "reasoning_effort": reasoning_effort,
        "usage": _usage() if usage is _DEFAULT else usage,
    }


def hourly_records(
    count: int,
    start: datetime,
    *,
    machine_id: str = "machine-a",
) -> list[dict[str, Any]]:
    return [
        audit_record(
            (start + timedelta(hours=index)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            machine_id=machine_id,
        )
        for index in range(count)
    ]


class _IngestState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.get_requests: list[str] = []
        self.rows: dict[tuple[Any, ...], dict[str, Any]] = {}
        self.last_seq = 0
        self.commits = 0
        self.duplicates = 0
        self.conflicts = 0
        self.drop_next_response = False
        self.drop_response_at: Optional[int] = None
        self.fail_next_status: Optional[int] = None
        self.fail_next_location: Optional[str] = None
        self.discard = False
        self.on_receive: Any = None

    def receive(
        self,
        body: bytes,
        authorization: Optional[str],
        path: str,
    ) -> tuple[int, bool, Optional[str]]:
        if self.discard:
            with self.lock:
                self.requests.append(
                    {
                        "body": body,
                        "payload": None,
                        "authorization": authorization,
                        "path": path,
                        "status": 200,
                        "dropped": False,
                    }
                )
            return 200, False, None
        with self.lock:
            payload = json.loads(body.decode("utf-8"))
            if self.fail_next_status is not None:
                status = self.fail_next_status
                location = self.fail_next_location
                self.fail_next_status = None
                self.fail_next_location = None
                self.requests.append(
                    {
                        "body": body,
                        "payload": payload,
                        "authorization": authorization,
                        "path": path,
                        "status": status,
                        "dropped": False,
                    }
                )
                return status, False, location

            sequence = payload["batch_seq"]
            status: int
            if sequence < self.last_seq:
                status = 409
                self.conflicts += 1
            elif sequence == self.last_seq:
                status = 200
                self.duplicates += 1
            else:
                for row in payload.get("usage_buckets") or []:
                    key = (
                        row["source"],
                        row["account"],
                        row["actor_kind"],
                        row["actor_id"],
                        row["model"],
                        row["effort"],
                        row["bucket_start"],
                    )
                    self.rows[key] = row
                self.last_seq = sequence
                self.commits += 1
                status = 200

            drop = self.drop_next_response
            if drop:
                self.drop_next_response = False
            if self.drop_response_at == len(self.requests) + 1:
                drop = True
                self.drop_response_at = None
            self.requests.append(
                {
                    "body": body,
                    "payload": payload,
                    "authorization": authorization,
                    "path": path,
                    "status": status,
                    "dropped": drop,
                }
            )
            return status, drop, None

    def record_get(self, path: str) -> None:
        with self.lock:
            self.get_requests.append(path)

    def snapshot_requests(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.requests)

    def snapshot_gets(self) -> list[str]:
        with self.lock:
            return list(self.get_requests)

    def snapshot_rows(self) -> dict[tuple[Any, ...], dict[str, Any]]:
        with self.lock:
            return dict(self.rows)

    def stats(self) -> tuple[int, int, int, int]:
        with self.lock:
            return self.last_seq, self.commits, self.duplicates, self.conflicts


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - stdlib handler name
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if self.path != INGEST_PATH:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        status, drop, location = self.server.ingest.receive(  # type: ignore[attr-defined]
            body,
            self.headers.get("Authorization"),
            self.path,
        )
        callback = self.server.ingest.on_receive  # type: ignore[attr-defined]
        if callback is not None:
            self.server.ingest.on_receive = None  # type: ignore[attr-defined]
            callback()
        if drop:
            # The mock "commits" the batch but loses the ACK by closing the
            # socket without writing a response.
            self.close_connection = True
            return
        response = b"{}"
        self.send_response(status)
        if location is not None:
            self.send_header("Location", location)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler name
        self.server.ingest.record_get(self.path)  # type: ignore[attr-defined]
        response = b"login"
        self.send_response(200)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args: Any) -> None:
        pass


class DebitmetreShipperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.mkdtemp(prefix="bilan-shipper-test-")
        self.usage_path = os.path.join(self.tempdir, "usage.jsonl")
        self.state_path = os.path.join(self.tempdir, "shipper-state.json")
        self.ingest = _IngestState()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.daemon_threads = True
        self.server.ingest = self.ingest  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.endpoint = "http://%s:%d%s" % (host, port, INGEST_PATH)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        shutil.rmtree(self.tempdir, ignore_errors=True)

    # -- helpers ---------------------------------------------------------

    def write_records(
        self,
        records: list[dict[str, Any]],
        *,
        path: Optional[str] = None,
        trailing_newline: bool = True,
        append: bool = False,
    ) -> int:
        target = path or self.usage_path
        chunks = [json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n" for record in records]
        data = b"".join(chunks)
        if data and not trailing_newline:
            data = data[:-1]
        mode = "ab" if append else "wb"
        with open(target, mode) as handle:
            handle.write(data)
        return os.path.getsize(target)

    def run_cli(
        self,
        *,
        usage_path: Optional[str] = None,
        state_path: Optional[str] = None,
        extra: Optional[list[str]] = None,
        cwd: Optional[str] = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            SHIPPER,
            "--usage-file",
            usage_path or self.usage_path,
            "--state-file",
            state_path or self.state_path,
            "--endpoint",
            self.endpoint,
            "--token",
            TOKEN,
            "--timeout",
            "5",
        ]
        command.extend(extra or [])
        environment = os.environ.copy()
        environment.pop("BILAN_INGEST_URL", None)
        environment.pop("BILAN_INGEST_TOKEN", None)
        environment["NO_PROXY"] = "127.0.0.1,localhost"
        environment["no_proxy"] = "127.0.0.1,localhost"
        return subprocess.run(
            command,
            cwd=cwd or self.tempdir,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def read_state(self, path: Optional[str] = None) -> dict[str, Any]:
        with open(path or self.state_path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def bucket_map(self, payload: dict[str, Any]) -> dict[tuple[str, str, str, str], dict[str, Any]]:
        return {
            (
                row["bucket_start"],
                row["actor_id"],
                row["model"],
                row["effort"],
            ): row
            for row in payload["usage_buckets"]
        }

    def assert_ok(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stderr)

    def write_records_streaming(
        self,
        records: Any,
        *,
        path: Optional[str] = None,
        append: bool = False,
    ) -> int:
        target = path or self.usage_path
        with open(target, "ab" if append else "wb") as handle:
            for record in records:
                handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
        return os.path.getsize(target)

    def run_paths(
        self, usage_path: str, state_path: str, *, backfill: bool = False
    ) -> bool:
        return shipper_module.run_once(
            usage_path=usage_path,
            state_path=state_path,
            producer_id="debitmetre-main",
            endpoint=self.endpoint,
            token=TOKEN,
            backfill=backfill,
            heartbeat=True,
            timeout=5,
            quiet=True,
        )

    def run_in_process(self, *, backfill: bool = False, heartbeat: bool = True) -> bool:
        return shipper_module.run_once(
            usage_path=self.usage_path,
            state_path=self.state_path,
            producer_id="debitmetre-main",
            endpoint=self.endpoint,
            token=TOKEN,
            backfill=backfill,
            heartbeat=heartbeat,
            timeout=5,
            quiet=True,
        )

    @staticmethod
    def bootstrap_records(old_rows: int) -> Iterator[dict[str, Any]]:
        for _ in range(old_rows):
            yield audit_record("2026-01-01T00:05:00Z", machine_id="machine-a")
        for _ in range(8):
            yield audit_record("2026-02-01T00:05:00Z", machine_id="machine-a")

    def _first_warm_read_bytes(self, label: str, old_rows: int) -> int:
        directory = os.path.join(self.tempdir, label)
        os.makedirs(directory)
        usage = os.path.join(directory, "usage.jsonl")
        state = os.path.join(directory, "state.json")
        self.write_records_streaming(self.bootstrap_records(old_rows), path=usage)
        self.assertTrue(self.run_paths(usage, state))
        extra = audit_record("2026-02-01T00:10:00Z", machine_id="machine-a")
        with open(usage, "ab") as handle:
            handle.write(json.dumps(extra, separators=(",", ":")).encode("utf-8") + b"\n")
        with measure_read_bytes(usage) as meter:
            self.assertTrue(self.run_paths(usage, state))
        return meter["bytes"]

    # -- tests -----------------------------------------------------------

    def test_aggregates_complete_touched_hours_with_null_zero_and_effort_semantics(self) -> None:
        hour = "2026-10-31T16:00:00Z"
        records = [
            audit_record(
                "2026-10-31T16:05:00Z",
                machine_id="machine-a",
                model="gpt-5",
                reasoning_effort="high",
            ),
            # Explicit zeros are recorded values, not missing fields.
            audit_record(
                "2026-10-31T16:10:00Z",
                machine_id="machine-a",
                model="gpt-5",
                reasoning_effort="high",
                usage=_usage(
                    input_total=0,
                    uncached=0,
                    cache_read=0,
                    cache_write=0,
                    output_total=0,
                    reasoning=0,
                    total=0,
                ),
            ),
            # A partially metered request (only output is known) leaks into the
            # same hour but stays a distinct unlabelled-effort row.
            audit_record(
                "2026-10-31T16:20:00Z",
                machine_id="machine-a",
                model="gpt-5",
                reasoning_effort=None,
                accounting_quality="partial",
                usage=_usage(
                    input_total=None,
                    uncached=None,
                    cache_read=None,
                    cache_write=None,
                    output_total=7,
                    reasoning=None,
                    total=None,
                ),
            ),
            # An unmetered accepted lifecycle still counts as a unit and a gap.
            audit_record(
                "2026-10-31T16:30:00Z",
                machine_id="machine-b",
                model=None,
                reasoning_effort="low",
                accounting_quality="unavailable",
                usage=None,
            ),
            # All-zero bucket proves NULL and 0 remain distinguishable.
            audit_record(
                "2026-10-31T16:40:00Z",
                machine_id="machine-c",
                model="gpt-5",
                reasoning_effort="low",
                usage=_usage(
                    input_total=0,
                    uncached=0,
                    cache_read=0,
                    cache_write=0,
                    output_total=0,
                    reasoning=0,
                    total=0,
                ),
            ),
            # A different hour must not be re-sent when only hour 16 is touched.
            audit_record(
                "2026-10-31T17:05:00Z",
                machine_id="machine-d",
                model="gpt-5",
                reasoning_effort="high",
            ),
        ]
        size = self.write_records(records)

        result = self.run_cli()
        self.assert_ok(result)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["authorization"], "Bearer " + TOKEN)
        payload = requests[0]["payload"]
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["batch_seq"], 1)
        self.assertEqual(payload["quota_observations"], [])
        self.assertEqual(payload["balance_snapshots"], [])
        self.assertEqual(len(payload["usage_buckets"]), 5)

        buckets = self.bucket_map(payload)
        high = buckets[(hour, "machine-a", "gpt-5", "high")]
        self.assertEqual(high["source"], "codex")
        self.assertEqual(high["account"], "default")
        self.assertEqual(high["actor_kind"], "machine")
        self.assertEqual(high["unit_kind"], "request")
        self.assertEqual(high["accounting_basis"], "debitmetre-audit-v1")
        self.assertEqual(high["unit_count"], 2)
        self.assertEqual(high["coverage_gaps"], 0)
        self.assertEqual(high["input_tokens"], 100)
        self.assertEqual(high["input_counted"], 2)  # the explicit zero counted too
        self.assertEqual(high["uncached_tokens"], 40)
        self.assertEqual(high["uncached_counted"], 2)
        self.assertEqual(high["cached_tokens"], 50)
        self.assertEqual(high["cached_counted"], 2)
        self.assertEqual(high["cache_write_tokens"], 10)
        self.assertEqual(high["cache_write_counted"], 2)
        self.assertEqual(high["output_tokens"], 20)
        self.assertEqual(high["output_counted"], 2)
        self.assertEqual(high["reasoning_tokens"], 5)
        self.assertEqual(high["reasoning_counted"], 2)
        self.assertNotIn("total_tokens", high)
        self.assertNotIn("total", high)

        unlabelled = buckets[(hour, "machine-a", "gpt-5", "")]
        self.assertEqual(unlabelled["unit_count"], 1)
        self.assertEqual(unlabelled["coverage_gaps"], 1)
        self.assertIsNone(unlabelled["input_tokens"])
        self.assertEqual(unlabelled["input_counted"], 0)
        self.assertEqual(unlabelled["output_tokens"], 7)
        self.assertEqual(unlabelled["output_counted"], 1)
        self.assertIsNone(unlabelled["reasoning_tokens"])
        self.assertEqual(unlabelled["reasoning_counted"], 0)

        unmetered = buckets[(hour, "machine-b", "unknown", "low")]
        self.assertEqual(unmetered["unit_count"], 1)
        self.assertEqual(unmetered["coverage_gaps"], 1)
        self.assertIsNone(unmetered["input_tokens"])
        self.assertEqual(unmetered["input_counted"], 0)

        zeros = buckets[(hour, "machine-c", "gpt-5", "low")]
        self.assertEqual(zeros["unit_count"], 1)
        self.assertEqual(zeros["coverage_gaps"], 0)
        self.assertEqual(zeros["input_tokens"], 0)
        self.assertEqual(zeros["input_counted"], 1)
        self.assertEqual(zeros["output_tokens"], 0)
        self.assertEqual(zeros["output_counted"], 1)

        state = self.read_state()
        self.assertEqual(state["producer_id"], "debitmetre-main")
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["cursor"], size)
        self.assertIsNone(state["pending"])

        # Append a new record to the already-shipped hour. The retry must send
        # the complete hour again (including earlier lines), not a delta.
        self.write_records(
            [audit_record("2026-10-31T16:55:00Z", machine_id="machine-a", model="gpt-5", reasoning_effort="high")],
            append=True,
        )
        result = self.run_cli()
        self.assert_ok(result)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        second = requests[1]["payload"]
        self.assertEqual(second["batch_seq"], 2)
        second_buckets = self.bucket_map(second)
        self.assertEqual(len(second_buckets), 4)  # only the four hour-16 rows
        self.assertTrue(all(key[0] == hour for key in second_buckets))
        self.assertEqual(second_buckets[(hour, "machine-a", "gpt-5", "high")]["unit_count"], 3)
        self.assertEqual(second_buckets[(hour, "machine-a", "gpt-5", "high")]["input_tokens"], 200)
        self.assertEqual(second_buckets[(hour, "machine-a", "gpt-5", "high")]["input_counted"], 3)

    def test_preserves_utc_hours_for_utc_plus_8_month_slicing(self) -> None:
        self.write_records(
            [
                # 2026-10-31 23:59 in UTC+8
                audit_record("2026-10-31T15:59:00Z"),
                # 2026-11-01 00:00 in UTC+8
                audit_record("2026-10-31T16:00:00Z"),
            ]
        )
        result = self.run_cli()
        self.assert_ok(result)
        payload = self.ingest.snapshot_requests()[0]["payload"]
        starts = sorted(row["bucket_start"] for row in payload["usage_buckets"])
        self.assertEqual(starts, ["2026-10-31T15:00:00Z", "2026-10-31T16:00:00Z"])

    def test_lost_ack_retries_identical_persisted_batch_without_double_counting(self) -> None:
        self.write_records([audit_record("2026-11-01T09:05:00Z")])
        self.ingest.drop_next_response = True

        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(self.ingest.stats()[0], 1)
        self.assertEqual(self.ingest.stats()[1], 1)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 0)
        self.assertEqual(state["pending"]["batch_seq"], 1)
        self.assertEqual(state["pending"]["payload"]["batch_seq"], 1)
        first_body = self.ingest.snapshot_requests()[0]["body"]

        second = self.run_cli()
        self.assert_ok(second)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["body"], first_body)
        self.assertEqual(requests[1]["payload"]["batch_seq"], 1)
        last_seq, commits, duplicates, conflicts = self.ingest.stats()
        self.assertEqual((last_seq, commits, duplicates, conflicts), (1, 1, 1, 0))
        self.assertEqual(len(self.ingest.snapshot_rows()), 1)

        state = self.read_state()
        self.assertEqual(state["batch_seq"], 1)
        self.assertIsNone(state["pending"])
        self.assertEqual(state["cursor"], os.path.getsize(self.usage_path))

        # Idle run: only a heartbeat is sent and no usage row is rewritten.
        third = self.run_cli()
        self.assert_ok(third)
        heartbeat = self.ingest.snapshot_requests()[2]["payload"]
        self.assertEqual(heartbeat["batch_seq"], 2)
        self.assertEqual(heartbeat["usage_buckets"], [])
        self.assertEqual(heartbeat["quota_observations"], [])
        self.assertEqual(heartbeat["balance_snapshots"], [])
        self.assertEqual(len(self.ingest.snapshot_rows()), 1)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 2)
        self.assertEqual(state["cursor"], os.path.getsize(self.usage_path))

    def test_202_accepted_does_not_clear_pending_before_exact_200(self) -> None:
        self.write_records([audit_record("2026-11-01T09:05:00Z")])
        self.ingest.fail_next_status = 202

        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        last_seq, commits, duplicates, conflicts = self.ingest.stats()
        self.assertEqual((last_seq, commits, duplicates, conflicts), (0, 0, 0, 0))
        state = self.read_state()
        self.assertEqual(state["pending"]["batch_seq"], 1)
        first_body = self.ingest.snapshot_requests()[0]["body"]

        second = self.run_cli()
        self.assert_ok(second)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["body"], first_body)
        self.assertEqual(self.ingest.stats(), (1, 1, 0, 0))
        self.assertIsNone(self.read_state()["pending"])

    def test_login_redirect_is_not_followed_and_pending_is_retried(self) -> None:
        self.write_records([audit_record("2026-11-01T09:05:00Z")])
        self.ingest.fail_next_status = 302
        self.ingest.fail_next_location = "/login"

        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(self.ingest.snapshot_gets(), [])
        self.assertEqual(self.ingest.stats(), (0, 0, 0, 0))
        state = self.read_state()
        self.assertEqual(state["pending"]["batch_seq"], 1)
        first_body = self.ingest.snapshot_requests()[0]["body"]

        second = self.run_cli()
        self.assert_ok(second)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["body"], first_body)
        self.assertEqual(self.ingest.snapshot_gets(), [])
        self.assertEqual(self.ingest.stats(), (1, 1, 0, 0))
        self.assertIsNone(self.read_state()["pending"])

    def test_missing_usage_log_fails_before_sending_a_heartbeat(self) -> None:
        result = self.run_cli()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("usage log not found", result.stderr)
        self.assertEqual(self.ingest.snapshot_requests(), [])

    def test_existing_empty_usage_log_still_sends_an_idle_heartbeat(self) -> None:
        self.write_records([])

        result = self.run_cli()

        self.assert_ok(result)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["payload"]["usage_buckets"], [])
        self.assertEqual(requests[0]["payload"]["batch_seq"], 1)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["cursor"], 0)

    def test_idle_heartbeat_can_be_disabled_without_moving_data_age(self) -> None:
        self.write_records([audit_record("2026-11-01T10:05:00Z")])
        self.assert_ok(self.run_cli())
        before = self.read_state()

        result = self.run_cli(extra=["--no-heartbeat"])
        self.assert_ok(result)
        self.assertEqual(len(self.ingest.snapshot_requests()), 1)
        after = self.read_state()
        self.assertEqual(after["batch_seq"], before["batch_seq"])
        self.assertEqual(after["cursor"], before["cursor"])
        self.assertEqual(len(self.ingest.snapshot_rows()), 1)

    def test_backfill_replays_history_without_moving_cursor_and_is_idempotent(self) -> None:
        self.write_records(
            [
                audit_record("2026-09-15T03:05:00Z", machine_id="machine-a"),
                audit_record("2026-09-15T04:05:00Z", machine_id="machine-b"),
            ]
        )
        self.assert_ok(self.run_cli())
        state_after_normal = self.read_state()
        self.assertEqual(state_after_normal["batch_seq"], 1)
        self.assertEqual(len(self.ingest.snapshot_rows()), 2)

        # A late line appended after the cursor must be picked up by a
        # historical replay of the whole file.
        self.write_records(
            [audit_record("2026-09-15T03:55:00Z", machine_id="machine-a")],
            append=True,
        )
        self.assertEqual(len(self.ingest.snapshot_rows()), 2)

        self.assert_ok(self.run_cli(extra=["--backfill"]))
        state_after_first_backfill = self.read_state()
        self.assertEqual(state_after_first_backfill["batch_seq"], 2)
        self.assertEqual(state_after_first_backfill["cursor"], state_after_normal["cursor"])
        first_backfill = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(len(first_backfill["usage_buckets"]), 2)
        buckets = self.bucket_map(first_backfill)
        self.assertEqual(buckets[("2026-09-15T03:00:00Z", "machine-a", "gpt-5", "high")]["unit_count"], 2)
        self.assertEqual(len(self.ingest.snapshot_rows()), 2)

        self.assert_ok(self.run_cli(extra=["--backfill"]))
        state_after_second_backfill = self.read_state()
        self.assertEqual(state_after_second_backfill["batch_seq"], 3)
        self.assertEqual(state_after_second_backfill["cursor"], state_after_normal["cursor"])
        second_backfill = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(second_backfill["usage_buckets"], first_backfill["usage_buckets"])
        self.assertEqual(len(self.ingest.snapshot_rows()), 2)

    def test_unfinished_trailing_line_is_not_consumed_until_complete(self) -> None:
        first = audit_record("2026-11-01T11:05:00Z", machine_id="machine-a")
        second = audit_record("2026-11-01T11:25:00Z", machine_id="machine-a")
        self.write_records([first])
        partial = json.dumps(second, separators=(",", ":")).encode("utf-8")
        with open(self.usage_path, "ab") as handle:
            handle.write(partial[:25])
        first_size = os.path.getsize(self.usage_path)

        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(len(payload["usage_buckets"]), 1)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 1)
        self.assertEqual(self.read_state()["cursor"], first_size - len(partial[:25]))

        with open(self.usage_path, "ab") as handle:
            handle.write(partial[25:] + b"\n")
        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[1]["payload"]
        self.assertEqual(len(payload["usage_buckets"]), 1)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 2)
        self.assertEqual(self.read_state()["cursor"], os.path.getsize(self.usage_path))

    def test_pending_is_replayed_before_a_rotated_generation_is_read(self) -> None:
        records = [audit_record("2026-11-01T13:05:00Z", machine_id="machine-a")]
        self.write_records(records)
        self.ingest.drop_next_response = True
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        state = self.read_state()
        self.assertEqual(state["pending"]["batch_seq"], 1)
        self.assertEqual(state["pending"]["cursor_after"], os.path.getsize(self.usage_path))
        first_body = self.ingest.snapshot_requests()[0]["body"]

        replacement = [audit_record("2026-11-01T14:05:00Z", machine_id="machine-b")]
        rotated = os.path.join(self.tempdir, "usage.next.jsonl")
        with open(rotated, "wb") as handle:
            for record in replacement:
                handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
        replacement_size = os.path.getsize(rotated)
        os.replace(rotated, self.usage_path)

        second = self.run_cli()
        self.assert_ok(second)
        self.assertIn("rotated or truncated", second.stderr)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 3)
        # The immutable outbox is retried byte-for-byte before the new
        # generation is read from zero.
        self.assertEqual(requests[1]["body"], first_body)
        self.assertEqual(requests[2]["payload"]["batch_seq"], 2)
        self.assertEqual(
            set(self.bucket_map(requests[2]["payload"])),
            {("2026-11-01T14:00:00Z", "machine-b", "gpt-5", "high")},
        )
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 2)
        self.assertEqual(state["cursor"], replacement_size)
        self.assertIsNone(state["pending"])

    def test_backfill_reads_the_source_once_on_a_fresh_run(self) -> None:
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        records = hourly_records(1500, start)
        size = self.write_records(records)
        self.ingest.discard = True

        with measure_read_bytes(self.usage_path) as meter:
            self.assertTrue(self.run_in_process(backfill=True))

        # One aggregation pass plus the bounded tail scan, not a second full
        # aggregation of the same stable extent.
        self.assertLess(meter["bytes"], size + 128 * 1024)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 3)
        self.assertIsNone(state["backfill"])

    def test_incremental_aggregation_is_bounded_to_captured_extent(self) -> None:
        first = audit_record("2026-11-01T16:05:00Z", machine_id="machine-a")
        self.write_records([first])
        captured_extent = os.path.getsize(self.usage_path)
        late = audit_record("2026-11-01T16:35:00Z", machine_id="machine-a")
        self.ingest.on_receive = lambda: self.write_records([late], append=True)

        self.assertTrue(self.run_in_process())

        payload = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 1)
        state = self.read_state()
        self.assertEqual(state["cursor"], captured_extent)

        # The concurrent append is picked up by the next run.
        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 2)
        self.assertEqual(self.read_state()["cursor"], os.path.getsize(self.usage_path))

    def test_interrupted_backfill_resumes_remaining_chunks_on_normal_run(self) -> None:
        start = datetime(2026, 1, 1, 0, 5, tzinfo=timezone.utc)
        first = audit_record("2026-01-01T00:05:00Z", machine_id="machine-a")
        first_size = self.write_records([first])
        self.assert_ok(self.run_cli())
        preexisting_cursor = self.read_state()["cursor"]
        self.assertEqual(preexisting_cursor, first_size)
        self.assertEqual(len(self.ingest.snapshot_requests()), 1)

        backfill_records = hourly_records(1001, start + timedelta(hours=1))
        self.write_records([first, *backfill_records])
        source_extent = os.path.getsize(self.usage_path)
        self.ingest.drop_response_at = 3  # normal #1, backfill chunk 1 #2, chunk 2 #3

        interrupted = self.run_cli(extra=["--backfill"])
        self.assertNotEqual(interrupted.returncode, 0)
        state = self.read_state()
        self.assertEqual(state["cursor"], preexisting_cursor)
        self.assertEqual(state["backfill"]["source_extent"], source_extent)
        self.assertIsNotNone(state["pending"])
        self.assertEqual(state["pending"]["backfill_index"], 1)
        self.assertEqual(state["backfill"]["next_batch"], 1)
        self.assertEqual(state["backfill"]["total_batches"], 3)
        self.assertEqual(len(self.ingest.snapshot_requests()), 3)

        # Interrupt the replayed outbox a second time: the same deterministic
        # resume must still converge across multiple batches.
        self.ingest.drop_response_at = 4
        again = self.run_cli()
        self.assertNotEqual(again.returncode, 0)
        state = self.read_state()
        self.assertEqual(state["pending"]["backfill_index"], 1)
        self.assertEqual(state["backfill"]["next_batch"], 1)

        # Appending beyond the stable backfill extent must not enter this
        # operation or advance the incremental cursor.
        after = audit_record("2026-03-15T12:05:00Z", machine_id="machine-after")
        self.write_records([after], append=True)
        resumed = self.run_cli()
        self.assert_ok(resumed)
        state = self.read_state()
        self.assertIsNone(state["pending"])
        self.assertIsNone(state["backfill"])
        self.assertEqual(state["cursor"], preexisting_cursor)
        self.assertEqual(state["batch_seq"], 4)
        self.assertEqual(len(self.ingest.snapshot_requests()), 6)
        self.assertEqual(len(self.ingest.snapshot_rows()), 1002)
        self.assertFalse(
            any(row["actor_id"] == "machine-after" for row in self.ingest.snapshot_rows().values())
        )

        # The next normal run processes the appended record from the unchanged
        # cursor, proving the durable backfill did not skip it.
        self.assert_ok(self.run_cli())
        state = self.read_state()
        self.assertEqual(state["cursor"], os.path.getsize(self.usage_path))
        self.assertEqual(len(self.ingest.snapshot_rows()), 1003)
        self.assertTrue(
            any(row["actor_id"] == "machine-after" for row in self.ingest.snapshot_rows().values())
        )

    def test_replaced_source_generation_restarts_even_when_regrown(self) -> None:
        self.write_records([audit_record("2026-11-01T11:05:00Z", machine_id="machine-a")])
        self.assert_ok(self.run_cli())
        shipped_state = self.read_state()

        replacement = [
            audit_record("2026-11-01T12:05:00Z", machine_id="machine-z"),
            audit_record("2026-11-01T12:15:00Z", machine_id="machine-z"),
        ]
        rotated = os.path.join(self.tempdir, "usage.grown.jsonl")
        with open(rotated, "wb") as handle:
            for record in replacement:
                handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
        new_size = os.path.getsize(rotated)
        self.assertGreater(new_size, shipped_state["cursor"])
        os.replace(rotated, self.usage_path)

        replaced = self.run_cli()
        self.assert_ok(replaced)
        self.assertIn("rotated or truncated", replaced.stderr)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(payload["batch_seq"], 2)
        self.assertEqual(
            set(self.bucket_map(payload)),
            {("2026-11-01T12:00:00Z", "machine-z", "gpt-5", "high")},
        )
        state = self.read_state()
        self.assertEqual(state["cursor"], new_size)
        self.assertNotEqual(state["file_id"], shipped_state["file_id"])
        self.assertEqual(
            state["file_id"],
            [os.stat(self.usage_path).st_dev, os.stat(self.usage_path).st_ino],
        )

    def test_truncated_source_restarts_with_a_warning(self) -> None:
        records = [
            audit_record("2026-11-01T10:05:00Z", machine_id="machine-a"),
            audit_record("2026-11-01T10:25:00Z", machine_id="machine-a"),
        ]
        self.write_records(records)
        self.assert_ok(self.run_cli())
        self.assertEqual(self.ingest.snapshot_requests()[0]["payload"]["usage_buckets"][0]["unit_count"], 2)

        # A same-generation truncation is accepted as an accounting loss for
        # the active hour; the shipper warns and restarts instead of locking up.
        truncated_size = self.write_records(records[:1])
        truncated = self.run_cli()
        self.assert_ok(truncated)
        self.assertIn("rotated or truncated", truncated.stderr)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(payload["batch_seq"], 2)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 1)
        self.assertEqual(self.read_state()["cursor"], truncated_size)

        # Appending afterwards resumes normally and rebuilds the complete hour.
        self.write_records(
            [audit_record("2026-11-01T10:25:00Z", machine_id="machine-a")], append=True
        )
        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 2)
        self.assertEqual(self.read_state()["cursor"], os.path.getsize(self.usage_path))

    def test_backfill_extent_state_migrates_intact(self) -> None:
        records = [
            audit_record("2026-11-01T15:05:00Z", machine_id="machine-a"),
            audit_record("2026-11-01T15:25:00Z", machine_id="machine-a"),
        ]
        self.write_records(records)
        self.assert_ok(self.run_cli(extra=["--backfill"]))
        self.assertEqual(self.read_state()["cursor"], 0)

        migrated = tempfile.mkdtemp(prefix="bilan-shipper-migrated-", dir=self.tempdir)
        migrated_usage = os.path.join(migrated, "usage.jsonl")
        migrated_state = os.path.join(migrated, "state.json")
        shutil.copyfile(self.usage_path, migrated_usage)
        shutil.copyfile(self.state_path, migrated_state)
        with open(migrated_usage, "ab") as handle:
            record = audit_record("2026-11-01T15:45:00Z", machine_id="machine-a")
            handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")

        result = self.run_cli(usage_path=migrated_usage, state_path=migrated_state, cwd=migrated)
        self.assert_ok(result)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(payload["batch_seq"], 2)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 3)

    def test_migrated_host_keeps_logical_producer_and_sequence(self) -> None:
        self.write_records([audit_record("2026-11-02T01:05:00Z", machine_id="machine-a")])
        self.assert_ok(self.run_cli())
        self.assertEqual(self.ingest.stats()[0], 1)

        migrated = tempfile.mkdtemp(prefix="bilan-shipper-migrated-", dir=self.tempdir)
        migrated_usage = os.path.join(migrated, "usage.jsonl")
        migrated_state = os.path.join(migrated, "state.json")
        shutil.copyfile(self.usage_path, migrated_usage)
        shutil.copyfile(self.state_path, migrated_state)
        with open(migrated_usage, "ab") as handle:
            record = audit_record("2026-11-02T01:30:00Z", machine_id="machine-a")
            handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")

        result = self.run_cli(usage_path=migrated_usage, state_path=migrated_state, cwd=migrated)
        self.assert_ok(result)
        self.assertEqual(self.ingest.stats()[0], 2)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(payload["batch_seq"], 2)
        self.assertEqual(len(payload["usage_buckets"]), 1)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 2)
        self.assertEqual(self.read_state(migrated_state)["producer_id"], "debitmetre-main")

    def test_splits_payloads_at_the_500_row_contract_limit(self) -> None:
        records = []
        for index in range(501):
            hour = 1 + index  # 2026-01-01T01:00Z plus index hours
            day = 1 + hour // 24
            hour_of_day = hour % 24
            records.append(
                audit_record(
                    "2026-01-%02dT%02d:05:00Z" % (day, hour_of_day),
                    machine_id="machine-a",
                )
            )
        self.write_records(records)

        self.assert_ok(self.run_cli())
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(len(requests[0]["payload"]["usage_buckets"]), 500)
        self.assertEqual(requests[0]["payload"]["batch_seq"], 1)
        self.assertEqual(len(requests[1]["payload"]["usage_buckets"]), 1)
        self.assertEqual(requests[1]["payload"]["batch_seq"], 2)
        self.assertEqual(len(self.ingest.snapshot_rows()), 501)
        self.assertEqual(self.read_state()["batch_seq"], 2)

    def test_ignores_noncanonical_and_malformed_lines(self) -> None:
        with open(self.usage_path, "wb") as handle:
            handle.write(b"{not json}\n")
            handle.write(b"\n")
            handle.write(
                json.dumps(
                    audit_record("2026-11-03T01:05:00Z", kind="compaction"),
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            handle.write(
                json.dumps(
                    audit_record("2026-11-03T01:10:00Z", schema_version=2),
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            handle.write(
                json.dumps(
                    audit_record("2026-11-03T01:15:00Z"),
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )

        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(len(payload["usage_buckets"]), 1)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 1)

    # -- streaming, anchors and rotation ---------------------------------

    def test_idle_tick_reads_no_source_bytes(self) -> None:
        self.write_records([audit_record("2026-11-01T10:05:00Z")])
        self.assert_ok(self.run_cli())
        size = os.path.getsize(self.usage_path)

        with measure_read_bytes(self.usage_path) as meter:
            self.assertTrue(self.run_in_process())

        self.assertEqual(meter["bytes"], 0)
        self.assertEqual(self.read_state()["cursor"], size)
        self.assertEqual(len(self.ingest.snapshot_requests()), 2)  # idle heartbeat

    def test_first_warm_tick_after_multi_hour_bootstrap_reads_only_active_tail(self) -> None:
        self.write_records_streaming(self.bootstrap_records(15_000))
        self.assertGreater(os.path.getsize(self.usage_path), 4 * 1024 * 1024)
        self.assertTrue(self.run_in_process())
        state = self.read_state()
        self.assertEqual(state["active_hour"], "2026-02-01T00:00:00Z")
        self.assertGreater(state["active_hour_offset"], 0)

        # The idle tick between the bootstrap and the first append must not
        # read history either.
        with measure_read_bytes(self.usage_path) as idle:
            self.assertTrue(self.run_in_process())
        self.assertEqual(idle["bytes"], 0)

        extra = audit_record("2026-02-01T00:10:00Z", machine_id="machine-a")
        with open(self.usage_path, "ab") as handle:
            handle.write(json.dumps(extra, separators=(",", ":")).encode("utf-8") + b"\n")

        with (
            measure_read_bytes(self.usage_path) as meter,
            measure_peak_bytes() as memory,
        ):
            self.assertTrue(self.run_in_process())

        # A bootstrap spanning January and February must anchor on February, so
        # this first warm tick reads only the active February tail.
        self.assertLess(meter["bytes"], 64 * 1024)
        self.assertLess(memory["peak"], 2 * 1024 * 1024)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        buckets = self.bucket_map(payload)
        self.assertEqual(
            set(buckets),
            {("2026-02-01T00:00:00Z", "machine-a", "gpt-5", "high")},
        )
        self.assertEqual(
            buckets[("2026-02-01T00:00:00Z", "machine-a", "gpt-5", "high")]["unit_count"], 9
        )

    def test_tenfold_older_history_keeps_the_first_warm_read_identical(self) -> None:
        self.ingest.discard = True

        small = self._first_warm_read_bytes("small-history", 15_000)
        large = self._first_warm_read_bytes("large-history", 150_000)

        self.assertLess(small, 64 * 1024)
        self.assertEqual(large, small)

    def test_late_older_append_falls_back_exactly_and_preserves_latest_anchor(self) -> None:
        self.write_records_streaming(self.bootstrap_records(200))
        self.assertTrue(self.run_in_process())
        state = self.read_state()
        self.assertEqual(state["active_hour"], "2026-02-01T00:00:00Z")
        february_anchor = state["active_hour_offset"]
        file_size = os.path.getsize(self.usage_path)

        late = audit_record("2026-01-01T00:25:00Z", machine_id="machine-a")
        with open(self.usage_path, "ab") as handle:
            handle.write(json.dumps(late, separators=(",", ":")).encode("utf-8") + b"\n")

        with measure_read_bytes(self.usage_path) as fallback:
            self.assertTrue(self.run_in_process())

        # An older late record triggers the exact streaming fallback from zero.
        self.assertGreaterEqual(fallback["bytes"], file_size)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        buckets = self.bucket_map(payload)
        self.assertEqual(
            set(buckets),
            {("2026-01-01T00:00:00Z", "machine-a", "gpt-5", "high")},
        )
        self.assertEqual(
            buckets[("2026-01-01T00:00:00Z", "machine-a", "gpt-5", "high")]["unit_count"],
            201,
        )
        state = self.read_state()
        # The late hour must not drag the tracked maximum or its anchor back.
        self.assertEqual(state["active_hour"], "2026-02-01T00:00:00Z")
        self.assertEqual(state["active_hour_offset"], february_anchor)

        extra = audit_record("2026-02-01T00:15:00Z", machine_id="machine-a")
        with open(self.usage_path, "ab") as handle:
            handle.write(json.dumps(extra, separators=(",", ":")).encode("utf-8") + b"\n")
        with measure_read_bytes(self.usage_path) as warm:
            self.assertTrue(self.run_in_process())
        self.assertLess(warm["bytes"], 64 * 1024)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        buckets = self.bucket_map(payload)
        self.assertEqual(
            buckets[("2026-02-01T00:00:00Z", "machine-a", "gpt-5", "high")]["unit_count"], 9
        )

    def test_backfill_peak_memory_is_bounded_on_high_cardinality(self) -> None:
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)

        def records() -> Iterator[dict[str, Any]]:
            for hour in range(1000):
                timestamp = (start + timedelta(hours=hour)).strftime("%Y-%m-%dT%H:%M:%SZ")
                for _ in range(30):
                    yield audit_record(timestamp, machine_id="machine-a")

        size = self.write_records_streaming(records())
        self.assertGreater(size, 4 * 1024 * 1024)
        self.ingest.discard = True

        with measure_peak_bytes() as memory:
            self.assertTrue(self.run_in_process(backfill=True))

        self.assertLess(memory["peak"], size / 2)
        self.assertIsNone(self.read_state()["backfill"])

    def test_legacy_v1_state_keeps_sequence_cursor_and_outbox(self) -> None:
        size = self.write_records([audit_record("2026-11-01T09:05:00Z")])
        payload = shipper_module.envelope(8, [])
        legacy = {
            "version": 1,
            "producer_id": "debitmetre-main",
            "batch_seq": 7,
            "cursor": 0,
            "source_extent": 0,
            "source_checkpoint": {"cursor": 0, "scope": "full", "digest": "0" * 64},
            "pending": {
                "batch_seq": 8,
                "payload": payload,
                "cursor_after": size,
                "source_extent": size,
                "source_checkpoint": {"cursor": size, "scope": "full", "digest": "a" * 64},
                "created_at": "2026-11-01T09:06:00Z",
            },
            "backfill": None,
        }
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(legacy, handle)

        self.assert_ok(self.run_cli())

        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["payload"], payload)
        state = self.read_state()
        self.assertEqual(state["version"], 2)
        self.assertEqual(state["batch_seq"], 8)
        self.assertEqual(state["cursor"], size)
        self.assertIsNone(state["pending"])
        self.assertNotIn("source_checkpoint", state)

    def test_legacy_v1_in_progress_backfill_resumes_without_hashes(self) -> None:
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        size = self.write_records(hourly_records(1001, start))
        legacy = {
            "version": 1,
            "producer_id": "debitmetre-main",
            "batch_seq": 5,
            "cursor": 0,
            "source_extent": size,
            "source_checkpoint": {"cursor": size, "scope": "full", "digest": "b" * 64},
            "pending": None,
            "backfill": {"source_extent": size, "next_batch": 1, "total_batches": 3},
        }
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(legacy, handle)

        self.assert_ok(self.run_cli())

        self.assertEqual(len(self.ingest.snapshot_requests()), 2)
        state = self.read_state()
        self.assertEqual(state["version"], 2)
        self.assertEqual(state["batch_seq"], 7)
        self.assertIsNone(state["backfill"])
        self.assertEqual(state["cursor"], 0)
        # Chunk 0 was already committed before the legacy state was captured,
        # so only the remaining 501 rows are replayed by this run.
        self.assertEqual(len(self.ingest.snapshot_rows()), 501)


if __name__ == "__main__":
    unittest.main()
