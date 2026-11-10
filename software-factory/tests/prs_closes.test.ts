// `factory prs --json` says which tasks each pull request's body closes (#545 item 4), as people name them.
// Against a fake `gh` that answers from a scenario (the same shape prs.test.ts uses).
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, SF, envWith, gitRepo, sh, tmp, write, writeExe } from "./support.ts";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.PRS_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json") out(s.main_settings ?? {});
if (path in s) out(s[path]);
if (path === "branches") out([]);
fail("fake gh: no answer for " + path);
`;

type Row = Record<string, any>;

function pullsFor(bodies: Record<number, string>): Map<number, Row> {
  const s: Row = { pulls: [], issues: [], "issues/comments": [], main_settings: { tasks: { source: "issues" } } };
  for (const [k, body] of Object.entries(bodies)) {
    const n = Number(k);
    const sha = n.toString(16).repeat(40);
    s.pulls.push({ number: n, title: `Task ${n}`, draft: false, body, html_url: `https://github.com/o/r/pull/${n}`,
      head: { sha, ref: `taytu/thing-${n}` }, labels: [] });
    s[`commits/${sha}`] = { commit: { committer: { date: "2020-01-01T00:00:00Z" } } };
    s[`commits/${sha}/check-runs`] = { check_runs: [] };
    s[`issues/${n}/comments`] = [];
    s[`pulls/${n}/files`] = [{ filename: "src/a.ts" }];
  }
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["taytu"] }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  write(join(root, "scenario.json"), JSON.stringify(s));
  const env = envWith(join(root, "bin"), { PRS_SCENARIO: join(root, "scenario.json"), PRS_LOG: join(root, "log"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined });
  const p = sh(["bash", join(SF, "factory"), "prs", "--json"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  return new Map(((JSON.parse(p.stdout) as Row).pulls as Row[]).map((x) => [x.number as number, x]));
}

test("a body that says Closes b3 names b3, and Closes #7 names 7 without the #", () => {
  const rows = pullsFor({ 1: "What changed.\n\nCloses b3", 2: "Closes #7" });
  expect(rows.get(1)?.closes).toEqual(["b3"]);
  expect(rows.get(2)?.closes).toEqual(["7"]);
});

test("Fixes and Resolves count, in any case", () => {
  const rows = pullsFor({ 1: "fixes b4", 2: "RESOLVES #9", 3: "Resolves B5" });
  expect(rows.get(1)?.closes).toEqual(["b4"]);
  expect(rows.get(2)?.closes).toEqual(["9"]);
  expect(rows.get(3)?.closes).toEqual(["b5"]);
});

test("several tasks come in order of appearance with no duplicates", () => {
  const rows = pullsFor({ 1: "Closes b3, closes #7\nAlso fixes b3 and Resolves #2" });
  expect(rows.get(1)?.closes).toEqual(["b3", "7", "2"]);
});

test("a body that closes nothing, or is empty, has closes []", () => {
  const rows = pullsFor({ 1: "Part of #7. See b3.", 2: "" });
  expect(rows.get(1)?.closes).toEqual([]);
  expect(rows.get(2)?.closes).toEqual([]);
});
