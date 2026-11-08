// A stateful fake `gh` for tests that write to GitHub (comments, issues). Not a test file.
//
// The state is a JSON file (FAKE_DB):
//   issues    [{number, title, body, state, labels: [{name}], state_reason, pull_request?}]
//   labels, milestones   what `POST labels` and `POST milestones` made
//   comments  {"<issue number>": [body or {body, created_at}]}
//   pulls     [...]
// Reads answer from it. `POST issues` makes an issue; `POST issues/N/comments` appends a comment. Every call is logged
// to LOOP_LOG as `gh <args>`, and every write also to `posted` in the file, so a test can say "nothing was written".
// With `repo` set in the file (owner/name), paths that name that repo (`repos/owner/name/...`) are served too, `gh auth
// token` says it is signed in, and `PATCH issues/N` sets an issue's labels and state. FAKE_GH_FAIL=1 makes every `gh api`
// call fail (HTTP 502), as GitHub does when it is down, and FAKE_GH_FAIL_WRITES=1 only the writes. A posted comment's id is the one the listing gives it.
//
//     installFakeGh(dir)  // writes <dir>/bin/gh, executable
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
type Row = Record<string, any>;
const pathDb = process.env.FAKE_DB as string;
const db: Row = JSON.parse(readFileSync(pathDb, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.LOOP_LOG || "/dev/null", "gh " + a.join(" ") + "\n");
if (a[0] === "auth" && a[1] === "token" && db.repo) { console.log("gho_fake"); process.exit(0); }
// main's settings as GitHub has them (#637): mainSettings in the file, else a 404 (no factory.json on main)
if (a[0] === "repo" && a[1] === "view" && db.repo) { console.log("main"); process.exit(0); }
if (a[0] === "api" && a.some((x) => x.includes("contents/.claude/factory.json"))) {
  if (db.mainSettings === undefined) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
  process.stdout.write(JSON.stringify(db.mainSettings)); process.exit(0);
}
if (a[0] !== "api") process.exit(1);
if (process.env.FAKE_GH_FAIL === "1") { console.error("gh: Bad Gateway (HTTP 502)"); process.exit(1); }
if (process.env.FAKE_GH_FAIL_WRITES === "1" && a.some((x, i) => (x === "-X" || x === "--method") && a[i + 1] !== "GET")) {
  console.error("gh: Bad Gateway (HTTP 502)"); process.exit(1);
}
let method = "GET";
a.forEach((x, i) => { if (x === "-X" || x === "--method") method = a[i + 1] as string; });
const skip = new Set(["GET", "PATCH", "POST", "PUT", "DELETE", "application/vnd.github+json", "-"]);
const path = a.slice(1).filter((x) => !x.startsWith("-") && !skip.has(x))[0] as string;
const data: Row = a.includes("--input") ? JSON.parse(readFileSync(0, "utf8") || "{}") : {};
const own = db.repo ? "repos/" + db.repo + "/" : null;
const u = new URL(path.replace("repos/{owner}/{repo}/", "").replace(own && path.startsWith(own) ? own : "repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
const q = u.searchParams; const page = Number(q.get("page") || "1");
function out(x: unknown): never { process.stdout.write(JSON.stringify(x) + "\n"); process.exit(0); }
function save(kind: string, what: Row) { (db.posted ??= []).push({ kind, ...what }); writeFileSync(pathDb, JSON.stringify(db)); }
if (p === "user") out({ login: "me" });
if (p === "repos/{owner}/{repo}" || p === "repos/{owner}/{repo}/") out({ owner: { login: "boss", type: "User" } });
if (p === "labels" && method === "POST") {
  (db.labels ??= []).push({ name: data.name, color: data.color ?? "" }); save("label", { name: data.name }); out({});
}
if (p === "labels") out(page === 1 ? db.labels ?? [] : []);
if (p === "milestones" && method === "POST") {
  const ms = (db.milestones ??= []); const m = { number: ms.length + 1, title: data.title }; ms.push(m); save("milestone", m); out(m);
}
if (p === "milestones") out(page === 1 ? db.milestones ?? [] : []);
if (p === "issues" && method === "POST") {
  const n = Math.max(...(db.issues ?? []).map((i: Row) => i.number), 100) + 1;
  const issue: Row = { number: n, title: data.title ?? "", body: data.body ?? "", state: "open",
    labels: (data.labels ?? []).map((x: string) => ({ name: x })), html_url: "https://github.com/o/r/issues/" + n };
  if (data.milestone) issue.milestone = (db.milestones ?? []).find((m: Row) => m.number === data.milestone) ?? null;
  (db.issues ??= []).push(issue); save("issue", { number: n, title: issue.title }); out(issue);
}
if (p === "issues") {
  let items: Row[] = db.issues ?? [];
  const st = q.get("state") ?? "open";
  if (st !== "all") items = items.filter((i) => (i.state ?? "open") === st);
  const lab = q.get("labels");
  if (lab !== null) items = items.filter((i) => (i.labels ?? []).map((l: Row) => l.name).includes(lab));
  out(page === 1 ? items : []);
}
const m1 = /^issues\/(\d+)$/.exec(p);
if (m1 && method === "PATCH") {
  const i = (db.issues ?? []).find((x: Row) => x.number === Number(m1[1]));
  if (!i) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
  if (data.labels) i.labels = data.labels.map((x: string) => ({ name: x }));
  if (data.state) i.state = data.state;
  if ("state_reason" in data) i.state_reason = data.state_reason;
  save("patch", { issue: i.number, ...data }); out(i);
}
if (m1 && method === "GET") out((db.issues ?? []).find((i: Row) => i.number === Number(m1[1])) ?? {});
if (p === "pulls") out(page === 1 ? db.pulls ?? [] : []);
const mp = /^pulls\/(\d+)$/.exec(p);
if (mp && method === "GET") {
  const pr = (db.pulls ?? []).find((x: Row) => x.number === Number(mp[1]));
  if (!pr) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
  out(pr);
}
const m = /^issues\/(\d+)\/comments$/.exec(p);
if (m && method === "POST") {
  const k = m[1] as string;
  ((db.comments ??= {})[k] ??= []).push(data.body ?? "");
  const id = 1000 * Number(k) + db.comments[k].length;
  save("comment", { issue: Number(k), body: data.body ?? "" }); out({ id, body: data.body ?? "" });
}
if (m) {
  const k = m[1] as string;
  const rows = ((db.comments ?? {})[k] ?? []).map((b: unknown, j: number) => ({ id: 1000 * Number(k) + j + 1,
    ...(typeof b === "object" && b ? b : { body: b, created_at: "2026-10-25T10:00:00Z" }) }));
  out(page === 1 ? rows : []);
}
out(page === 1 ? [] : []);
`;

/** Write the fake gh to <dir>/bin/gh (executable) and return that bin folder, to put first on PATH. */
export function installFakeGh(dir: string, script: string = GH): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}
