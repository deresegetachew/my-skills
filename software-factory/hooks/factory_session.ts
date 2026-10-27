#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// SessionStart hook: makes a plain `claude` session in a project folder or worktree a factory agent.
//
// What factory-loop.sh does for its runs, this does for a session you start yourself, for example
// `factory agent taytu` (or `cd "$(bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts worktree 2)" && claude`), for manual
// work in that agent's folder; to run the queue, use `factory loop -i`, which gives each task a fresh session:
//
//   1. Slot and name: slot 1 is the project folder, slot N `<project>-agents/<name>`; the names are `agents` in
//      factory.json (menelik, taytu, ...).
//   2. Checkout claim: records this session in the lock file, so factory-loop.sh won't use the same folder, and warns
//      when another live session already works here.
//   3. Submodules (`git submodule update --init`), then `commands.install` (worktrees), then `commands.agentSetup`.
//   4. Issues mode: registers the agent on GitHub (factory_agents.ts), so the dev manager sees it's alive.
//   5. Environment: writes `agentEnv` (own ports and database), FACTORY_AGENT and FACTORY_PID to CLAUDE_ENV_FILE, so
//      every command in the session uses them and `/next-task` claims its tasks as this agent. When the shared
//      Turborepo cache is set up (turbo.api), its TURBO_* variables go there too (factory_turbo.ts).
//
// Under factory-loop.sh (FACTORY_AGENT already set) it only updates the submodules: the loop did the rest.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { agentName, load, toFloat } from "./factory_config.ts";
import { agentEnv, slotOf } from "./factory_env.ts";
import { register } from "./factory_claims.ts";
import { agentEnv as turboEnv } from "./factory_turbo.ts";
import { bunCmd, run, runMain, shQuote } from "./factory_lib.ts";

function sh(cmd: string, env?: Record<string, string | undefined>) {
  return run(["/bin/sh", "-c", cmd], { env });
}

/** Whether a process's command line is Claude Code: the `claude` program, or node running Claude Code's script.
 * Only the program and node's script count, so a folder named claude (/home/claude/...) in an argument doesn't. */
export function isClaude(args: string): boolean {
  const words = args.split(/\s+/).filter((w) => w);
  if (!words.length) return false;
  const prog = basename(words[0] as string);
  if (prog === "claude") return true;
  return ["node", "nodejs", "bun"].includes(prog) && words.length > 1 &&
    ((words[1] as string).includes("claude-code") || basename(words[1] as string) === "claude");
}

/** The pid of the Claude process that started this hook (claims last as long as it runs). When none is found:
 * the parent process, or null with `strict` (the stop hook, which must never signal some other process). */
export function claudePid(strict = false): number | null {
  let pid = process.ppid;
  for (let i = 0; i < 8; i++) {
    const out = run(["ps", "-o", "ppid=,args=", "-p", String(Math.trunc(pid))]).stdout.trim();
    if (!out) break;
    const sp = out.indexOf(" ");
    const ppid = sp < 0 ? out : out.slice(0, sp);
    const args = sp < 0 ? "" : out.slice(sp + 1);
    if (isClaude(args.trim())) return pid;
    if (!/^\d+$/.test(ppid.trim()) || Number(ppid) <= 1) break;
    pid = Number(ppid);
  }
  return strict ? null : process.ppid;
}

async function main(): Promise<void> {
  try {
    JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // no event, or not JSON: nothing in it is needed
  }
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  process.chdir(root);
  if (!existsSync(join(".claude", "factory.json"))) return;
  if (existsSync(".gitmodules")) sh("git submodule update --init -q");
  if (process.env.FACTORY_AGENT) return; // factory-loop.sh set everything up

  const cfg = load();
  const slot = slotOf(null, root);
  const agent = agentName(cfg, slot);
  const pid = claudePid() as number;
  const notes: string[] = [];
  const other = register(agent, pid, root, toFloat(cfg.claimStaleHours ?? 6) ?? 6);
  if (other) {
    notes.push(`Another live session (pid ${other.pid ?? "None"}) already works in this folder as ${agent}. Two ` +
      "sessions in one folder share files and claims: use another worktree, " +
      "`cd \"$(bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts worktree <N>)\"`.");
  }

  const env = agentEnv(cfg, slot);
  env.FACTORY_AGENT = agent;
  env.FACTORY_PID = String(pid);
  const child = { ...process.env, ...env };
  const cmds = (cfg.commands ?? {}) as Record<string, string>;
  // Each session start (worktrees only): main may have new dependencies since the worktree was last used.
  if (cmds.install && slot !== 1) {
    if (sh(cmds.install, child).code !== 0) notes.push(`\`${cmds.install}\` failed in this worktree; run it before testing.`);
  }
  if (cmds.agentSetup) {
    if (sh(cmds.agentSetup, child).code !== 0) {
      notes.push(`\`${cmds.agentSetup}\` failed (is the local stack running?); tests that need it will fail.`);
    }
  }

  // The shared Turborepo cache (#59): the address, team and token go to the session's env file, never to the lines
  // this hook prints (they reach the agent's context). No cache set up, or none answering: nothing, with a note.
  const [turbo, turboUnset, turboNotes] = await turboEnv(cfg);
  notes.push(...turboNotes);

  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    let text = "";
    for (const [k, v] of Object.entries(env)) text += `export ${k}=${shQuote(v)}\n`;
    for (const k of turboUnset) text += `unset ${k}\n`;
    for (const [k, v] of Object.entries(turbo)) text += `export ${k}=${shQuote(v)}\n`;
    appendFileSync(envFile, text);
  } else {
    notes.push("This Claude version gave the hook no CLAUDE_ENV_FILE, so the slot's variables aren't set: " +
      "run `eval \"$(bun --no-env-file --config=/dev/null .claude/hooks/factory_env.ts)\"` in each command, or use factory-loop.sh.");
  }

  // issues mode: the agent's own issue on GitHub says it's alive (factory_agents.ts)
  run([...bunCmd(join(import.meta.dir, "factory_agents.ts")), "register", "--agent", agent], { env: child, timeoutMs: 30_000 });
  const shown = Object.entries(env).filter(([k]) => k !== "FACTORY_PID").map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`Factory slot ${slot}: this session is ${agent} (${shown}). /next-task claims its tasks as ${agent}.`);
  for (const n of notes) console.log(n);
}

if (import.meta.main) await runMain(main);
