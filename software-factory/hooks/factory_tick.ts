#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// One dev manager tick that costs nothing when there is nothing to do (#71).
//
//   factory manage-tick [--dry-run] [--print-command]
//
// Runs the precheck (factory_wait.ts precheck, which reads GitHub only). When it finds nothing, it prints
// `nothing to do` and exits 0: no model call, no tokens. Only when it lists work does it start ONE Claude session,
// `claude -p "/manage-pass"`, on the manager settings profile with the `models.manager` flags, and the session ends
// when the pass ends. Run it from cron, launchd, a systemd timer or a loop script instead of keeping a session
// alive to tick: the idle ticks are shell only.
//
//   --dry-run   print the precheck and the command that would start, start nothing
// A second tick that starts while a pass still runs on this checkout does nothing (a lock in .git).
// Exit: 0 nothing to do, or the session's own exit code; 1 the tick can't run (the line says why and what to do).
import { existsSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { load } from "./factory_config.ts";
import { configured, flags, ModelsError, type Models } from "./factory_models.ts";
import { skillLine } from "./factory_roles.ts";
import { precheck } from "./factory_wait.ts";
import { bunCmd, flock, run, runMain, shQuote } from "./factory_lib.ts";

export const PROFILE = join(".claude", "manager", "settings.json");
// The session reads only the user's settings and the profile, so Claude Code does not load the project's skills: the
// prompt names the skill's file (factory_roles.ts skillLine), and the marker lets `factory usage --by role` count it.
export const PROMPT = `${skillLine("manage-pass")}\n\n<!-- factory-role role=dev-manager name=tick -->`;

/** Only the project's MCP servers, from main on the remote (factory_mcp.ts); none when it can't say. */
export function mcpFlags(): string[] {
  const p = run(bunCmd(join(import.meta.dir, "factory_mcp.ts")), { timeoutMs: 120_000 });
  const cfg = p.stdout.trim() || '{"mcpServers":{}}';
  return ["--mcp-config", cfg, "--strict-mcp-config"];
}

export function command(models: Models): string[] {
  return ["claude", "--setting-sources", "user", "--settings", PROFILE, ...mcpFlags(), ...flags("manager", models), "-p", PROMPT];
}

export function tick(args: string[]): number {
  const todo = precheck(load());
  if (!todo.length) {
    console.log("nothing to do");
    return 0;
  }
  console.log(todo.join("\n"));
  if (!existsSync(PROFILE)) {
    process.stderr.write(`factory manage-tick: ${PROFILE} is missing, so the manager cannot start safely. ` +
      "Fix: run `factory update` (it links the manager profile), then try again.\n");
    return 1;
  }
  let cmd: string[];
  try {
    cmd = command(configured());
  } catch (e) {
    if (!(e instanceof ModelsError)) throw e;
    process.stderr.write(`factory manage-tick: ${e.message}\n`);
    return 1;
  }
  if (args.includes("--dry-run")) {
    console.log("would run: " + cmd.map(shQuote).join(" "));
    return 0;
  }
  const where = run(["git", "rev-parse", "--git-path", "factory-manage-tick.lock"]).stdout.trim() || ".factory-manage-tick.lock";
  const fd = openSync(resolve(where), "w");
  if (!flock(fd, false)) {
    console.log("a manager pass is already running here; this tick starts nothing");
    return 0;
  }
  return run(cmd, { inherit: true }).code;
}

if (import.meta.main) await runMain(() => tick(process.argv.slice(2)));
