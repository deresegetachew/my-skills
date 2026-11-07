// The TaskTracker port (decision 0003, #377): where the tasks are and who holds them. GitHub Issues is one tracker
// (adapters/github), the build plan another (adapters/plan), memory a third (adapters/memory, for tests); Jira or
// Linear would be more. `tasks.source` chooses (core/compose.ts). Its contract is tests/contracts/task_tracker.ts, and
// every adapter passes it. A refusal is a CoreError with {code, message, fix}.
import type { Claimant } from "../domain/claim.ts";
import type { Epic } from "../domain/epic.ts";
import type { Task } from "../domain/task.ts";

/** What a pick gave: the task (null for none), and a line to tell the person when the tracker held back. */
export interface Picked {
  task: Task | null;
  note?: string;
}

export interface NewTask {
  title: string;
  body: string;
  group?: string; // a milestone or phase
  tags?: string[]; // labels, besides ready
}

/** A ready task passed over because its PRD change hasn't merged (#578): how people call it ("#5", "b12", "1.3") and the
 * pull request it waits for. */
export interface SkippedForPrd {
  name: string;
  pr: string;
}

export interface Filed {
  id: string;
  url: string;
}

export interface TaskTracker {
  /** The open tasks (not done), in build order. */
  list(): Task[];
  /** The task as a person reads it: title, state, text and what people said about it. */
  show(id: string): string;
  /** The first ready task nobody holds whose dependencies are done and whose PRD change merged; claims nothing.
   * `skipped`, when given, hears the ready tasks passed over only for their PRD change (#578), so a caller can say why
   * without listing the tasks again. */
  next(skipped?: SkippedForPrd[]): Task | null;
  /** The agent's own in-progress task first, else the next ready one, claimed. A claim lost in a race moves on to the
   * one after. */
  pick(who: Claimant): Picked;
  /** Claim exactly this task, or refuse (`*-not-found`, `*-taken`, `*-blocked`, `*-not-ready`) and change nothing. A
   * task the agent already holds is given back as it is. */
  claim(id: string, who: Claimant): Task;
  /** Back to ready: its claim ends and its holder comes off. */
  release(id: string, reason?: string): void;
  /** Mark it in review (its pull request is open) or done; the line says what changed. */
  setState(id: string, state: "in-review" | "done"): string;
  /** Tick its `index`th todo (1-based); refuses (`no-such-todo`) one that isn't there. */
  tick(id: string, index: number): void;
  /** Blocked, saying why; ends the claim, so whoever takes it after a release wins it. */
  block(id: string, reason: string): void;
  /** The epics (open and closed), in issue-number order; trackers without them give none. */
  epics(): Epic[];
  /** A new ready task, after the others. */
  file(task: NewTask): Filed;
  /** Keep this machine's claim on `id` alive while its agent works (a heartbeat, #513): true when it moved the claim's
   * time on, false when there is nothing to keep (this tracker's claims don't run out, or this machine holds no claim on
   * it). A claim the tracker gave to someone else meanwhile is refused (`claim-lost`). */
  keep(id: string): boolean;
}
