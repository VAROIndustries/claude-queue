-- Claude Queue: one row per Claude Code session.
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,   -- Claude Code session_id
  project         TEXT NOT NULL DEFAULT '',
  cwd             TEXT NOT NULL DEFAULT '',
  host            TEXT NOT NULL DEFAULT '',
  remote          INTEGER NOT NULL DEFAULT 0,  -- 1 = cloud session
  state           TEXT NOT NULL DEFAULT 'working', -- working | waiting
  kind            TEXT NOT NULL DEFAULT '',    -- permission | question | done (when waiting)
  summary         TEXT NOT NULL DEFAULT '',
  link            TEXT NOT NULL DEFAULT '',
  waiting_since   INTEGER,                     -- ms epoch
  updated         INTEGER NOT NULL,            -- ms epoch
  snoozed_until   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated);
