#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory verify`: run what CI runs, here, for the current commit, before a pull request (#58).
//
// Runs `commands.ci` from .claude/factory.json (for example
// `pnpm turbo run typecheck lint test build --filter=...[{base}]`, where `{base}` becomes `origin/<main>`). When it
// passes on a clean working tree, it records the commit in <reviewMarkers>/<branch>.ci.ok. The PR gate needs that
// mark for `gh pr create` and `gh pr ready` when main's factory.json sets `commands.ci`; drafts don't.
//
// Before it, `commands.fix` formats the changed files (#69); if that changes anything the pass is refused, because
// the commit no longer matches the files: commit the formatting and run it again.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_verify.ts     exit 0: passed (or nothing to run); 1: it fails or can't run
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, load, loadFromMain } from "./factory_config.ts";
import { git as gitRun, pyInt, runMain, shell, splitLines } from "./factory_lib.ts";
import * as factoryFix from "./factory_fix.ts";
import { writeLog } from "./factory_run_check.ts";

function git(...a: string[]): [number, string] {
  const p = gitRun(a);
  return [p.code, p.stdout.trim()];
}

function tail(text: string, limit: number): string[] {
  return splitLines(text.trim()).filter((l) => l.trim()).slice(-limit);
}

export function main(): number {
  // Main's settings, as the PR gate reads them (#51): the command the gate requires, not whatever this branch says.
  const local = load();
  let cfg: Config;
  try {
    cfg = loadFromMain(local);
  } catch (e) {
    cfg = local;
    process.stderr.write(`factory verify: can't read main's settings from GitHub (${e instanceof Error ? e.message : String(e)}); ` +
      "using this worktree's .claude/factory.json.\n");
  }
  const cmd = (cfg.commands || {}).ci || "";
  if (!cmd) {
    process.stdout.write("commands.ci isn't set in main's .claude/factory.json, so there is nothing to run. Set it to what CI " +
      "runs.\n");
    return 0;
  }
  const [rc, branch] = git("branch", "--show-current");
  if (rc !== 0 || !branch) {
    process.stderr.write("factory verify: check out the task branch first (no branch here).\n");
    return 1;
  }
  // The mark says "this commit passed", so the files must be that commit: nothing uncommitted, and no untracked file
  // (.gitignore respected) that CI wouldn't have.
  const [src, dirty] = git("status", "--porcelain", "--untracked-files=all");
  if (src !== 0 || dirty) {
    process.stderr.write("factory verify: commit your changes first. The pass is recorded for a commit, and these files " +
      "aren't in it:\n" + dirty + "\n");
    return 1;
  }
  const [fixRc, fixMsg] = factoryFix.run(cfg);
  if (fixRc !== 0) {
    process.stderr.write(fixMsg + "\n");
    return 1;
  }
  if (fixMsg) {
    process.stderr.write(`factory verify: ${fixMsg}. Commit them and run verify again: CI checks the commit, not the ` +
      "working tree.\n");
    return 1;
  }
  const head = git("rev-parse", "HEAD")[1];
  const runCmd = cmd.split("{base}").join(`origin/${cfg.mainBranch}`);
  process.stdout.write(`factory verify: ${runCmd}\n`);
  const p = shell(runCmd);
  const n = pyInt(cfg.checkOutputLines || 40);
  const limit = n === null ? 40 : Math.max(n, 1);
  if (p.code !== 0) {
    const log = writeLog(cfg, "verify", `$ ${runCmd}\n${p.stdout}${p.stderr}`);
    process.stderr.write(`\`${runCmd}\` fails, so CI would fail too.` + (log ? ` Full log: ${log}.` : "") +
      " The last lines:\n" + tail(p.stdout + p.stderr, limit).join("\n") + "\n");
    return 1;
  }
  if (git("rev-parse", "HEAD")[1] !== head || git("status", "--porcelain", "--untracked-files=all")[1]) {
    process.stderr.write("factory verify: the commit or the files changed while it ran; run it again.\n");
    return 1;
  }
  const d = cfg.reviewMarkers;
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, branch.replace(/\//g, "_") + ".ci.ok"), head + "\n");
  process.stdout.write(`factory verify: passed for ${head.slice(0, 12)} on ${branch}.\n`);
  return 0;
}

if (import.meta.main) await runMain(() => main());
