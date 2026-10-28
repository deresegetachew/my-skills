// The fake `gh` that keeps issues in a JSON file, and the helpers the issues-mode tests share (issues, labels,
// hardening, label output, machines, next output, heartbeat, autostart). Not a test file.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, read, runHook, sh, tmp, write, writeExe } from "./support.ts";

export const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
type Row = Record<string, any>;
const dbPath = process.env.FAKE_GH_DB as string;
function fail(text: string): never { process.stderr.write(text + "\n"); process.exit(1); }
const db: Row = JSON.parse(readFileSync(dbPath, "utf8"));
const a = process.argv.slice(2);
if (a[0] !== "api") fail("fake gh: only ` + "`gh api`" + String.raw`");
const method = a.includes("-X") ? a[a.indexOf("-X") + 1] as string : "GET";
const path = a.slice(1).filter((x) => !x.startsWith("-") && ![method, "Accept: application/vnd.github+json", "-"].includes(x))[0] as string;
const body: Row = a.includes("--input") ? JSON.parse(readFileSync(0, "utf8")) : {};
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1);
const q = u.searchParams;
const page = Number(q.get("page") ?? "1");
function out(x: unknown): never { process.stdout.write(JSON.stringify(x) + "\n"); writeFileSync(dbPath, JSON.stringify(db)); process.exit(0); }
function issue(n: number): Row { const i = db.issues.find((i: Row) => i.number === n); if (!i) fail("StopIteration"); return i; }
const lab = (names: string[]) => names.map((n) => ({ name: n }));
db.clock = (db.clock ?? 0) + 1;
let m = /^issues\/(\d+)$/.exec(p);
if (p === "issues" && method === "GET") {
  if (process.env.FAKE_GH_MOVED) out({ message: "Moved Permanently", url: "https://api.github.com/repositories/1" });
  if (page > 1) out([]);
  let res = db.issues.filter((i: Row) => [i.state, "all"].includes(q.get("state") ?? "open"));
  if (q.has("labels")) res = res.filter((i: Row) => i.labels.map((l: Row) => l.name).includes(q.get("labels")));
  out(res);
}
if (p === "issues" && method === "POST") {
  const n = Math.max(0, ...db.issues.map((i: Row) => i.number)) + 1;
  const i = { number: n, title: body.title, body: body.body, state: "open", labels: lab(body.labels ?? []),
    milestone: "milestone" in body ? { number: body.milestone } : null, updated_at: "2026-10-21T08:00:00Z", html_url: "https://x/" + n };
  db.issues.push(i); out(i);
}
if (m && method === "GET") {
  if (!db.issues.some((i: Row) => i.number === Number(m![1]))) { process.stdout.write('{"message":"Not Found","status":"404"}\n'); fail("gh: Not Found (HTTP 404)"); }
  out(issue(Number(m[1])));
}
if (m && method === "PATCH") { Object.assign(issue(Number(m[1])), body); out(issue(Number(m[1]))); }
m = /^issues\/(\d+)\/labels$/.exec(p);
if (m) {
  const i = issue(Number(m[1]));
  for (const n of body.labels) if (!i.labels.some((l: Row) => l.name === n)) i.labels.push({ name: n });
  out(i.labels);
}
m = /^issues\/(\d+)\/labels\/(.+)$/.exec(p);
if (m) { const i = issue(Number(m[1])); i.labels = i.labels.filter((l: Row) => l.name !== decodeURIComponent(m![2] as string)); out([]); }
m = /^issues\/(\d+)\/comments$/.exec(p);
if (m) {
  const cs = ((db.comments ??= {})[m[1] as string] ??= []);
  if (method === "POST") { cs.push({ body: body.body, at: db.clock }); out(cs[cs.length - 1]); }
  out(page > 1 ? [] : cs);
}
if (p === "labels" && method === "POST") { (db.labels ??= []).push(body); out(body); }
if (["branches", "labels", "milestones", "pulls"].includes(p)) out(page > 1 ? [] : db[p] ?? []);
fail("fake gh: no route for " + method + " " + p);
`;

export interface IssueRow {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  milestone: { number: number } | null;
  updated_at: string;
  [key: string]: unknown;
}

export interface Db {
  issues: IssueRow[];
  comments?: Record<string, { body: string; at: number; user?: { login: string } }[]>;
  labels?: { name: string; color?: string }[];
  branches?: unknown[];
  pulls?: unknown[];
  clock?: number;
  [key: string]: unknown;
}

export type Env = Record<string, string | undefined>;

/** A project in issues mode with the fake gh first on PATH: [dir, db file, env]. */
export function setup(issues: IssueRow[]): [string, string, Env] {
  const d = tmp();
  mkdirSync(join(d, ".claude"), { recursive: true });
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik", "taytu"] }));
  const db = write(join(d, "db.json"), JSON.stringify({ issues }));
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, FAKE_GH_DB: db };
  delete env.FACTORY_AGENT; delete env.FACTORY_PID;
  return [d, db, env];
}

export function loadDb(db: string): Db {
  return JSON.parse(read(db)) as Db;
}

export function saveDb(db: string, data: Db): void {
  write(db, JSON.stringify(data));
}

/** factory_issues.ts with arguments: [exit code, stdout and stderr, each stripped, together]. */
export function run(d: string, env: Env, ...args: string[]): [number, string] {
  const p = runHook("factory_issues", args, { cwd: d, env });
  return [p.code, p.stdout.trim() + p.stderr.trim()];
}

/** factory_agents.ts with arguments, the same way. */
export function agents(d: string, env: Env, ...args: string[]): [number, string] {
  const p = runHook("factory_agents", args, { cwd: d, env });
  return [p.code, p.stdout.trim() + p.stderr.trim()];
}

/** next_task.ts with arguments: [exit code, stdout, stderr], each stripped. */
export function nextTask(d: string, env: Env, ...args: string[]): [number, string, string] {
  const p = runHook("next_task", args, { cwd: d, env });
  return [p.code, p.stdout.trim(), p.stderr.trim()];
}

export function issue(n: number, labels: string[] = ["factory:ready"], body = "", milestone: number | null = null): IssueRow {
  return { number: n, title: `Task ${n}`, body, state: "open", labels: labels.map((l) => ({ name: l })),
    milestone: milestone ? { number: milestone } : null, updated_at: "2020-01-01T00:00:00Z" };
}

export function labels(db: string, n: number): string[] {
  return (loadDb(db).issues.find((i) => i.number === n) as IssueRow).labels.map((l) => l.name).sort();
}

/** A pull request as the issues API lists it: an issue with a `pull_request` key. */
export function pull(n: number, state = "open"): IssueRow {
  return { ...issue(n, []), state, pull_request: { url: `https://x/pulls/${n}` } };
}

export function agentIssue(n: number, name: string, ping: string, state = "open"): IssueRow {
  const body = `<!-- factory-agent name=${name} status=idle ping=${ping} -->\n**Started:** x\n**Where:** y`;
  return { number: n, title: `Agent: ${name} · idle`, body, state, labels: [{ name: "factory:agent" }], milestone: null,
    updated_at: "2020-01-01T00:00:00Z" };
}

export function countAgentIssues(db: string): number {
  return loadDb(db).issues.filter((i) => i.labels.some((l) => l.name === "factory:agent")).length;
}

/** The db without the fake's clock (it ticks on reads), as text with sorted keys. */
export function snapshot(db: string): string {
  const data = loadDb(db);
  delete data.clock;
  const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ?
    Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sortKeys(data));
}

/** Run TypeScript in the project with the hooks imported (the port of a test that imported a hook in-process). */
export function inProject(d: string, env: Env, code: string) {
  return sh([process.execPath, "--no-env-file", "-e", code], { cwd: d, env: { ...env, CLAUDE_PROJECT_DIR: d } });
}

export { HOOKS };
