// A factory project for the NATS plugin's end-to-end tests (#410-#412): a git repo whose origin names the project, its
// own HOME (for the seeds) and config folder, `.claude/factory.json` with the `messaging` settings, and the stateful fake
// gh of tests/fakegh.ts on PATH. Not a test file.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Proc, readJson, runHook, sh, tmp, write, writeExe } from "../../../tests/support.ts";

// A stateful fake gh: issues (labels, PATCH), comments (GET, POST, PATCH, one by id), pulls and branches, kept in
// FAKE_DB. Every call is logged to LOOP_LOG as `<METHOD> <path>`.
const GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
type Row = Record<string, any>;
const f = process.env.FAKE_DB as string;
const db: Row = JSON.parse(readFileSync(f, "utf8"));
const a = process.argv.slice(2);
if (a[0] !== "api") { console.error("fake gh: only gh api"); process.exit(1); }
let method = "GET"; let path = ""; let body: Row = {};
for (let i = 1; i < a.length;) {
  const x = a[i] as string;
  if (x === "-X" || x === "--method") { method = a[i + 1] as string; i += 2; continue; }
  if (x === "-H") { i += 2; continue; }
  if (x === "--input") { body = JSON.parse(readFileSync(0, "utf8") || "{}"); i += 2; continue; }
  if (x.startsWith("-")) { i += 1; continue; }
  if (!path) path = x;
  i += 1;
}
appendFileSync(process.env.LOOP_LOG as string, method + " " + path + "\n");
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = decodeURIComponent(u.pathname.slice(1)); const q = u.searchParams; const page = Number(q.get("page") ?? "1");
function out(x: unknown): never { writeFileSync(f, JSON.stringify(db)); console.log(JSON.stringify(x)); process.exit(0); }
const list = (x: unknown[]) => out(page === 1 ? x : []);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const issue = (n: string) => (db.issues as Row[]).find((i) => i.number === Number(n));
if (p === "user") out({ login: "me" });
if (p === "repos/{owner}/{repo}" || p === "") out({ full_name: "o/r", owner: { login: "o", type: "User" } });
if (p === "issues") {
  let items: Row[] = db.issues;
  const st = q.get("state") ?? "open";
  if (st !== "all") items = items.filter((i) => (i.state ?? "open") === st);
  const lab = q.get("labels");
  if (lab) items = items.filter((i) => i.labels.some((l: Row) => l.name === lab));
  list(items);
}
let m = /^issues\/(\d+)$/.exec(p);
if (m && method === "PATCH") { Object.assign(issue(m[1] as string) ?? {}, body); out(issue(m[1] as string)); }
if (m) { const i = issue(m[1] as string); if (!i) { console.error("HTTP 404: Not Found"); process.exit(1); } out(i); }
m = /^issues\/(\d+)\/labels$/.exec(p);
if (m && method === "POST") {
  const i = issue(m[1] as string) as Row;
  for (const l of body.labels) if (!i.labels.some((x: Row) => x.name === l)) i.labels.push({ name: l });
  (db.posted ??= []).push({ kind: "labels", issue: i.number, labels: body.labels }); out(i.labels);
}
m = /^issues\/(\d+)\/labels\/(.+)$/.exec(p);
if (m && method === "DELETE") {
  const i = issue(m[1] as string) as Row; i.labels = i.labels.filter((x: Row) => x.name !== m![2]); out(i.labels);
}
m = /^issues\/(\d+)\/comments$/.exec(p);
if (m && method === "POST") {
  db.next_id = (db.next_id ?? 1000) + 1;
  const c = { id: db.next_id, body: body.body, created_at: now(), issue_url: "https://api.github.com/repos/o/r/issues/" + m[1],
    user: { login: "me" } };
  ((db.comments ??= {})[m[1] as string] ??= []).push(c);
  (db.posted ??= []).push({ kind: "comment", issue: Number(m[1]), body: body.body }); out(c);
}
if (m) list((db.comments ?? {})[m[1] as string] ?? []);
m = /^issues\/comments\/(\d+)$/.exec(p);
if (m) {
  for (const [n, cs] of Object.entries(db.comments ?? {}) as [string, Row[]][]) {
    for (const c of cs) {
      if (c.id !== Number(m[1])) continue;
      if (method === "PATCH") { c.body = body.body; (db.posted ??= []).push({ kind: "edit", issue: Number(n), body: body.body }); }
      out({ ...c, issue_url: "https://api.github.com/repos/o/r/issues/" + n });
    }
  }
  console.error("HTTP 404: Not Found"); process.exit(1);
}
if (p === "pulls") list((db.pulls ?? []).filter((x: Row) => (x.state ?? "open") === "open"));
m = /^pulls\/(\d+)$/.exec(p);
if (m) { const x = (db.pulls ?? []).find((y: Row) => y.number === Number(m![1])); if (x) out(x); console.error("HTTP 404: Not Found"); process.exit(1); }
if (p === "branches") list(db.branches ?? []);
console.error("fake gh: no route for " + method + " " + path); process.exit(1);
`;

function installFakeGh(root: string): string {
  writeExe(join(root, "bin", "gh"), GH);
  return join(root, "bin");
}

export interface Project {
  dir: string; // the project's folder (a git repo)
  home: string;
  env: Record<string, string | undefined>;
  db: string; // the fake gh's state (FAKE_DB)
  log: string; // every gh call, one line each (LOOP_LOG)
}

export type Db = Record<string, unknown>;

/** A project named `repo` on origin, with `config` as its factory.json and `db` as GitHub's state. */
export function project(repo: string, config: Record<string, unknown>, db: Db = {}): Project {
  const root = tmp();
  const dir = join(root, repo.toLowerCase());
  mkdirSync(dir, { recursive: true });
  sh(["git", "init", "-q", "-b", "main", dir]);
  sh(["git", "-C", dir, "remote", "add", "origin", `git@github.com:o/${repo}.git`]);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const bin = installFakeGh(root);
  const dbPath = write(join(root, "db.json"), JSON.stringify({ issues: [], comments: {}, pulls: [], ...db }));
  write(join(dir, ".claude", "factory.json"), JSON.stringify(config));
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home,
    FACTORY_CONFIG_DIR: join(home, "cfg"), FAKE_DB: dbPath, LOOP_LOG: join(root, "gh.log"), FACTORY_CLAIM_SETTLE_SECONDS: "0",
    GH_TOKEN: "x" };
  for (const k of ["FACTORY_AGENT", "FACTORY_ROLE", "FACTORY_LOOP", "FACTORY_MACHINE_ID"]) delete env[k];
  return { dir, home, env, db: dbPath, log: join(root, "gh.log") };
}

/** Run hooks/<name>.ts in the project, as `agent` when given. */
export function hook(p: Project, name: string, args: string[], agent?: string, extra: Record<string, string> = {}): Proc {
  return runHook(name, args, { cwd: p.dir, env: { ...p.env, ...(agent ? { FACTORY_AGENT: agent } : {}), ...extra },
    timeoutMs: 120_000 });
}

/** The gh calls so far, one `<METHOD> <path>` each. */
export function calls(p: Project): string[] {
  try {
    return readFileSync(p.log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** The fake GitHub's state now. */
export function state(p: Project): Db & { posted?: Record<string, unknown>[]; comments: Record<string, unknown[]> } {
  return readJson(p.db);
}
