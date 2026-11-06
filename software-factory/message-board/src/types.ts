// What the board holds, as its API returns it. Plain data: ids are numbers, times are Dates.

export const TASK_KINDS = ["task", "epic", "bug", "decision", "note"] as const;
export const STATUSES = ["open", "in_progress", "in_review", "done", "deferred"] as const;
export const OUTCOMES = ["done", "wont_do", "duplicate", "superseded"] as const;
export const EDGE_KINDS = ["blocks", "waits_for", "discovered_from", "supersedes", "duplicates", "related"] as const;
/** The edge kinds that block the task they point to. */
export const BLOCKING: readonly EdgeKind[] = ["blocks", "waits_for"];
export const MESSAGE_KINDS = ["question", "answer", "status", "note", "verdict", "ask"] as const;
export const CONTEXT_KINDS = ["discovery", "decision", "blocker", "result"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type ContextKind = (typeof CONTEXT_KINDS)[number];
export type MessageState = "open" | "answered" | "closed";

export interface Task {
  id: number;
  ref: string | null;
  title: string;
  body: string;
  kind: TaskKind;
  status: Status;
  outcome: Outcome | null;
  priority: number;
  parentId: number | null;
  createdBy: string;
  /** Set by a hand-off: only this actor may claim it. */
  assignee: string | null;
  holder: string | null;
  claimedAt: Date | null;
  claimUntil: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** Computed when read: a blocking edge from a task that isn't done points to it or to one of its parents. */
  blocked: boolean;
  blockedBy: number[];
}

/** A claim: the task and the token every later write by the holder names. */
export interface Claim {
  task: Task;
  token: string;
}

export interface Edge {
  from: number;
  to: number;
  kind: EdgeKind;
}

export interface Message {
  id: number;
  taskId: number | null;
  threadId: number;
  kind: MessageKind;
  from: string;
  to: string | null;
  state: MessageState;
  inReplyTo: number | null;
  body: string;
  createdAt: Date;
}

export interface ContextEntry {
  id: number;
  taskId: number;
  kind: ContextKind;
  body: string;
  author: string;
  createdAt: Date;
}

export interface BoardEvent {
  seq: number;
  kind: string;
  subject: string;
  actor: string;
  session: string | null;
  payload: Record<string, unknown>;
  at: Date;
}

/** An actor's start: what it holds (with the context its tasks bring), what is ready, what is blocked, recent events. */
export interface Prime {
  actor: string;
  holding: { task: Task; context: ContextEntry[] }[];
  ready: Task[];
  blocked: Task[];
  recent: BoardEvent[];
}

/** What waits on an actor: the tasks it holds or was handed, and the open messages addressed to it. */
export interface OnMe {
  tasks: Task[];
  messages: Message[];
}

/** What an actor asked for and where each is: the tasks it made that someone else has or had, and its open questions. */
export interface Delegated {
  tasks: Task[];
  messages: Message[];
}

export interface NewTask {
  title: string;
  body?: string;
  kind?: TaskKind;
  priority?: number;
  parentId?: number | null;
  ref?: string | null;
}

export interface TaskChanges {
  /** The version the caller read; a different one is a `conflict`. */
  version: number;
  title?: string;
  body?: string;
  kind?: TaskKind;
  priority?: number;
  parentId?: number | null;
  ref?: string | null;
  /** open, in_review or deferred; claim, release and close make the other moves. */
  status?: "open" | "in_review" | "deferred";
}

export type Next = { next: "ready"; reason: string } | { next: "deferred"; reason: string } | { next: "handoff"; to?: string; reason: string };

export interface NewMessage {
  task?: number | null;
  kind: MessageKind;
  to?: string | null;
  body: string;
  inReplyTo?: number | null;
}
