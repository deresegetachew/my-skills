// A clone of an empty repo has no fetch refspec, so no origin/main (#181). The claims hook says so with
// {code, message, fix} instead of a stack trace. (The doctor's check stays in test_no_origin_main.py until
// factory_doctor is ported.)
import { expect, test } from "bun:test";
import { join } from "node:path";
import { runHook, sh, tmp, write } from "./support.ts";

const FIX = "git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git fetch origin";

function must(cmd: string[], cwd?: string): void {
  const p = sh(cmd, { cwd });
  if (p.code !== 0) throw new Error(`${cmd.join(" ")}: ${p.out}`);
}

function cloneWithoutRefspec(): string {
  const d = tmp();
  const origin = join(d, "origin.git");
  const work = join(d, "work");
  must(["git", "init", "-q", "--bare", "-b", "main", origin]);
  must(["git", "init", "-q", "-b", "main", work]);
  must(["git", "remote", "add", "origin", origin], work);
  must(["git", "config", "--unset-all", "remote.origin.fetch"], work); // what cloning an empty repo leaves
  write(join(work, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"] }));
  write(join(work, "a.txt"), "x");
  must(["git", "add", "-A"], work);
  must(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first"], work);
  must(["git", "push", "-q", "origin", "main"], work); // pushed, but nothing tracks it
  return work;
}

test("a worktree without origin main gives code message fix and no traceback", () => {
  const work = cloneWithoutRefspec();
  const p = runHook("factory_claims", ["worktree", "taytu"], { cwd: work, env: { ...process.env, CLAUDE_PROJECT_DIR: work } });
  expect(p.code, p.out).toBe(1);
  for (const bad of ["Traceback", "CalledProcessError", "    at "]) expect(p.stderr).not.toContain(bad);
  const lines = p.stderr.trim().split("\n");
  const e = JSON.parse(lines[lines.length - 1] as string) as Record<string, string>;
  expect(e.code).toBe("no-origin-main");
  expect(e.message).toContain("origin/main");
  expect(e.fix).toContain(FIX);
});

test("the worktree is made once the refspec is there", () => {
  const work = cloneWithoutRefspec();
  must(["git", "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], work);
  const p = runHook("factory_claims", ["worktree", "taytu"], { cwd: work, env: { ...process.env, CLAUDE_PROJECT_DIR: work } });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.trim().endsWith("work-agents/taytu")).toBe(true);
});
