// Leases and wake-ups on the message board (#500, decision 0007 point 10), the board's side of what NATS gives
// (decision 0004): a lease is the board's `lease` row (one holder per key until its time runs out), a wake-up a
// `signal.wake` event. A wait is a child that listens until a matching wake-up or its time limit. The keys and wakes are
// the project's own (`<project>:<key>`, and the project in each wake), so projects sharing a board don't meet.
import type { BoardEvent, WaitFor } from "../../../../message-board/src/index.ts";
import type { ClaimResult, Leases, Wake, WakeWait, Wakes } from "../../ports/messaging.ts";
import type { BoardChild } from "./child.ts";

export interface BoardBusOptions {
  child: BoardChild;
  /** The project's name (compose.ts's messagingProject). */
  project: string;
}

export class BoardBus implements Leases, Wakes {
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
    return this.o.child.one(process.env.FACTORY_AGENT || "factory", "dropLease", this.key(key)) as boolean;
  }

  wake(w: Wake): void {
    this.o.child.one(w.from, "signal", "wake", { project: this.o.project, from: w.from, to: w.to, ref: w.ref, why: w.why,
      at: w.at ?? new Date().toISOString() });
  }

  waitWake(w: WakeWait): Wake | null {
    const wait: WaitFor = { kind: "signal.wake", since: w.since, seconds: w.seconds, match: { project: [this.o.project], to: w.names },
      not: { from: w.names.slice(0, 1) } };
    const e = this.o.child.call(w.names[0] || "factory", [{ op: "wait", args: [wait] }], Math.max(0, w.seconds) * 1000)[0] as BoardEvent | null;
    if (!e) return null;
    const p = e.payload;
    return { from: String(p.from ?? ""), to: String(p.to ?? ""), ref: String(p.ref ?? ""), why: String(p.why ?? ""), at: String(p.at ?? "") };
  }

  private key(key: string): string {
    return `${this.o.project}:${key}`;
  }
}
