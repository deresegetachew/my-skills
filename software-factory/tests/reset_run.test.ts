// `factory reset-run` (#229): lists what an earlier run left in this project, and with --apply cleans it. A fake gh and a
// fake docker record every call, so the tests show that the plan changes nothing, that --apply does each step and only this
// project's own, and that a second run finds nothing. A down agent of another machine is left alone unless named (#236).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CI, HOOKS, SF, envWith, readmeAndWiki, sh, tmp, write, writeExe, type Proc } from "./support.ts";

const GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(process.env.CALLS as string, "gh " + a.join(" ") + "\n");
const dbPath = process.env.DB as string; const db: any = JSON.parse(readFileSync(dbPath, "utf8"));
if (a[0] !== "api") process.exit(1);
const method = a.includes("-X") ? a[a.indexOf("-X") + 1] as string : "GET";
const path = a.slice(1).filter((x) => !x.startsWith("-") && ![method, "Accept: application/vnd.github+json", "-"].includes(x))[0] as string;
const body: any = a.includes("--input") ? JSON.parse(readFileSync(0, "utf8")) : {};
const p = path.replace("repos/{owner}/{repo}/", "").split("?")[0] as string; const q = path.includes("?") ? path.split("?")[1] as string : "";
function out(x: unknown): never { writeFileSync(dbPath, JSON.stringify(db)); console.log(JSON.stringify(x)); process.exit(0); }
if (p === "user") out({ login: "me" });
if (p === "issues") out(q.includes("page=2") ? [] : db.issues.filter(() => q.includes("labels=factory:agent")));
let m = /^issues\/(\d+)$/.exec(p);
if (m && method === "PATCH") { const i = db.issues.find((i: any) => i.number === Number(m![1])); Object.assign(i, body); out(i); }
if (p === "actions/runners" && method === "GET") out({ runners: db.runners });
m = /^actions\/runners\/(\d+)$/.exec(p);
if (m && method === "DELETE") { db.runners = db.runners.filter((r: any) => r.id !== Number(m![1])); out({}); }
if (p === "actions/variables") out({ variables: db.variables });
m = /^actions\/variables\/(\w+)$/.exec(p);
if (m && method === "DELETE") { db.variables = db.variables.filter((v: any) => v.name !== m![1]); out({}); }
console.error("fake gh: no route for " + method + " " + p); process.exit(1);
`;

const DOCKER = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(process.env.CALLS as string, "docker " + a.join(" ") + "\n");
const dbPath = process.env.DB as string; const db: any = JSON.parse(readFileSync(dbPath, "utf8"));
if (a[0] === "ps") for (const c of db.containers) console.log([c.id, c.name, c.project].join("\t"));
if (a[0] === "rm") { db.containers = db.containers.filter((c: any) => c.id !== a[1]); writeFileSync(dbPath, JSON.stringify(db)); }
`;

type Row = Record<string, any>;
type Env = Record<string, string | undefined>;

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function agentIssue(n: number, name: string, st: string, minutesAgo: number, machine = ""): Row {
  return { number: n, title: `Agent: ${name} · ${st}`, state: "open", labels: [{ name: "factory:agent" }],
    body: `<!-- factory-agent name=${name} status=${st} ping=${iso(minutesAgo)}${machine ? ` machine=${machine}` : ""} -->\n` };
}

function world(extraIssues: Row[] = []): [string, Env] {
  const d = tmp();
  sh(["git", "init", "-q", "-b", "main", d]);
  mkdirSync(join(d, ".claude"), { recursive: true });
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  symlinkSync(CI, join(d, ".claude", "ci"));
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"], tasks: { source: "issues" },
    ci: { repo: "acme/widget" } }));
  write(join(d, ".git", "factory", "claims.json"), JSON.stringify({ checkouts: { menelik: { pid: 2 ** 22 + 12345, host: hostname(),
    path: d, at: 1 } }, tasks: {} }));
  writeExe(join(d, "bin", "gh"), GH);
  writeExe(join(d, "bin", "docker"), DOCKER);
  const db = {
    issues: [agentIssue(4, "ghost", "idle", 60 * 24 * 3), agentIssue(11, "menelik", "down", 600), agentIssue(12, "taytu", "idle", 1),
      ...extraIssues],
    runners: [{ id: 7, name: "widget-ci-old", status: "offline", busy: false, labels: [{ name: "self-hosted" }] },
      { id: 8, name: "other-ci-old", status: "offline", busy: false, labels: [] },
      { id: 9, name: "widget-ci-live", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "widget-local" }] }],
    variables: [{ name: "CI_RUNS_ON_LIGHT", value: '["self-hosted","widget-light"]' },
      { name: "CI_RUNS_ON", value: '["self-hosted","widget-local"]' }],
    containers: [{ id: "c1", name: "widget-ci-runner-1", project: "widget-ci" }, { id: "c2", name: "unrelated", project: "otherproj" },
      { id: "c3", name: "widget-ci-light-runner", project: "widget-ci-light" }, { id: "c4", name: "lookalike", project: "widget-ci-extra" }],
  };
  writeFileSync(join(d, "db.json"), JSON.stringify(db));
  const env = envWith(join(d, "bin"), { DB: join(d, "db.json"), CALLS: join(d, "calls.log"), FACTORY_AGENT: undefined,
    FACTORY_AGENTS: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_CONFIG_DIR: join(d, "config"), FACTORY_MACHINE_ID: "this-machine",
    XDG_STATE_HOME: join(d, "state") });
  return [d, env];
}

function runIt(d: string, env: Env, ...args: string[]): Proc {
  return sh([process.execPath, "--no-env-file", join(d, ".claude", "hooks", "factory_reset_run.ts"), ...args], { cwd: d, env, timeoutMs: 90_000 });
}

function db(d: string): Row {
  return JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as Row;
}

function calls(d: string): string[] {
  const p = join(d, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l) : [];
}

function writes(d: string): string[] {
  return calls(d).filter((c) => c.includes("-X PATCH") || c.includes("-X DELETE") || c.startsWith("docker rm"));
}

const claimsFile = (d: string): string => readFileSync(join(d, ".git", "factory", "claims.json"), "utf8");

test("without apply it prints the plan and changes nothing", () => {
  const [d, env] = world();
  const before = [JSON.stringify(db(d)), claimsFile(d)];
  const p = runIt(d, env);
  expect(p.code, p.out).toBe(0);
  for (const what of ["release the claims of menelik", "close Agent issue #4", "close Agent issue #11",
    "remove the exited container widget-ci-runner-1", "remove the exited container widget-ci-light-runner",
    "remove the offline runner widget-ci-old", "delete CI_RUNS_ON_LIGHT"]) {
    expect(p.stdout).toContain(what);
  }
  expect(p.stdout).toContain("plan");
  expect(p.stdout).toContain("--apply");
  expect(writes(d)).toEqual([]);
  expect([JSON.stringify(db(d)), claimsFile(d)]).toEqual(before);
});

test("apply does each step and only this projects own", () => {
  const [d, env] = world();
  const p = runIt(d, env, "--apply");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split("done,").length - 1, p.stdout).toBe(7);
  const after = db(d);
  expect(Object.fromEntries((after.issues as Row[]).map((i) => [i.number, i.state]))).toEqual({ 4: "closed", 11: "closed", 12: "open" }); // the live agent stays
  expect((after.runners as Row[]).map((r) => r.id)).toEqual([8, 9]); // another project's offline runner and the online one stay
  expect((after.variables as Row[]).map((v) => v.name)).toEqual(["CI_RUNS_ON"]); // the one with an online runner stays
  expect((after.containers as Row[]).map((c) => c.id)).toEqual(["c2", "c4"]); // another project's and a lookalike stay
  expect((JSON.parse(claimsFile(d)) as Row).checkouts).toEqual({});
});

test("a second apply changes nothing", () => {
  const [d, env] = world();
  runIt(d, env, "--apply");
  const n = writes(d).length;
  const p = runIt(d, env, "--apply");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Nothing to reset.");
  expect(p.stdout).not.toContain("done,");
  expect(writes(d).length).toBe(n);
});

test("a signed out gh is a plain error with a fix and nothing changes", () => {
  const [d, env] = world();
  writeExe(join(d, "bin", "gh"), "#!/bin/sh\necho 'gh: run gh auth login' >&2\nexit 1\n");
  const p = runIt(d, env, "--apply");
  const err = JSON.parse(p.stderr.trim().split("\n").at(-1) as string) as Row;
  expect(p.code, p.out).toBe(1);
  expect(err.code).toBe("github-failed");
  expect(err.fix).toContain("gh auth login");
  expect(writes(d)).toEqual([]);
  expect(db(d).containers.length).toBe(4);
});

test("an unknown option is refused before anything runs", () => {
  const [d, env] = world();
  const p = runIt(d, env, "--force");
  expect(p.code, p.out).toBe(1);
  expect((JSON.parse(p.stderr) as Row).code).toBe("usage");
  expect(calls(d)).toEqual([]);
});

test("the command is in factory help and the readme table", () => {
  const help = sh(["bash", join(SF, "factory"), "help"]).stdout;
  expect(help).toContain("reset-run");
  expect(help).toContain("--apply");
  expect(readmeAndWiki()).toContain("`factory reset-run [--apply]`");
});

// --- #236: a down agent of another machine ------------------------------------------------------------------------------

test("a down agent of another machine is left alone", () => {
  // haile runs on another machine and is only offline there: nothing may change for it.
  const [d, env] = world([agentIssue(20, "haile", "down", 600, "other-machine")]);
  const plan = runIt(d, env);
  expect(plan.code, plan.out).toBe(0);
  expect(plan.stdout).not.toContain("close Agent issue #20");
  expect(plan.stdout).toContain("left Agent issue #20 open");
  expect(plan.stdout).toContain("--agent haile");
  const p = runIt(d, env, "--apply");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).not.toContain("close Agent issue #20");
  const after = Object.fromEntries((db(d).issues as Row[]).map((i) => [i.number, i.state]));
  expect(after[20]).toBe("open");
  expect(after[11]).toBe("closed"); // this machine's own down agent (its issue names no machine) still goes
  expect(writes(d).some((w) => w.includes("issues/20"))).toBe(false);
});

test("a down agent of another machine is closed when named or configured for this machine", () => {
  let [d, env] = world([agentIssue(20, "haile", "down", 600, "other-machine")]);
  let p = runIt(d, env, "--apply", "--agent", "haile");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("done, agent: close Agent issue #20");
  expect((db(d).issues as Row[]).find((i) => i.number === 20)?.state).toBe("closed");
  [d, env] = world([agentIssue(20, "haile", "down", 600, "other-machine")]);
  p = runIt(d, env, "--apply");
  expect((db(d).issues as Row[]).find((i) => i.number === 20)?.state).toBe("open");
  [d, env] = world([agentIssue(20, "haile", "down", 600, "other-machine")]);
  p = runIt(d, { ...env, FACTORY_AGENTS: "haile" }, "--apply"); // this machine is configured to run haile
  expect(p.stdout, p.out).toContain("done, agent: close Agent issue #20");
  [d, env] = world([agentIssue(20, "haile", "down", 600, "this-machine")]); // its issue names this machine
  p = runIt(d, env, "--apply");
  expect(p.stdout, p.out).toContain("done, agent: close Agent issue #20");
});
