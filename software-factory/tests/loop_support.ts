// A stub loop project and a fake `claude` that records its arguments, for the tests that run factory-loop.sh and
// `factory agent` for real (mcp_isolation, models). Not a test file.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOOKS, SF, tmp, write, writeExe } from "./support.ts";

export const EMPTY = '{"mcpServers":{}}';
export const NO_CONNECTORS = '{"disableClaudeAiConnectors": true}';

/** next_task hands out one task, then nothing (waitMinutes 0 makes the loop exit). One stub serves every hook name. */
export const STUB = String.raw`#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(import.meta.path);
const a = process.argv.slice(2);
if (name === "factory_claims.ts" && a[0] === "checkout") console.log("solo", process.cwd());
if (name === "next_task.ts") {
  const state = process.env.LOOP_STATE as string;
  const n = existsSync(state) ? Number(readFileSync(state, "utf8")) : 0;
  writeFileSync(state, String(n + 1));
  if (n === 0) { console.log("1.1 First task"); process.exit(0); }
  process.exit(1);
}
`;

export const CLAUDE = String.raw`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CLAUDE_LOG as string, JSON.stringify(process.argv.slice(2)) + "\n");
`;

export type Env = Record<string, string | undefined>;

/** A bin folder with the fake claude first on PATH; its calls go to <d>/claude.log. */
export function fakeClaude(d: string): Env {
  const bin = join(d, "bin");
  writeExe(join(bin, "claude"), CLAUDE);
  const env: Env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CLAUDE_LOG: join(d, "claude.log"),
    LOOP_STATE: join(d, "state"), FACTORY_REMOTE_CONTROL: "0" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_LOOP",
    "CLAUDE_PROJECT_DIR"]) delete env[k];
  return env;
}

/** Run a command quietly; throw when it fails. */
export function quiet(cmd: string[], cwd?: string): void {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${p.exitCode})`);
}

/** A clone of a bare origin with stub hooks, the real factory_mcp.ts and factory-loop.sh, committed and pushed to main.
 * `mcp` is committed as .mcp.json; `worktreeMcp` is written afterwards, only in this worktree. */
export function loopProject(mcp?: unknown, worktreeMcp?: unknown): [string, Env] {
  const d = tmp();
  const origin = join(d, "origin.git");
  const work = join(d, "work");
  quiet(["git", "init", "-q", "--bare", "-b", "main", origin]);
  quiet(["git", "clone", "-q", origin, work]);
  const hooks = join(work, ".claude", "hooks");
  for (const name of ["factory_claims.ts", "factory_env.ts", "factory_agents.ts", "factory_remote.ts", "next_task.ts"]) {
    write(join(hooks, name), STUB);
  }
  for (const f of ["factory_mcp.ts", "factory_lib.ts"]) copyFileSync(join(HOOKS, f), join(hooks, f));
  write(join(work, ".claude", "factory.json"), '{"waitMinutes": 0}');
  if (mcp !== undefined) write(join(work, ".mcp.json"), JSON.stringify(mcp));
  copyFileSync(join(SF, "factory-loop.sh"), join(work, "factory-loop.sh"));
  quiet(["git", "add", "-A"], work);
  quiet(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start"], work);
  quiet(["git", "push", "-q", "origin", "HEAD:main"], work);
  if (worktreeMcp !== undefined) write(join(work, ".mcp.json"), JSON.stringify(worktreeMcp)); // untracked, or an uncommitted edit
  return [work, fakeClaude(d)];
}

/** Every argument list the fake claude was called with. */
export function calls(env: Env): string[][] {
  const log = env.CLAUDE_LOG as string;
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

/** The value after a flag; throws when the flag is not there. */
export function flag(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i < 0) throw new Error(`${name} not in ${JSON.stringify(args)}`);
  return args[i + 1] as string;
}

export const MAIN_COPY = join(".git", "factory-mcp.json");

export function mainCopy(work: string): string {
  return join(resolve(work), MAIN_COPY);
}

