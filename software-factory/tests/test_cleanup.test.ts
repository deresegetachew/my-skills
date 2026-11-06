// Tests clean up after themselves (#476): a test that fails or is killed for taking too long leaves no process behind.
// Each case writes a small test file into a temp folder and runs it the way a person would (`bun tools/run_tests.ts`,
// or `bun test` on the file), then looks at `ps` for anything it started. The processes carry a marker in their command
// line, so this test only ever sees its own.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { BUN, ROOT, SF, sh, tmp, write } from "./support.ts";

function marker(): string {
  return `leakmark${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

/** The pids whose command line has the marker. */
function alive(mark: string): string[] {
  const p = sh(["ps", "-axo", "pid=,command="]);
  return p.stdout.split("\n").filter((l) => l.includes(mark) && !l.includes("ps -axo")).map((l) => l.trim().split(/\s+/)[0] ?? "");
}

/** A child that would live for 10 minutes, with the marker on its command line. */
const CHILD = (mark: string): string =>
  `Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", ${JSON.stringify(mark)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`;

function runner(dir: string, env: Record<string, string> = {}): { code: number; out: string } {
  const p = sh([...BUN, "--config=/dev/null", join(ROOT, "tools", "run_tests.ts"), "--jobs", "1"],
    { cwd: ROOT, env: { ...process.env, FACTORY_TEST_DIR: dir, ...env }, timeoutMs: 120_000 });
  return { code: p.code, out: p.stdout + p.stderr };
}

test("a test file that fails leaves none of the processes it started (run_tests)", () => {
  const mark = marker();
  const dir = tmp("cleanup-");
  write(join(dir, "leaks.test.ts"), `import { expect, test } from "bun:test";
test("starts a child, then fails", async () => {
  ${CHILD(mark)}
  await Bun.sleep(300);
  expect(1).toBe(2);
});
`);
  const r = runner(dir);
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain("1 failed");
  expect(alive(mark), "a child of the failed test file is still running").toEqual([]);
});

test("a test file killed for taking too long takes the processes it started with it (run_tests)", () => {
  const mark = marker();
  const dir = tmp("cleanup-");
  write(join(dir, "hangs.test.ts"), `import { test } from "bun:test";
test("starts a child, then never ends", async () => {
  ${CHILD(mark)}
  console.log("SPAWNED");
  await new Promise(() => {});
});
`);
  const r = runner(dir, { FACTORY_TEST_TIMEOUT_MS: "3000" });
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain("timed out after 3 s");
  expect(r.out, "the child was started before the kill").toContain("SPAWNED");
  expect(alive(mark), "a child of the killed test file is still running").toEqual([]);
});

test("a web UI test that fails leaves no factory ui server, even under plain bun test", () => {
  const dir = tmp("cleanup-");
  const file = join(dir, "ui_fails.test.ts");
  write(file, `import { expect, test } from "bun:test";
import { project, startUi } from ${JSON.stringify(join(SF, "tests", "web_ui_support.ts"))};
test("starts the UI, then fails", async () => {
  const p = project();
  const ui = await startUi(p);
  console.log("UI_PID=" + ui.proc.pid);
  expect(ui.url).toBe("not this");
});
`);
  const p = sh([process.execPath, "test", file], { cwd: ROOT, timeoutMs: 120_000 });
  const out = p.stdout + p.stderr;
  expect(p.code, out).not.toBe(0);
  const pid = /UI_PID=(\d+)/.exec(out)?.[1] ?? "";
  expect(pid, out).not.toBe("");
  expect(sh(["kill", "-0", pid]).code, "the factory ui server from the failed test is still running").not.toBe(0);
});

test("Ctrl-C on the runner stops every test file it runs and what they started", async () => {
  const mark = marker();
  const dir = tmp("cleanup-");
  write(join(dir, "slow.test.ts"), `import { test } from "bun:test";
test("starts a child, then waits", async () => {
  ${CHILD(mark)}
  await Bun.sleep(60_000);
}, 120_000);
`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const runner = Bun.spawn([...BUN, "--config=/dev/null", join(ROOT, "tools", "run_tests.ts"), "--jobs", "1"],
    { cwd: ROOT, env: { ...env, FACTORY_TEST_DIR: dir }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100 && !alive(mark).length; i++) await Bun.sleep(100);
  expect(alive(mark).length, "the test file's child never started").toBeGreaterThan(0);
  runner.kill("SIGINT");
  await runner.exited;
  await Bun.sleep(300);
  expect(alive(mark), "a child is still running after Ctrl-C on the runner").toEqual([]);
});
