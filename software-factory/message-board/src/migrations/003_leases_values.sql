-- factory-message-board: leases and values (#500, decision 0007 point 10).
-- A lease is a named claim on anything that isn't a task (a review, an answer, a rework): one holder at a time until its
-- time runs out. Taking it again moves the time on.
CREATE TABLE leases (
  key        text PRIMARY KEY CHECK (key <> ''),
  holder     text NOT NULL CHECK (holder <> ''),
  until      timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A value is the latest of something a user keeps by name (a watcher's snapshot of the open pull requests): a write
-- replaces it whole. What changed is said as events (signals), not here.
CREATE TABLE "values" (
  key        text PRIMARY KEY CHECK (key <> ''),
  value      jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
