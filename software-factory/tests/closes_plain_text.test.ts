// Closing keywords inside code spans, fenced blocks and quoted lines are plain text to GitHub (b233); so here.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { closedIn } from "../hooks/core/domain/task.ts";
import { names } from "../hooks/factory_board_merged.ts";
import { issueOf } from "../hooks/factory_watch.ts";
import { tasksOf } from "../hooks/factory_ui_pr.ts";
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

const FENCE = "```";

test("closedIn: Closes inside a code span names nothing", () => {
  expect(closedIn("`Closes b3`")).toEqual([]);
  expect(closedIn("Tests: `Closes #7`")).toEqual([]);
});

test("closedIn: Closes inside a fenced block (backticks or tildes) names nothing", () => {
  expect(closedIn(`${FENCE}\nFixes #7\n${FENCE}`)).toEqual([]);
  expect(closedIn("~~~\nFixes #7\n~~~")).toEqual([]);
});

test("closedIn: a quoted line names nothing", () => {
  expect(closedIn("> Closes b4")).toEqual([]);
});

test("closedIn: plain Closes still names the task", () => {
  expect(closedIn("Closes b3")).toEqual(["b3"]);
});

test("closedIn: a body mixing coded, quoted and plain names only the plain one", () => {
  expect(closedIn("`Closes b1`\n> Closes b2\n" + FENCE + "\nFixes #7\n" + FENCE + "\nCloses b3")).toEqual(["b3"]);
});

test("factory prs --json: closes ignores code-spanned keywords", () => {
  const rows = pullsFor({ 1: "Tests: `Closes b3` and `Closes #7`", 2: "Closes b3" });
  expect(rows.get(1)?.closes).toEqual([]);
  expect(rows.get(2)?.closes).toEqual(["b3"]);
});

const pr = (body: string) => ({ title: "Unrelated work", body, branch: "taytu/other" });

test("names: a quoted or code-spanned Closes b3 does not name b3, plain does", () => {
  expect(names("b3", pr("`Closes b3`"))).toBe(false);
  expect(names("b3", pr("> Closes b3"))).toBe(false);
  expect(names("b3", pr(FENCE + "\nCloses b3\n" + FENCE))).toBe(false);
  expect(names("b3", pr("Closes b3"))).toBe(true);
});

test("names: b3: inside a code span does not count, plain does", () => {
  expect(names("b3", pr("see `b3: thing`"))).toBe(false);
  expect(names("b3", pr("b3: thing"))).toBe(true);
});

test("names: a code-spanned Closes #7 does not name issue 7", () => {
  expect(names("#7", pr("`Closes #7`"))).toBe(false);
  expect(names("#7", pr("Closes #7"))).toBe(true);
});

test("issueOf: a code-spanned or fenced keyword falls back to the branch", () => {
  expect(issueOf({ body: "`Closes #7`", head: { ref: "task/12-x" } })).toBe(12);
  expect(issueOf({ body: FENCE + "\nFixes #7\n" + FENCE, head: { ref: "task/12-x" } })).toBe(12);
  expect(issueOf({ body: "> Closes #7", head: { ref: "task/12-x" } })).toBe(12);
});

test("issueOf: a plain Closes #7 gives 7", () => {
  expect(issueOf({ body: "Closes #7", head: { ref: "task/12-x" } })).toBe(7);
});

test("tasksOf: a code-spanned or quoted Part of is not listed, a plain one is", () => {
  expect(tasksOf("taytu/x", "`Part of #9`")).toEqual([]);
  expect(tasksOf("taytu/x", "> Part of #9")).toEqual([]);
  expect(tasksOf("taytu/x", "Part of #9")).toEqual(["9"]);
});
