-- factory-message-board: waits_for points the other way from blocks (7 Nov).
-- blocks: from must be done before to can start. waits_for: from can't start until to is done, so `to` is the blocker.
-- 001 read waits_for like blocks, the opposite of its name. The edges stay as they were written; their meaning now
-- matches what the people and agents who wrote them meant. `ready` reads task_blockers, so both views are made again.
DROP VIEW ready;
DROP VIEW task_blockers;

-- Blocked, computed when read: the task, or one of its parents at any depth, has a blocker that isn't done. A blocker
-- is the from of a blocks edge into it, or the to of a waits_for edge out of it.
CREATE VIEW task_blockers AS
WITH RECURSIVE lineage (task_id, ancestor_id) AS (
  SELECT id, id FROM tasks
  UNION
  SELECT l.task_id, t.parent_id FROM lineage l JOIN tasks t ON t.id = l.ancestor_id WHERE t.parent_id IS NOT NULL
), waits (waiter_id, blocker_id) AS (
  SELECT to_id, from_id FROM edges WHERE kind = 'blocks'
  UNION
  SELECT from_id, to_id FROM edges WHERE kind = 'waits_for'
)
SELECT DISTINCT l.task_id, w.blocker_id
FROM lineage l
JOIN waits w ON w.waiter_id = l.ancestor_id
JOIN tasks b ON b.id = w.blocker_id AND b.status <> 'done';

-- Ready: a task or a bug (epics, notes and decisions aren't claimed), open, not blocked, and nobody holds it.
CREATE VIEW ready AS
SELECT t.* FROM tasks t
WHERE t.status = 'open' AND t.holder IS NULL AND t.kind IN ('task', 'bug')
  AND NOT EXISTS (SELECT 1 FROM task_blockers k WHERE k.task_id = t.id);
