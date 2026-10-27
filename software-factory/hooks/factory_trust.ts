#!/usr/bin/env -S bun --no-env-file
// Is a folder trusted by Claude Code? (#180, #193)
//
// A folder Claude Code has not been told to trust makes it ignore the whole `permissions.allow` list ("Ignoring N
// permissions.allow entries from .claude/settings.json: this workspace has not been trusted"), so an unattended run
// stalls on the first command. The flag is `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json`; a folder also
// counts as trusted when a folder above it is, or when it is a git worktree whose main working tree is trusted (#246,
// #248: Claude Code writes no entry for an agent worktree beside the project, and shows no trust question there). This
// only reads that file, never writes it, and never prints what is in it.
//
//   bun --no-env-file .claude/hooks/factory_trust.ts check [<path>]
//       exit 0 when trusted or unknown; exit 1 and a {code, message, fix} line when the folder is not trusted
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { die, git, pyDumps, runMain } from "./factory_lib.ts";

const USAGE = `Is a folder trusted by Claude Code? (#180, #193)

  bun --no-env-file .claude/hooks/factory_trust.ts check [<path>]   exit 0 when trusted or unknown; exit 1 and a
                                                          {code, message, fix} line when the folder is not trusted`;

export type TrustState = "trusted" | "untrusted" | "unknown";
type Projects = Record<string, unknown>;

export function configPath(): string {
  return join(process.env.HOME || homedir(), ".claude.json");
}

/** os.path.realpath: resolves the links of the part that exists, keeps the rest as written. */
export function realpath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const up = dirname(abs);
    return up === abs ? abs : join(realpath(up), basename(abs));
  }
}

/** The `projects` table of ~/.claude.json, or null when there is nothing to judge by. */
function projects(): Projects | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const p = (doc as Record<string, unknown>).projects;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Projects) : {};
}

function walkUp(table: Projects, path: string): boolean {
  let here = realpath(path);
  for (;;) {
    const entry = table[here];
    if (entry && typeof entry === "object" && (entry as Record<string, unknown>).hasTrustDialogAccepted === true) return true;
    const up = dirname(here);
    if (up === here) return false;
    here = up;
  }
}

/** The main working tree of the git worktree at `path`, or null when `path` is not a linked worktree (#246, #248).
 * Found with `git rev-parse --git-common-dir`: it is the .git folder of the main working tree. */
export function mainTree(path: string): string | null {
  const ask = (flag: string): string | null => {
    const p = git(["-C", path, "rev-parse", flag]);
    const out = p.stdout.trim();
    return p.code === 0 && out ? realpath(resolve(path, out)) : null;
  };
  const common = ask("--git-common-dir");
  const own = ask("--git-dir");
  if (!common || !own || common === own || basename(common) !== ".git") return null;
  return dirname(common);
}

/** "trusted", "untrusted", or "unknown" (no ~/.claude.json, or one that can't be read: nothing to judge by). */
export function state(path: string): TrustState {
  const table = projects();
  if (table === null) return "unknown";
  if (walkUp(table, path)) return "trusted";
  const main = mainTree(path); // a git worktree of a trusted main working tree is trusted too
  return main && walkUp(table, main) ? "trusted" : "untrusted";
}

/** The main working tree whose trust a git worktree at `path` inherits, or null (not a worktree, trusted on its own
 * account, or that tree is not trusted itself). Claude Code writes no entry for a worktree of a trusted repository. */
export function inheritedFrom(path: string): string | null {
  const table = projects();
  if (table === null || walkUp(table, path)) return null;
  const main = mainTree(path);
  return main && walkUp(table, main) ? main : null;
}

/** The plain error for an untrusted folder: {code, message, fix}. */
export function problem(path: string): { code: string; message: string; fix: string } {
  return {
    code: "folder_not_trusted",
    message: `Claude Code has not been told to trust ${path}, so it ignores the allow lists (the agents' in .claude/factory/settings.json and the project's own) ` +
      "and an unattended run stops at its first command.",
    fix: `open it once yourself: \`cd ${path} && claude\`, answer yes to the trust question, then start the loop again. ` +
      "Only you can do this; the factory never sets the trust flag.",
  };
}

export function main(argv: string[]): number {
  if (argv[0] !== "check") die(USAGE);
  const path = argv.length > 1 ? (argv[1] as string) : process.cwd();
  if (state(path) !== "untrusted") return 0;
  console.log(pyDumps(problem(realpath(path))));
  return 1;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
