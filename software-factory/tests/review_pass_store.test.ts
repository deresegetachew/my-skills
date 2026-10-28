// Review passes can't be forged (#260 item 5). A pass lives in the git folder (`<git common dir>/factory-reviews/`),
// not in the worktree's tmp/reviews that the kit lets an agent edit. Only a reviewer subagent may run
// `factory review-pass`: the PR gate reads who runs the command from Claude Code's hook input (agent_id, agent_type).
// The agents' rules deny writing that folder directly.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fnmatch } from "../hooks/factory_lib.ts";
import { KIT_AGENT_SETTINGS } from "./loop_support.ts";
import { allowedBy, type Permissions } from "./manager_support.ts";
import { GATE } from "./pr_gate_support.ts";
import { readmeAndWiki, runHook, sh, tmp, write } from "./support.ts";

const ENV: Record<string, string | undefined> = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENT: undefined,
};

function git(d: string, ...a: string[]): string {
  const p = sh(["git", ...a], { cwd: d, env: ENV });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
  return p.stdout.trim();
}

function project(): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ reviewMarkers: "tmp/reviews" }));
  write(join(d, "a.txt"), "a\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "one");
  git(d, "checkout", "-q", "-b", "task/9-x");
  return d;
}

const store = (d: string): string => join(resolve(d, git(d, "rev-parse", "--git-common-dir")), "factory-reviews");

test("a reviewer pass is written to the git folder, not to tmp/reviews", () => {
  const d = project();
  const p = runHook("factory_review_pass", ["reviewer"], { cwd: d, env: ENV });
  expect(p.code, p.out).toBe(0);
  expect(readFileSync(join(store(d), "task_9-x.ok"), "utf8").trim()).toBe(git(d, "rev-parse", "HEAD"));
  expect(existsSync(join(d, "tmp", "reviews", "task_9-x.ok"))).toBe(false);
  expect(p.stdout).toContain("factory-reviews");
});

test("a pass recorded in a linked worktree lands in the shared git folder", () => {
  const d = project();
  git(d, "checkout", "-q", "main");
  const wt = join(tmp(), "wt");
  git(d, "worktree", "add", "-q", wt, "task/9-x");
  const p = runHook("factory_review_pass", ["arch"], { cwd: wt, env: ENV });
  expect(p.code, p.out).toBe(0);
  expect(readFileSync(join(store(d), "task_9-x.arch.ok"), "utf8").trim()).toBe(git(wt, "rev-parse", "HEAD"));
  expect(existsSync(join(wt, "tmp"))).toBe(false);
});

// --- only a reviewer subagent records a pass ----------------------------------------------------------------------------

type Who = { agent_id?: string; agent_type?: string };

function gate(cwd: string, command: string, who: Who = {}): [number, string] {
  const p = sh([process.execPath, "--no-env-file", GATE], { cwd, env: ENV,
    input: JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...who }) });
  return [p.code, p.stderr];
}

const PASS = (kind: string): string => `bun --no-env-file --config=/dev/null .claude/hooks/factory_review_pass.ts ${kind}`;

test("the coding agent itself can't record a review pass", () => {
  const d = project();
  for (const c of [PASS("reviewer"), PASS("arch"), "./factory review-pass reviewer", "factory review-pass arch",
    "bun .claude/hooks/factory_review_pass.ts reviewer", "bash -c './factory review-pass reviewer'"]) {
    const [code, err] = gate(d, c);
    expect(code, c).toBe(2);
    expect(err, c).toContain("reviewer subagent");
  }
  // a main thread started with --agent reviewer has agent_type but no agent_id: still not a reviewer subagent
  expect(gate(d, PASS("reviewer"), { agent_type: "reviewer" })[0]).toBe(2);
  // another subagent (the test writer, a general-purpose helper) can't either
  expect(gate(d, PASS("reviewer"), { agent_id: "a1", agent_type: "test-writer" })[0]).toBe(2);
});

test("a reviewer subagent records only its own kind of pass", () => {
  const d = project();
  expect(gate(d, PASS("reviewer"), { agent_id: "a1", agent_type: "reviewer" })).toEqual([0, ""]);
  expect(gate(d, PASS("arch"), { agent_id: "a2", agent_type: "architecture-reviewer" })).toEqual([0, ""]);
  expect(gate(d, PASS("arch"), { agent_id: "a1", agent_type: "reviewer" })[0]).toBe(2);
  expect(gate(d, PASS("reviewer"), { agent_id: "a2", agent_type: "architecture-reviewer" })[0]).toBe(2);
  // one command per call: a pass chained with anything else is refused
  expect(gate(d, `git status && ${PASS("reviewer")}`, { agent_id: "a1", agent_type: "reviewer" })[0]).toBe(2);
});

test("the gate refuses commands that touch the passes folder or climb out of the hooks folder", () => {
  const d = project();
  for (const c of ["cp x .git/factory-reviews/task_9-x.ok", "mkdir -p .git/factory-reviews",
    "bun --no-env-file --config=/dev/null .claude/hooks/../../tmp/x.ts", "bun --no-env-file --config=/dev/null .claude/hooks/../x.ts"]) {
    expect(gate(d, c)[0], c).toBe(2);
  }
  for (const c of ["git status", "bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts"]) {
    expect(gate(d, c), c).toEqual([0, ""]);
  }
});

// --- the agents' rules deny writing the folder -----------------------------------------------------------------------

const settings = (): Permissions => (JSON.parse(readFileSync(KIT_AGENT_SETTINGS, "utf8")) as { permissions: Permissions }).permissions;

function deniedPath(tool: string, path: string): boolean {
  return settings().deny.some((r) => {
    const m = new RegExp(`^${tool}\\(//(.*)\\)$`, "s").exec(r);
    return Boolean(m) && fnmatch(path.replace(/^\//, ""), m?.[1] as string);
  });
}

test("the agents' rules deny writing a pass directly", () => {
  for (const p of ["/home/a/proj/.git/factory-reviews/task_1-x.ok", "/w/.git/factory-reviews/task_1-x.arch.ok"]) {
    expect(deniedPath("Edit", p), p).toBe(true);
    // Edit(path) also covers the Write tool; Claude Code never matches a Write(path) rule and warns about it at start
    expect(deniedPath("Write", p), p).toBe(false);
  }
  expect(deniedPath("Edit", "/w/proj/tmp/pr.md")).toBe(false);
  for (const c of ["cp tmp/x .git/factory-reviews/task_1-x.ok", "tee .git/factory-reviews/task_1-x.ok",
    "mkdir -p ../.git/factory-reviews"]) {
    expect(allowedBy(settings(), c), c).toBe(false);
  }
});

test("the docs say where passes live and that an old tmp/reviews pass no longer counts", () => {
  const docs = readmeAndWiki();
  expect(docs).toContain("factory-reviews");
  expect(readmeAndWiki("reviews-and-gates.md")).toMatch(/tmp\/reviews[^.]*no longer count/);
});
