"""Behavior tests for the standalone orihsus shipper CLI.

Every test drives the real command line against a local HTTP ingest endpoint.
The mock endpoint enforces the replay contract (monotonic batch sequence,
duplicate no-op, stale conflict) and records the exact request bytes so retries
can be compared byte-for-byte. Fixtures use only synthetic ``audit.jsonl`` and
``usage/YYYY-MM-DD.jsonl`` lines shaped exactly like orihsus's own writers.
"""

from __future__ import annotations

import contextlib
import gzip
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator, Optional
from unittest import mock

from shippers import orihsus as shipper_module
from shippers.tests.support import measure_peak_bytes, measure_read_bytes

SHIPPER = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "orihsus.py"))
INGEST_PATH = "/api/v1/ingest"
TOKEN = "test-scoped-token"
DEFAULT_RESET = "2026-11-27T00:00:00Z"


def window(
    status: Optional[str] = "ok",
    percent: Optional[float] = 10.0,
    resets_at: Optional[str] = DEFAULT_RESET,
) -> dict[str, Any]:
    return {"status": status, "percent": percent, "resetsAt": resets_at}


def audit_record(
    timestamp: str,
    *,
    gateway_key: Optional[str] = "laptop-key",
    model: Optional[str] = "deepseek-chat",
    request_id: Optional[str] = None,
    status: int = 200,
    outcome: Optional[str] = "completed",
    input_tokens: Optional[int] = 100,
    cached_tokens: Optional[int] = 40,
    uncached_tokens: Optional[int] = 60,
    cache_write_tokens: Optional[int] = None,
    output_tokens: Optional[int] = 20,
    reasoning_tokens: Optional[int] = None,
) -> dict[str, Any]:
    return {
        "timestamp": timestamp,
        "request_id": request_id or "req-" + timestamp,
        "model": model,
        "key_fingerprint": "fp-key",
        "gateway_key": gateway_key,
        "input_tokens": input_tokens,
        "cached_tokens": cached_tokens,
        "uncached_tokens": uncached_tokens,
        "cache_write_tokens": cache_write_tokens,
        "output_tokens": output_tokens,
        "reasoning_tokens": reasoning_tokens,
        "status": status,
        "outcome": outcome,
        "latency_ms": 150,
        "opencode_session_id": None,
        "opencode_project_id": None,
        "opencode_request_id": None,
        "attempts": [],
    }


def usage_record(
    timestamp: str,
    *,
    key_fingerprint: str = "fp_a",
    rolling: Optional[dict[str, Any]] = None,
    weekly: Optional[dict[str, Any]] = None,
    monthly: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "timestamp": timestamp,
        "key_fingerprint": key_fingerprint,
    }
    for name, value in (("rolling", rolling), ("weekly", weekly), ("monthly", monthly)):
        if value is not None:
            record[name] = value
    return record


class _IngestState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.usage_rows: dict[tuple[Any, ...], dict[str, Any]] = {}
        self.observations: dict[str, dict[str, Any]] = {}
        self.last_seq = 0
        self.commits = 0
        self.duplicates = 0
        self.conflicts = 0
        self.drop_next_response = False
        self.drop_response_at: Optional[int] = None
        self.discard = False
        self.on_receive: Any = None

    def receive(
        self,
        body: bytes,
        authorization: Optional[str],
        path: str,
    ) -> tuple[int, bool]:
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
            return 200, False
        with self.lock:
            payload = json.loads(body.decode("utf-8"))
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
                    self.usage_rows[key] = row
                for observation in payload.get("quota_observations") or []:
                    # Observations are immutable once sampled.
                    self.observations.setdefault(observation["sample_id"], observation)
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
            return status, drop

    def snapshot_requests(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.requests)

    def snapshot_usage_rows(self) -> dict[tuple[Any, ...], dict[str, Any]]:
        with self.lock:
            return dict(self.usage_rows)

    def snapshot_observations(self) -> dict[str, dict[str, Any]]:
        with self.lock:
            return dict(self.observations)

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
        status, drop = self.server.ingest.receive(  # type: ignore[attr-defined]
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
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args: Any) -> None:
        pass


class OrihsusShipperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.mkdtemp(prefix="bilan-orihsus-test-")
        self.audit_path = os.path.join(self.tempdir, "audit.jsonl")
        self.usage_dir = os.path.join(self.tempdir, "usage")
        os.makedirs(self.usage_dir, exist_ok=True)
        self.state_path = os.path.join(self.tempdir, "shipper-state.json")
        self.write_audit([])
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

    @staticmethod
    def _encode(records: list[dict[str, Any]], trailing_newline: bool = True) -> bytes:
        data = b"".join(
            json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n"
            for record in records
        )
        if data and not trailing_newline:
            data = data[:-1]
        return data

    def write_audit(
        self,
        records: list[dict[str, Any]],
        *,
        append: bool = False,
        trailing_newline: bool = True,
    ) -> int:
        data = self._encode(records, trailing_newline)
        with open(self.audit_path, "ab" if append else "wb") as handle:
            handle.write(data)
        return os.path.getsize(self.audit_path)

    @staticmethod
    def _record(timestamp: str, tokens: int) -> dict[str, Any]:
        return audit_record(
            timestamp,
            input_tokens=tokens,
            cached_tokens=0,
            uncached_tokens=tokens,
            output_tokens=0,
        )

    @staticmethod
    def _usage_row(rows: dict[tuple[Any, ...], dict[str, Any]], hour: str) -> dict[str, Any]:
        return rows[
            (
                "opencode",
                "default",
                "identity",
                "laptop-key",
                "deepseek-chat",
                "",
                hour,
            )
        ]

    def write_audit_archive(
        self,
        number: int,
        records: list[dict[str, Any]],
        *,
        compressed: bool = False,
    ) -> str:
        path = os.path.join(
            self.tempdir, "audit.jsonl.%d%s" % (number, ".gz" if compressed else "")
        )
        data = self._encode(records)
        if compressed:
            with gzip.open(path, "wb") as handle:
                handle.write(data)
        else:
            with open(path, "wb") as handle:
                handle.write(data)
        return path

    def write_usage(
        self,
        day: str,
        records: list[dict[str, Any]],
        *,
        append: bool = False,
        trailing_newline: bool = True,
    ) -> str:
        path = os.path.join(self.usage_dir, day + ".jsonl")
        data = self._encode(records, trailing_newline)
        with open(path, "ab" if append else "wb") as handle:
            handle.write(data)
        return path

    def run_cli(
        self,
        *,
        extra: Optional[list[str]] = None,
        audit_path: Optional[str] = None,
        usage_dir: Optional[str] = None,
        state_path: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            SHIPPER,
            "--audit-file",
            audit_path or self.audit_path,
            "--usage-dir",
            usage_dir or self.usage_dir,
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
            timeout=60,
        )

    def read_state(self, path: Optional[str] = None) -> dict[str, Any]:
        with open(path or self.state_path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def bucket_map(self, payload: dict[str, Any]) -> dict[tuple[str, str, str], dict[str, Any]]:
        return {
            (
                row["bucket_start"],
                row["actor_id"],
                row["model"],
            ): row
            for row in payload["usage_buckets"]
        }

    def assert_ok(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stderr)

    def write_audit_streaming(
        self,
        records: Any,
        *,
        path: Optional[str] = None,
        append: bool = False,
    ) -> int:
        target = path or self.audit_path
        with open(target, "ab" if append else "wb") as handle:
            for record in records:
                handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
        return os.path.getsize(target)

    def write_usage_streaming(self, day: str, records: Any) -> str:
        path = os.path.join(self.usage_dir, day + ".jsonl")
        with open(path, "wb") as handle:
            for record in records:
                handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
        return path

    @staticmethod
    def offset_after_lines(path: str, count: int) -> int:
        offset = 0
        seen = 0
        with open(path, "rb") as handle:
            for line in handle:
                offset += len(line)
                seen += 1
                if seen == count:
                    return offset
        raise AssertionError("fewer than %d complete lines" % count)

    def run_paths(
        self, audit_path: str, usage_dir: str, state_path: str
    ) -> bool:
        return shipper_module.run_once(
            audit_path=audit_path,
            usage_dir=usage_dir,
            state_path=state_path,
            producer_id="orihsus-main",
            endpoint=self.endpoint,
            token=TOKEN,
            interval_seconds=300,
            observer_machine="gateway-a",
            heartbeat=True,
            timeout=5,
            quiet=True,
        )

    def run_in_process(self) -> bool:
        return self.run_paths(self.audit_path, self.usage_dir, self.state_path)

    @staticmethod
    def bootstrap_audit_records(old_rows: int) -> Iterator[dict[str, Any]]:
        for _ in range(old_rows):
            yield audit_record("2026-01-01T00:05:00.000Z", gateway_key="laptop-key")
        for _ in range(8):
            yield audit_record("2026-02-01T00:05:00.000Z", gateway_key="laptop-key")

    def _first_warm_read_bytes(self, label: str, old_rows: int) -> int:
        directory = os.path.join(self.tempdir, label)
        usage_dir = os.path.join(directory, "usage")
        os.makedirs(usage_dir)
        audit_path = os.path.join(directory, "audit.jsonl")
        state_path = os.path.join(directory, "state.json")
        self.write_audit_streaming(self.bootstrap_audit_records(old_rows), path=audit_path)
        self.assertTrue(self.run_paths(audit_path, usage_dir, state_path))
        extra = audit_record("2026-02-01T00:10:00.000Z", gateway_key="laptop-key")
        with open(audit_path, "ab") as handle:
            handle.write(json.dumps(extra, separators=(",", ":")).encode("utf-8") + b"\n")
        with measure_read_bytes(audit_path) as meter:
            self.assertTrue(self.run_paths(audit_path, usage_dir, state_path))
        return meter["bytes"]

    # -- audit.jsonl -> identity usage -----------------------------------

    def test_audit_usage_is_grouped_by_gateway_identity_with_nullable_tokens(self) -> None:
        hour = "2026-11-26T14:00:00Z"
        self.write_audit(
            [
                audit_record(
                    "2026-11-26T14:05:00.123Z",
                    gateway_key="laptop-key",
                    model="deepseek-chat",
                ),
                # Explicit zeros are recorded values, not missing fields.
                audit_record(
                    "2026-11-26T14:10:00.500Z",
                    gateway_key="laptop-key",
                    model="deepseek-chat",
                    input_tokens=0,
                    cached_tokens=0,
                    uncached_tokens=0,
                    cache_write_tokens=0,
                    output_tokens=0,
                    reasoning_tokens=0,
                ),
                # A failed request is still an audited HTTP request, but it has
                # no token facts and must not be turned into zeros.
                audit_record(
                    "2026-11-26T14:20:00.000Z",
                    gateway_key="laptop-key",
                    model=None,
                    status=500,
                    outcome="upstream_error",
                    input_tokens=None,
                    cached_tokens=None,
                    uncached_tokens=None,
                    output_tokens=None,
                    reasoning_tokens=None,
                ),
                # Rejected before identity resolution: identity stays unknown.
                audit_record(
                    "2026-11-26T14:30:00.000Z",
                    gateway_key=None,
                    model=None,
                    status=401,
                    outcome=None,
                    input_tokens=None,
                    cached_tokens=None,
                    uncached_tokens=None,
                    output_tokens=None,
                    reasoning_tokens=None,
                ),
                # A different hour must not be re-sent when only hour 14 is touched.
                audit_record(
                    "2026-11-26T15:05:00.000Z",
                    gateway_key="desktop-key",
                    model="kimi",
                    cache_write_tokens=5,
                    reasoning_tokens=2,
                ),
            ]
        )

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
        self.assertEqual(len(payload["usage_buckets"]), 4)

        buckets = self.bucket_map(payload)
        combined = buckets[(hour, "laptop-key", "deepseek-chat")]
        self.assertEqual(combined["source"], "opencode")
        self.assertEqual(combined["account"], "default")
        self.assertEqual(combined["actor_kind"], "identity")
        self.assertEqual(combined["unit_kind"], "request")
        self.assertEqual(combined["effort"], "")
        self.assertEqual(combined["accounting_basis"], "orihsus-audit-v1")
        self.assertEqual(combined["unit_count"], 2)
        self.assertEqual(combined["coverage_gaps"], 0)
        self.assertEqual(combined["input_tokens"], 100)
        self.assertEqual(combined["input_counted"], 2)  # the explicit zero counted too
        self.assertEqual(combined["cached_tokens"], 40)
        self.assertEqual(combined["cached_counted"], 2)
        self.assertEqual(combined["uncached_tokens"], 60)
        self.assertEqual(combined["uncached_counted"], 2)
        self.assertEqual(combined["output_tokens"], 20)
        self.assertEqual(combined["output_counted"], 2)
        # Optional upstream counters: one missing value plus one explicit zero.
        self.assertEqual(combined["cache_write_tokens"], 0)
        self.assertEqual(combined["cache_write_counted"], 1)
        self.assertEqual(combined["reasoning_tokens"], 0)
        self.assertEqual(combined["reasoning_counted"], 1)
        self.assertNotIn("total_tokens", combined)

        failed = buckets[(hour, "laptop-key", "unknown")]
        self.assertEqual(failed["unit_count"], 1)
        self.assertEqual(failed["coverage_gaps"], 1)
        self.assertIsNone(failed["input_tokens"])
        self.assertEqual(failed["input_counted"], 0)
        self.assertIsNone(failed["output_tokens"])
        self.assertEqual(failed["output_counted"], 0)

        rejected = buckets[(hour, "unknown", "unknown")]
        self.assertEqual(rejected["unit_count"], 1)
        self.assertEqual(rejected["coverage_gaps"], 1)
        self.assertIsNone(rejected["input_tokens"])

        desktop = buckets[("2026-11-26T15:00:00Z", "desktop-key", "kimi")]
        self.assertEqual(desktop["unit_count"], 1)
        self.assertEqual(desktop["coverage_gaps"], 0)
        self.assertEqual(desktop["cache_write_tokens"], 5)
        self.assertEqual(desktop["cache_write_counted"], 1)
        self.assertEqual(desktop["reasoning_tokens"], 2)
        self.assertEqual(desktop["reasoning_counted"], 1)

        state = self.read_state()
        self.assertEqual(state["producer_id"], "orihsus-main")
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["audit_cursor"], os.path.getsize(self.audit_path))
        self.assertIsNone(state["pending"])

        # Append to the already-shipped hour: the retry sends the complete
        # hour again (including earlier lines), not a delta.
        self.write_audit(
            [
                audit_record(
                    "2026-11-26T14:55:00.000Z",
                    gateway_key="laptop-key",
                    model="deepseek-chat",
                    input_tokens=10,
                    cached_tokens=0,
                    uncached_tokens=10,
                    output_tokens=5,
                )
            ],
            append=True,
        )
        self.assert_ok(self.run_cli())
        second = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(second["batch_seq"], 2)
        second_buckets = self.bucket_map(second)
        self.assertEqual(len(second_buckets), 3)
        self.assertTrue(all(key[0] == hour for key in second_buckets))
        self.assertEqual(second_buckets[(hour, "laptop-key", "deepseek-chat")]["unit_count"], 3)
        self.assertEqual(second_buckets[(hour, "laptop-key", "deepseek-chat")]["input_tokens"], 110)
        self.assertEqual(second_buckets[(hour, "laptop-key", "deepseek-chat")]["input_counted"], 3)
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 4)

    def test_successful_gateway_metadata_reads_are_not_usage_requests(self) -> None:
        hour = "2026-11-26T14:00:00Z"
        metadata = audit_record(
            "2026-11-26T14:05:00.000Z",
            gateway_key=None,
            model=None,
            status=200,
            outcome=None,
            input_tokens=None,
            cached_tokens=None,
            uncached_tokens=None,
            output_tokens=None,
            reasoning_tokens=None,
        )
        metadata["key_fingerprint"] = None
        self.write_audit(
            [
                metadata,
                audit_record(
                    "2026-11-26T14:10:00.000Z",
                    gateway_key="laptop-key",
                    model="deepseek-chat",
                ),
            ]
        )

        self.assert_ok(self.run_cli())
        buckets = self.bucket_map(self.ingest.snapshot_requests()[-1]["payload"])

        inference = buckets[(hour, "laptop-key", "deepseek-chat")]
        self.assertEqual(inference["unit_count"], 1)
        self.assertEqual(inference["coverage_gaps"], 0)

        tombstone = buckets[(hour, "unknown", "unknown")]
        self.assertEqual(tombstone["unit_count"], 0)
        self.assertEqual(tombstone["coverage_gaps"], 0)
        for column in (
            "input_tokens",
            "cached_tokens",
            "uncached_tokens",
            "cache_write_tokens",
            "output_tokens",
            "reasoning_tokens",
        ):
            self.assertIsNone(tombstone[column])
            self.assertEqual(tombstone[column.replace("_tokens", "_counted")], 0)

    def test_canceled_and_unclassified_requests_still_count_toward_coverage(self) -> None:
        hour = "2026-11-26T14:00:00Z"
        canceled = audit_record(
            "2026-11-26T14:05:00.000Z",
            gateway_key="laptop-key",
            model="kimi",
            status=200,
            outcome="client_cancel",
            input_tokens=None,
            cached_tokens=None,
            uncached_tokens=None,
            output_tokens=None,
            reasoning_tokens=None,
        )
        rejected = audit_record(
            "2026-11-26T14:10:00.000Z",
            gateway_key=None,
            model=None,
            status=500,
            outcome=None,
            input_tokens=None,
            cached_tokens=None,
            uncached_tokens=None,
            output_tokens=None,
            reasoning_tokens=None,
        )
        rejected["key_fingerprint"] = None
        token_only = audit_record(
            "2026-11-26T14:15:00.000Z",
            gateway_key=None,
            model=None,
            status=200,
            outcome=None,
            input_tokens=5,
            cached_tokens=0,
            uncached_tokens=5,
            output_tokens=0,
        )
        token_only["key_fingerprint"] = None
        attempt_only = audit_record(
            "2026-11-26T14:20:00.000Z",
            gateway_key=None,
            model=None,
            status=200,
            outcome=None,
            input_tokens=None,
            cached_tokens=None,
            uncached_tokens=None,
            output_tokens=None,
            reasoning_tokens=None,
        )
        attempt_only["key_fingerprint"] = None
        attempt_only["attempts"] = [{"attempt_number": 1, "terminal_reason": "completed"}]

        self.write_audit([canceled, rejected, token_only, attempt_only])
        self.assert_ok(self.run_cli())
        buckets = self.bucket_map(self.ingest.snapshot_requests()[-1]["payload"])

        canceled_row = buckets[(hour, "laptop-key", "kimi")]
        self.assertEqual(canceled_row["unit_count"], 1)
        self.assertEqual(canceled_row["coverage_gaps"], 1)
        self.assertIsNone(canceled_row["input_tokens"])

        unclassified = buckets[(hour, "unknown", "unknown")]
        self.assertEqual(unclassified["unit_count"], 3)
        self.assertEqual(unclassified["coverage_gaps"], 2)
        self.assertEqual(unclassified["input_tokens"], 5)
        self.assertEqual(unclassified["input_counted"], 1)
        self.assertEqual(unclassified["output_tokens"], 0)
        self.assertEqual(unclassified["output_counted"], 1)

    def test_ignores_noncanonical_audit_lines(self) -> None:
        with open(self.audit_path, "wb") as handle:
            handle.write(b"{not json}\n")
            handle.write(b"\n")
            handle.write(
                json.dumps(
                    {"timestamp": "2026-11-03T01:05:00.000Z", "status": 200},
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            handle.write(
                json.dumps(
                    audit_record("2026-11-03T01:10:00.000Z", status=999),
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            handle.write(
                json.dumps(
                    audit_record("not-a-timestamp"),
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            handle.write(
                json.dumps(
                    audit_record("2026-11-03T01:15:00.000Z"),
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )

        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(len(payload["usage_buckets"]), 1)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 1)

    # -- usage/YYYY-MM-DD.jsonl -> per-key quota observations -------------

    def test_quota_observations_are_per_key_and_keep_same_second_samples(self) -> None:
        self.write_usage(
            "2026-11-26",
            [
                usage_record(
                    "2026-11-26T14:30:00.100Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=10.0),
                    weekly=window(percent=20.0),
                    monthly=window(percent=30.0),
                ),
                # Same key, same exact timestamp, different sample content.
                usage_record(
                    "2026-11-26T14:30:00.100Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=15.0),
                    weekly=window(percent=25.0),
                    monthly=window(percent=35.0),
                ),
                usage_record(
                    "2026-11-26T14:30:05.000Z",
                    key_fingerprint="fp_b",
                    rolling=window(status="rate-limited", percent=100.0),
                    weekly=window(percent=50.0),
                    monthly=window(percent=0.0),
                ),
            ],
        )

        result = self.run_cli(
            extra=[
                "--observer-machine",
                "gateway-a",
                "--interval-seconds",
                "120",
            ]
        )
        self.assert_ok(result)
        payload = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(payload["usage_buckets"], [])
        observations = payload["quota_observations"]
        self.assertEqual(len(observations), 3)
        self.assertEqual(len({observation["sample_id"] for observation in observations}), 3)

        fp_a = [observation for observation in observations if observation["account"] == "fp_a"]
        self.assertEqual(len(fp_a), 2)
        self.assertEqual({observation["sampled_at"] for observation in fp_a}, {"2026-11-26T14:30:00Z"})
        self.assertEqual(
            sorted(
                row["used_percent"]
                for observation in fp_a
                for row in observation["windows"]
                if row["slot"] == "rolling"
            ),
            [10.0, 15.0],
        )
        for observation in fp_a:
            self.assertEqual(observation["source"], "opencode")
            self.assertEqual(observation["status"], "ok")
            self.assertEqual(observation["observer_machine"], "gateway-a")
            self.assertEqual(observation["interval_seconds"], 120)
            self.assertIsNone(observation["time_anomaly"])
            self.assertIsNone(observation["error_summary"])
            self.assertEqual(
                [row["slot"] for row in observation["windows"]],
                ["rolling", "weekly", "monthly"],
            )
            for row in observation["windows"]:
                self.assertEqual(row["bucket_id"], "fp_a")
                self.assertIsNone(row["label"])
                self.assertEqual(row["status"], "ok")
                self.assertEqual(row["used_percent"] + row["remaining_percent"], 100.0)
                self.assertEqual(row["resets_at"], DEFAULT_RESET)

        fp_b = [observation for observation in observations if observation["account"] == "fp_b"]
        self.assertEqual(len(fp_b), 1)
        self.assertEqual(fp_b[0]["sampled_at"], "2026-11-26T14:30:05Z")
        rolling = [row for row in fp_b[0]["windows"] if row["slot"] == "rolling"][0]
        self.assertEqual(rolling["status"], "limited")
        self.assertEqual(rolling["used_percent"], 100.0)
        self.assertEqual(rolling["remaining_percent"], 0.0)

        # A second idle run only refreshes liveness; no sample is rewritten.
        self.assert_ok(self.run_cli())
        self.assertEqual(len(self.ingest.snapshot_requests()), 2)
        heartbeat = self.ingest.snapshot_requests()[1]["payload"]
        self.assertEqual(heartbeat["batch_seq"], 2)
        self.assertEqual(heartbeat["usage_buckets"], [])
        self.assertEqual(heartbeat["quota_observations"], [])
        self.assertEqual(len(self.ingest.snapshot_observations()), 3)

    def test_quota_windows_use_optional_key_alias_and_never_raw_keys(self) -> None:
        aliased = usage_record(
            "2026-11-26T14:30:00.000Z",
            key_fingerprint="fp_a",
            rolling=window(),
            weekly=window(),
            monthly=window(),
        )
        aliased["key_alias"] = "go-key-1"
        unlabelled = usage_record(
            "2026-11-26T14:31:00.000Z",
            key_fingerprint="fp_b",
            rolling=window(),
            weekly=window(),
            monthly=window(),
        )
        # An unrelated raw-key field must never become a display label.
        unlabelled["key"] = "sk-raw-secret-must-not-leak"
        self.write_usage("2026-11-26", [aliased, unlabelled])

        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[0]["payload"]
        observations = {
            observation["account"]: observation for observation in payload["quota_observations"]
        }
        self.assertEqual(
            {window_row["label"] for window_row in observations["fp_a"]["windows"]},
            {"go-key-1"},
        )
        self.assertEqual(
            {window_row["label"] for window_row in observations["fp_b"]["windows"]},
            {None},
        )
        self.assertNotIn("sk-raw-secret-must-not-leak", json.dumps(payload))

    def test_disappeared_monthly_window_is_not_carried_forward(self) -> None:
        self.write_usage(
            "2026-11-26",
            [
                usage_record(
                    "2026-11-26T14:30:00.000Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=10.0),
                    weekly=window(percent=20.0),
                    monthly=window(percent=30.0),
                )
            ],
        )
        self.assert_ok(self.run_cli())
        first = self.ingest.snapshot_requests()[0]["payload"]["quota_observations"]
        self.assertEqual(len(first), 1)
        self.assertEqual(
            [row["slot"] for row in first[0]["windows"]],
            ["rolling", "weekly", "monthly"],
        )

        # The next two successful polls omit monthly in both shapes orihsus can
        # produce: a present-but-null window, and an absent window object.
        self.write_usage(
            "2026-11-27",
            [
                usage_record(
                    "2026-11-27T09:00:00.000Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=11.0),
                    weekly=window(percent=21.0),
                    monthly=window(status=None, percent=None, resets_at=None),
                ),
                usage_record(
                    "2026-11-27T09:05:00.000Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=12.0),
                    weekly=window(percent=22.0),
                ),
            ],
        )
        self.assert_ok(self.run_cli())
        later = self.ingest.snapshot_requests()[-1]["payload"]["quota_observations"]
        self.assertEqual(len(later), 2)
        for observation in later:
            self.assertEqual([row["slot"] for row in observation["windows"]], ["rolling", "weekly"])
            self.assertNotIn("monthly", [row["slot"] for row in observation["windows"]])
        # Immutable history keeps the old sample; only the newer samples have no
        # monthly window, so the read surface cannot show a ghost window.
        self.assertEqual(len(self.ingest.snapshot_observations()), 3)

    def test_successful_empty_poll_is_empty_and_malformed_lines_are_skipped(self) -> None:
        with open(os.path.join(self.usage_dir, "2026-11-26.jsonl"), "wb") as handle:
            handle.write(b"{not json}\n")
            handle.write(
                json.dumps(
                    {"timestamp": "2026-11-26T10:00:00.000Z"},
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            handle.write(
                json.dumps(
                    {"timestamp": "not-a-timestamp", "key_fingerprint": "fp_bad"},
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            handle.write(
                json.dumps(
                    usage_record(
                        "2026-11-26T10:00:00.000Z",
                        key_fingerprint="fp_empty",
                        rolling=window(status=None, percent=None, resets_at=None),
                        weekly=window(status=None, percent=None, resets_at=None),
                        monthly=window(status=None, percent=None, resets_at=None),
                    ),
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            handle.write(
                json.dumps(
                    usage_record(
                        "2026-11-26T10:01:00.000Z",
                        key_fingerprint="fp_bad_percent",
                        rolling=window(status=None, percent=150.0, resets_at=None),
                        weekly=window(status=None, percent=-1.0, resets_at="invalid"),
                        monthly=window(status="unexpected", percent=None, resets_at=None),
                    ),
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )

        self.assert_ok(self.run_cli())
        observations = self.ingest.snapshot_requests()[0]["payload"]["quota_observations"]
        by_key = {observation["account"]: observation for observation in observations}
        self.assertEqual(set(by_key), {"fp_empty", "fp_bad_percent"})
        self.assertEqual(by_key["fp_empty"]["status"], "empty")
        self.assertEqual(by_key["fp_empty"]["windows"], [])
        # Invalid percentages are dropped, never coerced to 0 or 100.
        self.assertEqual(by_key["fp_bad_percent"]["status"], "ok")
        self.assertEqual(len(by_key["fp_bad_percent"]["windows"]), 1)
        bad = by_key["fp_bad_percent"]["windows"][0]
        self.assertEqual(bad["slot"], "monthly")
        self.assertIsNone(bad["used_percent"])
        self.assertIsNone(bad["remaining_percent"])
        self.assertIsNone(bad["resets_at"])
        self.assertEqual(bad["status"], "unknown")
        # Failed polls are never written upstream, so no error observation is
        # fabricated from a line the shipper cannot see.
        self.assertTrue(all(observation["status"] != "error" for observation in observations))

    def test_offline_backlog_across_daily_files_is_shipped_and_reruns_are_idempotent(self) -> None:
        self.write_audit(
            [
                audit_record("2026-11-24T10:05:00.000Z", gateway_key="laptop-key"),
                audit_record("2026-11-25T10:05:00.000Z", gateway_key="desktop-key"),
                audit_record("2026-11-26T10:05:00.000Z", gateway_key="laptop-key"),
            ]
        )
        usage_paths = {}
        for day, timestamp in (
            ("2026-11-24", "2026-11-24T10:10:00.000Z"),
            ("2026-11-25", "2026-11-25T10:10:00.000Z"),
            ("2026-11-26", "2026-11-26T10:10:00.000Z"),
        ):
            usage_paths[day] = self.write_usage(
                day,
                [
                    usage_record(
                        timestamp,
                        key_fingerprint="fp_a",
                        rolling=window(percent=10.0),
                        weekly=window(percent=20.0),
                        monthly=window(percent=30.0),
                    )
                ],
            )
        # Non-daily files in the same directory are not quota history.
        with open(os.path.join(self.usage_dir, "notes.jsonl"), "wb") as handle:
            handle.write(b'{"hello":"world"}\n')
        with open(os.path.join(self.usage_dir, "2026-11-26.txt"), "wb") as handle:
            handle.write(b"not quota history\n")

        self.assert_ok(self.run_cli())
        first = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(first["batch_seq"], 1)
        self.assertEqual(len(first["quota_observations"]), 3)
        self.assertEqual(len(first["usage_buckets"]), 3)
        self.assertEqual(len(self.ingest.snapshot_observations()), 3)
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 3)

        state = self.read_state()
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["audit_cursor"], os.path.getsize(self.audit_path))
        self.assertEqual(state["usage_cursors"], {
            day: os.path.getsize(path) for day, path in usage_paths.items()
        })
        self.assertIsNone(state["pending"])

        # Re-running the same offline backlog is idempotent; only liveness moves.
        self.assert_ok(self.run_cli())
        heartbeat = self.ingest.snapshot_requests()[1]["payload"]
        self.assertEqual(heartbeat["batch_seq"], 2)
        self.assertEqual(heartbeat["usage_buckets"], [])
        self.assertEqual(heartbeat["quota_observations"], [])
        self.assertEqual(len(self.ingest.snapshot_observations()), 3)
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 3)
        self.assertEqual(self.read_state()["batch_seq"], 2)

        # Heartbeats can be disabled without losing the consumed cursors.
        result = self.run_cli(extra=["--no-heartbeat"])
        self.assert_ok(result)
        self.assertEqual(len(self.ingest.snapshot_requests()), 2)
        self.assertEqual(self.read_state()["batch_seq"], 2)

    def test_duplicate_equivalent_usage_lines_are_deduplicated_before_split(self) -> None:
        base = datetime(2026, 11, 26, 0, 0, 0)
        unique = [
            usage_record(
                (base + timedelta(seconds=index)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                key_fingerprint="fp_%03d" % index,
                rolling=window(percent=10.0),
                weekly=window(percent=20.0),
                monthly=window(percent=30.0),
            )
            for index in range(125)
        ]
        # 125 unique observations fill exactly 500 rows. Duplicate poll lines
        # must be removed before splitting so the batch stays one request and
        # never carries duplicate sample_ids.
        path = self.write_usage(
            "2026-11-26",
            [unique[0], unique[0], unique[1], unique[1], *unique[2:]],
        )

        self.assert_ok(self.run_cli())
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 1)
        observations = requests[0]["payload"]["quota_observations"]
        self.assertEqual(len(observations), 125)
        self.assertEqual(len({item["sample_id"] for item in observations}), 125)
        self.assertEqual(self.ingest.snapshot_requests()[0]["payload"]["batch_seq"], 1)
        self.assertEqual(self.read_state()["usage_cursors"]["2026-11-26"], os.path.getsize(path))

        self.assert_ok(self.run_cli())
        self.assertEqual(len(self.ingest.snapshot_requests()), 2)
        self.assertEqual(self.ingest.snapshot_requests()[1]["payload"]["quota_observations"], [])
        self.assertEqual(len(self.ingest.snapshot_observations()), 125)

    def test_unfinished_trailing_usage_line_is_not_consumed_until_complete(self) -> None:
        first = usage_record(
            "2026-11-26T11:05:00.000Z",
            key_fingerprint="fp_a",
            rolling=window(percent=10.0),
            weekly=window(percent=20.0),
            monthly=window(percent=30.0),
        )
        second = usage_record(
            "2026-11-26T11:10:00.000Z",
            key_fingerprint="fp_a",
            rolling=window(percent=11.0),
            weekly=window(percent=21.0),
            monthly=window(percent=31.0),
        )
        path = self.write_usage("2026-11-26", [first])
        partial = json.dumps(second, separators=(",", ":")).encode("utf-8")
        with open(path, "ab") as handle:
            handle.write(partial[:25])
        first_size = os.path.getsize(path)

        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(len(payload["quota_observations"]), 1)
        self.assertEqual(self.read_state()["usage_cursors"]["2026-11-26"], first_size - 25)

        with open(path, "ab") as handle:
            handle.write(partial[25:] + b"\n")
        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[1]["payload"]
        self.assertEqual(len(payload["quota_observations"]), 1)
        self.assertEqual(self.read_state()["usage_cursors"]["2026-11-26"], os.path.getsize(path))
        self.assertEqual(len(self.ingest.snapshot_observations()), 2)

    def test_splits_payloads_at_the_500_row_contract_limit_including_windows(self) -> None:
        start = datetime(2026, 11, 26, 0, 0, 0)
        records = []
        for index in range(126):
            timestamp = (start + timedelta(seconds=index)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            records.append(
                usage_record(
                    timestamp,
                    key_fingerprint="fp_a",
                    rolling=window(percent=index % 100),
                    weekly=window(percent=index % 90),
                    monthly=window(percent=index % 80),
                )
            )
        self.write_usage("2026-11-26", records)

        self.assert_ok(self.run_cli())
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        first = requests[0]["payload"]
        second = requests[1]["payload"]
        self.assertEqual(first["batch_seq"], 1)
        self.assertEqual(len(first["quota_observations"]), 125)  # 125 * 4 rows
        self.assertEqual(second["batch_seq"], 2)
        self.assertEqual(len(second["quota_observations"]), 1)
        self.assertEqual(len(self.ingest.snapshot_observations()), 126)
        self.assertEqual(self.read_state()["batch_seq"], 2)

    # -- audit log integrity ----------------------------------------------

    def test_missing_audit_log_fails_before_sending_a_heartbeat(self) -> None:
        os.remove(self.audit_path)
        result = self.run_cli()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("audit log not found", result.stderr)
        self.assertEqual(self.ingest.snapshot_requests(), [])

    def test_existing_empty_audit_log_still_sends_an_idle_heartbeat(self) -> None:
        self.write_audit([])

        self.assert_ok(self.run_cli())
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["payload"]["usage_buckets"], [])
        self.assertEqual(requests[0]["payload"]["quota_observations"], [])
        self.assertEqual(requests[0]["payload"]["batch_seq"], 1)
        state = self.read_state()
        self.assertEqual(state["version"], 4)
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["audit_cursor"], 0)
        self.assertIsNone(state["audit_active_hour"])
        self.assertEqual(state["audit_active_hour_offset"], 0)

    def test_truncated_audit_log_restarts_with_a_warning(self) -> None:
        first = audit_record("2026-11-26T14:05:00.000Z", gateway_key="laptop-key")
        second = audit_record("2026-11-26T14:10:00.000Z", gateway_key="laptop-key")
        self.write_audit([first, second])
        self.assert_ok(self.run_cli())

        key = (
            "opencode",
            "default",
            "identity",
            "laptop-key",
            "deepseek-chat",
            "",
            "2026-11-26T14:00:00Z",
        )
        self.assertEqual(self.ingest.snapshot_usage_rows()[key]["unit_count"], 2)

        # A same-generation truncation is accepted as an active-hour loss: the
        # shipper warns and restarts instead of blocking forever.
        truncated_size = self.write_audit([second])
        result = self.run_cli()

        self.assert_ok(result)
        self.assertIn("rotated or truncated", result.stderr)
        self.assertEqual(self.ingest.snapshot_usage_rows()[key]["unit_count"], 1)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 2)
        self.assertEqual(state["audit_cursor"], truncated_size)

    def test_replaced_audit_generation_restarts_even_when_regrown(self) -> None:
        self.write_audit([audit_record("2026-11-26T14:05:00.000Z", gateway_key="laptop-key")])
        self.assert_ok(self.run_cli())
        before = self.read_state()

        rotated = os.path.join(self.tempdir, "audit.next.jsonl")
        with open(rotated, "wb") as handle:
            record = audit_record("2026-11-26T15:05:00.000Z", gateway_key="desktop-key")
            handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
        new_size = os.path.getsize(rotated)
        self.assertGreater(new_size, 0)
        os.replace(rotated, self.audit_path)

        result = self.run_cli()

        self.assert_ok(result)
        self.assertIn("rotated or truncated", result.stderr)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(payload["batch_seq"], 2)
        self.assertEqual(
            set(self.bucket_map(payload)),
            {("2026-11-26T15:00:00Z", "desktop-key", "deepseek-chat")},
        )
        state = self.read_state()
        self.assertEqual(state["audit_cursor"], new_size)
        self.assertNotEqual(state["audit_file_id"], before["audit_file_id"])
        self.assertEqual(
            state["audit_file_id"],
            [os.stat(self.audit_path).st_dev, os.stat(self.audit_path).st_ino],
        )

    def test_multichunk_pending_replays_exactly_and_advances(self) -> None:
        base = datetime(2026, 1, 1)
        records = [
            audit_record(
                (base + timedelta(hours=index)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                gateway_key="identity-%03d" % index,
            )
            for index in range(501)
        ]
        self.write_audit(records)
        full_size = os.path.getsize(self.audit_path)

        self.ingest.drop_next_response = True
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(len(self.ingest.snapshot_requests()), 1)
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 500)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 0)
        self.assertEqual(state["audit_cursor"], 0)
        self.assertEqual(state["pending"]["batch_seq"], 1)
        self.assertEqual(state["pending"]["audit_cursor_after"], 0)
        first_body = self.ingest.snapshot_requests()[0]["body"]

        # The outbox is retried byte-for-byte, then the complete extent is
        # re-derived and its remaining rows are sent with fresh sequences.
        self.assert_ok(self.run_cli())
        requests = self.ingest.snapshot_requests()
        self.assertEqual(requests[1]["body"], first_body)
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 501)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 3)
        self.assertEqual(state["audit_cursor"], full_size)
        self.assertEqual(state["audit_active_hour"], "2026-01-21T20:00:00Z")
        self.assertIsNone(state["pending"])

    def test_crash_after_partial_chunk_resends_and_converges(self) -> None:
        base = datetime(2026, 1, 1)
        records = [
            audit_record(
                (base + timedelta(hours=index)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                gateway_key="partial-%03d" % index,
            )
            for index in range(501)
        ]
        self.write_audit(records)
        full_size = os.path.getsize(self.audit_path)

        # Chunk 1 commits, but its ACK is lost and the crash happens before the
        # next pending is persisted.
        self.ingest.drop_next_response = True
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 500)
        state = self.read_state()
        self.assertEqual(state["audit_cursor"], 0)
        state["pending"] = None
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(state, handle)

        # The cursor is still before the extent, so the next run re-derives the
        # full extent and converges without loss or a stale conflict.
        self.assert_ok(self.run_cli())
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 501)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 2)
        self.assertEqual(state["audit_cursor"], full_size)
        self.assertIsNone(state["pending"])

    def test_incremental_aggregation_is_bounded_to_captured_extent(self) -> None:
        first = audit_record("2026-11-26T14:05:00.000Z", gateway_key="laptop-key")
        self.write_audit([first])
        captured_extent = os.path.getsize(self.audit_path)
        late = audit_record("2026-11-26T14:35:00.000Z", gateway_key="laptop-key")
        self.ingest.on_receive = lambda: self.write_audit([late], append=True)

        self.assertTrue(self.run_in_process())

        payload = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(len(payload["usage_buckets"]), 1)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 1)
        self.assertEqual(self.read_state()["audit_cursor"], captured_extent)

        # The concurrent append is picked up by the next normal run.
        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        self.assertEqual(len(payload["usage_buckets"]), 1)
        self.assertEqual(payload["usage_buckets"][0]["unit_count"], 2)
        self.assertEqual(self.read_state()["audit_cursor"], os.path.getsize(self.audit_path))

    def test_replaced_usage_file_generation_restarts_even_when_regrown(self) -> None:
        self.write_usage(
            "2026-11-26",
            [
                usage_record(
                    "2026-11-26T14:30:00.000Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=10.0),
                )
            ],
        )
        self.assert_ok(self.run_cli())
        self.assertEqual(len(self.ingest.snapshot_observations()), 1)

        path = os.path.join(self.usage_dir, "2026-11-26.jsonl")
        rotated = os.path.join(self.usage_dir, "2026-11-26.next.jsonl")
        with open(rotated, "wb") as handle:
            record = usage_record(
                "2026-11-26T15:30:00.000Z",
                key_fingerprint="fp_b",
                rolling=window(percent=20.0),
            )
            handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
        new_size = os.path.getsize(rotated)
        os.replace(rotated, path)

        result = self.run_cli()

        self.assert_ok(result)
        self.assertIn("rotated or truncated", result.stderr)
        self.assertEqual(len(self.ingest.snapshot_observations()), 2)
        self.assertEqual(self.read_state()["usage_cursors"]["2026-11-26"], new_size)

    def test_truncated_usage_file_restarts_with_a_warning(self) -> None:
        first = usage_record(
            "2026-11-26T14:30:00.000Z",
            key_fingerprint="fp_a",
            rolling=window(percent=10.0),
        )
        second = usage_record(
            "2026-11-26T14:35:00.000Z",
            key_fingerprint="fp_a",
            rolling=window(percent=11.0),
        )
        path = self.write_usage("2026-11-26", [first, second])
        self.assert_ok(self.run_cli())
        self.assertEqual(len(self.ingest.snapshot_observations()), 2)

        self.write_usage("2026-11-26", [second])
        truncated_size = os.path.getsize(path)
        result = self.run_cli()

        self.assert_ok(result)
        self.assertIn("rotated or truncated", result.stderr)
        self.assertEqual(self.read_state()["usage_cursors"]["2026-11-26"], truncated_size)

    def test_legacy_v3_state_keeps_sequence_pending_and_cursors(self) -> None:
        self.write_audit([audit_record("2026-11-26T14:05:00.000Z")])
        path = self.write_usage(
            "2026-11-26",
            [
                usage_record(
                    "2026-11-26T14:30:00.000Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=10.0),
                )
            ],
        )
        audit_size = os.path.getsize(self.audit_path)
        usage_size = os.path.getsize(path)
        payload = shipper_module._envelope(8, [], [])
        legacy = {
            "version": 3,
            "producer_id": "orihsus-main",
            "batch_seq": 7,
            "audit_cursor": 0,
            "audit_prefix_sha256": "0" * 64,
            "audit_inflight_extent_cursor": None,
            "audit_inflight_extent_sha256": None,
            "usage_cursors": {},
            "pending": {
                "batch_seq": 8,
                "payload": payload,
                "audit_cursor_after": audit_size,
                "audit_prefix_sha256_after": "a" * 64,
                "audit_extent_cursor": audit_size,
                "audit_extent_sha256": "a" * 64,
                "usage_cursors_after": {"2026-11-26": usage_size},
                "created_at": "2026-11-26T14:06:00Z",
            },
        }
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(legacy, handle)

        self.assert_ok(self.run_cli())

        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["payload"], payload)
        state = self.read_state()
        self.assertEqual(state["version"], 4)
        self.assertEqual(state["batch_seq"], 8)
        self.assertEqual(state["audit_cursor"], audit_size)
        self.assertEqual(state["usage_cursors"], {"2026-11-26": usage_size})
        self.assertIsNone(state["pending"])
        self.assertNotIn("audit_prefix_sha256", state)
        self.assertNotIn("audit_inflight_extent_cursor", state)

    # -- durable replay / ACK / heartbeat ---------------------------------

    def test_lost_ack_retries_identical_batch_then_heartbeats(self) -> None:
        self.write_audit([audit_record("2026-11-26T12:05:00.000Z")])
        self.write_usage(
            "2026-11-26",
            [
                usage_record(
                    "2026-11-26T12:10:00.000Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=10.0),
                    weekly=window(percent=20.0),
                    monthly=window(percent=30.0),
                )
            ],
        )
        self.ingest.drop_next_response = True

        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(self.ingest.stats(), (1, 1, 0, 0))
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 0)
        self.assertEqual(state["audit_cursor"], 0)
        self.assertIsNone(state["audit_active_hour"])
        self.assertEqual(state["audit_active_hour_offset"], 0)
        self.assertEqual(state["usage_cursors"], {})
        self.assertEqual(state["pending"]["batch_seq"], 1)
        self.assertEqual(state["pending"]["payload"]["batch_seq"], 1)
        audit_size = os.path.getsize(self.audit_path)
        self.assertEqual(state["pending"]["audit_cursor_after"], audit_size)
        self.assertEqual(state["pending"]["audit_active_hour"], "2026-11-26T12:00:00Z")
        self.assertEqual(state["pending"]["audit_active_hour_offset"], 0)
        self.assertEqual(
            state["pending"]["audit_file_id"],
            [os.stat(self.audit_path).st_dev, os.stat(self.audit_path).st_ino],
        )
        self.assertEqual(
            state["pending"]["usage_cursors_after"],
            {"2026-11-26": os.path.getsize(os.path.join(self.usage_dir, "2026-11-26.jsonl"))},
        )
        first_body = self.ingest.snapshot_requests()[0]["body"]

        second = self.run_cli()
        self.assert_ok(second)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["body"], first_body)
        self.assertEqual(requests[1]["payload"]["batch_seq"], 1)
        self.assertEqual(self.ingest.stats(), (1, 1, 1, 0))
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 1)
        self.assertEqual(len(self.ingest.snapshot_observations()), 1)

        state = self.read_state()
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["audit_cursor"], os.path.getsize(self.audit_path))
        self.assertEqual(state["audit_active_hour"], "2026-11-26T12:00:00Z")
        self.assertEqual(state["audit_active_hour_offset"], 0)
        self.assertEqual(
            state["audit_file_id"],
            [os.stat(self.audit_path).st_dev, os.stat(self.audit_path).st_ino],
        )
        self.assertEqual(
            state["usage_cursors"],
            {"2026-11-26": os.path.getsize(os.path.join(self.usage_dir, "2026-11-26.jsonl"))},
        )
        self.assertIsNone(state["pending"])

        # Idle run: only an empty heartbeat moves liveness and batch_seq.
        self.assert_ok(self.run_cli())
        heartbeat = self.ingest.snapshot_requests()[2]["payload"]
        self.assertEqual(heartbeat["batch_seq"], 2)
        self.assertEqual(heartbeat["usage_buckets"], [])
        self.assertEqual(heartbeat["quota_observations"], [])
        self.assertEqual(heartbeat["balance_snapshots"], [])
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 1)
        self.assertEqual(len(self.ingest.snapshot_observations()), 1)

        # An idle run with heartbeats disabled must not touch the server.
        self.assert_ok(self.run_cli(extra=["--no-heartbeat"]))
        self.assertEqual(len(self.ingest.snapshot_requests()), 3)
        self.assertEqual(self.read_state()["batch_seq"], 2)

    # -- streaming, anchors and rotation ---------------------------------

    def test_idle_tick_reads_no_history(self) -> None:
        self.write_audit([audit_record("2026-11-26T12:05:00.000Z")])
        path = self.write_usage(
            "2026-11-26",
            [
                usage_record(
                    "2026-11-26T12:10:00.000Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=10.0),
                )
            ],
        )
        self.assert_ok(self.run_cli())
        audit_size = os.path.getsize(self.audit_path)
        usage_size = os.path.getsize(path)

        with (
            measure_read_bytes(self.audit_path) as audit_meter,
            measure_read_bytes(path) as usage_meter,
        ):
            self.assertTrue(self.run_in_process())

        self.assertEqual(audit_meter["bytes"], 0)
        self.assertEqual(usage_meter["bytes"], 0)
        state = self.read_state()
        self.assertEqual(state["audit_cursor"], audit_size)
        self.assertEqual(state["usage_cursors"]["2026-11-26"], usage_size)

    def test_first_warm_tick_after_multi_hour_bootstrap_reads_only_active_tail(self) -> None:
        self.write_audit_streaming(self.bootstrap_audit_records(15_000))
        self.assertGreater(os.path.getsize(self.audit_path), 4 * 1024 * 1024)
        self.assertTrue(self.run_in_process())
        state = self.read_state()
        self.assertEqual(state["audit_active_hour"], "2026-02-01T00:00:00Z")
        self.assertGreater(state["audit_active_hour_offset"], 0)

        with measure_read_bytes(self.audit_path) as idle:
            self.assertTrue(self.run_in_process())
        self.assertEqual(idle["bytes"], 0)

        extra = audit_record("2026-02-01T00:10:00.000Z", gateway_key="laptop-key")
        self.write_audit([extra], append=True)

        with (
            measure_read_bytes(self.audit_path) as meter,
            measure_peak_bytes() as memory,
        ):
            self.assertTrue(self.run_in_process())

        # The multi-hour bootstrap must anchor February, not January, so the
        # very first warm tick reads only the active February tail.
        self.assertLess(meter["bytes"], 64 * 1024)
        self.assertLess(memory["peak"], 2 * 1024 * 1024)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        buckets = self.bucket_map(payload)
        self.assertEqual(
            set(buckets),
            {("2026-02-01T00:00:00Z", "laptop-key", "deepseek-chat")},
        )
        self.assertEqual(
            buckets[("2026-02-01T00:00:00Z", "laptop-key", "deepseek-chat")]["unit_count"], 9
        )

    def test_tenfold_older_history_keeps_the_first_warm_read_identical(self) -> None:
        self.ingest.discard = True

        small = self._first_warm_read_bytes("small-history", 15_000)
        large = self._first_warm_read_bytes("large-history", 150_000)

        self.assertLess(small, 64 * 1024)
        self.assertEqual(large, small)

    def test_late_older_audit_append_falls_back_and_preserves_latest_anchor(self) -> None:
        self.write_audit_streaming(self.bootstrap_audit_records(200))
        self.assertTrue(self.run_in_process())
        state = self.read_state()
        self.assertEqual(state["audit_active_hour"], "2026-02-01T00:00:00Z")
        february_anchor = state["audit_active_hour_offset"]
        file_size = os.path.getsize(self.audit_path)

        late = audit_record("2026-01-01T00:25:00.000Z", gateway_key="laptop-key")
        self.write_audit([late], append=True)

        with measure_read_bytes(self.audit_path) as fallback:
            self.assertTrue(self.run_in_process())

        self.assertGreaterEqual(fallback["bytes"], file_size)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        buckets = self.bucket_map(payload)
        self.assertEqual(
            set(buckets),
            {("2026-01-01T00:00:00Z", "laptop-key", "deepseek-chat")},
        )
        self.assertEqual(
            buckets[("2026-01-01T00:00:00Z", "laptop-key", "deepseek-chat")]["unit_count"],
            201,
        )
        state = self.read_state()
        self.assertEqual(state["audit_active_hour"], "2026-02-01T00:00:00Z")
        self.assertEqual(state["audit_active_hour_offset"], february_anchor)

        extra = audit_record("2026-02-01T00:15:00.000Z", gateway_key="laptop-key")
        self.write_audit([extra], append=True)
        with measure_read_bytes(self.audit_path) as warm:
            self.assertTrue(self.run_in_process())
        self.assertLess(warm["bytes"], 64 * 1024)
        payload = self.ingest.snapshot_requests()[-1]["payload"]
        buckets = self.bucket_map(payload)
        self.assertEqual(
            buckets[("2026-02-01T00:00:00Z", "laptop-key", "deepseek-chat")]["unit_count"], 9
        )

    def test_quota_backlog_peak_memory_is_bounded_by_a_batch(self) -> None:
        start = datetime(2026, 11, 26, 0, 0, 0)

        def records() -> Iterator[dict[str, Any]]:
            for index in range(1000):
                record = usage_record(
                    (start + timedelta(minutes=index)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                    key_fingerprint="fp_%04d" % index,
                    rolling=window(percent=float(index % 100)),
                )
                # A large ignored field keeps the file over 4 MB while each
                # observation still costs only one window.
                record["noise"] = "x" * 4200
                yield record

        path = self.write_usage_streaming("2026-11-26", records())
        size = os.path.getsize(path)
        self.assertGreater(size, 4 * 1024 * 1024)
        self.ingest.discard = True

        with measure_peak_bytes() as memory:
            self.assertTrue(self.run_in_process())

        self.assertLess(memory["peak"], size / 2)
        self.assertEqual(self.read_state()["usage_cursors"]["2026-11-26"], size)

    def test_quota_batches_advance_offsets_only_on_ack(self) -> None:
        start = datetime(2026, 11, 26, 0, 0, 0)
        records = [
            usage_record(
                (start + timedelta(minutes=index)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                key_fingerprint="fp_a",
                rolling=window(percent=float(index % 100)),
            )
            for index in range(300)
        ]
        path = self.write_usage("2026-11-26", records)
        first_batch_end = self.offset_after_lines(path, 250)
        size = os.path.getsize(path)

        self.ingest.drop_response_at = 2
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)

        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(len(requests[0]["payload"]["quota_observations"]), 250)
        self.assertEqual(len(requests[1]["payload"]["quota_observations"]), 50)
        state = self.read_state()
        self.assertEqual(state["usage_cursors"], {"2026-11-26": first_batch_end})
        self.assertEqual(state["pending"]["batch_seq"], 2)
        self.assertEqual(
            state["pending"]["usage_cursors_after"], {"2026-11-26": size}
        )
        dropped_body = requests[1]["body"]

        self.assert_ok(self.run_cli())
        retried = self.ingest.snapshot_requests()[2]
        self.assertEqual(retried["body"], dropped_body)
        state = self.read_state()
        self.assertEqual(state["usage_cursors"], {"2026-11-26": size})
        self.assertEqual(len(self.ingest.snapshot_observations()), 300)

    def test_rotation_during_pending_replays_then_ships_new_generation(self) -> None:
        self.write_audit([audit_record("2026-11-26T14:05:00.000Z", gateway_key="laptop-key")])
        self.ingest.drop_next_response = True
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(len(self.ingest.snapshot_requests()), 1)
        pending_body = self.ingest.snapshot_requests()[0]["body"]

        rotated = os.path.join(self.tempdir, "audit.rotated.jsonl")
        with open(rotated, "wb") as handle:
            for record in (
                audit_record("2026-11-26T15:05:00.000Z", gateway_key="desktop-key"),
                audit_record("2026-11-26T15:15:00.000Z", gateway_key="desktop-key"),
            ):
                handle.write(json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n")
        new_size = os.path.getsize(rotated)
        os.replace(rotated, self.audit_path)

        resumed = self.run_cli()

        self.assert_ok(resumed)
        self.assertIn("rotated or truncated", resumed.stderr)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(requests[1]["body"], pending_body)
        self.assertEqual(requests[2]["payload"]["batch_seq"], 2)
        self.assertEqual(
            set(self.bucket_map(requests[2]["payload"])),
            {("2026-11-26T15:00:00Z", "desktop-key", "deepseek-chat")},
        )
        state = self.read_state()
        self.assertIsNone(state["pending"])
        self.assertEqual(state["batch_seq"], 2)
        self.assertEqual(state["audit_cursor"], new_size)
        self.assertEqual(
            state["audit_file_id"],
            [os.stat(self.audit_path).st_dev, os.stat(self.audit_path).st_ino],
        )

    def test_pending_replays_before_missing_audit_error(self) -> None:
        self.write_audit([audit_record("2026-11-26T12:05:00.000Z")])
        path = self.write_usage(
            "2026-11-26",
            [
                usage_record(
                    "2026-11-26T12:10:00.000Z",
                    key_fingerprint="fp_a",
                    rolling=window(percent=10.0),
                )
            ],
        )
        audit_size = os.path.getsize(self.audit_path)
        usage_size = os.path.getsize(path)
        self.ingest.drop_next_response = True
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        first_body = self.ingest.snapshot_requests()[0]["body"]
        os.remove(self.audit_path)

        missing = self.run_cli()

        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("audit log not found", missing.stderr)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["body"], first_body)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["audit_cursor"], audit_size)
        self.assertEqual(state["usage_cursors"], {"2026-11-26": usage_size})
        self.assertIsNone(state["pending"])

        # Restoring the audit source lets the next run proceed automatically.
        self.write_audit([audit_record("2026-11-26T12:05:00.000Z")])
        self.assert_ok(self.run_cli())
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 2)
        self.assertEqual(state["audit_cursor"], os.path.getsize(self.audit_path))
        self.assertEqual(len(self.ingest.snapshot_observations()), 1)

    def test_rotation_reset_persists_without_new_data(self) -> None:
        self.write_audit([audit_record("2026-11-26T12:05:00.000Z")])
        self.assert_ok(self.run_cli())
        before = self.read_state()

        rotated = os.path.join(self.tempdir, "audit.empty.jsonl")
        open(rotated, "wb").close()
        os.replace(rotated, self.audit_path)

        result = self.run_cli(extra=["--no-heartbeat"])
        self.assert_ok(result)
        self.assertIn("rotated or truncated", result.stderr)
        state = self.read_state()
        self.assertEqual(state["audit_cursor"], 0)
        self.assertIsNone(state["audit_active_hour"])
        self.assertEqual(state["batch_seq"], before["batch_seq"])
        self.assertNotEqual(state["audit_file_id"], before["audit_file_id"])
        self.assertEqual(
            state["audit_file_id"],
            [os.stat(self.audit_path).st_dev, os.stat(self.audit_path).st_ino],
        )

        # The reset was persisted, so the next idle run does not repeat it.
        again = self.run_cli(extra=["--no-heartbeat"])
        self.assert_ok(again)
        self.assertNotIn("rotated or truncated", again.stderr)

    def test_replacement_just_before_inspection_ships_replacement_prefix(self) -> None:
        day = "2026-11-26"
        base = datetime(2026, 11, 26, 0, 0, 0)

        def records(prefix: str, count: int, noise: int) -> list[dict[str, Any]]:
            result = []
            for index in range(count):
                record = usage_record(
                    (base + timedelta(minutes=index)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                    key_fingerprint="%s-%02d" % (prefix, index),
                    rolling=window(percent=float(index)),
                )
                record["noise"] = "x" * noise
                result.append(record)
            return result

        def encode(items: list[dict[str, Any]]) -> bytes:
            return b"".join(
                json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n"
                for record in items
            )

        path = self.write_usage(day, records("old", 3, 1500))
        old_size = os.path.getsize(path)
        self.assert_ok(self.run_cli())
        self.assertEqual(self.read_state()["usage_cursors"][day], old_size)

        replacement = records("new", 5, 1000)
        replacement_bytes = encode(replacement)
        prefix_accounts = {record["key_fingerprint"] for record in replacement[:3]}
        self.assertGreaterEqual(len(replacement_bytes), old_size)
        self.assertLess(len(encode(replacement[:3])), old_size)

        rotated = os.path.join(self.usage_dir, day + ".rotated.jsonl")
        real_inspect = shipper_module.inspect_source
        replaced = False

        def replace_then_inspect(path_arg: str, cursor: int, expected: Any):
            nonlocal replaced
            if os.path.abspath(path_arg) == os.path.abspath(path) and not replaced:
                replaced = True
                with open(rotated, "wb") as handle:
                    handle.write(replacement_bytes)
                os.replace(rotated, path)
            return real_inspect(path_arg, cursor, expected)

        warning = io.StringIO()
        with (
            mock.patch.object(
                shipper_module,
                "inspect_source",
                side_effect=replace_then_inspect,
            ),
            contextlib.redirect_stderr(warning),
        ):
            self.assertTrue(self.run_in_process())

        self.assertTrue(replaced)
        self.assertIn("rotated or truncated", warning.getvalue())
        observations = self.ingest.snapshot_requests()[-1]["payload"]["quota_observations"]
        shipped = {observation["account"] for observation in observations}
        self.assertTrue(prefix_accounts <= shipped)
        self.assertEqual(shipped, {record["key_fingerprint"] for record in replacement})
        self.assertEqual(self.read_state()["usage_cursors"][day], len(replacement_bytes))

    def test_usage_file_disappearing_before_inspection_is_skipped(self) -> None:
        gone_day = "2026-11-26"
        other_day = "2026-11-27"
        gone_path = self.write_usage(
            gone_day,
            [
                usage_record(
                    "2026-11-26T10:00:00.000Z",
                    key_fingerprint="fp_gone",
                    rolling=window(percent=10.0),
                )
            ],
        )
        self.write_usage(
            other_day,
            [
                usage_record(
                    "2026-11-27T10:00:00.000Z",
                    key_fingerprint="fp_other",
                    rolling=window(percent=20.0),
                )
            ],
        )

        real_inspect = shipper_module.inspect_source
        removed = False

        def remove_then_inspect(path_arg: str, cursor: int, expected: Any):
            nonlocal removed
            if os.path.abspath(path_arg) == os.path.abspath(gone_path) and not removed:
                removed = True
                os.remove(gone_path)
            return real_inspect(path_arg, cursor, expected)

        with mock.patch.object(
            shipper_module,
            "inspect_source",
            side_effect=remove_then_inspect,
        ):
            self.assertTrue(self.run_in_process())

        self.assertTrue(removed)
        observations = self.ingest.snapshot_requests()[-1]["payload"]["quota_observations"]
        self.assertEqual({observation["account"] for observation in observations}, {"fp_other"})
        state = self.read_state()
        self.assertNotIn(gone_day, state["usage_cursors"])
        self.assertIn(other_day, state["usage_cursors"])


    def test_old_cursor_combines_plain_and_gzip_archives(self) -> None:
        self.write_audit_archive(2, [self._record("2026-11-26T08:00:00.000Z", 1)], compressed=True)
        self.write_audit_archive(
            1,
            [
                self._record("2026-11-26T08:30:00.000Z", 2),
                self._record("2026-11-26T09:05:00.000Z", 4),
            ],
        )
        self.write_audit([self._record("2026-11-26T09:55:00.000Z", 8)])
        size = os.path.getsize(self.audit_path)
        legacy = {
            "version": 4,
            "producer_id": "orihsus-main",
            "batch_seq": 0,
            "audit_cursor": size,
            "audit_active_hour": "2026-11-26T09:00:00Z",
            "audit_active_hour_offset": 0,
            "audit_file_id": [
                os.stat(self.audit_path).st_dev,
                os.stat(self.audit_path).st_ino,
            ],
            "usage_cursors": {},
            "usage_files": {},
            "pending": None,
        }
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(legacy, handle)

        self.assert_ok(self.run_cli())
        rows = self.ingest.snapshot_usage_rows()
        hour8 = self._usage_row(rows, "2026-11-26T08:00:00Z")
        hour9 = self._usage_row(rows, "2026-11-26T09:00:00Z")
        self.assertEqual((hour8["unit_count"], hour8["input_tokens"]), (2, 3))
        self.assertEqual((hour9["unit_count"], hour9["input_tokens"]), (2, 12))

    def test_append_to_archived_hour_includes_archive_contribution(self) -> None:
        self.write_audit_archive(1, [self._record("2026-11-26T08:05:00.000Z", 1)])
        self.write_audit([self._record("2026-11-26T09:05:00.000Z", 2)])
        self.assert_ok(self.run_cli())

        self.write_audit([self._record("2026-11-26T08:35:00.000Z", 4)], append=True)
        self.assert_ok(self.run_cli())

        rows = self.ingest.snapshot_usage_rows()
        hour8 = self._usage_row(rows, "2026-11-26T08:00:00Z")
        self.assertEqual((hour8["unit_count"], hour8["input_tokens"]), (2, 5))

    def test_archive_rescan_tombstones_legacy_metadata_buckets(self) -> None:
        hour = "2026-11-26T08:00:00Z"
        metadata = audit_record(
            "2026-11-26T08:05:00.000Z",
            gateway_key=None,
            model=None,
            status=200,
            outcome=None,
            input_tokens=None,
            cached_tokens=None,
            uncached_tokens=None,
            output_tokens=None,
            reasoning_tokens=None,
        )
        metadata["key_fingerprint"] = None
        self.write_audit_archive(1, [metadata])
        self.write_audit([])
        archive_fingerprint = shipper_module._audit_archive_fingerprint(
            shipper_module._audit_archive_entries(self.audit_path)
        )
        legacy_state = {
            "version": 4,
            "producer_id": "orihsus-main",
            "batch_seq": 0,
            "audit_cursor": 0,
            "audit_active_hour": None,
            "audit_active_hour_offset": 0,
            "audit_file_id": [
                os.stat(self.audit_path).st_dev,
                os.stat(self.audit_path).st_ino,
            ],
            "audit_archives": archive_fingerprint,
            "audit_archive_hour": hour,
            "usage_cursors": {},
            "usage_files": {},
            "pending": None,
        }
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(legacy_state, handle)

        legacy_key = ("opencode", "default", "identity", "unknown", "unknown", "", hour)
        self.ingest.usage_rows[legacy_key] = {
            "source": "opencode",
            "account": "default",
            "actor_kind": "identity",
            "actor_id": "unknown",
            "model": "unknown",
            "effort": "",
            "bucket_start": hour,
            "unit_kind": "request",
            "unit_count": 7,
            "coverage_gaps": 7,
        }
        self.assert_ok(self.run_cli())
        self.assertEqual(self.ingest.snapshot_usage_rows()[legacy_key]["unit_count"], 7)

        # Production retriggers the existing archive scan once by removing only
        # the archive fingerprint under the shipper's own lock.
        with open(self.state_path, "r", encoding="utf-8") as handle:
            retrigger_state = json.load(handle)
        retrigger_state.pop("audit_archives")
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(retrigger_state, handle)

        self.assert_ok(self.run_cli())
        tombstone = self.ingest.snapshot_usage_rows()[legacy_key]
        self.assertEqual(tombstone["unit_count"], 0)
        self.assertEqual(tombstone["coverage_gaps"], 0)
        self.assertIsNone(tombstone["input_tokens"])
        self.assertEqual(tombstone["input_counted"], 0)

    def test_corrupt_retained_archive_fails_before_publishing(self) -> None:
        corrupt = gzip.compress(self._encode([self._record("2026-11-26T08:05:00.000Z", 1)]))[:-8]
        with open(os.path.join(self.tempdir, "audit.jsonl.2.gz"), "wb") as handle:
            handle.write(corrupt)
        self.write_audit_archive(1, [self._record("2026-11-26T09:05:00.000Z", 2)])

        result = self.run_cli()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not be read completely", result.stderr)
        self.assertEqual(self.ingest.snapshot_requests(), [])

    def test_lost_ack_replays_same_archive_snapshot_and_repeat_stays_cached(self) -> None:
        archive = self.write_audit_archive(1, [self._record("2026-11-26T08:05:00.000Z", 1)])
        self.write_audit([self._record("2026-11-26T09:05:00.000Z", 2)])
        self.ingest.drop_next_response = True

        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        first_body = self.ingest.snapshot_requests()[0]["body"]

        self.assert_ok(self.run_cli())
        self.assertEqual(self.ingest.snapshot_requests()[1]["body"], first_body)
        self.assertEqual(len(self.ingest.snapshot_usage_rows()), 2)

        before = self.ingest.snapshot_usage_rows()
        with measure_read_bytes(archive) as meter:
            self.assertTrue(self.run_in_process())
        self.assertEqual(meter["bytes"], 0)
        self.assertEqual(self.ingest.snapshot_usage_rows(), before)


if __name__ == "__main__":
    unittest.main()
