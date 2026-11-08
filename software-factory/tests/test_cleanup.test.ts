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

/** Every process below `root` (its children, theirs, and so on), from `ps`. */
function below(root: number): number[] {
  const kids = new Map<number, number[]>();
  for (const line of sh(["ps", "-axo", "pid=,ppid="]).stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  for (let todo = [...(kids.get(root) ?? [])]; todo.length;) {
    const pid = todo.shift() as number;
    out.push(pid);
    todo.push(...(kids.get(pid) ?? []));
  }
  return out;
}

const gone = (pid: number): boolean => sh(["kill", "-0", String(pid)]).code !== 0;

/** Runs a web UI test file with plain `bun test`, waits for its server, kills the test process alone with SIGKILL (as a
 * cancelled CI job or a killed runner can), and returns the processes it had started that are still running. */
async function killedMidway(start: string, setup = ""): Promise<{ left: number[]; out: string }> {
  const dir = tmp("cleanup-");
  const file = join(dir, "ui_killed.test.ts");
  const outFile = join(dir, "out.txt");
  write(file, `import { test } from "bun:test";
import { project, startUi } from ${JSON.stringify(join(SF, "tests", "web_ui_support.ts"))};
import { join } from "node:path";
import { mkdirSync, symlinkSync } from "node:fs";
const SF = ${JSON.stringify(SF)};
test("starts the UI, then never ends", async () => {
  const p = project();
  mkdirSync(join(p.d, ".claude"), { recursive: true });
  ${setup}
  const ui = await ${start};
  console.log("UI_URL=" + ui.url);
  await new Promise(() => {});
}, 120_000);
`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn([process.execPath, "test", file], { cwd: ROOT, env, stdin: "ignore", stdout: Bun.file(outFile),
    stderr: Bun.file(outFile) });
  let out = "";
  for (let i = 0; i < 300 && !out.includes("UI_URL="); i++) {
    await Bun.sleep(100);
    out = await Bun.file(outFile).text().catch(() => "");
  }
  const started = below(proc.pid);
  proc.kill("SIGKILL");
  await proc.exited;
  for (let i = 0; i < 50 && !started.every(gone); i++) await Bun.sleep(100);
  const left = started.filter((pid) => !gone(pid));
  for (const pid of left) sh(["kill", "-9", String(pid)]); // a red run leaves nothing either
  return { left, out: `${out}\nstarted: ${started.join(" ")}` };
}

test("a web UI test file killed in the middle leaves no factory ui server behind (#527)", async () => {
  const r = await killedMidway("startUi(p)");
  expect(r.out).toContain("UI_URL=");
  expect(r.left, `still running after the test process was killed:\n${r.out}`).toEqual([]);
}, 60_000);

test("a web UI test file killed in the middle leaves no server when it ran `factory ui` (#527)", async () => {
  const r = await killedMidway(`startUi(p, ["ui", "--port", "0"], ["bash", join(SF, "factory")])`,
    `symlinkSync(join(SF, "hooks"), join(p.d, ".claude", "hooks"));`);
  expect(r.out).toContain("UI_URL=");
  expect(r.left, `still running after the test process was killed:\n${r.out}`).toEqual([]);
}, 60_000);
