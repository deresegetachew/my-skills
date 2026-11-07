// What the board's writes share inside a transaction: the locks, the loop check and the event insert.
import type { SQL } from "bun";
import type { Row } from "./rows.ts";

export const GRAPH_LOCK = 4_891_008; // serialises edge and parent writes, so two of them can't close a loop together
export const EVENT_LOCK = 4_891_009; // serialises event inserts to commit order, so a reader's cursor never skips one

export interface NewEvent {
  kind: string;
  subject: string;
  payload: Record<string, unknown>;
}

/** Whether `target` is reachable from `start` by "comes before" steps: a blocks edge from→to, a waits_for edge to→from
 * (from waits for to), and parent to child (a block on a task also blocks its children). An edge or parent that adds a
 * step back from `target` to `start` would close a loop. */
export async function reaches(tx: SQL, start: number, target: number): Promise<boolean> {
  const r = (await tx.unsafe(`
    WITH RECURSIVE reach (id) AS (
      SELECT $1::bigint
      UNION
      SELECT n.id FROM reach r CROSS JOIN LATERAL (
        SELECT e.to_id AS id FROM edges e WHERE e.from_id = r.id AND e.kind = 'blocks'
        UNION ALL
        SELECT e.from_id AS id FROM edges e WHERE e.to_id = r.id AND e.kind = 'waits_for'
        UNION ALL
        SELECT c.id FROM tasks c WHERE c.parent_id = r.id
      ) n
    )
    SELECT EXISTS (SELECT 1 FROM reach WHERE id = $2::bigint) AS hit`, [start, target])) as Row[];
  return Boolean(r[0]?.hit);
}

/** Record events in the transaction, in order, and NOTIFY mb_events with each seq (sent when the transaction commits). */
export async function recordEvents(tx: SQL, actor: string, session: string | null, events: NewEvent[]): Promise<void> {
  if (!events.length) return;
  await tx`SELECT pg_advisory_xact_lock(${EVENT_LOCK})`;
  for (const e of events) {
    const ev = (await tx`INSERT INTO events (kind, subject, actor, actor_session, payload)
      VALUES (${e.kind}, ${e.subject}, ${actor}, ${session}, ${e.payload}) RETURNING seq::text AS seq`) as Row[];
    await tx`SELECT pg_notify('mb_events', ${String(ev[0]?.seq)})`;
  }
}
