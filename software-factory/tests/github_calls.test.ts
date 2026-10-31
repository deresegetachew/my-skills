// #371: the factory counts its own GitHub calls (per machine) and `factory usage --github` shows the last hour's.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, envWith, runBun, runHook, tmp, write, writeExe } from "./support.ts";

const T = 1_793_000_000; // a fixed "now", on the hour or not, it doesn't matter

/** A fake `gh` that answers `{}` to everything, and a script that makes the gh calls it is given (one per argument,
 * words split on spaces) through the factory's own run(). */
function setup(): { bin: string; state: string; script: string } {
  const dir = tmp();
  const bin = join(dir, "bin");
  writeExe(join(bin, "gh"), "#!/usr/bin/env bash\necho '{}'\n");
  const script = write(join(dir, "my_cmd.ts"), `import { gh } from ${JSON.stringify(join(HOOKS, "factory_lib.ts"))};
for (const call of process.argv.slice(3)) gh(call.split(" "));
`);
  return { bin, state: join(dir, "state"), script };
}

function calls(s: ReturnType<typeof setup>, cwd: string, agent: string | undefined, now: number, ...gh: string[]): void {
  mkdirSync(cwd, { recursive: true });
  const p = runBun(s.script, ["list", ...gh], { cwd, env: envWith(s.bin, { XDG_STATE_HOME: s.state, FACTORY_AGENT: agent,
    FACTORY_NOW: String(now) }) });
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

test("each gh call is counted by agent, command and endpoint; auth and rate_limit are not", () => {
  const s = setup();
  const root = tmp();
  calls(s, join(root, "proj-agents", "haile"), "haile", T - 60,
    "api repos/{owner}/{repo}/issues/12/comments", "api --paginate repos/{owner}/{repo}/issues/13/comments?since=x",
    "api -X POST repos/{owner}/{repo}/issues/12/comments -f body=hi", "pr view 5 --json number",
    "auth status", "api rate_limit");
  calls(s, join(root, "proj"), undefined, T - 30, "api repos/{owner}/{repo}/pulls?state=open");
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
  const cwd = join(tmp(), "proj");
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
  const cwd = join(tmp(), "proj");
  calls(s, cwd, "haile", T - 3 * 86_400, "api user");
  const dir = join(s.state, "software-factory", "github-calls");
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
