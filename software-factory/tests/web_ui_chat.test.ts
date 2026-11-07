// The web UI's chat with each agent and the owner queue's cards (#423). An agent's channel is a chat: what the agent said
// (its messages, read through `factory messages ls`) and what the owner sends: to a coding agent through `factory say`,
// to the dev manager or the product owner through one turn of a talk (`factory talk`), whose answer
// arrives later over the WebSocket. The owner-queue channel lists each ask with its options; an answer runs
// `factory owner answer` after a confirm. gh is a fake (the owner queue lives in its db), and `factory` is a fake that
// logs what it was asked, except `owner answer`, which runs the real command against the fake gh.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, hbRow, heartbeat, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { BUN, HOOKS, write, writeExe } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// `factory` for these tests: logs each call (one line, its arguments as JSON), prints the messages file for
// `messages ls`, answers a talk with a fixed line, and runs the real `factory owner` (against the fake gh).
const FACTORY = `#!/usr/bin/env bash
${BUN.map((x) => `'${x}'`).join(" ")} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@" >> "$FAKE_FACTORY_LOG"
case "$1" in
  say) [ -n "$FAKE_SAY_FAIL" ] && { echo '{"code": "no-session", "message": "No session.", "fix": "Start it."}' >&2; exit 1; }
       echo "Sent to $2 on local (logged there, without the text)." ;;
  messages) cat "$FAKE_MESSAGES" ;;
  talk) sleep "\${FAKE_TALK_SLEEP:-0}"; echo '{"answer": "Noted: I will look at it.", "summary": {"posted": true, "issue": 50}}' ;;
  owner) shift; exec ${BUN.map((x) => `'${x}'`).join(" ")} '${join(HOOKS, "factory_owner.ts")}' "$@" ;;
  *) echo "fake factory: $*" ;;
esac
`;

const QUEUE = "Dev manager: needs the owner";

function msg(id: string, more: Row): Row {
  return { id, kind: "question", from: "menelik", to: "dev-manager", state: "submitted", ref: "pr#12", inReplyTo: "", sha: "",
    legacy: false, thread: 12, url: `https://github.com/o/r/pull/12#${id}`, created: "2026-11-05T10:00:00Z", summary: "", ...more };
}

interface Chat extends Project {
  messages: string;
  db: string;
}

function chatProject(cfg?: Row): Chat {
  const p = cfg ? project(cfg) : project();
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FACTORY);
  const messages = write(join(p.root, "messages.json"), JSON.stringify([
    msg("q-menelik-1", { summary: "Should the login page use the old session cookie?" }),
    msg("a-fasil-1", { kind: "answer", from: "fasil", to: "menelik", state: "completed", inReplyTo: "q-menelik-1",
      created: "2026-11-05T10:05:00Z", summary: "No: use the new one." }),
    msg("s-menelik-0", { kind: "status", state: "working", ref: "issue#30", thread: 30, created: "2026-11-05T09:00:00Z", summary: "Status: working" }),
  ]));
  const db = join(p.root, "db.json");
  write(db, JSON.stringify({
    issues: [{ number: 50, title: QUEUE, body: "", state: "open", labels: [], html_url: "https://github.com/o/r/issues/50" }],
    comments: { "50": [
      { body: "<!-- factory-owner-ask id=pick-db -->\nWhich database for the cache?\n\n- Postgres\n- SQLite\n", created_at: "2026-11-05T09:00:00Z",
        html_url: "https://github.com/o/r/issues/50#c1" },
      { body: "<!-- factory-owner-ask id=old-ask -->\nShip it on Friday?\n\n1. Yes\n2. No\n", created_at: "2026-11-04T09:00:00Z" },
      { body: "<!-- factory-owner-answer id=old-ask -->\n\nYes", created_at: "2026-11-04T10:00:00Z" },
    ] },
  }));
  heartbeat(p, [hbRow("menelik", { state: "working", detail: "working on #12", task: "12" }), hbRow("fasil", { kind: "dev-manager" })]);
  p.env.FAKE_MESSAGES = messages;
  p.env.FACTORY_AGENT = undefined;
  return { ...p, messages, db };
}

async function started(p: Project, env: Record<string, string> = {}): Promise<Running> {
  const ui = await startUi(p, ["--port", "0"], null, env);
  running.push(ui);
  return ui;
}

function calls(p: Project): string[][] {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

function posted(p: Chat): Row[] {
  return ((JSON.parse(readFileSync(p.db, "utf8")) as Row).posted as Row[] | undefined) ?? [];
}

function socket(ui: Running): WebSocket {
  return new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
}

/** The next WebSocket message that `want` accepts, or null after `ms`. */
function next(ws: WebSocket, want: (m: Row) => boolean, ms: number): Promise<Row | null> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as Row;
      if (want(m)) {
        clearTimeout(timer);
        done(m);
      }
    });
  });
}

const texts = (items: unknown): string[] => ((items as Row[] | undefined) ?? []).map((i) => String(i.text));

// --- the chat ----------------------------------------------------------------------------------------------------------

test("an agent's chat has what it said and what it was told, from its messages", async () => {
  const p = chatProject();
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/agents/menelik/chat");
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ project: "work", agent: "menelik", pending: false });
  const items = r.json.items as Row[];
  expect(texts(items)).toEqual(["Status: working", "Should the login page use the old session cookie?", "No: use the new one."]);
  expect(items[1]).toMatchObject({ from: "menelik", to: "dev-manager", kind: "question", ref: "pr#12", url: "https://github.com/o/r/pull/12#q-menelik-1" });
  // the dev manager's channel has the question addressed to its role and the answer it gave; an agent's status (addressed
  // to the dev manager by default) stays in the agent's own channel
  const dm = await api(ui, "/api/projects/work/agents/fasil/chat");
  expect(texts(dm.json.items)).toEqual(["Should the login page use the old session cookie?", "No: use the new one."]);
  // nobody else's
  const other = await api(ui, "/api/projects/work/agents/taytu/chat");
  expect(other.json.items).toEqual([]);
  expect(calls(p).some((c) => c.join(" ") === "messages ls --kind all --all --json")).toBe(true);
}, T);

test("a message to a coding agent goes through factory say and stays in its chat", async () => {
  const p = chatProject();
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/agents/menelik/chat", { method: "POST", body: { text: "Please rebase on main,\nthen push." } });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ ok: true, command: "factory say menelik …" });
  expect((r.json.item as Row)).toMatchObject({ from: "owner", to: "menelik", kind: "owner", text: "Please rebase on main, then push." });
  expect(calls(p)).toContainEqual(["say", "menelik", "Please rebase on main, then push."]);
  const chat = await api(ui, "/api/projects/work/agents/menelik/chat");
  expect(texts(chat.json.items)).toContain("Please rebase on main, then push.");
  // kept on this machine, readable by the owner only
  const kept = join(p.state, "ui-chat.jsonl");
  expect(readFileSync(kept, "utf8")).toContain("Please rebase on main, then push.");
  expect(statSync(kept).mode & 0o777).toBe(0o600);
}, T);

test("a refused say comes back with its own code, message and fix, and is not kept", async () => {
  const p = chatProject();
  const ui = await started(p, { FAKE_SAY_FAIL: "1" });
  const r = await api(ui, "/api/projects/work/agents/menelik/chat", { method: "POST", body: { text: "hello" } });
  expect(r.status).toBe(500);
  expect(r.json).toMatchObject({ ok: false, code: "no-session", message: "No session.", fix: "Start it." });
  const chat = await api(ui, "/api/projects/work/agents/menelik/chat");
  expect(texts(chat.json.items)).not.toContain("hello");
}, T);

test("a message needs text, at most 2000 characters, to an agent of the project", async () => {
  const p = chatProject();
  const ui = await started(p);
  for (const body of [{}, { text: "   " }, { text: "x".repeat(2001) }, { text: 7 }]) {
    const r = await api(ui, "/api/projects/work/agents/menelik/chat", { method: "POST", body });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("chat_text_needed");
    expect(String(r.json.fix)).not.toBe("");
  }
  const r = await api(ui, "/api/projects/work/agents/nobody/chat", { method: "POST", body: { text: "hi" } });
  expect(r.status).toBe(404);
  expect(r.json.code).toBe("ui_agent_unknown");
  expect(calls(p).some((c) => c[0] === "say")).toBe(false);
}, T);

test("the dev manager answers through factory talk, and the answer arrives over the WebSocket", async () => {
  const p = chatProject();
  const ui = await started(p, { FAKE_TALK_SLEEP: "1" });
  const ws = socket(ui);
  await next(ws, (m) => m.type === "hello", 10_000);
  const answer = next(ws, (m) => m.type === "chat" && m.agent === "fasil" && texts(m.items).includes("Noted: I will look at it."), 20_000);
  const r = await api(ui, "/api/projects/work/agents/fasil/chat", { method: "POST", body: { text: "Why is #12 still open?" } });
  expect(r.status).toBe(202);
  expect(r.json).toMatchObject({ ok: true, pending: true, command: "factory talk dev-manager …" });
  const during = await api(ui, "/api/projects/work/agents/fasil/chat");
  expect(during.json.pending).toBe(true);
  const got = await answer;
  expect(got).not.toBeNull();
  expect(((got as Row).items as Row[])[0]).toMatchObject({ from: "fasil", to: "owner", kind: "reply" });
  expect((got as Row).pending).toBe(false);
  expect(calls(p)).toContainEqual(["talk", "dev-manager", "Why is #12 still open?"]);
  // the next turn carries the conversation so far
  const again = next(ws, (m) => m.type === "chat" && m.agent === "fasil" && m.pending === false, 20_000);
  await api(ui, "/api/projects/work/agents/fasil/chat", { method: "POST", body: { text: "And #13?" } });
  await again;
  ws.close();
  const second = calls(p).find((c) => c[0] === "talk" && c[2] === "And #13?") as string[];
  expect(JSON.parse(second[3] as string)).toEqual([{ who: "owner", text: "Why is #12 still open?" }, { who: "role", text: "Noted: I will look at it." }]);
  const chat = await api(ui, "/api/projects/work/agents/fasil/chat");
  expect(texts(chat.json.items)).toEqual(expect.arrayContaining(["Why is #12 still open?", "Noted: I will look at it.", "And #13?"]));
}, T);

test("a message an agent says later arrives over the WebSocket in its chat", async () => {
  const p = chatProject();
  const ui = await started(p);
  const ws = socket(ui);
  await next(ws, (m) => m.type === "state", 15_000);
  await Bun.sleep(1500); // the first read is what was already said
  const arrived = next(ws, (m) => m.type === "chat" && m.agent === "menelik" && texts(m.items).includes("Pushed the fix."), 20_000);
  const before = JSON.parse(readFileSync(p.messages, "utf8")) as Row[];
  write(p.messages, JSON.stringify([...before, msg("s-menelik-2", { kind: "answer", from: "menelik", to: "fasil", state: "completed",
    created: "2026-11-05T11:00:00Z", summary: "Pushed the fix." })]));
  const got = await arrived;
  ws.close();
  expect(got).not.toBeNull();
  expect(texts((got as Row).items)).toEqual(["Pushed the fix."]); // only what is new
}, T);

// --- the owner queue ---------------------------------------------------------------------------------------------------

test("the owner queue lists each ask with its options, and the answered ones as answered", async () => {
  const p = chatProject();
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/owner-queue");
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ project: "work", issue: 50, url: "https://github.com/o/r/issues/50" });
  const asks = r.json.asks as Row[];
  expect(asks.map((a) => a.id)).toEqual(["pick-db", "old-ask"]);
  expect(asks[0]).toMatchObject({ state: "open", options: ["Postgres", "SQLite"], url: "https://github.com/o/r/issues/50#c1" });
  expect(String(asks[0]?.text)).toContain("Which database for the cache?");
  expect(asks[1]).toMatchObject({ state: "answered", options: ["Yes", "No"], answer: "Yes" });
}, T);

test("an answer tap needs a confirm, then posts what factory owner answer posts", async () => {
  const p = chatProject();
  const ui = await started(p);
  const path = "/api/projects/work/owner-queue/pick-db/answer";
  const no = await api(ui, path, { method: "POST", body: { answer: "Postgres" } });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("confirm_needed");
  expect(posted(p)).toEqual([]);
  const empty = await api(ui, path, { method: "POST", body: { answer: " ", confirm: true } });
  expect(empty.status).toBe(400);
  expect(posted(p)).toEqual([]);
  const ws = socket(ui);
  await next(ws, (m) => m.type === "hello", 10_000);
  const pushed = next(ws, (m) => m.type === "owner-queue" && m.project === "work", 20_000);
  const r = await api(ui, path, { method: "POST", body: { answer: "Postgres", confirm: true } });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ ok: true, command: "factory owner answer pick-db …" });
  expect(posted(p)).toEqual([{ kind: "comment", issue: 50, body: "<!-- factory-owner-answer id=pick-db -->\n\nPostgres" }]);
  const after = await api(ui, "/api/projects/work/owner-queue");
  expect((after.json.asks as Row[])[0]).toMatchObject({ id: "pick-db", state: "answered", answer: "Postgres" });
  const got = await pushed;
  ws.close();
  expect((((got as Row).queue as Row).asks as Row[])[0]).toMatchObject({ id: "pick-db", state: "answered" });
}, T);

test("an unknown ask is refused by factory owner answer with its own error", async () => {
  const p = chatProject();
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/owner-queue/nope/answer", { method: "POST", body: { answer: "Yes", confirm: true } });
  expect(r.status).toBe(500);
  expect(r.json.code).toBe("no_such_ask");
  expect(posted(p)).toEqual([]);
}, T);

test("with no owner queue issue the channel says so", async () => {
  const p = chatProject();
  write(p.db, JSON.stringify({ issues: [] }));
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/owner-queue");
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ issue: null, asks: [] });
}, T);

// --- the token ---------------------------------------------------------------------------------------------------------

test("the chat and owner-queue endpoints refuse a missing or wrong token and run nothing", async () => {
  const p = chatProject();
  const ui = await started(p);
  const reqs: [string, string, Row | undefined][] = [
    ["GET", "/api/projects/work/agents/menelik/chat", undefined],
    ["POST", "/api/projects/work/agents/menelik/chat", { text: "hi" }],
    ["POST", "/api/projects/work/agents/fasil/chat", { text: "hi" }],
    ["GET", "/api/projects/work/owner-queue", undefined],
    ["POST", "/api/projects/work/owner-queue/pick-db/answer", { answer: "Postgres", confirm: true }],
  ];
  for (const [method, path, body] of reqs) {
    for (const token of [null, "x".repeat(43)]) {
      const r = await api(ui, path, { method, body, token });
      expect(r.status).toBe(401);
      expect(String(r.json.code)).toMatch(/^ui_token_(missing|wrong)$/);
    }
  }
  expect(calls(p)).toEqual([]);
  expect(posted(p)).toEqual([]);
}, T);
