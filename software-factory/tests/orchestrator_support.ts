// The dev manager's orchestrator in a throwaway project (orchestrator.test.ts, manager_verdict.test.ts): the role project
// of roles_support.ts with a stateful fake `gh` (a JSON file that POST and PATCH change, so claims, notes and owner asks
// can be read back) and a fake `claude` that records its prompt in full. Not a test file.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, type Proc, sh, writeExe } from "./support.ts";
import { claudeCalls, type Env, log, project, type Row, SF } from "./roles_support.ts";

export { SF };
export const H = "a".repeat(40);
export const H2 = "b".repeat(40);

export const GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { flock } from "@@LIB@@";
const f = process.env.FAKE_DB as string;
flock(openSync(f + ".lock", "w")); // sub-managers run side by side: one request at a time
const db = JSON.parse(readFileSync(f, "utf8")); const a = process.argv.slice(2);
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] !== "api") fail("fake gh: only gh api");
const rest = a.slice(1); let method = "GET"; let path = ""; let body: any = null;
for (let i = 0; i < rest.length;) {
  const x = rest[i] as string;
  if (x === "-X") { method = rest[i + 1] as string; i += 2; continue; }
  if (x === "-H") { i += 2; continue; }
  if (x === "--input") { body = JSON.parse(readFileSync(0, "utf8")); i += 2; continue; }
  if (x.startsWith("-")) { i += 1; continue; }
  path = x; i += 1;
}
appendFileSync(process.env.LOOP_LOG as string, "gh " + method + " " + path + "\n");
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = decodeURIComponent(u.pathname.slice(1)); const q = u.searchParams; const page = Number(q.get("page") ?? "1");
function save() { writeFileSync(f, JSON.stringify(db)); }
function out(x: unknown): never { console.log(JSON.stringify(x)); process.exit(0); }
function paged(x: unknown[]): never { out(page === 1 ? x : []); }
function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function findComment(cid: number) { for (const cs of Object.values(db.comments) as any[]) for (const c of cs) if (c.id === cid) return c; return null; }
if (p === "user") out({ login: "me" });
if (p === "repos/{owner}/{repo}") out(db.repo ?? { owner: { login: "boss", type: "User" } });
if (p === "pulls") { const want = q.get("state") ?? "open"; paged(db.pulls.filter((x: any) => (x.state ?? "open") === want)); }
let m = /^pulls\/(\d+)$/.exec(p);
if (m) out(db.pulls.find((x: any) => x.number === Number(m![1])));
if (p === "issues" && method === "GET") {
  let items = db.issues; const st = q.get("state") ?? "open";
  if (st !== "all") items = items.filter((x: any) => (x.state ?? "open") === st);
  const lab = q.get("labels");
  if (lab !== null) items = items.filter((x: any) => (x.labels ?? []).map((l: any) => l.name).includes(lab));
  paged(items.map((x: any) => ({ updated_at: now(), ...x })));
}
if (p === "branches") paged([]);
if (p === "issues" && method === "POST") {
  const n = Math.max(0, ...db.issues.map((x: any) => x.number)) + 1;
  const issue = { number: n, state: "open", title: body.title, body: body.body ?? "", labels: (body.labels ?? []).map((l: string) => ({ name: l })) };
  db.issues.push(issue); save(); out(issue);
}
m = /^issues\/(\d+)\/comments$/.exec(p);
if (m && method === "GET") paged(db.comments[m[1] as string] ?? []);
if (m && method === "POST") {
  db.next_id = (db.next_id ?? 1000) + 1;
  const c = { id: db.next_id, body: body.body, created_at: now() };
  (db.comments[m[1] as string] ??= []).push(c); save(); out(c);
}
m = /^issues\/comments\/(\d+)$/.exec(p);
if (m && method === "PATCH") { const c = findComment(Number(m[1])); c.body = body.body; save(); out(c); }
m = /^issues\/(\d+)\/events$/.exec(p);
if (m) paged((db.events ?? {})[m[1] as string] ?? []);
m = /^issues\/(\d+)\/labels$/.exec(p);
if (m && method === "POST") out([]);
m = /^commits\/(\w+)$/.exec(p);
if (m) out({ sha: m[1], commit: { committer: { date: (db.commits ?? {})[m[1] as string] ?? "2020-01-01T00:00:00Z" } } });
m = /^commits\/(\w+)\/check-runs$/.exec(p);
if (m) out({ check_runs: (db.checks ?? {})[m[1] as string] ?? [] });
if (/^commits\/\w+\/status$/.test(p)) out({ statuses: [] });
if (p === "actions/runs") out({ workflow_runs: db.actions_runs ?? [] });
if (p === "actions/runners") out({ runners: db.runners ?? [] });
fail("fake gh: no route for " + method + " " + path);
`.replace("@@LIB@@", join(HOOKS, "factory_lib.ts"));

/** An ISO time `minutesAgo` minutes ago (negative: in the future). */
export function iso(minutesAgo = 0): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function pr(n: number, o: { sha?: string; ref?: string; body?: string; draft?: boolean; labels?: string[]; state?: string;
  mergeable_state?: string } = {}): Row {
  return { number: n, title: `Change ${n}`, state: o.state ?? "open", draft: o.draft ?? false, body: o.body ?? "", user: { login: "me" },
    head: { sha: o.sha ?? H, ref: o.ref ?? `task/${n}-thing` }, base: { ref: "main" },
    labels: (o.labels ?? []).map((l) => ({ name: l })), mergeable_state: o.mergeable_state ?? "clean" };
}

export function comment(cid: number, body: string, ago = 0): Row {
  return { id: cid, body, created_at: iso(ago) };
}

export function okRun(name = "tests"): Row {
  return { id: 1, name, status: "completed", conclusion: "success" };
}

export function badRun(name = "tests"): Row {
  return { id: 2, name, status: "completed", conclusion: "failure" };
}

export function agentIssue(n: number, name: string, status: string, pingAgo: number, role = "coding-agent", sinceAgo: number | null = null): Row {
  const since = sinceAgo !== null ? ` since=${iso(sinceAgo)}` : "";
  return { number: n, state: "open", title: `Agent: ${name}`, labels: [{ name: "factory:agent" }],
    body: `<!-- factory-agent name=${name} status=${status} ping=${iso(pingAgo)}${since} -->\n<!-- factory-role role=${role} -->` };
}

const FAKE_CLAUDE = [
  "#!/usr/bin/env bash",
  String.raw`line="$(printf "claude %s" "$(printf "%s" "$*" | tr "\n" " ")")"; tmp="$(mktemp)"; printf "%s\n" "$line" > "$tmp"; cat "$tmp" >> "$LOOP_LOG"; rm -f "$tmp"`,
  String.raw`printf "%s\n" "$@" > "$(dirname "$LOOP_LOG")/last-args"`,
  'if [ -n "$' + '{FAKE_CLAUDE_HOOK:-}" ]; then bash "$FAKE_CLAUDE_HOOK" "$@"; exit $?; fi',
  "exit 0",
  "",
].join("\n");

export function world(o: { db?: Row; cfg?: Record<string, unknown>; files?: Record<string, string> } = {}): [string, string, Env] {
  const base: Row = { pulls: [], issues: [], comments: {}, events: {}, commits: {}, checks: {}, ...(o.db ?? {}) };
  const config: Record<string, unknown> = { tasks: { source: "issues" }, manager: { busyMinutes: 0, idleMinutes: 0 } };
  for (const [k, v] of Object.entries(o.cfg ?? {})) {
    const have = config[k];
    config[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(have && typeof have === "object" ? have : {}), ...v } : v;
  }
  const kitProfile = readFileSync(join(SF, "kit", ".claude", "manager", "settings.json"), "utf8");
  const [d, work, env] = project({ cfg: config, db: base, files: { ".claude/manager/settings.json": kitProfile, ...(o.files ?? {}) } });
  writeExe(join(d, "bin", "gh"), GH);
  // a fake claude that records its prompt in full and the lease state at the time it ran
  writeExe(join(d, "bin", "claude"), FAKE_CLAUDE);
  return [d, work, env];
}

export function dbOf(d: string): Row {
  return JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as Row;
}

export function put(d: string, changes: Row): void {
  writeFileSync(join(d, "db.json"), JSON.stringify({ ...dbOf(d), ...changes }));
}

/** Run one of the project's own hooks (.claude/hooks/<script>) with Bun. */
export function hook(work: string, env: Env, script: string, ...args: string[]): Proc {
  return sh([process.execPath, "--no-env-file", join(work, ".claude", "hooks", script), ...args], { cwd: work, env, timeoutMs: 90_000 });
}

export function watch(work: string, env: Env): Record<string, Row> {
  const p = hook(work, env, "factory_watch.ts", "--json");
  if (p.code !== 0 && p.code !== 3) throw new Error(p.out);
  const out: Record<string, Row> = {};
  if (p.stdout.trim().startsWith("[")) for (const i of JSON.parse(p.stdout) as Row[]) out[i.ref as string] = i;
  return out;
}

export function cycle(work: string, env: Env, ...args: string[]): Proc {
  return hook(work, env, "factory_orchestrator.ts", "cycle", "--name", "lead", ...args);
}

export function postedC(d: string, n: number): Row[] {
  return ((dbOf(d).comments as Record<string, Row[]>)[String(n)] ?? []);
}

export function posted(d: string, n: number): string[] {
  return postedC(d, n).map((c) => c.body as string);
}

export function writes(env: Env): string[] {
  return log(env).filter((l) => /^gh (POST|PATCH|PUT|DELETE) /.test(l));
}

export function prompts(env: Env): string[] {
  return claudeCalls(env);
}

export function skipComments(d: string, n: number): string[] {
  return posted(d, n).filter((b) => b.includes("factory-manager-skip"));
}

export function runSub(work: string, env: Env, item = "pr-5"): Proc {
  return hook(work, env, "factory_orchestrator.ts", "sub", "--name", "lead", "--item", item);
}

export const UNREVIEWED: Row = { pulls: [pr(5)], commits: { [H]: iso(60) } };
