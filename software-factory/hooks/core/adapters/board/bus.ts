// Leases, wake-ups and the pull request feed on the message board (#500, decision 0007 point 10): the claim, wake
// and pr kinds of messaging.kinds, with `messaging.transport` "board".
//
// - A lease is the board's `leases` row: one holder per key until its time runs out.
// - A wake-up is a `signal.wake` event; a wait is a child that listens until a matching one or its time limit.
// - The watcher's snapshot of the open pull requests is the board's value `<project>:prs`, and each change it saw a
//   `signal.pr` event, written in the same transaction. A wait with `prChanges` also ends on such an event.
// A wait sends this machine's clock with its `since`, and the board moves `since` by how far its own clock is from it
// (message-board/src/child.ts), so a machine whose clock runs fast doesn't miss a wake-up.
// Keys, values and signals carry the project (compose.ts's messagingProject), so projects sharing a board don't meet.
import type { BoardEvent, EventRule, WaitFor } from "../../../../message-board/src/index.ts";
import { CoreError } from "../../domain/error.ts";
import { NAME, REF } from "../../domain/message.ts";
import type { ClaimResult, Leases, PrEvent, PrFeed, PrSnapshot, PrWait, Wake, WakeWait, Wakes } from "../../ports/messaging.ts";
import type { BoardChild } from "./child.ts";

export interface BoardBusOptions {
  child: BoardChild;
  /** The project's name (compose.ts's messagingProject). */
  project: string;
}

export class BoardBus implements Leases, Wakes, PrFeed {
  constructor(private readonly o: BoardBusOptions) {}

  claim(key: string, holder: string, ttl: number): ClaimResult {
    return this.o.child.one(holder, "lease", this.key(key), holder, ttl) as ClaimResult;
  }

  release(key: string, holder: string): boolean {
    return this.o.child.one(holder, "unlease", this.key(key), holder) as boolean;
  }

  holder(key: string): string {
    return this.o.child.one("factory", "leaseHolder", this.key(key)) as string;
  }

  drop(key: string): boolean {
    return this.o.child.one(this.actor(), "dropLease", this.key(key)) as boolean;
  }

  wake(w: Wake): void {
    if (!NAME.test(w.from) || !NAME.test(w.to) || (w.ref && !REF.test(w.ref))) {
      throw new CoreError("bad-wake", `A wake needs a sender and an addressee (lowercase names) and an issue#<n> or pr#<n> ref, ` +
        `not from=${w.from} to=${w.to} ref=${w.ref}.`, "Report it as a bug with the command you ran.");
    }
    this.o.child.one(w.from, "signal", "wake", { project: this.o.project, from: w.from, to: w.to, ref: w.ref, why: w.why,
      at: w.at ?? new Date().toISOString() });
  }

  waitWake(w: WakeWait): Wake | null {
    const seconds = Math.max(1, Math.floor(w.seconds));
    const or: EventRule[] = w.prChanges
      ? [{ kind: "signal.pr", match: { project: [this.o.project], ...(w.prChanges.length ? { change: w.prChanges } : {}) } }]
      : [];
    const wait: WaitFor = { kind: "signal.wake", since: w.since, clock: Date.now(), seconds, match: { project: [this.o.project], to: w.names },
      not: { from: w.names.slice(0, 1) }, or };
    const e = this.o.child.call(w.names[0] || "factory", [{ op: "wait", args: [wait] }], seconds * 1000)[0] as BoardEvent | null;
    if (!e) return null;
    const p = e.payload;
    const text = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
    if (e.kind === "signal.pr") return { from: text("from"), to: w.names[0] ?? "", ref: `pr#${Number(p.pr)}`, why: `pull request ${text("change")}`, at: text("at") };
    return { from: text("from"), to: text("to"), ref: text("ref"), why: text("why"), at: text("at") };
  }

  putPrs(snapshot: PrSnapshot, events: PrEvent[]): void {
    if (!NAME.test(snapshot.by) || events.some((e) => e.from !== snapshot.by)) {
      throw new CoreError("bad-pr-event", `Pull request events need their watcher's name as the sender, not '${snapshot.by}'.`,
        "Report it as a bug with the command you ran.");
    }
    const signals = events.map((e) => ({ name: "pr", payload: { project: this.o.project, pr: e.pr, change: e.change, from: e.from,
      head: e.head, checks: e.checks, labels: e.labels, at: e.at } }));
    this.o.child.one(snapshot.by, "setValue", this.key("prs"), snapshot, signals);
  }

  prs(): PrSnapshot | null {
    const s = this.o.child.one("factory", "value", this.key("prs")) as PrSnapshot | null;
    return s && s.v === 1 && typeof s.at === "number" && Array.isArray(s.prs) && Array.isArray(s.closed) ? s : null;
  }

  prEvents(w: PrWait): PrEvent[] {
    const seconds = Math.max(1, Math.floor(w.seconds));
    const rule = { kind: "signal.pr", since: w.since, clock: Date.now(), match: { project: [this.o.project], ...(w.pr ? { pr: [String(w.pr)] } : {}) } };
    const got = w.first
      ? [this.o.child.call("factory", [{ op: "wait", args: [{ ...rule, seconds }] }], seconds * 1000)[0] as BoardEvent | null]
      : this.o.child.one("factory", "find", rule) as BoardEvent[];
    return got.filter((e): e is BoardEvent => e !== null).map((e) => {
      const p = e.payload;
      const text = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
      return { pr: Number(p.pr), change: text("change"), from: text("from"), head: text("head"), checks: text("checks"),
        labels: Array.isArray(p.labels) ? p.labels.filter((x): x is string => typeof x === "string") : [], at: text("at") };
    });
  }

  private actor(): string {
    return process.env.FACTORY_AGENT || "factory";
  }

  private key(key: string): string {
    return `${this.o.project}:${key}`;
  }
}
