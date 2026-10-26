// Free decision and migration numbers (the 22 Oct lessons): a new numbered file takes a number neither main nor another
// open PR has. The tests of `factory_numbers.ts` run on its own, from test_lessons.py; the ones through the PR gate are
// in lessons.test.ts.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHook, sh, tmp, write, writeExe } from "./support.ts";

// Answers by path (without "repos/{owner}/{repo}/" and the query): "text" for calls with --jq (the text gh would
// print after the jq filter), "json" for the others. Unknown paths fail, like a broken gh.
const FAKE_GH = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const dbPath = process.env.FAKE_GH_DB as string;
const db = JSON.parse(readFileSync(dbPath, "utf8"));
const a = process.argv.slice(2);
appendFileSync(dbPath + ".log", a.join(" ") + "\\n");
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
if (a[0] !== "api") { console.error("fake gh: no answer for " + a.join(" ")); process.exit(1); }
const rest = a.slice(1); let path: string | null = null;
for (let k = 0; k < rest.length;) {
  const w = rest[k] as string;
  if (["-X", "-H", "--jq", "-f", "-F", "--input"].includes(w)) k += 2;
  else if (w.startsWith("-")) k += 1;
  else { path = w; break; }
}
const p = new URL((path ?? "").replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (a.includes("--jq") && p in (db.text ?? {})) { console.log(db.text[p]); process.exit(0); }
if (p in (db.json ?? {})) { console.log(JSON.stringify(db.json[p])); process.exit(0); }
console.error("fake gh: no answer for " + p); process.exit(1);
`;

type Env = Record<string, string | undefined>;

function git(d: string, ...a: string[]): string {
  const p = sh(["git", ...a], { cwd: d });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
  return p.stdout.trim();
}

function files(d: string, list: string[]): void {
  for (const f of list) write(join(d, f), f);
}

/** A clone with origin/main holding `mainFiles` and branch task/1-x adding `branchFiles`, plus a fake gh. */
function project(mainFiles: string[], branchFiles: string[], cfg: Record<string, unknown> = {}): [string, string, Env] {
  const root = tmp();
  const origin = join(root, "origin.git");
  const d = join(root, "work");
  sh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  sh(["git", "clone", "-q", origin, d]);
  git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ reviewMarkers: "tmp/reviews", protected: [], alwaysAllowed: [],
    maxOpenPRs: 3, ...cfg }));
  files(d, [...mainFiles, "README.md"]);
  git(d, "add", "-A"); git(d, "commit", "-qm", "main"); git(d, "push", "-q", "origin", "HEAD:main");
  git(d, "checkout", "-qb", "task/1-x");
  files(d, branchFiles);
  git(d, "add", "-A"); git(d, "commit", "-q", "--allow-empty", "-m", "task"); git(d, "fetch", "-q", "origin");
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  const db = join(root, "db.json");
  writeFileSync(db, JSON.stringify({ text: { pulls: "" } }));
  const env: Env = { ...process.env, PATH: `${root}/bin:${process.env.PATH ?? ""}`, FAKE_GH_DB: db, FACTORY_AGENT: undefined,
    CLAUDE_PROJECT_DIR: undefined };
  return [d, db, env];
}

function answers(db: string, kw: Record<string, Record<string, unknown>>): void {
  const data = JSON.parse(readFileSync(db, "utf8")) as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(kw)) data[k] = { ...(data[k] ?? {}), ...v };
  writeFileSync(db, JSON.stringify(data));
}

function numbers(d: string, env: Env): [number, string] {
  const p = runHook("factory_numbers", [], { cwd: d, env });
  return [p.code, p.stdout + p.stderr];
}

test("migrations count when configured and this branch own pr is not a clash", () => {
  const [d, db, env] = project(["apps/api/migrations/0008_a.sql"], ["apps/api/migrations/0009_b.sql"],
    { numberedDirs: ["apps/api/migrations"] });
  answers(db, { text: { pulls: "144\ttask/1-x\n150\ttask/9-y", "pulls/144/files": "apps/api/migrations/0009_b.sql",
    "pulls/150/files": "apps/api/migrations/0009_other.sql" } });
  const [rc, out] = numbers(d, env);
  expect(rc, out).toBe(1);
  expect(out).toContain("0009_other.sql in #150");
  expect(out).toContain("Rename it to 0010");
  answers(db, { text: { pulls: "144\ttask/1-x" } }); // only this branch's own PR: free
  expect(numbers(d, env)[0]).toBe(0);
});

test("two new files with one number in a branch are refused", () => {
  const [d, , env] = project(["docs/decisions/0001-a.md"], ["docs/decisions/0002-b.md", "docs/decisions/0002-c.md"]);
  const [rc, out] = numbers(d, env);
  expect(rc, out).toBe(1);
  expect(out).toContain("in this branch");
  expect(out).toContain("Rename it to 0003");
});

test("a rename that keeps its number is not a new number", () => {
  const [d, db, env] = project(["docs/decisions/0001-a.md", "docs/decisions/0002-old-title.md"], []);
  git(d, "mv", "docs/decisions/0002-old-title.md", "docs/decisions/0002-new-title.md");
  git(d, "commit", "-qm", "retitle");
  expect(numbers(d, env)[0]).toBe(0);
  answers(db, { text: { pulls: "150\ttask/9-y",
    "pulls/150/files": "docs/decisions/0002-retitled.md\tdocs/decisions/0002-old-title.md" } });
  expect(numbers(d, env)[0]).toBe(0); // another PR retitling a decision takes no number either
});

test("a number merged to main meanwhile counts without a manual fetch", () => {
  const [d, , env] = project(["docs/decisions/0001-a.md"], ["docs/decisions/0002-mine.md"]);
  const other = tmp();
  sh(["git", "clone", "-q", git(d, "config", "--get", "remote.origin.url"), other]);
  git(other, "config", "user.email", "t@t"); git(other, "config", "user.name", "t");
  write(join(other, "docs", "decisions", "0002-theirs.md"), "x");
  git(other, "add", "-A"); git(other, "commit", "-qm", "theirs"); git(other, "push", "-q", "origin", "HEAD:main");
  const [rc, out] = numbers(d, env); // this checkout never fetched since: the check does
  expect(rc, out).toBe(1);
  expect(out).toContain("0002-theirs.md on main");
  expect(out).toContain("Rename it to 0003");
});

test("numbers skip only this repos own pr", () => {
  const [d, db, env] = project(["docs/decisions/0001-a.md"], ["docs/decisions/0002-mine.md"]);
  answers(db, { text: { pulls: "201\ttask/1-x\tstranger/fork\tme/app", "pulls/201/files": "docs/decisions/0002-theirs.md" } });
  const [rc, out] = numbers(d, env);
  expect(rc, out).toBe(1);
  expect(out).toContain("0002-theirs.md in #201");
  answers(db, { text: { pulls: "144\ttask/1-x\tme/app\tme/app" } });
  expect(numbers(d, env)[0]).toBe(0);
});

test("a free number passes and github that cannot be read fails closed", () => {
  // The gate's side of these is in lessons.test.ts ("a free decision number opens the pr" and
  // "the number check fails closed when github cant be read").
  let [d, db, env] = project(["docs/decisions/0001-a.md", "docs/decisions/0002-b.md"], ["docs/decisions/0003-c.md"]);
  let [rc, out] = numbers(d, env);
  expect(rc, out).toBe(0);
  expect(out.trim()).toBe("Every new decision and migration number is free.");
  [d, db, env] = project([], ["docs/decisions/0001-b.md"]);
  writeFileSync(db, "{}");
  [rc, out] = numbers(d, env);
  expect(rc).toBe(1);
  expect(out).toContain("could not list the open pull requests");
});
