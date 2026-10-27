// `factory doctor` says which model a session role will use without spending tokens (#194, the doctor half): the
// `models` setting when set; else the model Claude Code resolves from ANTHROPIC_MODEL or the `model` key of its
// settings files (project, then user); else plainly that it can't tell, with the command that pins one. Read-only: only
// the `model` key of those files is looked at, and nothing else from them is printed.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, type Env, machine, project } from "./doctor_support.ts";
import { type Proc, tmp, write } from "./support.ts";

function run(o: { models?: unknown; envModel?: string; user?: unknown; projectSettings?: unknown } = {}): [Proc, Record<string, string>] {
  const d = project({}, { agents: ["taytu"], ...(o.models ? { models: o.models } : {}) });
  const env: Env = { ...machine(), FACTORY_AGENTS: "taytu" };
  if (o.envModel) env.ANTHROPIC_MODEL = o.envModel;
  if (o.user !== undefined) write(join(env.HOME as string, ".claude", "settings.json"), JSON.stringify(o.user));
  if (o.projectSettings !== undefined) write(join(d, ".claude", "settings.json"), JSON.stringify(o.projectSettings));
  const p = doctor(d, env);
  const by: Record<string, string> = {};
  for (const l of p.stdout.split("\n")) if (l.includes("model for")) by[(l.split("model for ")[1] as string).split(":")[0] as string] = l;
  return [p, by];
}

test("the models setting wins and is named", () => {
  const [, by] = run({ models: { builder: { model: "opus" } }, envModel: "sonnet" });
  const b = by.builder as string;
  expect(b.startsWith("ok") && b.includes("opus") && b.includes("setting"), b).toBe(true);
});

test("an unset role shows the model anthropic model resolves to", () => {
  const [, by] = run({ envModel: "claude-sonnet-5-5" });
  for (const role of ["builder", "manager"]) {
    const l = by[role] as string;
    expect(l.startsWith("ok") && l.includes("Claude Code default") && l.includes("claude-sonnet-5-5") && l.includes("ANTHROPIC_MODEL"), l).toBe(true);
  }
});

test("an unset role shows the users settings model and only that key", () => {
  const [p, by] = run({ user: { model: "opus", env: { SECRET_TOKEN: "hunter2" }, apiKeyHelper: "get-my-key" } });
  expect((by.builder as string).includes("opus") && (by.builder as string).includes("~/.claude/settings.json"), by.builder).toBe(true);
  expect(p.stdout).not.toContain("hunter2");
  expect(p.stdout).not.toContain("get-my-key");
});

test("the project settings model comes before the users", () => {
  const [, by] = run({ user: { model: "opus" }, projectSettings: { model: "haiku", hooks: {} } });
  const b = by.builder as string;
  expect(b.includes("haiku") && b.includes(".claude/settings.json") && !b.includes("opus"), b).toBe(true);
});

test("the environment comes before the settings files", () => {
  const [, by] = run({ envModel: "sonnet", user: { model: "opus" } });
  const b = by.builder as string;
  expect(b.includes("sonnet") && !b.includes("opus"), b).toBe(true);
});

test("when nothing can be read it says so with the pin command and is a note not a fix", () => {
  const [p, by] = run();
  for (const role of ["builder", "manager"]) {
    const l = by[role] as string;
    expect(l.startsWith("note") && l.includes("can't tell"), l).toBe(true);
    expect(l).toContain(`factory settings set models '{"${role}":{"model":"<name>"}}'`);
    expect(l).toContain("Claude Code default");
  }
  expect(p.code, p.stdout).toBe(0);
});

test("doctor makes no model call", () => {
  const d = project({}, { agents: ["taytu"] });
  const env = machine();
  const log = join(tmp(), "claude.log");
  write(join(env.PATH as string, "claude"), `#!/bin/sh\necho "$*" >> ${log}\necho '2.1.310 (Claude Code)'\n`, 0o755);
  doctor(d, { ...env, FACTORY_AGENTS: "taytu" });
  const words = new Set(readFileSync(log, "utf8").split(/\s+/).filter(Boolean));
  for (const w of words) expect(["--version", "2.1.310", "(Claude", "Code)"]).toContain(w);
});
