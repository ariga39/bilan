#!/usr/bin/env python3
"""Create a synthetic telemetre centre SQLite database for the B5 acceptance run.

Only the columns read by ``shippers/telemetre.py`` are created. Every value is
synthetic: host aliases (``host-c``), accounts (``personal``/``work``), sample
ids, and timestamps. No live telemetre database or credential is involved.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3

SCHEMA = """
CREATE TABLE quota_samples (
    sample_id        TEXT PRIMARY KEY,
    provider         TEXT NOT NULL,
    account          TEXT NOT NULL,
    machine          TEXT NOT NULL,
    sampled_at       TEXT NOT NULL,
    received_at      TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('success', 'failure')),
    error_kind       TEXT,
    error_detail     TEXT,
    empty_windows    INTEGER NOT NULL DEFAULT 0,
    time_anomaly     INTEGER NOT NULL DEFAULT 0,
    interval_seconds INTEGER NOT NULL
);

CREATE TABLE quota_windows (
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

AGY_WINDOWS = (
    {
        "group_name": "Gemini",
        "bucket_id": "five-hour",
        "limit_id": None,
        "slot": "five-hour",
        "window_raw": "5h",
        "window_minutes": 300,
        "remaining_value": 0.42,
        "remaining_unit": "fraction",
        "remaining_display": 42.0,
        "reset_raw": "2026-12-01T05:00:00Z",
        "reset_at": "2026-12-01T05:00:00Z",
        "anomalies": [],
    },
    {
        "group_name": "Gemini",
        "bucket_id": "weekly",
        "limit_id": None,
        "slot": "weekly",
        "window_raw": "7d",
        "window_minutes": 10080,
        "remaining_value": 0.9,
        "remaining_unit": "fraction",
        "remaining_display": 90.0,
        "reset_raw": "2026-12-01T00:00:00Z",
        "reset_at": "2026-12-01T00:00:00Z",
        "anomalies": [],
    },
)

CODEX_WINDOWS = (
    {
        "group_name": "codex",
        "bucket_id": "primary",
        "limit_id": "codex",
        "slot": "primary",
        "window_raw": 10080,
        "window_minutes": 10080,
        "remaining_value": 10,
        "remaining_unit": "percent_used",
        "remaining_display": 90.0,
        "reset_raw": 1798761600,
        "reset_at": "2026-12-01T00:00:00Z",
        "anomalies": [],
    },
    {
        "group_name": "codex",
        "bucket_id": "secondary",
        "limit_id": "codex",
        "slot": "secondary",
        "window_raw": 300,
        "window_minutes": 300,
        "remaining_value": 0,
        "remaining_unit": "percent_used",
        "remaining_display": 100.0,
        "reset_raw": 1798761600,
        "reset_at": "2026-12-01T00:00:00Z",
        "anomalies": [],
    },
)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _insert_sample(
    connection: sqlite3.Connection,
    *,
    sample_id: str,
    provider: str,
    account: str,
    machine: str,
    sampled_at: str,
    interval_seconds: int,
    windows: tuple[dict[str, object], ...],
) -> None:
    connection.execute(
        """
        INSERT INTO quota_samples (
            sample_id, provider, account, machine, sampled_at, received_at,
            status, error_kind, error_detail, empty_windows, time_anomaly,
            interval_seconds
        ) VALUES (?, ?, ?, ?, ?, ?, 'success', NULL, NULL, 0, 0, ?)
        """,
        (
            sample_id,
            provider,
            account,
            machine,
            sampled_at,
            sampled_at,
            interval_seconds,
        ),
    )
    for ordinal, window in enumerate(windows):
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
                window["group_name"],
                window["bucket_id"],
                window["limit_id"],
                window["slot"],
                _json(window["window_raw"]),
                window["window_minutes"],
                window["remaining_value"],
                window["remaining_unit"],
                window["remaining_display"],
                _json(window["reset_raw"]),
                window["reset_at"],
                _json(window["anomalies"]),
            ),
        )


def build(database: str) -> None:
    if os.path.exists(database):
        os.unlink(database)
    connection = sqlite3.connect(database)
    try:
        connection.executescript(SCHEMA)
        _insert_sample(
            connection,
            sample_id="agy-sample-1",
            provider="agy",
            account="personal",
            machine="host-c",
            sampled_at="2026-11-26T14:30:00Z",
            interval_seconds=900,
            windows=AGY_WINDOWS,
        )
        _insert_sample(
            connection,
            sample_id="codex-sample-1",
            provider="codex",
            account="work",
            machine="host-c",
            sampled_at="2026-11-26T14:31:00Z",
            interval_seconds=900,
            windows=CODEX_WINDOWS,
        )
        connection.commit()
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    build(os.path.abspath(args.database))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
