CREATE TABLE IF NOT EXISTS monitor_snapshots (
  id BIGSERIAL PRIMARY KEY,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warning', 'critical')),
  summary TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
  raw_data JSONB NOT NULL DEFAULT '{}'::JSONB,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_monitor_snapshots_check_time
ON monitor_snapshots (check_name, snapshot_at)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_monitor_snapshots_time
ON monitor_snapshots (snapshot_at)
WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_monitor_snapshots_updated_at ON monitor_snapshots;
CREATE TRIGGER set_monitor_snapshots_updated_at
BEFORE UPDATE ON monitor_snapshots
FOR EACH ROW EXECUTE FUNCTION set_updated_at();