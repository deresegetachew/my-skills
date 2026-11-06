// #371: the factory counts its own GitHub calls (per machine) and `factory usage --github` shows the last hour's.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, envWith, git, gitRepo, runBun, runHook, sh, tmp, write, writeExe } from "./support.ts";

const T = 1_793_000_000; // a fixed "now", on the hour or not, it doesn't matter

/** A fake `gh` that answers `{}` to everything, and a script that makes the gh calls it is given (one per argument,
 * words split on spaces) through the factory's own run(). */
function setup(): { bin: string; state: string; script: string } {
  const dir = tmp();
  const bin = join(dir, "bin");
  writeExe(join(bin, "gh"), `#!/usr/bin/env bash
case "$*" in
  *rate_limit*) echo '{"resources":{"core":{"limit":5000,"remaining":4321,"reset":${T + 1800}}}}' ;;
  "pr view"*) echo MERGED ;;
  *) echo '{}' ;;
esac
`);
  const script = write(join(dir, "my_cmd.ts"), `import { gh } from ${JSON.stringify(join(HOOKS, "factory_lib.ts"))};
for (const call of process.argv.slice(3)) gh(call.split(" "));
`);
  return { bin, state: join(dir, "state"), script };
}

function calls(s: ReturnType<typeof setup>, cwd: string, agent: string | undefined, now: number, ...gh: string[]): void {
  callsAs(s, cwd, { FACTORY_AGENT: agent }, now, ...gh);
}

/** The same, with the agent's environment given whole (FACTORY_AGENT, FACTORY_ROLE). */
function callsAs(s: ReturnType<typeof setup>, cwd: string, who: Record<string, string | undefined>, now: number, ...gh: string[]): void {
  mkdirSync(cwd, { recursive: true });
  const p = runBun(s.script, ["list", ...gh], { cwd, env: envWith(s.bin, { XDG_STATE_HOME: s.state, FACTORY_AGENT: undefined,
    FACTORY_ROLE: undefined, ...who, FACTORY_NOW: String(now) }) });
  expect(p.code, p.out).toBe(0);
}

interface Report {
  total: number;
  agents: Record<string, number>;
  commands: Record<string, number>;
  endpoints: Record<string, number>;
}

function report(s: ReturnType<typeof setup>, ...args: string[]) {
  return runHook("factory_usage", ["--github", ...args], { cwd: tmp(), env: envWith(s.bin, { XDG_STATE_HOME: s.state,
    FACTORY_NOW: String(T) }) });
}

/** A project `proj` and an agent's worktree of it, `proj-agents/haile`. */
function project(): { main: string; agent: string } {
  const main = join(tmp(), "proj");
  mkdirSync(main);
  gitRepo(main);
  const agent = join(main + "-agents", "haile");
  git(main, "worktree", "add", "-q", "--detach", agent);
  return { main, agent };
}

test("each gh call is counted by agent, command and endpoint; auth and rate_limit are not", () => {
  const s = setup();
  const { main, agent } = project();
  calls(s, agent, "haile", T - 60,
    "api repos/{owner}/{repo}/issues/12/comments", "api --paginate repos/{owner}/{repo}/issues/13/comments?since=x",
    "api -X POST repos/{owner}/{repo}/issues/12/comments -f body=hi", "pr view 5 --json number",
    "auth status", "api rate_limit");
  calls(s, main, undefined, T - 30, "api repos/{owner}/{repo}/pulls?state=open");
  const p = report(s, "--json");
  expect(p.code, p.out).toBe(0);
  const r = JSON.parse(p.stdout) as Report;
  expect(r.total).toBe(5);
  expect(r.agents).toEqual({ "haile (proj)": 4, "- (proj)": 1 });
  expect(r.commands).toEqual({ "my_cmd list": 5 });
  expect(r.endpoints).toEqual({ "issues/:n/comments": 2, "POST issues/:n/comments": 1, "pr view": 1, "pulls": 1 });
});

test("only the last hour counts, and the text lists the biggest first", () => {
  const s = setup();
  const cwd = project().main;
  calls(s, cwd, "taytu", T - 3_700, "api repos/{owner}/{repo}/issues", "api repos/{owner}/{repo}/issues");
  calls(s, cwd, "taytu", T - 100, "api repos/{owner}/{repo}/issues");
  calls(s, cwd, "menelik", T - 50, "api repos/{owner}/{repo}/pulls", "api repos/{owner}/{repo}/pulls");
  const r = JSON.parse(report(s, "--json").stdout) as Report;
  expect(r.total).toBe(3);
  expect(r.agents).toEqual({ "menelik (proj)": 2, "taytu (proj)": 1 });
  const p = report(s);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("3 GitHub calls in the last hour");
  expect(p.stdout.indexOf("menelik (proj)")).toBeGreaterThan(-1);
  expect(p.stdout.indexOf("menelik (proj)")).toBeLessThan(p.stdout.indexOf("taytu (proj)"));
});

test("no calls yet says so", () => {
  const s = setup();
  const p = report(s);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("No GitHub calls counted on this machine in the last hour");
});

test("hour files older than two days are removed when a new hour starts", () => {
  const s = setup();
  const cwd = project().main;
  calls(s, cwd, "haile", T - 3 * 86_400, "api user");
  const dir = join(s.state, "proj-factory", "github-calls");
  expect(readdirSync(dir).length).toBe(1);
  calls(s, cwd, "haile", T, "api user");
  const left = readdirSync(dir);
  expect(left.length).toBe(1);
  expect(existsSync(join(dir, left[0] as string))).toBe(true);
  expect(left[0]).toBe(`${new Date(T * 1000).toISOString().slice(0, 13)}.log`);
});

test("--github refuses the token options", () => {
  const s = setup();
  const p = report(s, "--task", "7");
  expect(p.code).toBe(2);
  expect(p.stderr).toContain("--github");
});

/** `factory status` (text, or `--json`) in `cwd`, at T, with no agent of its own. */
function status(s: ReturnType<typeof setup>, cwd: string, ...args: string[]) {
  return runHook("factory_status", args, { cwd, timeoutMs: 60_000, env: envWith(s.bin, { XDG_STATE_HOME: s.state,
    FACTORY_NOW: String(T), FACTORY_AGENT: undefined, FACTORY_ROLE: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined }) });
}

interface StatusCalls {
  total: number;
  agents: Record<string, number>;
  callers: { caller: string; calls: number }[];
  limit: { remaining: number; limit: number; reset: string } | null;
}

test("factory status shows the last hour's calls by agent, the top callers and what GitHub has left", () => {
  const s = setup();
  const { main, agent } = project();
  callsAs(s, agent, { FACTORY_AGENT: "haile" }, T - 600, "api repos/{owner}/{repo}/issues/12/comments",
    "api repos/{owner}/{repo}/issues/13/comments", "api repos/{owner}/{repo}/issues/14/comments");
  callsAs(s, main, { FACTORY_ROLE: "dev-manager" }, T - 300, "api repos/{owner}/{repo}/pulls", "pr view 5 --json number");
  callsAs(s, main, { FACTORY_AGENT: "taytu", FACTORY_ROLE: "coding-agent" }, T - 60, "api repos/{owner}/{repo}/pulls");
  callsAs(s, main, { FACTORY_AGENT: "taytu" }, T - 4_000, "api repos/{owner}/{repo}/pulls"); // over an hour ago
  const p = status(s, main, "--json");
  expect(p.code, p.out).toBe(0);
  const g = (JSON.parse(p.stdout) as { githubCalls: StatusCalls }).githubCalls;
  expect(g.agents["haile (proj)"]).toBe(3);
  expect(g.agents["dev-manager (proj)"], "a role's loop without a name is counted by its role").toBe(2);
  expect(g.agents["taytu (proj)"]).toBe(1);
  expect(g.callers[0]).toEqual({ caller: "my_cmd list: issues/:n/comments", calls: 3 });
  expect(g.callers.length).toBeLessThanOrEqual(5);
  expect(g.limit).toEqual({ remaining: 4321, limit: 5000, reset: new Date((T + 1800) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") });
  const text = status(s, main);
  expect(text.code, text.out).toBe(0);
  expect(text.stdout).toContain("GitHub calls (this machine, last hour)");
  expect(text.stdout).toContain("GitHub has 4321 of 5000 left");
  expect(text.stdout).toMatch(/by agent: .*haile \(proj\) 3/);
  expect(text.stdout).toContain("top callers:");
  expect(text.stdout).toContain("my_cmd list: issues/:n/comments");
});

test("the web UI's own gh calls are counted too", () => {
  const s = setup();
  const { main } = project();
  const script = write(join(tmp(), "ui_call.ts"), `import { spawn } from ${JSON.stringify(join(HOOKS, "factory_ui_data.ts"))};
const env = { ...process.env, FACTORY_AGENT: "" } as Record<string, string>;
const r = await spawn(["gh", "api", "repos/{owner}/{repo}/issues/7/comments"], process.cwd(), env, 10_000);
process.exit(r.code);
`);
  const p = runBun(script, [], { cwd: main, env: envWith(s.bin, { XDG_STATE_HOME: s.state, FACTORY_NOW: String(T - 10) }) });
  expect(p.code, p.out).toBe(0);
  const r = JSON.parse(report(s, "--json").stdout) as Report;
  expect(r.endpoints).toEqual({ "issues/:n/comments": 1 });
});

test("wait_for_merge.sh counts its polls", () => {
  const s = setup();
  const { agent } = project();
  const p = sh(["bash", join(HOOKS, "wait_for_merge.sh"), "5", "1"], { cwd: agent, env: envWith(s.bin, { XDG_STATE_HOME: s.state,
    FACTORY_AGENT: "menelik" }) });
  expect(p.code, p.out).toBe(0);
  const got = runHook("factory_usage", ["--github", "--json"], { cwd: tmp(), env: envWith(s.bin, { XDG_STATE_HOME: s.state,
    FACTORY_NOW: undefined }) });
  const r = JSON.parse(got.stdout) as Report;
  expect(r.agents).toEqual({ "menelik (proj)": 1 });
  expect(r.commands).toEqual({ "wait_for_merge.sh": 1 });
  expect(r.endpoints).toEqual({ "pr view": 1 });
});
