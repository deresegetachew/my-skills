// `factory prs --json` gives each pull request the decisions and PRD stories its body cites (`cites`), against a fake `gh`.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, SF, envWith, gitRepo, sh, tmp, write, writeExe } from "./support.ts";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.PRS_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json") out(s.main_settings);
if (path in s) out(s[path]);
if (path === "branches") out([]);
console.error("fake gh: no answer for " + path);
process.exit(1);
`;

function pull(n: number, body: string): unknown {
  return { number: n, title: `Task ${n}`, draft: false, body, html_url: `https://github.com/o/r/pull/${n}`,
    head: { sha: String(n).repeat(40), ref: `task/${n}-x` }, labels: [] };
}

test("prs --json: each pull's cites come from its body, and are [] when it cites nothing", () => {
  const sc: Record<string, unknown> = { pulls: [pull(1, "Follows decision 0004 and covers US-12."), pull(2, "No citations.")],
    issues: [], "issues/comments": [], main_settings: { tasks: { source: "issues" } } };
  for (const n of [1, 2]) {
    const sha = String(n).repeat(40);
    sc[`commits/${sha}`] = { commit: { committer: { date: "2020-01-01T00:00:00Z" } } };
    sc[`commits/${sha}/check-runs`] = { check_runs: [] };
    sc[`issues/${n}/comments`] = [];
    sc[`pulls/${n}/files`] = [{ filename: "src/a.ts" }];
  }
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik", "taytu"] }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  write(join(root, "scenario.json"), JSON.stringify(sc));
  const env = envWith(join(root, "bin"), { PRS_SCENARIO: join(root, "scenario.json"), PRS_LOG: join(root, "log"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined });
  const p = sh(["bash", join(SF, "factory"), "prs", "--json"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  const pulls = (JSON.parse(p.stdout) as { pulls: { number: number; cites?: string[] }[] }).pulls;
  expect(pulls.map((x) => [x.number, x.cites])).toEqual([[1, ["decision 0004", "US-12"]], [2, []]]);
});
