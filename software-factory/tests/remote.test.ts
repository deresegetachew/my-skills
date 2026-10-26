// factory_remote.ts: a remote that points at a repository moved or renamed on GitHub is pointed at its new name.
// The Bun twins of the "a moved repository" tests in test_lessons.py, which stays in Python until the PR gate and
// factory_numbers are ported (its other tests drive those).
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { envWith, git, gitRepo, runHook, tmp, write, writeExe } from "./support.ts";

// Answers `gh api repos/<owner>/<repo> --jq .full_name` from FAKE_GH_DB ({"text": {"repos/o/r": "new/r"}});
// an unknown path fails like a broken gh.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const db = JSON.parse(readFileSync(process.env.FAKE_GH_DB as string, "utf8")) as { text?: Record<string, string> };
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_DB + ".log", a.join(" ") + "\n");
const path = a[0] === "api" ? a.slice(1).find((x) => !x.startsWith("-")) : undefined;
if (path && a.includes("--jq") && db.text && path in db.text) { console.log(db.text[path]); process.exit(0); }
process.stderr.write("fake gh: no answer for " + a.join(" ") + "\n"); process.exit(1);
`;

function project(): [string, string, Record<string, string | undefined>] {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  const db = write(join(root, "db.json"), JSON.stringify({ text: {} }));
  const env = envWith(join(root, "bin"), { FAKE_GH_DB: db, FACTORY_AGENT: undefined });
  return [d, db, env];
}

function answers(db: string, text: Record<string, string>): void {
  write(db, JSON.stringify({ text }));
}

function remote(d: string, env: Record<string, string | undefined>, ...args: string[]): [number, string] {
  const p = runHook("factory_remote", args, { cwd: d, env });
  return [p.code, p.stdout];
}

const url = (d: string): string => git(d, "config", "--get", "remote.origin.url").trim();

test("a remote to a moved repository is pointed at its new name", () => {
  const [d, db, env] = project();
  git(d, "remote", "add", "origin", "https://github.com/remanual-org/remanual.git");
  answers(db, { "repos/remanual-org/remanual": "deresegetachew/remanual" });
  expect(remote(d, env, "--check")[0]).toBe(1);
  expect(url(d)).toBe("https://github.com/remanual-org/remanual.git"); // --check changes nothing
  const [rc, out] = remote(d, env);
  expect(rc).toBe(0);
  expect(out).toContain("now points at https://github.com/deresegetachew/remanual.git");
  expect(url(d)).toBe("https://github.com/deresegetachew/remanual.git");
});

test("ssh remotes keep their form and a current remote is left alone", () => {
  const [d, db, env] = project();
  git(d, "remote", "add", "origin", "git@github.com:old/app.git");
  answers(db, { "repos/old/app": "new/app" });
  remote(d, env);
  expect(url(d)).toBe("git@github.com:new/app.git");
  answers(db, { "repos/new/app": "new/app" });
  expect(remote(d, env)).toEqual([0, ""]);
});

test("no answer from github changes nothing", () => {
  const [d, , env] = project();
  git(d, "remote", "add", "origin", "https://github.com/old/app");
  expect(remote(d, env)).toEqual([0, ""]);
  expect(url(d)).toBe("https://github.com/old/app");
});

test("credentials in a remote url are never printed", () => {
  const [d, db, env] = project();
  git(d, "remote", "add", "origin", "https://x-access-token:SECRET@github.com/old/app.git");
  answers(db, { "repos/old/app": "new/app" });
  const [rc, out] = remote(d, env, "--check");
  expect(rc).toBe(1);
  expect(out).toBe("origin points at https://***@github.com/old/app.git, but the repository is now https://***@github.com/new/app.git.\n");
});
