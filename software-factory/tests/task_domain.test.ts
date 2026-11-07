// The Task and Claim rules (decision 0003, #377): plain functions, tested without any fake.
import { expect, test } from "bun:test";
import { type ClaimEvent, isMe, standing, winner } from "../hooks/core/domain/claim.ts";
import { checkClaim, dependencies, prdChangeIn, type Task, tickTodo, todos } from "../hooks/core/domain/task.ts";

const claim = (agent: string, machine: string | null = null): ClaimEvent => ({ claim: { agent, machine } });

test("the earlier claim wins a race, and a release starts over", () => {
  expect(winner([claim("taytu", "m2"), claim("haile", "m1")])).toEqual({ agent: "taytu", machine: "m2" });
  expect(winner([claim("taytu"), { release: true }, claim("haile", "m1")])).toEqual({ agent: "haile", machine: "m1" });
  expect(winner([claim("taytu"), { release: true }])).toBeNull();
  expect(standing([claim("a"), claim("b"), { release: true }, claim("c"), claim("d")]).map((c) => c.agent)).toEqual(["c", "d"]);
});

test("a claim is mine by name and machine; one with no machine by name alone", () => {
  expect(isMe({ agent: "haile", machine: "m1" }, "haile", "m1")).toBe(true);
  expect(isMe({ agent: "haile", machine: "m1" }, "haile", "m2")).toBe(false); // the same name on two machines
  expect(isMe({ agent: "haile", machine: null }, "haile", "m2")).toBe(true);
  expect(isMe({ agent: "haile", machine: "m1" }, "haile", "")).toBe(true);
  expect(isMe(null, "haile", "m1")).toBe(false);
});

test("dependencies: #12, #14 in an issue, dotted ids in a plan, and nothing else", () => {
  expect(dependencies("Depends on #14, #12 and #14", "issue")).toEqual(["12", "14"]);
  expect(dependencies("Depends on 3 things", "issue")).toEqual([]);
  expect(dependencies("Build it. Depends on 1.2, 2.1.", "plan")).toEqual(["1.2", "2.1"]);
  expect(dependencies("Depends on #12", "plan")).toEqual([]);
});

test("ticking todo 3 ticks only todo 3; a number past the last is refused", () => {
  const text = "- [ ] a\n* [ ] b\n  - [ ] c\n- [x] d";
  expect(tickTodo(text, 3, "#5")).toBe("- [ ] a\n* [ ] b\n  - [x] c\n- [x] d");
  expect(todos(tickTodo(text, 3, "#5")).map((t) => t.done)).toEqual([false, false, true, true]);
  let err: { code?: string; message?: string } = {};
  try {
    tickTodo(text, 5, "#5");
  } catch (e) {
    err = e as Error & { code: string };
  }
  expect([err.code, err.message]).toEqual(["no-such-todo", "#5 has 4 checkboxes; there is no number 5"]);
});

function task(extra: Partial<Task> = {}): Task {
  return { id: "5", title: "T", state: "ready", holders: [], dependsOn: [], todos: [], group: "", tags: [], ...extra };
}

test("only a ready task whose dependencies are done can be claimed, and in this order of reasons", () => {
  const none = (): string[] => [];
  const mine = (): boolean => true;
  expect(checkClaim(task(), "haile", mine, none)).toEqual(["free", []]);
  expect(checkClaim(task({ state: "in-progress", holders: ["haile"] }), "haile", mine, none)).toEqual(["mine", []]);
  expect(checkClaim(task({ state: "in-progress", holders: ["haile"] }), "haile", () => false, none)).toEqual(["taken", []]);
  expect(checkClaim(task({ state: "in-review" }), "haile", mine, none)).toEqual(["taken", []]);
  expect(checkClaim(task({ state: "blocked" }), "haile", mine, () => ["3"])).toEqual(["blocked", []]);
  expect(checkClaim(task(), "haile", mine, () => ["3"])).toEqual(["waiting", ["3"]]);
  expect(checkClaim(task({ state: "new" }), "haile", mine, none)).toEqual(["not-ready", []]);
});

test("a task from a PRD change waits for its pull request before its dependencies; merged, it is free (#578)", () => {
  const none = (): string[] => [];
  const mine = (): boolean => true;
  expect(checkClaim(task({ waitsForPrd: "62" }), "haile", mine, () => ["3"])).toEqual(["prd", ["62"]]);
  expect(checkClaim(task({ state: "blocked", waitsForPrd: "62" }), "haile", mine, none)).toEqual(["blocked", []]);
  expect(checkClaim(task({ state: "in-progress", holders: ["haile"], waitsForPrd: "62" }), "haile", mine, none)).toEqual(["mine", []]);
  expect(checkClaim(task(), "haile", mine, none)).toEqual(["free", []]);
});

test("the PRD change a task names: `PRD change: #62` or the pull request's link, on a line of its own (#578)", () => {
  expect(prdChangeIn("PRD: US-3\nPRD change: #62\n\nBuild it.")).toBe("62");
  expect(prdChangeIn("  - prd change: https://github.com/acme/shop/pull/62")).toBe("62");
  expect(prdChangeIn("PRD change: #62 (Shelf v1.1)")).toBe("62");
  expect(prdChangeIn("PRD: US-62\nDepends on #62")).toBeNull();
  expect(prdChangeIn("See the PRD change: #62 in the text")).toBeNull();
  expect(prdChangeIn("")).toBeNull();
});
