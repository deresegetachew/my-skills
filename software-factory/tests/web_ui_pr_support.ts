// Shared helpers for the pull request page's tests (#453). Not a test file.
//
// A fake `gh` for one pull request's page: `gh api` answers pulls/N, pulls/N/files, pulls/N/reviews, issues/N/comments
// (GET and POST), commits/<sha>/check-runs and contents/<path> (raw) from a JSON db (FAKE_DB), PATCH pulls/N records
// the change, and `gh pr ready N` makes the draft ready. Every call is logged to LOOP_LOG as one JSON line {argv}.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeGh } from "./fakegh.ts";
import { write } from "./support.ts";
import { CONFIG, type Project, type Row } from "./web_ui_support.ts";

export const PR_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const file = process.env.FAKE_DB as string;
const db = JSON.parse(readFileSync(file, "utf8"));
appendFileSync(process.env.LOOP_LOG as string, JSON.stringify({ argv: a }) + "\n");
const out = (x: unknown): never => { console.log(typeof x === "string" ? x : JSON.stringify(x)); process.exit(0); };
const fail = (m: string): never => { process.stderr.write(m + "\n"); process.exit(1); };
const save = () => writeFileSync(file, JSON.stringify(db));
if (a[0] === "pr" && a[1] === "ready") {
  const pr = db.prs?.[a[2] as string]; if (!pr) fail("no pull request");
  pr.draft = false; (db.posted ??= []).push({ kind: "ready", pr: a[2] }); save(); out("ready");
}
if (a[0] !== "api") fail("unexpected gh " + a.join(" "));
if (process.env.FAKE_GH_FAIL === "1") fail("gh: Bad Gateway (HTTP 502)");
let method = "GET"; let path = ""; const fields: Record<string, string> = {};
for (let i = 1; i < a.length; i++) {
  const x = a[i] as string;
  if (x === "-X" || x === "--method") method = a[++i] as string;
  else if (x === "-H") i++;
  else if (x === "-f" || x === "-F") { const v = a[++i] as string; const at = v.indexOf("="); fields[v.slice(0, at)] = v.slice(at + 1); }
  else if (!x.startsWith("-") && !path) path = x;
}
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = decodeURIComponent(u.pathname.slice(1));
let m: RegExpExecArray | null;
if ((m = /^pulls\/(\d+)$/.exec(p))) {
  const pr = db.prs?.[m[1] as string]; if (!pr) fail("gh: Not Found (HTTP 404)");
  if (method === "PATCH") { Object.assign(pr, fields); (db.posted ??= []).push({ kind: "patch", pr: m[1], ...fields }); save(); }
  out(pr);
}
if ((m = /^pulls\/(\d+)\/files$/.exec(p))) out(db.files?.[m[1] as string] ?? []);
if ((m = /^pulls\/(\d+)\/reviews$/.exec(p))) out(db.reviews?.[m[1] as string] ?? []);
if ((m = /^commits\/([0-9a-f]+)\/check-runs$/.exec(p))) out({ total_count: 0, check_runs: db.checks?.[m[1] as string] ?? [] });
if ((m = /^contents\/(.+)$/.exec(p))) { const t = db.contents?.[m[1] as string]; if (t === undefined) fail("gh: Not Found (HTTP 404)"); process.stdout.write(t); process.exit(0); }
if ((m = /^issues\/(\d+)\/comments$/.exec(p))) {
  const n = m[1] as string;
  if (method === "POST") { (db.posted ??= []).push({ kind: "comment", issue: n, body: fields.body }); ((db.comments ??= {})[n] ??= []).push({ body: fields.body, user: { login: "boss" } }); save(); out({ id: 1 }); }
  out(db.comments?.[n] ?? []);
}
fail("gh: Not Found (HTTP 404) for " + method + " " + path);
`;

export const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const NEW_HEAD = "ffffeeee0000111122223333444455556666aaaa";
export const RED_HEAD = "bbbbcccc0000111122223333444455556666dddd";

/** The project's settings: the PRD is protected, as on factory-sandbox. */
export const PR_CONFIG: Row = { ...CONFIG, protected: ["^docs/PRD\\.md$", "^\\.claude/"], alwaysAllowed: [] };

const PRD = "# Shelf\n\n## Users\n\n- **US-1.** As a reader, I keep a list of books.\n";

/** #42: the product owner's draft PRD, on po/shelf-prd. #22: a builder's green PR. #23: a builder's red PR. */
export function prDb(): Row {
  const run = (name: string, conclusion: string | null, id: number, status = "completed") => ({ name, status, conclusion,
    started_at: "2026-11-07T10:00:00Z", html_url: `https://github.com/o/work/actions/runs/${id}/job/${id + 1}`,
    details_url: `https://github.com/o/work/actions/runs/${id}/job/${id + 1}` });
  return {
    prs: {
      42: { number: 42, title: "The product's PRD", state: "open", draft: true, merged: false, mergeable: true, html_url: "https://github.com/o/work/pull/42",
        body: "## What changes in the PRD\n\nThe first PRD for Shelf.\n\nPart of #3", head: { sha: HEAD, ref: "po/shelf-prd" }, base: { ref: "main" },
        user: { login: "boss" }, labels: [] },
      22: { number: 22, title: "The settings page", state: "open", draft: false, merged: false, mergeable: true, html_url: "https://github.com/o/work/pull/22",
        body: "Closes #8", head: { sha: NEW_HEAD, ref: "task/8-settings" }, base: { ref: "main" }, user: { login: "boss" }, labels: [{ name: "agent:taytu" }] },
      23: { number: 23, title: "Login", state: "open", draft: false, merged: false, mergeable: true, html_url: "https://github.com/o/work/pull/23",
        body: "Closes #7", head: { sha: RED_HEAD, ref: "task/7-login" }, base: { ref: "main" }, user: { login: "boss" }, labels: [{ name: "agent:menelik" }] },
    },
    files: {
      42: [{ filename: "docs/PRD.md", status: "added", additions: 5, deletions: 0, patch: "@@ -0,0 +1,5 @@\n+# Shelf\n+\n+## Users\n+\n+- **US-1.** As a reader, I keep a list of books." }],
      22: [{ filename: "src/settings.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d" }],
      23: [{ filename: "src/login.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x" }],
    },
    reviews: { 42: [{ user: { login: "fasil" }, state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-11-07T10:05:00Z" }] },
    comments: { 42: [{ body: "<!-- pr-watch sha=" + HEAD + " -->\nRead it; the owner merges the PRD.", user: { login: "fasil" }, created_at: "2026-11-07T10:06:00Z" },
      { body: "Looks right to me.", user: { login: "boss" }, created_at: "2026-11-07T10:07:00Z" }] },
    checks: { [HEAD]: [run("check", "success", 900)], [NEW_HEAD]: [run("check", "success", 901), run("guard", "success", 902)],
      [RED_HEAD]: [run("check", "failure", 903)] },
    contents: { "docs/PRD.md": PRD },
  };
}

/** The snapshot's rows for them, as `factory snapshot` writes them. */
export function prRows(head42 = HEAD): Row[] {
  return [
    { number: 22, title: "The settings page", url: "https://github.com/o/work/pull/22", branch: "task/8-settings", draft: false, ci: "green",
      next: "owner-merges", nextText: "owner merges (protected)", agent: "taytu", review: "factory-approved", gate: null, notGreen: [],
      protected: true, claim: null, head: NEW_HEAD },
    { number: 23, title: "Login", url: "https://github.com/o/work/pull/23", branch: "task/7-login", draft: false, ci: "red",
      next: "waiting-for-agent", nextText: "waiting for agent", agent: "menelik", review: null, gate: null, notGreen: [{ name: "check", state: "red" }],
      protected: null, claim: null, head: RED_HEAD },
    { number: 42, title: "The product's PRD", url: "https://github.com/o/work/pull/42", branch: "po/shelf-prd", draft: true, ci: "green",
      next: "waiting-for-agent", nextText: "waiting for agent", agent: null, review: "pr-watch", gate: null, notGreen: [], protected: null, claim: null,
      head: head42 },
  ];
}

/** Puts the fake gh and its db in project `p`, and the snapshot's cache with `rows`. */
export function prProject(p: Project, rows: Row[] = prRows(), db: Row = prDb()): void {
  installFakeGh(p.root, PR_GH);
  writeFileSync(join(p.root, "db.json"), JSON.stringify(db));
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [] }, pulls: rows, ci: { mode: "github", repo: "o/work", runners: [], runs: [], errors: [] } }));
}

/** What the fake gh was asked, one argv per call. */
export function ghCalls(p: Project): string[][] {
  return readFileSync(p.ghLog, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv);
}

/** What the fake gh wrote (comments, patches, ready). */
export function posted(p: Project): Row[] {
  return ((JSON.parse(readFileSync(join(p.root, "db.json"), "utf8")) as Row).posted ?? []) as Row[];
}
