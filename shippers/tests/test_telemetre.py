"""Behavior tests for the standalone telemetre quota shipper CLI.

Every test drives the real command line against a local HTTP ingest endpoint.
The mock endpoint enforces the replay contract (monotonic batch sequence,
duplicate no-op, stale conflict, 500-row budget) and records the exact request
bytes so retries can be compared byte-for-byte.

The source fixture is a synthetic telemetre centre SQLite database created with
the same ``quota_samples`` / ``quota_windows`` schema as the upstream sampler.
The test process inserts rows directly; the shipper only ever opens the file
read-only.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

SHIPPER = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "telemetre.py"))
INGEST_PATH = "/api/v1/ingest"
TOKEN = "test-scoped-token"

SCHEMA = """
CREATE TABLE IF NOT EXISTS quota_samples (
    sample_id        TEXT PRIMARY KEY,
    provider         TEXT NOT NULL,
    account          TEXT NOT NULL,
    machine          TEXT NOT NULL,
    sampled_at       TEXT NOT NULL,
    sampled_epoch    REAL NOT NULL,
    received_at      TEXT NOT NULL,
    received_epoch   REAL NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('success', 'failure')),
    error_kind       TEXT,
    error_detail     TEXT,
    empty_windows    INTEGER NOT NULL DEFAULT 0,
    time_anomaly     INTEGER NOT NULL DEFAULT 0,
    interval_seconds INTEGER NOT NULL,
    collector_version TEXT NOT NULL,
    payload_digest   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quota_samples_account_time
    ON quota_samples (provider, account, sampled_epoch DESC, received_epoch DESC);
CREATE INDEX IF NOT EXISTS quota_samples_time
    ON quota_samples (sampled_epoch);

CREATE TABLE IF NOT EXISTS quota_windows (
    sample_id         TEXT NOT NULL REFERENCES quota_samples(sample_id) ON DELETE CASCADE,
    ordinal           INTEGER NOT NULL,
    group_name        TEXT NOT NULL,
    bucket_id         TEXT NOT NULL,
    limit_id          TEXT,
    slot              TEXT,
    window_raw        TEXT,
    window_minutes    INTEGER,
    remaining_value   REAL,
    remaining_unit    TEXT,
    remaining_display REAL,
    reset_raw         TEXT,
    reset_at          TEXT,
    anomalies         TEXT NOT NULL,
    PRIMARY KEY (sample_id, ordinal)
);
"""


def _epoch(timestamp: str) -> float:
    text = timestamp[:-1] + "+00:00" if timestamp.endswith("Z") else timestamp
    return datetime.fromisoformat(text).astimezone(timezone.utc).timestamp()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def window(
    *,
    group_name: str = "Gemini",
    bucket_id: str = "weekly",
    limit_id: Optional[str] = None,
    slot: Optional[str] = None,
    window_raw: Any = "7d",
    window_minutes: Optional[int] = 10080,
    remaining_value: Optional[float] = 0.9,
    remaining_unit: Optional[str] = "fraction",
    remaining_display: Optional[float] = 90.0,
    reset_raw: Any = "2026-12-01T00:00:00Z",
    reset_at: Optional[str] = "2026-12-01T00:00:00Z",
    anomalies: tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "group_name": group_name,
        "bucket_id": bucket_id,
        "limit_id": limit_id,
        "slot": slot,
        "window_raw": window_raw,
        "window_minutes": window_minutes,
        "remaining_value": remaining_value,
        "remaining_unit": remaining_unit,
        "remaining_display": remaining_display,
        "reset_raw": reset_raw,
        "reset_at": reset_at,
        "anomalies": anomalies,
    }


def payload_row_count(payload: dict[str, Any]) -> int:
    rows = len(payload.get("usage_buckets") or [])
    rows += len(payload.get("balance_snapshots") or [])
    for observation in payload.get("quota_observations") or []:
        rows += 1 + len(observation.get("windows") or [])
    return rows


class _IngestState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.observations: dict[str, dict[str, Any]] = {}
        self.last_seq = 0
        self.commits = 0
        self.duplicates = 0
        self.conflicts = 0
        self.oversized = 0
        self.invalid = 0
        self.drop_next_response = False
        self.drop_request_number: Optional[int] = None

    def receive(
        self,
        body: bytes,
        authorization: Optional[str],
        path: str,
    ) -> tuple[int, bool]:
        with self.lock:
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                self.invalid += 1
                self.requests.append(
                    {
                        "body": body,
                        "payload": None,
                        "authorization": authorization,
                        "path": path,
                        "status": 400,
                        "dropped": False,
                    }
                )
                return 400, False

            status: int
            rows = payload_row_count(payload)
            if payload.get("schema_version") != 1 or rows > 500:
                status = 400
                if rows > 500:
                    self.oversized += 1
                else:
                    self.invalid += 1
            else:
                sequence = payload["batch_seq"]
                if sequence < self.last_seq:
                    status = 409
                    self.conflicts += 1
                elif sequence == self.last_seq:
                    status = 200
                    self.duplicates += 1
                else:
                    for observation in payload.get("quota_observations") or []:
                        # Observations are immutable once sampled.
                        self.observations.setdefault(
                            observation["sample_id"], observation
                        )
                    self.last_seq = sequence
                    self.commits += 1
                    status = 200

            request_number = len(self.requests) + 1
            drop = self.drop_next_response or self.drop_request_number == request_number
            if drop:
                self.drop_next_response = False
                if self.drop_request_number == request_number:
                    self.drop_request_number = None
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

    def snapshot_observations(self) -> dict[str, dict[str, Any]]:
        with self.lock:
            return dict(self.observations)

    def stats(self) -> tuple[int, int, int, int]:
        with self.lock:
            return self.last_seq, self.commits, self.duplicates, self.conflicts

    def failure_counts(self) -> tuple[int, int]:
        with self.lock:
            return self.oversized, self.invalid


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


class TelemetreShipperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.mkdtemp(prefix="bilan-telemetre-test-")
        self.database_path = os.path.join(self.tempdir, "quota.sqlite3")
        self.state_path = os.path.join(self.tempdir, "shipper-state.json")
        self._sample_counter = 0
        connection = sqlite3.connect(self.database_path)
        connection.executescript(SCHEMA)
        connection.commit()
        connection.close()

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

    # -- fixture helpers -------------------------------------------------

    def add_sample(
        self,
        *,
        sample_id: Optional[str] = None,
        provider: str = "agy",
        account: str = "personal",
        machine: str = "studio",
        sampled_at: str = "2026-11-26T14:30:00Z",
        received_at: Optional[str] = None,
        status: str = "success",
        error_kind: Optional[str] = None,
        error_detail: Optional[str] = None,
        empty_windows: int = 0,
        time_anomaly: int = 0,
        interval_seconds: int = 900,
        windows: tuple[dict[str, Any], ...] = (),
    ) -> int:
        if sample_id is None:
            self._sample_counter += 1
            sample_id = "sample-%03d" % self._sample_counter
        received_at = received_at or sampled_at
        connection = sqlite3.connect(self.database_path)
        try:
            cursor = connection.execute(
                """
                INSERT INTO quota_samples (
                    sample_id, provider, account, machine, sampled_at, sampled_epoch,
                    received_at, received_epoch, status, error_kind, error_detail,
                    empty_windows, time_anomaly, interval_seconds, collector_version,
                    payload_digest
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sample_id,
                    provider,
                    account,
                    machine,
                    sampled_at,
                    _epoch(sampled_at),
                    received_at,
                    _epoch(received_at),
                    status,
                    error_kind,
                    error_detail,
                    int(empty_windows),
                    int(time_anomaly),
                    interval_seconds,
                    "telemetre-quota/0.1",
                    "digest-" + sample_id,
                ),
            )
            row_id = int(cursor.lastrowid)
            for ordinal, item in enumerate(windows):
                self._insert_window(connection, sample_id, ordinal, item)
            connection.commit()
            return row_id
        finally:
            connection.close()

    @staticmethod
    def _insert_window(
        connection: sqlite3.Connection,
        sample_id: str,
        ordinal: int,
        item: dict[str, Any],
    ) -> None:
        connection.execute(
            """
            INSERT INTO quota_windows (
                sample_id, ordinal, group_name, bucket_id, limit_id, slot,
                window_raw, window_minutes, remaining_value, remaining_unit,
                remaining_display, reset_raw, reset_at, anomalies
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sample_id,
                ordinal,
                item["group_name"],
                item["bucket_id"],
                item["limit_id"],
                item["slot"],
                _json(item["window_raw"]),
                item["window_minutes"],
                item["remaining_value"],
                item["remaining_unit"],
                item["remaining_display"],
                _json(item["reset_raw"]),
                item["reset_at"],
                _json(list(item["anomalies"])),
            ),
        )

    def max_row_id(self) -> int:
        connection = sqlite3.connect(self.database_path)
        try:
            row = connection.execute("SELECT MAX(rowid) FROM quota_samples").fetchone()
            return int(row[0] or 0)
        finally:
            connection.close()

    def database_snapshot(self) -> dict[str, list[tuple[Any, ...]]]:
        connection = sqlite3.connect(self.database_path)
        try:
            return {
                "samples": connection.execute(
                    "SELECT sample_id, status, sampled_at FROM quota_samples ORDER BY rowid"
                ).fetchall(),
                "windows": connection.execute(
                    "SELECT sample_id, ordinal, bucket_id, slot FROM quota_windows "
                    "ORDER BY sample_id, ordinal"
                ).fetchall(),
            }
        finally:
            connection.close()

    def run_cli(self, *, extra: Optional[list[str]] = None) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            SHIPPER,
            "--database",
            self.database_path,
            "--state-file",
            self.state_path,
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
        environment.pop("TELEMETRE_QUOTA_DB", None)
        environment["NO_PROXY"] = "127.0.0.1,localhost"
        environment["no_proxy"] = "127.0.0.1,localhost"
        return subprocess.run(
            command,
            cwd=self.tempdir,
            env=environment,
            capture_output=True,
            text=True,
            timeout=90,
        )

    def read_state(self) -> dict[str, Any]:
        with open(self.state_path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def observations_by_id(self) -> dict[str, dict[str, Any]]:
        return self.ingest.snapshot_observations()

    def assert_ok(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stderr)

    @staticmethod
    def windows_by_slot(observation: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {item["slot"]: item for item in observation["windows"]}

    def assert_envelope_shape(self, payload: dict[str, Any], sequence: int) -> None:
        self.assertEqual(payload["schema_version"], 1)
        self.assertEqual(payload["batch_seq"], sequence)
        self.assertEqual(payload["usage_buckets"], [])
        self.assertEqual(payload["balance_snapshots"], [])
        self.assertIsInstance(payload["quota_observations"], list)

    # -- AGY + Codex mapping ---------------------------------------------

    def test_pushes_agy_and_codex_quota_with_window_mapping(self) -> None:
        self.add_sample(
            sample_id="agy-sample",
            provider="agy",
            account="personal",
            machine="studio-a",
            sampled_at="2026-11-26T14:30:00.900Z",
            received_at="2026-11-26T14:30:20Z",
            interval_seconds=900,
            windows=(
                window(
                    group_name="Gemini",
                    bucket_id="five-hour",
                    window_raw="5h",
                    window_minutes=300,
                    remaining_value=0.42,
                    remaining_display=42.0,
                    reset_at="2026-12-01T05:00:00.000Z",
                ),
                window(
                    group_name="Gemini",
                    bucket_id="weekly",
                    window_raw="7d",
                    window_minutes=10080,
                    remaining_value=0.9,
                    remaining_display=90.0,
                ),
            ),
        )
        self.add_sample(
            sample_id="codex-sample",
            provider="codex",
            account="work",
            machine="studio-a",
            sampled_at="2026-11-26T14:30:00.100Z",
            windows=(
                window(
                    group_name="codex",
                    bucket_id="primary",
                    limit_id="codex",
                    slot="primary",
                    window_raw=10080,
                    window_minutes=10080,
                    remaining_value=10,
                    remaining_unit="percent_used",
                    remaining_display=90.0,
                    reset_raw=1798761600,
                    reset_at="2026-12-01T00:00:00Z",
                ),
                window(
                    group_name="codex",
                    bucket_id="secondary",
                    limit_id="codex",
                    slot="secondary",
                    window_raw=300,
                    window_minutes=300,
                    remaining_value=0,
                    remaining_unit="percent_used",
                    remaining_display=100.0,
                    reset_raw=1798761600,
                    reset_at="2026-12-01T00:00:00Z",
                ),
            ),
        )
        # A legacy provider row is neither AGY nor Codex quota and must not be
        # shipped, but its insertion position must not pin the cursor.
        other_row_id = self.add_sample(
            sample_id="other-sample",
            provider="other",
            account="legacy",
            sampled_at="2026-11-26T14:31:00Z",
            windows=(window(group_name="Other"),),
        )
        before = self.database_snapshot()

        result = self.run_cli()
        self.assert_ok(result)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["authorization"], "Bearer " + TOKEN)
        payload = requests[0]["payload"]
        self.assert_envelope_shape(payload, 1)
        self.assertLessEqual(payload_row_count(payload), 500)
        self.assertEqual(len(payload["quota_observations"]), 2)

        by_id = {item["sample_id"]: item for item in payload["quota_observations"]}
        self.assertEqual(set(by_id), {"agy-sample", "codex-sample"})

        agy = by_id["agy-sample"]
        self.assertEqual(agy["source"], "agy")
        self.assertEqual(agy["account"], "personal")
        self.assertEqual(agy["observer_machine"], "studio-a")
        self.assertEqual(agy["sampled_at"], "2026-11-26T14:30:00Z")
        self.assertEqual(agy["interval_seconds"], 900)
        self.assertEqual(agy["status"], "ok")
        self.assertIsNone(agy["time_anomaly"])
        self.assertIsNone(agy["error_summary"])
        agy_windows = self.windows_by_slot(agy)
        self.assertEqual(set(agy_windows), {"five-hour", "weekly"})
        five_hour = agy_windows["five-hour"]
        self.assertEqual(five_hour["bucket_id"], "Gemini")
        self.assertEqual(five_hour["label"], "5h")
        self.assertEqual(five_hour["used_percent"], 58.0)
        self.assertEqual(five_hour["remaining_percent"], 42.0)
        self.assertIsNone(five_hour["status"])
        self.assertEqual(five_hour["resets_at"], "2026-12-01T05:00:00Z")
        self.assertEqual(five_hour["window_duration_mins"], 300)
        meta = json.loads(five_hour["meta_json"])
        self.assertEqual(meta["group"], "Gemini")
        self.assertEqual(meta["source_bucket_id"], "five-hour")
        self.assertEqual(meta["window"], "5h")
        self.assertEqual(meta["remaining_value"], 0.42)
        self.assertEqual(meta["remaining_unit"], "fraction")
        self.assertIn(meta.get("anomalies"), (None, []))
        self.assertEqual(agy_windows["weekly"]["label"], "7d")
        self.assertEqual(agy_windows["weekly"]["remaining_percent"], 90.0)

        codex = by_id["codex-sample"]
        self.assertEqual(codex["source"], "codex")
        self.assertEqual(codex["account"], "work")
        self.assertEqual(codex["sampled_at"], "2026-11-26T14:30:00Z")
        self.assertEqual(codex["status"], "ok")
        codex_windows = self.windows_by_slot(codex)
        self.assertEqual(set(codex_windows), {"primary", "secondary"})
        primary = codex_windows["primary"]
        self.assertEqual(primary["bucket_id"], "codex")
        self.assertIsNone(primary["label"])
        self.assertEqual(primary["used_percent"], 10.0)
        self.assertEqual(primary["remaining_percent"], 90.0)
        self.assertEqual(primary["window_duration_mins"], 10080)
        self.assertEqual(primary["resets_at"], "2026-12-01T00:00:00Z")
        primary_meta = json.loads(primary["meta_json"])
        self.assertEqual(primary_meta["group"], "codex")
        self.assertEqual(primary_meta["limit_id"], "codex")
        self.assertEqual(primary_meta["window"], 10080)
        self.assertEqual(primary_meta["remaining_unit"], "percent_used")
        self.assertEqual(codex_windows["secondary"]["used_percent"], 0.0)
        self.assertEqual(codex_windows["secondary"]["remaining_percent"], 100.0)

        # The shipper only reads the centre database; it must not rewrite it.
        self.assertEqual(self.database_snapshot(), before)

        state = self.read_state()
        self.assertEqual(state["producer_id"], "telemetre-quota")
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["cursor_rowid"], other_row_id)
        self.assertEqual(state["cursor_sample_id"], "other-sample")
        self.assertIsNone(state["pending"])
        self.assertEqual(self.ingest.failure_counts(), (0, 0))

        # An idle run only refreshes producer liveness.
        self.assert_ok(self.run_cli())
        heartbeat = self.ingest.snapshot_requests()[1]["payload"]
        self.assert_envelope_shape(heartbeat, 2)
        self.assertEqual(heartbeat["quota_observations"], [])
        self.assertEqual(len(self.observations_by_id()), 2)

    def test_late_and_same_second_samples_survive_across_ticks(self) -> None:
        self.add_sample(
            sample_id="codex-newer",
            provider="codex",
            account="work",
            sampled_at="2026-11-26T12:00:00Z",
            windows=(window(group_name="codex", bucket_id="primary", limit_id="codex", slot="primary"),),
        )
        self.add_sample(
            sample_id="agy-same-a",
            provider="agy",
            account="personal",
            sampled_at="2026-11-26T12:00:05Z",
            windows=(window(group_name="Gemini", bucket_id="weekly"),),
        )
        self.assert_ok(self.run_cli())
        first = self.ingest.snapshot_requests()[0]["payload"]
        self.assertEqual(
            {item["sample_id"] for item in first["quota_observations"]},
            {"codex-newer", "agy-same-a"},
        )

        # Insert a late-arriving sample with an older sampled_at after a newer
        # row, plus two samples sharing the exact same second.
        self.add_sample(
            sample_id="agy-late",
            provider="agy",
            account="personal",
            sampled_at="2026-11-26T11:00:00Z",
            received_at="2026-11-26T12:01:00Z",
            windows=(window(group_name="Gemini", bucket_id="five-hour", window_raw="5h"),),
        )
        self.add_sample(
            sample_id="agy-same-b",
            provider="agy",
            account="personal",
            sampled_at="2026-11-26T12:00:05Z",
            windows=(window(group_name="Gemini", bucket_id="weekly", remaining_display=50.0),),
        )
        self.add_sample(
            sample_id="codex-same",
            provider="codex",
            account="work",
            sampled_at="2026-11-26T12:00:05Z",
            windows=(window(group_name="codex", bucket_id="primary", limit_id="codex", slot="primary"),),
        )

        self.assert_ok(self.run_cli())
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        second = requests[1]["payload"]
        self.assert_envelope_shape(second, 2)
        self.assertEqual(
            {item["sample_id"] for item in second["quota_observations"]},
            {"agy-late", "agy-same-b", "codex-same"},
        )
        by_id = {item["sample_id"]: item for item in second["quota_observations"]}
        self.assertEqual(by_id["agy-late"]["sampled_at"], "2026-11-26T11:00:00Z")
        same_second = {
            item["sample_id"]: item["sampled_at"]
            for item in second["quota_observations"]
            if item["sample_id"] in ("agy-same-b", "codex-same")
        }
        self.assertEqual(
            same_second,
            {
                "agy-same-b": "2026-11-26T12:00:05Z",
                "codex-same": "2026-11-26T12:00:05Z",
            },
        )

        # Every insertion-ordered sample reached the mock exactly once.
        self.assertEqual(
            set(self.observations_by_id()),
            {"codex-newer", "agy-same-a", "agy-late", "agy-same-b", "codex-same"},
        )
        self.assertEqual(self.ingest.stats(), (2, 2, 0, 0))
        self.assertEqual(self.read_state()["cursor_rowid"], self.max_row_id())

    # -- error / empty / null semantics ----------------------------------

    def test_error_and_empty_attempts_are_preserved_without_readings(self) -> None:
        self.add_sample(
            sample_id="failure-timeout",
            provider="codex",
            account="work",
            status="failure",
            error_kind="timeout",
            error_detail="provider did not finish within 60s\nsecond line",
        )
        self.add_sample(
            sample_id="empty-agy",
            provider="agy",
            account="personal",
            empty_windows=1,
        )
        self.add_sample(
            sample_id="missing-agy",
            provider="agy",
            account="personal",
            windows=(
                window(
                    group_name="Gemini",
                    bucket_id="weekly",
                    window_raw="7d",
                    window_minutes=None,
                    remaining_value=None,
                    remaining_unit=None,
                    remaining_display=None,
                    reset_raw=None,
                    reset_at=None,
                    anomalies=("missing_remaining",),
                ),
            ),
        )

        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[0]["payload"]
        by_id = {item["sample_id"]: item for item in payload["quota_observations"]}

        failed = by_id["failure-timeout"]
        self.assertEqual(failed["status"], "error")
        self.assertEqual(
            failed["error_summary"],
            "timeout: provider did not finish within 60s second line",
        )
        self.assertEqual(failed["windows"], [])
        self.assertIsNone(failed["time_anomaly"])

        empty = by_id["empty-agy"]
        self.assertEqual(empty["status"], "empty")
        self.assertEqual(empty["windows"], [])
        self.assertIsNone(empty["error_summary"])

        missing = by_id["missing-agy"]
        self.assertEqual(missing["status"], "ok")
        self.assertEqual(len(missing["windows"]), 1)
        item = missing["windows"][0]
        self.assertEqual(item["bucket_id"], "Gemini")
        self.assertEqual(item["slot"], "weekly")
        self.assertIsNone(item["used_percent"])
        self.assertIsNone(item["remaining_percent"])
        self.assertIsNone(item["resets_at"])
        self.assertIsNone(item["window_duration_mins"])
        meta = json.loads(item["meta_json"])
        self.assertEqual(meta["anomalies"], ["missing_remaining"])

        # A failed or empty attempt is never converted into a 0%/100% reading.
        self.assertFalse(
            any(
                window_item["used_percent"] == 0
                for observation in payload["quota_observations"]
                for window_item in observation["windows"]
            )
        )

    def test_future_clock_and_window_anomalies_are_preserved(self) -> None:
        self.add_sample(
            sample_id="agy-valid",
            provider="agy",
            account="personal",
            sampled_at="2026-11-26T10:00:00Z",
            windows=(window(group_name="Gemini", bucket_id="weekly", remaining_display=50.0),),
        )
        self.add_sample(
            sample_id="agy-future",
            provider="agy",
            account="personal",
            sampled_at="2099-01-01T00:00:00Z",
            received_at="2026-11-26T10:05:00Z",
            time_anomaly=1,
            windows=(
                window(
                    group_name="Gemini",
                    bucket_id="five-hour",
                    window_raw="5h",
                    window_minutes=300,
                    remaining_value=1.5,
                    remaining_display=150.0,
                    anomalies=("remaining_out_of_range",),
                ),
                window(
                    group_name="Gemini",
                    bucket_id="weekly",
                    window_raw="7d",
                    remaining_value=None,
                    remaining_unit=None,
                    remaining_display=None,
                    reset_raw=None,
                    reset_at=None,
                    anomalies=("missing_remaining", "invalid_reset"),
                ),
            ),
        )

        self.assert_ok(self.run_cli())
        payload = self.ingest.snapshot_requests()[0]["payload"]
        by_id = {item["sample_id"]: item for item in payload["quota_observations"]}

        future = by_id["agy-future"]
        # A far-future clock is preserved verbatim, never clamped to now.
        self.assertEqual(future["sampled_at"], "2099-01-01T00:00:00Z")
        self.assertEqual(future["time_anomaly"], "future_sampled_at")
        self.assertEqual(future["status"], "ok")
        future_windows = self.windows_by_slot(future)
        out_of_range = future_windows["five-hour"]
        self.assertIsNone(out_of_range["used_percent"])
        self.assertIsNone(out_of_range["remaining_percent"])
        out_of_range_meta = json.loads(out_of_range["meta_json"])
        self.assertIn("remaining_out_of_range", out_of_range_meta["anomalies"])
        self.assertEqual(out_of_range_meta["remaining_value"], 1.5)
        missing = future_windows["weekly"]
        self.assertIsNone(missing["used_percent"])
        self.assertIsNone(missing["remaining_percent"])
        self.assertIsNone(missing["resets_at"])
        self.assertEqual(
            json.loads(missing["meta_json"])["anomalies"],
            ["missing_remaining", "invalid_reset"],
        )

        valid = by_id["agy-valid"]
        self.assertIsNone(valid["time_anomaly"])
        self.assertEqual(valid["windows"][0]["remaining_percent"], 50.0)

        # The read surface can still select the latest *valid* observation.
        valid_candidates = [
            item
            for item in payload["quota_observations"]
            if item["source"] == "agy"
            and item["account"] == "personal"
            and item["status"] == "ok"
            and item["time_anomaly"] is None
        ]
        self.assertEqual(len(valid_candidates), 1)
        self.assertEqual(valid_candidates[0]["sample_id"], "agy-valid")

    def test_observations_keep_each_account_and_latest_per_account(self) -> None:
        self.add_sample(
            sample_id="agy-personal-1",
            provider="agy",
            account="personal",
            sampled_at="2026-11-26T10:00:00Z",
            windows=(window(group_name="Gemini", bucket_id="weekly", remaining_display=80.0),),
        )
        self.add_sample(
            sample_id="agy-work-1",
            provider="agy",
            account="work",
            sampled_at="2026-11-26T10:05:00Z",
            windows=(window(group_name="Gemini", bucket_id="weekly", remaining_display=60.0),),
        )
        self.add_sample(
            sample_id="codex-work-1",
            provider="codex",
            account="work",
            sampled_at="2026-11-26T10:10:00Z",
            windows=(window(group_name="codex", bucket_id="primary", limit_id="codex", slot="primary"),),
        )
        self.assert_ok(self.run_cli())
        self.assertEqual(len(self.observations_by_id()), 3)

        self.add_sample(
            sample_id="agy-personal-2",
            provider="agy",
            account="personal",
            sampled_at="2026-11-26T10:15:00Z",
            windows=(window(group_name="Gemini", bucket_id="weekly", remaining_display=70.0),),
        )
        self.assert_ok(self.run_cli())
        self.assertEqual(len(self.observations_by_id()), 4)

        latest: dict[tuple[str, str], dict[str, Any]] = {}
        for observation in self.observations_by_id().values():
            key = (observation["source"], observation["account"])
            if key not in latest or observation["sampled_at"] > latest[key]["sampled_at"]:
                latest[key] = observation
        self.assertEqual(set(latest), {("agy", "personal"), ("agy", "work"), ("codex", "work")})
        self.assertEqual(latest[("agy", "personal")]["sample_id"], "agy-personal-2")
        self.assertEqual(latest[("agy", "personal")]["sampled_at"], "2026-11-26T10:15:00Z")
        self.assertEqual(latest[("agy", "work")]["sample_id"], "agy-work-1")
        self.assertEqual(latest[("codex", "work")]["sample_id"], "codex-work-1")

    def test_null_bucket_slot_and_values_use_stable_non_empty_identities(self) -> None:
        self.add_sample(
            sample_id="agy-null-slot",
            provider="agy",
            account="personal",
            windows=(
                window(
                    group_name="Gemini",
                    bucket_id="weekly",
                    slot=None,
                    limit_id=None,
                    window_raw="7d",
                    remaining_display=None,
                    remaining_value=None,
                    remaining_unit=None,
                    reset_raw=None,
                    reset_at=None,
                    window_minutes=None,
                    anomalies=("missing_remaining",),
                ),
            ),
        )
        self.add_sample(
            sample_id="codex-null-limit",
            provider="codex",
            account="work",
            windows=(
                window(
                    group_name="default",
                    bucket_id="primary",
                    limit_id=None,
                    slot=None,
                    window_raw=None,
                    window_minutes=0,
                    remaining_display=None,
                    remaining_value=None,
                    remaining_unit=None,
                    reset_raw=None,
                    reset_at=None,
                    anomalies=("missing_remaining", "invalid_reset"),
                ),
                # Entirely empty upstream identities still get distinct,
                # contract-safe fallback keys.
                window(
                    group_name="",
                    bucket_id="",
                    limit_id=None,
                    slot=None,
                    window_raw=None,
                    window_minutes=None,
                    remaining_display=None,
                    remaining_value=None,
                    remaining_unit=None,
                    reset_raw=None,
                    reset_at=None,
                ),
            ),
        )

        self.assert_ok(self.run_cli())
        self.assertEqual(self.ingest.failure_counts(), (0, 0))
        payload = self.ingest.snapshot_requests()[0]["payload"]
        by_id = {item["sample_id"]: item for item in payload["quota_observations"]}

        agy = by_id["agy-null-slot"]["windows"][0]
        self.assertEqual(agy["bucket_id"], "Gemini")
        self.assertEqual(agy["slot"], "weekly")
        self.assertEqual(agy["label"], "7d")
        self.assertIsNone(agy["used_percent"])
        self.assertIsNone(agy["remaining_percent"])
        self.assertIsNone(agy["resets_at"])
        self.assertIsNone(agy["window_duration_mins"])

        codex_windows = by_id["codex-null-limit"]["windows"]
        self.assertEqual(len(codex_windows), 2)
        for item in codex_windows:
            self.assertTrue(item["bucket_id"])
            self.assertTrue(item["slot"])
            self.assertLessEqual(len(item["bucket_id"]), 128)
            self.assertLessEqual(len(item["slot"]), 64)
        keys = {(item["bucket_id"], item["slot"]) for item in codex_windows}
        self.assertEqual(len(keys), 2)
        self.assertIn(("default", "primary"), keys)
        self.assertIsNone(codex_windows[0]["used_percent"])
        self.assertIsNone(codex_windows[0]["remaining_percent"])
        self.assertIsNone(codex_windows[0]["resets_at"])
        self.assertIsNone(codex_windows[0]["window_duration_mins"])

    def test_long_slot_dedup_suffixes_stay_within_the_contract(self) -> None:
        long_slot = "s" * 64
        self.add_sample(
            sample_id="codex-long-slot",
            provider="codex",
            account="work",
            windows=(
                window(
                    group_name="default",
                    bucket_id="primary",
                    limit_id=None,
                    slot=long_slot,
                ),
                window(
                    group_name="default",
                    bucket_id="primary",
                    limit_id=None,
                    slot=long_slot,
                ),
                window(
                    group_name="default",
                    bucket_id="primary",
                    limit_id=None,
                    slot=long_slot,
                ),
            ),
        )

        self.assert_ok(self.run_cli())
        self.assertEqual(self.ingest.failure_counts(), (0, 0))
        payload = self.ingest.snapshot_requests()[0]["payload"]
        windows = payload["quota_observations"][0]["windows"]
        slots = [item["slot"] for item in windows]
        self.assertEqual(len(slots), 3)
        self.assertTrue(all(slot and len(slot) <= 64 for slot in slots))
        self.assertEqual(len(set(slots)), 3)
        self.assertEqual(slots[0], long_slot)
        self.assertTrue(slots[1].endswith("#2"))
        self.assertTrue(slots[2].endswith("#3"))

    # -- durable replay / ACK / heartbeat ---------------------------------

    def test_lost_ack_retries_identical_batch_then_heartbeats(self) -> None:
        self.add_sample(
            sample_id="agy-1",
            provider="agy",
            account="personal",
            windows=(window(group_name="Gemini", bucket_id="weekly"),),
        )
        self.add_sample(
            sample_id="codex-1",
            provider="codex",
            account="work",
            windows=(window(group_name="codex", bucket_id="primary", limit_id="codex", slot="primary"),),
        )
        self.ingest.drop_next_response = True

        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(self.ingest.stats(), (1, 1, 0, 0))
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 0)
        self.assertEqual(state["cursor_rowid"], 0)
        self.assertIsNone(state["cursor_sample_id"])
        self.assertEqual(state["pending"]["batch_seq"], 1)
        self.assertEqual(state["pending"]["payload"]["batch_seq"], 1)
        self.assertEqual(state["pending"]["cursor_rowid_after"], self.max_row_id())
        self.assertEqual(state["pending"]["cursor_sample_id_after"], "codex-1")
        first_body = self.ingest.snapshot_requests()[0]["body"]

        second = self.run_cli()
        self.assert_ok(second)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["body"], first_body)
        self.assertEqual(requests[1]["payload"]["batch_seq"], 1)
        self.assertEqual(self.ingest.stats(), (1, 1, 1, 0))
        self.assertEqual(len(self.observations_by_id()), 2)

        state = self.read_state()
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["cursor_rowid"], self.max_row_id())
        self.assertEqual(state["cursor_sample_id"], "codex-1")
        self.assertIsNone(state["pending"])

        # An idle run only refreshes liveness.
        self.assert_ok(self.run_cli())
        heartbeat = self.ingest.snapshot_requests()[2]["payload"]
        self.assert_envelope_shape(heartbeat, 2)
        self.assertEqual(heartbeat["quota_observations"], [])
        self.assertEqual(len(self.observations_by_id()), 2)

        # Heartbeats can be disabled without losing the consumed cursor.
        self.assert_ok(self.run_cli(extra=["--no-heartbeat"]))
        self.assertEqual(len(self.ingest.snapshot_requests()), 3)
        self.assertEqual(self.read_state()["batch_seq"], 2)

    def test_interrupted_multi_chunk_backlog_resumes_without_loss(self) -> None:
        # 126 observations with three windows each = 504 storage rows, so the
        # first batch must stop at exactly 500 rows and leave one observation.
        for index in range(126):
            timestamp = "2026-11-26T%02d:%02d:%02dZ" % (
                index // 3600,
                (index // 60) % 60,
                index % 60,
            )
            self.add_sample(
                sample_id="bulk-%03d" % index,
                provider="agy",
                account="personal",
                sampled_at=timestamp,
                windows=(
                    window(group_name="Gemini", bucket_id="five-hour", window_raw="5h"),
                    window(group_name="Gemini", bucket_id="weekly", window_raw="7d"),
                    window(group_name="Gemini", bucket_id="monthly", window_raw="30d"),
                ),
            )

        self.ingest.drop_next_response = True
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 0)
        self.assertEqual(state["pending"]["batch_seq"], 1)
        self.assertEqual(len(state["pending"]["payload"]["quota_observations"]), 125)
        self.assertEqual(
            payload_row_count(state["pending"]["payload"]), 500
        )
        self.assertEqual(state["pending"]["cursor_rowid_after"], 125)
        self.assertEqual(state["pending"]["cursor_sample_id_after"], "bulk-124")
        first_body = self.ingest.snapshot_requests()[0]["body"]

        second = self.run_cli()
        self.assert_ok(second)
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 3)
        self.assertEqual(requests[1]["body"], first_body)
        self.assertEqual(len(requests[1]["payload"]["quota_observations"]), 125)
        self.assertEqual(len(requests[2]["payload"]["quota_observations"]), 1)
        self.assertEqual(requests[2]["payload"]["batch_seq"], 2)
        self.assertEqual(payload_row_count(requests[2]["payload"]), 4)
        for request in requests:
            self.assertLessEqual(payload_row_count(request["payload"]), 500)
        self.assertEqual(self.ingest.failure_counts(), (0, 0))
        self.assertEqual(self.ingest.stats(), (2, 2, 1, 0))
        self.assertEqual(len(self.observations_by_id()), 126)
        self.assertEqual(
            set(self.observations_by_id()),
            {"bulk-%03d" % index for index in range(126)},
        )

        state = self.read_state()
        self.assertEqual(state["batch_seq"], 2)
        self.assertEqual(state["cursor_rowid"], self.max_row_id())
        self.assertEqual(state["cursor_sample_id"], "bulk-125")
        self.assertIsNone(state["pending"])

    def test_non_quota_rows_advance_cursor_without_skipping_later_quota(self) -> None:
        self.add_sample(
            sample_id="other-1",
            provider="other",
            account="legacy",
            windows=(window(group_name="Other"),),
        )
        self.assert_ok(self.run_cli(extra=["--no-heartbeat"]))
        self.assertEqual(self.ingest.snapshot_requests(), [])
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 0)
        self.assertEqual(state["cursor_rowid"], 1)
        self.assertEqual(state["cursor_sample_id"], "other-1")

        self.add_sample(
            sample_id="agy-after-other",
            provider="agy",
            account="personal",
            windows=(window(group_name="Gemini", bucket_id="weekly"),),
        )
        self.assert_ok(self.run_cli())
        requests = self.ingest.snapshot_requests()
        self.assertEqual(len(requests), 1)
        self.assertEqual(
            [item["sample_id"] for item in requests[0]["payload"]["quota_observations"]],
            ["agy-after-other"],
        )
        state = self.read_state()
        self.assertEqual(state["cursor_rowid"], 2)
        self.assertEqual(state["cursor_sample_id"], "agy-after-other")

    def test_cursor_resets_when_the_centre_database_is_rebuilt(self) -> None:
        self.add_sample(
            sample_id="old-sample",
            provider="agy",
            account="personal",
            windows=(window(group_name="Gemini", bucket_id="weekly"),),
        )
        self.assert_ok(self.run_cli())
        self.assertEqual(len(self.observations_by_id()), 1)
        self.assertEqual(self.read_state()["cursor_sample_id"], "old-sample")

        # Replace the centre database as an operator might after a restore.
        os.unlink(self.database_path)
        for suffix in ("-wal", "-shm"):
            try:
                os.unlink(self.database_path + suffix)
            except FileNotFoundError:
                pass
        connection = sqlite3.connect(self.database_path)
        connection.executescript(SCHEMA)
        connection.commit()
        connection.close()
        self.add_sample(
            sample_id="rebuilt-sample",
            provider="agy",
            account="personal",
            windows=(window(group_name="Gemini", bucket_id="weekly"),),
        )

        self.assert_ok(self.run_cli())
        # The old row id may still exist in the rebuilt file, so the cursor
        # identity check forces an idempotent replay instead of silently
        # resuming past the replacement data.
        self.assertEqual(
            set(self.observations_by_id()), {"old-sample", "rebuilt-sample"}
        )
        self.assertEqual(self.read_state()["cursor_sample_id"], "rebuilt-sample")

    def test_rebuilt_centre_with_lost_replay_ack_persists_cursor_reset(self) -> None:
        self.add_sample(
            sample_id="old-sample",
            provider="agy",
            account="personal",
            windows=(window(group_name="Gemini", bucket_id="weekly"),),
        )
        self.ingest.drop_next_response = True
        first = self.run_cli()
        self.assertNotEqual(first.returncode, 0)
        state = self.read_state()
        self.assertEqual(state["pending"]["batch_seq"], 1)
        self.assertEqual(state["cursor_rowid"], 0)

        # Replace the centre database while the old batch is still pending.
        os.unlink(self.database_path)
        for suffix in ("-wal", "-shm"):
            try:
                os.unlink(self.database_path + suffix)
            except FileNotFoundError:
                pass
        connection = sqlite3.connect(self.database_path)
        connection.executescript(SCHEMA)
        connection.commit()
        connection.close()
        self.add_sample(
            sample_id="new-sample",
            provider="agy",
            account="personal",
            windows=(window(group_name="Gemini", bucket_id="weekly"),),
        )

        # Request 2 is the pending retry; request 3 is the rebuilt-database
        # replay whose ACK is lost. The durable cursor reset must already be
        # persisted when that replay fails.
        self.ingest.drop_request_number = 3
        second = self.run_cli()
        self.assertNotEqual(second.returncode, 0)
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 1)
        self.assertEqual(state["pending"]["batch_seq"], 2)
        self.assertEqual(state["pending"]["cursor_rowid_after"], 1)
        self.assertEqual(state["pending"]["cursor_sample_id_after"], "new-sample")
        self.assertEqual(state["cursor_rowid"], 0)
        self.assertIsNone(state["cursor_sample_id"])

        self.assert_ok(self.run_cli())
        self.assertEqual(
            set(self.observations_by_id()), {"old-sample", "new-sample"}
        )
        state = self.read_state()
        self.assertEqual(state["batch_seq"], 2)
        self.assertEqual(state["cursor_rowid"], 1)
        self.assertEqual(state["cursor_sample_id"], "new-sample")
        self.assertIsNone(state["pending"])


if __name__ == "__main__":
    unittest.main()
