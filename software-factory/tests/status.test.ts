// `factory status`: one read-only view of agents, pull requests, CI and tasks across machines (#64), against a fake
// `gh` that answers from a scenario and logs every call.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, SF, envWith, gitRepo, sh, tmp, write, type Proc } from "./support.ts";

const SHA = "c".repeat(40);

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.STATUS_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.STATUS_LOG as string, a.join(" ") + "\n");
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); } // the default branch, for main's settings
const method = a.includes("-X") ? a[a.indexOf("-X") + 1] : "GET";
if (a[0] !== "api" || method !== "GET" || a.includes("--input") || a.includes("-f") || a.includes("-F")) fail("fake gh: status must only read");
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json") { if (!("main_settings" in s)) fail("gh: Not Found (HTTP 404)"); out(s.main_settings); }
if ((s.broken ?? []).includes(path)) fail("gh: HTTP 403");
if (path in s) out(s[path]);
if (path.startsWith("issues/") && path.endsWith("/comments")) out([]);
fail("fake gh: no answer for " + path);
`;

type Row = Record<string, any>;
type Env = Record<string, string | undefined>;

/** A project whose .claude/hooks holds a copy of every hook (so a test can swap one for a stub; Bun resolves a linked
 * script to its target's folder, so links would not do). */
function setup(scenario: Row, cfg: Row): [string, Env] {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  write(join(root, "bin", "gh"), FAKE_GH, 0o755);
  write(join(root, "scenario.json"), JSON.stringify(scenario));
  return [d, envWith(join(root, "bin"), { STATUS_SCENARIO: join(root, "scenario.json"), STATUS_LOG: join(root, "log"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined })];
}

function status(d: string, env: Env, ...args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), "status", ...args], { cwd: d, env, timeoutMs: 60_000 });
}

function agentIssue(name: string, st: string, ping: string): Row {
  return { number: 90, title: `Agent: ${name} · ${st}`, state: "open", labels: [{ name: "factory:agent" }],
    body: `<!-- factory-agent name=${name} status=${st} ping=${ping} -->` };
}

function task(n: number, label: string, milestone: string | null = null): Row {
  return { number: n, title: `Task ${n}`, state: "open", body: "", labels: [{ name: label }],
    milestone: milestone ? { number: 1, title: milestone } : null };
}

const ISSUES_MODE = { tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] };

function scenario(): Row {
  const now = "2099-01-01T00:00:00Z"; // a ping in the future: never silent, whatever the clock says
  return {
    issues: [agentIssue("taytu", "working", now), task(5, "factory:ready", "Phase 3"), task(6, "factory:ready", "Phase 3"),
      task(7, "factory:in-progress"), task(8, "factory:blocked")],
    pulls: [{ number: 12, title: "Task 7", draft: false, body: "Closes #7\nA person merges this one: CI",
      head: { sha: SHA, ref: "task/7-x" }, labels: [{ name: "factory-hold" }] }],
    [`commits/${SHA}/check-runs`]: { check_runs: [{ status: "completed", conclusion: "failure" }] },
    "issues/12/comments": [{ body: "<!-- factory-mustfix --> fix the test" }],
    "actions/runs": { workflow_runs: [{ created_at: "2020-01-01T00:00:00Z", status: "queued" }] },
    "actions/runners": { runners: [{ name: "dev-pc-1", status: "online", busy: true }] },
  };
}

test("one view of agents prs ci and tasks", () => {
  const [d, env] = setup(scenario(), ISSUES_MODE);
  write(join(d, ".git", "factory-reviews", "task_7-x.ok"), SHA); // passes live in the git folder (#260)
  const p = status(d, env);
  expect(p.code, p.out).toBe(0);
  for (const w of ["taytu", "working", "#12", "CI failed", "reviewed", "hold", "must-fix", "a person merges it", "1 queued",
    "dev-pc-1 online busy", "ready: 2 in Phase 3", "in progress 1", "blocked 1"]) {
    expect(p.stdout).toContain(w);
  }
});

test("json for scripts", () => {
  const [d, env] = setup(scenario(), ISSUES_MODE);
  const s = JSON.parse(status(d, env, "--json").stdout) as Row;
  expect(s.pulls.pulls[0].ci).toBe("failed");
  expect(s.pulls.pulls[0].reviewed, "no marker on this machine: unknown, not false").toBeNull();
  expect(s.tasks.ready).toEqual({ "Phase 3": 2 });
});

test("it only reads", () => {
  const [d, env] = setup(scenario(), ISSUES_MODE);
  status(d, env);
  const calls = readFileSync(env.STATUS_LOG as string, "utf8").split("\n").filter((l) => l);
  const reads = calls.filter((c) => !c.startsWith("repo view --json defaultBranchRef")); // main's name: a read too
  expect(reads.length > 0).toBe(true);
  for (const c of reads) expect(c.startsWith("api ") && (!c.includes(" -X ") || c.includes(" -X GET ")), c).toBe(true);
});

test("a section github cant answer says so and the rest still shows", () => {
  let s = scenario();
  s.broken = ["actions/runs", "actions/runners"];
  let [d, env] = setup(s, ISSUES_MODE);
  const p = status(d, env);
  expect(p.code, p.out).toBe(0);
  for (const w of ["can't read it", "#12", "ready: 2 in Phase 3"]) expect(p.stdout).toContain(w);
  s = scenario();
  s.broken = ["actions/runners"]; // listing runners needs admin
  [d, env] = setup(s, ISSUES_MODE);
  expect(status(d, env).stdout).toContain("runners: can't be listed");
});

const OTHER = "d".repeat(40);

function devManagerView(comments: Row[], mainSettings: Row | null = null, local: Row = {}): unknown {
  const s = scenario();
  s["issues/12/comments"] = comments;
  if (mainSettings !== null) s.main_settings = mainSettings;
  const [d, env] = setup(s, { ...ISSUES_MODE, ...local });
  const p = status(d, env, "--json");
  expect(p.code, p.out).toBe(0);
  return (JSON.parse(p.stdout) as Row).pulls.pulls[0].devManager;
}

function c(body: string, login = "dm"): Row {
  return { body, user: { login } };
}

test("an approval counts only as the gate counts it", () => {
  // Only for the head commit, and (with trustedReviewers on main) only from a trusted login (#85 review).
  expect(devManagerView([c(`<!-- factory-approved sha=${SHA.slice(0, 12)} -->`)])).toBe("approved");
  expect(devManagerView([c(`<!-- factory-approved sha=${OTHER.slice(0, 12)} -->`)])).toBe("approval stale");
  expect(devManagerView([c("<!-- factory-approved -->")])).toBe("approval stale"); // names no commit
  const trusted = { ...ISSUES_MODE, trustedReviewers: ["dm"] };
  expect(devManagerView([c(`<!-- factory-approved sha=${SHA.slice(0, 12)} -->`, "agent")], trusted)).toBeNull();
  expect(devManagerView([c("<!-- factory-mustfix -->"), c(`<!-- factory-approved sha=${SHA.slice(0, 12)} -->`, "agent")], trusted)).toBe("must-fix");
  // trustedReviewers comes from main, not this worktree's copy.
  expect(devManagerView([c(`<!-- factory-approved sha=${SHA.slice(0, 12)} -->`, "agent")], trusted, { trustedReviewers: [] })).toBeNull();
});

test("a must fix holds until an approval of the head and says when it is for an older commit", () => {
  expect(devManagerView([c(`<!-- factory-mustfix sha=${SHA} -->`)])).toBe("must-fix");
  expect(devManagerView([c(`<!-- factory-mustfix sha=${OTHER} -->`)])).toBe("must-fix (older commit)");
  expect(devManagerView([c("<!-- factory-mustfix -->"), c(`<!-- factory-approved sha=${SHA} -->`)])).toBe("approved");
  expect(devManagerView([c(`<!-- factory-approved sha=${SHA} -->`), c("<!-- factory-mustfix -->")])).toBe("must-fix");
});

test("one prs ci failing to read shows ci unknown and keeps the rest", () => {
  const s = scenario();
  s.broken = [`commits/${SHA}/check-runs`];
  const [d, env] = setup(s, ISSUES_MODE);
  const out = status(d, env).stdout;
  expect(out).toContain("#12");
  expect(out).toContain("CI unknown");
});

test("claims and the next task that cant be read say so", () => {
  const [d, env] = setup(scenario(), { reviewMarkers: "tmp/reviews" }); // plan mode: no build plan, no origin
  const hooks = join(d, ".claude", "hooks");
  for (const f of ["factory_claims.ts", "next_task.ts"]) {
    sh(["rm", join(hooks, f)]);
    // A stub that fails when run (other hooks import the real module's exports, which it passes on).
    write(join(hooks, f), `export * from ${JSON.stringify(join(HOOKS, f))};\n` +
      'if (import.meta.main) { console.error("boom"); process.exit(1); }\n');
  }
  const p = status(d, env);
  const out = p.stdout;
  expect(out, p.out).toContain("claims: can't read them");
  expect(out).not.toContain("no claims");
  expect(out).toContain("next task: can't read it");
  expect(out).not.toContain("nothing ready");
});
