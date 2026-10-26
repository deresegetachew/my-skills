// Running the real factory-loop.sh in a throwaway repo with stub hooks and a stub `claude`: the stub loop project and
// a fake `claude` that records its arguments (mcp_isolation, models), and a logging stub loop (countdown, reload, once,
// machines, autostart). Not a test file.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOOKS, SF, sh, tmp, write, writeExe } from "./support.ts";

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


// --- the logging stub loop ---------------------------------------------------------------------------------------

/** A stub hook: logs "<its file name> <args>" to LOOP_LOG (when set). factory_claims checkout prints "solo <cwd>";
 * next_task hands out one task ("1.1 First task"), then nothing (exit 1). */
export const LOGGING_STUB = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(import.meta.path);
const args = process.argv.slice(2);
if (process.env.LOOP_LOG) appendFileSync(process.env.LOOP_LOG, name + " " + args.join(" ") + "\n");
if (name === "factory_claims.ts" && args[0] === "checkout") console.log("solo", process.cwd());
if (name === "next_task.ts") {
  const state = process.env.LOOP_STATE as string;
  const n = existsSync(state) ? Number(readFileSync(state, "utf8")) : 0;
  writeFileSync(state, String(n + 1));
  if (n === 0) { console.log(process.env.STUB_TASK || "1.1 First task"); process.exit(0); }
  process.exit(1);
}
`;

export const STUB_HOOKS = ["factory_claims.ts", "factory_env.ts", "factory_agents.ts", "next_task.ts"];

export function must(cmd: string[], cwd?: string, env?: Env): void {
  const p = sh(cmd, { cwd, env });
  if (p.code !== 0) throw new Error(`${cmd.join(" ")}: ${p.out}`);
}

export function commitAll(work: string, message: string): void {
  must(["git", "add", "-A"], work);
  must(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], work);
}

export function push(work: string): void {
  must(["git", "push", "-q", "origin", "HEAD:main"], work);
}

/** A clone of a bare origin with factory-loop.sh, stub hooks and `waitMinutes: 0`, pushed to main: [root, work].
 * `stubs` names the stub hooks (default: claims, env, agents, next_task); `extra` writes more files first. */
export function loopRepo(stubs: string[] = STUB_HOOKS, extra: Record<string, string> = {}): [string, string] {
  const d = tmp();
  const origin = join(d, "origin.git");
  const work = join(d, "work");
  must(["git", "init", "-q", "--bare", "-b", "main", origin]);
  must(["git", "clone", "-q", origin, work]);
  for (const name of stubs) writeExe(join(work, ".claude", "hooks", name), LOGGING_STUB);
  write(join(work, ".claude", "factory.json"), '{"waitMinutes": 0}');
  for (const [rel, text] of Object.entries(extra)) write(join(work, rel), text);
  copyFileSync(join(SF, "factory-loop.sh"), join(work, "factory-loop.sh"));
  commitAll(work, "start");
  push(work);
  return [d, work];
}

/** test_loop_countdown's setup: [work, env] with a stub `claude` that logs its arguments to LOOP_LOG. */
export function setup(): [string, Env] {
  const [d, work] = loopRepo();
  writeExe(join(d, "bin", "claude"), '#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\n');
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, LOOP_LOG: join(d, "log"), LOOP_STATE: join(d, "state") };
  for (const k of ["FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR"]) delete env[k];
  return [work, env];
}

/** Runs the loop with a controlling terminal (so it can read /dev/tty): [exit code or null, output]. `keys` are typed
 * once the loop asks whether to stop. */
export async function runOnATerminal(work: string, env: Env, timeoutS: number, args: string[] = ["-i", "3"],
  keys = ""): Promise<[number | null, string]> {
  let out = "";
  let sent = false;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const proc = Bun.spawn(["bash", "./factory-loop.sh", ...args], {
    cwd: work, env: clean,
    terminal: { cols: 200, rows: 50, data(term, data) {
      out += new TextDecoder().decode(data);
      if (keys && !sent && out.includes("type q and Enter to stop")) {
        sent = true;
        term.write(keys);
      }
    } },
  });
  const timer = setTimeout(() => proc.kill(9), timeoutS * 1000);
  const code = await proc.exited;
  clearTimeout(timer);
  await Bun.sleep(50);
  proc.terminal?.close();
  return [proc.signalCode === "SIGKILL" ? null : code, out];
}
