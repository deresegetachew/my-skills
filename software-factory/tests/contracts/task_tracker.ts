// The TaskTracker port's contract (decision 0003, #377). Every adapter passes it: the in-memory one
// (task_tracker_memory.test.ts), the plan file (task_tracker_plan.test.ts) and GitHub Issues against a fake `gh`
// (task_tracker_github.test.ts). Not a test file: those files call taskTrackerContract with a way to make a port.
import { expect, test } from "bun:test";
import type { Claimant } from "../../hooks/core/domain/claim.ts";
import type { Task } from "../../hooks/core/domain/task.ts";
import type { TaskTracker } from "../../hooks/core/ports/task_tracker.ts";

/** One task to start with, in build order. `dependsOn` names earlier specs by their place in the list (0-based). */
export interface Spec {
  title?: string;
  state?: "ready" | "blocked" | "done";
  dependsOn?: number[];
  todos?: number; // that many unticked checkboxes, "todo 1" ... "todo n"
  /** It comes from a PRD change (#578): it waits for the fixture's PRD pull request, which starts open. */
  prd?: boolean;
}

/** A fresh port holding `specs`, and what the test needs to know about how this adapter names them. */
export interface Fixture {
  port: TaskTracker;
  ids: string[]; // the id of each spec, in order
  missing: string; // an id in this adapter's own form that names no task
  foreign: string; // an id in the other mode's form (a plan id for issues, an issue number for a plan)
  /** Another agent's claim lands first, before its labels or state show it: the start of a race. */
  rival(id: string, who: Claimant): void;
  /** The number of the PRD change's pull request that the `prd` specs wait for (as written after `#`). */
  prd: string;
  /** That pull request merges. */
  mergePrd(): void;
}

const haile: Claimant = { agent: "haile", machine: "m1" };
const taytu: Claimant = { agent: "taytu", machine: "m2" };
const menelik: Claimant = { agent: "menelik", machine: "m3" };

/** What a refusal carries: the {code, message, fix} every factory error has. */
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

const titled = (t: Task | null): string | null => (t ? t.title : null);

export function taskTrackerContract(name: string, make: (specs: Spec[]) => Fixture): void {
  test(`${name}: the open tasks are listed in order, with their state`, () => {
    const { port, ids } = make([{ title: "One" }, { title: "Two", state: "blocked" }, { title: "Three", state: "done" }]);
    expect(port.list().map((t) => [t.id, t.title, t.state])).toEqual([[ids[0] as string, "One", "ready"], [ids[1] as string, "Two", "blocked"]]);
  });

  test(`${name}: next shows the first ready task and claims nothing`, () => {
    const { port, ids } = make([{ title: "One" }, { title: "Two" }]);
    expect(port.next()?.id).toBe(ids[0] as string);
    expect(port.next()?.id).toBe(ids[0] as string);
    expect(port.pick(haile).task?.id).toBe(ids[0] as string);
  });

  test(`${name}: nothing ready gives no task, for next and for pick`, () => {
    const { port } = make([{ state: "done" }, { state: "blocked" }]);
    expect(port.next()).toBeNull();
    expect(port.pick(haile).task).toBeNull();
    expect(make([]).port.pick(haile).task).toBeNull();
  });

  test(`${name}: a task is claimed once`, () => {
    const { port, ids } = make([{ title: "One" }, { title: "Two" }]);
    const id = ids[0] as string;
    expect(port.claim(id, haile).id).toBe(id);
    expect(port.list().find((t) => t.id === id)?.state).toBe("in-progress");
    expect(port.list().find((t) => t.id === id)?.holders).toEqual(["haile"]);
    expect(refusal(() => port.claim(id, taytu)).code).toMatch(/-taken$/);
    expect(port.pick(taytu).task?.id).toBe(ids[1] as string);
    expect(port.next()).toBeNull();
  });

  test(`${name}: claiming a task you hold gives it back, and pick carries on with it`, () => {
    const { port, ids } = make([{ title: "One" }, { title: "Two" }]);
    const id = ids[1] as string;
    port.claim(id, haile);
    expect(port.claim(id, haile).id).toBe(id);
    expect(port.pick(haile).task?.id).toBe(id);
  });

  test(`${name}: a race goes to the earlier claim`, () => {
    const { port, ids, rival } = make([{ title: "One" }, { title: "Two" }]);
    rival(ids[0] as string, taytu);
    expect(refusal(() => port.claim(ids[0] as string, haile)).code).toMatch(/-taken$/);
    const other = make([{ title: "One" }, { title: "Two" }]);
    other.rival(other.ids[0] as string, taytu);
    expect(titled(other.port.pick(haile).task)).toBe("Two"); // lost the first, so the next one
  });

  test(`${name}: a blocked task is neither next nor picked, and claiming it is refused`, () => {
    const { port, ids } = make([{ title: "One", state: "blocked" }, { title: "Two" }]);
    expect(port.next()?.id).toBe(ids[1] as string);
    expect(port.pick(haile).task?.id).toBe(ids[1] as string);
    expect(refusal(() => port.claim(ids[0] as string, taytu)).code).toMatch(/-blocked$/);
  });

  test(`${name}: a task with an open dependency waits; a done one does not hold it back`, () => {
    const { port, ids } = make([{ title: "Done", state: "done" }, { title: "Open", state: "blocked" },
      { title: "Waits", dependsOn: [0, 1] }, { title: "Free", dependsOn: [0] }]);
    expect(port.list().find((t) => t.title === "Waits")?.dependsOn).toEqual([ids[0] as string, ids[1] as string]);
    expect(titled(port.next())).toBe("Free");
    const r = refusal(() => port.claim(ids[2] as string, haile));
    expect(r.code).toMatch(/-blocked$/);
    expect(r.message).toContain(ids[1] as string);
    expect(r.message).not.toContain(`${ids[0]},`);
  });

  test(`${name}: a dependency marked done lets the task be picked`, () => {
    const { port, ids } = make([{ title: "First" }, { title: "Second", dependsOn: [0] }]);
    port.claim(ids[0] as string, haile);
    expect(port.pick(taytu).task).toBeNull();
    port.setState(ids[0] as string, "done");
    expect(port.list().map((t) => t.id)).toEqual([ids[1] as string]);
    expect(port.pick(taytu).task?.id).toBe(ids[1] as string);
  });

  test(`${name}: a released task is ready again and another agent can claim it`, () => {
    const { port, ids } = make([{ title: "One" }]);
    const id = ids[0] as string;
    port.claim(id, haile);
    port.release(id, "the run ended");
    const t = port.list().find((x) => x.id === id);
    expect([t?.state, t?.holders]).toEqual(["ready", []]);
    expect(port.next()?.id).toBe(id);
    expect(port.claim(id, taytu).id).toBe(id);
    expect(refusal(() => port.claim(id, menelik)).code).toMatch(/-taken$/);
  });

  test(`${name}: a block says why, ends the claim, and a release makes the task ready again`, () => {
    const { port, ids } = make([{ title: "One" }]);
    const id = ids[0] as string;
    port.claim(id, haile);
    port.block(id, "needs the Stripe keys");
    expect(port.list().find((t) => t.id === id)?.state).toBe("blocked");
    expect(port.show(id)).toContain(id);
    expect(port.pick(taytu).task).toBeNull();
    port.release(id);
    expect(port.claim(id, taytu).id).toBe(id);
  });

  test(`${name}: ticking todo 3 ticks only todo 3`, () => {
    const { port, ids } = make([{ title: "One", todos: 4 }]);
    const id = ids[0] as string;
    port.tick(id, 3);
    const t = port.list().find((x) => x.id === id) as Task;
    expect(t.todos.map((x) => [x.text, x.done])).toEqual([["todo 1", false], ["todo 2", false], ["todo 3", true], ["todo 4", false]]);
    port.tick(id, 3); // ticking it again keeps it ticked
    expect((port.list().find((x) => x.id === id) as Task).todos.filter((x) => x.done)).toHaveLength(1);
  });

  test(`${name}: ticking a todo that is not there is refused with code message fix`, () => {
    const { port, ids } = make([{ title: "One", todos: 2 }]);
    const r = refusal(() => port.tick(ids[0] as string, 3));
    expect(r.code).toBe("no-such-todo");
    expect(r.message).toContain("2 checkboxes");
    expect((port.list()[0] as Task).todos.every((x) => !x.done)).toBe(true);
  });

  test(`${name}: an id that names no task, or one in the other mode's form, is refused and nothing changes`, () => {
    const { port, missing, foreign } = make([{ title: "One" }]);
    for (const id of [missing, foreign]) expect(refusal(() => port.claim(id, haile)).code).toMatch(/-not-found$/);
    expect(port.list().map((t) => t.state)).toEqual(["ready"]);
  });

  test(`${name}: in review, the task stays open and is not picked`, () => {
    const { port, ids } = make([{ title: "One" }]);
    const id = ids[0] as string;
    port.claim(id, haile);
    expect(port.setState(id, "in-review")).toContain(id);
    expect(port.pick(taytu).task).toBeNull();
    expect(port.list().map((t) => t.id)).toEqual([id]);
  });

  test(`${name}: a filed task is ready and comes after the others`, () => {
    const { port, ids } = make([{ title: "One" }]);
    const filed = port.file({ title: "Later", body: "What we're building." });
    expect(filed.id).not.toBe(ids[0] as string);
    expect(port.list().map((t) => [t.title, t.state])).toEqual([["One", "ready"], ["Later", "ready"]]);
    port.claim(ids[0] as string, haile);
    expect(port.next()?.id).toBe(filed.id);
  });

  test(`${name}: keeping a claim alive never changes who holds the task (#513)`, () => {
    const { port, ids } = make([{ title: "One" }]);
    const id = ids[0] as string;
    expect(port.keep(id)).toBe(false); // nobody holds it: nothing to keep
    port.claim(id, haile);
    port.keep(id);
    expect(port.list().map((t) => [t.id, t.state, t.holders])).toEqual([[id, "in-progress", ["haile"]]]);
    expect(port.pick(taytu).task).toBeNull();
  });

  test(`${name}: a task whose PRD change hasn't merged waits for it and says so; the merge makes it ready (#578)`, () => {
    const { port, ids, prd, mergePrd } = make([{ title: "Waits", prd: true }, { title: "Free" }]);
    const waits = (): string | undefined => port.list().find((t) => t.title === "Waits")?.waitsForPrd;
    expect(waits()).toBe(prd);
    expect(port.list().find((t) => t.title === "Free")?.waitsForPrd).toBeUndefined();
    expect(titled(port.next())).toBe("Free");
    const r = refusal(() => port.claim(ids[0] as string, haile));
    expect(r.code).toMatch(/-waits-for-prd$/);
    expect(r.message).toContain(`PR #${prd}`);
    const picked = port.pick(haile);
    expect(titled(picked.task)).toBe("Free");
    expect(picked.note).toContain(`PR #${prd}`);
    const none = port.pick(taytu);
    expect(none.task).toBeNull();
    expect(none.note).toContain(`PR #${prd}`);
    mergePrd();
    expect(waits()).toBeUndefined();
    expect(titled(port.next())).toBe("Waits");
    expect(port.claim(ids[0] as string, taytu).id).toBe(ids[0] as string);
  });

  test(`${name}: a task with no PRD change is picked as before, with no note (#578)`, () => {
    const { port, ids } = make([{ title: "One" }]);
    expect(port.list()[0]?.waitsForPrd).toBeUndefined();
    const picked = port.pick(haile);
    expect(picked.task?.id).toBe(ids[0] as string);
    expect(picked.note).toBeUndefined();
  });
}
