// `factory doctor` looks at CI before a test run (#205, the doctor part of #199): the runs-on variables and whether a
// runner with that label is online (a runner restarting between jobs is waited for, #246), whether the newest run on
// main is green, stale claims and Agent issues for agents that never ran, and a workflow whose setup does not match
// factory.json. Everything is read through `gh api` GETs; a fake gh answers from a JSON file and records what it was
// asked.
//
// factory_doctor is not ported yet (a later family), so these run factory_doctor_ci's checks in a project through a
// small driver that prints and exits as the doctor does (`ok    `, `fix   `, `note  `; exit 1 when anything is a fix).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { HOOKS, type Proc, read, runCode, sh, tmp, write, writeExe } from "./support.ts";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(process.env.GH_LOG as string, a.join(" ") + "\n");
if (a[0] !== "api") process.exit(0);
const rest = a.slice(1);
let path: string | null = null;
let method = "GET";
for (let i = 0; i < rest.length; ) {
  const x = rest[i] as string;
  if (x === "-X" || x === "--method") { method = rest[i + 1] as string; i += 2; }
  else if (["-H", "--jq", "-q", "--input", "-f", "-F"].includes(x)) i += 2;
  else if (x.startsWith("-")) i += 1;
  else { path = path ?? x; i += 1; }
}
if (method !== "GET") { process.stderr.write("fake gh: a write was attempted: " + a.join(" ") + "\n"); process.exit(1); }
const dbPath = process.env.GH_DB as string;
const db = JSON.parse(readFileSync(dbPath, "utf8")) as Record<string, unknown>;
const p = path as string;
const page2 = /[&?]page=([2-9])/.test(p);
const key = p.replace(/[&?]per_page=100/g, "").replace(/[&?]page=\d+/g, "");
if (key.endsWith("actions/runners") && "runners_seq" in db) { // answers in turn, the last one for ever (a restarting runner)
  const seq = db.runners_seq as unknown[];
  const nFile = dbPath + ".n";
  const n = existsSync(nFile) ? Number(readFileSync(nFile, "utf8")) : 0;
  writeFileSync(nFile, String(n + 1));
  console.log(JSON.stringify(seq[Math.min(n, seq.length - 1)])); process.exit(0);
}
if (key in db) { console.log(JSON.stringify(page2 ? [] : db[key])); process.exit(0); }
if (key.startsWith("repos/{owner}/{repo}/issues?")) { console.log("[]"); process.exit(0); }
process.stderr.write("gh: Not Found (HTTP 404)\n"); process.exit(1);
`;

/** What `factory doctor` does with these checks: a report printed line by line, exit 1 on any fix. */
const DRIVER = `
import { load } from ${JSON.stringify(join(HOOKS, "factory_config.ts"))};
import { checks } from ${JSON.stringify(join(HOOKS, "factory_doctor_ci.ts"))};
let fixes = 0;
const r = {
  ok: (what: string) => console.log("ok    " + what),
  fix: (what: string, how: string) => { fixes += 1; console.log("fix   " + what + ": " + how); },
  note: (what: string, how: string) => console.log("note  " + what + ": " + how),
};
checks(r, load());
console.log();
console.log(fixes ? fixes + " to fix." : "All the checks pass.");
process.exitCode = fixes ? 1 : 0;
`;

const P = "repos/{owner}/{repo}/";
type Row = Record<string, unknown>;
const OK_RUN = { workflow_runs: [{ name: "ci", conclusion: "success", status: "completed", html_url: "https://x/runs/1", head_sha: "a".repeat(40) }] };
const BAD_RUN = { workflow_runs: [{ name: "ci", conclusion: "failure", status: "completed", html_url: "https://x/runs/9", head_sha: "b".repeat(40) }] };

function runner(name: string, labels: string[], status = "online"): Row {
  return { name, status, labels: labels.map((l) => ({ name: l })) };
}

function agentIssue(n: number, name: string, status: string, minutesAgo: number, state = "open"): Row {
  const ping = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { number: n, title: `Agent: ${name} · ${status}`, state, labels: [{ name: "factory:agent" }],
    body: `<!-- factory-agent name=${name} status=${status} ping=${ping} -->` };
}

function taskIssue(n: number, agent: string): Row {
  return { number: n, title: `Task ${n}`, state: "open", body: "", labels: [{ name: "factory:in-progress" }, { name: "agent:" + agent }] };
}

function run(o: { db?: Row; cfg?: Row; files?: Record<string, string>; runs?: Row; env?: Record<string, string> } = {}): [Proc, string] {
  const d = tmp();
  sh(["git", "init", "-q", "-b", "main", d]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu"], ...(o.cfg ?? {}) }));
  write(join(d, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
  for (const [name, text] of Object.entries(o.files ?? {})) write(join(d, name), text);
  const scratch = tmp();
  const bin = join(scratch, "bin");
  writeExe(join(bin, "gh"), FAKE_GH);
  const db = { user: { login: "me" }, "repos/{owner}/{repo}": {}, [P + "actions/runs?branch=main&per_page=1"]: o.runs ?? OK_RUN, ...(o.db ?? {}) };
  write(join(scratch, "db.json"), JSON.stringify(db));
  const log = write(join(scratch, "log"), "");
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: tmp(),
    GH_DB: join(scratch, "db.json"), GH_LOG: log, FACTORY_AGENTS: "taytu", CLAUDE_PROJECT_DIR: d,
    FACTORY_DOCTOR_RUNNER_WAIT: "0", ...(o.env ?? {}) }; // 0: no waiting for a restarting runner, unless a test says
  delete env.FACTORY_AGENT;
  const p = runCode(DRIVER, { cwd: d, env, timeoutMs: 60_000 });
  return [p, read(log)];
}

function mine(p: Proc, kind: string, word: string): string[] {
  return p.stdout.split("\n").filter((l) => l.startsWith(kind) && l.includes(word));
}

function variables(kw: Record<string, string>): Row {
  return { [P + "actions/variables"]: { variables: Object.entries(kw).map(([name, value]) => ({ name, value })) } };
}

const count = (text: string, word: string): number => text.split(word).length - 1;

// --- (1) runs-on variables and runners --------------------------------------------------------------------------------

test("a runs-on variable with no online runner of that label is a fix that names the label and the way out", () => {
  const [p] = run({ db: { ...variables({ CI_RUNS_ON_LIGHT: '["self-hosted","sandbox-light"]' }),
    [P + "actions/runners"]: { runners: [runner("a", ["self-hosted", "sandbox-heavy"])] } } });
  const fixes = mine(p, "fix", "CI_RUNS_ON_LIGHT");
  expect(fixes.length, p.stdout).toBeGreaterThan(0);
  expect(fixes[0]).toContain("sandbox-light");
  expect(fixes[0]).toContain("factory ci");
  expect(p.code).toBe(1);
});

test("an offline runner does not count", () => {
  const [p] = run({ db: { ...variables({ CI_RUNS_ON: '["self-hosted","x-local"]' }),
    [P + "actions/runners"]: { runners: [runner("a", ["self-hosted", "x-local"], "offline")] } } });
  expect(mine(p, "fix", "CI_RUNS_ON").length, p.stdout).toBeGreaterThan(0);
  expect(mine(p, "fix", "CI_RUNS_ON")[0]).toContain("x-local");
});

test("an online runner with the label is ok and github hosted needs no runner", () => {
  const [p] = run({ db: { ...variables({ CI_RUNS_ON: '["self-hosted","x-local"]', CI_RUNS_ON_LIGHT: '"ubuntu-latest"' }),
    [P + "actions/runners"]: { runners: [runner("a", ["self-hosted", "Linux", "x-local"])] } } });
  expect(mine(p, "ok", "CI_RUNS_ON ").length, p.stdout).toBeGreaterThan(0);
  expect(mine(p, "ok", "CI_RUNS_ON_LIGHT").length, p.stdout).toBeGreaterThan(0);
  expect(mine(p, "fix", "CI_RUNS_ON"), p.stdout).toEqual([]);
});

test("runners gh cannot read are a note not a fix", () => {
  const [p] = run({ db: variables({ CI_RUNS_ON: '["self-hosted","x-local"]' }) }); // no runners answer: needs admin
  expect(mine(p, "note", "runner").length, p.stdout).toBeGreaterThan(0);
  expect(mine(p, "fix", "CI_RUNS_ON"), p.stdout).toEqual([]);
});

test("a runner that is back within the wait is not reported", () => {
  // #246: the heavy runner container restarts after every job; doctor ran in the gap and reported a fix.
  const wanted = variables({ CI_RUNS_ON: '["self-hosted","x-local"]' });
  const gap = { runners: [] };
  const back = { runners: [runner("a", ["self-hosted", "x-local"])] };
  const [p, log] = run({ db: { ...wanted, runners_seq: [gap, gap, back] },
    env: { FACTORY_DOCTOR_RUNNER_WAIT: "5", FACTORY_DOCTOR_RUNNER_STEP: "0.1" } });
  expect(mine(p, "ok", "CI_RUNS_ON ").length, p.stdout).toBeGreaterThan(0);
  expect(mine(p, "fix", "CI_RUNS_ON"), p.stdout).toEqual([]);
  expect(count(log, "actions/runners"), log).toBe(3);
});

test("a runner that stays missing past the wait is still a fix", () => {
  const wanted = variables({ CI_RUNS_ON: '["self-hosted","x-local"]' });
  const [p, log] = run({ db: { ...wanted, runners_seq: [{ runners: [] }] },
    env: { FACTORY_DOCTOR_RUNNER_WAIT: "0.5", FACTORY_DOCTOR_RUNNER_STEP: "0.1" } });
  expect(mine(p, "fix", "CI_RUNS_ON").length, p.stdout).toBeGreaterThan(0);
  expect(mine(p, "fix", "CI_RUNS_ON")[0]).toContain("x-local");
  expect(count(log, "actions/runners"), "it looked again before giving up").toBeGreaterThan(1);
});

// --- (2) the newest run on main ----------------------------------------------------------------------------------------

test("a failed newest run on main is a fix with the run link", () => {
  const [p] = run({ runs: BAD_RUN });
  const fixes = mine(p, "fix", "main");
  expect(fixes.length, p.stdout).toBeGreaterThan(0);
  expect(fixes[0]).toContain("https://x/runs/9");
  expect(fixes[0]).toContain("failure");
  expect(p.code).toBe(1);
});

test("a green newest run on main is ok and no run yet is a note", () => {
  let [p] = run();
  expect(mine(p, "ok", "main").length, p.stdout).toBeGreaterThan(0);
  [p] = run({ runs: { workflow_runs: [] } });
  expect(mine(p, "note", "main").length, p.stdout).toBeGreaterThan(0);
  expect(mine(p, "fix", "main"), p.stdout).toEqual([]);
});

// --- (3) stale claims and agent issues for agents that never ran -----------------------------------------------------

const ISSUES = "repos/{owner}/{repo}/issues?state=all&labels=factory:agent";

test("an in progress issue held by a down agent is a note with the release command", () => {
  const db = { [ISSUES]: [agentIssue(4, "menelik", "down", 600)], [P + "issues?state=open&labels=factory:in-progress"]: [taskIssue(30, "menelik")],
    [P + "issues?state=open&labels=factory:agent"]: [agentIssue(4, "menelik", "down", 600)] };
  const [p] = run({ db, cfg: { tasks: { source: "issues" }, agents: ["taytu", "menelik"] } });
  const notes = mine(p, "note", "#30");
  expect(notes.length, p.stdout).toBeGreaterThan(0);
  expect(notes[0]).toContain("menelik");
  expect(notes[0]).toContain("factory issues release 30");
  expect(p.code, "a stale claim is a note, not a fix").toBe(0);
});

test("an open agent issue for a name that is not configured is a note", () => {
  const old = agentIssue(11, "ghost", "idle", 5000);
  const [p] = run({ db: { [ISSUES]: [old], [P + "issues?state=open&labels=factory:agent"]: [old] }, cfg: { tasks: { source: "issues" } } });
  const notes = mine(p, "note", "#11");
  expect(notes.length, p.stdout).toBeGreaterThan(0);
  expect(notes[0]).toContain("ghost");
  expect(notes[0]).toContain("close");
});

// --- (4) the workflow against factory.json ---------------------------------------------------------------------------

const PNPM_CI = "name: ci\njobs:\n  test:\n    steps:\n      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v4\n" +
  "      - run: pnpm install --frozen-lockfile\n      - run: pnpm test\n";

test("a pnpm workflow in a project without package json is a fix naming the files", () => {
  const [p] = run({ files: { ".github/workflows/ci.yml": PNPM_CI }, cfg: { commands: { test: "bun test" } } });
  const fixes = mine(p, "fix", "ci.yml");
  expect(fixes.length, p.stdout).toBeGreaterThan(0);
  expect(fixes[0]).toContain("package.json");
  expect(fixes[0]).toContain("commands.test");
});

test("a workflow that runs a command factory json leaves empty is a fix", () => {
  const [p] = run({ files: { ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: pnpm test\n", "package.json": "{}" } });
  const fixes = mine(p, "fix", "commands.test");
  expect(fixes.length, p.stdout).toBeGreaterThan(0);
  expect(fixes[0]).toContain("pnpm test");
});

test("a matching workflow and no workflow are quiet", () => {
  let [p] = run({ files: { ".github/workflows/ci.yml": PNPM_CI, "package.json": '{"packageManager": "pnpm@9.0.0"}', ".nvmrc": "22\n" },
    cfg: { commands: { test: "pnpm test" } } });
  expect(mine(p, "fix", "ci.yml"), p.stdout).toEqual([]);
  expect(mine(p, "fix", "commands."), p.stdout).toEqual([]);
  [p] = run();
  expect(mine(p, "fix", "ci.yml"), p.stdout).toEqual([]);
});

// --- read-only --------------------------------------------------------------------------------------------------------

test("doctor only reads from github", () => {
  const [, log] = run({ db: { ...variables({ CI_RUNS_ON: '["self-hosted","x"]' }), [P + "actions/runners"]: { runners: [] } },
    cfg: { tasks: { source: "issues" } } });
  const calls = log.split("\n").filter((l) => l.startsWith("api"));
  expect(calls.length, log).toBeGreaterThan(0);
  expect(calls.filter((l) => ["-X POST", "-X PATCH", "-X PUT", "-X DELETE", "--input"].some((w) => l.includes(w))), log).toEqual([]);
});
