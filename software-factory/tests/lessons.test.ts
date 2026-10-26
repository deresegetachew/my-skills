// The fixes from the 22 Oct lessons: free decision and migration numbers through the PR gate, and CI that never
// started (factory_ci.ts and the gate's message). A moved repository is in remote.test.ts; numbers on their own in
// numbers.test.ts; the claims and issues lessons in claims_lessons.test.ts.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, runGate } from "./pr_gate_support.ts";
import { runHook, sh, tmp, write, writeExe } from "./support.ts";

// Answers by path (without "repos/{owner}/{repo}/" and the query): "text" for calls with --jq (the text gh would
// print after the jq filter), "json" for the others. Unknown paths fail, like a broken gh.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const dbPath = process.env.FAKE_GH_DB as string;
const db = JSON.parse(readFileSync(dbPath, "utf8"));
const a = process.argv.slice(2);
appendFileSync(dbPath + ".log", a.join(" ") + "\n");
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] === "pr" && a[1] === "list") { console.log(JSON.stringify(db.open_prs ?? [])); process.exit(0); }
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); } // the default branch, as GitHub has it
if (a[0] === "api" && a.join(" ").includes("contents/.claude/factory.json")) { // main's settings, as GitHub has them
  const r = Bun.spawnSync(["git", "show", "origin/main:.claude/factory.json"]);
  if (r.exitCode !== 0) fail("gh: Not Found (HTTP 404)");
  process.stdout.write(r.stdout.toString() + "\n"); process.exit(0);
}
if (a[0] !== "api") fail("fake gh: no answer for " + a.join(" "));
const rest = a.slice(1); let path = "";
for (let k = 0; k < rest.length;) { // the first word that isn't a flag or a flag's value
  const w = rest[k] as string;
  if (["-X", "-H", "--jq", "-f", "-F", "--input"].includes(w)) k += 2;
  else if (w.startsWith("-")) k += 1;
  else { path = w; break; }
}
const p = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (a.includes("--jq") && p in (db.text ?? {})) { console.log(db.text[p]); process.exit(0); }
if (p in (db.json ?? {})) { console.log(JSON.stringify(db.json[p])); process.exit(0); }
if (p.startsWith("commits/") && p.endsWith("/status")) { // GitHub's answer for a commit with no statuses
  console.log(JSON.stringify({ total_count: 0, statuses: [] })); process.exit(0);
}
fail("fake gh: no answer for " + p);
`;

function git(d: string, ...a: string[]): string {
  const p = sh(["git", ...a], { cwd: d });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
  return p.stdout.trim();
}

/** A clone with origin/main holding `mainFiles` and branch task/1-x adding `branchFiles`, plus a fake gh. */
function project(mainFiles: string[], branchFiles: string[], cfg: Record<string, unknown> = {}): [string, string, Env] {
  const root = tmp();
  const origin = join(root, "origin.git");
  const d = join(root, "work");
  sh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  sh(["git", "clone", "-q", origin, d]);
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ reviewMarkers: "tmp/reviews", protected: [], alwaysAllowed: [],
    maxOpenPRs: 3, ...cfg }));
  const files = (list: string[]): void => list.forEach((f) => write(join(d, f), f));
  files([...mainFiles, "README.md"]);
  git(d, "add", "-A"); git(d, "commit", "-qm", "main"); git(d, "push", "-q", "origin", "HEAD:main");
  git(d, "checkout", "-qb", "task/1-x");
  files(branchFiles);
  git(d, "add", "-A"); git(d, "commit", "-q", "--allow-empty", "-m", "task"); git(d, "fetch", "-q", "origin");
  write(join(d, "tmp", "reviews", "task_1-x.ok"), git(d, "rev-parse", "HEAD"));
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  const db = join(root, "db.json");
  writeFileSync(db, JSON.stringify({ text: { pulls: "" } }));
  const env: Env = { ...process.env, PATH: `${root}/bin:${process.env.PATH ?? ""}`, FAKE_GH_DB: db };
  delete env.FACTORY_AGENT;
  delete env.CLAUDE_PROJECT_DIR;
  return [d, db, env];
}

type Db = Record<string, unknown>;

function answers(db: string, kw: Db): void {
  const data = JSON.parse(readFileSync(db, "utf8")) as Db;
  for (const [k, v] of Object.entries(kw)) {
    if (v && typeof v === "object" && !Array.isArray(v)) data[k] = { ...((data[k] as Db | undefined) ?? {}), ...(v as Db) };
    else data[k] = v;
  }
  writeFileSync(db, JSON.stringify(data));
}

const gate = (d: string, env: Env, command: string): [number, string] => runGate(d, env, command);

const CREATE = "gh pr create --title x --body 'Closes #1'";

// --- numbers -------------------------------------------------------------------------------------------------

test("a free decision number opens the pr", () => {
  const [d, , env] = project(["docs/decisions/0001-a.md", "docs/decisions/0002-b.md"], ["docs/decisions/0003-c.md"]);
  expect(gate(d, env, CREATE)).toEqual([0, ""]);
});

test("a number main already has is refused with the next free one", () => {
  const [d, , env] = project(["docs/decisions/0001-a.md", "docs/decisions/0002-b.md"], ["docs/decisions/0002-c.md"]);
  const [rc, err] = gate(d, env, CREATE);
  expect(rc, err).toBe(2);
  for (const w of ["0002-c.md uses number 0002", "on main", "Rename it to 0003"]) expect(err).toContain(w);
});

test("a number another open pr took is refused", () => {
  const [d, db, env] = project(["docs/decisions/0041-a.md"], ["docs/decisions/0042-demo-guides.md"]);
  answers(db, { text: { pulls: "127\ttask/3-3-reader\n145\ttask/106-home-page",
    "pulls/127/files": "docs/decisions/0042-reader.md\napps/x.ts", "pulls/145/files": "docs/decisions/0045-home-page.md" } });
  const [rc, err] = gate(d, env, CREATE);
  expect(rc, err).toBe(2);
  expect(err).toContain("0042-reader.md in #127");
  expect(err).toContain("Rename it to 0046");
});

test("a draft skips the number check", () => {
  const [d, , env] = project(["docs/decisions/0001-a.md"], ["docs/decisions/0001-b.md"]);
  expect(gate(d, env, CREATE + " --draft")[0]).toBe(0);
});

test("the number check fails closed when github cant be read", () => {
  const [d, db, env] = project([], ["docs/decisions/0001-b.md"]);
  answers(db, { text: {}, json: {} });
  writeFileSync(db, JSON.stringify({}));
  const [rc, err] = gate(d, env, CREATE);
  expect(rc, err).toBe(2);
  expect(err).toContain("Could not check the decision and migration numbers");
});

// --- CI that never started -----------------------------------------------------------------------------------

const BILLING = "The job was not started because recent account payments have failed or your spending limit needs to be " +
  "increased. Please check the 'Billing & plans' section in your settings";

function ci(env: Env, sha = "abc"): [number, string] {
  const p = runHook("factory_ci", [sha], { env });
  return [p.code, p.stdout];
}

const FAILED_TWICE = { check_runs: [{ id: 1, conclusion: "failure" }, { id: 2, conclusion: "failure" }] };

test("ci that never started is told apart from a failure", () => {
  const [, db, env] = project([], []);
  answers(db, { json: { "commits/abc/check-runs": FAILED_TWICE, "check-runs/1/annotations": [{ message: BILLING }],
    "check-runs/2/annotations": [{ message: BILLING }] } });
  const [rc, out] = ci(env);
  expect(rc, out).toBe(3);
  expect(out).toContain("isn't a result about your code");
  expect(out).toContain("spending limit");
});

test("one real failure is a failure even next to billing", () => {
  const [, db, env] = project([], []);
  answers(db, { json: { "commits/abc/check-runs": FAILED_TWICE, "check-runs/1/annotations": [{ message: BILLING }],
    "check-runs/2/annotations": [{ message: "billing.test.ts: expected 3, got 4" }] } });
  expect(ci(env)).toEqual([0, ""]);
});

test("the gate explains a merge blocked by ci that never ran", () => {
  const [d, db, env] = project([], []);
  const head = git(d, "rev-parse", "HEAD");
  const pr = { number: 7, headRefName: "task/1-x", headRefOid: head, comments: [], labels: [] };
  const fake = join(dirname(db), "bin", "gh");
  const src = readFileSync(fake, "utf8").replace('if (a[0] !== "api") fail(', `if (a[0] === "pr" && a[1] === "view") { console.log(JSON.stringify(db.pr)); process.exit(0); }
if (a[0] === "pr" && a[1] === "checks") process.exit(1);
if (a[0] !== "api") fail(`);
  expect(src).toContain('a[1] === "checks"');
  writeFileSync(fake, src);
  answers(db, { pr, text: { "pulls/7/files": "src/a.ts" },
    json: { [`commits/${head}/check-runs`]: { check_runs: [{ id: 1, conclusion: "failure" }] },
      "check-runs/1/annotations": [{ message: BILLING }] } });
  const [rc, err] = gate(d, env, `gh pr merge 7 --squash --match-head-commit ${head}`);
  expect(rc, err).toBe(2);
  expect(err).toContain("CI didn't run on this commit");
});

test("a timed out job next to billing is a real result", () => {
  const [, db, env] = project([], []);
  answers(db, { json: { "commits/abc/check-runs": { total_count: 2, check_runs: [{ id: 1, conclusion: "failure" }, { id: 2, conclusion: "timed_out" }] },
    "check-runs/1/annotations": [{ message: BILLING }], "check-runs/2/annotations": [] } });
  expect(ci(env)).toEqual([0, ""]);
});

test("more runs than one page is treated as a real result", () => {
  const [, db, env] = project([], []);
  answers(db, { json: { "commits/abc/check-runs": { total_count: 150, check_runs: [{ id: 1, conclusion: "failure" }] },
    "check-runs/1/annotations": [{ message: BILLING }] } });
  expect(ci(env)).toEqual([0, ""]);
});

test("a failed commit status next to billing is a real result", () => {
  const [, db, env] = project([], []);
  answers(db, { json: { "commits/abc/check-runs": { total_count: 1, check_runs: [{ id: 1, conclusion: "failure" }] },
    "check-runs/1/annotations": [{ message: BILLING }],
    "commits/abc/status": { total_count: 1, statuses: [{ state: "failure", context: "ext" }] } } });
  expect(ci(env)).toEqual([0, ""]);
  answers(db, { json: { "commits/abc/status": { total_count: 0, statuses: [] } } });
  expect(ci(env)[0]).toBe(3);
});
