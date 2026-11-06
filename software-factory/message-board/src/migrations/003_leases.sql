-- factory-message-board: leases (#500, decision 0007 point 10). A lease is a named claim on anything that isn't a task
-- (a review, an answer, a rework): one holder at a time until its time runs out. Taking it again moves the time on.
CREATE TABLE leases (
  key        text PRIMARY KEY CHECK (key <> ''),
  holder     text NOT NULL CHECK (holder <> ''),
  until      timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
