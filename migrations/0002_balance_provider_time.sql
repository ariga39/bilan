CREATE INDEX idx_balance_provider_time
  ON balance_snapshots (provider, sampled_at);
