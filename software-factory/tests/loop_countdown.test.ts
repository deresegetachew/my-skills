// factory-loop.sh -i: when a task's session closes before the task is done, the loop carries on after a 10 s
// countdown instead of waiting for a key. Runs the real loop on a pseudo-terminal with stub hooks and a stub `claude`.
import { expect, test } from "bun:test";
import { read } from "./support.ts";
import { runOnATerminal, setup } from "./loop_support.ts";

function nextTaskCalls(log: string): number {
  return log.split("\n").filter((l) => l.startsWith("next_task.ts")).length;
}

test("an unfinished session carries on after the countdown", async () => {
  const [work, env] = setup();
  const start = Date.now();
  const [code, out] = await runOnATerminal(work, env, 45);
  expect(code, out).toBe(0); // it went on by itself, found nothing more to do and exited
  expect(out).toContain("session ended before it was done. Carrying on in 10 s");
  expect((Date.now() - start) / 1000).toBeGreaterThanOrEqual(9); // the countdown should give about 10 s to type q
  expect(nextTaskCalls(read(env.LOOP_LOG as string))).toBe(2);
});

test("q still stops the loop", async () => {
  const [work, env] = setup();
  const [code, out] = await runOnATerminal(work, env, 45, ["-i", "3"], "q\n");
  expect(code, out).toBe(0);
  expect(out).toContain("Stopped.");
  expect(nextTaskCalls(read(env.LOOP_LOG as string))).toBe(1);
});
