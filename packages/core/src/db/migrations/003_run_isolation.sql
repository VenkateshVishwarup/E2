-- Simulated conversations are real events in the same log, isolated by env.
-- DEFAULT 'live' means every row written before this migration stays live.
ALTER TABLE events ADD COLUMN env    TEXT NOT NULL DEFAULT 'live';
ALTER TABLE events ADD COLUMN run_id TEXT;

ALTER TABLE events ADD CONSTRAINT events_env_check CHECK (env IN ('live', 'sim'));

-- A live row must never carry a run_id; a sim row must always have one.
ALTER TABLE events ADD CONSTRAINT events_run_id_check
  CHECK ((env = 'live' AND run_id IS NULL) OR (env = 'sim' AND run_id IS NOT NULL));

CREATE INDEX events_env_idx ON events (tenant_id, env, occurred_at);
CREATE INDEX events_run_idx ON events (tenant_id, run_id) WHERE run_id IS NOT NULL;
