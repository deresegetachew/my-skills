// `factory snapshot` (#298, #425): one snapshot of the factory as data, the core the web UI's views read, written to a
// cache in this machine's state folder. Run against a fake `gh` that answers from a scenario and logs every call. And
// `factory cockpit`, retired (#425), says it moved to `factory ui`.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, CI, copyHookFolders, SF, envWith, gitRepo, read, sh, tmp, write, type Proc } from "./support.ts";

const SHA = "c".repeat(40);
const T = 180_000; // doctor is slow: generous per-test timeouts

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.SNAPSHOT_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.SNAPSHOT_LOG as string, a.join(" ") + "\n");
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (s.fail_all) fail("gh: not logged in");
if (s.unauthorized && a[0] === "api") fail("gh: Bad credentials (HTTP 401)");
if (s.secondary_limited && a[0] === "api") { // a secondary limit: core still has calls, its reset an hour away (#385)
  if (a[1] === "rate_limit") out({ resources: { core: { limit: 5000, remaining: 4000, reset: s.secondary_limited } } });
  fail("gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)");
}
if (s.rate_limited && a[0] === "api") {
  if (a[1] === "rate_limit") out({ resources: { core: { limit: 5000, remaining: 0, reset: s.rate_limited } } });
  fail("gh: API rate limit exceeded for user ID 1. (HTTP 403)");
}
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] !== "api") { console.log("ok"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "POST" && x !== "PATCH" && x !== "Accept: application/vnd.github+json")[0] as string;
const short = raw.replace("repos/{owner}/{repo}/", "").replace(/^repos\/o\/r(\/|$)/, (_m, slash) => slash ? "" : "repo");
const path = new URL(short, "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json" || path.startsWith("actions/variables/")) fail("gh: Not Found (HTTP 404)");
if (path in s) out(s[path]);
if (path.startsWith("issues/") && path.endsWith("/comments")) out([]);
fail("fake gh: no answer for " + path);
`;

type Row = Record<string, any>;
type Env = Record<string, string | undefined>;
interface Proj { d: string; env: Env; xdg: string; log: string }

const ISSUES_MODE = { tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] };

/** A project with a copy of every hook and of ci/, a fake gh, and an isolated state dir for the cache. */
function setup(scenario: Row, cfg: Row = ISSUES_MODE): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  write(join(root, "bin", "gh"), FAKE_GH, 0o755);
  write(join(root, "scenario.json"), JSON.stringify(scenario));
  const xdg = join(root, "state");
  mkdirSync(xdg);
  const log = join(root, "log");
  writeFileSync(log, "");
  const env = envWith(join(root, "bin"), { SNAPSHOT_SCENARIO: join(root, "scenario.json"), SNAPSHOT_LOG: log,
    XDG_STATE_HOME: xdg, HOME: join(root, "home"), FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined,
    FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: undefined,
    XDG_CONFIG_HOME: join(root, "config") }); // this machine's own agent names must not leak in
  mkdirSync(join(root, "home"));
  return { d, env, xdg, log };
}

function factory(p: Proj, ...args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), ...args], { cwd: p.d, env: p.env, timeoutMs: 120_000 });
}

function snapshot(p: Proj): Row {
  const r = factory(p, "snapshot");
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.stdout) as Row;
}

/** Every snapshot.json under the state dir. */
function caches(xdg: string): string[] {
  const found: string[] = [];
  for (const dir of readdirSync(xdg)) {
    const f = join(xdg, dir, "snapshot.json");
    if (existsSync(f)) found.push(f);
  }
  return found;
}

function noTrace(out: string): void {
  expect(out).not.toMatch(/^\s+at .*(:\d+|\))/m);
  expect(out).not.toMatch(/^error:/m);
  expect(out).not.toMatch(/\b(TypeError|ReferenceError|SyntaxError|Unhandled)\b/);
}

function agentIssue(name: string, st: string, ping: string, more = ""): Row {
  return { number: 90, title: `Agent: ${name} · ${st}`, state: "open", labels: [{ name: "factory:agent" }],
    body: `<!-- factory-agent name=${name} status=${st} ping=${ping} machine=m-other ${more}-->` };
}

function scenario(): Row {
  return {
    issues: [
      agentIssue("zemen", "working", "2020-01-01T00:00:00Z", "kind=dev-manager "),
      { number: 77, title: "Dev manager: needs the owner", state: "open", labels: [], body: "" },
    ],
    "issues/77/comments": [{ body: "<!-- factory-owner-ask id=ship-it -->\nThis needs your yes: ship it", user: { login: "dm" },
      created_at: "2020-01-01T00:00:00Z", html_url: "https://github.com/o/r/issues/77#c1" }],
    pulls: [{ number: 12, title: "Task 7", draft: false, html_url: "https://github.com/o/r/pull/12",
      body: "Closes #7\nA person merges this one: CI", head: { sha: SHA, ref: "task/7-x" }, labels: [] }],
    [`commits/${SHA}`]: { commit: { committer: { date: "2020-01-01T00:00:00Z" } } },
    [`commits/${SHA}/check-runs`]: { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
    "issues/12/comments": [{ body: `<!-- factory-approved sha=${SHA.slice(0, 12)} -->`, user: { login: "dm" } }],
    "pulls/12/files": [{ filename: "src/a.ts" }],
    repo: { default_branch: "main" },
    "actions/runs": { workflow_runs: [{ head_branch: "main", status: "completed", conclusion: "success", name: "check",
      created_at: "2020-01-01T00:00:00Z" }] },
    "actions/runners": { runners: [] },
  };
}

// --- factory snapshot ------------------------------------------------------------------------------------------------

test("the snapshot has every key and exits 0", () => {
  const p = setup(scenario());
  const j = snapshot(p);
  for (const k of ["generatedAt", "version", "sessions", "needsYou", "pulls", "ci", "doctor", "counts", "missing"]) {
    expect(j, k).toHaveProperty(k);
  }
  expect(Number.isNaN(Date.parse(j.generatedAt))).toBe(false);
  expect(Array.isArray(j.sessions)).toBe(true);
  expect(Array.isArray(j.needsYou)).toBe(true);
  expect(Array.isArray(j.missing)).toBe(true);
  expect(Object.keys(j.counts).sort()).toEqual(["needYou", "pulls", "sessions", "working"]);
  expect(Object.keys(j.version).sort()).toEqual(["installed", "source"]);
  expect(j.ci, JSON.stringify(j.missing)).not.toBeNull();
}, T);

test("the snapshot writes the cache under the state dir", () => {
  const p = setup(scenario());
  snapshot(p);
  expect(caches(p.xdg).length).toBe(1);
}, T);

test("the snapshot carries the tasks from the task tracker", () => {
  const p = setup(scenario());
  const j = snapshot(p);
  expect(j.tasks, JSON.stringify(j.tasks)).toMatchObject({ source: "issues" });
}, T);

test("the snapshot's tasks carry the epics, and a task's cites, for the web UI's epics and tasks channels (#440, #438, #425)", () => {
  const s = scenario();
  s.issues.push(
    { number: 7, title: "Add the login page", state: "open", labels: [{ name: "factory:ready" }], body: "Builds on decision 0004.",
      html_url: "https://github.com/o/r/issues/7" },
    { number: 40, title: "Accounts", state: "open", labels: [{ name: "epic" }, { name: "epic:building" }],
      body: "People sign in.\n\nPRD: docs/accounts.md\nDecisions: 0003\n\n- [ ] #7\n- [x] #8\n", html_url: "https://github.com/o/r/issues/40" });
  const j = snapshot(setup(s));
  expect(j.tasks.epics, JSON.stringify(j.tasks)).toEqual([expect.objectContaining({ id: "40", title: "Accounts", stage: "building",
    prd: "docs/accounts.md", decisions: ["0003"], tasks: [{ id: "7", done: false }, { id: "8", done: true }],
    url: "https://github.com/o/r/issues/40" })]);
  expect(Object.keys(j.tasks.epics[0]).sort()).toEqual(["cites", "decisions", "id", "prd", "stage", "summary", "tasks", "title", "url"]);
  const ids = (j.tasks.tasks as Row[]).map((t) => t.id);
  expect(ids, "an epic is not a task").not.toContain("40");
  expect((j.tasks.tasks as Row[]).find((t) => t.id === "7")?.cites).toEqual(["decision 0004"]);
}, T);

test("with FACTORY_SNAPSHOT_TASKS=board (the web UI reads them from the message board, #498) the tasks are not read: the last ones are kept", () => {
  const s = scenario();
  s.issues.push({ number: 7, title: "Add the login page", state: "open", labels: [{ name: "factory:ready" }], body: "", html_url: "https://github.com/o/r/issues/7" });
  const p = setup(s);
  const first = snapshot(p);
  expect((first.tasks.tasks as Row[]).map((t) => t.id)).toContain("7");
  expect((first.tasks.tasks as Row[]).map((t) => t.id)).not.toContain("8");
  s.issues.push({ number: 8, title: "Sign out", state: "open", labels: [{ name: "factory:ready" }], body: "", html_url: "https://github.com/o/r/issues/8" });
  writeFileSync(join(p.env.SNAPSHOT_SCENARIO as string), JSON.stringify(s));
  const r = sh(["bash", join(SF, "factory"), "snapshot"], { cwd: p.d, env: { ...p.env, FACTORY_SNAPSHOT_TASKS: "board" }, timeoutMs: 120_000 });
  expect(r.code, r.out).toBe(0);
  const j = JSON.parse(r.stdout) as Row;
  expect(j.tasks).toEqual(first.tasks);
  const again = snapshot(p); // without it, the tracker is read again
  expect((again.tasks.tasks as Row[]).map((t) => t.id)).toContain("8");
}, T);

test("doctor has the summary shape", () => {
  const p = setup(scenario());
  const dr = snapshot(p).doctor;
  expect(dr).not.toBeNull();
  expect(Object.keys(dr).sort()).toEqual(["fix", "fixes", "notes", "ok", "summary"]);
  for (const k of ["fixes", "notes", "ok"]) expect(typeof dr[k]).toBe("number");
  expect(typeof dr.summary).toBe("string");
  expect(Array.isArray(dr.fix)).toBe(true);
  expect(dr.fix.length).toBeLessThanOrEqual(dr.fixes);
}, T);

test("ci is the object factory ci status --json prints", () => {
  const p = setup(scenario());
  const j = snapshot(p);
  const ci = j.ci;
  expect(ci, JSON.stringify(j.missing)).not.toBeNull();
  expect(typeof ci).toBe("object");
  for (const k of ["mode", "runs", "errors"]) expect(ci, k).toHaveProperty(k);
  expect(ci.errors).toEqual([]);
  expect(ci.runs).toContainEqual(expect.objectContaining({ ref: "main", branch: "main", state: "success" }));
  expect((j.missing as Row[]).map((m) => m.code)).not.toContain("ci_unreadable");
}, T);

test("the version comes from the release pin", () => {
  const p = setup(scenario());
  write(join(p.d, ".claude", "factory", "release.json"),
    JSON.stringify({ schema: "factory-pin/1", tag: "v9.9.9", version: "9.9.9", sha256: "x", files: {} }));
  expect(snapshot(p).version).toEqual({ installed: "9.9.9", source: "release" });
}, T);

test("the version of a linked checkout comes from the VERSION file", () => {
  const p = setup(scenario());
  write(join(p.d, ".claude", "VERSION"), "1.2.3\n");
  expect(snapshot(p).version).toEqual({ installed: "1.2.3", source: "linked" });
}, T);

test("no pin and no VERSION file give nulls", () => {
  const p = setup(scenario());
  expect(snapshot(p).version).toEqual({ installed: null, source: null });
}, T);

test("a second machine that stopped reporting is listed and not working", () => {
  const p = setup(scenario());
  const j = snapshot(p);
  const row = (j.sessions as Row[]).find((r) => r.name === "zemen");
  expect(row, JSON.stringify(j.sessions)).toBeDefined();
  expect(row?.where).toBe("machine m-other");
  expect(row?.state).not.toBe("working");
  expect(["silent", "down"]).toContain(row?.state);
  expect(row?.kind).toMatch(/dev.manager/); // the role comes from the row's kind
  expect(j.counts.sessions).toBe((j.sessions as Row[]).length);
  expect(j.counts.working).toBe((j.sessions as Row[]).filter((r) => r.state === "working").length);
}, T);

test("an unanswered owner ask needs you", () => {
  const p = setup(scenario());
  const j = snapshot(p);
  const ask = (j.needsYou as Row[]).find((x) => x.kind === "owner-ask");
  expect(ask, JSON.stringify(j.needsYou)).toBeDefined();
  expect(ask).toMatchObject({ id: "ship-it", issue: 77, url: "https://github.com/o/r/issues/77#c1" });
  expect(typeof ask?.ageMinutes).toBe("number");
  expect(j.counts.needYou).toBe((j.needsYou as Row[]).length);
}, T);

test("an answered owner ask does not need you", () => {
  const s = scenario();
  s["issues/77/comments"].push({ body: "yes, go", user: { login: "owner" }, created_at: "2020-01-02T00:00:00Z" });
  const j = snapshot(setup(s));
  expect((j.needsYou as Row[]).filter((x) => x.kind === "owner-ask")).toEqual([]);
}, T);

test("only asks waiting on the owner need you, and one the product owner replied to says so (#352)", () => {
  const s = scenario();
  const c = (body: string, at: string): Row => ({ body, user: { login: "dm" }, created_at: at, html_url: "https://github.com/o/r/issues/77#cx" });
  s["issues/77/comments"] = [
    c("<!-- factory-owner-ask id=ship-it -->\nThis needs your yes: ship it", "2020-01-01T00:00:00Z"),
    c("<!-- factory-owner-ask id=waits for=product -->\nThis needs your yes: a", "2020-01-01T01:00:00Z"),
    c("<!-- factory-po-reply ask=waits -->\nmy reply", "2020-01-01T02:00:00Z"),
    c("<!-- factory-owner-ask id=withpo for=product -->\nThis needs your yes: b", "2020-01-01T03:00:00Z"),
  ];
  const asks = (snapshot(setup(s)).needsYou as Row[]).filter((x) => x.kind === "owner-ask");
  expect(asks.map((x) => x.id).sort()).toEqual(["ship-it", "waits"]);
  expect(asks.find((x) => x.id === "waits")).toMatchObject({ state: "owner" });
}, T);

test("a pull request the owner merges needs you and is a pull row", () => {
  const p = setup(scenario());
  const j = snapshot(p);
  const row = (j.pulls as Row[]).find((r) => r.number === 12);
  expect(row, JSON.stringify(j.pulls)).toBeDefined();
  expect(row).toMatchObject({ number: 12, title: "Task 7", url: "https://github.com/o/r/pull/12", branch: "task/7-x",
    draft: false, ci: "green", next: "owner-merges" });
  const item = (j.needsYou as Row[]).find((x) => x.kind === "owner-merges");
  expect(item).toMatchObject({ number: 12, title: "Task 7", url: "https://github.com/o/r/pull/12" });
  expect(j.counts.pulls).toBe((j.pulls as Row[]).length);
}, T);

test("a pull row carries what the web UI's pull requests channel shows: review, checks, protected, agent (#424)", () => {
  const p = setup(scenario());
  const j = snapshot(p);
  const row = (j.pulls as Row[]).find((r) => r.number === 12);
  expect(row, JSON.stringify(j.pulls)).toMatchObject({ review: "factory-approved", notGreen: [], protected: true, agent: null,
    nextText: "owner merges (protected)", claim: null });
}, T);

test("a pull row carries its head commit, which keeps the web UI's pull request page until it changes (#453)", () => {
  const p = setup(scenario());
  const j = snapshot(p);
  const row = (j.pulls as Row[]).find((r) => r.number === 12);
  expect(row, JSON.stringify(j.pulls)).toMatchObject({ head: SHA });
}, T);

test("a pull row carries the decisions and PRD stories its body cites, [] when it cites none (#438, #425)", () => {
  const base = scenario();
  const pulls = base.pulls as Row[];
  const first = pulls[0] ?? {};
  const withCites = { ...base, pulls: [{ ...first, body: `${first.body}\nSee decision 0004 and US-12.` }] };
  const row = (snapshot(setup(withCites)).pulls as Row[]).find((r) => r.number === 12);
  expect(row?.cites, JSON.stringify(row)).toEqual(["decision 0004", "US-12"]);
  const plain = (snapshot(setup(scenario())).pulls as Row[]).find((r) => r.number === 12);
  expect(plain?.cites).toEqual([]);
}, T);

test("no sessions at all", () => {
  const p = setup({ issues: [] }, { tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: [] });
  const j = snapshot(p);
  expect(j.sessions).toEqual([]);
  expect(j.counts.sessions).toBe(0);
  expect(j.counts.working).toBe(0);
}, T);

test("with gh failing, the snapshot still answers and says what is missing without a stack trace", () => {
  const p = setup({ fail_all: true });
  const r = factory(p, "snapshot");
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  const j = JSON.parse(r.stdout) as Row;
  expect(j.missing.length).toBeGreaterThan(0);
  for (const m of j.missing as Row[]) {
    for (const k of ["code", "message", "fix"]) expect(typeof m[k], JSON.stringify(m)).toBe("string");
    expect(m.fix.length).toBeGreaterThan(0);
  }
  expect(j.pulls === null || Array.isArray(j.pulls)).toBe(true);
  expect(caches(p.xdg).length).toBe(1);
}, T);

test("with everything answering, missing is empty for pulls and the owner queue", () => {
  const j = snapshot(setup(scenario()));
  expect(Array.isArray(j.pulls)).toBe(true);
  const codes = (j.missing as Row[]).map((m) => JSON.stringify(m)).join("\n");
  expect(codes).not.toMatch(/pull/i);
}, T);

// --- errors, help and docs -------------------------------------------------------------------------------------------

test("an argument to factory snapshot is an error with code, message and fix", () => {
  const p = setup(scenario());
  const r = factory(p, "snapshot", "--bogus");
  expect(r.code, r.out).toBe(2);
  const e = JSON.parse(r.stderr.trim()) as Row;
  expect(e.code).toBe("snapshot_usage");
  for (const k of ["code", "message", "fix"]) expect(typeof e[k], r.stderr).toBe("string");
  noTrace(r.out);
}, T);

test("factory cockpit, with or without arguments, says it moved to factory ui and changes nothing", () => {
  const p = setup(scenario());
  for (const args of [[], ["--json"], ["--status"], ["watch", "pr-12"]]) {
    const r = factory(p, "cockpit", ...args);
    expect(r.code, r.out).toBe(1);
    const e = JSON.parse(r.stderr.trim()) as Row;
    expect(e.code).toBe("cockpit_moved");
    expect(e.message).toContain("factory ui");
    expect(e.fix).toContain("factory ui");
    noTrace(r.out);
  }
  expect(caches(p.xdg)).toEqual([]);
  expect(readFileSync(p.log, "utf8")).toBe("");
}, T);

test("factory doctor no longer checks a cockpit bundle or its Ink packages", () => {
  const p = setup(scenario());
  const r = factory(p, "doctor");
  expect(r.out).toMatch(/All the checks pass\.|\d+ to fix\./);
  expect(r.out.toLowerCase()).not.toContain("cockpit");
}, T);

test("factory help lists snapshot and no cockpit", () => {
  const p = setup(scenario());
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env, timeoutMs: 60_000 });
  expect(r.stdout).toMatch(/^ {2}snapshot\b/m);
  expect(r.stdout).not.toContain("cockpit");
});

test("the commands page has a row for factory snapshot and none for factory cockpit", () => {
  const page = read(join(SF, "docs", "wiki", "commands.md"));
  expect(page).toMatch(/^\| `factory snapshot`/m);
  expect(page).not.toMatch(/^\| `factory cockpit/m);
});

// --- the GitHub limit, machine names (#383) --------------------------------------------------------------------------

/** The reset the fake gh reports: 8 minutes from now, in whole seconds, and the HH:MM UTC the snapshot should print. */
function resetIn8(): { epoch: number; hhmm: string } {
  const epoch = Math.floor(Date.now() / 1000) + 8 * 60;
  return { epoch, hhmm: new Date(epoch * 1000).toISOString().slice(11, 16) };
}

function setScenario(p: Proj, s: Row): void {
  writeFileSync(p.env.SNAPSHOT_SCENARIO as string, JSON.stringify(s));
}

test("with the hourly limit used up, missing says so with the reset time and no login hint", () => {
  const { epoch, hhmm } = resetIn8();
  const p = setup({ ...scenario(), rate_limited: epoch });
  const j = snapshot(p);
  const miss = j.missing as Row[];
  const lim = miss.find((m) => m.code === "github_limit");
  expect(lim, JSON.stringify(miss)).toBeDefined();
  expect(lim?.message).toContain(`GitHub's hourly limit is used up; back at ${hhmm} UTC (in `);
  expect(lim?.message).toMatch(/\(in [78] min\)/);
  expect(lim?.message).toContain("The web UI shows the last snapshot meanwhile.");
  for (const m of miss) expect(m.fix, JSON.stringify(m)).not.toContain("gh auth login");
}, T);

test("when the limit hits after a good snapshot, the cache keeps the earlier data and its time", () => {
  const p = setup(scenario());
  const first = snapshot(p);
  expect((first.pulls as Row[]).length).toBeGreaterThan(0);
  setScenario(p, { ...scenario(), rate_limited: resetIn8().epoch });
  const r = factory(p, "snapshot");
  expect(r.code, r.out).toBe(0);
  const [file] = caches(p.xdg) as [string];
  const cached = JSON.parse(read(file)) as Row;
  expect(cached.pulls).toEqual(first.pulls);
  expect((cached.sessions as Row[]).map((x) => x.name)).toEqual((first.sessions as Row[]).map((x) => x.name));
  expect(cached.generatedAt).toBe(first.generatedAt);
  expect((cached.missing as Row[]).map((m) => m.code)).toContain("github_limit");
}, T);

test("a secondary limit while calls remain keeps no reset time and says no 'used up' (#385)", () => {
  const later = Math.floor(Date.now() / 1000) + 50 * 60;
  const p = setup({ ...scenario(), secondary_limited: later });
  const j = snapshot(p);
  expect((j.missing as Row[]).map((m) => m.code)).toContain("github_limit");
  expect((j.limit as Row).reset, JSON.stringify(j.limit)).toBeNull();
  const lim = (j.missing as Row[]).find((m) => m.code === "github_limit");
  expect(lim?.message).not.toContain("used up");
}, T);

test("a real 401 keeps the login hint and is not reported as the limit", () => {
  const j = snapshot(setup({ ...scenario(), unauthorized: true }));
  const miss = j.missing as Row[];
  expect(miss.length).toBeGreaterThan(0);
  expect(miss.map((m) => m.code)).not.toContain("github_limit");
  expect(miss.some((m) => String(m.fix).includes("gh auth login")), JSON.stringify(miss)).toBe(true);
}, T);

test("a session from another machine carries the name set in machines, else the hostname in its marker, else the id", () => {
  const named = setup(scenario(), { ...ISSUES_MODE, machines: { "m-other": { name: "dev-pc" } } });
  const a = (snapshot(named).sessions as Row[]).find((r) => r.name === "zemen");
  expect(a).toMatchObject({ machine: "m-other", machineName: "dev-pc" });

  const s = scenario();
  s.issues[0] = agentIssue("zemen", "working", "2020-01-01T00:00:00Z", "kind=dev-manager where=builder-box ");
  const host = (snapshot(setup(s)).sessions as Row[]).find((r) => r.name === "zemen");
  expect(host).toMatchObject({ machine: "m-other", machineName: "builder-box" });

  const bare = (snapshot(setup(scenario())).sessions as Row[]).find((r) => r.name === "zemen");
  expect(bare).toMatchObject({ machine: "m-other", machineName: "m-other" });
}, T);
