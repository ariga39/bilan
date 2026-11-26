CREATE TABLE usage_buckets (
  producer_id         TEXT NOT NULL,
  source              TEXT NOT NULL,
  account             TEXT NOT NULL DEFAULT 'default',
  actor_kind          TEXT NOT NULL,
  actor_id            TEXT NOT NULL DEFAULT 'unknown',
  model               TEXT NOT NULL DEFAULT 'unknown',
  effort              TEXT NOT NULL DEFAULT '',
  bucket_start        TEXT NOT NULL,

  unit_kind           TEXT NOT NULL,
  unit_count          INTEGER NOT NULL DEFAULT 0,
  coverage_gaps       INTEGER NOT NULL DEFAULT 0,

  input_tokens        INTEGER,
  input_counted       INTEGER NOT NULL DEFAULT 0,
  cached_tokens       INTEGER,
  cached_counted      INTEGER NOT NULL DEFAULT 0,
  uncached_tokens     INTEGER,
  uncached_counted    INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER,
  cache_write_counted INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER,
  output_counted      INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER,
  reasoning_counted   INTEGER NOT NULL DEFAULT 0,

  accounting_basis    TEXT NOT NULL DEFAULT 'unknown',
  source_version      TEXT NOT NULL DEFAULT 'unknown',
  batch_seq           INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL,

  PRIMARY KEY (producer_id, source, account, actor_kind, actor_id, model, effort, bucket_start)
);

CREATE INDEX idx_usage_buckets_time
  ON usage_buckets (bucket_start, source);

CREATE INDEX idx_usage_buckets_source_time
  ON usage_buckets (source, bucket_start);
