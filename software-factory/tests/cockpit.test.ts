// `factory cockpit --json` and `--status` (#298): one snapshot of the factory for every screen, and one short line for
// tmux's status line read from a cache. Run against a fake `gh` that answers from a scenario and logs every call.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, CI, SF, envWith, gitRepo, read, sh, tmp, write, type Proc } from "./support.ts";

const SHA = "c".repeat(40);
const T = 180_000; // doctor is slow: generous per-test timeouts

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.COCKPIT_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.COCKPIT_LOG as string, a.join(" ") + "\n");
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (s.fail_all) fail("gh: not logged in");
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
if (a[0] !== "api") { console.log("ok"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "POST" && x !== "PATCH" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json") fail("gh: Not Found (HTTP 404)");
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
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  write(join(root, "bin", "gh"), FAKE_GH, 0o755);
  write(join(root, "scenario.json"), JSON.stringify(scenario));
  const xdg = join(root, "state");
  mkdirSync(xdg);
  const log = join(root, "log");
  writeFileSync(log, "");
  const env = envWith(join(root, "bin"), { COCKPIT_SCENARIO: join(root, "scenario.json"), COCKPIT_LOG: log,
    XDG_STATE_HOME: xdg, HOME: join(root, "home"), FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined,
    FACTORY_COCKPIT_CACHE_SECONDS: undefined });
  mkdirSync(join(root, "home"));
  return { d, env, xdg, log };
}

function cockpit(p: Proj, ...args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: p.env, timeoutMs: 120_000 });
}

function snapshot(p: Proj): Row {
  const r = cockpit(p, "--json");
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.stdout) as Row;
}

function calls(p: Proj): string[] {
  return readFileSync(p.log, "utf8").split("\n").filter((l) => l);
}

/** Every cockpit.json under the state dir. */
function caches(xdg: string): string[] {
  const found: string[] = [];
  for (const dir of readdirSync(xdg)) {
    const f = join(xdg, dir, "cockpit.json");
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
  };
}

// --- --json ----------------------------------------------------------------------------------------------------------

test("json has every key and exits 0", () => {
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
}, T);

test("json writes the cache under the state dir", () => {
  const p = setup(scenario());
  snapshot(p);
  expect(caches(p.xdg).length).toBe(1);
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
  const ci = snapshot(p).ci;
  if (ci !== null) {
    expect(typeof ci).toBe("object");
    for (const k of ["mode", "runs", "errors"]) expect(ci, k).toHaveProperty(k);
  }
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

test("no sessions at all", () => {
  const p = setup({ issues: [] }, { tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: [] });
  const j = snapshot(p);
  expect(j.sessions).toEqual([]);
  expect(j.counts.sessions).toBe(0);
  expect(j.counts.working).toBe(0);
}, T);

test("with gh failing, json still answers and says what is missing without a stack trace", () => {
  const p = setup({ fail_all: true });
  const r = cockpit(p, "--json");
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

// --- --status --------------------------------------------------------------------------------------------------------

/** Run --json once, then rewrite its cache with known numbers, as of now. */
function seedCache(p: Proj, counts: Row, missing: Row[] = []): void {
  snapshot(p);
  const [file] = caches(p.xdg) as [string];
  const j = JSON.parse(read(file)) as Row;
  writeFileSync(file, JSON.stringify({ ...j, generatedAt: new Date().toISOString(), counts, missing }));
  writeFileSync(p.log, "");
}

test("status from a fresh cache is one line with the counts and makes no github call", () => {
  const p = setup(scenario());
  seedCache(p, { sessions: 3, working: 1, pulls: 2, needYou: 4 });
  const r = cockpit(p, "--status");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trimEnd().split("\n").length).toBe(1);
  expect(r.stdout).toContain("4 need you");
  expect(r.stdout).toContain("3 sessions");
  expect(r.stdout).toContain("1 working");
  expect(calls(p)).toEqual([]);
}, T);

test("status says what it cant read when the cache has missing parts", () => {
  const p = setup(scenario());
  seedCache(p, { sessions: 1, working: 0, pulls: 0, needYou: 0 },
    [{ code: "github-unreadable", message: "GitHub did not answer.", fix: "Run: gh auth login" }]);
  const r = cockpit(p, "--status");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trimEnd().split("\n").length).toBe(1);
  expect(r.stdout).toContain("can't read");
  noTrace(r.out);
}, T);

test("status with no cache says there is no snapshot yet and starts a refresh", async () => {
  const p = setup(scenario());
  const r = cockpit(p, "--status");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trimEnd().split("\n").length).toBe(1);
  expect(r.stdout).toContain("no snapshot yet");
  noTrace(r.out);
  for (let i = 0; i < 60 && caches(p.xdg).length === 0; i++) await Bun.sleep(500);
  expect(caches(p.xdg).length, "a background refresh writes cockpit.json").toBe(1);
}, T);

test("status with gh failing still answers in one line", () => {
  const p = setup({ fail_all: true });
  const r = cockpit(p, "--status");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trimEnd().split("\n").length).toBe(1);
  noTrace(r.out);
}, T);

// --- errors, help and docs -------------------------------------------------------------------------------------------

test("no flag and an unknown flag are errors with code message and fix", () => {
  const p = setup(scenario());
  for (const args of [[], ["--bogus"]]) {
    const r = cockpit(p, ...args);
    expect(r.code, r.out).toBe(2);
    const e = JSON.parse(r.stderr.trim()) as Row;
    for (const k of ["code", "message", "fix"]) expect(typeof e[k], r.stderr).toBe("string");
    noTrace(r.out);
  }
}, T);

test("factory help lists both flags", () => {
  const p = setup(scenario());
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env, timeoutMs: 60_000 });
  expect(r.stdout).toContain("cockpit --json");
  expect(r.stdout).toContain("cockpit --status");
});

test("the commands page has a row for factory cockpit", () => {
  const page = read(join(SF, "docs", "wiki", "commands.md"));
  expect(page).toMatch(/^\| `factory cockpit[^`]*`/m);
  expect(page).toContain("--status");
});
