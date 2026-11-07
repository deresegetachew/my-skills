// Every coding agent works in its own worktree, `<project>-agents/<name>`, the first one too (#572). The project folder
// stays on the main branch, for the owner, the web UI, the hub's `factory` commands and `factory update`: an agent's
// branch there would make them run that branch's older copy of the factory.
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkout, project } from "./claims_support.ts";
import { doctor, lines, machine, project as doctorProject } from "./doctor_support.ts";
import { KIT_AGENT_SETTINGS, LOGGING_STUB, must } from "./loop_support.ts";
import { HOOKS, read, runHook, SF, sh, tmp, write, writeExe } from "./support.ts";

const loops: { kill(): void }[] = [];
afterAll(() => loops.forEach((l) => l.kill()));

function branch(dir: string): string {
  return sh(["git", "-C", dir, "symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim();
}

function real(path: string): string {
  return realpathSync(path);
}

test("with two agents both work in their own worktree and the project folder stays on main", () => {
  const clone = project(); // agents: menelik, taytu, haile, tewodros
  const head = sh(["git", "-C", clone, "rev-parse", "HEAD"]).stdout.trim();
  const got: string[][] = [];
  for (let i = 0; i < 2; i++) {
    const [p, l] = checkout(clone);
    loops.push(l);
    expect(p.code, p.out).toBe(0);
    got.push(p.stdout.trim().split(/\s+/));
  }
  expect(got.map((g) => g[0])).toEqual(["menelik", "taytu"]);
  for (const [name, dir] of got) {
    expect(real(dir as string)).toBe(real(clone + "-agents") + "/" + name);
    expect(existsSync(join(dir as string, ".claude", "factory.json")), `${dir} is a checkout`).toBe(true);
  }
  expect(branch(clone)).toBe("main");
  expect(sh(["git", "-C", clone, "rev-parse", "HEAD"]).stdout.trim()).toBe(head);
});

test("the first agent's folder is its worktree, by name and by slot", () => {
  const clone = project();
  for (const who of ["menelik", "1"]) {
    const p = runHook("factory_claims", ["worktree", who], { cwd: clone });
    expect(p.code, p.out).toBe(0);
    expect(real(p.stdout.trim().split("\n").pop() as string)).toBe(real(clone + "-agents") + "/menelik");
  }
  // The first name keeps slot 1, so its ports and database, also from its folder alone.
  for (const args of [["--agent", "menelik"], []]) {
    const env = runHook("factory_env", args, { cwd: clone + "-agents/menelik", env: { ...process.env, FACTORY_AGENT: "" } });
    expect(env.stdout, env.out).toContain("export FACTORY_SLOT=1\n");
  }
});

test("an old claim on the project folder moves to the first agent's worktree when its loop starts", () => {
  const clone = project();
  // What an older loop left: menelik claimed the project folder itself, and that loop has exited.
  const state = join(clone, ".git", "factory");
  write(join(state, "claims.json"), JSON.stringify({ checkouts: { menelik: { agent: "menelik", pid: 999999,
    host: "elsewhere-not-this-host", at: 0, path: clone } }, tasks: {} }));
  const [p, l] = checkout(clone);
  loops.push(l);
  expect(p.code, p.out).toBe(0);
  const [name, dir] = p.stdout.trim().split(/\s+/) as [string, string];
  expect(name).toBe("menelik");
  expect(real(dir)).toBe(real(clone + "-agents") + "/menelik");
  const claims = JSON.parse(read(join(state, "claims.json"))) as { checkouts: Record<string, { path: string }> };
  expect(claims.checkouts.menelik?.path).toBe(dir);
});

test("a loop restarted from the project folder moves to its worktree", () => {
  const clone = project();
  const l = { pid: process.pid, kill: () => undefined }; // relocate only needs a pid that holds nothing else
  const p = runHook("factory_claims", ["relocate", "--agent", "menelik", "--pid", String(l.pid)], { cwd: clone });
  expect(p.code, p.out).toBe(0);
  expect(real(p.stdout.trim())).toBe(real(clone + "-agents") + "/menelik");
  expect(branch(clone)).toBe("main");
});

test("relocate refuses a name another live loop holds, and changes nothing", () => {
  const clone = project();
  const [first, l] = checkout(clone);
  loops.push(l);
  expect(first.code, first.out).toBe(0);
  const before = read(join(clone, ".git", "factory", "claims.json"));
  const p = runHook("factory_claims", ["relocate", "--agent", "menelik", "--pid", "1"], { cwd: clone });
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("menelik");
  expect(read(join(clone, ".git", "factory", "claims.json"))).toBe(before);
});

// --- the real loop, with the real claims, in a throwaway project -----------------------------------------------------

/** The stub `claude`: records the folder it ran in, then works on a task branch there, as an agent does. */
const CLAUDE = String.raw`#!/usr/bin/env bash
echo "claude-cwd $PWD" >> "$LOOP_LOG"
git checkout -q -b task/1-first-task
`;

/** A clone of a bare origin with two agents, the real factory-loop.sh and hooks (next_task stubbed, no trust gate). */
function realLoopProject(): [string, Record<string, string | undefined>] {
  const d = tmp();
  const origin = join(d, "origin.git");
  const work = join(d, "proj");
  must(["git", "init", "-q", "--bare", "-b", "main", origin]);
  must(["git", "clone", "-q", origin, work]);
  const hooks = join(work, ".claude", "hooks");
  cpSync(HOOKS, hooks, { recursive: true });
  rmSync(join(hooks, "factory_trust.ts")); // the trust gate reads ~/.claude.json, which a test leaves alone
  for (const name of ["next_task.ts"]) writeExe(join(hooks, name), LOGGING_STUB);
  write(join(work, ".claude", "factory", "settings.json"), readFileSync(KIT_AGENT_SETTINGS, "utf8"));
  write(join(work, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"], waitMinutes: 0 }));
  cpSync(join(SF, "factory-loop.sh"), join(work, "factory-loop.sh"));
  must(["git", "add", "-A"], work);
  must(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start"], work);
  must(["git", "push", "-q", "origin", "HEAD:main"], work);
  writeExe(join(d, "bin", "claude"), CLAUDE);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`,
    LOOP_LOG: join(d, "log"), LOOP_STATE: join(d, "state"), FACTORY_REMOTE_CONTROL: "0", GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_LOOP",
    "FACTORY_ROLE", "FACTORY_NAME", "CLAUDE_PROJECT_DIR"]) delete env[k];
  return [work, env];
}

function claudeDirs(env: Record<string, string | undefined>): string[] {
  const log = env.LOOP_LOG as string;
  if (!existsSync(log)) return [];
  return read(log).split("\n").filter((l) => l.startsWith("claude-cwd ")).map((l) => l.slice("claude-cwd ".length));
}

test("the first agent's loop works in its worktree and never moves the project folder off main", () => {
  const [work, env] = realLoopProject();
  const p = sh(["bash", "./factory-loop.sh", "--once"], { cwd: work, env, timeoutMs: 120_000 });
  const dirs = claudeDirs(env);
  expect(dirs.length, p.out).toBe(1);
  expect(real(dirs[0] as string)).toBe(real(work + "-agents") + "/menelik");
  expect(branch(work), p.out).toBe("main");
});

test("a loop that restarts itself from the project folder moves to its worktree for the next task", () => {
  const [work, env] = realLoopProject();
  // What an older loop hands its new script when main brings a new factory-loop.sh: the project folder.
  const p = sh(["bash", "./factory-loop.sh", "--once"], { cwd: work, timeoutMs: 120_000,
    env: { ...env, FACTORY_RELOAD_AGENT: "menelik", FACTORY_RELOAD_DIR: work } });
  const dirs = claudeDirs(env);
  expect(dirs.length, p.out).toBe(1);
  expect(real(dirs[0] as string)).toBe(real(work + "-agents") + "/menelik");
  expect(branch(work), p.out).toBe("main");
});

// --- factory doctor ---------------------------------------------------------------------------------------------------

test("doctor notes a project folder that is not on the main branch, with the fix", () => {
  const d = doctorProject();
  must(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x", "--allow-empty"], d);
  must(["git", "checkout", "-q", "-b", "task/7-something"], d);
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  const found = lines(p, "note").filter((l) => l.includes("project folder") && l.includes("task/7-something"));
  expect(found.length, p.stdout).toBe(1);
  expect(found[0]).toMatch(/`git -C \S+ switch main/);
});

test("doctor says ok for a project folder on the main branch", () => {
  const d = doctorProject();
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "ok").some((l) => l.includes("project folder") && l.includes("main")), p.stdout).toBe(true);
  expect(lines(p, "note").some((l) => l.includes("project folder is on")), p.stdout).toBe(false);
});
