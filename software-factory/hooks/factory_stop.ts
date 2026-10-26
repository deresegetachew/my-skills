#!/usr/bin/env -S bun --no-env-file
// Stop hook for `factory loop -i`: when the agent has marked its task done, close the session.
//
// The next-task skill runs `factory_claims.ts done --agent $FACTORY_AGENT --task <id>` once its PR is open. When the
// turn ends, this hook sees the mark and ends the Claude process a few seconds later (so the last message stays on
// screen). The loop then counts down and starts the next task in a fresh session. Without the mark, or outside an
// interactive loop, it does nothing.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { doneFile } from "./factory_claims.ts";
import { claudePid } from "./factory_session.ts";
import { runMain } from "./factory_lib.ts";

function main(): number {
  try {
    JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // no event: nothing in it is needed
  }
  const agent = process.env.FACTORY_AGENT;
  if (process.env.FACTORY_INTERACTIVE !== "1" || !agent) return 0;
  process.chdir(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const mark = doneFile(agent);
  if (!existsSync(mark) || existsSync(mark + ".closing")) return 0;
  const pid = claudePid(true);
  if (pid === null) return 0; // not sure which process is Claude: never signal a guess; the session stays open for /exit
  closeSync(openSync(mark + ".closing", "w"));
  // Detached, so the hook returns at once and Claude can draw its last message before it's asked to quit. The
  // values go to sh as arguments ($1, $2), never into the script text.
  const child = spawn("sh", ["-c", 'sleep 3; kill -TERM "$1" 2>/dev/null; rm -f -- "$2"', "factory-stop", String(Math.trunc(pid)),
    mark + ".closing"], { detached: true, stdio: "ignore" });
  child.unref();
  return 0;
}

if (import.meta.main) await runMain(main);
