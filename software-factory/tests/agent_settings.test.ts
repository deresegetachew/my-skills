// The agents' rules are passed when the factory starts an agent (#258), never kept in the project's
// .claude/settings.json, which Claude Code loads in every session (the owner's own too). factory-loop.sh and
// `factory agent` start claude with `--settings <file>`: .claude/factory/settings.json and main's
// `permissions.allow` from .claude/factory.json, both as main has them on origin, never this worktree's copy.
// Runs the real loop with stub hooks and a stub `claude` that records its arguments.
import { expect, test } from "bun:test";
import { cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { calls, type Env, fakeClaude, KIT_AGENT_SETTINGS, loopProject, NO_CONNECTORS, quiet, startedSettings } from "./loop_support.ts";
import { HOOKS, read, SF, sh, tmp, write } from "./support.ts";

type Settings = { permissions: { allow: string[]; deny: string[] }; hooks: Record<string, unknown> };

const kit = (): Settings => JSON.parse(read(KIT_AGENT_SETTINGS)) as Settings;

function loop(work: string, env: Env) {
  return sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env, timeoutMs: 60_000 });
}

function commitAndPush(work: string, message: string): void {
  quiet(["git", "add", "-A"], work);
  quiet(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], work);
  quiet(["git", "push", "-q", "origin", "HEAD:main"], work);
}

test("a coding agent starts with the kit's rules and main's extra allow rules on top of the project's own settings", () => {
  const [work, env] = loopProject(undefined, undefined, JSON.stringify({ waitMinutes: 0, permissions: { allow: ["Bash(make test*)"] } }));
  write(join(work, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(my-own-tool*)"] } }));
  commitAndPush(work, "the project's own settings");
  const p = loop(work, env);
  expect(p.code, p.out).toBe(0);
  const args = calls(env)[0] as string[];
  const got = startedSettings(args) as Settings;
  expect(got.permissions.deny).toEqual(kit().permissions.deny);
  expect(got.hooks).toEqual(kit().hooks);
  expect(got.permissions.allow).toEqual([...kit().permissions.allow, "Bash(make test*)"]);
  expect(got).toMatchObject(JSON.parse(NO_CONNECTORS));
  // The project's own file is Claude Code's to load and merge: never copied in, never switched off.
  expect(got.permissions.allow).not.toContain("Bash(my-own-tool*)");
  expect(args).not.toContain("--setting-sources");
  expect(JSON.parse(read(join(work, ".claude", "settings.json")))).toEqual({ permissions: { allow: ["Bash(my-own-tool*)"] } });
});

test("an agent cannot loosen its own rules in its worktree", () => {
  const [work, env] = loopProject(undefined, undefined, JSON.stringify({ waitMinutes: 0 }));
  // uncommitted edits in the worktree: no deny list, and an allow rule for everything
  write(join(work, ".claude", "factory", "settings.json"), JSON.stringify({ permissions: { deny: [] }, hooks: {} }));
  write(join(work, ".claude", "factory.json"), JSON.stringify({ waitMinutes: 0, permissions: { allow: ["Bash(*)"] } }));
  const p = loop(work, env);
  expect(p.code, p.out).toBe(0);
  const got = startedSettings(calls(env)[0] as string[]) as Settings;
  expect(got.permissions.deny).toEqual(kit().permissions.deny);
  expect(got.hooks).toEqual(kit().hooks);
  expect(got.permissions.allow).not.toContain("Bash(*)");
});

test("a project not yet updated keeps its old settings file and gets only the connectors setting", () => {
  const [work, env] = loopProject();
  rmSync(join(work, ".claude", "factory"), { recursive: true });
  write(join(work, ".claude", "settings.json"), read(KIT_AGENT_SETTINGS)); // where releases before #258 put the rules
  commitAndPush(work, "an old release");
  const p = loop(work, env);
  expect(p.code, p.out).toBe(0);
  const args = calls(env)[0] as string[];
  expect(startedSettings(args)).toEqual(JSON.parse(NO_CONNECTORS));
  expect(args).not.toContain("--setting-sources");
});

test("with no rules on main the loop starts no agent and says how to fix it", () => {
  const [work, env] = loopProject();
  rmSync(join(work, ".claude", "factory"), { recursive: true });
  commitAndPush(work, "no rules");
  write(join(work, ".claude", "factory", "settings.json"), read(KIT_AGENT_SETTINGS)); // only in the worktree: not enough
  const p = loop(work, env);
  expect(p.code, p.out).not.toBe(0);
  expect(calls(env)).toEqual([]);
  expect(p.out).toContain("no_agent_settings");
  expect(p.out).toContain("factory update");
  expect(p.out).toContain("no session was started");
});

/** A project with the factory as a submodule copy at vendor/my-skills (a real path, not /var -> /private/var). */
function linkedProject(): string {
  const d = realpathSync(tmp());
  quiet(["git", "init", "-q", "-b", "main", d]);
  cpSync(SF, join(d, "vendor", "my-skills", "software-factory"), {
    recursive: true, filter: (s) => !/\/(node_modules|tests|__pycache__)(\/|$)/.test(s),
  });
  return d;
}

function installLink(d: string) {
  return sh(["bash", join(d, "vendor", "my-skills", "software-factory", "install.sh"), ".", "--link", "--layout", "new"], { cwd: d, timeoutMs: 120_000 });
}

test("a link install removes the old link to the kit's rules and links the agents' settings instead", () => {
  const d = linkedProject();
  // the link a project linked before #258 has; the updated submodule no longer has its target
  mkdirSync(join(d, ".claude"), { recursive: true });
  symlinkSync("../vendor/my-skills/software-factory/kit/.claude/settings.json", join(d, ".claude", "settings.json"));
  const p = installLink(d);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("removed  .claude/settings.json");
  expect(lstatSync(join(d, ".claude", "settings.json"), { throwIfNoEntry: false })).toBeUndefined();
  const agent = join(d, ".claude", "factory", "settings.json");
  expect(lstatSync(agent).isSymbolicLink()).toBe(true);
  expect(read(agent)).toBe(read(KIT_AGENT_SETTINGS));
  const again = installLink(d); // safe to run twice
  expect(again.code, again.out).toBe(0);
  expect(again.stdout).not.toContain("removed");
});

test("a link install never touches the project's own settings file", () => {
  const d = linkedProject();
  write(join(d, ".claude", "settings.json"), '{"permissions": {"allow": ["Bash(mine *)"]}}\n');
  const p = installLink(d);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).not.toContain("removed  .claude/settings.json");
  expect(read(join(d, ".claude", "settings.json"))).toBe('{"permissions": {"allow": ["Bash(mine *)"]}}\n');
  expect(lstatSync(join(d, ".claude", "factory", "settings.json")).isSymbolicLink()).toBe(true);
});

test("factory agent starts claude with the same rules and starts nothing without them", () => {
  const d = tmp();
  const work = join(d, "proj");
  quiet(["git", "init", "-q", "-b", "main", work]);
  write(join(work, ".claude", "hooks", ".keep"), "");
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(work, ".claude", "hooks", f));
  write(join(work, ".claude", "factory", "settings.json"), read(KIT_AGENT_SETTINGS));
  write(join(work, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"], permissions: { allow: ["Bash(make*)"] } }));
  quiet(["git", "add", "-A"], work);
  quiet(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start"], work);
  const origin = join(d, "origin.git");
  quiet(["git", "init", "-q", "--bare", "-b", "main", origin]);
  quiet(["git", "remote", "add", "origin", origin], work);
  quiet(["git", "push", "-q", "origin", "HEAD:main"], work);
  const env = fakeClaude(d);
  let p = sh(["bash", join(SF, "factory"), "agent", "menelik"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const got = startedSettings(calls(env)[0] as string[]) as Settings;
  expect(got.permissions.deny).toEqual(kit().permissions.deny);
  expect(got.permissions.allow).toContain("Bash(make*)");
  expect(calls(env)[0]).not.toContain("--setting-sources");

  quiet(["git", "rm", "-q", "-r", ".claude/factory"], work);
  quiet(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "no rules"], work);
  quiet(["git", "push", "-q", "origin", "HEAD:main"], work);
  write(join(work, ".claude", "factory", "settings.json"), read(KIT_AGENT_SETTINGS)); // only in the folder: not enough
  p = sh(["bash", join(SF, "factory"), "agent", "menelik"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).not.toBe(0);
  expect(calls(env).length, "no second claude").toBe(1);
  expect(p.out).toContain("no_agent_settings");
});
