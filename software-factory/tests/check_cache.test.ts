// The Stop check skips a rerun when nothing changed since its last green run (#61): same HEAD, same changes under
// `codePaths` (tracked and untracked) and the same commands. A failure is never remembered.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHook, sh, tmp, write as put } from "./support.ts";

const ENV: Record<string, string | undefined> = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDECODE: undefined,
};

function git(d: string, ...a: string[]): void {
  const p = sh(["git", ...a], { cwd: d, env: ENV });
  if (p.code !== 0) throw new Error(p.out);
}

/** A repo with one committed file under src/, and a test command that logs each run outside the repo. */
function project(exitCode = 0): [string, string] {
  const d = tmp();
  const log = join(tmp(), "runs");
  git(d, "init", "-q", "-b", "main");
  const cfg = { codePaths: ["src"], commands: { test: `echo run >> '${log}'; exit ${exitCode}` } };
  put(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  put(join(d, "src", "a.ts"), "one\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "start");
  return [d, log];
}

/** The Stop check at the end of an agent's turn, in a factory run (FACTORY_LOOP=1, #256). */
function stop(d: string) {
  return runHook("check", [], { cwd: d, input: "{}", env: { ...ENV, CLAUDE_PROJECT_DIR: d, FACTORY_LOOP: "1" } });
}

function runs(log: string): number {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
}

function write(d: string, path: string, text: string): void {
  writeFileSync(join(d, path), text);
}

function settings(d: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(d, ".claude", "factory.json"), "utf8")) as Record<string, Record<string, string>>;
}

test("a second stop with no new changes skips the check", () => {
  const [d, log] = project();
  write(d, "src/a.ts", "two\n");
  expect(stop(d).code).toBe(0);
  expect(runs(log)).toBe(1);
  expect(stop(d).code).toBe(0);
  expect(runs(log)).toBe(1); // nothing changed since the green run
});

test("a new edit after a green check runs it again", () => {
  const [d, log] = project();
  write(d, "src/a.ts", "two\n");
  stop(d);
  write(d, "src/a.ts", "three\n");
  expect(stop(d).code).toBe(0);
  expect(runs(log)).toBe(2);
});

test("an edited untracked file runs it again", () => {
  const [d, log] = project();
  write(d, "src/new.ts", "x\n");
  stop(d);
  write(d, "src/new.ts", "y\n");
  stop(d);
  expect(runs(log)).toBe(2);
});

test("a new commit runs it again even with the same working tree change", () => {
  const [d, log] = project();
  write(d, "src/b.ts", "b\n");
  stop(d);
  write(d, "notes.txt", "outside codePaths\n");
  git(d, "add", "notes.txt");
  git(d, "commit", "-qm", "another");
  stop(d);
  expect(runs(log)).toBe(2);
});

test("changed commands run it again", () => {
  const [d, log] = project();
  write(d, "src/a.ts", "two\n");
  stop(d);
  const cfg = settings(d);
  (cfg.commands as Record<string, string>).typecheck = `echo run >> '${log}'`;
  writeFileSync(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  stop(d);
  expect(runs(log)).toBe(3); // typecheck and test both ran
});

test("a change outside code paths runs it again", () => {
  // A root tsconfig.json, package.json or lockfile changes the result too (dev manager, #81).
  const [d, log] = project();
  write(d, "tsconfig.json", "good\n");
  git(d, "add", "tsconfig.json");
  git(d, "commit", "-qm", "config");
  write(d, "src/a.ts", "two\n");
  stop(d);
  write(d, "tsconfig.json", "broken\n");
  stop(d);
  expect(runs(log)).toBe(2); // a tracked change outside codePaths must rerun
  write(d, "vitest.config.ts", "new\n"); // untracked, outside codePaths
  stop(d);
  expect(runs(log)).toBe(3);
});

test("a new install runs it again", () => {
  const [d, log] = project();
  writeFileSync(join(d, ".claude", "factory.json"), JSON.stringify({ ...settings(d), checkRequires: ["node_modules"] }));
  write(d, ".gitignore", "node_modules/\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "ignore");
  mkdirSync(join(d, "node_modules"));
  write(d, "src/a.ts", "two\n");
  stop(d);
  const t = statSync(join(d, "node_modules")).mtimeMs / 1000 + 5;
  utimesSync(join(d, "node_modules"), t, t); // `pnpm install` touched it
  stop(d);
  expect(runs(log)).toBe(2);
});

test("a failing check is never skipped", () => {
  const [d, log] = project(1);
  write(d, "src/a.ts", "two\n");
  expect(stop(d).code).toBe(2);
  expect(stop(d).code).toBe(2);
  expect(runs(log)).toBe(2);
});

test("the remembered check lives in the git folder not the working tree", () => {
  const [d] = project();
  write(d, "src/a.ts", "two\n");
  stop(d);
  const status = sh(["git", "status", "--porcelain"], { cwd: d }).stdout;
  expect(status.split(/\s+/).filter(Boolean)).toEqual(["M", "src/a.ts"]);
});
