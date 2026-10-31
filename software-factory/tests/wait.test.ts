// Token-free waits: factory wait ci|answer|slot|ready and the dev manager's precheck.
//
// `gh` is a fake on PATH reading a JSON file; each call may also advance the world ("steps": a list of db patches applied
// one per call to the pulls route), so a wait can see CI go from running to green. Sleeps are 0 seconds.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { A, pr, Q, run, SF, wait, world } from "./wait_support.ts";
import { HOOKS, sh } from "./support.ts";

const FACTORY = join(SF, "factory");

test("ci waits for running checks then reports green", () => {
  const [d, env] = world({ pulls: { "7": pr(7) }, runs: [run("a", "in_progress", null)],
    steps: [{}, {}, { runs: [run("a"), run("b", "completed", "skipped")] }] });
  const [rc, out] = wait(d, env, "ci", "7", "5");
  expect(rc, out).toBe(0);
  expect(out).toContain("CI green");
  expect(out.split("\n").length - 1).toBe(0);
});

test("ci reports the failing check in one line", () => {
  const [d, env] = world({ pulls: { "7": pr(7) }, runs: [run("lint"), run("tests", "completed", "failure")] });
  const [rc, out] = wait(d, env, "ci", "7");
  expect(rc, out).toBe(1);
  expect(out).toContain("tests");
  expect(out).not.toContain("lint");
});

test("ci that never started is not a failure of the code", () => {
  const note = { message: "The job was not started because recent account payments have failed" };
  const [d, env] = world({ pulls: { "7": pr(7) }, runs: [run("tests", "completed", "failure")], annotations: [note] });
  const [rc, out] = wait(d, env, "ci", "7");
  expect(rc, out).toBe(4);
  expect(out).toContain("didn't run");
});

test("ci times out with exit 2 and a merged pr exits 3", () => {
  let [d, env] = world({ pulls: { "7": pr(7) }, runs: [run("a", "queued", null)] });
  env.FACTORY_WAIT_START = "0.01";
  let [rc, out] = wait(d, env, "ci", "7", "0.01");
  expect(rc, out).toBe(2);
  expect(out).toContain("still running");
  [d, env] = world({ pulls: { "7": pr(7, { state: "closed", merged: true }) } });
  [rc, out] = wait(d, env, "ci", "7");
  expect(rc, out).toBe(3);
  expect(out).toContain("merged");
});

/** A run of a check at a time: GitHub keeps every run, a label event cancels the one before (#360). */
function runAt(id: number, name: string, at: string, status = "completed", conclusion: string | null = "success") {
  return { id, name, status, conclusion, started_at: `2026-10-31T10:${at}:00Z` };
}

test("ci ignores a run cancelled by a newer run of the same check", () => {
  const [d, env] = world({ pulls: { "7": pr(7) }, runs: [runAt(2, "Factory guard", "05"),
    runAt(1, "Factory guard", "01", "completed", "cancelled"), runAt(3, "tests", "02")] });
  const [rc, out] = wait(d, env, "ci", "7");
  expect(rc, out).toBe(0);
  expect(out).toContain("CI green");
});

test("ci waits for the newer run when the older one was cancelled", () => {
  const cancelled = runAt(1, "Factory guard", "01", "completed", "cancelled");
  const [d, env] = world({ pulls: { "7": pr(7) }, runs: [cancelled, runAt(2, "Factory guard", "05", "in_progress", null)],
    steps: [{}, {}, { runs: [cancelled, runAt(2, "Factory guard", "05")] }] });
  const [rc, out] = wait(d, env, "ci", "7", "5");
  expect(rc, out).toBe(0);
  expect(out).toContain("CI green");
});

test("ci judges a check by its newest run: a newer failure fails, a re-run that passed is green", () => {
  let [d, env] = world({ pulls: { "7": pr(7) }, runs: [runAt(1, "tests", "01"), runAt(2, "tests", "05", "completed", "failure")] });
  let [rc, out] = wait(d, env, "ci", "7");
  expect(rc, out).toBe(1);
  expect(out).toContain("tests");
  [d, env] = world({ pulls: { "7": pr(7) }, runs: [runAt(1, "tests", "01", "completed", "failure"), runAt(2, "tests", "05")] });
  [rc, out] = wait(d, env, "ci", "7");
  expect(rc, out).toBe(0);
  expect(out).toContain("CI green");
});

test("ci still fails on a cancelled run nothing replaced", () => {
  const [d, env] = world({ pulls: { "7": pr(7) }, runs: [runAt(1, "Factory guard", "01", "completed", "cancelled"),
    runAt(2, "tests", "05")] });
  const [rc, out] = wait(d, env, "ci", "7");
  expect(rc, out).toBe(1);
  expect(out).toContain("Factory guard");
});

test("answer returns once the question has a later answer", () => {
  const [d, env] = world({ pulls: { "7": pr(7) }, steps_comments: [{ "7": [Q] }, { "7": [Q] }, { "7": [Q, "chat", A] }] });
  const [rc, out] = wait(d, env, "answer", "7", "5");
  expect(rc, out).toBe(0);
  expect(out).toContain("answered");
});

test("answer with nothing asked says so instead of waiting", () => {
  const [d, env] = world({ pulls: { "7": pr(7) }, comments: { "7": ["hello"] } });
  const [rc, out] = wait(d, env, "answer", "7");
  expect(rc, out).toBe(1);
  expect(out).toContain("no question");
});

test("a question asked after an answer is open again", () => {
  const [d, env] = world({ pulls: { "7": pr(7) }, comments: { "7": [Q, A, Q] } });
  env.FACTORY_WAIT_START = "0.01";
  expect(wait(d, env, "answer", "7", "0.01")[0]).toBe(2);
});

function E(kw: Record<string, string>): string {
  const all: Record<string, string> = { ...kw };
  if (!("v" in all)) all.v = "1";
  return "<!-- factory-msg " + Object.entries(all).map(([k, v]) => `${k.replace(/_/g, "-")}=${v}`).join(" ") + " -->";
}

const QX = E({ id: "q1x", kind: "question", from: "haile", to: "dev-manager", state: "submitted" }) + "\nWhich?";
const AX = E({ id: "a1x", kind: "answer", from: "dev-manager", to: "haile", state: "completed", in_reply_to: "q1x" }) + "\nThis one.";

test("answer waits for the answer that names the question", () => {
  const other = E({ id: "a2x", kind: "answer", from: "dev-manager", to: "haile", state: "completed", in_reply_to: "zzz" });
  const [d, env] = world({ pulls: { "7": pr(7) }, steps_comments: [{ "7": [QX] }, { "7": [QX, other] }, { "7": [QX, other, AX] }] });
  const [rc, out] = wait(d, env, "answer", "7", "5");
  expect(rc, out).toBe(0);
  expect(out).toContain("answered");
});

test("answer keeps waiting when only someone else's question was answered", () => {
  const poQ = E({ id: "q2x", kind: "question", from: "haile", to: "po", state: "submitted" });
  const [d, env] = world({ pulls: { "7": pr(7) }, comments: { "7": [QX, poQ, AX] } });
  env.FACTORY_WAIT_START = "0.01";
  const [rc, out] = wait(d, env, "answer", "7", "0.01");
  expect(rc, out).toBe(2);
});

test("answer stops when the addressee asks for more information", () => {
  const ask = E({ id: "s1x", kind: "status", from: "dev-manager", to: "haile", state: "input-required", in_reply_to: "q1x" }) + "\nWhich one?";
  const [d, env] = world({ pulls: { "7": pr(7) }, comments: { "7": [QX, ask] } });
  const [rc, out] = wait(d, env, "answer", "7");
  expect(rc, out).toBe(0);
  expect(out).toContain("more information");
  expect(out).toContain("q1x");
});

test("a failed question counts as answered with its state in the line", () => {
  const failed = E({ id: "a1x", kind: "answer", from: "dev-manager", state: "failed", in_reply_to: "q1x" }) + "\nneeds-owner: name";
  const [d, env] = world({ pulls: { "7": pr(7) }, steps_comments: [{ "7": [QX] }, { "7": [QX, failed] }] });
  const [rc, out] = wait(d, env, "answer", "7", "5");
  expect(rc, out).toBe(0);
  expect(out).toContain("answered");
});

test("precheck lists questions for the dev manager on prs and issues but not for others", () => {
  const poQ = E({ id: "q2x", kind: "question", from: "haile", to: "po", state: "submitted" });
  let [d, env] = world({ pulls: { "7": pr(7, { sha: "abc1234def" }) },
    issues: [{ number: 21, title: "T", body: "", state: "open", comments: 1, labels: [], updated_at: "2020-01-01T00:00:00Z" }],
    comments: { "7": ["<!-- factory-approved sha=abc1234 -->", QX, poQ], "21": [QX.replace("q1x", "q3x")] } });
  const [rc, out] = wait(d, env, "precheck");
  expect(rc, out).toBe(3);
  expect(out).toContain("PR #7: question waits for an answer (q1x from haile)");
  expect(out).toContain("issue #21: question waits for an answer (q3x from haile)");
  expect(out).not.toContain("q2x");
  [d, env] = world({ pulls: { "7": pr(7, { sha: "abc1234def" }) }, comments: { "7": ["<!-- factory-approved sha=abc1234 -->", QX, AX] } });
  expect(wait(d, env, "precheck")).toEqual([0, "nothing to do"]);
});

test("precheck sees an approval in the new form", () => {
  const ok = E({ id: "p1x", kind: "approval", from: "dev-manager", state: "completed", sha: "abc1234" });
  const [d, env] = world({ pulls: { "7": pr(7, { sha: "abc1234def" }) }, comments: { "7": [ok] } });
  expect(wait(d, env, "precheck")).toEqual([0, "nothing to do"]);
});

test("slot counts only my ready prs", () => {
  const pulls = { "1": pr(1), "2": pr(2), "3": pr(3, { draft: true }), "4": pr(4, { user: "other" }) };
  let [d, env] = world({ pulls, cfg: { maxOpenPRs: 2 } });
  env.FACTORY_WAIT_START = "0.01";
  let [rc, out] = wait(d, env, "slot", "0.01");
  expect(rc, out).toBe(2);
  expect(out).toContain("#1, #2");
  [d, env] = world({ pulls, cfg: { maxOpenPRs: 3 } });
  [rc, out] = wait(d, env, "slot");
  expect(rc, out).toBe(0);
  expect(out).toContain("free");
});

function issue(n: number, labels: string[] = ["factory:ready"]): Record<string, unknown> {
  return { number: n, title: `Task ${n}`, body: "", state: "open", milestone: null, updated_at: "2020-01-01T00:00:00Z",
    labels: labels.map((l) => ({ name: l })) };
}

test("ready prints the next task once one is ready", () => {
  let [d, env] = world({ issues: [issue(3)], cfg: { tasks: { source: "issues" } } });
  expect(wait(d, env, "ready")).toEqual([0, "issue-3 Task 3"]);
  [d, env] = world({ issues: [issue(3, ["factory:in-progress"])], cfg: { tasks: { source: "issues" } } });
  env.FACTORY_WAIT_START = "0.01";
  expect(wait(d, env, "ready", "0.01")[0]).toBe(2);
});

test("precheck ends with nothing to do when everything is reviewed and answered", () => {
  const [d, env] = world({ pulls: { "7": pr(7, { sha: "abc1234def" }), "8": pr(8, { draft: true }) },
    comments: { "7": ["<!-- factory-approved sha=abc1234 -->", Q, A] } });
  expect(wait(d, env, "precheck")).toEqual([0, "nothing to do"]);
});

test("precheck lists an unreviewed commit and an open question", () => {
  const [d, env] = world({ pulls: { "7": pr(7, { sha: "bbb2222" }), "8": pr(8) },
    comments: { "7": ["<!-- factory-approved sha=abc1234 -->"], "8": ["<!-- pr-watch sha=abc1234def -->", Q] } });
  const [rc, out] = wait(d, env, "precheck");
  expect(rc, out).toBe(3);
  expect(out).toContain("PR #7: commit bbb2222 not reviewed");
  expect(out).toContain("PR #8: question waits");
  expect(out).not.toContain("PR #8: commit");
});

test("factory command routes the new waits and keeps wait pr", () => {
  const [d, env] = world({ pulls: { "7": pr(7) }, runs: [run("a")] });
  sh(["git", "init", "-q", d]);
  // the factory script runs the project's own .claude/hooks, so link the kit's into the temp project
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  let p = sh(["bash", FACTORY, "wait", "ci", "7"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("CI green");
  p = sh(["bash", FACTORY, "precheck"], { cwd: d, env });
  expect(p.code, p.out).toBe(3);
  expect(p.stdout).toContain("not reviewed");
  expect(sh(["bash", FACTORY, "help"], { cwd: d, env }).stdout).toContain("wait <pr>");
});
