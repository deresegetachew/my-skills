// Database rows to the API's plain objects, and the SELECT lists that produce them.
import type { BoardEvent, ContextEntry, ContextKind, Message, MessageKind, MessageState, Outcome, Status, Task, TaskKind } from "./types.ts";

export type Row = Record<string, unknown>;

/** A task's columns, with the ids of what blocks it (task_blockers, computed when read). Needs `FROM tasks t`. */
export const TASK_SELECT = `
  SELECT t.id, t.external_ref, t.title, t.body, t.kind, t.status, t.outcome, t.priority, t.parent_id, t.created_by,
         t.assignee, t.holder, t.claimed_at, t.claim_until, t.version, t.created_at, t.updated_at,
         COALESCE(kb.blockers, '{}') AS blocked_by
  FROM tasks t
  LEFT JOIN (SELECT task_id, array_agg(blocker_id::int ORDER BY blocker_id) AS blockers FROM task_blockers GROUP BY task_id) kb
    ON kb.task_id = t.id`;

export const MESSAGE_COLS = "id, external_ref, tag, task_id, thread_id, kind, sender, addressee, state, in_reply_to, body, created_at";
export const CONTEXT_COLS = "id, task_id, kind, body, author, created_at";
export const EVENT_COLS = "seq, kind, subject, actor, actor_session, payload, at";

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => String(v ?? "");
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));

function ids(v: unknown): number[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return v.replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
  return Array.from(v as ArrayLike<number | string>, Number);
}

export function toTask(r: Row): Task {
  const blockedBy = ids(r.blocked_by);
  return {
    id: num(r.id),
    ref: strOrNull(r.external_ref),
    title: str(r.title),
    body: str(r.body),
    kind: str(r.kind) as TaskKind,
    status: str(r.status) as Status,
    outcome: strOrNull(r.outcome) as Outcome | null,
    priority: num(r.priority),
    parentId: numOrNull(r.parent_id),
    createdBy: str(r.created_by),
    assignee: strOrNull(r.assignee),
    holder: strOrNull(r.holder),
    claimedAt: dateOrNull(r.claimed_at),
    claimUntil: dateOrNull(r.claim_until),
    version: num(r.version),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    blocked: blockedBy.length > 0,
    blockedBy,
  };
}

export function toMessage(r: Row): Message {
  return {
    id: num(r.id),
    ref: strOrNull(r.external_ref),
    tag: strOrNull(r.tag),
    taskId: numOrNull(r.task_id),
    threadId: num(r.thread_id),
    kind: str(r.kind) as MessageKind,
    from: str(r.sender),
    to: strOrNull(r.addressee),
    state: str(r.state) as MessageState,
    inReplyTo: numOrNull(r.in_reply_to),
    body: str(r.body),
    createdAt: date(r.created_at),
  };
}

export function toContext(r: Row): ContextEntry {
  return { id: num(r.id), taskId: num(r.task_id), kind: str(r.kind) as ContextKind, body: str(r.body), author: str(r.author), createdAt: date(r.created_at) };
}

export function toEvent(r: Row): BoardEvent {
  const p = typeof r.payload === "string" ? (JSON.parse(r.payload) as unknown) : r.payload;
  return {
    seq: num(r.seq),
    kind: str(r.kind),
    subject: str(r.subject),
    actor: str(r.actor),
    session: strOrNull(r.actor_session),
    payload: typeof p === "object" && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {},
    at: date(r.at),
  };
}
