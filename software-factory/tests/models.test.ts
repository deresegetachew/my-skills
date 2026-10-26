// The `models` setting: a model (and effort) per role, in factory.json (#94). A role with no entry behaves as before.
// The values must reach the `claude` command line: --model and --effort for the builder (loop) and the manager,
// --agents for a subagent (the one mechanism that overrides a kit agent file per role; see factory_models.ts).
// (`factory settings`, `factory agent` and `factory doctor` with this setting are checked in test_models.py until those
// scripts are ported.)
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { calls, flag, loopProject } from "./loop_support.ts";
import { HOOKS, KIT, read, runBun, sh, tmp, write } from "./support.ts";

const AGENTS = join(KIT, ".claude", "agents");
const SUBAGENTS = ["test-writer", "reviewer", "architecture-reviewer", "safety-auditor", "security-reviewer"];

function project(models?: unknown): string {
  const d = tmp();
  sh(["git", "init", "-q", "-b", "main", d]);
  const hooks = join(d, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  symlinkSync(AGENTS, join(d, ".claude", "agents"));
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(hooks, f));
  const cfg: Record<string, unknown> = { agents: ["menelik", "taytu"] };
  if (models !== undefined) cfg.models = models;
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  write(join(d, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
  return d;
}

function modelsTs(d: string, ...args: string[]) {
  return runBun(join(d, ".claude", "hooks", "factory_models.ts"), args, { cwd: d });
}

function flagsOf(d: string, role: string): string[] {
  const p = modelsTs(d, "flags", role);
  expect(p.code, p.out).toBe(0);
  return p.stdout.split("\n").filter((l, i, a) => i < a.length - 1 || l !== "");
}

test("no models entry means no flags at all", () => {
  let d = project();
  for (const role of ["builder", "manager"]) {
    const p = modelsTs(d, "flags", role);
    expect(p.code, role + p.out).toBe(0);
    expect(p.stdout).toBe("");
  }
  d = project({ builder: {}, manager: {}, reviewer: {}, "safety-auditor": {} });
  expect(modelsTs(d, "flags", "builder").stdout).toBe("");
});

test("builder and manager get model and effort", () => {
  const d = project({ builder: { model: "opus", effort: "high" }, manager: { model: "sonnet" } });
  expect(flagsOf(d, "builder")).toEqual(["--model", "opus", "--effort", "high"]);
  expect(flagsOf(d, "manager")).toEqual(["--model", "sonnet"]);
});

test("each subagent role reaches claude as an agents override that keeps its instructions", () => {
  for (const role of SUBAGENTS) {
    const d = project({ [role]: { model: "haiku" } });
    const args = flagsOf(d, "builder");
    expect(args[0], role).toBe("--agents");
    expect(args.length, role).toBe(2);
    const agents = JSON.parse(args[1] as string) as Record<string, { model: string; prompt: string; tools: string[]; description: string }>;
    expect(Object.keys(agents)).toEqual([role]);
    const text = read(join(AGENTS, role + ".md"));
    const agent = agents[role] as { model: string; prompt: string; tools: string[]; description: string };
    expect(agent.model).toBe("haiku");
    expect(agent.prompt.trim(), role).toBe((text.split("\n---\n").slice(1).join("\n---\n")).trim());
    expect(agent.tools.length).toBeGreaterThan(0);
    expect(agent.tools).toContain("Read");
    expect(agent.description).toBeTruthy();
    expect(flagsOf(d, "manager").slice(0, 1)).toEqual(["--agents"]); // the manager starts subagents too
  }
});

function loopWith(models: unknown, withAgents = true): [ReturnType<typeof sh>, string[][], Record<string, string | undefined>] {
  const [work, env] = loopProject();
  const cfg: Record<string, unknown> = { waitMinutes: 0 };
  if (models !== undefined) cfg.models = models;
  write(join(work, ".claude", "factory.json"), JSON.stringify(cfg));
  for (const f of ["factory_models.ts", "factory_config.ts"]) copyFileSync(join(HOOKS, f), join(work, ".claude", "hooks", f));
  if (withAgents) symlinkSync(AGENTS, join(work, ".claude", "agents"));
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env, timeoutMs: 60_000 });
  return [p, calls(env), env];
}

function runLoop(models: unknown): string[] {
  const [p, got] = loopWith(models);
  expect(got.length, p.out).toBe(1);
  return got[0] as string[];
}

test("the loop passes the builder model effort and subagent overrides to claude", () => {
  const args = runLoop({ builder: { model: "opus", effort: "xhigh" }, "test-writer": { model: "haiku" } });
  expect(flag(args, "--model")).toBe("opus");
  expect(flag(args, "--effort")).toBe("xhigh");
  expect(JSON.parse(flag(args, "--agents"))["test-writer"].model).toBe("haiku");
  expect(args.slice(-2)).toEqual(["-p", "/next-task 1.1"]);
});

test("a loop with no models runs exactly as before", () => {
  const args = runLoop(undefined);
  for (const f of ["--model", "--effort", "--agents"]) expect(args).not.toContain(f);
  expect(args.slice(0, 2)).toEqual(["--mcp-config", '{"mcpServers":{}}']);
  expect(args.slice(-2)).toEqual(["-p", "/next-task 1.1"]);
});

test("the loop refuses a bad models value and says why", () => {
  const [p, , env] = loopWith({ janitor: { model: "x" } }, false);
  expect(p.code, p.out).not.toBe(0);
  expect(p.out).toContain("janitor");
  expect(existsSync(env.CLAUDE_LOG as string)).toBe(false); // claude never started
});

test("escalate prints the reviewer's escalation model and opus when unset", () => {
  expect(modelsTs(project({ reviewer: { model: "sonnet", escalateTo: "claude-opus-5-5" } }), "escalate").stdout.trim()).toBe("claude-opus-5-5");
  expect(modelsTs(project(), "escalate").stdout.trim()).toBe("opus");
  expect(modelsTs(project({ reviewer: { model: "haiku" } }), "escalate").stdout.trim()).toBe("opus");
});

test("the next-task skill asks for the escalation model from the setting", () => {
  const skill = read(join(KIT, ".claude", "skills", "next-task", "SKILL.md"));
  expect(skill.split(/\s+/).filter(Boolean).join(" ")).toContain("factory_models.ts escalate");
  expect(skill).toContain("models.reviewer.escalateTo");
});
