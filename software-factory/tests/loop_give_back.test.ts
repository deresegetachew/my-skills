// factory-loop.sh (#192): the loop says which issue it claimed, and when its run ends it gives back the claims that have
// no branch or pull request, and prints what it released. Runs the real loop (headless) with stub hooks and a `claude`
// that exits early.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { read, sh, writeExe } from "./support.ts";
import { commitAll, type Env, LOGGING_STUB, push, setup } from "./loop_support.ts";

const GIVE_BACK = LOGGING_STUB + `
if (name === "factory_issues.ts" && args[0] === "give-back") {
  console.log("released #5: the run ended with no branch or pull request, so it is ready again.");
}
`;

function runLoop(exitCode: number) {
  const [work, env0] = setup();
  const env: Env = { ...env0, STUB_TASK: "issue-5 Build the thing" };
  const hooks = join(work, ".claude", "hooks");
  for (const name of ["factory_issues.ts", "factory_roles.ts"]) writeExe(join(hooks, name), GIVE_BACK);
  writeExe(join(env.LOOP_LOG as string, "..", "bin", "claude"), `#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\nexit ${exitCode}\n`);
  commitAll(work, "stubs");
  push(work);
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env, timeoutMs: 60_000 });
  return { p, log: read(env.LOOP_LOG as string) };
}

test("a failed run gives its claim back and says so", () => {
  const { p, log } = runLoop(1);
  expect(p.out).toContain("claimed issue #5");
  expect(log).toContain("give-back --agent solo");
  expect(p.out).toContain("released #5");
});

test("a run that ends cleanly also gives back what has no branch", () => {
  const { p, log } = runLoop(0);
  expect(log).toContain("give-back --agent solo");
  expect(p.out).toContain("released #5");
});
