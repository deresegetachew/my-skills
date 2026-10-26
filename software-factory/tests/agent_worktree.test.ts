// A new agent worktree gets its submodules, so the kit's links in .claude/ resolve before Claude starts (#46).
import { expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, runHook, SF, sh, tmp, write, writeExe } from "./support.ts";

const FACTORY = join(SF, "factory");

function env(): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"]) delete e[k];
  return e;
}

function git(cwd: string | null, ...a: string[]): void {
  const p = sh(["git", ...a], { cwd: cwd ?? undefined, env: env() });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
}

/** A bare origin whose .claude/settings.json is a link into a submodule, and a fresh clone of it. */
function project(): string {
  const top = tmp();
  const [kit, origin, work, seedKit] = ["kit.git", "origin.git", "seed", "kit-seed"].map((n) => join(top, n)) as string[];
  write(join(seedKit as string, "kit", "settings.json"), JSON.stringify({ hooks: {} }));
  git(null, "init", "-q", "-b", "main", seedKit as string);
  git(seedKit as string, "add", "-A");
  git(seedKit as string, "commit", "-qm", "kit");
  git(null, "clone", "-q", "--bare", seedKit as string, kit as string);
  git(null, "init", "-q", "-b", "main", work as string);
  git(work as string, "submodule", "add", "-q", kit as string, "vendor/my-skills");
  write(join(work as string, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"] }));
  symlinkSync("../vendor/my-skills/kit/settings.json", join(work as string, ".claude", "settings.json"));
  git(work as string, "add", "-A");
  git(work as string, "commit", "-qm", "project");
  git(null, "clone", "-q", "--bare", work as string, origin as string);
  const clone = join(top, "proj");
  git(null, "clone", "-q", "--recurse-submodules", origin as string, clone);
  return clone;
}

test("a new worktree gets the submodule so the settings link resolves", () => {
  const clone = project();
  const p = runHook("factory_claims", ["worktree", "taytu"], { cwd: clone, env: env() });
  expect(p.code, p.out).toBe(0);
  const lines = p.stdout.trim().split("\n");
  const path = lines[lines.length - 1] as string;
  expect(path === clone + "-agents/taytu" || path.endsWith("/proj-agents/taytu")).toBe(true);
  expect(statSync(join(path, "vendor", "my-skills", "kit", "settings.json")).isFile(), readdirSync(path).join(",")).toBe(true);
  expect(existsSync(join(path, ".claude", "settings.json"))).toBe(true); // the settings link resolves
});

test("factory agent refuses to start claude without the settings", () => {
  const clone = project();
  const wt = clone + "-agents/taytu";
  git(clone, "worktree", "add", "-q", "--detach", wt, "origin/main"); // made by hand, no submodule
  // Break the submodule in that worktree so it can't be fetched, and leave the link dangling.
  renameSync(join(wt, ".gitmodules"), join(wt, ".gitmodules.off"));
  const fake = tmp();
  writeExe(join(fake, "claude"), "#!/bin/sh\necho CLAUDE STARTED\n");
  const hooks = join(clone, ".claude", "hooks");
  write(join(hooks, ".keep"), "");
  for (const f of readdirSync(HOOKS)) if (!existsSync(join(hooks, f))) symlinkSync(join(HOOKS, f), join(hooks, f));
  const p = sh(["bash", FACTORY, "agent", "taytu"], { cwd: clone, env: { ...env(), PATH: `${fake}:${process.env.PATH}`,
    FACTORY_REMOTE_CONTROL: "0" } });
  expect(p.code).not.toBe(0);
  expect(p.stdout).not.toContain("CLAUDE STARTED");
  expect(p.stderr).toContain("settings.json doesn't resolve");
});
