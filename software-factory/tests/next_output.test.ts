// `factory next` says it does not claim and shows the claim command (#155).
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { type Env, issue, type IssueRow, setup } from "./issues_support.ts";
import { HOOKS, readmeAndWiki, runHook, SF, sh } from "./support.ts";

// The command a person runs to claim (the .ts since #252; it was python3 .claude/hooks/next_task.py before).
const CLAIM = "bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --claim taytu --pid $$";

function project(issues: IssueRow[]): [string, Env] {
  const [d, , env] = setup(issues);
  sh(["git", "init", "-q", d]);
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  return [d, { ...env, FACTORY_AGENT: "taytu" }];
}

function factory(d: string, env: Env, ...args: string[]): [number, string[]] {
  const p = sh(["bash", join(SF, "factory"), ...args], { cwd: d, env });
  return [p.code, p.stdout.trim().split("\n")];
}

test("factory next ends with a line saying nothing was claimed", () => {
  const [d, env] = project([issue(7)]);
  const [rc, lines] = factory(d, env, "next");
  expect(rc).toBe(0);
  expect(lines[0]).toBe("issue-7 Task 7");
  expect(lines.length).toBe(2);
  expect(lines[1]?.startsWith("Not claimed.")).toBe(true);
  expect(lines[1]).toContain(CLAIM);
});

test("factory next with nothing ready prints only none", () => {
  const [d, env] = project([]);
  expect(factory(d, env, "next")).toEqual([1, ["none"]]);
});

test("the script itself stays one line for other programs", () => {
  const [d, env] = project([issue(7)]);
  expect(runHook("next_task", [], { cwd: d, env }).stdout.trim()).toBe("issue-7 Task 7");
});

test("help says next does not claim", () => {
  const [d, env] = project([]);
  const text = factory(d, env, "help")[1].join("\n");
  expect(text).toContain("does not claim");
  expect(text).toContain("next_task.ts --claim");
});

test("readme says next does not claim", () => {
  const row = readmeAndWiki().split("\n").find((l) => l.startsWith("| `factory next`")) as string;
  expect(row).toContain("does not claim");
  expect(row).toContain("--claim");
});

function agentIssue(n: number, name: string, status: string, ping = "2020-01-01T00:00:00Z"): IssueRow {
  return issue(n, ["factory:agent"], `<!-- factory-agent name=${name} status=${status} ping=${ping} -->\n**Started:** x\n**Where:** y`);
}

test("factory next says which issue a down agent still holds and how to free it", () => {
  // #191: the agent is down, its claim stays, and `next` skipped the issue without a word.
  const [d, env] = project([issue(3, ["factory:in-progress", "agent:menelik"]), issue(7), agentIssue(9, "menelik", "down")]);
  const p = sh(["bash", join(SF, "factory"), "next"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split("\n")[0]).toBe("issue-7 Task 7");
  for (const w of ["#3", "menelik", "down", "factory issues release 3"]) expect(p.stderr).toContain(w);
});

test("a live agents claim is not called stale", () => {
  const [d, env] = project([issue(3, ["factory:in-progress", "agent:menelik"]), issue(7),
    agentIssue(9, "menelik", "working", "2999-01-01T00:00:00Z")]);
  const p = sh(["bash", join(SF, "factory"), "next"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stderr).not.toContain("release");
});

test("the dry run says it too", () => {
  const [d, env] = project([issue(3, ["factory:in-progress", "agent:menelik"]), issue(7), agentIssue(9, "menelik", "down")]);
  const p = sh(["bash", join(SF, "factory-loop.sh"), "--once", "--dry-run"],
    { cwd: d, env: { ...env, FACTORY_ROLE: "coding-agent", FACTORY_NAME: "taytu" } });
  expect(p.out).toContain("factory issues release 3");
  expect(p.out).toContain("issue-7");
});
