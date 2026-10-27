// The factory's messages (#107): the A2A-shaped envelope, its states and transitions, old markers still read,
// `factory messages ls|new`, and the agent card. The library is imported directly; the commands run against a fake
// `gh` on PATH that reads a JSON file.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import * as fa from "../hooks/factory_agents.ts";
import * as fc from "../hooks/factory_cards.ts";
import * as fm from "../hooks/factory_messages.ts";
import type { Issue } from "../hooks/factory_issues.ts";
import { HOOKS, read, runHook, SF, sh, tmp, write, writeExe } from "./support.ts";

const FACTORY = join(SF, "factory");

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
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
if (m) paged((db.comments ?? {})[m[1] as string] ?? []);
fail("fake gh: no route for " + p);
`;

interface Item { number: number; title: string; state: string; comments: number; labels: { name: string }[];
  html_url: string; body: string; pull_request?: unknown }

function item(n: number, title = "t", { pr = false, labels = [] as string[], state = "open", comments = 1 } = {}): Item {
  const d: Item = { number: n, title, state, comments, labels: labels.map((x) => ({ name: x })),
    html_url: `https://github.test/r/${n}`, body: "" };
  if (pr) d.pull_request = { url: "x" };
  return d;
}

function comment(cid: number, body: string, login = "me", at = "2026-10-25T10:00:00Z") {
  return { id: cid, body, user: { login }, created_at: at, html_url: `https://github.test/c/${cid}` };
}

/** The envelope comment text for the attributes given (v=1 unless said). */
function envMsg(kw: Record<string, string>): string {
  const all = { v: "1", ...kw };
  return "<!-- factory-msg " + Object.entries(all).map(([k, v]) => `${k.replace(/_/g, "-")}=${v}`).join(" ") + " -->";
}

function world(items: Item[], comments: Record<string, unknown[]>, extra: Record<string, string> = {}): [string, Record<string, string | undefined>] {
  const d = tmp();
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), "{}");
  write(join(d, "db.json"), JSON.stringify({ items, comments }));
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.FACTORY_AGENT;
  Object.assign(env, { PATH: `${d}/bin:${process.env.PATH}`, FAKE_DB: `${d}/db.json`, FAKE_LOG: `${d}/log`, ...extra });
  return [d, env];
}

function run(d: string, env: Record<string, string | undefined>, ...args: string[]): [number, string, string] {
  const p = runHook("factory_messages", args, { cwd: d, env, timeoutMs: 60_000 });
  return [p.code, p.stdout.trim(), p.stderr.trim()];
}

function msgs(text: string | null, login = "me", cid = 1): fm.Message[] {
  return fm.parseComment({ id: cid, body: text, user: { login } });
}

function one(text: string, login = "me", cid = 1): fm.Message {
  const found = msgs(text, login, cid);
  expect(found.length).toBe(1);
  return found[0] as fm.Message;
}

// --- the envelope ---------------------------------------------------------------------------------------------------

test("an envelope round trips through render and parse", () => {
  const m = new fm.Message({ id: "01abc23def", kind: "question", frm: "haile", to: "po", state: "submitted", ref: "issue#103",
    inReplyTo: "01abc00000", sha: "a".repeat(40) });
  const text = fm.render(m);
  expect(text.startsWith("<!-- factory-msg v=1 id=01abc23def kind=question from=haile to=po state=submitted ")).toBe(true);
  const back = one(text + "\nWhich colour?");
  expect([back.id, back.kind, back.frm, back.to, back.state, back.ref, back.inReplyTo, back.sha]).toEqual(
    ["01abc23def", "question", "haile", "po", "submitted", "issue#103", "01abc00000", "a".repeat(40)]);
  expect(back.summary).toBe("Which colour?");
  expect(back.legacy).toBe(false);
});

test("an envelope may span lines and list its attributes in any order", () => {
  const m = one("<!-- factory-msg v=1 id=q1x kind=question\n     state=submitted from=haile to=po\n     ref=pr#7 -->\nText");
  expect([m.id, m.to, m.ref]).toEqual(["q1x", "po", "pr#7"]);
});

test("to defaults to the dev manager and a question starts submitted", () => {
  const m = one(envMsg({ id: "q1x", kind: "question", from: "haile" }));
  expect(m.to).toBe("dev-manager");
  expect(m.state).toBe("submitted");
});

test("unknown future versions and malformed envelopes are ignored not fatal", () => {
  expect(msgs(envMsg({ v: "2", id: "q1x", kind: "question", from: "haile" }))).toEqual([]);
  expect(msgs(envMsg({ id: "q1x", kind: "shout", from: "haile" }))).toEqual([]); // unknown kind
  expect(msgs(envMsg({ id: "q1x", kind: "question", state: "sleeping" }))).toEqual([]); // unknown state
  expect(msgs(envMsg({ kind: "question", from: "haile" }))).toEqual([]); // no id
  expect(msgs(envMsg({ id: "q1x", kind: "question", to: "Bad Name" }))).toEqual([]); // not an agent name
  expect(msgs("<!-- factory-msg v=1 id=q1x kind=question ")).toEqual([]); // never closed
  expect(msgs("")).toEqual([]);
  expect(msgs(null)).toEqual([]);
});

test("a future version with a legacy marker line still counts as the legacy message", () => {
  const m = one(envMsg({ v: "2", id: "q1x", kind: "question" }) + "\n<!-- factory-question -->\nWhich?");
  expect(m.legacy).toBe(true);
  expect(m.kind).toBe("question");
});

test("the old markers parse as messages", () => {
  const q = one("<!-- factory-question -->\nWhich one?", "me", 41);
  expect([q.kind, q.state, q.to, q.legacy, q.id]).toEqual(["question", "submitted", "dev-manager", true, "c41"]);
  const a = one("<!-- factory-answer -->\nThis one.", "me", 42);
  expect([a.kind, a.state, a.frm, a.legacy]).toEqual(["answer", "completed", "dev-manager", true]);
  const f = one("<!-- factory-answer -->\nneeds-owner: the name is theirs", "me", 43);
  expect(f.state).toBe("failed");
  const mf = one("<!-- factory-mustfix sha=abc1234 -->\nFix x", "me", 44);
  expect([mf.kind, mf.sha]).toEqual(["mustfix", "abc1234"]);
  const ok = one("<!-- factory-approved sha=abc1234 -->", "me", 45);
  expect([ok.kind, ok.sha, ok.state]).toEqual(["approval", "abc1234", "completed"]);
});

test("an envelope wins over the legacy line in the same comment", () => {
  const found = msgs(envMsg({ id: "a1x", kind: "answer", from: "po", to: "haile", state: "completed", in_reply_to: "q1x" }) +
    "\n<!-- factory-answer -->\nUse blue.");
  expect(found.length).toBe(1);
  expect(found[0]?.legacy).toBe(false);
  expect(found[0]?.frm).toBe("po");
});

test("verdicts read both forms", () => {
  expect(fm.verdicts("<!-- factory-mustfix sha=abc1234 -->")).toEqual([["mustfix", "abc1234"]]);
  expect(fm.verdicts("<!-- factory-approved sha=abc1234 -->")).toEqual([["approved", "abc1234"]]);
  const both = envMsg({ id: "m1x", kind: "mustfix", from: "dev-manager", sha: "abc1234" }) + "\n<!-- factory-mustfix sha=abc1234 -->";
  expect(fm.verdicts(both)).toEqual([["mustfix", "abc1234"]]); // not counted twice
  expect(fm.verdicts(envMsg({ id: "p1x", kind: "approval", from: "dev-manager", sha: "def5678" }))).toEqual([["approved", "def5678"]]);
  expect(fm.verdicts("<!-- factory-mustfix -->")).toEqual([["mustfix", null]]);
  expect(fm.verdicts("nothing")).toEqual([]);
});

test("new ids are short unique and valid", () => {
  const ids = new Set(Array.from({ length: 200 }, () => fm.newId()));
  expect(ids.size).toBe(200);
  for (const i of ids) {
    expect(i.length >= 8 && i.length <= 16).toBe(true);
    expect(fm.ID.test(i)).toBe(true);
  }
});

// --- states and transitions -----------------------------------------------------------------------------------------

function q(id = "q1x", frm = "haile", to = "po", kw: Partial<fm.Message> = {}): fm.Message {
  return new fm.Message({ id, kind: "question", frm, to, state: "submitted", ...kw });
}

function reply(id: string, kind: string, state: string, frm: string, to: string, of = "q1x", kw: Partial<fm.Message> = {}): fm.Message {
  return new fm.Message({ id, kind, frm, to, state, inReplyTo: of, ...kw });
}

function state(thread: fm.Thread, id = "q1x"): string {
  return (thread.tasks.get(id) as fm.Task).state;
}

test("the state names are a2a task states", () => {
  expect([...fm.STATES]).toEqual(["submitted", "working", "input-required", "completed", "failed", "canceled"]);
  expect([...fm.OPEN]).toEqual(["submitted", "working", "input-required"]);
  expect(fm.TRANSITIONS.completed?.length).toBe(0);
  expect(fm.TRANSITIONS.failed?.length).toBe(0);
});

test("submitted to working to completed", () => {
  const t = fm.fold([q(), reply("s1x", "status", "working", "po", "haile"), reply("a1x", "answer", "completed", "po", "haile")]);
  expect(state(t)).toBe("completed");
  expect(t.rejected).toEqual([]);
  expect(t.tasks.get("q1x")?.answer?.id).toBe("a1x");
  expect(t.tasks.get("q1x")?.history.map((h) => h[0])).toEqual(["submitted", "working", "completed"]);
});

test("an answer may complete a submitted question directly", () => {
  expect(state(fm.fold([q(), reply("a1x", "answer", "completed", "po", "haile")]))).toBe("completed");
});

test("input required is a clarification going back and the asker resumes it", () => {
  const t = fm.fold([q(), reply("s1x", "status", "input-required", "po", "haile"),
    reply("s2x", "status", "working", "haile", "po", "s1x"), // replies to the clarification message
    reply("a1x", "answer", "completed", "po", "haile")]);
  expect(state(t)).toBe("completed");
  expect(t.rejected).toEqual([]);
});

test("failed is an answer that could not be given here", () => {
  const t = fm.fold([q(), reply("a1x", "answer", "failed", "po", "haile")]);
  expect(state(t)).toBe("failed");
  expect(t.tasks.get("q1x")?.isOpen).toBe(false);
});

test("only the asker cancels and only the addressee answers", () => {
  let t = fm.fold([q(), reply("c1x", "status", "canceled", "po", "haile")]);
  expect(state(t)).toBe("submitted");
  expect(t.rejected[0]?.[1]).toContain("asker");
  t = fm.fold([q(), reply("c1x", "status", "canceled", "haile", "po")]);
  expect(state(t)).toBe("canceled");
  t = fm.fold([q(), reply("a1x", "answer", "completed", "taytu", "haile")]); // someone else answers
  expect(state(t)).toBe("submitted");
  expect(t.rejected[0]?.[1]).toContain("addressed to po");
});

test("a trusted login may complete a question addressed to someone else", () => {
  const answer = reply("a1x", "answer", "completed", "dev-manager", "haile", "q1x", { login: "owner-login" });
  expect(state(fm.fold([q(), answer], new Set(["owner-login"])))).toBe("completed");
  expect(state(fm.fold([q(), answer], new Set(["someone-else"])))).toBe("submitted");
});

test("invalid transitions are rejected with the reason", () => {
  let t = fm.fold([q(), reply("a1x", "answer", "completed", "po", "haile"), reply("s1x", "status", "working", "po", "haile")]);
  expect(state(t)).toBe("completed");
  expect(t.rejected[0]?.[1]).toContain("completed");
  t = fm.fold([q(), reply("s1x", "status", "completed", "po", "haile")]); // completing is an answer
  expect(state(t)).toBe("submitted");
  expect(t.rejected.length).toBeGreaterThan(0);
  t = fm.fold([q(), reply("s1x", "status", "submitted", "po", "haile")]); // never back to submitted
  expect(state(t)).toBe("submitted");
  expect(t.rejected.length).toBeGreaterThan(0);
  expect(fm.canMove("submitted", "working")).toBe(true);
  expect(fm.canMove("completed", "working")).toBe(false);
  expect(fm.canMove("working", "working")).toBe(true); // a repeat is a no-op, not invalid
});

test("a reply to nothing is rejected and never creates a task", () => {
  const t = fm.fold([reply("a1x", "answer", "completed", "po", "haile", "nope")]);
  expect(t.tasks.size).toBe(0);
  expect(t.rejected[0]?.[1]).toContain("nope");
});

test("reposting a message changes nothing", () => {
  const answer = reply("a1x", "answer", "completed", "po", "haile");
  const once = fm.fold([q(), answer]);
  const twice = fm.fold([q(), answer, answer, q()]);
  expect(state(once)).toBe("completed");
  expect(state(twice)).toBe("completed");
  expect(twice.rejected).toEqual([]);
  expect(twice.duplicates.map((m) => m.id)).toEqual(["a1x", "q1x"]);
  expect(twice.tasks.get("q1x")?.history.length).toBe(once.tasks.get("q1x")?.history.length as number);
});

test("a legacy answer completes every open question to the dev manager and no other", () => {
  const legacyQ = new fm.Message({ id: "c1", kind: "question", frm: "", to: "dev-manager", state: "submitted", legacy: true });
  const toDm = q("q2x", "haile", "dev-manager");
  const toPo = q("q3x", "haile", "po");
  const legacyA = new fm.Message({ id: "c9", kind: "answer", frm: "dev-manager", to: "", state: "completed", legacy: true });
  const t = fm.fold([legacyQ, toDm, toPo, legacyA]);
  expect([state(t, "c1"), state(t, "q2x"), state(t, "q3x")]).toEqual(["completed", "completed", "submitted"]);
  const again = fm.fold([legacyA, legacyQ]); // a later question is open again
  expect(state(again, "c1")).toBe("submitted");
});

test("open filters by addressee state and ref", () => {
  const t = fm.fold([q("q1x", "haile", "po", { ref: "issue#103" }), q("q2x", "haile", "dev-manager", { ref: "pr#7" }),
    reply("s1x", "status", "input-required", "dev-manager", "haile", "q2x")]);
  expect(fm.select(t.tasks.values(), "po").map((x) => x.id)).toEqual(["q1x"]);
  expect(fm.select(t.tasks.values(), null, null, "input-required").map((x) => x.id)).toEqual(["q2x"]);
  expect(fm.select(t.tasks.values(), null, null, null, "7").map((x) => x.id)).toEqual(["q2x"]);
  expect(fm.select(t.tasks.values(), null, null, null, "pr#7").map((x) => x.id)).toEqual(["q2x"]);
  expect(fm.select(t.tasks.values()).length).toBe(2);
});

// --- what the PR gate asks of a new message -------------------------------------------------------------------------

test("a new message is checked against its thread", () => {
  const t = fm.fold([q("q1x", "haile", "taytu")]);
  const ok = reply("a1x", "answer", "completed", "taytu", "haile");
  expect(fm.checkNew(ok, t, "taytu")).toBeNull();
  expect(fm.checkNew(ok, t, "menelik")).toContain("yourself"); // from= must be the poster
  const stolen = reply("a1x", "answer", "completed", "po", "haile");
  expect(fm.checkNew(stolen, t, "taytu")).toContain("yourself");
  const other = fm.fold([q("q1x", "haile", "po")]);
  expect(fm.checkNew(reply("a1x", "answer", "completed", "taytu", "haile"), other, "taytu")).toContain("addressed to po");
  expect(fm.checkNew(new fm.Message({ id: "p1x", kind: "approval", frm: "taytu", state: "completed", sha: "abc1234" }), t, "taytu")).toContain("reserved");
  expect(fm.checkNew(new fm.Message({ id: "p1x", kind: "mustfix", frm: "taytu", state: "submitted", sha: "abc1234" }), t, "taytu")).toContain("reserved");
  expect(fm.checkNew(reply("a1x", "answer", "completed", "taytu", "haile", "zzz"), t, "taytu")).toContain("can't find");
  expect(fm.checkNew(new fm.Message({ id: "a1x", kind: "answer", frm: "taytu", state: "completed" }), t, "taytu")).toContain("in-reply-to");
  const done = fm.fold([q("q1x", "haile", "taytu"), reply("a0x", "answer", "completed", "taytu", "haile")]);
  expect(fm.checkNew(reply("a1x", "answer", "failed", "taytu", "haile"), done, "taytu")).toContain("completed");
  const asked = new fm.Message({ id: "q9x", kind: "question", frm: "taytu", to: "po", state: "submitted" });
  expect(fm.checkNew(asked, t, "taytu")).toBeNull();
  expect(fm.checkNew(new fm.Message({ id: "q9x", kind: "question", frm: "taytu", to: "po", state: "completed" }), t, "taytu")).toContain("submitted");
  const status = new fm.Message({ id: "agent-taytu", kind: "status", frm: "taytu", state: "input-required" });
  expect(fm.checkNew(status, t, "taytu")).toBeNull();
});

// --- the commands ---------------------------------------------------------------------------------------------------

function threadWorld(extra: Record<string, string> = {}) {
  const items = [item(103, "Task issue"), item(7, "A PR", { pr: true }), item(9, "Agent: haile", { labels: ["factory:agent"] }),
    item(11, "Quiet", { comments: 0 }), item(5, "Old", { state: "closed" })];
  const comments = {
    103: [comment(1, envMsg({ id: "q1x", kind: "question", from: "haile", to: "po", state: "submitted", ref: "issue#103" }) + "\nWhich colour?", "me", "2026-10-25T09:00:00Z"),
      comment(2, envMsg({ id: "q2x", kind: "question", from: "taytu", to: "po", state: "submitted" }) + "\nWhich font?"),
      comment(3, envMsg({ id: "a2x", kind: "answer", from: "po", to: "taytu", state: "completed", in_reply_to: "q2x" }) + "\nSerif.")],
    7: [comment(4, "<!-- factory-question -->\nSplit the PR?"),
      comment(5, envMsg({ id: "q4x", kind: "question", from: "menelik", to: "dev-manager" }) + "\nWhich branch?"),
      comment(6, envMsg({ id: "s4x", kind: "status", from: "dev-manager", to: "menelik", state: "input-required", in_reply_to: "q4x" }) + "\nWhich one do you mean?")],
    9: [comment(7, envMsg({ id: "q5x", kind: "question", from: "haile" }) + "\nNoise on an agent issue")],
    5: [comment(8, envMsg({ id: "q6x", kind: "question", from: "haile", to: "owner" }) + "\nOn a closed item")],
  };
  return world(items, comments, extra);
}

test("ls lists open questions across issues and prs", () => {
  const [d, env] = threadWorld();
  const [rc, out, err] = run(d, env, "ls");
  expect(rc, err).toBe(0);
  for (const w of ["q1x", "haile -> po", "issue#103", "Which colour?"]) expect(out).toContain(w);
  for (const w of ["c4", "pr#7", "Split the PR?"]) expect(out).toContain(w); // the old marker, shown as a message
  expect(out).toContain("q4x");
  expect(out).toContain("input-required");
  expect(out).not.toContain("q2x"); // answered
  expect(out).not.toContain("q5x"); // agent issues and closed items are skipped
  expect(out).not.toContain("q6x");
  expect(read(`${d}/log`)).not.toContain("issues/11/comments"); // an item with no comments costs no call
});

test("ls filters by addressee state and ref", () => {
  const [d, env] = threadWorld();
  let [rc, out] = run(d, env, "ls", "--to", "po");
  expect(rc).toBe(0);
  expect(out).toContain("q1x");
  expect(out).not.toContain("q4x");
  expect(out).not.toContain("c4");
  [, out] = run(d, env, "ls", "--state", "input-required");
  expect(out).toContain("q4x");
  expect(out).not.toContain("q1x");
  [, out] = run(d, env, "ls", "--ref", "7");
  expect(out).toContain("q4x");
  expect(out).toContain("c4");
  expect(out).not.toContain("q1x");
  [, out] = run(d, env, "ls", "--ref", "pr#7", "--to", "menelik");
  expect(out).toContain("no messages");
  [, out] = run(d, env, "ls", "--ref", "5", "--state", "submitted"); // a closed item, named directly
  expect(out).toContain("q6x");
  [, out] = run(d, env, "ls", "--state", "completed"); // terminal states are asked for by name
  expect(out).toContain("q2x");
  expect(out).not.toContain("q1x");
});

test("ls json and all", () => {
  const [d, env] = threadWorld();
  const [, out] = run(d, env, "ls", "--json", "--all");
  const rows = JSON.parse(out) as Record<string, unknown>[];
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(by.q2x?.state).toBe("completed");
  expect(by.q1x?.to).toBe("po");
  expect(by.q1x?.ref).toBe("issue#103");
  expect(by.c4?.legacy).toBe(true);
  expect(by.c4?.from).toBe("");
  expect(String(by.c4?.url).endsWith("/c/4")).toBe(true);
});

test("ls with nothing open says so and exits zero", () => {
  const [d, env] = world([item(1)], { 1: [comment(1, "just talking")] });
  const [rc, out] = run(d, env, "ls");
  expect(rc).toBe(0);
  expect(out).toContain("no messages");
});

test("ls bad arguments answer with code message fix", () => {
  const [d, env] = threadWorld();
  const [rc, , err] = run(d, env, "ls", "--state", "sleeping");
  expect(rc).toBe(1);
  const e = JSON.parse(err) as Record<string, string>;
  expect(e.code).toBe("bad-state");
  expect(e.fix).toContain("completed");
});

test("ls reads agent status with kind status", () => {
  const body = "<!-- factory-agent name=haile status=working ping=2026-10-25T10:00:00Z -->\n" +
    envMsg({ id: "agent-haile", kind: "status", from: "haile", to: "dev-manager", state: "input-required" }) + "\nx";
  const ag = item(9, "Agent: haile", { labels: ["factory:agent"] });
  ag.body = body;
  const [d, env] = world([ag], {});
  let [rc, out] = run(d, env, "ls", "--kind", "status");
  expect(rc).toBe(0);
  expect(out).toContain("agent-haile");
  expect(out).toContain("input-required");
  [rc, out] = run(d, env, "ls", "--kind", "status", "--state", "idle");
  expect(out).toContain("no messages");
});

test("new prints an envelope and the old marker", () => {
  const [d, env] = world([], {}, { FACTORY_AGENT: "haile" });
  const [rc, out, err] = run(d, env, "new", "--kind", "question", "--to", "po", "--ref", "issue#103");
  expect(rc, err).toBe(0);
  const lines = out.split("\n");
  const m = fm.parseComment({ id: 1, body: out, user: { login: "x" } });
  expect(m.length).toBe(1);
  expect([m[0]?.frm, m[0]?.to, m[0]?.state, m[0]?.ref]).toEqual(["haile", "po", "submitted", "issue#103"]);
  expect(lines[1]).toBe("<!-- factory-question -->");
  const [, out2] = run(d, env, "new", "--kind", "question", "--no-legacy");
  expect(out2.split("\n").length).toBe(1);
  expect(out2).not.toContain("factory-question");
  expect(out2).toContain("to=dev-manager");
  const [, out3] = run(d, env, "new", "--kind", "answer", "--in-reply-to", "q1x", "--to", "haile");
  expect(out3.split("\n")[0]).toContain("state=completed");
  expect(out3).toContain("in-reply-to=q1x");
  expect(out3.split("\n")[1]).toBe("<!-- factory-answer -->");
  const [, out4] = run(d, env, "new", "--kind", "answer", "--in-reply-to", "q1x", "--to", "haile", "--state", "failed");
  expect(out4).toContain("state=failed");
});

test("new refuses bad input with code message fix", () => {
  const [d, env] = world([], {}, { FACTORY_AGENT: "haile" });
  const cases: [string[], string][] = [[["--kind", "shout"], "bad-kind"], [["--kind", "answer"], "needs-in-reply-to"],
    [["--kind", "question", "--to", "Bad Name"], "bad-name"], [["--kind", "question", "--state", "completed"], "bad-state"],
    [["--kind", "mustfix"], "needs-sha"]];
  for (const [args, code] of cases) {
    const [rc, , err] = run(d, env, "new", ...args);
    expect(rc, args.join(" ")).toBe(1);
    const e = JSON.parse(err) as Record<string, string>;
    expect(e.code).toBe(code);
    expect(e.message && e.fix).toBeTruthy();
  }
  const env2 = { ...env };
  delete env2.FACTORY_AGENT;
  const [rc, , err] = run(d, env2, "new", "--kind", "question");
  expect(rc).toBe(1);
  expect((JSON.parse(err) as Record<string, string>).code).toBe("needs-from");
});

test("the factory command runs messages", () => {
  const [d, env] = threadWorld();
  sh(["git", "init", "-q", d]);
  symlinkSync(HOOKS, `${d}/.claude/hooks`);
  let p = sh(["bash", FACTORY, "messages", "ls", "--to", "po"], { cwd: d, env });
  expect(p.code, p.stderr).toBe(0);
  expect(p.stdout).toContain("q1x");
  p = sh(["bash", FACTORY, "help"], { cwd: d, env });
  expect(p.stdout).toContain("messages");
});

// --- agent status and cards ------------------------------------------------------------------------------------------

test("agent status uses the message states and the issue carries an envelope", () => {
  let [title, body] = fa.render("haile", "input-required", "", "2026-10-25T09:00:00Z", null, null, "m1");
  expect(title).toBe("Agent: haile · input-required");
  const f = fa.fields({ body });
  expect([f.name, f.status]).toEqual(["haile", "input-required"]); // the old marker still reads
  const m = fm.parseComment({ id: 1, body, user: { login: "x" } });
  expect(m.length).toBe(1);
  expect([m[0]?.kind, m[0]?.frm, m[0]?.state, m[0]?.id]).toEqual(["status", "haile", "input-required", "agent-haile"]);
  [title, body] = fa.render("haile", "idle", "", "2026-10-25T09:00:00Z");
  expect(fm.parseComment({ id: 1, body })[0]?.state).toBe("idle");
});

test("status vocabulary is the task one plus idle and down", () => {
  expect(new Set(fm.AGENT_STATES)).toEqual(new Set(["working", "idle", "down", "input-required"]));
});

test("a card has the fields an agent would publish", () => {
  const c = fc.card("haile", "working", "m1", "1.2.3");
  expect(c).toEqual({ name: "haile", kind: "coding-agent", skills: ["build-tasks"], state: "working", location: "machine",
    machine: "m1", follow: "remote-control:haile", version: "1.2.3", lastPing: null });
  const dm = fc.card("dev-manager", "idle");
  expect([dm.kind, dm.location, dm.follow]).toEqual(["dev-manager", "cloud", null]);
  expect(dm.skills).toContain("answer-process-questions");
  const po = fc.card("po", "working");
  expect(po.kind).toBe("po");
  expect(po.skills).toContain("answer-product-questions");
});

test("agents list renders from the cards", () => {
  const [title, body] = fa.render("haile", "working", "working on #3", "2026-10-25T09:00:00Z", null, null, "m1");
  const issue = { number: 5, title, body, state: "open", labels: [] } as Issue;
  const cards = fc.cards({}, [issue], "9.9.9");
  expect(cards.map((c) => c.name)).toEqual(["haile"]);
  expect(["working", "silent"]).toContain(cards[0]?.state as string);
  expect([cards[0]?.version, cards[0]?.location, cards[0]?.machine]).toEqual(["9.9.9", "machine", "m1"]);
  const line = fc.row(cards[0] as fc.Card);
  expect(line.startsWith("haile")).toBe(true);
  expect(line).toContain(`last ping ${cards[0]?.lastPing}`);
  expect(line).toContain("machine m1");
});
