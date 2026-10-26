// Commands that change labels or claims say what they did (#156).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { issue, labels, loadDb, run, saveDb, setup } from "./issues_support.ts";
import { readmeAndWiki, runHook, sh, tmp, write } from "./support.ts";

function claims(): (...args: string[]) => [number, string, string] {
  const d = tmp();
  sh(["git", "init", "-q", d]);
  write(join(d, ".claude", "factory.json"), "{}");
  write(join(d, ".git", "factory", "claims.json"), JSON.stringify({ checkouts: { taytu: { agent: "taytu", pid: 1 } },
    tasks: { "issue-5": { agent: "taytu", pid: 1 } } }));
  return (...args) => {
    const p = runHook("factory_claims", ["release", ...args], { cwd: d });
    return [p.code, p.stdout.trim(), p.stderr.trim()];
  };
}

test("review prints the labels it changed", () => {
  const [d, , env] = setup([issue(1, ["factory:in-progress", "agent:menelik"])]);
  expect(run(d, env, "review", "1")).toEqual([0, "#1 is in review: added factory:in-review, removed factory:in-progress."]);
});

test("review on an issue already in review says nothing changed", () => {
  const [d, , env] = setup([issue(1, ["factory:in-review", "agent:menelik"])]);
  expect(run(d, env, "review", "1")).toEqual([0, "#1 was already in review: nothing changed."]);
});

test("release prints what it let go", () => {
  const go = claims();
  const [rc, out, err] = go("--agent", "taytu");
  expect([rc, out], err).toEqual([0, "Released taytu: the checkout and the task claim issue-5."]);
});

test("release tasks only keeps the checkout and says so", () => {
  const go = claims();
  const [rc, out, err] = go("--agent", "taytu", "--tasks-only");
  expect([rc, out], err).toEqual([0, "Released taytu: the task claim issue-5. The checkout stays."]);
});

test("release of a claim that is not there says so", () => {
  const go = claims();
  let [rc, out, err] = go("--agent", "haile");
  expect([rc, out], err).toEqual([0, "Nothing to release: haile holds no checkout or task claim."]);
  [rc, out, err] = go("--agent", "haile", "--tasks-only");
  expect([rc, out], err).toEqual([0, "Nothing to release: haile holds no task claim."]);
});

test("readme and help describe the output", () => {
  const readme = readmeAndWiki();
  expect(readme).toContain("Nothing to release"); // README should show the release output
  expect(readme).toContain("in review: added"); // README should show the review output
});

test("issues setup says what it made and makes the two review labels", () => {
  const [d, db, env] = setup([]);
  saveDb(db, { issues: [], labels: [{ name: "factory:ready", color: "0e8a16" }] });
  const [rc, out] = run(d, env, "setup");
  expect(rc, out).toBe(0);
  expect(out).toContain("created tests-reviewed");
  expect(out).toContain("created deps-reviewed");
  expect(out).toContain("already there: factory:ready");
  const made = new Set((loadDb(db).labels ?? []).map((l) => l.name));
  expect(made.has("tests-reviewed") && made.has("deps-reviewed")).toBe(true);
  const [rc2, again] = run(d, env, "setup"); // safe to run twice
  expect(rc2).toBe(0);
  expect(again).not.toContain("created");
  expect(again).toContain("already there: tests-reviewed");
});

test("give back releases a claim with no branch or pull request and says so", () => {
  // #192: the run claimed #1 and #2, built only #2, and both stayed in progress on GitHub.
  const [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:taytu"]), issue(2, ["factory:in-progress", "agent:taytu"]),
    issue(3, ["factory:in-progress", "agent:menelik"])]);
  const [rc, out] = run(d, env, "give-back", "--agent", "taytu");
  expect(rc, out).toBe(0);
  expect(out).toContain("released #1");
  expect(out).toContain("released #2");
  expect(out).not.toContain("#3");
  expect(out).not.toContain("factory issues release");
  expect([labels(db, 1), labels(db, 2)]).toEqual([["factory:ready"], ["factory:ready"]]);
  expect(labels(db, 3)).toEqual(["agent:menelik", "factory:in-progress"]); // another agent's claim is left alone
});

test("give back keeps a claim that has a pushed branch a pull request or is in review", () => {
  const [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:taytu"]), issue(2, ["factory:in-progress", "agent:taytu"]),
    issue(3, ["factory:in-review", "agent:taytu"])]);
  const state = loadDb(db);
  state.branches = [{ name: "task/1-thing", commit: { sha: "a" } }];
  state.pulls = [{ number: 9, head: { ref: "task/2-other" }, state: "open" }];
  saveDb(db, state);
  const [rc, out] = run(d, env, "give-back", "--agent", "taytu");
  expect(rc).toBe(0);
  expect(out).not.toContain("released");
  expect(out).toContain("kept #1");
  expect(out).toContain("kept #2");
  expect(labels(db, 1)).toEqual(["agent:taytu", "factory:in-progress"]);
});

test("give back with nothing held says so", () => {
  const [d, , env] = setup([issue(1)]);
  expect(run(d, env, "give-back", "--agent", "taytu")[1]).toBe("Nothing to give back: taytu holds no in-progress issue.");
});
