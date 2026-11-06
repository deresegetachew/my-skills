// The sign-off pages' words and shapes (#454), from web/signoff_model.ts as it is (no React): the title and steps of a test
// plan, the list's groups and tabs and its one primary row, the status words, the note a walk-through writes, and the history.
// The module is imported inside each test, so a missing file fails each test on its own.
import { expect, test } from "bun:test";
import type * as Model from "../web/signoff_model.ts";

type Mod = typeof Model;
const mod = (): Promise<Mod> => import("../web/signoff_model.ts");

interface Hist { what: string; by: string; at: string; result?: string; note?: string }
interface It {
  kind: "signoff" | "testplan"; id: string; task: string | null; text: string; confirmed: boolean; state: string; by: string; at: string;
  results: string[][]; history: Hist[];
}

function item(id: string, more: Partial<It> = {}): It {
  return { kind: "testplan", id, task: "13", text: "1. Open the link.", confirmed: false, state: "proposed", by: "mentewab",
    at: "2026-11-05T10:05:00Z", results: [], history: [], ...more };
}

const proposed = (id: string, at = "2026-11-05T10:05:00Z"): It => item(id, { at });
const confirmed = (id: string): It => item(id, { confirmed: true, state: "confirmed" });
const todo = (id: string): It => item(id, { kind: "signoff", confirmed: false, state: "open", text: "To check: Read the warning" });
const passed = (id: string): It => item(id, { confirmed: true, state: "passed", results: [["pass", "boss", "ok"]] });
const failed = (id: string): It => item(id, { confirmed: true, state: "failed", results: [["fail", "boss", "no"]] });
const blocked = (id: string): It => item(id, { confirmed: true, state: "blocked", results: [["blocked", "boss", ""]] });

test("the title: a heading, a first line, or the id made readable when the text starts with a step", async () => {
  const { titleOf } = await mod();
  expect(titleOf(item("x", { text: "# Sign in on a phone\n1. Open it." }))).toBe("Sign in on a phone");
  expect(titleOf(item("x", { text: "To check: Read the warning" }))).toBe("Read the warning");
  expect(titleOf(item("x", { text: "Check the Arabic guide\n1. Open it." }))).toBe("Check the Arabic guide");
  expect(titleOf(item("login-flow", { text: "1. Open the link.\n2. Tap Start." }))).toBe("Login flow");
  expect(titleOf(item("login-flow", { text: "2) Open the link." }))).toBe("Login flow");
});

test("the steps: numbered lines, what you should see, continuation lines, and what is not a step", async () => {
  const { stepsOf } = await mod();
  const text = [
    "Check the sign in", "1. Open the link.", "   You should see: the login page", "2) Tap Start", "   on the phone",
    "   expected: a spinner", "3. Wait", "EXPECT: a message", "Passes when both work.",
  ].join("\n");
  expect(stepsOf(text)).toEqual([
    { n: 1, text: "Open the link.", expect: "the login page" },
    { n: 2, text: "Tap Start on the phone", expect: "a spinner" },
    { n: 3, text: "Wait", expect: "a message" },
  ]);
  expect(stepsOf("1. One\n2. Two")).toEqual([{ n: 1, text: "One", expect: "" }, { n: 2, text: "Two", expect: "" }]);
  expect(stepsOf("1. Look\n   Expected: it shows")[0]?.expect).toBe("it shows");
  expect(stepsOf("Just read the warning.")).toEqual([]);
  expect(stepsOf("Passes when it works.")).toEqual([]);
});

test("passes when: the whole line, or nothing", async () => {
  const { passWhen } = await mod();
  expect(passWhen("1. Open it.\nPasses when the page shows your name.\n")).toBe("Passes when the page shows your name.");
  expect(passWhen("1. Open it.")).toBeNull();
});

test("a group per state: proposed, ready to test, or a result", async () => {
  const { groupOf } = await mod();
  expect(groupOf(proposed("a"))).toBe("proposed");
  expect(groupOf(confirmed("a"))).toBe("ready");
  expect(groupOf(todo("a"))).toBe("ready");
  expect(groupOf(passed("a"))).toBe("results");
  expect(groupOf(failed("a"))).toBe("results");
  expect(groupOf(blocked("a"))).toBe("results");
});

test("the status words and dots", async () => {
  const { statusOf } = await mod();
  expect(statusOf(proposed("a"))).toEqual({ text: "Waiting for you", dot: "waiting" });
  expect(statusOf(confirmed("a"))).toEqual({ text: "Confirmed", dot: "idle" });
  expect(statusOf(todo("a"))).toEqual({ text: "To check", dot: "idle" });
  expect(statusOf(passed("a"))).toEqual({ text: "Passed", dot: "working" });
  expect(statusOf(failed("a"))).toEqual({ text: "Failed", dot: "down" });
  expect(statusOf(blocked("a"))).toEqual({ text: "Blocked", dot: "waiting" });
});

const NOW = new Date(2026, 10, 6, 12, 0);

test("the list: tabs with counts, groups in order, and one primary row for the oldest proposed plan", async () => {
  const { listOf } = await mod();
  const l = listOf([passed("p3"), proposed("new", "2026-11-05T12:00:00Z"), todo("t1"), proposed("old", "2026-11-04T08:00:00Z"), confirmed("c1")], NOW);
  expect(l.tabs).toEqual([{ id: "all", label: "All", count: 5 }, { id: "waiting", label: "Waiting for you", count: 2 },
    { id: "ready", label: "Ready to test", count: 2 }, { id: "results", label: "Results", count: 1 }]);
  expect(l.groups.map((g) => g.id)).toEqual(["proposed", "ready", "results"]);
  const rows = l.groups.flatMap((g) => g.rows);
  const primary = rows.filter((r) => r.primary);
  expect(primary.length).toBe(1);
  expect(primary[0]?.id).toBe("old");
  expect(primary[0]?.status.dot).toBe("red");
  expect(rows.filter((r) => r.status.dot === "red").length).toBe(1);
  const byId = (id: string) => rows.find((r) => r.id === id);
  expect(byId("old")?.action).toBe("Review plan");
  expect(byId("new")?.action).toBe("Review plan");
  expect(byId("new")?.primary).toBe(false);
  expect(byId("c1")?.action).toBe("Record result");
  expect(byId("t1")?.action).toBe("Record result");
  expect(byId("p3")?.action).toBe("Open");
  expect(byId("t1")?.title).toBe("Read the warning");
  expect(byId("c1")?.title).toBe("C1");
  expect(byId("p3")?.status).toEqual({ text: "Passed", dot: "working" });
  expect(l.groups.find((g) => g.id === "ready")?.rows.map((r) => r.id).sort()).toEqual(["c1", "t1"]);
});

test("the list: no proposed plan means no primary row and no empty group", async () => {
  const { listOf } = await mod();
  const l = listOf([todo("t1"), confirmed("c1"), failed("f1")], NOW);
  expect(l.groups.map((g) => g.id)).toEqual(["ready", "results"]);
  expect(l.groups.flatMap((g) => g.rows).filter((r) => r.primary).length).toBe(0);
  expect(l.groups.flatMap((g) => g.rows).filter((r) => r.status.dot === "red").length).toBe(0);
});

test("the list's line says how many items and how many plans wait", async () => {
  const { listOf } = await mod();
  expect(listOf([proposed("a"), confirmed("b"), todo("c"), passed("d")], NOW).line)
    .toBe("What only a person can check. 4 items; 1 plan is waiting for you.");
  expect(listOf([proposed("a"), proposed("b"), confirmed("b2")], NOW).line)
    .toBe("What only a person can check. 3 items; 2 plans are waiting for you.");
  expect(listOf([confirmed("b"), todo("c"), passed("d")], NOW).line).toBe("What only a person can check. 3 items.");
  expect(listOf([], NOW).line).toBe("What only a person can check. Nothing yet.");
  expect(listOf([], NOW).groups).toEqual([]);
});

test("a tab keeps only its groups", async () => {
  const { filterGroups, listOf } = await mod();
  const l = listOf([proposed("a"), confirmed("b"), passed("c")], NOW);
  expect(filterGroups(l, "all").map((g) => g.id)).toEqual(["proposed", "ready", "results"]);
  expect(filterGroups(l, "waiting").map((g) => g.id)).toEqual(["proposed"]);
  expect(filterGroups(l, "ready").map((g) => g.id)).toEqual(["ready"]);
  expect(filterGroups(l, "results").map((g) => g.id)).toEqual(["results"]);
});

test("the note a walk-through writes, step by step, then the owner's own words", async () => {
  const { noteOf } = await mod();
  const steps = [{ n: 1, text: "Open", expect: "" }, { n: 2, text: "Tap", expect: "" }, { n: 3, text: "Wait", expect: "" }];
  expect(noteOf(steps, [{ result: "pass", note: "fine" }, { result: "fail", note: "no inbox" }, { result: "pass", note: "" }], "  Also slow.  "))
    .toBe("Step 1 passed: fine\nStep 2 failed: no inbox\nStep 3 passed\nAlso slow.");
  expect(noteOf(steps, [{ result: null, note: "" }, { result: "pass", note: "" }, { result: null, note: "" }], "")).toBe("Step 2 passed");
  expect(noteOf(steps, [{ result: null, note: "" }, { result: null, note: "" }, { result: null, note: "" }], "")).toBe("");
  expect(noteOf(steps, [{ result: null, note: "" }, { result: null, note: "" }, { result: null, note: "" }], "Only this")).toBe("Only this");
});

test("the outcome: any failed step fails it, all passed passes it, otherwise none yet", async () => {
  const { outcomeOf } = await mod();
  const m = (...r: ("pass" | "fail" | null)[]) => r.map((result) => ({ result, note: "" }));
  expect(outcomeOf(m("pass", "fail", null))).toBe("fail");
  expect(outcomeOf(m("pass", "pass"))).toBe("pass");
  expect(outcomeOf(m("pass", null))).toBeNull();
  expect(outcomeOf(m(null, null))).toBeNull();
});

test("when: today, yesterday, or the date", async () => {
  const { whenText } = await mod();
  expect(whenText(new Date(2026, 10, 6, 10, 5).toISOString(), NOW)).toBe("Today 10:05");
  expect(whenText(new Date(2026, 10, 5, 18, 0).toISOString(), NOW)).toBe("Yesterday 18:00");
  expect(whenText(new Date(2026, 10, 3, 9, 0).toISOString(), NOW)).toBe("3 Nov");
  expect(whenText("", NOW)).toBe("");
});

test("the history: newest first, in the person's words", async () => {
  const { historyOf, whenText } = await mod();
  const t = (d: number, h: number, m = 0): string => new Date(2026, 10, d, h, m).toISOString();
  const plan = item("login-flow", { text: "1. a\n2. b\n3. c\n4. d", confirmed: true, state: "failed", history: [
    { what: "proposed", by: "mentewab", at: t(4, 9) },
    { what: "confirmed", by: "boss", at: t(5, 18) },
    { what: "result", by: "boss", at: t(6, 10, 5), result: "fail", note: "Step 2 failed\nsecond line" },
  ] });
  expect(historyOf(plan, NOW)).toEqual([
    { text: "boss recorded failed: Step 2 failed", when: whenText(t(6, 10, 5), NOW) },
    { text: "boss confirmed the plan", when: whenText(t(5, 18), NOW) },
    { text: "mentewab proposed the plan, 4 steps", when: whenText(t(4, 9), NOW) },
  ]);
  const added = item("x", { kind: "signoff", text: "To check: it", history: [{ what: "added", by: "boss", at: t(6, 9) }] });
  expect(historyOf(added, NOW)[0]?.text).toBe("boss added it");
  const noSteps = item("y", { text: "Read it", history: [{ what: "proposed", by: "mentewab", at: t(6, 9) }] });
  expect(historyOf(noSteps, NOW)[0]?.text).toBe("mentewab proposed the plan");
  const passedNoNote = item("z", { history: [{ what: "result", by: "boss", at: t(6, 9), result: "pass", note: "" }] });
  expect(historyOf(passedNoNote, NOW)[0]?.text).toBe("boss recorded passed");
  const blockedOne = item("w", { history: [{ what: "result", by: "boss", at: t(6, 9), result: "blocked", note: "No device" }] });
  expect(historyOf(blockedOne, NOW)[0]?.text).toBe("boss recorded blocked: No device");
});
