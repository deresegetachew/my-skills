#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The MCP config a factory session starts with (#55): the project's `.mcp.json` as the main branch has it on the
// remote, never this worktree's copy.
//
// `claude --mcp-config <file>` starts the stdio servers in that file without asking, so the file must be one an agent
// can't change: an uncommitted, untracked or branch-only `.mcp.json` is never used. This fetches the remote's default branch
// (asked of the remote, never `mainBranch` in the worktree's .claude/factory.json) from origin, writes its `.mcp.json` to this worktree's git folder
// (`.git/factory-mcp.json`, out of the working tree) and prints that path. When main has none, or the fetch fails,
// it prints the empty config `{"mcpServers":{}}`, so nothing starts. `.mcp.json` is protected, so a change to it
// needs a person to merge.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_mcp.ts      prints the value for `--mcp-config`
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "./factory_lib.ts";

export const EMPTY = '{"mcpServers":{}}';

interface Out {
  code: number;
  stdout: Buffer;
}

function git(...args: string[]): Out {
  try {
    const p = Bun.spawnSync(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    if (p.exitCode === null) throw new Error("timeout");
    return { code: p.exitCode, stdout: p.stdout };
  } catch {
    throw new Error("git could not run");
  }
}

/** The remote's default branch, asked of the remote itself (`git ls-remote --symref origin HEAD`). Never the
 * worktree's `.claude/factory.json` (`mainBranch`) or a local ref: an agent can change those, and could point them
 * at a branch with its own `.mcp.json` (#77 review). null when the remote can't say: then no servers start. */
export function mainBranch(): string | null {
  const p = git("ls-remote", "--symref", "origin", "HEAD");
  const m = p.code === 0 ? /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(p.stdout.toString()) : null;
  const name = m ? (m[1] as string) : null;
  return name && /^[\w./-]+$/.test(name) && !name.startsWith("-") ? name : null;
}

export function main(): number {
  try {
    // FETCH_HEAD, straight from the remote: a local ref named origin/<main> can't stand in for it.
    const branch = mainBranch();
    if (!branch || git("fetch", "-q", "origin", `refs/heads/${branch}`).code !== 0) {
      console.log(EMPTY);
      return 0;
    }
    const shown = git("show", "FETCH_HEAD:.mcp.json");
    if (shown.code !== 0) {
      console.log(EMPTY); // main has no .mcp.json
      return 0;
    }
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(shown.stdout)); // a broken file on main: start without servers rather than fail
    const path = resolve(git("rev-parse", "--git-path", "factory-mcp.json").stdout.toString().trim());
    writeFileSync(path, shown.stdout);
    console.log(path);
  } catch {
    console.log(EMPTY);
  }
  return 0;
}

if (import.meta.main) await runMain(() => main());
