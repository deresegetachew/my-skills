// The orchestrator's lease (factory_lease.ts, #97): the earliest unexpired claim wins, a loser ends its own, an expired
// claim is taken over, a new head is a new key, and release ends a lease early. (From test_orchestrator.py's lease
// section, #252; the rest of that file waits for factory_orchestrator.)
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, envWith, gitRepo, runCode, tmp, writeExe } from "./support.ts";

const H = "a".repeat(40);
const H2 = "b".repeat(40);

// A stateful fake gh: comments on issues and PRs (GET, POST, PATCH), kept in FAKE_DB.
const GH = String.raw`#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const f = process.env.FAKE_DB as string;
const db: any = JSON.parse(readFileSync(f, "utf8"));
const a = process.argv.slice(2);
if (a[0] !== "api") { console.error("fake gh: only gh api"); process.exit(1); }
let method = "GET"; let path = ""; let body: any = null;
for (let i = 1; i < a.length;) {
  const x = a[i] as string;
  if (x === "-X") { method = a[i + 1] as string; i += 2; continue; }
  if (x === "-H") { i += 2; continue; }
  if (x === "--input") { body = JSON.parse(readFileSync(0, "utf8")); i += 2; continue; }
  if (x.startsWith("-")) { i += 1; continue; }
  path = x; i += 1;
}
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1); const page = Number(u.searchParams.get("page") ?? "1");
function out(x: unknown): never { writeFileSync(f, JSON.stringify(db)); console.log(JSON.stringify(x)); process.exit(0); }
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
let m = /^issues\/(\d+)\/comments$/.exec(p);
if (m && method === "GET") out(page === 1 ? db.comments[m[1] as string] ?? [] : []);
if (m && method === "POST") {
  db.next_id = (db.next_id ?? 1000) + 1;
  const c = { id: db.next_id, body: body.body, created_at: now() };
  (db.comments[m[1] as string] ??= []).push(c); out(c);
}
m = /^issues\/comments\/(\d+)$/.exec(p);
if (m && method === "PATCH") {
  for (const cs of Object.values(db.comments) as any[][]) for (const c of cs) if (c.id === Number(m[1])) { c.body = body.body; out(c); }
}
console.error("fake gh: no route for " + method + " " + path); process.exit(1);
`;

type Db = { comments: Record<string, { id: number; body: string; created_at: string }[]> };

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function comment(cid: number, body: string, ago = 0): { id: number; body: string; created_at: string } {
  return { id: cid, body, created_at: iso(ago) };
}

function world(db: Db): [string, Record<string, string | undefined>] {
  const d = tmp();
  mkdirSync(join(d, "work"));
  const work = gitRepo(join(d, "work"));
  writeExe(join(d, "bin", "gh"), GH);
  writeFileSync(join(d, "db.json"), JSON.stringify(db));
  return [work, envWith(join(d, "bin"), { FAKE_DB: join(d, "db.json"), CLAUDE_PROJECT_DIR: undefined })];
}

function dbOf(env: Record<string, string | undefined>): Db {
  return JSON.parse(readFileSync(env.FAKE_DB as string, "utf8")) as Db;
}

function posted(env: Record<string, string | undefined>, n: number): string[] {
  return (dbOf(env).comments[String(n)] ?? []).map((c) => c.body);
}

const LEASE = JSON.stringify(join(HOOKS, "factory_lease.ts"));

function leaseScript(work: string, env: Record<string, string | undefined>, who: string): unknown {
  const code = `const L = await import(${LEASE}); const r = L.acquire(5, "review", ${JSON.stringify(H)}, ${JSON.stringify(who)}, 20);` +
    " console.log(JSON.stringify(r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]))));";
  const p = runCode(code, { cwd: work, env });
  expect(p.code, p.out).toBe(0);
  return JSON.parse(p.stdout) as unknown;
}

test("the earliest unexpired claim wins and the loser ends its own", () => {
  const [work, env] = world({ comments: { "5": [] } });
  const first = leaseScript(work, env, "alpha") as { holder: string };
  expect(first.holder).toBe("alpha");
  expect(leaseScript(work, env, "beta"), "beta must not take what alpha holds").toBeNull();
  expect((leaseScript(work, env, "alpha") as { holder: string }).holder, "holding it already is fine").toBe("alpha");
  const claims = posted(env, 5).filter((b) => b.includes("-claim "));
  expect(claims.length).toBe(1);
  expect(claims[0]).toContain("manager=alpha");
});

test("an expired claim is taken over and a new head is a different key", () => {
  const old = `<!-- factory-review-claim manager=alpha sha=${H} until=${iso(5)} -->`;
  const [work, env] = world({ comments: { "5": [comment(1, old, 30)] } });
  expect((leaseScript(work, env, "beta") as { holder: string }).holder).toBe("beta");
  const other = `<!-- factory-review-claim manager=alpha sha=${H2} until=${iso(-9)} -->`;
  const db = dbOf(env);
  db.comments = { "5": [comment(1, other, 1)] };
  writeFileSync(env.FAKE_DB as string, JSON.stringify(db));
  expect((leaseScript(work, env, "beta") as { holder: string }).holder, "alpha's claim is on another head").toBe("beta");
});

test("release ends a lease early", () => {
  const [work, env] = world({ comments: { "5": [] } });
  const code = `const L = await import(${LEASE}); const r = L.acquire(5, "review", ${JSON.stringify(H)}, "alpha", 20);` +
    ` L.release(r); L.release(r); console.log(String(L.holder(5, "review", ${JSON.stringify(H)})));`;
  const p = runCode(code, { cwd: work, env });
  expect(p.stdout.trim(), p.out).toBe("null");
});
