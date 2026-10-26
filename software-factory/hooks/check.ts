#!/usr/bin/env -S bun --no-env-file
// Stop hook: don't let a turn end with a broken build.
//
// Runs the project's typecheck and test commands (from .claude/factory.json) only when files under
// `codePaths` changed. `commands.typecheckChanged` and `commands.testChanged`, when set, run instead, for the
// changed packages only. Before them it runs `commands.fix` on the changed files (#69, `factory_fix.ts`), so style never
// costs a turn; the agent hears "formatted 3 files" and nothing more. Exit 2 sends the failure back to Claude so it fixes
// it before stopping: the lines that name a failure first, then the end of the output, `checkOutputLines` in all.
//
// After a green run it remembers what it checked (HEAD, every tracked change, every untracked file that isn't ignored,
// the commands, and when each `checkRequires` path last changed) in the git folder, and skips the next Stop if all of
// that is the same. A failure is never remembered. Other ignored files (`.env`, build output) aren't in it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { load } from "./factory_config.ts";
import { git, pyDumps, runMain, shell } from "./factory_lib.ts";
import * as factoryFix from "./factory_fix.ts";
import { excerpt, lineLimit, writeLog } from "./factory_run_check.ts";

function readStdin(): unknown {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

/** The bytes a git command prints (paths go as arguments, never into a shell string). */
function gitBytes(args: string[]): Uint8Array {
  try {
    return Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }).stdout;
  } catch {
    return new Uint8Array();
  }
}

/** What a green run covered: HEAD, the commands, the whole tracked diff (a root tsconfig.json or lockfile counts
 * too), each untracked file that isn't ignored, and when each `checkRequires` path last changed (an install). */
function fingerprint(commands: string[], needs: string[]): string {
  const h = createHash("sha256");
  h.update(git(["rev-parse", "HEAD"]).stdout);
  h.update(pyDumps(commands, { sortKeys: true }));
  h.update(gitBytes(["diff", "--binary", "HEAD"]));
  const names = Buffer.from(gitBytes(["ls-files", "-z", "--others", "--exclude-standard"]));
  const list: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === 0) {
      if (i > start) list.push(names.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < names.length) list.push(names.subarray(start));
  list.sort(Buffer.compare);
  for (const name of list) {
    h.update(name);
    h.update(Buffer.from([0]));
    try {
      h.update(createHash("sha256").update(readFileSync(name)).digest());
    } catch {
      h.update("?");
    }
  }
  for (const p of needs) {
    try {
      h.update(`${p}:${statSync(p, { bigint: true }).mtimeNs}`);
    } catch {
      h.update(`${p}:-`);
    }
  }
  return h.digest("hex");
}

export function main(): number {
  const data = readStdin();
  if (data && typeof data === "object" && (data as Record<string, unknown>).stop_hook_active) {
    return 0; // already continuing because of this hook; don't loop
  }
  const cfg = load();
  // Not installed yet (a fresh clone or worktree): nothing to check until `commands.install` has run.
  const needs = cfg.checkRequires ?? [];
  if (needs.some((p) => !existsSync(p))) return 0;
  const paths = cfg.codePaths.filter((p) => existsSync(p));
  if (!paths.length) return 0; // no code yet

  // Format and auto-fix the files this branch changed, before anything is compared or run. What it did is one line.
  const [fixRc, fixMsg] = factoryFix.run(cfg);
  if (fixRc !== 0) {
    process.stderr.write(fixMsg + "\n");
    return 2;
  }
  if (fixMsg) process.stdout.write(pyDumps({ systemMessage: `factory: ${fixMsg}.` }) + "\n");
  const note = fixMsg ? `(${fixMsg}.) ` : "";

  const changed = git(["diff", "--quiet", "HEAD", "--", ...paths]).code !== 0;
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...paths]).stdout.trim();
  if (!changed && !untracked) return 0;

  // In the git folder: one per worktree, never in the working tree, never committed.
  const lastGreen = git(["rev-parse", "--git-path", "factory-check-green"]).stdout.trim();
  const commands = ["typecheck", "test"].map((n) => cfg.commands[`${n}Changed`] || cfg.commands[n] || "");
  const current = fingerprint(commands, needs);
  try {
    if (lastGreen && readFileSync(lastGreen, "utf8").trim() === current) return 0; // nothing changed since the last green check
  } catch {
    // not remembered yet
  }

  const limit = lineLimit(cfg);
  for (const name of ["typecheck", "test"]) {
    const cmd = cfg.commands[`${name}Changed`] || cfg.commands[name];
    if (!cmd) continue;
    const r = shell(cmd);
    if (r.code !== 0) {
      const text = r.stdout + r.stderr;
      const out = excerpt(text, limit);
      const log = writeLog(cfg, name, `$ ${cmd}\n${text}`);
      const more = log ? ` Full log: ${log}` : "";
      process.stderr.write(`${note}\`${cmd}\` fails. Fix it before finishing:${more}\n` + out.join("\n") + "\n");
      return 2;
    }
  }
  try {
    if (lastGreen) writeFileSync(lastGreen, current + "\n");
  } catch {
    // can't remember it: the next Stop just runs the check again
  }
  return 0;
}

if (import.meta.main) await runMain(() => main());
