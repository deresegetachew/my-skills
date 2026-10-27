// `--once` is one pass in every case, and a worktree without the factory is refused plainly (#189): no stack traces,
// no polling, an error with {code, message, fix}, and no wrong slot number.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { sh, tmp, write, writeExe } from "./support.ts";
import { commitAll, type Env, loopProject, must, push } from "./loop_support.ts";

const NOTHING = "#!/usr/bin/env bun\nprocess.exit(1);\n";
const CLAIMS = '#!/usr/bin/env bun\nif (process.argv[2] === "checkout") console.log("taytu", process.env.AGENT_DIR);\n';

function git(cwd: string, ...a: string[]): void {
  must(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], cwd);
}

function project(waitMinutes = 5): [string, Env] {
  const [work, env] = loopProject();
  const hooks = join(work, ".claude", "hooks");
  writeExe(join(hooks, "next_task.ts"), NOTHING);
  writeExe(join(hooks, "factory_claims.ts"), CLAIMS);
  write(join(work, ".claude", "factory.json"), JSON.stringify({ waitMinutes, agents: ["menelik", "taytu"] }));
  commitAll(work, "config");
  push(work);
  return [work, env];
}

function runOnce(work: string, env: Env, ...args: string[]) {
  return sh(["bash", "./factory-loop.sh", "--once", ...args], { cwd: work, env, timeoutMs: 60_000 });
}

test("once with nothing ready exits after one look and does not poll", () => {
  const [work, env] = project();
  const p = runOnce(work, { ...env, AGENT_DIR: work });
  expect(p.code, p.out).toBe(0);
  expect(p.out).not.toContain("Checking again");
  expect(p.out.toLowerCase()).toContain("nothing ready");
});

test("a worktree without the factory is refused with a fix and no traceback", () => {
  const [work, env] = project();
  git(work, "rm", "-rq", ".claude");
  git(work, "commit", "-qm", "no factory here");
  git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "reset", "-q", "--hard", "HEAD~1");
  const wt = join(tmp(), "agent");
  git(work, "worktree", "add", "-q", "--detach", wt, "HEAD");
  const p = runOnce(work, { ...env, AGENT_DIR: wt });
  expect(p.code, p.out).toBe(1);
  for (const bad of ["Traceback", "Checking again", "(slot 1)"]) expect(p.out).not.toContain(bad);
  const err = JSON.parse(p.out.split("\n").find((l) => l.startsWith("{")) as string) as Record<string, string>;
  expect(err.code).toBe("no-factory");
  expect(err.message).toContain(".claude/factory.json");
  expect(err.fix).toBeTruthy();
});

test("the slot shown is the agents own", () => {
  const [work, env0] = project();
  const env = { ...env0, AGENT_DIR: work };
  writeExe(join(work, ".claude", "hooks", "factory_env.ts"), '#!/usr/bin/env bun\nconsole.log("export FACTORY_SLOT=2");\n');
  const p = runOnce(work, env);
  expect(p.stdout).toContain("(slot 2)");
});
