#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory review-pass <kind>`: a review agent records its pass for the current commit (#197).
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_review_pass.ts reviewer     writes <passes>/<branch>.ok
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_review_pass.ts arch         writes <passes>/<branch>.arch.ok
//
// The file holds HEAD's id. The PR gate reads it. The agent runs only this one command, so no chained shell, `mkdir`,
// `cd` or `git rev-parse` has to be allowed. Run it only when there is no must-fix item, for a commit you reviewed.
// Exit 0: written; 1: not written (no branch, or no commit), with `{code, message, fix}` on stderr.
//
// <passes> is `<git common dir>/factory-reviews/` (#260): in the git folder, not the worktree, so an agent can't write
// a pass with its Edit tool (the kit allows `Edit(tmp/**)`, where passes used to be), and every worktree of a clone
// sees the same passes. The agents' rules deny writing that folder, and the PR gate lets only a reviewer subagent run
// this command (it reads who runs it from Claude Code's hook input). `factory verify` writes its `.ci.ok` there too.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git as gitRun, pyDumps, runMain } from "./factory_lib.ts";

export const SUFFIX: Record<string, string> = { reviewer: ".ok", arch: ".arch.ok" };
/** The subagent (its `name:` in .claude/agents/) that may record each kind of pass. */
export const AGENT_FOR: Record<string, string> = { reviewer: "reviewer", arch: "architecture-reviewer" };
/** The passes folder's name in the git folder. */
export const PASSES = "factory-reviews";

function git(...a: string[]): [number, string] {
  const p = gitRun(a);
  return [p.code, p.stdout.trim()];
}

/** The passes folder of the repository the current folder is in, or null outside a repository. */
export function passesDir(): string | null {
  const [rc, common] = git("rev-parse", "--git-common-dir");
  return rc === 0 && common ? join(resolve(common), PASSES) : null;
}

/** The pass file for a branch and a suffix (`.ok`, `.arch.ok`, `.ci.ok`), or null outside a repository. */
export function passFile(branch: string, suffix: string): string | null {
  const d = passesDir();
  return d === null ? null : join(d, branch.replace(/\//g, "_") + suffix);
}

/** Write a pass: `sha` in the branch's file. Returns the path. */
export function writePass(branch: string, suffix: string, sha: string): string {
  const path = passFile(branch, suffix);
  if (path === null) throw new Error("not in a git repository");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, sha + "\n");
  return path;
}

function refuse(code: string, message: string, fix: string): number {
  process.stderr.write(pyDumps({ code, message, fix }) + "\n");
  return 1;
}

export function main(argv: string[]): number {
  const kind = argv[0] ?? "";
  if (argv.length !== 1 || !Object.hasOwn(SUFFIX, kind)) {
    return refuse("bad-kind", "Say which review passed: reviewer or arch.",
      "Run: bun --no-env-file --config=/dev/null .claude/hooks/factory_review_pass.ts reviewer (or arch).");
  }
  const [rc, branch] = git("branch", "--show-current");
  if (rc !== 0 || !branch) {
    return refuse("no-branch", "There is no task branch checked out here.", "Check out the task branch and try again.");
  }
  const [hrc, head] = git("rev-parse", "HEAD");
  if (hrc !== 0 || !head) {
    return refuse("no-commit", "This branch has no commit to pass.", "Commit the change, then ask for the review.");
  }
  const path = writePass(branch, SUFFIX[kind] as string, head);
  const [, dirty] = git("status", "--porcelain", "--untracked-files=no");
  process.stdout.write(`${kind} pass recorded for ${head.slice(0, 12)} on ${branch}: ${path}\n`);
  if (dirty) process.stdout.write("Note: tracked files have uncommitted changes. The pass names the commit, not those changes.\n");
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
