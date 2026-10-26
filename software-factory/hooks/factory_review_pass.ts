#!/usr/bin/env -S bun --no-env-file
// `factory review-pass <kind>`: a review agent records its pass for the current commit (#197).
//
//   bun --no-env-file .claude/hooks/factory_review_pass.ts reviewer     writes <reviewMarkers>/<branch>.ok
//   bun --no-env-file .claude/hooks/factory_review_pass.ts arch         writes <reviewMarkers>/<branch>.arch.ok
//
// The file holds HEAD's id. The PR gate reads it. The agent runs only this one command, so no chained shell, `mkdir`,
// `cd` or `git rev-parse` has to be allowed. Run it only when there is no must-fix item, for a commit you reviewed.
// Exit 0: written; 1: not written (no branch, or no commit), with `{code, message, fix}` on stderr.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "./factory_config.ts";
import { git as gitRun, pyDumps, runMain } from "./factory_lib.ts";

export const SUFFIX: Record<string, string> = { reviewer: ".ok", arch: ".arch.ok" };

function git(...a: string[]): [number, string] {
  const p = gitRun(a);
  return [p.code, p.stdout.trim()];
}

function refuse(code: string, message: string, fix: string): number {
  process.stderr.write(pyDumps({ code, message, fix }) + "\n");
  return 1;
}

export function main(argv: string[]): number {
  const kind = argv[0] ?? "";
  if (argv.length !== 1 || !Object.hasOwn(SUFFIX, kind)) {
    return refuse("bad-kind", "Say which review passed: reviewer or arch.",
      "Run: bun --no-env-file .claude/hooks/factory_review_pass.ts reviewer (or arch).");
  }
  const [rc, branch] = git("branch", "--show-current");
  if (rc !== 0 || !branch) {
    return refuse("no-branch", "There is no task branch checked out here.", "Check out the task branch and try again.");
  }
  const [hrc, head] = git("rev-parse", "HEAD");
  if (hrc !== 0 || !head) {
    return refuse("no-commit", "This branch has no commit to pass.", "Commit the change, then ask for the review.");
  }
  const cfg = load();
  const d = cfg.reviewMarkers;
  mkdirSync(d, { recursive: true });
  const path = join(d, branch.replace(/\//g, "_") + SUFFIX[kind]);
  writeFileSync(path, head + "\n");
  const [, dirty] = git("status", "--porcelain", "--untracked-files=no");
  process.stdout.write(`${kind} pass recorded for ${head.slice(0, 12)} on ${branch}: ${path}\n`);
  if (dirty) process.stdout.write("Note: tracked files have uncommitted changes. The pass names the commit, not those changes.\n");
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
