// Live artifact access per role (#104, layer 2). Interactive Claude Code sessions have the built-in `Artifact` tool
// (and `DesignSync`); unattended `claude -p` passes have no artifact tool at all. The factory denies both tools to every
// role session unless `roles.product-owner.artifacts` is on, as main has it on origin; the dev manager and the coding
// agents are always denied them. An agent can't turn it on in its own folder.
//
// Runs the real loop and hooks in a throwaway project (a bare origin and a clone) with a fake `claude` that logs its
// arguments.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { calls, type Env as LoopEnv, KIT_AGENT_SETTINGS, loopProject, startedSettings } from "./loop_support.ts";
import { claudeCalls, type Env, factory, git, project, type Row } from "./roles_support.ts";
import { BUN, KIT, read, sh, write } from "./support.ts";

const TOOLS = ["Artifact", "DesignSync"];
const PO_WORK = { issues: [{ number: 7, title: "Pick the palette", labels: [{ name: "factory:needs-product" }] }] };

type Settings = { permissions?: { allow?: string[]; deny?: string[] } };

/** The settings `factory_roles.ts claude-flags <role>` gives a role's sessions, run in `work`. */
function roleSettings(work: string, env: Env, role: string): Settings {
  const p = sh([...BUN, "--config=/dev/null", join(".claude", "hooks", "factory_roles.ts"), "claude-flags", role], { cwd: work, env });
  expect(p.code, p.out).toBe(0);
  const lines = p.stdout.split("\n").filter(Boolean);
  const i = lines.indexOf("--settings");
  expect(i, p.stdout).toBeGreaterThanOrEqual(0);
  return JSON.parse(lines[i + 1] as string) as Settings;
}

const denied = (s: Settings): string[] => s.permissions?.deny ?? [];

function poProject(on: boolean | undefined, profile = true): [string, Env] {
  const po: Row = { names: ["eleni"], busyMinutes: 0, idleMinutes: 0 };
  if (on !== undefined) po.artifacts = on;
  if (profile) po.profile = ".claude/manager/settings.json";
  const [, work, env] = project({ db: PO_WORK, cfg: { roles: { "dev-manager": { names: ["lead"], artifacts: true }, "product-owner": po } } });
  return [work, env];
}

// --- the coding agents ----------------------------------------------------------------------------------------------

test("the kit's rules for coding agents deny the artifact tools", () => {
  const deny = (JSON.parse(read(KIT_AGENT_SETTINGS)) as Settings).permissions?.deny ?? [];
  for (const t of TOOLS) expect(deny).toContain(t);
});

test("a coding agent starts with the artifact tools denied, whatever the roles settings say", () => {
  const json = JSON.stringify({ waitMinutes: 0, roles: { "product-owner": { artifacts: true }, "coding-agent": { artifacts: true } } });
  const [work, env] = loopProject(undefined, undefined, json);
  // main's rules without the two denies (an older release): the started settings still have them
  const kit = JSON.parse(read(KIT_AGENT_SETTINGS)) as Settings;
  kit.permissions = { ...kit.permissions, deny: denied(kit).filter((d) => !TOOLS.includes(d)) };
  write(join(work, ".claude", "factory", "settings.json"), JSON.stringify(kit));
  git(work, "add", "-A");
  git(work, "commit", "-qm", "rules without the artifact denies");
  git(work, "push", "-q", "origin", "HEAD:main");
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env: env as LoopEnv, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const got = startedSettings(calls(env as LoopEnv)[0] as string[]) as Settings;
  for (const t of TOOLS) expect(denied(got)).toContain(t);
});

// --- the dev manager ------------------------------------------------------------------------------------------------

test("the dev manager's sessions always have the artifact tools denied", () => {
  const [work, env] = poProject(true); // roles.dev-manager.artifacts is set too: not a setting, ignored
  const s = roleSettings(work, env, "dev-manager");
  for (const t of TOOLS) expect(denied(s)).toContain(t);
});

// --- the product owner ----------------------------------------------------------------------------------------------

test("the product owner's sessions have the artifact tools denied by default", () => {
  for (const profile of [true, false]) {
    const [work, env] = poProject(undefined, profile);
    const s = roleSettings(work, env, "product-owner");
    for (const t of TOOLS) expect(denied(s), `profile ${profile}`).toContain(t);
  }
});

test("with roles.product-owner.artifacts on main the product owner's sessions may use them", () => {
  for (const profile of [true, false]) {
    const [work, env] = poProject(true, profile);
    const s = roleSettings(work, env, "product-owner");
    for (const t of TOOLS) expect(denied(s), `profile ${profile}`).not.toContain(t);
    if (profile) expect(s.permissions?.allow).toContain("Bash(gh api *)"); // the profile is still there
  }
});

test("on, a profile's own deny of the tools is dropped for the product owner but kept for the dev manager", () => {
  const kitProfile = read(join(KIT, ".claude", "manager", "settings.json"));
  for (const t of TOOLS) expect((JSON.parse(kitProfile) as Settings).permissions?.deny).toContain(t);
  const [, work, env] = project({ db: PO_WORK, files: { ".claude/manager/settings.json": kitProfile }, cfg: { roles: {
    "dev-manager": { names: ["lead"] },
    "product-owner": { names: ["eleni"], busyMinutes: 0, idleMinutes: 0, artifacts: true, profile: ".claude/manager/settings.json" } } } });
  const po = roleSettings(work, env, "product-owner");
  for (const t of TOOLS) expect(denied(po)).not.toContain(t);
  expect(denied(po)).toContain("Bash(gh pr merge*)"); // the rest of the profile's denies stay
  for (const t of TOOLS) expect(denied(roleSettings(work, env, "dev-manager"))).toContain(t);
});

test("turning it on in the product owner's own folder does not take effect: main's value is used", () => {
  const [work, env] = poProject(false);
  const cfg = JSON.parse(read(join(work, ".claude", "factory.json"))) as { roles: Record<string, Row> };
  (cfg.roles["product-owner"] as Row).artifacts = true;
  write(join(work, ".claude", "factory.json"), JSON.stringify(cfg)); // an uncommitted edit
  for (const t of TOOLS) expect(denied(roleSettings(work, env, "product-owner"))).toContain(t);
  // a commit on a branch that is not main does not count either
  git(work, "checkout", "-q", "-b", "po/on");
  git(work, "commit", "-qam", "turn it on");
  git(work, "push", "-q", "origin", "po/on");
  for (const t of TOOLS) expect(denied(roleSettings(work, env, "product-owner"))).toContain(t);
});

test("turning it off in the folder while main has it on leaves it on", () => {
  const [work, env] = poProject(true);
  const cfg = JSON.parse(read(join(work, ".claude", "factory.json"))) as { roles: Record<string, Row> };
  (cfg.roles["product-owner"] as Row).artifacts = false;
  write(join(work, ".claude", "factory.json"), JSON.stringify(cfg));
  for (const t of TOOLS) expect(denied(roleSettings(work, env, "product-owner"))).not.toContain(t);
});

test("when main can't be read the product owner's sessions have the artifact tools denied", () => {
  const [work, env] = poProject(true);
  git(work, "remote", "set-url", "origin", join(work, "no-such-origin.git"));
  for (const t of TOOLS) expect(denied(roleSettings(work, env, "product-owner"))).toContain(t);
});

test("a product owner pass starts with the setting's denies", () => {
  const [offWork, offEnv] = poProject(undefined);
  expect(factory(offWork, offEnv, ["product-owner", "loop", "--once"]).code).toBe(0);
  const off = claudeCalls(offEnv)[0] as string;
  for (const t of TOOLS) expect(off).toContain(`"${t}"`);
  const [onWork, onEnv] = poProject(true);
  expect(factory(onWork, onEnv, ["product-owner", "loop", "--once"]).code).toBe(0);
  const on = claudeCalls(onEnv)[0] as string;
  for (const t of TOOLS) expect(on).not.toContain(`"${t}"`);
});

// --- the setting ----------------------------------------------------------------------------------------------------

test("factory settings knows roles.product-owner.artifacts, off by default", () => {
  const [work, env] = poProject(undefined);
  const p = factory(work, env, ["settings", "help", "roles.product-owner.artifacts"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("roles.product-owner.artifacts");
  expect(p.stdout).toContain("false");
  expect(p.stdout).toContain("Artifact");
});
