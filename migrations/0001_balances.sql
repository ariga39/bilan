CREATE TABLE producers (
  producer_id               TEXT PRIMARY KEY,
  mode                      TEXT NOT NULL,
  display_name              TEXT NOT NULL,
  scopes_json               TEXT NOT NULL,
  expected_interval_seconds INTEGER NOT NULL DEFAULT 3600,
  last_batch_seq            INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at         TEXT,
  last_attempt_at           TEXT,
  last_status               TEXT,
  last_error                TEXT,
  updated_at                TEXT NOT NULL
);

CREATE TABLE balance_snapshots (
  producer_id       TEXT NOT NULL,
  provider          TEXT NOT NULL,
  account           TEXT NOT NULL DEFAULT 'default',
  currency          TEXT NOT NULL,
  sampled_at        TEXT NOT NULL,

  total_balance     REAL,
  topped_up_balance REAL,
  granted_balance   REAL,
  cumulative_usage  REAL,
  credit_limit      REAL,
  is_available      INTEGER,
  ingested_at       TEXT NOT NULL,

  PRIMARY KEY (producer_id, provider, account, currency, sampled_at)
);

CREATE INDEX idx_balance_latest
  ON balance_snapshots (provider, account, currency, sampled_at DESC);
