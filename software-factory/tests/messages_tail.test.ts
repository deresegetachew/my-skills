// `factory messages tail` and `factory follow <agent> --messages` (#414, decision 0004 point 7): watch the messages as
// they are said. Everything runs over the GitHub adapter, with a fake `gh` that reads a JSON file and can add comments
// that only show from the second listing on (so "new between reads" is testable). Tests look at the lines printed,
// the exit codes and what the fake gh was asked.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitRepo, runHook, SF, sh, tmp, write, writeExe } from "./support.ts";

type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;

// `late[n]` comments are added to issue n's comments from the second listing of them on.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
type Row = Record<string, any>;
const db: Row = JSON.parse(readFileSync(process.env.FAKE_DB as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG as string, a.join(" ") + "\n");
function fail(t: string): never { process.stderr.write(t + "\n"); process.exit(1); }
if (a[0] !== "api") fail("fake gh: only gh api");
const path = a.slice(1).filter((x) => !x.startsWith("-") && !["GET", "Accept: application/vnd.github+json"].includes(x))[0] as string;
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1); const q = u.searchParams; const page = Number(q.get("page") ?? "1");
function out(x: unknown): never { process.stdout.write(JSON.stringify(x) + "\n"); process.exit(0); }
function paged(x: unknown[]): never { out(page === 1 ? x : []); }
if (p === "issues") paged(db.items.filter((i: Row) => i.state === (q.get("state") ?? "open")));
let m = /^issues\/(\d+)$/.exec(p);
if (m) { for (const i of db.items) if (String(i.number) === m[1]) out(i); fail("gh: Not Found (HTTP 404)"); }
m = /^issues\/(\d+)\/comments$/.exec(p);
if (m) {
  const n = m[1] as string;
  let calls = 0;
  if (page === 1) {
    const f = (process.env.FAKE_LOG as string) + ".count-" + n;
    calls = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
    calls += 1;
    writeFileSync(f, String(calls));
  }
  const base = (db.comments ?? {})[n] ?? [];
  const late = calls >= 2 ? (db.late ?? {})[n] ?? [] : [];
  paged([...base, ...late]);
}
fail("fake gh: no route for " + p);
`;

function item(n: number, title = "t", { pr = false, labels = [] as string[], body = "" } = {}): Row {
  const d: Row = { number: n, title, state: "open", comments: 1, labels: labels.map((x) => ({ name: x })),
    html_url: `https://github.test/r/${n}`, body };
  if (pr) d.pull_request = { url: "x" };
  return d;
}

let cid = 100;
function comment(body: string, at: string) {
  cid += 1;
  return { id: cid, body, user: { login: "me" }, created_at: at, html_url: `https://github.test/c/${cid}` };
}

function envMsg(kw: Record<string, string>): string {
  return "<!-- factory-msg " + Object.entries({ v: "1", ...kw }).map(([k, v]) => `${k.replace(/_/g, "-")}=${v}`).join(" ") + " -->";
}

/** A comment with an envelope; `minute` is minutes past 10:00 on 2026-10-25. */
function say(id: string, kind: string, from: string, to: string, ref: string, text: string, minute: number) {
  const at = `2026-10-25T10:${String(minute).padStart(2, "0")}:00Z`;
  const state = kind === "answer" || kind === "approval" ? "completed" : kind === "status" ? "working" : "submitted";
  return comment(envMsg({ id, kind, from, to, state, ref }) + "\n" + text, at);
}

interface World { d: string; env: Env; log: string }

function world(items: Row[], comments: Record<string, unknown[]>, late: Record<string, unknown[]> = {}, config: unknown = {}): World {
  const d = tmp();
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), JSON.stringify(config));
  write(join(d, "db.json"), JSON.stringify({ items, comments, late }));
  const env: Env = { ...process.env };
  delete env.FACTORY_AGENT;
  delete env.CLAUDE_PROJECT_DIR;
  Object.assign(env, { PATH: `${d}/bin:${process.env.PATH}`, FAKE_DB: `${d}/db.json`, FAKE_LOG: `${d}/log` });
  return { d, env, log: `${d}/log` };
}

const tail = (w: World, ...args: string[]) => runHook("factory_messages", ["tail", ...args], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
const lines = (s: string) => s.split("\n").filter(Boolean);
const ghLog = (w: World) => (existsSync(w.log) ? readFileSync(w.log, "utf8") : "");
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** The standard world: an issue 7 and a PR 8, an agent card issue 9, a few messages in order. */
function basic(late: Record<string, unknown[]> = {}, config: unknown = {}): World {
  const card = envMsg({ id: "card1", kind: "status", from: "haile", to: "dev-manager", state: "working", ref: "issue#9" }) + "\nCARDTEXT";
  return world(
    [item(7, "An issue"), item(8, "A PR", { pr: true }), item(9, "Agent: haile", { labels: ["factory:agent"], body: card })],
    { 7: [say("m01", "question", "haile", "po", "issue#7", "Which colour?", 1), say("m02", "answer", "po", "haile", "issue#7", "Use blue.", 2)],
      8: [say("m03", "mustfix", "dev-manager", "taytu", "pr#8", "Fix the lint", 3)] },
    late, config);
}

// --- tail ---------------------------------------------------------------------------------------------------------------

test("tail prints the messages already said, oldest first, one per line, with kind, from -> to, ref and summary", () => {
  const w = basic();
  const p = tail(w, "--polls", "1", "--every", "0");
  expect(p.code, p.out).toBe(0);
  const out = lines(p.stdout);
  expect(out.length).toBe(3);
  expect(out[0]).toMatch(/question.*haile -> po.*issue#7.*Which colour\?/);
  expect(out[1]).toMatch(/answer.*po -> haile.*issue#7.*Use blue\./);
  expect(out[2]).toMatch(/mustfix.*dev-manager -> taytu.*pr#8.*Fix the lint/);
});

test("tail does not print agent cards", () => {
  const p = tail(basic(), "--polls", "1", "--every", "0");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Which colour?");
  expect(p.stdout).not.toContain("CARDTEXT");
  expect(p.stdout).not.toContain("card1");
});

test("tail's first read shows only the newest 10 messages", () => {
  const many = Array.from({ length: 13 }, (_, i) => say(`n${String(i + 1).padStart(2, "0")}`, "question", "haile", "po", "issue#7", `msg-${String(i + 1).padStart(2, "0")}`, i + 1));
  const w = world([item(7)], { 7: many });
  const p = tail(w, "--polls", "1", "--every", "0");
  expect(p.code, p.out).toBe(0);
  const out = lines(p.stdout);
  expect(out.length).toBe(10);
  expect(out[0]).toContain("msg-04");
  expect(out[9]).toContain("msg-13");
  expect(p.stdout).not.toContain("msg-03");
});

test("tail reads again and prints only what was said since", () => {
  const w = basic({ 7: [say("m04", "answer", "dev-manager", "haile", "issue#7", "LATE-ONE", 20)] });
  const p = tail(w, "--polls", "3", "--every", "0");
  expect(p.code, p.out).toBe(0);
  const out = lines(p.stdout);
  expect(out.length).toBe(4);
  expect(out[3]).toMatch(/answer.*dev-manager -> haile.*LATE-ONE/);
  for (const s of ["Which colour?", "Use blue.", "Fix the lint", "LATE-ONE"]) expect(count(p.stdout, s), s).toBe(1);
});

test("tail with --polls 1 reads once", () => {
  const w = basic({ 7: [say("m04", "answer", "dev-manager", "haile", "issue#7", "LATE-ONE", 20)] });
  const p = tail(w, "--polls", "1", "--every", "0");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Which colour?");
  expect(p.stdout).not.toContain("LATE-ONE");
});

test("tail --to keeps only the messages addressed to that agent", () => {
  const p = tail(basic(), "--to", "haile", "--polls", "1", "--every", "0");
  expect(p.code, p.out).toBe(0);
  const out = lines(p.stdout);
  expect(out.length).toBe(1);
  expect(out[0]).toContain("Use blue.");
});

test("tail --ref reads only that item and never lists the open issues", () => {
  const w = basic();
  const p = tail(w, "--ref", "8", "--polls", "1", "--every", "0");
  expect(p.code, p.out).toBe(0);
  const out = lines(p.stdout);
  expect(out.length).toBe(1);
  expect(out[0]).toContain("Fix the lint");
  expect(ghLog(w)).not.toMatch(/issues\?.*state=open/);
});

test("tail --json prints each message as one JSON object on its own line", () => {
  const p = tail(basic(), "--json", "--polls", "1", "--every", "0");
  expect(p.code, p.out).toBe(0);
  const objs = lines(p.stdout).map((l) => JSON.parse(l) as Row);
  expect(objs.length).toBe(3);
  expect(objs[0]).toMatchObject({ id: "m01", kind: "question", from: "haile", to: "po", ref: "issue#7" });
  expect(String(objs[0]?.summary)).toContain("Which colour?");
  expect(objs[2]).toMatchObject({ id: "m03", kind: "mustfix", from: "dev-manager", to: "taytu", ref: "pr#8" });
});

test("tail never lets a control character from a summary reach the terminal", () => {
  const w = world([item(7)], { 7: [say("m01", "question", "haile", "po", "issue#7", "\x1b[31mred\x07 alert", 1)] });
  const p = tail(w, "--polls", "1", "--every", "0");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("red");
  expect(p.stdout).not.toContain("\x1b");
  expect(p.stdout).not.toContain("\x07");
});

test("tail says once on stderr that Ctrl-C stops it", () => {
  const p = tail(basic(), "--polls", "3", "--every", "0");
  expect(p.code, p.out).toBe(0);
  expect(count(p.stderr, "Ctrl-C stops")).toBe(1);
  expect(p.stdout).not.toContain("Ctrl-C");
});

test("tail refuses an --every that is negative or not a number, without calling gh", () => {
  for (const bad of ["-1", "x"]) {
    const w = basic();
    const p = tail(w, "--every", bad, "--polls", "1");
    expect(p.code, bad).not.toBe(0);
    const e = JSON.parse(lines(p.stderr).at(-1) as string) as { code: string; message: string; fix: string };
    expect(e.code).toBe("bad-every");
    expect(e.message.length).toBeGreaterThan(0);
    expect(e.fix.length).toBeGreaterThan(0);
    expect(ghLog(w), bad).toBe("");
  }
});

test("tail with transport nats goes on with GitHub and says plugin-missing once", () => {
  const w = basic({}, { messaging: { transport: "nats" } });
  const p = tail(w, "--polls", "2", "--every", "0");
  expect(p.code, p.out).toBe(0);
  expect(lines(p.stdout).length).toBe(3);
  expect(count(p.stderr, "plugin-missing")).toBe(1);
});

test("factory messages tail runs through the factory script", () => {
  const w = basic();
  gitRepo(w.d);
  const p = sh(["bash", join(SF, "factory"), "messages", "tail", "--polls", "1", "--every", "0"], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  expect(lines(p.stdout).length).toBe(3);
});

test("factory help mentions tail on the messages line", () => {
  const w = basic();
  gitRepo(w.d);
  const p = sh(["bash", join(SF, "factory"), "help"], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const all = p.stdout.split("\n");
  const at = all.findIndex((l) => /^\s*messages\s/.test(l));
  expect(at).toBeGreaterThanOrEqual(0);
  expect(all.slice(at, at + 4).join("\n")).toMatch(/\btail\b/);
});

// --- factory follow <agent> --messages ----------------------------------------------------------------------------------

test("follow <agent> --messages shows the messages from or to that agent and not others", () => {
  const w = basic();
  const p = runHook("factory_follow", ["follow", "haile", "--messages", "--polls", "1"], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const out = lines(p.stdout);
  expect(out.length).toBe(2);
  expect(out[0]).toMatch(/question.*haile -> po.*issue#7.*Which colour\?/);
  expect(out[1]).toMatch(/answer.*po -> haile.*Use blue\./);
  expect(p.stdout).not.toContain("Fix the lint"); // dev-manager -> taytu
});
