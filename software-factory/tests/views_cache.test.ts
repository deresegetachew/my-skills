// The GitHub views answer from one cache (#305): `factory prs`, `factory watch` and `factory messages ls` against a fake
// `gh` that answers from a scenario and logs every call. A run that reads GitHub leaves lines in the log; a run served
// from the cache leaves none. Time moves with FACTORY_NOW. The cache lives under XDG_STATE_HOME, which each test points at
// its own folder.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, SF, envWith, gitRepo, runBun, sh, tmp, write, writeExe, type Proc } from "./support.ts";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.VIEWS_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.VIEWS_LOG as string, a.join(" ") + "\n");
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
const method = a.includes("-X") ? a[a.indexOf("-X") + 1] : "GET";
if (a[0] !== "api" || method !== "GET" || a.includes("--input") || a.includes("-f") || a.includes("-F")) fail("fake gh: views must only read");
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json") out(s.main_settings ?? {});
if ((s.broken ?? []).includes(path)) fail("gh: HTTP 403");
if (path in s) out(s[path]);
if (path.startsWith("actions/runs")) out({ workflow_runs: [] });
if (path.startsWith("actions/runners")) out({ runners: [] });
out([]);
`;

type Row = Record<string, any>;
type Env = Record<string, string | undefined>;
type ViewName = "prs" | "watch" | "messages";

const OLD_COMMIT = "1999-01-01T00:00:00Z"; // long before every FACTORY_NOW used here, so watch has a review to ask for
const SHA = "1".repeat(40);
const T0 = 1_000_000_000;
const NOTE = (s: number): string => `(as of ${s} s ago; --fresh asks GitHub again)`;
const MAIN = { tasks: { source: "issues" }, manager: { flakes: ["e2e"] }, protected: ["^\\.claude/"] };

const VIEWS: Record<ViewName, { file: string; args: string[]; code: number }> = {
  prs: { file: "factory_prs.ts", args: [], code: 0 },
  watch: { file: "factory_watch.ts", args: [], code: 3 },
  messages: { file: "factory_messages.ts", args: ["ls"], code: 0 },
};

function scenario(extra: Row = {}, withPr = true): Row {
  const s: Row = { pulls: [], issues: [], "issues/comments": [], main_settings: MAIN };
  if (withPr) {
    s.pulls.push({ number: 1, title: "Task 1", draft: false, body: "", html_url: "https://github.com/o/r/pull/1",
      head: { sha: SHA, ref: "task/1-x" }, labels: [] });
    s[`commits/${SHA}`] = { commit: { committer: { date: OLD_COMMIT } } };
    s[`commits/${SHA}/check-runs`] = { check_runs: [] };
    s["issues/1/comments"] = [{ id: 11, body: "hello", created_at: OLD_COMMIT }, { id: 12, body: "again", created_at: OLD_COMMIT }];
    s["pulls/1/files"] = [{ filename: "src/a.py" }];
  }
  return { ...s, ...extra };
}

/** For messages: two questions on one issue, one to the product owner and one to the dev manager (and no pull request). */
function messagesScenario(extra: Row = {}): Row {
  const s = scenario({}, false);
  s.issues = [{ number: 2, title: "Ask", labels: [], comments: 2, body: "", html_url: "https://github.com/o/r/issues/2" }];
  s["issues/2/comments"] = [
    { id: 21, body: "<!-- factory-msg v=1 id=q-for-po kind=question from=haile to=po state=submitted -->\nWhat colour?", created_at: OLD_COMMIT },
    { id: 22, body: "<!-- factory-msg v=1 id=q-for-dm kind=question from=haile to=dev-manager state=submitted -->\nWhich branch?", created_at: OLD_COMMIT },
  ];
  return { ...s, ...extra };
}

interface Ctx {
  d: string;
  env: Env;
  log: string;
  views: string;
}

function project(sc: Row, cfg: Row = {}): Ctx {
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik", "taytu"], ...cfg }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  write(join(root, "scenario.json"), JSON.stringify(sc));
  write(join(root, "log"), "");
  const state = join(root, "state");
  const env = envWith(join(root, "bin"), { VIEWS_SCENARIO: join(root, "scenario.json"), VIEWS_LOG: join(root, "log"),
    XDG_STATE_HOME: state, FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_NOW: undefined });
  return { d, env, log: join(root, "log"), views: join(state, "work-factory", "views") };
}

function ctxFor(name: ViewName, cfg: Row = {}, extra: Row = {}): Ctx {
  return project(name === "messages" ? messagesScenario(extra) : scenario(extra), cfg);
}

function hook(name: ViewName): string {
  return join(HOOKS, VIEWS[name].file);
}

/** One run of a view's hook at time `now` (seconds since 1970). */
function run(c: Ctx, name: ViewName, extra: string[] = [], now: number = T0): Proc {
  return runBun(hook(name), [...VIEWS[name].args, ...extra], { cwd: c.d, env: { ...c.env, FACTORY_NOW: String(now) } });
}

function calls(c: Ctx): number {
  return readFileSync(c.log, "utf8").split("\n").filter(Boolean).length;
}

function logCount(c: Ctx, text: string): number {
  return readFileSync(c.log, "utf8").split("\n").filter((l) => l.includes(text)).length;
}

function viewFiles(c: Ctx, ext = ".json"): string[] {
  return existsSync(c.views) ? readdirSync(c.views).filter((f) => f.endsWith(ext)).map((f) => join(c.views, f)) : [];
}

const lastLine = (p: Proc): string => p.stdout.trimEnd().split("\n").pop() ?? "";
const withoutNote = (text: string): string => text.split("\n").filter((l) => !l.startsWith("(as of ")).join("\n");

/** A prs --json answer without the time it was made, which is the only part that differs between two reads. */
function stable(text: string): unknown {
  const v = JSON.parse(text) as Row;
  if (!Array.isArray(v)) delete v.generatedAt;
  return v;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(ok: () => boolean, capMs: number): Promise<boolean> {
  const end = Date.now() + capMs;
  while (Date.now() < end) {
    if (ok()) return true;
    await sleep(100);
  }
  return ok();
}

/** Waits until the number of calls has not changed for `quietMs` (capped), and returns it. */
async function settle(c: Ctx, quietMs = 1500, capMs = 8000): Promise<number> {
  const end = Date.now() + capMs;
  let last = calls(c);
  let since = Date.now();
  while (Date.now() < end && Date.now() - since < quietMs) {
    await sleep(100);
    const n = calls(c);
    if (n !== last) {
      last = n;
      since = Date.now();
    }
  }
  return last;
}

function spawnView(c: Ctx, name: ViewName, extra: string[], now: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...c.env, FACTORY_NOW: String(now) })) if (v !== undefined) env[k] = v;
  const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", hook(name), ...VIEWS[name].args, ...extra],
    { cwd: c.d, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
    .then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
}

const NAMES: ViewName[] = ["prs", "watch", "messages"];

// --- the harness itself: a first read works today -----------------------------------------------------------------

test("a first run of each view reads GitHub and prints its answer", () => {
  const shows: Record<ViewName, string> = { prs: "Open pull requests (1)", watch: "pr-1", messages: "q-for-dm" };
  for (const name of NAMES) {
    const c = ctxFor(name);
    const p = run(c, name);
    expect(p.code, `${name}: ${p.out}`).toBe(VIEWS[name].code);
    expect(p.stdout, name).toContain(shows[name]);
    expect(p.stdout, name).not.toContain("(as of");
    expect(calls(c), name).toBeGreaterThan(0);
  }
});

// --- a fresh entry answers without GitHub --------------------------------------------------------------------------

test("a second run within the time to live reads nothing and says how old the answer is (text)", () => {
  for (const name of NAMES) {
    const c = ctxFor(name);
    const first = run(c, name, [], T0);
    const before = calls(c);
    const second = run(c, name, [], T0 + 10);
    expect(second.code, `${name}: ${second.out}`).toBe(VIEWS[name].code);
    expect(calls(c), `${name} read GitHub again`).toBe(before);
    expect(lastLine(second), name).toBe(NOTE(10));
    expect(withoutNote(second.stdout), name).toBe(withoutNote(first.stdout));
    expect(first.stdout, name).not.toContain("(as of");
  }
});

test("with --json the note goes to stderr and stdout stays the same parseable JSON", () => {
  for (const name of NAMES) {
    const c = ctxFor(name);
    const first = run(c, name, ["--json"], T0);
    const before = calls(c);
    const second = run(c, name, ["--json"], T0 + 10);
    expect(second.code, `${name}: ${second.out}`).toBe(VIEWS[name].code);
    expect(calls(c), `${name} read GitHub again`).toBe(before);
    expect(second.stderr, name).toContain(NOTE(10));
    expect(JSON.parse(second.stdout), name).toEqual(JSON.parse(first.stdout));
    expect(first.stderr, name).not.toContain("(as of");
  }
});

test("watch keeps its exit code from the cache: 0 when nothing needs anyone", () => {
  const c = project(scenario({}, false));
  const first = run(c, "watch", [], T0);
  expect(first.code, first.out).toBe(0);
  expect(first.stdout).toContain("nothing to do");
  const before = calls(c);
  const second = run(c, "watch", [], T0 + 10);
  expect(second.code, second.out).toBe(0);
  expect(calls(c)).toBe(before);
  expect(lastLine(second)).toBe(NOTE(10));
  expect(second.stdout).toContain("nothing to do");
});

test("the cache is a file per view named <view>-<hash>.json under the state folder, with no temp file left", () => {
  const c = ctxFor("prs");
  for (const name of NAMES) run(c, name, [], T0);
  const names = viewFiles(c).map((f) => f.slice(c.views.length + 1));
  for (const name of NAMES) expect(names.filter((n) => new RegExp(`^${name}-[0-9a-f]+\\.json$`).test(n)).length, name).toBe(1);
  for (const f of viewFiles(c)) JSON.parse(readFileSync(f, "utf8"));
  expect(viewFiles(c, ".tmp")).toEqual([]);
});

// --- it expires ----------------------------------------------------------------------------------------------------

test("at or after the time to live GitHub is read again and there is no note", () => {
  for (const name of NAMES) {
    const c = ctxFor(name);
    run(c, name, [], T0);
    const before = calls(c);
    const later = run(c, name, [], T0 + 50);
    expect(later.code, `${name}: ${later.out}`).toBe(VIEWS[name].code);
    expect(calls(c), `${name} did not read GitHub`).toBeGreaterThan(before);
    expect(later.out, name).not.toContain("(as of");
  }
});

test("views.cacheSeconds sets the time to live: 100 keeps an answer that 45 would have dropped", () => {
  const c = ctxFor("prs", { views: { cacheSeconds: 100 } });
  run(c, "prs", [], T0);
  const before = calls(c);
  const second = run(c, "prs", [], T0 + 50);
  expect(calls(c)).toBe(before);
  expect(lastLine(second)).toBe(NOTE(50));
});

// --- --fresh and switching the cache off -------------------------------------------------------------------------

test("--fresh reads GitHub even within the time to live and prints no note", () => {
  for (const name of NAMES) {
    const c = ctxFor(name);
    run(c, name, [], T0);
    const before = calls(c);
    const fresh = run(c, name, ["--fresh"], T0 + 10);
    expect(fresh.code, `${name}: ${fresh.out}`).toBe(VIEWS[name].code);
    expect(calls(c), `${name} did not read GitHub`).toBeGreaterThan(before);
    expect(fresh.out, name).not.toContain("(as of");
  }
});

test("--fresh also keeps the new answer for the runs after it", () => {
  const c = ctxFor("prs");
  run(c, "prs", ["--fresh"], T0);
  const before = calls(c);
  const next = run(c, "prs", [], T0 + 5);
  expect(calls(c)).toBe(before);
  expect(lastLine(next)).toBe(NOTE(5));
});

test("views.cacheSeconds 0 turns the cache off: every run reads GitHub", () => {
  for (const name of NAMES) {
    const c = ctxFor(name, { views: { cacheSeconds: 0 } });
    const a = run(c, name, [], T0);
    expect(a.code, `${name}: ${a.out}`).toBe(VIEWS[name].code);
    const before = calls(c);
    const b = run(c, name, [], T0 + 1);
    expect(b.code, `${name}: ${b.out}`).toBe(VIEWS[name].code);
    expect(calls(c), `${name} used a cache`).toBeGreaterThan(before);
    expect(b.out, name).not.toContain("(as of");
  }
});

// --- different arguments are different entries -------------------------------------------------------------------

test("prs and prs --since-days 3 are separate entries", () => {
  const c = ctxFor("prs");
  run(c, "prs", [], T0);
  const before = calls(c);
  const other = run(c, "prs", ["--since-days", "3"], T0 + 5);
  expect(other.code, other.out).toBe(0);
  expect(calls(c)).toBeGreaterThan(before);
  expect(other.out).not.toContain("(as of");
  const again = run(c, "prs", ["--since-days", "3"], T0 + 8);
  expect(lastLine(again)).toBe(NOTE(3));
});

test("messages ls --to po and --to dev-manager are separate entries", () => {
  const c = ctxFor("messages");
  const po = run(c, "messages", ["--to", "po"], T0);
  expect(po.code, po.out).toBe(0);
  expect(po.stdout).toContain("q-for-po");
  expect(po.stdout).not.toContain("q-for-dm");
  const before = calls(c);
  const dm = run(c, "messages", ["--to", "dev-manager"], T0 + 5);
  expect(dm.code, dm.out).toBe(0);
  expect(calls(c)).toBeGreaterThan(before);
  expect(dm.stdout).toContain("q-for-dm");
  expect(dm.stdout).not.toContain("q-for-po");
  expect(dm.out).not.toContain("(as of");
});

// --- a bad file counts as missing ----------------------------------------------------------------------------------

type Damage = [string, (file: string) => void];
const DAMAGES: Damage[] = [
  ["half written", (f) => writeFileSync(f, readFileSync(f).subarray(0, 10))],
  ["written by an older release", (f) => writeFileSync(f, JSON.stringify({ schema: 0, at: T0 + 5, data: {} }))],
  ["a plain list", (f) => writeFileSync(f, "[]")],
];

for (const [what, damage] of DAMAGES) {
  test(`a cache file that is ${what} is read as missing: GitHub is read, the answer is right, the file is repaired`, () => {
    for (const name of NAMES) {
      const c = ctxFor(name);
      const first = run(c, name, [], T0);
      const files = viewFiles(c);
      expect(files.length, `${name}: no cache file was written`).toBeGreaterThan(0);
      for (const f of files) damage(f);
      const before = calls(c);
      const second = run(c, name, [], T0 + 10);
      expect(second.code, `${name}: ${second.out}`).toBe(VIEWS[name].code);
      expect(calls(c), `${name} trusted a bad file`).toBeGreaterThan(before);
      expect(second.stdout, name).toBe(first.stdout);
      expect(second.out, name).not.toContain("(as of");
      for (const f of viewFiles(c)) JSON.parse(readFileSync(f, "utf8"));
      expect(viewFiles(c, ".tmp"), name).toEqual([]);
    }
  });
}

// --- two views at once ---------------------------------------------------------------------------------------------

test("prs twice and watch at the same moment on an empty cache all finish with valid JSON and a sound cache", async () => {
  const c = ctxFor("prs");
  const runs = await Promise.all([spawnView(c, "prs", ["--json"], T0), spawnView(c, "prs", ["--json"], T0),
    spawnView(c, "watch", ["--json"], T0)]);
  expect(runs[0].code, runs[0].stderr).toBe(0);
  expect(runs[1].code, runs[1].stderr).toBe(0);
  expect(runs[2].code, runs[2].stderr).toBe(3);
  for (const r of runs) JSON.parse(r.stdout);
  expect(stable(runs[0].stdout)).toEqual(stable(runs[1].stdout));
  const files = viewFiles(c);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) JSON.parse(readFileSync(f, "utf8"));
  expect(viewFiles(c, ".tmp")).toEqual([]);
});

// --- a failed read is never kept -----------------------------------------------------------------------------------

test("a read that fails is not cached: the next run asks GitHub again", () => {
  const c = ctxFor("prs", {}, { broken: ["pulls"] });
  const first = run(c, "prs", [], T0);
  expect(first.code, first.out).toBe(0);
  expect(first.stdout).toContain("can't read it");
  const before = calls(c);
  const second = run(c, "prs", [], T0 + 5);
  expect(calls(c)).toBeGreaterThan(before);
  expect(second.out).not.toContain("(as of");
});

// --- the background refresh ----------------------------------------------------------------------------------------

test("an answer at least half as old as the time to live is served and refreshed in the background", async () => {
  const c = ctxFor("prs");
  run(c, "prs", [], T0);
  const before = calls(c);
  const second = run(c, "prs", [], T0 + 30);
  expect(second.code, second.out).toBe(0);
  expect(lastLine(second)).toBe(NOTE(30));
  expect(await waitFor(() => calls(c) > before, 5000), "no refresh reached GitHub").toBe(true);
  await settle(c);
  // the refresh stored a newer entry, so a run a little later is served from it
  const settled = calls(c);
  const third = run(c, "prs", [], T0 + 40);
  expect(third.code, third.out).toBe(0);
  expect(lastLine(third)).toBe(NOTE(10));
  expect(calls(c)).toBe(settled);
});

test("two runs at the same moment start only one refresh", async () => {
  const c = ctxFor("prs");
  const firstRun = run(c, "prs", [], T0);
  expect(firstRun.code, firstRun.out).toBe(0);
  const perRead = logCount(c, "pulls?state=open");
  expect(perRead).toBeGreaterThan(0);
  const before = logCount(c, "pulls?state=open");
  const both = await Promise.all([spawnView(c, "prs", [], T0 + 30), spawnView(c, "prs", [], T0 + 30)]);
  for (const r of both) {
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(NOTE(30));
  }
  expect(await waitFor(() => logCount(c, "pulls?state=open") > before, 5000), "no refresh reached GitHub").toBe(true);
  await settle(c);
  expect(logCount(c, "pulls?state=open")).toBe(before + perRead);
});

// --- help ----------------------------------------------------------------------------------------------------------

function helpBlock(help: string, command: string): string {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  ${command} `));
  expect(start, `${command} is not in factory help`).toBeGreaterThanOrEqual(0);
  const block = [lines[start] as string];
  for (let i = start + 1; i < lines.length && /^\s{3,}\S/.test(lines[i] as string); i++) block.push(lines[i] as string);
  return block.join("\n");
}

test("factory help mentions --fresh for prs, watch and messages", () => {
  const p = sh(["bash", join(SF, "factory"), "help"], { env: { ...process.env } });
  expect(p.code, p.out).toBe(0);
  for (const command of ["prs", "watch", "messages"]) expect(helpBlock(p.stdout, command), command).toContain("--fresh");
});

test("factory settings help views.cacheSeconds names the key and its default of 45", () => {
  const c = ctxFor("prs");
  const p = runBun(join(HOOKS, "factory_settings.ts"), ["help", "views.cacheSeconds"], { cwd: c.d, env: c.env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("views.cacheSeconds");
  expect(p.stdout).toContain("45");
});
