// Running the real factory-loop.sh in a throwaway repo with stub hooks and a stub `claude` (the loop tests: countdown,
// reload, once, machines, autostart; also for the other loop tests to share). Not a test file.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { SF, sh, tmp, write, writeExe } from "./support.ts";

/** A stub hook: logs "<its file name> <args>" to LOOP_LOG (when set). factory_claims checkout prints "solo <cwd>";
 * next_task hands out one task ("1.1 First task"), then nothing (exit 1). */
export const STUB = String.raw`#!/usr/bin/env bun
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

export type Env = Record<string, string | undefined>;

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
  for (const name of stubs) writeExe(join(work, ".claude", "hooks", name), STUB);
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

/** The stub `claude` of the MCP tests: it records its arguments, one JSON list per call, in CLAUDE_LOG. */
export const CLAUDE = '#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\n' +
  'appendFileSync(process.env.CLAUDE_LOG as string, JSON.stringify(process.argv.slice(2)) + "\\n");\n';

export function fakeClaude(d: string): Env {
  writeExe(join(d, "bin", "claude"), CLAUDE);
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, CLAUDE_LOG: join(d, "claude.log"),
    LOOP_STATE: join(d, "state"), FACTORY_REMOTE_CONTROL: "0" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_LOOP",
    "CLAUDE_PROJECT_DIR"]) delete env[k];
  return env;
}

/** test_mcp_isolation's loop_project without factory_mcp: [work, env] with the recording `claude`. */
export function loopProject(): [string, Env] {
  const [d, work] = loopRepo([...STUB_HOOKS, "factory_remote.ts"]);
  return [work, fakeClaude(d)];
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
