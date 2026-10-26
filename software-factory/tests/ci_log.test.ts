// `factory ci log <pr or run>` prints the failed job's log, trimmed to the failing step (#206). Read-only: it only
// GETs. Runs with a fake `gh` on PATH that answers from a JSON file and logs every call.
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { envWith, git, read, readmeAndWiki, sh, SF, tmp, write, writeExe } from "./support.ts";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const db = JSON.parse(readFileSync(process.env.FAKE_DB as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_DB + ".calls", a.join(" ") + "\n");
if (a[0] !== "api") { console.error("fake gh: only api"); process.exit(1); }
const path = a.slice(1).filter((x) => !x.startsWith("-"))[0].replace("repos/{owner}/{repo}/", "").split("?")[0];
if (a.includes("-X")) { console.error("fake gh: a write was asked for"); process.exit(1); }
if (path in db.text) { process.stdout.write(db.text[path]); process.exit(0); }
if (path in db.json) { console.log(JSON.stringify(db.json[path])); process.exit(0); }
console.error("gh: Not Found (HTTP 404)"); process.exit(1);
`;

const LOG = [
  "2026-10-26T10:00:00.0000000Z ##[group]Run actions/checkout@v4",
  "2026-10-26T10:00:01.0000000Z checkout noise",
  "2026-10-26T10:00:02.0000000Z ##[endgroup]",
  "2026-10-26T10:00:03.0000000Z ##[group]Run bun tools/run_tests.ts",
  "2026-10-26T10:00:04.0000000Z test_a ok",
  "2026-10-26T10:00:05.0000000Z FAIL test_b: expected 1, got 2",
  "2026-10-26T10:00:06.0000000Z ##[error]Process completed with exit code 1.",
  "2026-10-26T10:00:07.0000000Z post-job noise",
].join("\n") + "\n";

function project(extraJson: Record<string, unknown> = {}): [string, Record<string, string | undefined>] {
  const d = tmp();
  mkdirSync(join(d, "bin"));
  git(d, "init", "-q");
  mkdirSync(join(d, ".claude"));
  symlinkSync(join(SF, "hooks"), join(d, ".claude", "hooks"));
  write(join(d, ".claude", "factory.json"), "{}");
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const job = { id: 77, name: "test", conclusion: "failure", steps: [
    { number: 1, name: "Checkout", conclusion: "success" },
    { number: 2, name: "Run the tests", conclusion: "failure" }] };
  const ok = { id: 78, name: "lint", conclusion: "success", steps: [] };
  const db = {
    json: {
      "pulls/12": { head: { sha: "abc1234def" } },
      "commits/abc1234def/check-runs": { total_count: 2, check_runs: [
        { id: 77, name: "test", conclusion: "failure" }, { id: 78, name: "lint", conclusion: "success" }] },
      "actions/jobs/77": job,
      "actions/runs/999/jobs": { jobs: [job, ok] },
      ...extraJson,
    },
    text: { "actions/jobs/77/logs": LOG },
  };
  const path = write(join(d, "db.json"), JSON.stringify(db));
  return [d, envWith(join(d, "bin"), { FAKE_DB: path, CLAUDE_PROJECT_DIR: d })];
}

function ciLog(d: string, env: Record<string, string | undefined>, ...args: string[]): [number, string, string] {
  const p = sh(["bash", join(SF, "factory"), "ci", "log", ...args], { cwd: d, env });
  return [p.code, p.stdout, p.stderr];
}

test("a pr prints the failed job trimmed to the failing step", () => {
  const [d, env] = project();
  const [rc, out, err] = ciLog(d, env, "12");
  expect(rc, out + err).toBe(0);
  expect(out).toContain("job test");
  expect(out).toContain("Run the tests");
  expect(out).toContain("FAIL test_b: expected 1, got 2");
  expect(out).toContain("Process completed with exit code 1.");
  expect(out).not.toContain("checkout noise");
  expect(out).not.toContain("post-job noise");
  expect(out).not.toContain("2026-10-26T"); // timestamps are stripped
  expect(out).not.toContain("lint"); // the passing job is not shown
});

test("a run id works too", () => {
  const [d, env] = project();
  const [rc, out, err] = ciLog(d, env, "999");
  expect(rc, out + err).toBe(0);
  expect(out).toContain("FAIL test_b");
});

test("a pr with no failed job says so", () => {
  const [d, env] = project({ "commits/abc1234def/check-runs": { total_count: 1, check_runs: [
    { id: 78, name: "lint", conclusion: "success" }] } });
  const [rc, out, err] = ciLog(d, env, "12");
  expect(rc, out + err).toBe(0);
  expect(out).toContain("No failed job");
});

test("an unknown number is a code message fix", () => {
  const [d, env] = project();
  const [rc, out, err] = ciLog(d, env, "4040");
  expect(rc, out + err).toBe(1);
  const e = JSON.parse(err) as { code: string; message: string; fix: string };
  expect(e.code).toBe("ci-not-found");
  expect(e.message).toBeTruthy();
  expect(e.fix).toContain("factory ci log");
});

test("it only reads", () => {
  const [d, env] = project();
  ciLog(d, env, "12");
  const calls = read(env.FAKE_DB + ".calls");
  expect(calls).not.toContain("-X");
  expect(calls).not.toContain("POST");
  expect(calls).not.toContain("PATCH");
});

test("help and readme list the command", () => {
  const help = sh(["bash", join(SF, "factory"), "help"]).stdout;
  expect(help).toContain("ci log");
  expect(readmeAndWiki()).toContain("| `factory ci log");
});
