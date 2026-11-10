// #615: a task's CI runs are kept by `factory snapshot` itself, so a pull request that opens, runs CI and merges between
// two reads of the costs still has its runs counted. Observable: task-times.json in the state folder (the file the web
// UI's costs read) lists each run after the pull request is gone. The CI status lists the latest run per open-PR branch.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, CI, copyHookFolders, SF, envWith, gitRepo, sh, tmp, write } from "./support.ts";
import { copyFileSync, cpSync } from "node:fs";

const SHA = "d".repeat(40);

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.SNAPSHOT_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] !== "api") { console.log("ok"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "POST" && x !== "PATCH" && x !== "Accept: application/vnd.github+json")[0] as string;
const short = raw.replace("repos/{owner}/{repo}/", "").replace(/^repos\/o\/r(\/|$)/, (_m, slash) => slash ? "" : "repo");
const path = new URL(short, "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json" || path.startsWith("actions/variables/")) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
if (path in s) out(s[path]);
if (path.startsWith("issues/") && path.endsWith("/comments")) out([]);
console.error("fake gh: no answer for " + path); process.exit(1);
`;

type Row = Record<string, any>;

function scenario(open: boolean, run: Row | null): Row {
  return {
    issues: [],
    pulls: open ? [{ number: 12, title: "Task 7", draft: false, html_url: "https://github.com/o/r/pull/12", body: "Closes #7",
      head: { sha: SHA, ref: "task/7-login" }, labels: [] }] : [],
    [`commits/${SHA}`]: { commit: { committer: { date: "2020-01-01T00:00:00Z" } } },
    [`commits/${SHA}/check-runs`]: { check_runs: [] },
    "issues/12/comments": [],
    "pulls/12/files": [{ filename: "src/a.ts" }],
    repo: { default_branch: "main" },
    "actions/runs": { workflow_runs: run ? [run] : [] },
    "actions/runners": { runners: [] },
  };
}

const run = (id: number, conclusion: string): Row => ({ id, head_branch: "task/7-login", status: "completed", conclusion, name: "check",
  created_at: new Date(Date.now() - 5 * 60_000).toISOString() });

test("factory snapshot keeps a task's CI runs, so they count after its pull request has merged", () => {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] }));
  write(join(root, "bin", "gh"), FAKE_GH, 0o755);
  const xdg = join(root, "state");
  mkdirSync(xdg);
  mkdirSync(join(root, "home"));
  const scen = join(root, "scenario.json");
  const env = envWith(join(root, "bin"), { SNAPSHOT_SCENARIO: scen, XDG_STATE_HOME: xdg, HOME: join(root, "home"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENTS: undefined,
    FACTORY_CONFIG_DIR: undefined, XDG_CONFIG_HOME: join(root, "config") });
  const snap = (s: Row): void => {
    writeFileSync(scen, JSON.stringify(s));
    const r = sh(["bash", join(SF, "factory"), "snapshot"], { cwd: d, env, timeoutMs: 120_000 });
    expect(r.code, r.out).toBe(0);
    if (s.pulls.length) expect((JSON.parse(r.stdout) as Row).ci.runs.map((x: Row) => x.id), r.stdout).toEqual([s["actions/runs"].workflow_runs[0].id]);
  };
  snap(scenario(true, run(101, "success")));
  snap(scenario(true, run(102, "failure")));
  snap(scenario(false, null)); // merged: the snapshot no longer lists any run; no costs read in between

  const files = readdirSync(xdg).map((x) => join(xdg, x, "task-times.json")).filter((f) => existsSync(f));
  expect(files.length).toBe(1);
  const events = (JSON.parse(readFileSync(files[0] as string, "utf8")) as { events: Row[] }).events;
  const ci = events.filter((e) => e.kind === "ci" && e.task === "7");
  expect(ci.length).toBe(2);
  expect(ci.filter((e) => e.failed === true).length).toBe(1);
}, 400_000);
