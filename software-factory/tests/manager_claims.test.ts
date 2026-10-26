// Several dev managers at once (#99): review and question claims with a lease, a stale hold cleaned, a merge that
// GitHub refuses because someone else got there first, and owner-queue asks posted once. A fake `gh` keeps one
// repository in a JSON file (with a lock, so two managers can really race); the managers are the real command.
import { expect, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fnmatch } from "../hooks/factory_lib.ts";
import { runGate } from "./pr_gate_support.ts";
import { HOOKS, KIT, SF, sh, tmp, write, writeExe, type Proc } from "./support.ts";

const HEAD = "a".repeat(40);
const NEWHEAD = "b".repeat(40);

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
const statePath = process.env.FAKE_GH_STATE as string;
const lock = statePath + ".lock";
for (let i = 0; ; i++) { // one request at a time: two managers race for real
  try { mkdirSync(lock); break; } catch { Bun.sleepSync(5); if (i > 4000) break; }
}
const S: any = JSON.parse(readFileSync(statePath, "utf8"));
const a = process.argv.slice(2);
(S.log ??= []).push(a.join(" "));
function save() { writeFileSync(statePath, JSON.stringify(S)); try { rmdirSync(lock); } catch {} }
function fail(code: number, msg: string): never { save(); process.stderr.write("gh: " + msg + " (HTTP " + code + ")\n"); process.exit(1); }
function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function out(x: unknown): never { save(); console.log(JSON.stringify(x)); process.exit(0); }
if (a[0] === "repo" && a[1] === "view") { save(); console.log("main"); process.exit(0); }
if (a[0] !== "api") fail(400, "only api");
const method = a.includes("-X") ? a[a.indexOf("-X") + 1] : "GET";
const raw = a.slice(1).filter((x, i) => !x.startsWith("-") && a[i] !== "-X" && a[i] !== "-H")[0] as string;
const u = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/");
const path = u.pathname.slice(1);
const q = u.searchParams;
const body: any = a.includes("--input") ? JSON.parse(readFileSync(0, "utf8")) : {};
function issueView(n: string | number) {
  const k = Number(n);
  return S.pulls.find((p: any) => p.number === k) ?? S.issues.find((i: any) => i.number === k) ?? null;
}
function page(rows: any[]) {
  const per = Number(q.get("per_page") ?? "30"); const pg = Number(q.get("page") ?? "1");
  return rows.slice((pg - 1) * per, pg * per);
}
const parts = path.split("/");
if (path === "pulls" && method === "GET") out(page(S.pulls.filter((p: any) => p.state === "open")));
if (path === "issues" && method === "GET") {
  const rows = [...S.issues.filter((i: any) => i.state === "open"),
    ...S.pulls.filter((p: any) => p.state === "open").map((p: any) => ({ ...p, pull_request: {}, comments: (S.comments[String(p.number)] ?? []).length }))];
  out(page(rows));
}
if (path === "issues" && method === "POST") {
  const n = Math.max(0, ...S.issues.map((i: any) => i.number), ...S.pulls.map((p: any) => p.number)) + 1;
  S.issues.push({ number: n, title: body.title, body: body.body, state: "open", labels: [], comments: 0 });
  out({ number: n });
}
if (path === "user") out({ login: "owner" });
if (parts[0] === "pulls" && parts.length === 2 && method === "GET") { const p = issueView(parts[1]); if (p) out(p); fail(404, "Not Found"); }
if (parts[0] === "pulls" && parts[parts.length - 1] === "merge" && method === "PUT") {
  const p = issueView(parts[1]);
  if (p.state !== "open") fail(405, "Pull Request is not mergeable");
  if (body.sha !== p.head.sha) fail(409, "Head branch was modified. Review and try the merge again.");
  p.state = "closed"; p.merged = true;
  out({ merged: true });
}
if (parts[0] === "issues" && parts[1] === "comments") {
  const cid = Number(parts[2]);
  for (const [n, cs] of Object.entries(S.comments) as [string, any[]][]) {
    for (const c of cs) {
      if (c.id === cid) {
        if (method === "DELETE") { cs.splice(cs.indexOf(c), 1); out({}); }
        out({ ...c, issue_url: "https://api.github.com/repos/o/r/issues/" + n });
      }
    }
  }
  fail(404, "Not Found");
}
if (parts[0] === "issues" && parts.length === 3 && parts[2] === "comments") {
  const n = parts[1] as string;
  const cs = (S.comments[n] ??= []);
  if (method === "GET") out(page(cs));
  const race = S.race ?? {}; delete S.race;
  for (const other of race[n] ?? []) { // another manager gets in just before this post
    S.next_id += 1;
    cs.push({ id: S.next_id, body: other, created_at: now(), user: { login: "owner" } });
  }
  S.next_id += 1;
  const c = { id: S.next_id, body: body.body, created_at: now(), user: { login: "owner" } };
  cs.push(c);
  out(c);
}
if (parts[0] === "issues" && parts.length === 3 && parts[2] === "labels" && method === "POST") {
  const p = issueView(parts[1]);
  for (const name of body.labels) if (!p.labels.some((x: any) => x.name === name)) p.labels.push({ name });
  out(p.labels);
}
if (parts[0] === "issues" && parts.length === 4 && parts[2] === "labels" && method === "DELETE") {
  const p = issueView(parts[1]);
  p.labels = p.labels.filter((x: any) => x.name !== decodeURIComponent(parts[3] as string));
  out([]);
}
if (parts[0] === "commits") out({ check_runs: [], statuses: [] });
if (path === "actions/runs") out({ workflow_runs: [] });
fail(404, "Not Found: fake gh has no " + method + " " + path);
`;

function iso(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nowMs(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

function claimText(who: string, head: string | number, mins: number, kind = "review", subject = "sha"): string {
  return `<!-- factory-${kind}-claim manager=${who} ${subject}=${head} until=${iso(nowMs() + mins * 60_000)} -->`;
}

type Row = Record<string, any>;

function comment(body: string, cid: number, ago = 1): Row {
  return { id: cid, body, created_at: iso(nowMs() - ago * 60_000), user: { login: "owner" } };
}

function pull(n: number, o: { head?: string; draft?: boolean; labels?: string[] } = {}): Row {
  return { number: n, title: `Task ${n}`, state: "open", draft: o.draft ?? false, head: { sha: o.head ?? HEAD, ref: `task/${n}-x` },
    labels: (o.labels ?? []).map((x) => ({ name: x })), body: "" };
}

class Repo {
  d: string;
  state: string;
  env: Record<string, string | undefined>;

  /** A project folder with the factory's hooks linked in and a fake gh in front of the real one. */
  constructor(pulls: Row[] = [], comments: Record<number, Row[]> = {}, issues: Row[] = [], cfg: Row = {}) {
    this.d = tmp();
    sh(["git", "init", "-q", "-b", "main", this.d]);
    write(join(this.d, ".claude", "factory.json"), JSON.stringify(cfg));
    symlinkSync(HOOKS, join(this.d, ".claude", "hooks"));
    symlinkSync(join(SF, "factory"), join(this.d, "factory"));
    writeExe(join(this.d, "bin", "gh"), FAKE_GH);
    this.state = join(this.d, "state.json");
    const cs: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(comments)) cs[k] = v;
    writeFileSync(this.state, JSON.stringify({ pulls, issues, next_id: 1000, comments: cs }));
    this.env = { ...process.env, PATH: `${this.d}/bin:${process.env.PATH}`, FAKE_GH_STATE: this.state };
    for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"]) delete this.env[k];
  }

  run(...args: string[]): [number, string, string] {
    const p = sh([process.execPath, "--no-env-file", join(HOOKS, "factory_manager_claims.ts"), ...args], { cwd: this.d, env: this.env });
    return [p.code, p.stdout.trim(), p.stderr.trim()];
  }

  async runAsync(...args: string[]): Promise<[number, string, string]> {
    const p = Bun.spawn([process.execPath, "--no-env-file", join(HOOKS, "factory_manager_claims.ts"), ...args],
      { cwd: this.d, env: this.env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return [await p.exited, out.trim(), err.trim()];
  }

  factory(...args: string[]): Proc {
    return sh(["bash", join(this.d, "factory"), ...args], { cwd: this.d, env: this.env });
  }

  data(): Row {
    return JSON.parse(readFileSync(this.state, "utf8")) as Row;
  }

  edit(fn: (s: Row) => void): void {
    const s = this.data();
    fn(s);
    writeFileSync(this.state, JSON.stringify(s));
  }

  comments(n: number): Row[] {
    return this.data().comments[String(n)] ?? [];
  }

  labels(n: number): Set<string> {
    const p = (this.data().pulls as Row[]).find((x) => x.number === n) as Row;
    return new Set((p.labels as Row[]).map((x) => x.name as string));
  }

  writes(): string[] {
    return ((this.data().log ?? []) as string[]).filter((l) => l.startsWith("api -X POST") || l.startsWith("api -X DELETE")
      || l.startsWith("api -X PUT"));
  }
}

function untilOf(body: string): number {
  return Date.parse((body.split("until=")[1] as string).split(/\s/)[0] as string);
}

// ------------------------------------------------------------------------------------------------ review claims

test("a free pr is claimed with a lease and the hold goes on", () => {
  const r = new Repo([pull(5)]);
  const [rc, out, err] = r.run("review", "5", "--manager", "dm-1");
  expect(rc, out + err).toBe(0);
  expect(out).toContain("claimed");
  const cs = r.comments(5);
  expect(cs.length).toBe(1);
  expect(cs[0]?.body).toContain(`factory-review-claim manager=dm-1 sha=${HEAD} until=`);
  const mins = (untilOf(cs[0]?.body) - Date.now()) / 60_000;
  expect(mins >= 19 && mins <= 21, String(mins)).toBe(true); // manager.claimMinutes defaults to 20
  expect(r.labels(5).has("factory-hold")).toBe(true);
});

test("claim minutes comes from the manager setting", () => {
  const r = new Repo([pull(5)], {}, [], { manager: { claimMinutes: 7 } });
  expect(r.run("review", "5", "--manager", "dm-1")[0]).toBe(0);
  const mins = (untilOf(r.comments(5)[0]?.body) - Date.now()) / 60_000;
  expect(mins >= 6 && mins <= 8, String(mins)).toBe(true);
});

test("factory settings know the claim minutes", () => {
  const r = new Repo([pull(5)], { 5: [comment(claimText("dm-1", HEAD, 15), 1)] }, [], { reviewMarkers: "tmp/reviews" });
  const s = r.factory("settings", "show", "manager.claimMinutes");
  expect(s.code, s.out).toBe(0);
  expect(s.stdout).toContain("20");
});

test("an unexpired claim by another manager is respected and nothing is posted", () => {
  const r = new Repo([pull(5, { labels: ["factory-hold"] })], { 5: [comment(claimText("dm-1", HEAD, 15), 1)] });
  const [rc, out] = r.run("review", "5", "--manager", "dm-2");
  expect(rc, out).toBe(3);
  expect(out).toContain("held by dm-1");
  expect(r.writes()).toEqual([]);
  expect(r.comments(5).length).toBe(1);
});

test("two claims racing the earliest wins and the loser does nothing more", () => {
  const r = new Repo([pull(5)]);
  // dm-1's claim lands between dm-2's look and dm-2's own post: dm-2 re-reads, sees dm-1 first and stands down
  r.edit((s) => { s.race = { "5": [claimText("dm-1", HEAD, 20)] }; });
  let [rc, out] = r.run("review", "5", "--manager", "dm-2");
  expect(rc, out).toBe(3);
  expect(out).toContain("lost the claim to dm-1");
  expect(r.labels(5).has("factory-hold"), "the loser must not put the hold on").toBe(false);
  const bodies = r.comments(5).map((c) => c.body as string);
  expect(bodies.length).toBe(2);
  expect(bodies[0]).toContain("manager=dm-1");
  expect(bodies[1]).toContain("manager=dm-2");
  expect(r.writes().filter((w) => w.includes("labels"))).toEqual([]);
  // and the winner, when it carries on, is still the winner
  [rc, out] = r.run("review", "5", "--manager", "dm-1");
  expect(rc, out).toBe(0);
  expect(out).toContain("already claimed");
  expect(r.labels(5).has("factory-hold")).toBe(true);
  expect(r.comments(5).length, "the winner does not post a second claim").toBe(2);
});

test("an expired claim can be claimed again", () => {
  const old = claimText("dm-1", HEAD, -5); // ran out five minutes ago
  const r = new Repo([pull(5)], { 5: [comment(old, 1, 30)] });
  const [rc, out] = r.run("review", "5", "--manager", "dm-2");
  expect(rc, out).toBe(0);
  expect(out).toContain("claimed");
  expect(r.comments(5).at(-1)?.body).toContain("manager=dm-2");
  expect(r.labels(5).has("factory-hold")).toBe(true);
});

test("a claim cannot hold a pr for longer than the lease cap", () => {
  const far = `<!-- factory-review-claim manager=dm-1 sha=${HEAD} until=2999-01-01T00:00:00Z -->`;
  const r = new Repo([pull(5)], { 5: [comment(far, 1, 180)] }); // posted three hours ago: capped at two hours, so expired
  const [rc, out] = r.run("review", "5", "--manager", "dm-2");
  expect(rc, out).toBe(0);
  const fresh = new Repo([pull(5)], { 5: [comment(far, 1, 1)] }); // posted a minute ago: holds for the capped time
  expect(fresh.run("review", "5", "--manager", "dm-2")[0]).toBe(3);
});

test("a new head commit makes the old claim mean nothing", () => {
  const r = new Repo([pull(5, { head: NEWHEAD })], { 5: [comment(claimText("dm-1", HEAD, 15), 1)] });
  const [rc, out] = r.run("review", "5", "--manager", "dm-2");
  expect(rc, out).toBe(0);
  expect(r.comments(5).at(-1)?.body).toContain(`sha=${NEWHEAD}`);
});

test("a head that already has a review marker is not claimed", () => {
  for (const marker of ["factory-approved", "factory-mustfix", "pr-watch"]) {
    const r = new Repo([pull(5)], { 5: [comment(`<!-- ${marker} sha=${HEAD.slice(0, 7)} -->`, 1)] });
    const [rc, out] = r.run("review", "5", "--manager", "dm-1");
    expect(rc, `${marker} ${out}`).toBe(4);
    expect(r.writes()).toEqual([]);
  }
  const older = new Repo([pull(5, { head: NEWHEAD })], { 5: [comment(`<!-- factory-approved sha=${HEAD.slice(0, 7)} -->`, 1)] });
  expect(older.run("review", "5", "--manager", "dm-1")[0]).toBe(0); // a marker for an older head does not count
});

test("release takes the hold off and frees the pr", () => {
  const r = new Repo([pull(5)]);
  r.run("review", "5", "--manager", "dm-1");
  expect(r.run("release", "5", "--manager", "dm-2")[0]).toBe(3); // not dm-2's to release
  expect(r.labels(5).has("factory-hold")).toBe(true);
  const [rc, out] = r.run("release", "5", "--manager", "dm-1");
  expect(rc, out).toBe(0);
  expect(r.labels(5).has("factory-hold")).toBe(false);
  expect(r.run("review", "5", "--manager", "dm-2")[0]).toBe(0); // free again, before the lease ran out
});

test("manager names are required and checked", () => {
  const r = new Repo([pull(5)]);
  const [rc, , err] = r.run("review", "5");
  expect(rc).not.toBe(0);
  expect(err).toContain("--manager");
  expect(r.run("review", "5", "--manager", "Bad Name")[0]).not.toBe(0);
  expect(r.writes()).toEqual([]);
});

// ------------------------------------------------------------------------------------------------ stale holds

test("a stale hold is taken off but a running lease and a hand placed hold are left", () => {
  const stale = claimText("dm-1", HEAD, -10);
  const live = claimText("dm-2", HEAD, 10);
  const r = new Repo([pull(1, { labels: ["factory-hold"] }), pull(2, { labels: ["factory-hold"] }), pull(3, { labels: ["factory-hold"] }), pull(4)],
    { 1: [comment(stale, 1, 40)], 2: [comment(live, 2)], 3: [] });
  const [rc, out] = r.run("sweep");
  expect(rc).toBe(0);
  expect(out).toContain("#1");
  expect(out).not.toContain("#2");
  expect(out).not.toContain("#3");
  expect(r.labels(1).has("factory-hold")).toBe(false);
  expect(r.labels(2).has("factory-hold"), "a lease is still running").toBe(true);
  expect(r.labels(3).has("factory-hold"), "no claim was ever made: the owner's own hold").toBe(true);
});

test("a hold whose manager died after a marker is also cleared", () => {
  // approved, then the manager died before taking the hold off: nobody could merge it
  const r = new Repo([pull(1, { labels: ["factory-hold"] })],
    { 1: [comment(claimText("dm-1", HEAD, -10), 1, 40), comment(`<!-- factory-approved sha=${HEAD.slice(0, 7)} -->`, 2, 35)] });
  expect(r.run("sweep")[1]).toContain("#1");
  expect(r.labels(1).has("factory-hold")).toBe(false);
});

test("a manager whose lease ran out can claim again after the sweep", () => {
  const r = new Repo([pull(1, { labels: ["factory-hold"] })], { 1: [comment(claimText("dm-1", HEAD, -10), 1, 40)] });
  const [rc, out] = r.run("next", "--manager", "dm-2");
  expect(rc, out).toBe(0);
  expect(out).toContain("swept: PR #1");
  expect(out).toContain("review: PR #1");
  expect(r.labels(1).has("factory-hold")).toBe(true);
  expect(r.comments(1).at(-1)?.body).toContain("manager=dm-2");
});

// ------------------------------------------------------------------------------------------------ questions

test("a question claim two managers earliest wins", () => {
  const q = comment("<!-- factory-question -->\nWhich database?", 10);
  const r = new Repo([pull(5)], { 5: [q] });
  r.edit((s) => { s.race = { "5": [claimText("dm-1", 10, 20, "answer", "question")] }; });
  let [rc, out] = r.run("answer", "10", "--manager", "dm-2");
  expect(rc, out).toBe(3);
  expect(out).toContain("lost the claim to dm-1");
  [rc, out] = r.run("answer", "10", "--manager", "dm-1");
  expect(rc, out).toBe(0);
  expect(r.run("answer", "10", "--manager", "dm-3")[0]).toBe(3);
});

test("an expired question claim can be taken over and an answer ends it", () => {
  const q = comment("<!-- factory-question -->\nWhich database?", 10, 60);
  const old = comment(claimText("dm-1", 10, -5, "answer", "question"), 11, 30);
  const r = new Repo([pull(5)], { 5: [q, old] });
  expect(r.run("answer", "10", "--manager", "dm-2")[0]).toBe(0);
  r.edit((s) => { s.comments["5"].push(comment("<!-- factory-answer -->\nPostgres.", 99)); });
  const [rc, out] = r.run("answer", "10", "--manager", "dm-3");
  expect(rc, out).toBe(4);
  expect(out).toContain("already answered");
  expect(r.run("list")[1].split("comment 10").length - 1, "an answered question is not listed").toBe(0);
});

test("questions on issues and draft prs are found and listed", () => {
  const issues = [{ number: 30, title: "A task", state: "open", labels: [], comments: 1 }];
  const r = new Repo([pull(5, { draft: true })], { 5: [comment("<!-- factory-question -->\nA?", 10)],
    30: [comment("<!-- factory-question -->\nB?", 20)] }, issues);
  const [rc, out] = r.run("list", "--json");
  expect(rc).toBe(0);
  const s = JSON.parse(out) as Row;
  expect((s.questions as Row[]).map((q) => q.id as number).sort((a, b) => a - b)).toEqual([10, 20]);
  expect(s.prs[0].state).toBe("draft");
});

// ------------------------------------------------------------------------------------------------ two managers

test("two managers over one pr list review every pr exactly once", async () => {
  const prs = [1, 2, 3, 4, 5, 6].map((n) => pull(n, { head: n < 10 ? n.toString(16).repeat(40) : "c".repeat(40) }));
  const r = new Repo(prs);
  r.edit((s) => { s.issues = []; });
  const won: Record<string, number[]> = { "dm-1": [], "dm-2": [] };
  await Promise.all(Object.keys(won).map(async (who) => {
    const [rc, out, err] = await r.runAsync("next", "--manager", who, "--max", "6", "--json");
    expect(rc, err).toBe(0);
    won[who] = ((JSON.parse(out) as Row).reviews as Row[]).map((x) => x.number as number);
  }));
  const both = [...(won["dm-1"] as number[]), ...(won["dm-2"] as number[])].sort((a, b) => a - b);
  expect(both, JSON.stringify(won)).toEqual([1, 2, 3, 4, 5, 6]); // each PR won once, none twice, none dropped
  // the "review" itself: each winner posts its marker and lets go; a second pass finds nothing left
  for (const [who, numbers] of Object.entries(won)) {
    for (const n of numbers) {
      r.edit((s) => {
        s.comments[String(n)].push({ id: 5000 + n, body: `<!-- pr-watch sha=${(s.pulls[n - 1].head.sha as string).slice(0, 7)} -->`,
          created_at: iso(nowMs()), user: { login: "owner" } });
      });
      expect(r.run("release", String(n), "--manager", who)[0]).toBe(0);
    }
  }
  for (const who of Object.keys(won)) expect(r.run("next", "--manager", who)[1]).toContain("nothing to claim");
  for (let n = 1; n <= 6; n++) {
    const claims = r.comments(n).filter((c) => (c.body as string).includes("factory-review-claim"));
    expect(claims.filter((c) => (c.body as string).includes("dm-")).length >= 1).toBe(true);
    expect(r.labels(n).has("factory-hold")).toBe(false);
  }
});

test("alternating managers split the list without overlap", () => {
  const r = new Repo([1, 2, 3, 4, 5].map((n) => pull(n, { head: String(n).repeat(40) })));
  const reviews = (who: string): Row[] => (JSON.parse(r.run("next", "--manager", who, "--max", "2", "--json")[1]) as Row).reviews as Row[];
  const a = reviews("dm-1");
  const b = reviews("dm-2");
  const c = reviews("dm-1");
  const nums = [...a, ...b, ...c].map((x) => x.number as number).sort((x, y) => x - y);
  expect([a.length, b.length, c.length]).toEqual([2, 2, 1]);
  expect(nums).toEqual([1, 2, 3, 4, 5]);
});

test("drafts are not reviewed and list shows every claim", () => {
  const r = new Repo([pull(1, { draft: true }), pull(2), pull(3)], { 3: [comment(claimText("dm-9", HEAD, 12), 1)] });
  const out = JSON.parse(r.run("next", "--manager", "dm-1", "--json")[1]) as Row;
  expect((out.reviews as Row[]).map((x) => x.number)).toEqual([2]);
  const text = r.run("list")[1];
  for (const w of ["claimed by dm-9", "claimed by dm-1", "draft"]) expect(text).toContain(w);
});

// ------------------------------------------------------------------------------------------------ merge

function approvedComment(head = HEAD): Row {
  return comment(`<!-- factory-approved sha=${head.slice(0, 7)} -->`, 3);
}

test("merge carries the head sha and only an approved head is merged", () => {
  const r = new Repo([pull(5)], { 5: [approvedComment()] });
  let [rc, out, err] = r.run("merge", "5", "--manager", "dm-1");
  expect(rc, out + err).toBe(0);
  expect(out).toContain("merged");
  expect(r.writes().some((w) => w.includes("pulls/5/merge"))).toBe(true);
  expect((r.data().pulls as Row[])[0]?.state).toBe("closed");
  const unapproved = new Repo([pull(5)], { 5: [] });
  [rc, out, err] = unapproved.run("merge", "5", "--manager", "dm-1");
  expect(rc).toBe(1);
  expect(err).toContain("no factory-approved");
  expect(unapproved.writes().some((w) => w.includes("merge"))).toBe(false);
  const stale = new Repo([pull(5, { head: NEWHEAD })], { 5: [approvedComment(HEAD)] });
  expect(stale.run("merge", "5", "--manager", "dm-1")[0]).toBe(1);
});

test("a merge already done by another manager is not an error", () => {
  const r = new Repo([pull(5)], { 5: [approvedComment()] });
  expect(r.run("merge", "5", "--manager", "dm-1")[0]).toBe(0);
  const [rc, out] = r.run("merge", "5", "--manager", "dm-2");
  expect(rc, out).toBe(0);
  expect(out).toContain("someone else");
});

test("a merge refused because the head moved is reported and nothing merged", () => {
  const r = new Repo([pull(5)], { 5: [approvedComment()] });
  // the head moves after the manager looked: GitHub refuses the sha-pinned merge with a 409
  const ghPath = join(r.d, "bin", "gh");
  const gh = readFileSync(ghPath, "utf8");
  const marker = 'if (parts[0] === "pulls" && parts[parts.length - 1] === "merge" && method === "PUT") {\n';
  expect(gh).toContain(marker);
  writeFileSync(ghPath, gh.replace(marker, marker + `  const p0 = issueView(parts[1]); p0.head.sha = "${NEWHEAD}";\n  body.sha = "${HEAD}";\n`));
  const [rc, out, err] = r.run("merge", "5", "--manager", "dm-2");
  expect(rc, out + err).toBe(0);
  expect(out).toContain("head moved");
  expect(out).toContain("needs a new review");
  expect((r.data().pulls as Row[])[0]?.state).toBe("open");
});

// ------------------------------------------------------------------------------------------------ owner queue

test("an owner ask is posted once by its id", () => {
  const r = new Repo([]);
  let [rc, out] = r.run("ask", "--id", "pick-a-name", "--text", "Choose the product name. I recommend Remanual.");
  expect(rc, out).toBe(0);
  expect(out).toContain("posted");
  const issue = (r.data().issues as Row[])[0] as Row;
  expect(issue.title).toBe("Dev manager: needs the owner");
  const cs = r.comments(issue.number);
  expect(cs.length).toBe(1);
  expect((cs[0]?.body as string).startsWith("<!-- factory-owner-ask id=pick-a-name -->")).toBe(true);
  expect(cs[0]?.body).toContain("needs your yes");
  [rc, out] = r.run("ask", "--id", "pick-a-name", "--text", "same again");
  expect(rc).toBe(0);
  expect(out).toContain("already");
  expect(r.comments(issue.number).length).toBe(1);
  r.run("ask", "--id", "other", "--text", "something else");
  expect(r.comments(issue.number).length).toBe(2);
});

test("two managers posting the same ask at once leave one comment", () => {
  const r = new Repo([], {}, [{ number: 40, title: "Dev manager: needs the owner", state: "open", labels: [], comments: 0 }]);
  r.edit((s) => { s.race = { "40": ["<!-- factory-owner-ask id=dup -->\nThis needs your yes: first"] }; });
  const [rc, out] = r.run("ask", "--id", "dup", "--text", "second");
  expect(rc, out).toBe(0);
  expect(out).toContain("another manager posted it first");
  const bodies = r.comments(40).map((c) => c.body as string);
  expect(bodies.length).toBe(1);
  expect(bodies[0]).toContain("first");
});

// ------------------------------------------------------------------------------------------------ wiring

test("factory command help and status know the claims", () => {
  // (`factory settings show manager.claimMinutes` stays in test_manager_claims.py until factory_settings is ported.)
  const r = new Repo([pull(5)], { 5: [comment(claimText("dm-1", HEAD, 15), 1)] }, [], { reviewMarkers: "tmp/reviews" });
  const h = r.factory("help");
  expect(h.stdout).toContain("manager-claims");
  const p = r.factory("manager-claims", "list");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("claimed by dm-1");
  const st = r.factory("status");
  expect(st.stdout, st.out).toContain("claimed by dm-1");
  const js = JSON.parse(r.factory("status", "--json").stdout) as Row;
  expect(js.pulls.pulls[0].claim.manager).toBe("dm-1");
});

test("builders cannot run the claim commands or post the markers", () => {
  const settings = JSON.parse(readFileSync(join(KIT, ".claude", "settings.json"), "utf8")) as { permissions: { deny: string[] } };
  const deny = settings.permissions.deny;
  for (const cmd of ["factory manager-claims review 5", "./factory manager-claims next",
    "bun --no-env-file .claude/hooks/factory_manager_claims.ts next"]) {
    expect(deny.some((d) => fnmatch(`Bash(${cmd})`, d)), cmd).toBe(true);
  }
  for (const cmd of ["gh pr comment 7 --body '<!-- factory-review-claim x -->'", "gh pr comment 7 --body '<!-- factory-claim-release x -->'"]) {
    expect(deny.some((d) => fnmatch(`Bash(${cmd})`, d)), cmd).toBe(true);
  }
  const r = new Repo([]);
  for (const marker of ["factory-review-claim", "factory-answer-claim", "factory-claim-release", "factory-owner-ask"]) {
    const [rc, err] = runGate(r.d, { ...r.env, FACTORY_AGENT: "haile" }, `gh pr comment 7 --body '<!-- ${marker} manager=x -->'`);
    expect(rc, `${marker} ${err}`).toBe(2);
  }
});

// ------------------------------------------------------------------------------------------------ the waiting code

test("a claim is not mistaken for an answer by the waiting code", () => {
  // factory wait answer / precheck treat a later factory-answer as the end of a question; a claim must not be one
  const q = comment("<!-- factory-question -->\nWhich database?", 10);
  const r = new Repo([pull(5)], { 5: [q, comment(claimText("dm-1", 10, 20, "answer", "question"), 11)] });
  const p = r.factory("precheck");
  expect(p.code, p.out).toBe(3);
  expect(p.stdout).toContain("question waits for an answer");
});
