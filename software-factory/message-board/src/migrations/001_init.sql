-- factory-message-board: the first schema (decision 0007 point 10). Applied once, in one transaction, by migrate.ts.

-- Who: an agent or a person. The role is the user's own word for it (free text).
CREATE TABLE actors (
  id         text PRIMARY KEY,
  kind       text NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'person')),
  role       text NOT NULL DEFAULT '',
  seen_at    timestamptz,            -- the last claim or heartbeat: the sweep's "holder is quiet"
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_ref text UNIQUE,          -- github:owner/repo#123, used by the import
  title        text NOT NULL CHECK (title <> ''),
  body         text NOT NULL DEFAULT '',
  kind         text NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'epic', 'bug', 'decision', 'note')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'in_review', 'done', 'deferred')),
  outcome      text CHECK (outcome IN ('done', 'wont_do', 'duplicate', 'superseded')),
  priority     integer NOT NULL DEFAULT 2,
  parent_id    bigint REFERENCES tasks (id),
  created_by   text NOT NULL,
  assignee     text,                 -- set by a hand-off: only this actor may claim it
  holder       text,
  claim_token  text,
  claimed_at   timestamptz,
  claim_until  timestamptz,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((holder IS NULL) = (claim_token IS NULL)),
  CHECK (parent_id <> id)
);
CREATE INDEX tasks_parent ON tasks (parent_id);
CREATE INDEX tasks_holder ON tasks (holder) WHERE holder IS NOT NULL;
CREATE INDEX tasks_queue ON tasks (priority, created_at, id) WHERE status = 'open' AND holder IS NULL;

-- Typed dependencies: "from blocks to". Parent and child is tasks.parent_id, not an edge.
CREATE TABLE edges (
  from_id    bigint NOT NULL REFERENCES tasks (id),
  to_id      bigint NOT NULL REFERENCES tasks (id),
  kind       text NOT NULL CHECK (kind IN ('blocks', 'waits_for', 'discovered_from', 'supersedes', 'duplicates', 'related')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX edges_to ON edges (to_id);

CREATE TABLE messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     bigint REFERENCES tasks (id),
  thread_id   bigint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('question', 'answer', 'status', 'note', 'verdict', 'ask')),
  sender      text NOT NULL,
  addressee   text,
  state       text NOT NULL CHECK (state IN ('open', 'answered', 'closed')),
  in_reply_to bigint REFERENCES messages (id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread ON messages (thread_id, id);
CREATE INDEX messages_task ON messages (task_id, id);
CREATE INDEX messages_open ON messages (addressee) WHERE state = 'open';

CREATE TABLE context (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id    bigint NOT NULL REFERENCES tasks (id),
  kind       text NOT NULL CHECK (kind IN ('discovery', 'decision', 'blocker', 'result')),
  body       text NOT NULL,
  author     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_task ON context (task_id, id);

-- The record of every write. NOTIFY mb_events carries only the seq; readers re-read from their cursor.
CREATE TABLE events (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL,
  subject       text NOT NULL,
  actor         text NOT NULL,
  actor_session text,
  payload       jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now()
);

-- Blocked, computed when read: a blocks or waits_for edge points to the task, or to one of its parents at any depth,
-- from a task that isn't done. Nothing is stored that a write could forget to refresh.
CREATE VIEW task_blockers AS
WITH RECURSIVE lineage (task_id, ancestor_id) AS (
  SELECT id, id FROM tasks
  UNION
  SELECT l.task_id, t.parent_id FROM lineage l JOIN tasks t ON t.id = l.ancestor_id WHERE t.parent_id IS NOT NULL
)
SELECT DISTINCT l.task_id, e.from_id AS blocker_id
FROM lineage l
JOIN edges e ON e.to_id = l.ancestor_id AND e.kind IN ('blocks', 'waits_for')
JOIN tasks b ON b.id = e.from_id AND b.status <> 'done';

-- Ready: open, not blocked, and nobody holds it.
CREATE VIEW ready AS
SELECT t.* FROM tasks t
WHERE t.status = 'open' AND t.holder IS NULL
  AND NOT EXISTS (SELECT 1 FROM task_blockers k WHERE k.task_id = t.id);
