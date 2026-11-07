// `factory next` says it does not claim and shows the claim command (#155).
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { type Env, issue, type IssueRow, setup } from "./issues_support.ts";
import { HOOKS, read, readmeAndWiki, runHook, SF, sh } from "./support.ts";

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

test("factory next --dry-run prints what it would take and claims nothing, even with --claim (#520)", () => {
  const [d, env] = project([issue(7)]);
  const issuesNow = (): unknown => (JSON.parse(read(env.FAKE_GH_DB as string)) as { issues: unknown }).issues; // the fake's clock ticks on reads
  const before = issuesNow();
  let p = sh(["bash", join(SF, "factory"), "next", "--dry-run"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split("\n")[0]).toBe("issue-7 Task 7");
  expect(p.stdout).toContain("Dry run: nothing was claimed.");
  expect(p.stderr).not.toContain("unrecognized");
  // --claim with --dry-run: the same look, as that agent, and still nothing claimed
  p = sh(["bash", join(SF, "factory"), "next", "--dry-run", "--claim", "taytu", "--pid", "1"], { cwd: d, env: { ...env, FACTORY_PID: "1" } });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split("\n")[0]).toBe("issue-7 Task 7");
  expect(p.stdout).toContain("Dry run: nothing was claimed.");
  expect(issuesNow(), "no issue was labelled or claimed").toEqual(before);
});

test("factory next --dry-run with --issue is refused with code, message and fix", () => {
  const [d, env] = project([issue(7)]);
  const p = sh(["bash", join(SF, "factory"), "next", "--dry-run", "--claim", "taytu", "--issue", "7"], { cwd: d, env });
  expect(p.code).toBe(1);
  const e = JSON.parse(p.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
  expect(e.code).toBe("dry_run_issue");
  expect(e.fix).toContain("factory issues show 7");
});

/** The PRD change's pull request as the issues API gives it: merged when `merged` is a time. */
function prdPull(n: number, merged: string | null): IssueRow {
  return { ...issue(n, []), title: "PRD: Shelf v1.1", state: merged ? "closed" : "open", pull_request: { url: `https://x/pulls/${n}`, merged_at: merged } };
}

test("factory next skips a task whose PRD change hasn't merged and says why; a claim skips it too (#578)", () => {
  const [d, env] = project([issue(5, ["factory:ready"], "PRD: US-12\nPRD change: #62"), issue(7), prdPull(62, null)]);
  let p = sh(["bash", join(SF, "factory"), "next"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split("\n")[0]).toBe("issue-7 Task 7");
  expect(p.stderr).toContain("Skipped #5: it waits for its PRD change, PR #62, to merge.");
  p = sh(["bash", join(SF, "factory"), "next", "--dry-run", "--claim", "taytu"], { cwd: d, env });
  expect(p.stdout.split("\n")[0]).toBe("issue-7 Task 7");
  expect(p.stderr).toContain("Skipped #5");
  p = runHook("next_task", ["--claim", "taytu", "--pid", "1"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.trim()).toBe("issue-7 Task 7");
  expect(p.stderr).toContain("Skipped #5: it waits for its PRD change, PR #62, to merge.");
  p = runHook("next_task", ["--claim", "menelik", "--pid", "2"], { cwd: d, env });
  expect(p.code).toBe(1);
  expect(p.stdout.trim()).toBe("none");
  expect(p.stderr).toContain("PR #62");
});
