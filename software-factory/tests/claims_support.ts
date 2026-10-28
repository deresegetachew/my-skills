// Helpers for the tests that take checkouts with factory_claims.ts (agent names, machines). Not a test file.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Proc, runHook, sh, tmp, write, writeExe } from "./support.ts";

export const NAMES = ["menelik", "taytu", "haile", "tewodros"];

/** The environment without the variables a test must set itself, and with a git identity. */
export function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_PID", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"]) delete env[k];
  return env;
}

function must(cmd: string[], env = baseEnv()): void {
  const p = sh(cmd, { env });
  if (p.code !== 0) throw new Error(`${cmd.join(" ")}: ${p.out}`);
}

/** A clone (named proj) of a bare origin whose factory.json names four agents. */
export function project(): string {
  const top = tmp();
  const [seed, origin, clone] = ["seed", "origin.git", "proj"].map((n) => join(top, n)) as [string, string, string];
  must(["git", "init", "-q", "-b", "main", seed]);
  write(join(seed, ".claude", "factory.json"), JSON.stringify({ agents: NAMES }));
  must(["git", "-C", seed, "add", "-A"]);
  must(["git", "-C", seed, "commit", "-qm", "x"]);
  must(["git", "clone", "-q", "--bare", seed, origin]);
  must(["git", "clone", "-q", origin, clone]);
  return clone;
}

/** A live process that looks like a factory loop to `ps` (a script named factory-loop.sh). */
export function aLoop(): { pid: number; kill(): void } {
  const d = tmp();
  mkdirSync(d, { recursive: true });
  const script = writeExe(join(d, "factory-loop.sh"), "#!/bin/sh\nsleep 60\n");
  // No pipes of ours inherited: the `sleep` this script leaves behind when killed must not keep a reader waiting.
  const p = Bun.spawn([script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return { pid: p.pid, kill: () => p.kill(9) };
}

export function checkout(clone: string, agents?: string, extra: Record<string, string> = {}): [Proc, { pid: number; kill(): void }] {
  const loop = aLoop();
  const env = { ...baseEnv(), ...(agents !== undefined ? { FACTORY_AGENTS: agents } : {}), ...extra };
  const p = runHook("factory_claims", ["checkout", "--pid", String(loop.pid)], { cwd: clone, env });
  return [p, loop];
}
