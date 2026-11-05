// Talking to the dev manager and the product owner in the cockpit (#395): the chat pane on Ink (cockpit/views/chat.tsx,
// drawn with ink-testing-library through cockpit/testing.tsx), and `factory cockpit --chat-send`, which answers one
// turn in a fresh role session (a fake `claude`) and posts a summary on the owner queue (a fake `gh`).
import { expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatProps, type ChatReply, drawChat, type Turn } from "../cockpit/testing.tsx";
import { project } from "./roles_support.ts";
import { type Proc, SF, sh, writeExe } from "./support.ts";

type Env = Record<string, string | undefined>;

// --- the pane --------------------------------------------------------------------------------------------------------

function pane(send: ChatProps["send"], role: ChatProps["role"] = "dev-manager") {
  return drawChat({ repo: "work", role, name: "fasil", cols: 100, rows: 30, color: false, send });
}

function later<T>(): { promise: Promise<T>; done: (v: T) => void } {
  let done: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    done = r;
  });
  return { promise, done };
}

test("the pane names the role it talks to and its keys", () => {
  const v = pane(async () => ({ answer: "", summary: "" }));
  expect(v.frame()).toContain("Talk to the dev manager");
  expect(v.frame()).toContain("Enter send");
  expect(v.frame()).toContain("Esc close");
  v.unmount();
  const po = pane(async () => ({ answer: "", summary: "" }), "product-owner");
  expect(po.frame()).toContain("Talk to the product owner");
  po.unmount();
});

test("typed text shows on the input line, and backspace takes the last character back", async () => {
  const v = pane(async () => ({ answer: "", summary: "" }));
  await v.press("hellox");
  expect(v.frame()).toContain("› hellox");
  await v.press("\x7f");
  expect(v.frame()).toContain("› hello");
  expect(v.frame()).not.toContain("hellox");
  v.unmount();
});

test("Enter on an empty line sends nothing", async () => {
  const sent: string[] = [];
  const v = pane(async (text) => {
    sent.push(text);
    return { answer: "x", summary: "" };
  });
  await v.press("\r");
  expect(sent).toEqual([]);
  v.unmount();
});

test("Enter sends the line, shows that the role is answering, then the answer and where the summary went", async () => {
  const calls: [string, Turn[]][] = [];
  const reply = later<ChatReply>();
  const v = pane((text, history) => {
    calls.push([text, history]);
    return reply.promise;
  });
  await v.press("what is waiting?");
  await v.press("\r");
  expect(calls).toEqual([["what is waiting?", []]]);
  expect(v.frame()).toContain("you: what is waiting?");
  expect(v.frame()).toContain("fasil is answering");
  await v.press("\r"); // a second Enter while it answers sends nothing
  expect(calls.length).toBe(1);
  reply.done({ answer: "Two PRs wait for review.\nI merged #12.", summary: "A summary is on the owner queue, #9." });
  await v.settle();
  const f = v.frame();
  expect(f).toContain("fasil:");
  expect(f).toContain("Two PRs wait for review.");
  expect(f).toContain("I merged #12.");
  expect(f).toContain("A summary is on the owner queue, #9.");
  expect(f).not.toContain("fasil is answering");
  expect(f).toMatch(/› *$/m);
  v.unmount();
});

test("the next line goes with the conversation so far", async () => {
  const calls: [string, Turn[]][] = [];
  const v = pane(async (text, history) => {
    calls.push([text, history]);
    return { answer: "Two PRs wait for review.\nI merged #12.", summary: "" };
  });
  await v.press("what is waiting?");
  await v.press("\r");
  await v.settle();
  await v.press("merge the first");
  await v.press("\r");
  await v.settle();
  expect(calls[1]).toEqual(["merge the first", [{ who: "owner", text: "what is waiting?" },
    { who: "role", text: "Two PRs wait for review.\nI merged #12." }]]);
  v.unmount();
});

test("a refusal shows its message and fix", async () => {
  const v = pane(async () => ({ problem: { code: "chat_failed", message: "The dev manager's session failed.", fix: "Run `factory doctor`." } }));
  await v.press("hi");
  await v.press("\r");
  await v.settle();
  expect(v.frame()).toContain("The dev manager's session failed.");
  expect(v.frame()).toContain("fix: Run `factory doctor`.");
  v.unmount();
});

// --- factory cockpit --chat-send -------------------------------------------------------------------------------------

const FAKE_CLAUDE = String.raw`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CLAUDE_LOG as string, JSON.stringify({ argv: process.argv.slice(2), role: process.env.FACTORY_ROLE ?? null,
  agent: process.env.FACTORY_AGENT ?? null }) + "\n");
if (process.env.CLAUDE_FAILS) { process.stderr.write("claude: something broke\n"); process.exit(1); }
console.log("Two PRs wait for review.");
`;

// The same small fake gh as owner.test.ts: a JSON db, every call logged, posted comments kept in `posted`.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const file = process.env.FAKE_DB as string;
const db = JSON.parse(readFileSync(file, "utf8"));
const valueFlags = new Set(["-X", "--method", "-H", "--header", "--input", "-q", "--jq", "-f", "-F", "--json"]);
let stdin = "";
if (a.includes("--input")) stdin = await Bun.stdin.text();
appendFileSync(process.env.FAKE_LOG as string, JSON.stringify({ argv: a, stdin }) + "\n");
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
const fail = (m: string): never => { process.stderr.write(m + "\n"); process.exit(1); };
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
if (a[0] !== "api") fail("unexpected gh " + a.join(" "));
let method = "GET"; let path = "";
for (let i = 1; i < a.length; i++) {
  const x = a[i] as string;
  if (x === "-X" || x === "--method") method = a[++i] as string;
  else if (valueFlags.has(x)) i++;
  else if (x.startsWith("-")) continue;
  else if (!path) path = x;
}
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = decodeURIComponent(u.pathname.slice(1)); const page = Number(u.searchParams.get("page") ?? "1");
const paged = (xs: unknown[]) => out(a.includes("--paginate") || page === 1 ? xs : []);
let m: RegExpExecArray | null;
if (p === "issues" && method === "GET") paged(db.issues ?? []);
if ((m = /^issues\/(\d+)\/comments$/.exec(p))) {
  if (method === "POST") { let body = ""; try { body = JSON.parse(stdin).body; } catch { body = a.join(" "); }
    (db.posted ??= []).push({ issue: m[1], body }); writeFileSync(file, JSON.stringify(db)); out({ id: 1 }); }
  paged([]);
}
fail("gh: Not Found (HTTP 404) for " + method + " " + path);
`;

interface Rig { d: string; work: string; env: Env }

function rig(queue = true): Rig {
  const [d, work, base] = project();
  cpSync(join(SF, "ci"), join(work, ".claude", "ci"), { recursive: true }); // a project has it beside its hooks
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  writeExe(join(d, "bin", "claude"), FAKE_CLAUDE);
  writeFileSync(join(d, "db.json"), JSON.stringify({ issues: queue ? [{ number: 9, title: "Dev manager: needs the owner", state: "open" }] : [] }));
  writeFileSync(join(d, "gh.log"), "");
  writeFileSync(join(d, "claude.log"), "");
  const env: Env = { ...base, FAKE_DB: join(d, "db.json"), FAKE_LOG: join(d, "gh.log"), CLAUDE_LOG: join(d, "claude.log") };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "FACTORY_ROLE", "CLAUDECODE"]) delete env[k];
  return { d, work, env };
}

function send(r: Rig, args: string[], more: Env = {}): Proc {
  return sh([process.execPath, "--no-env-file", "--config=/dev/null", join(r.work, ".claude", "hooks", "factory_cockpit.ts"),
    "--chat-send", ...args], { cwd: r.work, env: { ...r.env, ...more } });
}

type ClaudeCall = { argv: string[]; role: string | null; agent: string | null };

function claudeCalls(r: Rig): ClaudeCall[] {
  return readFileSync(join(r.d, "claude.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ClaudeCall);
}

function promptOf(c: ClaudeCall): string {
  return c.argv[c.argv.indexOf("-p") + 1] ?? "";
}

function posted(r: Rig): { issue: string; body: string }[] {
  return (JSON.parse(readFileSync(join(r.d, "db.json"), "utf8")) as { posted?: { issue: string; body: string }[] }).posted ?? [];
}

function problem(p: Proc): { code: string; message: string; fix: string } {
  return JSON.parse(p.stderr.trim().split("\n").filter(Boolean).pop() ?? "{}") as { code: string; message: string; fix: string };
}

test("--chat-send answers in a fresh dev manager session and posts a summary on the owner queue", () => {
  const r = rig();
  const p = send(r, ["dev-manager", "what is waiting on me?"]);
  expect(p.code, p.out).toBe(0);
  const got = JSON.parse(p.stdout) as { answer: string; summary: { posted: boolean; issue: number } };
  expect(got.answer).toBe("Two PRs wait for review.");
  expect(got.summary.posted).toBe(true);
  expect(got.summary.issue).toBe(9);
  const [c] = claudeCalls(r);
  expect(c).toBeDefined();
  expect(c?.argv).toContain("-p");
  expect(promptOf(c as ClaudeCall)).toContain("what is waiting on me?");
  expect(promptOf(c as ClaudeCall)).toContain("manage-pass");
  expect(c?.role).toBe("dev-manager");
  const sent = posted(r);
  expect(sent.length).toBe(1);
  expect(sent[0]?.issue).toBe("9");
  expect(sent[0]?.body.startsWith("<!-- factory-cockpit-chat role=dev-manager -->")).toBe(true);
  expect(sent[0]?.body).toContain("what is waiting on me?");
  expect(sent[0]?.body).toContain("Two PRs wait for review.");
});

test("--chat-send to the product owner runs its skill", () => {
  const r = rig();
  const p = send(r, ["product-owner", "is the PRD current?"]);
  expect(p.code, p.out).toBe(0);
  const [c] = claudeCalls(r);
  expect(promptOf(c as ClaudeCall)).toContain("product-pass");
  expect(c?.role).toBe("product-owner");
  expect(posted(r)[0]?.body.startsWith("<!-- factory-cockpit-chat role=product-owner -->")).toBe(true);
});

test("--chat-send puts the conversation so far in the prompt", () => {
  const r = rig();
  const history = JSON.stringify([{ who: "owner", text: "earlier question" }, { who: "role", text: "earlier answer" }]);
  const p = send(r, ["dev-manager", "and now?", history]);
  expect(p.code, p.out).toBe(0);
  const prompt = promptOf(claudeCalls(r)[0] as ClaudeCall);
  expect(prompt).toContain("earlier question");
  expect(prompt).toContain("earlier answer");
  expect(prompt).toContain("and now?");
});

test("without an owner queue the answer still comes back, and nothing is posted", () => {
  const r = rig(false);
  const p = send(r, ["dev-manager", "hello"]);
  expect(p.code, p.out).toBe(0);
  const got = JSON.parse(p.stdout) as { answer: string; summary: { posted: boolean } };
  expect(got.answer).toBe("Two PRs wait for review.");
  expect(got.summary.posted).toBe(false);
  expect(posted(r)).toEqual([]);
});

test("a role session that fails is chat_failed, and nothing is posted", () => {
  const r = rig();
  const p = send(r, ["dev-manager", "hello"], { CLAUDE_FAILS: "1" });
  expect(p.code).not.toBe(0);
  const e = problem(p);
  expect(e.code).toBe("chat_failed");
  expect(e.fix.length).toBeGreaterThan(0);
  expect(posted(r)).toEqual([]);
});

test("only the dev manager and the product owner can be talked to", () => {
  const r = rig();
  for (const role of ["coding-agent", "boss"]) {
    const p = send(r, [role, "hello"]);
    expect(p.code).toBe(2);
    expect(problem(p).code).toBe("cockpit_usage");
  }
  expect(claudeCalls(r)).toEqual([]);
});

test("an agent session can't talk for the owner", () => {
  const r = rig();
  const p = send(r, ["dev-manager", "hello"], { FACTORY_AGENT: "taytu" });
  expect(p.code).not.toBe(0);
  expect(problem(p).code).toBe("cockpit_agent_session");
  expect(claudeCalls(r)).toEqual([]);
});
