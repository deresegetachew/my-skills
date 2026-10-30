// Rework claims every machine sees (#355): starting a PR's rework posts a `factory-rework-claim` comment on the PR, a
// loop skips a PR another agent holds, the claim is released when the run ends and expires after `claimStaleHours`, and
// `factory claims list` and the cockpit's Pull requests view show who holds it. Two machines are two project folders
// (two state folders) with their own FACTORY_MACHINE_ID and one fake GitHub.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CI, envWith, gitRepo, HOOKS, runHook, SF, sh, tmp, write, writeExe } from "./support.ts";
import { type Db, type Env, FAKE_GH, issue, loadDb, nextTask, pull, run, saveDb, setup } from "./issues_support.ts";

const T = 120_000;
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const PID = String(process.pid); // a live process, so the local claim holds while the test runs

function iso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** PR #5 with a trusted must-fix on its head: rework for whoever picks next. */
function withRework(db: string, after: NonNullable<Db["comments"]>[string] = []): void {
  const data = loadDb(db);
  data.pulls = [{ number: 5, title: "Add truncate", labels: [], head: { sha: HEAD, ref: "task/5-x" } }];
  data.comments = { 5: [{ body: `<!-- factory-mustfix sha=${HEAD.slice(0, 7)} -->\nFix it.`, at: 1 }, ...after] };
  saveDb(db, data);
}

function machine(env: Env, id: string, db?: string): Env {
  return { ...env, FACTORY_MACHINE_ID: id, FACTORY_CLAIM_SETTLE_SECONDS: "0", ...(db ? { FAKE_GH_DB: db } : {}) };
}

function pick(d: string, env: Env, agent: string): string {
  const [rc, out, err] = nextTask(d, env, "--claim", agent, "--pid", PID);
  expect([0, 1], `${out}\n${err}`).toContain(rc);
  return out;
}

function bodies(db: string): string[] {
  return (loadDb(db).comments?.["5"] ?? []).map((c) => c.body);
}

function claimsOn(db: string): string[] {
  return bodies(db).filter((b) => b.includes("factory-rework-claim"));
}

function claim(agent: string, mach: string, sha: string, until: string): { body: string; at: number } {
  return { body: `<!-- factory-rework-claim agent=${agent} machine=${mach} host=dev-pc sha=${sha} until=${until} -->`, at: 2 };
}

// --- two machines, one PR ----------------------------------------------------------------------------------------

test("two agents on two machines can't both start the rework of one PR", () => {
  const [d1, db, e1] = setup([]);
  const [d2, , e2] = setup([]);
  withRework(db);
  expect(pick(d1, machine(e1, "mach-a"), "haile")).toBe("pr-5 Rework #5: Add truncate (task/5-x)");
  expect(pick(d2, machine(e2, "mach-b", db), "menelik"), "the other machine skips the held PR").toBe("none");
  const claims = claimsOn(db);
  expect(claims.length, bodies(db).join("\n")).toBe(1);
  expect(claims[0]).toContain("agent=haile");
  expect(claims[0]).toContain("machine=mach-a");
  expect(claims[0]).toContain(`sha=${HEAD}`);
  expect(claims[0]).toMatch(/until=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/);
}, T);

test("two agents on one machine can't both start the rework of one PR, in one clone or in two", () => {
  const [d1, db, e1] = setup([]);
  withRework(db);
  expect(pick(d1, machine(e1, "mach-a"), "haile")).toBe("pr-5 Rework #5: Add truncate (task/5-x)");
  expect(pick(d1, machine(e1, "mach-a"), "menelik"), "same clone").toBe("none");
  const [d2, , e2] = setup([]);
  expect(pick(d2, machine(e2, "mach-a", db), "taytu"), "another clone on the same machine").toBe("none");
  expect(claimsOn(db).length).toBe(1);
}, T);

test("the agent that holds the claim picks its rework again without a second claim", () => {
  const [d1, db, e1] = setup([]);
  withRework(db);
  pick(d1, machine(e1, "mach-a"), "haile");
  expect(pick(d1, machine(e1, "mach-a"), "haile")).toBe("pr-5 Rework #5: Add truncate (task/5-x)");
  expect(claimsOn(db).length).toBe(1);
}, T);

test("a claim another machine holds stops a restarted agent too", () => {
  // remanual, 2026-10-29: menelik was stopped and restarted and took #511 again while haile was on it
  const [d, db, env] = setup([]);
  withRework(db, [claim("haile", "mach-a", HEAD, iso(3600))]);
  expect(pick(d, machine(env, "mach-b"), "menelik")).toBe("none");
  expect(claimsOn(db).length, "no claim posted on a held PR").toBe(1);
}, T);

// --- release and expiry ------------------------------------------------------------------------------------------

test("releasing the agent's claims at the end of a run frees the rework for another machine", () => {
  const [d1, db, e1] = setup([]);
  const [d2, , e2] = setup([]);
  withRework(db);
  pick(d1, machine(e1, "mach-a"), "haile");
  const r = runHook("factory_claims", ["release", "--agent", "haile", "--tasks-only"], { cwd: d1, env: machine(e1, "mach-a") });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("pr-5");
  const released = bodies(db).filter((b) => b.includes("factory-rework-release"));
  expect(released.length, bodies(db).join("\n")).toBe(1);
  expect(released[0]).toContain("agent=haile");
  expect(pick(d2, machine(e2, "mach-b", db), "menelik")).toBe("pr-5 Rework #5: Add truncate (task/5-x)");
}, T);

test("a release posts nothing when the agent holds no rework claim", () => {
  const [d1, db, e1] = setup([]);
  withRework(db);
  const before = bodies(db).length;
  const r = runHook("factory_claims", ["release", "--agent", "haile", "--tasks-only"], { cwd: d1, env: machine(e1, "mach-a") });
  expect(r.code, r.out).toBe(0);
  expect(bodies(db).length).toBe(before);
}, T);

test("an expired claim doesn't hold the PR", () => {
  const [d, db, env] = setup([]);
  withRework(db, [claim("haile", "mach-a", HEAD, iso(-60))]);
  expect(pick(d, machine(env, "mach-b"), "menelik")).toBe("pr-5 Rework #5: Add truncate (task/5-x)");
}, T);

test("a claim never lasts longer than claimStaleHours after it was posted, whatever its until says", () => {
  const [d, db, env] = setup([]);
  const old = { ...claim("haile", "mach-a", HEAD, iso(30 * 24 * 3600)), created_at: iso(-7 * 3600) };
  withRework(db, [old]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik", "haile"], claimStaleHours: 6 }));
  expect(pick(d, machine(env, "mach-b"), "menelik")).toBe("pr-5 Rework #5: Add truncate (task/5-x)");
}, T);

test("a claim on an older head doesn't hold the new must-fix", () => {
  const [d, db, env] = setup([]);
  withRework(db, [claim("haile", "mach-a", OLD_HEAD, iso(3600))]);
  expect(pick(d, machine(env, "mach-b"), "menelik")).toBe("pr-5 Rework #5: Add truncate (task/5-x)");
}, T);

test("losing a simultaneous claim takes nothing and gives the losing claim back", () => {
  // the fake GitHub lands haile's claim just before menelik's, as two machines posting in the same second would
  const [d, db, env] = setup([]);
  withRework(db);
  const race = FAKE_GH.replace('if (method === "POST") { cs.push(',
    'if (method === "POST") { if (process.env.FAKE_RACE && String(body.body).includes("factory-rework-claim")) cs.push({ body: process.env.FAKE_RACE, at: 0 }); cs.push(');
  expect(race).not.toBe(FAKE_GH);
  writeExe(join(d, "bin", "gh"), race);
  const first = claim("haile", "mach-a", HEAD, iso(3600)).body;
  expect(pick(d, { ...machine(env, "mach-b"), FAKE_RACE: first }, "menelik")).toBe("none");
  const all = bodies(db);
  expect(all.some((b) => b.includes("factory-rework-release") && b.includes("agent=menelik")), all.join("\n")).toBe(true);
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const [d2, , e2] = setup([]);
  expect(pick(d2, machine(e2, "mach-c", db), "taytu"), "haile still holds it").toBe("none");
}, T);

// --- GitHub refuses the claim ------------------------------------------------------------------------------------

/** The fake GitHub, failing with `said` when a rework claim is posted. */
function refusingClaims(d: string, said: string): void {
  const gh = FAKE_GH.replace('if (method === "POST") { cs.push(',
    `if (method === "POST" && String(body.body).includes("factory-rework-claim")) fail(${JSON.stringify(said)}); if (method === "POST") { cs.push(`);
  expect(gh).not.toBe(FAKE_GH);
  writeExe(join(d, "bin", "gh"), gh);
}

test("when GitHub refuses the rework claim, the pick lets that rework go and takes the next job", () => {
  const [d, db, env] = setup([issue(7)]);
  withRework(db);
  refusingClaims(d, "gh: Validation Failed (HTTP 422)");
  const [rc, out, err] = nextTask(d, machine(env, "mach-a"), "--claim", "haile", "--pid", PID);
  expect(rc, `${out}\n${err}`).toBe(0);
  expect(out).toMatch(/^issue-7 /);
  expect(err).toContain("#5");
  const r = runHook("factory_claims", ["list"], { cwd: d, env: machine(env, "mach-a") });
  expect(r.stdout, "the local claim on pr-5 was let go").not.toContain("pr-5");
}, T);

test("when GitHub is busy while claiming a rework, the pick stops with the busy code", () => {
  const [d, db, env] = setup([issue(7)]);
  withRework(db);
  refusingClaims(d, "gh: API rate limit exceeded (HTTP 429)");
  const [rc, out, err] = nextTask(d, machine(env, "mach-a"), "--claim", "haile", "--pid", PID);
  expect(rc, `${out}\n${err}`).toBe(4);
  const r = runHook("factory_claims", ["list"], { cwd: d, env: machine(env, "mach-a") });
  expect(r.stdout, "the local claim on pr-5 was let go").not.toContain("pr-5");
}, T);

test("factory_issues.ts show leaves rework claims and releases out, as it does other factory comments", () => {
  const [d, db, env] = setup([pull(5)]);
  withRework(db, [claim("haile", "mach-a", HEAD, iso(3600)),
    { body: "<!-- factory-rework-release agent=haile machine=mach-a -->\n**haile** stopped reworking this.", at: 3 }]);
  const [rc, out] = run(d, env, "show", "5");
  expect(rc, out).toBe(0);
  expect(out).not.toContain("factory-rework-claim");
  expect(out).not.toContain("factory-rework-release");
}, T);

// --- what people see ---------------------------------------------------------------------------------------------

test("factory claims list shows a rework claim with its agent and machine", () => {
  const [d, db, env] = setup([]);
  withRework(db);
  pick(d, machine(env, "mach-a"), "haile");
  const r = runHook("factory_claims", ["list"], { cwd: d, env: machine(env, "mach-a") });
  expect(r.code, r.out).toBe(0);
  const line = r.stdout.split("\n").find((l) => l.startsWith("rework"));
  expect(line, r.stdout).toBeDefined();
  expect(line).toContain("pr-5");
  expect(line).toContain("haile");
  expect(line).toContain(hostname().replace(/[^\w.-]/g, "-"));
  expect(line).toContain("mach-a");
}, T);

test("factory claims list shows another machine's rework claim", () => {
  const [d, db, env] = setup([]);
  withRework(db, [claim("haile", "mach-a", HEAD, iso(3600))]);
  const r = runHook("factory_claims", ["list"], { cwd: d, env: machine(env, "mach-b") });
  const line = r.stdout.split("\n").find((l) => l.startsWith("rework"));
  expect(line, r.stdout).toBeDefined();
  expect(line).toContain("haile");
  expect(line).toContain("dev-pc");
}, T);

// The cockpit's Pull requests view, with a fake gh that answers from a scenario (as cockpit_prs.test.ts does).
const COCKPIT_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.COCKPIT_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] !== "api") { console.log("ok"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const short = raw.replace("repos/{owner}/{repo}/", "").replace(/^repos\/o\/r(\/|$)/, (_m, slash) => slash ? "" : "repo");
const path = new URL(short, "http://x/").pathname.slice(1);
if (path in s) out(s[path]);
if (path.startsWith("issues/") && path.endsWith("/comments")) out([]);
if (path.endsWith("/files")) out([]);
console.error("gh: Not Found (HTTP 404)"); process.exit(1);
`;

test("the cockpit's Pull requests view says who is reworking a PR, and on which machine", () => {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik", "haile"] }));
  const old = "2020-01-01T00:00:00Z";
  const scenario = {
    issues: [],
    pulls: [{ number: 13, title: "Task 8: the exporter", draft: false, html_url: "https://github.com/o/r/pull/13", body: "Closes #8",
      head: { sha: HEAD, ref: "task/8-exporter" }, labels: [{ name: "agent:haile" }] }],
    [`commits/${HEAD}`]: { commit: { committer: { date: old } } },
    [`commits/${HEAD}/check-runs`]: { check_runs: [{ name: "check", status: "completed", conclusion: "success" }] },
    "issues/13/comments": [
      { body: `<!-- factory-mustfix sha=${HEAD.slice(0, 12)} -->\nfix it`, user: { login: "dm" }, created_at: old },
      { body: `${claim("haile", "mach-a", HEAD, iso(3600)).body}\nhaile is reworking it.`, user: { login: "dm" }, created_at: iso(-60) },
    ],
    repo: { default_branch: "main" },
  };
  write(join(root, "bin", "gh"), COCKPIT_GH, 0o755);
  writeFileSync(join(root, "scenario.json"), JSON.stringify(scenario));
  for (const sub of ["state", "home"]) mkdirSync(join(root, sub));
  const env = envWith(join(root, "bin"), { COCKPIT_SCENARIO: join(root, "scenario.json"), XDG_STATE_HOME: join(root, "state"),
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), FACTORY_AGENT: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: undefined,
    FACTORY_COCKPIT_CACHE_SECONDS: undefined, TMUX: undefined, NO_COLOR: undefined, COLUMNS: "160", LINES: "40" });
  const r = sh(["bash", join(SF, "factory"), "cockpit", "--prs", "13"], { cwd: d, env, timeoutMs: 100_000 });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/haile on dev-pc .*reworking/);
}, T);
