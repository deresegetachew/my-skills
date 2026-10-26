// A stateful fake `gh` for tests that write to GitHub (comments, issues). Not a test file.
//
// The state is a JSON file (FAKE_DB):
//   issues    [{number, title, body, state, labels: [{name}], state_reason, pull_request?}]
//   labels, milestones   what `POST labels` and `POST milestones` made
//   comments  {"<issue number>": [body or {body, created_at}]}
//   pulls     [...]
// Reads answer from it. `POST issues` makes an issue; `POST issues/N/comments` appends a comment. Every call is logged
// to LOOP_LOG as `gh <args>`, and every write also to `posted` in the file, so a test can say "nothing was written".
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
if (a[0] !== "api") process.exit(1);
let method = "GET";
a.forEach((x, i) => { if (x === "-X" || x === "--method") method = a[i + 1] as string; });
const skip = new Set(["GET", "PATCH", "POST", "PUT", "DELETE", "application/vnd.github+json", "-"]);
const path = a.slice(1).filter((x) => !x.startsWith("-") && !skip.has(x))[0] as string;
const data: Row = a.includes("--input") ? JSON.parse(readFileSync(0, "utf8") || "{}") : {};
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
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
if (m1 && method === "GET") out((db.issues ?? []).find((i: Row) => i.number === Number(m1[1])) ?? {});
if (p === "pulls") out(page === 1 ? db.pulls ?? [] : []);
const m = /^issues\/(\d+)\/comments$/.exec(p);
if (m && method === "POST") {
  const k = m[1] as string;
  ((db.comments ??= {})[k] ??= []).push(data.body ?? "");
  save("comment", { issue: Number(k), body: data.body ?? "" }); out({ id: 1 });
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
