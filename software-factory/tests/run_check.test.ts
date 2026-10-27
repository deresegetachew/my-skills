// `factory run-check` and the quiet Stop check (#68): a pass prints a line, a failure prints a capped summary and
// the log path, the full output is on disk, and the log never shows up as an untracked file.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, read, runHook, sh, tmp, write } from "./support.ts";

const ENV: Record<string, string | undefined> = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDECODE: undefined,
};

function project(testCmd = "true", extra: Record<string, unknown> = {}): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ codePaths: ["src"], commands: { test: testCmd }, ...extra }));
  write(join(d, "src", "a.ts"), "one\n");
  git(d, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git(d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start");
  return d;
}

function runCheck(d: string, ...args: string[]) {
  return runHook("factory_run_check", args, { cwd: d, env: { ...ENV, CLAUDE_PROJECT_DIR: d } });
}

const NOISY_PASS = 'for i in $(seq 1 500); do echo "PASS test $i"; done';
const NOISY_FAIL = 'for i in $(seq 1 300); do echo "PASS test $i"; done; echo \'FAIL src/a.test.ts:12:3 expected 1\'; ' +
  'for i in $(seq 1 300); do echo "noise $i"; done; exit 1';

test("a passing run prints one line and keeps the log", () => {
  const d = project();
  const r = runCheck(d, "--name", "unit", NOISY_PASS);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trim().split("\n").length).toBe(1);
  expect(r.stdout).toContain("tmp/checks/unit.log");
  expect(r.stderr).toBe("");
  expect(read(join(d, "tmp/checks/unit.log")).split("\nPASS test").length - 1).toBe(500);
});

test("a failing run prints the failure capped and the log path", () => {
  const d = project();
  const r = runCheck(d, "--name", "unit", "--lines", "10", NOISY_FAIL);
  expect(r.code).toBe(1);
  const lines = r.stderr.trim().split("\n");
  expect(lines.length).toBeLessThanOrEqual(12);
  expect(r.stderr).toContain("FAIL src/a.test.ts:12:3 expected 1");
  expect(r.stderr).toContain("tmp/checks/unit.log");
  expect(read(join(d, "tmp/checks/unit.log"))).toContain("noise 300");
});

test("the exit code is the commands own", () => {
  const d = project();
  expect(runCheck(d, "exit 3").code).toBe(3);
});

test("the log is not an untracked file", () => {
  const d = project();
  runCheck(d, NOISY_PASS);
  const status = sh(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: d }).stdout;
  expect(status).toBe("");
});

test("check log dir setting moves the log", () => {
  const d = project("true", { checkLogDir: "logs/out" });
  runCheck(d, "--name", "x", "true");
  expect(existsSync(join(d, "logs/out/x.log"))).toBe(true);
});

test("no command is a usage error", () => {
  expect(runCheck(project()).code).toBe(2);
});

test("the stop check names the log and stays capped", () => {
  const d = project(NOISY_FAIL, { checkOutputLines: 10 });
  write(join(d, "src", "a.ts"), "two\n");
  const r = runHook("check", [], { cwd: d, input: "{}", env: { ...ENV, CLAUDE_PROJECT_DIR: d } });
  expect(r.code, r.out).toBe(2);
  expect(r.stderr).toContain("FAIL src/a.test.ts:12:3");
  expect(r.stderr.split("\n")[0]).toContain("Full log: tmp/checks/test.log");
  expect(r.stderr.trim().split("\n").length).toBeLessThanOrEqual(12);
  expect(existsSync(join(d, "tmp/checks/test.log"))).toBe(true);
});
