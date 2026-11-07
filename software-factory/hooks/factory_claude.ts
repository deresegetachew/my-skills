#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Where the `claude` program is (#568): the one place the factory looks for it, for `factory talk`, the dev manager's
// sub-managers, `factory manage-tick`, the loops (factory-loop.sh), `factory agent` and so `factory owner start`.
//
// A shell that is not a login shell (a service, `factory ui` restarted over ssh) often lacks ~/.local/bin on its PATH,
// which is where Claude Code's installer puts `claude`. So: the PATH first, then ~/.local/bin/claude, then
// ~/.claude/local/claude (an older install).
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_claude.ts path
//
// prints the path, or {code: claude_missing, message, fix} on stderr and exit 1.
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FactoryError, runMain } from "./factory_lib.ts";

/** Where `claude` is looked for, in order, as the error names them. */
export const CLAUDE_PLACES = ["PATH", "~/.local/bin", "~/.claude/local"];

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `claude` to run: on the PATH, else ~/.local/bin/claude, else ~/.claude/local/claude; null when none is. */
export function findClaude(env: Record<string, string | undefined> = process.env): string | null {
  const onPath = Bun.which("claude", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const home = env.HOME || homedir();
  for (const path of [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")]) {
    if (executable(path)) return path;
  }
  return null;
}

/** The error when there is no `claude` anywhere the factory looks. */
export function claudeMissing(): FactoryError {
  return new FactoryError("claude_missing",
    `Claude Code's \`claude\` program was not found; looked in: ${CLAUDE_PLACES.join(", ")}.`,
    "Install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`, which puts it in ~/.local/bin), " +
    "or add the folder that holds `claude` to the PATH of the shell that starts the factory, then try again.");
}

/** The `claude` to run, or the claude_missing error. */
export function claudeBin(env: Record<string, string | undefined> = process.env): string {
  const found = findClaude(env);
  if (!found) throw claudeMissing();
  return found;
}

export function main(args: string[]): number {
  if (args[0] !== "path" || args.length > 1) {
    throw new FactoryError("claude_usage", "factory_claude.ts takes one command: path.",
      "Run `bun --no-env-file --config=/dev/null .claude/hooks/factory_claude.ts path`.");
  }
  console.log(claudeBin());
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
