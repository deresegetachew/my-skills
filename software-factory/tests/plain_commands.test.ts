// Unattended, Claude Code asks before a command with a shell variable, `${...}`, `$(...)` or backticks in it, even when
// an allow rule matches, and nobody is there to answer: every builder stopped at `next_task.ts ${FACTORY_PID:+...}`.
// So the commands the kit tells agents to run are plain text, and the scripts read FACTORY_AGENT and FACTORY_PID from
// their own environment (factory-loop.sh exports FACTORY_AGENT; the SessionStart hook writes both to CLAUDE_ENV_FILE).
import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { baseEnv } from "./claims_support.ts";
import { type Env, issue, labels, nextTask, setup } from "./issues_support.ts";
import { gitRepo, KIT, read, runHook, SF, write } from "./support.ts";

function markdown(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdown(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Every file an agent reads its commands from: the skills, the agents' definitions and the role playbooks. */
const FILES = [...markdown(join(KIT, ".claude", "skills")), ...markdown(join(KIT, ".claude", "agents")),
  join(SF, "DEV-MANAGER.md"), join(SF, "PO.md"), join(KIT, "CLAUDE.factory.md")];

/** [line number, code] for each inline code span and each line of a fenced block. */
function codeOf(text: string): [number, string][] {
  const out: [number, string][] = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) out.push([i + 1, line]);
    else for (const m of line.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) out.push([i + 1, m[2] as string]);
  });
  return out;
}

const EXPANSION = /\$[A-Za-z_{(]/;

test("the scan finds the forms that stalled the agents", () => {
  const bad = "Run `next_task.ts ${FACTORY_PID:+--pid x}` then `done --agent \"$FACTORY_AGENT\"` and `x $(date)`.\n" +
    "```\necho $HOME\n```\nPlain `next_task.ts` is fine.";
  const hits = codeOf(bad).filter(([, c]) => EXPANSION.test(c)).map(([n]) => n);
  expect(hits).toEqual([1, 1, 1, 3]);
});

test("no command in the kit's skills, agents or playbooks uses a shell variable or substitution", () => {
  expect(FILES.length).toBeGreaterThan(8);
  const found: string[] = [];
  for (const f of FILES) {
    for (const [n, code] of codeOf(read(f))) {
      if (EXPANSION.test(code)) found.push(`${relative(SF, f)}:${n}: ${code}`);
    }
  }
  expect(found).toEqual([]);
});

test("the skills give the plain forms of the pick and the claim commands", () => {
  const skill = read(join(KIT, ".claude", "skills", "next-task", "SKILL.md"));
  expect(skill).toContain("`bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts`");
  expect(skill).toContain("`bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts release --tasks-only`");
  const rework = read(join(KIT, ".claude", "skills", "next-task", "rework.md"));
  expect(rework).toContain("`bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts done --task pr-<n>`");
});

test("the role prompts name the item in words, with no variable", () => {
  const d = gitRepo();
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu"] }));
  for (const role of ["dev-manager", "product-owner"]) {
    const p = runHook("factory_roles", ["prompt", role, "lead", "pr-7"], { cwd: d });
    expect(p.code, p.stderr).toBe(0);
    expect(p.stdout).toContain("for pr-7");
    expect(p.stdout).not.toMatch(EXPANSION);
  }
});

// --- the scripts read the agent from their environment ------------------------------------------------------------

function planProject(): string {
  const d = gitRepo();
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu", "menelik"] }));
  write(join(d, "docs", "build-plan.md"), "# Plan\n\n- [ ] **1.1 First task**\n- [ ] **1.2 Second task**\n");
  return d;
}

function claimsList(d: string): string {
  const p = runHook("factory_claims", ["list"], { cwd: d, env: baseEnv() });
  expect(p.code, p.stderr).toBe(0);
  return p.stdout;
}

const LIVE = String(process.pid); // a pid that is alive while the test runs

test("next_task claims as FACTORY_AGENT with FACTORY_PID from the environment", () => {
  const d = planProject();
  const p = runHook("next_task", ["--no-rework"], { cwd: d, env: { ...baseEnv(), FACTORY_AGENT: "taytu", FACTORY_PID: LIVE } });
  expect([p.code, p.stdout.trim()], p.stderr).toEqual([0, "1.1 First task"]);
  expect(claimsList(d)).toMatch(new RegExp(`^task\\s+1\\.1\\s+taytu\\s+pid ${LIVE} live`, "m"));
});

test("explicit --claim and --pid win over the environment", () => {
  const d = planProject();
  const p = runHook("next_task", ["--no-rework", "--claim", "menelik", "--pid", LIVE],
    { cwd: d, env: { ...baseEnv(), FACTORY_AGENT: "taytu", FACTORY_PID: "1" } });
  expect([p.code, p.stdout.trim()], p.stderr).toEqual([0, "1.1 First task"]);
  const list = claimsList(d);
  expect(list).toMatch(new RegExp(`^task\\s+1\\.1\\s+menelik\\s+pid ${LIVE} live`, "m"));
  expect(list).not.toContain("taytu");
});

test("next_task claims nothing without FACTORY_PID, with --no-claim, or for factory next's --note", () => {
  const d = planProject();
  const both = { ...baseEnv(), FACTORY_AGENT: "taytu", FACTORY_PID: LIVE };
  for (const [args, env] of [[["--no-rework"], { ...baseEnv(), FACTORY_AGENT: "taytu" }], [["--no-rework", "--no-claim"], both],
    [["--no-rework", "--note"], both], [["--no-rework"], baseEnv()]] as [string[], Env][]) {
    const p = runHook("next_task", args, { cwd: d, env });
    expect([p.code, p.stdout.split("\n")[0]], `${args.join(" ")} ${p.stderr}`).toEqual([0, "1.1 First task"]);
    expect(claimsList(d), args.join(" ")).toBe("");
  }
});

test("next_task --issue claims as FACTORY_AGENT from the environment", () => {
  const [d, db, env] = setup([issue(1, undefined, "", 1), issue(2, undefined, "", 2)]);
  const [rc, out, err] = nextTask(d, { ...env, FACTORY_AGENT: "menelik" }, "--issue", "2");
  expect([rc, out], err).toEqual([0, "issue-2 Task 2"]);
  expect(labels(db, 2)).toEqual(["agent:menelik", "factory:in-progress"]);
  expect(labels(db, 1)).toEqual(["factory:ready"]);
});

test("next_task --issue without an agent still says it needs --claim", () => {
  const [d, , env] = setup([issue(2)]);
  const e: Env = { ...env };
  delete e.FACTORY_AGENT;
  const [rc, , err] = nextTask(d, e, "--issue", "2");
  expect(rc).toBe(2);
  expect(err).toContain("--issue needs --claim AGENT");
});

test("factory_claims done, take-done and release use FACTORY_AGENT from the environment", () => {
  const d = planProject();
  const env = { ...baseEnv(), FACTORY_AGENT: "taytu" };
  let p = runHook("factory_claims", ["done", "--task", "pr-118"], { cwd: d, env });
  expect(p.code, p.stderr).toBe(0);
  p = runHook("factory_claims", ["take-done", "--agent", "taytu"], { cwd: d, env: baseEnv() });
  expect(p.stdout.trim()).toBe("pr-118");
  runHook("factory_claims", ["done", "--task", "1.1"], { cwd: d, env });
  p = runHook("factory_claims", ["take-done"], { cwd: d, env });
  expect([p.code, p.stdout.trim()], p.stderr).toEqual([0, "1.1"]);
  runHook("next_task", ["--no-rework", "--claim", "taytu", "--pid", LIVE], { cwd: d, env: baseEnv() });
  expect(claimsList(d)).toContain("taytu");
  p = runHook("factory_claims", ["release", "--tasks-only"], { cwd: d, env });
  expect(p.code, p.stderr).toBe(0);
  expect(p.stdout).toContain("1.1");
  expect(claimsList(d)).toBe("");
});

test("an explicit --agent wins over FACTORY_AGENT, and with neither the agent is still required", () => {
  const d = planProject();
  let p = runHook("factory_claims", ["done", "--agent", "menelik", "--task", "1.2"], { cwd: d, env: { ...baseEnv(), FACTORY_AGENT: "taytu" } });
  expect(p.code, p.stderr).toBe(0);
  expect(runHook("factory_claims", ["take-done", "--agent", "menelik"], { cwd: d, env: baseEnv() }).stdout.trim()).toBe("1.2");
  p = runHook("factory_claims", ["done", "--task", "1.2"], { cwd: d, env: baseEnv() });
  expect(p.code).toBe(2);
  expect(p.stderr).toContain("the following arguments are required: --agent");
});
