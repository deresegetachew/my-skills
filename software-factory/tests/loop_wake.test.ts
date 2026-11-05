// An idle loop waits through `factory_wake.ts` (#410): it asks how long to wait (`minutes`, which is
// messaging.pollMinutes while wake-ups come over NATS), waits with `wait --seconds N --since <when it last looked>`,
// and looks again as soon as that says it was woken, instead of after its waitMinutes. A release without
// factory_wake.ts sleeps as before. (factory_wake.ts itself is tested against a real NATS server in plugins/nats.)
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { write, writeExe } from "./support.ts";
import { commitAll, LOGGING_STUB, loopRepo, push, STUB_HOOKS } from "./loop_support.ts";

/** A coding loop with waitMinutes 5, whose next_task hands out one task and then nothing, run for `seconds`. */
async function idleLoop(wake: string | null, seconds: number): Promise<string> {
  const [d, work] = loopRepo(STUB_HOOKS);
  if (wake !== null) writeExe(join(work, ".claude", "hooks", "factory_wake.ts"), wake);
  write(join(work, ".claude", "factory.json"), JSON.stringify({ waitMinutes: 5 }));
  commitAll(work, "config");
  push(work);
  writeExe(join(d, "bin", "claude"), '#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\n');
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, LOOP_LOG: join(d, "log"),
    LOOP_STATE: join(d, "state") };
  for (const k of ["FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_ROLE"]) delete env[k];
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const proc = Bun.spawn(["bash", "./factory-loop.sh", "3"], { cwd: work, env: clean, stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(seconds * 1000);
  proc.kill(9);
  await proc.exited;
  try {
    return readFileSync(join(d, "log"), "utf8");
  } catch {
    return "";
  }
}

// woken at once: prints why, exit 0; asked how long: 15
const WOKEN = LOGGING_STUB.replace('if (name === "next_task.ts") {',
  'if (name === "factory_wake.ts" && args[0] === "minutes") console.log("15");\n' +
  'if (name === "factory_wake.ts" && args[0] === "wait") { console.log("woken by dm-1: merged a pull request"); process.exit(0); }\n' +
  'if (name === "next_task.ts") {');

test("an idle coding loop waits through factory_wake and looks for work again as soon as it is woken", async () => {
  const log = await idleLoop(WOKEN, 8);
  expect(log).toContain("factory_wake.ts minutes 5");
  expect(log).toMatch(/factory_wake\.ts wait --seconds 300 --since \d{10}/);
  // woken at once, so next_task was asked again and again within seconds, not once per 5 minutes
  expect(log.split("\n").filter((l) => l.startsWith("next_task.ts")).length).toBeGreaterThanOrEqual(3);
}, 60_000);

test("without factory_wake.ts an idle loop sleeps its waitMinutes as before", async () => {
  const log = await idleLoop(null, 6);
  expect(log).not.toContain("factory_wake");
  expect(log.split("\n").filter((l) => l.startsWith("next_task.ts")).length).toBe(2);
}, 60_000);
