// The contract of the ports a coordination transport gives (decision 0004; ports/messaging.ts): Leases, Wakes and
// PrFeed. NATS gave them first; the message board (#500) gives them too (bus_board.test.ts). Not a test file: a test
// file calls busContract with a way to make a fresh port for a project of its own.
import { expect, test } from "bun:test";
import type { Leases, PrEvent, PrFeed, PrSnapshot, Wakes } from "../../hooks/core/ports/messaging.ts";

export type Bus = Leases & Wakes & PrFeed;

function refusal(f: () => unknown): { code: string; message: string; fix: string } {
  try {
    f();
  } catch (e) {
    const { code, fix } = e as { code?: unknown; fix?: unknown };
    expect(typeof code).toBe("string");
    expect(typeof fix).toBe("string");
    expect((e as Error).message).toBeTruthy();
    return { code: code as string, message: (e as Error).message, fix: fix as string };
  }
  throw new Error("expected an error with code, message and fix");
}

function snapshot(by: string, prs: number[]): PrSnapshot {
  return { v: 1, at: Date.now(), by, login: "bot", repo: "o/r", closed: [], prs: prs.map((number) => ({ number, title: `PR ${number}`,
    body: "", author: "haile", draft: false, branch: `task/${number}`, base: "main", headRepo: "o/r", head: "a".repeat(40), headAt: null,
    labels: [], updated: "2026-11-06T10:00:00Z", mergeable: "clean", checks: "pending", runs: [], statuses: [] })) };
}

function event(pr: number, change: string, from = "lead"): PrEvent {
  return { pr, change, from, head: "b".repeat(40), checks: "green", labels: ["factory:in-review"], at: new Date().toISOString() };
}

export function busContract(name: string, make: () => Bus): void {
  test(`${name} leases: one holder per key; taking it again keeps it; release by the holder; drop by anyone`, () => {
    const bus = make();
    expect(bus.claim("review.12.abcdef0", "haile@m1", 60)).toEqual({ held: true, holder: "haile@m1" });
    expect(bus.claim("review.12.abcdef0", "taytu@m2", 60)).toEqual({ held: false, holder: "haile@m1" });
    expect(bus.claim("review.12.abcdef0", "haile@m1", 60)).toEqual({ held: true, holder: "haile@m1" });
    expect(bus.holder("review.12.abcdef0")).toBe("haile@m1");
    expect(bus.release("review.12.abcdef0", "taytu@m2")).toBe(false);
    expect(bus.release("review.12.abcdef0", "haile@m1")).toBe(true);
    expect(bus.holder("review.12.abcdef0")).toBe("");
    expect(bus.drop("task.7")).toBe(false);
    bus.claim("task.7", "taytu@m2", 60);
    expect(bus.drop("task.7")).toBe(true);
    expect(bus.holder("task.7")).toBe("");
  });

  test(`${name} leases: a claim whose time ran out goes to the next claimant`, async () => {
    const bus = make();
    bus.claim("answer.99", "haile@m1", 1);
    await Bun.sleep(1500);
    expect(bus.holder("answer.99")).toBe("");
    expect(bus.claim("answer.99", "taytu@m2", 60)).toEqual({ held: true, holder: "taytu@m2" });
  });

  test(`${name} leases: another project's keys are its own`, () => {
    const a = make();
    const b = make();
    a.claim("rework.3", "haile@m1", 60);
    expect(b.holder("rework.3")).toBe("");
    expect(b.claim("rework.3", "taytu@m2", 60).held).toBe(true);
  });

  test(`${name} wakes: one said since the wait's time ends it; one for someone else, or the waiter's own, does not`, () => {
    const bus = make();
    const since = Date.now() - 1000;
    bus.wake({ from: "haile", to: "taytu", ref: "", why: "not for po" });
    bus.wake({ from: "po", to: "po", ref: "", why: "my own" });
    bus.wake({ from: "lead", to: "po", ref: "pr#4", why: "merged" });
    expect(bus.waitWake({ names: ["po", "po", "all"], since, seconds: 5 })).toMatchObject({ from: "lead", to: "po", ref: "pr#4", why: "merged" });
    const all = make();
    all.wake({ from: "lead", to: "all", ref: "issue#3", why: "new task" });
    expect(all.waitWake({ names: ["menelik", "coding-agent", "all"], since, seconds: 5 })?.why).toBe("new task");
  });

  test(`${name} wakes: none in time gives null after the wait; another project's wakes are not heard`, () => {
    const bus = make();
    const since = Date.now() - 1000;
    make().wake({ from: "lead", to: "po", ref: "", why: "elsewhere" });
    const started = Date.now();
    expect(bus.waitWake({ names: ["po", "po", "all"], since, seconds: 1 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test(`${name} wakes: with prChanges, a pull request change of those kinds wakes the waiter; others do not`, () => {
    const bus = make();
    const since = Date.now() - 1000;
    bus.putPrs(snapshot("lead", [5]), [event(5, "labels")]);
    expect(bus.waitWake({ names: ["menelik", "coding-agent", "all"], since, seconds: 1, prChanges: ["merged", "closed"] })).toBeNull();
    bus.putPrs(snapshot("lead", []), [event(5, "merged")]);
    expect(bus.waitWake({ names: ["menelik", "coding-agent", "all"], since, seconds: 5, prChanges: ["merged", "closed"] }))
      .toMatchObject({ from: "lead", to: "menelik", ref: "pr#5", why: "pull request merged" });
    expect(bus.waitWake({ names: ["lead", "dev-manager", "all"], since, seconds: 5, prChanges: [] })?.why).toBe("pull request labels");
  });

  test(`${name} pull requests: no snapshot until a watcher writes one; the last one written is the one read`, () => {
    const bus = make();
    expect(bus.prs()).toBeNull();
    bus.putPrs(snapshot("lead", [5, 6]), []);
    bus.putPrs(snapshot("lead", [6]), []);
    expect(bus.prs()?.prs.map((p) => p.number)).toEqual([6]);
    expect(bus.prs()).toMatchObject({ v: 1, by: "lead", repo: "o/r" });
    expect(make().prs()).toBeNull(); // another project's
  });

  test(`${name} pull requests: the events since a time, in order, one pull request's, or the first only`, () => {
    const bus = make();
    const since = Date.now() - 1000;
    bus.putPrs(snapshot("lead", [5, 6]), [event(5, "opened"), event(6, "head")]);
    bus.putPrs(snapshot("lead", [5, 6]), [event(5, "checks")]);
    expect(bus.prEvents({ since, seconds: 2 }).map((e) => [e.pr, e.change, e.from])).toEqual([[5, "opened", "lead"], [6, "head", "lead"], [5, "checks", "lead"]]);
    expect(bus.prEvents({ since, seconds: 2, pr: 5 }).map((e) => e.change)).toEqual(["opened", "checks"]);
    expect(bus.prEvents({ since, seconds: 2, first: true }).map((e) => e.change)).toEqual(["opened"]);
    const one = bus.prEvents({ since, seconds: 2, pr: 6 })[0] as PrEvent;
    expect(one).toEqual({ pr: 6, change: "head", from: "lead", head: "b".repeat(40), checks: "green", labels: ["factory:in-review"], at: one.at });
    expect(bus.prEvents({ since: Date.now() + 60_000, seconds: 1 })).toEqual([]);
  });

  test(`${name} pull requests: an event whose sender isn't the watcher is refused, and nothing is written`, () => {
    const bus = make();
    const r = refusal(() => bus.putPrs(snapshot("lead", [5]), [event(5, "head", "someone-else")]));
    expect(r.code).toBe("bad-pr-event");
    expect(bus.prs()).toBeNull();
  });
}
