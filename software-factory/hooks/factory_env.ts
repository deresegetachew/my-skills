#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Per-loop environment, so several loops on one machine don't share ports, databases or queues.
//
// Each loop has a slot: 1 for the project folder, N for the worktree `<project>-agents/<name>` of the Nth name in
// `agents` (menelik, taytu, ...). `agentEnv` in .claude/factory.json maps variable names to templates:
//
//   {slot}        the slot number: 1, 2, 3 ...
//   {suffix}      "" in slot 1, "_N" in slot N (a database name: remanual, remanual_2 ...)
//   {port:4101}   4101 in slot 1, 4101 + portStep * (N - 1) in slot N (portStep defaults to 10)
//
// Slot 1 gets the project's defaults, so the main folder works exactly as before.
//
//   eval "$(bun --no-env-file --config=/dev/null .claude/hooks/factory_env.ts)"            in a worktree: the slot comes from the folder name
//   eval "$(bun --no-env-file --config=/dev/null .claude/hooks/factory_env.ts --agent taytu)"
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_env.ts --dotenv              KEY=value lines instead of exports
//
// factory-loop.sh does the eval for you and then runs `commands.agentSetup` (for example, create the slot's database)
// before the first task.
import { resolve } from "node:path";
import { agentSlot, type Config, load } from "./factory_config.ts";
import { die, pyRepr, runMain, shQuote } from "./factory_lib.ts";

/** The slot of an agent name (or the old agent-N), else of the folder (<project>-agents/<name>), else 1. */
export function slotOf(agent?: string | null, path?: string | null): number {
  const cfg = load();
  const name = agent || process.env.FACTORY_AGENT || "";
  const slot = agentSlot(cfg, name);
  if (slot) return slot;
  const m = /-agents[/\\]([^/\\]+)$/.exec(resolve(path || "."));
  return m ? (agentSlot(cfg, m[1]) ?? 1) : 1;
}

export function render(template: string, slot: number, step: number): string {
  return template.replace(/\{([a-z]+(?::\d+)?)\}/g, (_all, inner: string) => {
    const [key, arg = ""] = inner.split(":", 2) as [string, string?];
    if (key === "slot") return String(slot);
    if (key === "suffix") return slot === 1 ? "" : `_${slot}`;
    if (key === "port") return String(Number(arg) + step * (slot - 1));
    die(`agentEnv: unknown placeholder {${inner}} in ${pyRepr(template)}`);
  });
}

function pyInt(v: unknown): number {
  const n = typeof v === "number" ? Math.trunc(v) : typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v) ? Number(v) : NaN;
  if (Number.isNaN(n)) throw new Error(`invalid literal for int(): ${JSON.stringify(v)}`);
  return n;
}

export function agentEnv(cfg: Config, slot: number): Record<string, string> {
  const step = pyInt(cfg.portStep ?? 10);
  const env: Record<string, string> = { FACTORY_SLOT: String(slot) };
  for (const [key, template] of Object.entries(cfg.agentEnv ?? {})) {
    if (key.startsWith("_")) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      // exported and eval'd by the loop and the session hook
      die(`agentEnv: ${pyRepr(key)} isn't a valid variable name (letters, digits and _ only)`);
    }
    env[key] = render(typeof template === "string" ? template : JSON.stringify(template), slot, step);
  }
  return env;
}

function main(argv: string[]): number {
  let agent: string | null = null;
  let dotenv = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--agent" && i + 1 < argv.length) agent = argv[++i] as string;
    else if (a.startsWith("--agent=")) agent = a.slice(8);
    else if (a === "--dotenv") dotenv = true;
    else {
      process.stderr.write("usage: factory_env.ts [-h] [--agent AGENT] [--dotenv]\n" +
        `factory_env.ts: error: unrecognized arguments: ${argv.slice(i).join(" ")}\n`);
      return 2;
    }
  }
  const here = process.cwd();
  const cfg = load();
  const env = agentEnv(cfg, slotOf(agent, here));
  for (const [k, v] of Object.entries(env)) console.log(dotenv ? `${k}=${v}` : `export ${k}=${shQuote(v)}`);
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
