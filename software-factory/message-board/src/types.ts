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
  /** An outside id (`github:owner/repo/comments/123`), set by an import; unique. */
  ref: string | null;
  /** The user's own word for what it is (free text), such as the marker a GitHub comment carried. */
  tag: string | null;
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

/** The columns a move takes a task to (#503). ready is open; blocked is open with blocking edges, or deferred. */
export const MOVE_TARGETS = ["ready", "in_progress", "in_review", "done", "deferred", "blocked"] as const;
export type MoveTarget = (typeof MOVE_TARGETS)[number];

export interface Move {
  to: MoveTarget;
  /** Why; needed when the task is held (the claim is taken back), and kept as a blocker note with blocked. */
  reason?: string;
  /** With blocked: the tasks it waits on, each linked to it with a `blocks` edge. */
  blockedBy?: number[];
  /** With done (default done). */
  outcome?: Outcome;
}

export type Next ={ next: "ready"; reason: string } | { next: "deferred"; reason: string } | { next: "review"; reason: string } | { next: "handoff"; to?: string; reason: string };

export interface NewMessage {
  task?: number | null;
  kind: MessageKind;
  tag?: string | null;
  to?: string | null;
  body: string;
  inReplyTo?: number | null;
}

// ---------- import ----------
// An import brings tasks and their threads from somewhere else (a GitHub repo, a tracker) and is safe to run twice:
// everything is keyed by its outside id (`ref`), so a second run updates what changed and adds what is new.

/** A task to bring in. `status` is where it is outside; a task held on the board keeps its own. */
export interface ImportTask {
  ref: string;
  title: string;
  body?: string;
  kind?: TaskKind;
  status: "open" | "in_review" | "deferred" | "done";
  /** For a done task (default `done`). */
  outcome?: Outcome | null;
  /** When it was made outside; it orders the ready queue as there. */
  createdAt?: Date;
  /** Its parent's ref (in the batch or on the board). null: no parent from the import, so a parent that is an imported
   * task is cleared, and one set on the board is kept. Left out: the parent is left as it is. */
  parentRef?: string | null;
  /** The refs of the tasks that block it. The `blocks` edges into it that an import made follow this list; edges made
   * on the board are kept. Left out: its edges are left as they are. */
  blockedBy?: string[];
  /** Context entries kept on it, each with its own ref. The import's entries on it that aren't listed are removed. */
  notes?: { ref: string; kind: ContextKind; body: string }[];
}

/** A message to bring in, on a task of the batch or the board. It is written as `from`, not as the importing actor. */
export interface ImportMessage {
  ref: string;
  /** The task's ref. */
  task: string;
  kind: MessageKind;
  tag?: string | null;
  from: string;
  to?: string | null;
  body: string;
  /** The ref of the message it replies to: it joins that thread, and an answer marks an open question answered.
   * Without one, it joins the task's thread. */
  inReplyTo?: string | null;
  createdAt?: Date;
}

export interface ImportBatch {
  /** Where it comes from (`github:owner/repo`): `lastImport(source)` finds the last run. */
  source: string;
  tasks: ImportTask[];
  /** In the order they were said: a reply comes after what it replies to. */
  messages: ImportMessage[];
  /** Kept with the run's event, for the next run (for example when it started and with which options). */
  options?: Record<string, unknown>;
}

export interface Tally {
  created: number;
  updated: number;
  unchanged: number;
}

export interface ImportResult {
  dryRun: boolean;
  tasks: Tally;
  edges: { added: number; removed: number };
  /** Parents set or changed. */
  parents: number;
  messages: Tally;
  notes: { created: number; updated: number; removed: number };
  /** What it left out or left as it was, and why. */
  skipped: { ref: string; why: string }[];
}
