// The `models` setting: a model (and effort) per role, in factory.json (#94). A role with no entry behaves as before.
// The values must reach the `claude` command line: --model and --effort for the builder (loop) and the manager,
// --agents for a subagent (the one mechanism that overrides a kit agent file per role; see factory_models.ts).
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { calls, fakeClaude, flag, loopProject } from "./loop_support.ts";
import { HOOKS, KIT, read, runBun, SF, sh, tmp, write } from "./support.ts";

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

// --- `factory settings` and `factory agent` with the setting -------------------------------------------------------

function personEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) delete env[name];
  return env;
}

function settings(d: string, ...args: string[]) {
  return runBun(join(HOOKS, "factory_settings.ts"), args, { cwd: d, env: personEnv() });
}

test("settings show models documents the shape", () => {
  const p = settings(project(), "show", "models");
  expect(p.code, p.out).toBe(0);
  for (const word of ["builder", "manager", "test-writer", "reviewer", "architecture-reviewer", "safety-auditor",
    "security-reviewer", "effort", "escalateTo"]) expect(p.stdout).toContain(word);
  expect(settings(project()).stdout).toContain("factory settings");
  expect(settings(project()).stdout).toContain("models");
});

test("set accepts a good value and rejects a bad role an empty model and a bad effort", () => {
  let d = project();
  const good = { builder: { model: "opus", effort: "high" }, reviewer: { model: "sonnet", escalateTo: "opus" },
    "architecture-reviewer": {} };
  const p = settings(d, "set", "models", JSON.stringify(good));
  expect(p.code, p.out).toBe(0);
  expect(JSON.parse(read(join(d, ".claude", "factory.json"))).models).toEqual(good);
  for (const bad of [{ janitor: { model: "opus" } }, { builder: { model: "" } }, { builder: { model: "--dangerous" } },
    { builder: { model: "opus", effort: "turbo" } }, { "test-writer": { effort: "high" } },
    { builder: { escalateTo: "opus" } }, { builder: "opus" }, ["builder"]]) {
    d = project();
    const q = settings(d, "set", "models", JSON.stringify(bad));
    expect(q.code, JSON.stringify(bad)).not.toBe(0);
    expect(q.stderr, JSON.stringify(bad)).toContain("models");
    expect("models" in JSON.parse(read(join(d, ".claude", "factory.json"))), JSON.stringify(bad)).toBe(false);
  }
});

function agentRun(models?: unknown): string[] {
  const d = project(models);
  const must = (cmd: string[], cwd?: string): void => {
    const p = sh(cmd, { cwd });
    if (p.code !== 0) throw new Error(`${cmd.join(" ")}: ${p.out}`);
  };
  must(["git", "add", "-A"], d);
  must(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "s"], d);
  const origin = d + "-origin.git";
  must(["git", "init", "-q", "--bare", "-b", "main", origin]);
  must(["git", "remote", "add", "origin", origin], d);
  must(["git", "push", "-q", "origin", "HEAD:main"], d);
  const env = fakeClaude(tmp());
  const p = sh(["bash", join(SF, "factory"), "agent", "menelik", "--resume"], { cwd: d, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const got = calls(env);
  expect(got.length).toBe(1);
  return got[0] as string[];
}

test("factory agent passes the models setting before the users own arguments", () => {
  const args = agentRun({ builder: { model: "opus", effort: "low" }, reviewer: { model: "haiku" } });
  expect(flag(args, "--model")).toBe("opus");
  expect(flag(args, "--effort")).toBe("low");
  expect(JSON.parse(flag(args, "--agents")).reviewer.model).toBe("haiku");
  expect(args.at(-1)).toBe("--resume");
  expect(args.indexOf("--model")).toBeLessThan(args.indexOf("--resume"));
});

test("factory agent with no models adds nothing", () => {
  const args = agentRun(undefined);
  for (const f of ["--model", "--effort", "--agents"]) expect(args).not.toContain(f);
});

// --- `factory doctor` with the setting ---------------------------------------------------------------------------

function doctorRun(d: string) {
  return runBun(join(HOOKS, "factory_doctor.ts"), [], { cwd: d, env: personEnv() });
}

test("doctor shows the effective model per role and where it came from", () => {
  const d = project({ builder: { model: "opus" }, reviewer: { model: "haiku" } });
  const p = doctorRun(d);
  const out = p.stdout.split("\n").filter((l) => l.includes("model for"));
  const by: Record<string, string> = {};
  for (const l of out) by[(l.split("model for ")[1] as string).split(":")[0] as string] = l;
  expect(Object.keys(by).sort(), out.join("\n")).toEqual(["builder", "manager", ...SUBAGENTS].sort());
  expect(by.builder!.includes("opus") && by.builder!.includes("setting"), by.builder).toBe(true);
  expect(by.manager!, by.manager).toContain("Claude Code default");
  expect(by.reviewer!.includes("haiku") && by.reviewer!.includes("setting"), by.reviewer).toBe(true);
  expect(by["safety-auditor"]!.includes("opus") && by["safety-auditor"]!.includes("agent file"), by["safety-auditor"]).toBe(true);
  expect(by["test-writer"]!.includes("sonnet") && by["test-writer"]!.includes("agent file"), by["test-writer"]).toBe(true);
});

test("doctor flags a bad models value", () => {
  const d = project({ builder: { model: "" } });
  const p = doctorRun(d);
  expect(p.code === 1 && p.stdout.split("\n").some((l) => l.startsWith("fix") && l.includes("models")), p.stdout).toBe(true);
});
