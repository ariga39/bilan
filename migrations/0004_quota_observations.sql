CREATE TABLE quota_observations (
  producer_id      TEXT NOT NULL,
  sample_id        TEXT NOT NULL,
  source           TEXT NOT NULL,
  account          TEXT NOT NULL DEFAULT 'default',
  observer_machine TEXT NOT NULL DEFAULT 'unknown',
  sampled_at       TEXT NOT NULL,
  interval_seconds INTEGER,
  status           TEXT NOT NULL,
  time_anomaly     TEXT,
  error_summary    TEXT,
  ingested_at      TEXT NOT NULL,
  -- Ingest coordination only: the accepted batch that created this immutable
  -- observation, so child windows are inserted only for that same batch.
  batch_seq        INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (producer_id, sample_id)
);

CREATE INDEX idx_quota_obs_latest
  ON quota_observations (source, account, sampled_at DESC);

CREATE TABLE quota_windows (
  producer_id          TEXT NOT NULL,
  sample_id            TEXT NOT NULL,
  bucket_id            TEXT NOT NULL,
  slot                 TEXT NOT NULL,
  label                TEXT,
  used_percent         REAL,
  remaining_percent    REAL,
  status               TEXT,
  resets_at            TEXT,
  window_duration_mins INTEGER,
  meta_json            TEXT,

  PRIMARY KEY (producer_id, sample_id, bucket_id, slot),
  FOREIGN KEY (producer_id, sample_id)
    REFERENCES quota_observations (producer_id, sample_id)
    ON DELETE CASCADE
);
