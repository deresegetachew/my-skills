// Shared helpers for the token-free wait tests (wait.test.ts, manage_tick.test.ts). Not a test file.
//
// `gh` is a fake on PATH reading a JSON file; each call may also advance the world ("steps": a list of db patches applied
// one per call to the pulls route), so a wait can see CI go from running to green. Sleeps are 0 seconds.
import { join } from "node:path";
import { BUN, HOOKS, sh, tmp, write, writeExe } from "./support.ts";

export { SF } from "./support.ts";
export const HOOK = join(HOOKS, "factory_wait.ts");

export const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const f = process.env.FAKE_DB as string; const db = JSON.parse(readFileSync(f, "utf8")); const a = process.argv.slice(2);
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] !== "api") fail("fake gh: only gh api");
const path = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1); const page = Number(u.searchParams.get("page") ?? "1");
function out(x: unknown): never { console.log(JSON.stringify(x)); process.exit(0); }
function paged(x: unknown[]): never { out(page === 1 ? x : []); }
if (p === "user") out({ login: "me" });
let m = /^pulls\/(\d+)$/.exec(p);
if (m) { // each look at a PR moves the scripted world one step on
  if (db.steps && db.steps.length) {
    const step = db.steps.length > 1 ? db.steps.shift() : db.steps[0];
    Object.assign(db, step); writeFileSync(f, JSON.stringify(db));
  }
  out(db.pulls[m[1] as string]);
}
if (p === "pulls") paged(Object.values(db.pulls));
m = /^commits\/(\w+)\/check-runs$/.exec(p);
if (m) out({ check_runs: db.runs ?? [], total_count: (db.runs ?? []).length });
m = /^commits\/(\w+)\/status$/.exec(p);
if (m) out({ statuses: [], total_count: 0 });
if (/^check-runs\/\d+\/annotations$/.test(p)) out(db.annotations ?? []);
m = /^issues\/(\d+)\/comments$/.exec(p);
if (m) {
  if (db.steps_comments && db.steps_comments.length) {
    db.comments = db.steps_comments.length > 1 ? db.steps_comments.shift() : db.steps_comments[0];
    writeFileSync(f, JSON.stringify(db));
  }
  paged(((db.comments ?? {})[m[1] as string] ?? []).map((b: string) => ({ body: b })));
}
if (p === "issues") paged(db.issues ?? []);
if (p === "branches") paged([]);
fail("fake gh: no route for " + p);
`;

export type Env = Record<string, string | undefined>;
export type Row = Record<string, unknown>;

export function world(db: Row = {}): [string, Env] {
  const d = tmp();
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const { cfg, ...rest } = db;
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg ?? {}));
  write(join(d, "db.json"), JSON.stringify(rest));
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH ?? ""}`, FAKE_DB: join(d, "db.json"),
    FACTORY_WAIT_START: "0", FACTORY_WAIT_MAX: "0" };
  return [d, env];
}

export function wait(d: string, env: Env, ...args: string[]): [number, string] {
  const p = sh([...BUN, HOOK, ...args], { cwd: d, env, timeoutMs: 60_000 });
  return [p.code, (p.stdout + p.stderr).trim()];
}

export function pr(n: number, o: { sha?: string; state?: string; draft?: boolean; user?: string; merged?: boolean } = {}): Row {
  return { number: n, state: o.state ?? "open", merged: o.merged ?? false, draft: o.draft ?? false, user: { login: o.user ?? "me" },
    head: { sha: o.sha ?? "abc1234def", ref: `b${n}` } };
}

export function run(name: string, status = "completed", conclusion: string | null = "success"): Row {
  return { id: 1, name, status, conclusion };
}

export const Q = "<!-- factory-question -->\nWhich?";
export const A = "<!-- factory-answer -->\nThis one.";
