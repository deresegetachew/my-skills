// The Messaging port (decision 0003, #376): how the roles send the factory's messages and read what is new. GitHub
// comments are one transport (adapters/github), memory another (adapters/memory, for tests); NATS (#373) is next.
// Its contract is tests/contracts/messaging.ts, and every adapter passes it.
import type { Message } from "../domain/message.ts";

/** Where a read stopped. Opaque: only the adapter that gave it reads it. */
export type Cursor = string;

/** What a read is kept to: one issue or PR (7, #7, issue#7 or pr#7). */
export interface Scope {
  ref?: string;
}

export interface Read {
  messages: Message[]; // in the order they were said; each id once; `thread` says where each was read
  cursor: Cursor; // pass it to the next read to get only what came after
}

export interface Messaging {
  /** Post `m` with `text` under it, in the thread its `ref` names. Refuses (`needs-ref`) a message with no ref. */
  send(m: Message, text: string): Message;
  /** The messages said after `cursor` (everything when null), kept to `scope`. A message read once is not read again
   * after the cursor this read gives. Refuses (`bad-cursor`) a cursor it did not give. */
  read(cursor: Cursor | null, scope?: Scope): Read;
  /** Mark a message read or sent here as handled. Refuses (`unknown-message`) an id it never saw. */
  ack(id: string): void;
}

// --- leases and wake-ups (decision 0003's leases; decision 0004 points 1 and 6; #410-#412) ---------------------------
// Only a transport with a real compare-and-set has them (NATS). On GitHub a claim is a comment marker and a wake-up is
// the next poll, so the GitHub adapter has neither: a role that gets none goes on as it always did.

/** What a claim gave: whether the caller holds it now, and who does. */
export interface ClaimResult {
  held: boolean;
  holder: string;
}

export interface Leases {
  /** Take claim `key` for `holder` for `ttl` seconds if nobody holds it (or it ran out), or say who does. Taking it again
   * refreshes it. */
  claim(key: string, holder: string, ttl: number): ClaimResult;
  /** Give it back; false (nothing changes) when `holder` doesn't hold it. */
  release(key: string, holder: string): boolean;
  /** Who holds it now: "" for nobody. */
  holder(key: string): string;
  /** Free it whoever holds it; false when nobody did. */
  drop(key: string): boolean;
}

/** A wake-up: "something changed, look". `to` is an agent, a role's address (dev-manager, po, coding-agent) or all. */
export interface Wake {
  from: string;
  to: string;
  ref: string; // issue#<n> or pr#<n>, or "" when it is about no one thing
  why: string;
  at?: string;
}

/** The wakes addressed to one of `names`, said since `since` (ms since the epoch) by anyone but names[0] (the waiter). */
export interface WakeWait {
  names: string[];
  since: number;
  seconds: number;
}

export interface Wakes {
  wake(w: Wake): void;
  /** The first such wake, waiting up to `seconds` for one; null when none came. */
  waitWake(w: WakeWait): Wake | null;
}

// --- pull requests and CI over NATS (the `pr` kind) -----------------------------------------------------------------
// One watcher per project reads GitHub (hooks/factory_pr_feed.ts) and keeps what it saw here: a snapshot of the open
// pull requests, and one event per change. GitHub stays the record; this only says what changed, so a reader need not
// ask. Only a transport with a store has it (NATS); on GitHub every reader asks GitHub, as it always did.

/** An open pull request as the watcher last saw it. `runs` and `statuses` are its head's check runs and commit
 * statuses, cut to the fields the readers judge CI by. */
export interface PrState {
  number: number;
  title: string;
  body: string;
  author: string;
  draft: boolean;
  branch: string;
  base: string;
  headRepo: string;
  head: string;
  headAt: string | null; // the head commit's committer date
  labels: string[];
  updated: string; // the pull request's updated_at
  mergeable: string; // mergeable_state, "" when GitHub hasn't worked it out
  checks: string; // the dev manager's CI verdict (factory_ci_judge.ts): green, pending, failed or none
  runs: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
}

/** What the watcher saw at `at` (ms since the epoch): the open pull requests, and the latest closed ones. */
export interface PrSnapshot {
  v: 1;
  at: number;
  by: string; // the watcher
  login: string; // the account it reads as (D9: every role's)
  repo: string; // owner/name
  prs: PrState[];
  closed: { number: number; merged: boolean; at: string }[];
}

/** One change to one pull request: opened, head, checks, labels, draft, merged or closed. */
export interface PrEvent {
  pr: number;
  change: string;
  from: string;
  head: string;
  checks: string;
  labels: string[];
  at: string;
}

/** The events said since `since` (ms), about pull request `pr` when given, waiting up to `seconds` for them: all that
 * came in that time, or (`first`) the first one only. */
export interface PrWait {
  since: number;
  seconds: number;
  pr?: number;
  first?: boolean;
}

export interface PrFeed {
  /** Keep `snapshot` as the project's current one and publish `events`. */
  putPrs(snapshot: PrSnapshot, events: PrEvent[]): void;
  /** The current snapshot, or null when no watcher has written one. */
  prs(): PrSnapshot | null;
  prEvents(w: PrWait): PrEvent[];
}
