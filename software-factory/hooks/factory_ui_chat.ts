// The web UI's chat with each agent and the owner queue's cards (#423, decision 0005), served by factory_ui_server.ts.
// Everything goes through the commands that already do it, run in that project's folder:
//
//   GET  /api/projects/:p/agents/:name/chat          what the agent said and was told: its messages (`factory messages
//                                                    ls --kind all --all --json`, through the Messaging port, cached by
//                                                    the views' cache) and what the owner sent from this page
//   POST /api/projects/:p/agents/:name/chat {text}   to a coding agent: `factory say <name> <text>` (200). To the dev
//                                                    manager or the product owner: one turn of the cockpit's talk,
//                                                    `factory cockpit --chat-send <role> <text> [<history>]` (202); its
//                                                    answer arrives over the WebSocket
//   GET  /api/projects/:p/owner-queue                each ask on the owner queue ("Dev manager: needs the owner"): its
//                                                    text, its options (its list lines, as the cockpit has them), open or
//                                                    answered, and the answer
//   POST /api/projects/:p/owner-queue/:id/answer     {answer, confirm: true}: `factory owner answer <id> <answer>`
//
// The WebSocket gets {type: "chat", project, agent, items, pending} for each new item in a chat and {type: "owner-queue",
// project, queue} when the queue changes. What the owner sent (and the talk's answers) is kept on this machine in the
// project's state folder, `ui-chat.jsonl` (mode 600): `factory say` logs that it was used, never the text.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, roleNames } from "./factory_config.ts";
import { askText, forProduct, OWNER_QUEUE_TITLE, ownerAskIds, openOwnerAsks, trustedOf } from "./factory_prs.ts";
import { type Agent, envFor, factoryScript, type Obj, type Problem, type Ran, roleOf, spawn, stateDirOf, type UiProject } from "./factory_ui_data.ts";

const TEXT_MAX = 2000; // what `factory say` takes in one message
const ITEMS_MAX = 200; // what a chat shows
const LOG_MAX = 2000; // the lines of ui-chat.jsonl read back
const TURNS = 10; // the talk's turns that go with the next one (the cockpit's own cut)
const SAY_MS = 60_000;
const TALK_MS = 20 * 60_000; // the cockpit's pane waits 20 minutes; the session itself stops before
const READ_MS = 30_000;
const QUEUE_SECONDS = 45; // views.cacheSeconds' default: how long a read of the owner queue is used again
const TALKS = ["dev-manager", "product-owner"];
// an ask's options are its list lines: `- `, `* `, `1. `, `1) `, `A) `, `a. ` (as cockpit/views/ask.tsx reads them)
const OPTION = /^\s*(?:[-*]|\d{1,2}[.)]|[A-Za-z][.)])\s+(.+?)\s*$/;
const OWNER_ANSWER = /<!--\s*factory-owner-answer\s+id=([\w.-]+)\s*-->/g;

export interface ChatItem {
  id: string;
  at: string;
  from: string;
  to: string;
  /** owner (the owner said it here), reply (the talk's answer), error (a talk that failed), or a message's kind. */
  kind: string;
  text: string;
  state?: string;
  ref?: string;
  url?: string;
  error?: Problem;
}

export interface Ask {
  id: string;
  issue: number;
  text: string;
  options: string[];
  state: "open" | "answered";
  forProduct: boolean;
  url: string | null;
  created: string | null;
  answer: string | null;
}

export interface Queue {
  issue: number | null;
  url: string | null;
  asks: Ask[];
  problem: Problem | null;
}

export interface Reply {
  status: number;
  body: Obj;
}

type Publish = (message: Obj) => void;

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function problem(status: number, code: string, message: string, fix: string): Reply {
  return { status, body: { code, message, fix } };
}

/** The ask's options: its list lines, without their bullet or label. */
export function optionsOf(text: string): string[] {
  return text.split("\n").map((l) => OPTION.exec(l)?.[1] ?? "").map((o) => o.replace(/[\x00-\x1f\x7f]/g, "").trim()).filter(Boolean);
}

/** The environment the owner's commands run in: the project's, and not a Claude Code session's. `factory ui` is the
 * owner's (it refuses a factory session) and the token is the owner's, so what the page asks is the owner asking. */
function ownerEnv(p: UiProject): Record<string, string> {
  const env = envFor(p);
  delete env.CLAUDECODE;
  return env;
}

function factory(p: UiProject, args: string[], ms: number): Promise<Ran> {
  return spawn(["bash", factoryScript(p), ...args], p.path, ownerEnv(p), ms);
}

/** How a command went: 200 with its output, or 500 with its own {code, message, fix} (else one naming the command). */
function outcome(p: UiProject, command: string, r: Ran): Reply {
  const output = (r.stdout + r.stderr).trim();
  if (r.code === 0) return { status: 200, body: { ok: true, command, output } };
  const own = errorOf(r);
  if (own) return { status: 500, body: { ok: false, command, ...own, output } };
  const last = r.stderr.trim().split("\n").at(-1) ?? "";
  return { status: 500, body: { ok: false, command, code: "ui_command_failed", message: `\`${command}\` failed (${(last || `exit ${r.code}`).slice(0, 200)}).`,
    fix: `Run it in ${p.path} to see the whole error.`, output } };
}

/** The {code, message, fix} a failed command printed last on stderr, else null. */
function errorOf(r: Ran): Problem | null {
  const last = r.stderr.trim().split("\n").at(-1) ?? "";
  try {
    const own = obj(JSON.parse(last) as unknown);
    if (typeof own.code === "string" && typeof own.message === "string" && typeof own.fix === "string") {
      return { code: own.code, message: own.message, fix: own.fix };
    }
  } catch {
    // not one of ours
  }
  return null;
}

/** The channel a message's sender or addressee belongs to: a role's address or any of its names is that role's first
 * name (its channel); any other name is its own. */
export function channelOf(cfg: Config | null, name: string): string {
  if (!cfg || !name) return name;
  for (const [role, address] of [["dev-manager", "dev-manager"], ["product-owner", "po"]] as const) {
    const names = roleNames(cfg, role);
    if (name === address || name === role || names.includes(name)) return names[0] ?? name;
  }
  return name;
}

// --- what the owner said here ------------------------------------------------------------------------------------------

function logFile(p: UiProject): string {
  return join(stateDirOf(p), "ui-chat.jsonl");
}

function keep(p: UiProject, agent: string, item: ChatItem): void {
  const file = logFile(p);
  mkdirSync(stateDirOf(p), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify({ agent, item }) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

function kept(p: UiProject, agent: string): ChatItem[] {
  const file = logFile(p);
  if (!existsSync(file)) return [];
  const out: ChatItem[] = [];
  for (const line of readFileSync(file, "utf8").split("\n").slice(-LOG_MAX)) {
    try {
      const row = obj(JSON.parse(line) as unknown);
      if (row.agent === agent && typeof obj(row.item).text === "string") out.push(row.item as ChatItem);
    } catch {
      // a line cut short
    }
  }
  return out;
}

let made = 0;
function newId(): string {
  return `ui-${Date.now().toString(36)}-${(made++).toString(36)}`;
}

function item(from: string, to: string, kind: string, text: string, more: Partial<ChatItem> = {}): ChatItem {
  return { id: newId(), at: new Date().toISOString(), from, to, kind, text, ...more };
}

// --- the agents' messages ----------------------------------------------------------------------------------------------

interface Said {
  items: { item: ChatItem; channels: string[] }[];
  ids: Set<string>;
  problem: Problem | null;
}

async function readMessages(p: UiProject): Promise<Said> {
  const r = await factory(p, ["messages", "ls", "--kind", "all", "--all", "--json"], READ_MS);
  let rows: unknown;
  try {
    rows = JSON.parse(r.stdout) as unknown;
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) {
    const why = errorOf(r)?.message ?? (r.stderr.trim().split("\n").at(-1) || `exit ${r.code}`);
    return { items: [], ids: new Set(), problem: { code: "ui_messages_unreadable", message: `The agents' messages in ${p.name} can't be read (${why.slice(0, 200)}).`,
      fix: `Run \`factory messages ls --kind all\` in ${p.path} to see the whole error.` } };
  }
  const items = rows.map(obj).filter((m) => str(m.id)).map((m) => {
    const it: ChatItem = { id: str(m.id), at: str(m.created), from: str(m.from), to: str(m.to), kind: str(m.kind) || "message",
      text: str(m.summary), state: str(m.state), ref: str(m.ref), url: str(m.url) };
    return { item: it, channels: [...new Set([channelOf(p.config, it.from), channelOf(p.config, it.to)])].filter(Boolean) };
  });
  return { items, ids: new Set(items.map((x) => x.item.id)), problem: null };
}

function byTime(a: ChatItem, b: ChatItem): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

// --- the owner queue ---------------------------------------------------------------------------------------------------

async function ghAll(p: UiProject, path: string): Promise<Obj[] | Problem> {
  const out: Obj[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await spawn(["gh", "api", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`], p.path, ownerEnv(p), READ_MS);
    let chunk: unknown;
    try {
      chunk = JSON.parse(r.stdout) as unknown;
    } catch {
      chunk = null;
    }
    if (r.code !== 0 || !Array.isArray(chunk)) {
      const why = (r.stderr.trim().split("\n").at(-1) || `exit ${r.code}`).slice(0, 200);
      return { code: "ui_owner_queue_unreadable", message: `The owner queue of ${p.name} can't be read from GitHub (${why}).`,
        fix: "Run `gh auth status` (and `gh auth login` if it says so); `factory cockpit --needs` reads the same queue." };
    }
    out.push(...chunk.map(obj));
    if (chunk.length < 100) break;
  }
  return out;
}

/** The owner queue of project `p`: every ask on its open "Dev manager: needs the owner" issue, open or answered. */
export async function readQueue(p: UiProject): Promise<Queue> {
  const issues = await ghAll(p, "repos/{owner}/{repo}/issues?state=open");
  if (!Array.isArray(issues)) return { issue: null, url: null, asks: [], problem: issues };
  const queue = issues.find((i) => str(i.title).startsWith(OWNER_QUEUE_TITLE) && !i.pull_request);
  if (!queue) return { issue: null, url: null, asks: [], problem: null };
  const n = Number(queue.number);
  const comments = await ghAll(p, `repos/{owner}/{repo}/issues/${n}/comments`);
  if (!Array.isArray(comments)) return { issue: n, url: str(queue.html_url) || null, asks: [], problem: comments };
  const open = new Set(openOwnerAsks(comments, trustedOf((p.config ?? {}) as Config)).map(([id]) => id));
  const answers = new Map<string, string>();
  for (const c of comments) for (const m of str(c.body).matchAll(OWNER_ANSWER)) answers.set(m[1] as string, askText(str(c.body)));
  const asks: Ask[] = [];
  const seen = new Set<string>();
  for (const c of comments) {
    for (const id of ownerAskIds(str(c.body))) {
      if (seen.has(id)) continue;
      seen.add(id);
      const text = askText(str(c.body));
      asks.push({ id, issue: n, text, options: optionsOf(text), state: open.has(id) ? "open" : "answered", forProduct: forProduct(c),
        url: str(c.html_url) || null, created: str(c.created_at) || null, answer: answers.get(id) ?? null });
    }
  }
  return { issue: n, url: str(queue.html_url) || null, asks, problem: null };
}

// --- the hub -----------------------------------------------------------------------------------------------------------

export interface ChatOptions {
  pollSeconds: number;
  publish: Publish;
}

/** The chats and owner queues of every project: the API's routes for them, and what the poll loop pushes. */
export class ChatHub {
  private said = new Map<string, Said>();
  private reading = new Map<string, Promise<Said>>();
  private queues = new Map<string, { queue: Queue; text: string; at: number }>();
  private pending = new Set<string>();
  private readAt = new Map<string, number>();

  constructor(private o: ChatOptions) {}

  /** The project's messages, read again when older than `maxAgeMs`; each item not seen before is pushed to its chats. */
  private async messages(p: UiProject, maxAgeMs: number): Promise<Said> {
    const k = this.said.get(p.id);
    const at = this.readAt.get(p.id) ?? 0;
    if (k && Date.now() - at <= maxAgeMs) return k;
    const busy = this.reading.get(p.id);
    if (busy) return busy;
    const next = readMessages(p).then((now) => {
      const before = this.said.get(p.id);
      if (now.problem && before) return { ...before, problem: now.problem }; // keep what was read; say it can't be now
      this.said.set(p.id, now);
      this.readAt.set(p.id, Date.now());
      if (before) this.pushNew(p, now.items.filter((x) => !before.ids.has(x.item.id)));
      return now;
    }).finally(() => this.reading.delete(p.id));
    this.reading.set(p.id, next);
    return next;
  }

  private pushNew(p: UiProject, fresh: Said["items"]): void {
    const by = new Map<string, ChatItem[]>();
    for (const x of fresh) for (const c of x.channels) by.set(c, [...(by.get(c) ?? []), x.item]);
    for (const [agent, items] of by) this.push(p, agent, items.sort(byTime));
  }

  private push(p: UiProject, agent: string, items: ChatItem[]): void {
    this.o.publish({ type: "chat", project: p.id, agent, items, pending: this.pending.has(`${p.id}/${agent}`) });
  }

  private queueSeconds(p: UiProject): number {
    const s = obj(p.config?.views).cacheSeconds;
    return typeof s === "number" && s >= 0 ? s : QUEUE_SECONDS;
  }

  /** The project's owner queue, read again when older than its cache time (or now with `fresh`); pushed when it changed. */
  private async queue(p: UiProject, fresh = false): Promise<Queue> {
    const k = this.queues.get(p.id);
    if (!fresh && k && Date.now() - k.at <= this.queueSeconds(p) * 1000) return k.queue;
    const queue = await readQueue(p);
    const text = JSON.stringify(queue);
    this.queues.set(p.id, { queue, text, at: Date.now() });
    if (k && k.text !== text) this.o.publish({ type: "owner-queue", project: p.id, queue });
    return queue;
  }

  /** One turn of the poll loop for project `p` (only while a page is open). */
  async tick(p: UiProject): Promise<void> {
    if (p.problem) return;
    await this.messages(p, 0);
    if (this.queues.has(p.id)) await this.queue(p); // only once a page has looked at it
  }

  /** The reply to a chat or owner-queue request (after the token), or null when the path is none of theirs. */
  async api(req: Request, p: UiProject, rest: string[], seen: Agent[]): Promise<Reply | null> {
    if (rest[0] === "agents" && rest.length === 3 && rest[2] === "chat") {
      const name = rest[1] as string;
      const role = roleOf(p, name, seen);
      if (!role) return problem(404, "ui_agent_unknown", `${name} isn't one of ${p.name}'s agents.`, "Its channels list them: GET /api/projects/:p/channels.");
      if (req.method === "GET") return this.chat(p, name);
      if (req.method === "POST") return this.send(p, name, role, await body(req));
      return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET to read the chat, POST {\"text\": ...} to send.");
    }
    if (rest[0] === "owner-queue" && rest.length === 1) {
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      return { status: 200, body: { project: p.id, ...(await this.queue(p)) } };
    }
    if (rest[0] === "owner-queue" && rest.length === 3 && rest[2] === "answer") {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST with {\"answer\": ..., \"confirm\": true}.");
      return this.answer(p, rest[1] as string, await body(req));
    }
    return null;
  }

  private async chat(p: UiProject, agent: string): Promise<Reply> {
    const said = p.problem ? null : await this.messages(p, this.o.pollSeconds * 1000);
    const theirs = (said?.items ?? []).filter((x) => x.channels.includes(agent)).map((x) => x.item);
    const items = [...theirs, ...kept(p, agent)].sort(byTime).slice(-ITEMS_MAX);
    return { status: 200, body: { project: p.id, agent, items, pending: this.pending.has(`${p.id}/${agent}`),
      problems: said?.problem ? [said.problem] : [] } };
  }

  private async send(p: UiProject, agent: string, role: string, given: Obj): Promise<Reply> {
    const raw = typeof given.text === "string" ? given.text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ").trim() : "";
    if (!raw || raw.length > TEXT_MAX) {
      return problem(400, "chat_text_needed", `A message is some text, up to ${TEXT_MAX} characters.`, 'Send {"text": "..."}: type it in the box and press Enter.');
    }
    if (TALKS.includes(role)) return this.talk(p, agent, role, raw);
    const text = raw.replace(/\s+/g, " "); // one line: it is typed into the agent's session, where Enter sends
    const command = `factory say ${agent} …`;
    const r = outcome(p, command, await factory(p, ["say", agent, text], SAY_MS));
    if (r.status !== 200) return r;
    const said = item("owner", agent, "owner", text);
    keep(p, agent, said);
    this.push(p, agent, [said]);
    return { status: 200, body: { ...r.body, item: said } };
  }

  /** One turn of the cockpit's talk with the dev manager or the product owner: the owner's line now, the answer when the
   * session ends (over the WebSocket). One turn at a time per role. */
  private talk(p: UiProject, agent: string, role: string, text: string): Reply {
    const key = `${p.id}/${agent}`;
    if (this.pending.has(key)) {
      return problem(409, "chat_busy", `${agent} is still answering your last message.`, "Wait for the answer, then send the next one.");
    }
    const history = kept(p, agent).filter((x) => x.kind === "owner" || x.kind === "reply").slice(-TURNS)
      .map((x) => ({ who: x.kind === "owner" ? "owner" : "role", text: x.text }));
    const asked = item("owner", agent, "owner", text);
    keep(p, agent, asked);
    this.pending.add(key);
    this.push(p, agent, [asked]);
    const args = ["cockpit", "--chat-send", role, text, ...(history.length ? [JSON.stringify(history)] : [])];
    void factory(p, args, TALK_MS).then((r) => {
      let answer = "";
      try {
        answer = str(obj(JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "") as unknown).answer);
      } catch {
        // said below
      }
      const own = errorOf(r);
      const got = r.code === 0 && answer ? item(agent, "owner", "reply", answer)
        : item(agent, "owner", "error", own?.message ?? `The talk with ${agent} failed (exit ${r.code}); nothing was posted.`, {
          error: own ?? { code: "chat_failed", message: `The talk with ${agent} failed (exit ${r.code}).`,
            fix: `Run \`factory cockpit --chat ${role}\` in ${p.path} to see the whole error.` } });
      keep(p, agent, got);
      this.pending.delete(key);
      this.push(p, agent, [got]);
    });
    return { status: 202, body: { ok: true, pending: true, command: `factory cockpit --chat-send ${role} …`, item: asked } };
  }

  private async answer(p: UiProject, id: string, given: Obj): Promise<Reply> {
    if (given.confirm !== true) {
      return problem(400, "confirm_needed", `Answering ${id} posts on the owner queue as you, so it needs a confirm.`, 'Send {"answer": "...", "confirm": true} (the page asks you first).');
    }
    const text = typeof given.answer === "string" ? given.answer.trim() : "";
    if (!text || text.length > TEXT_MAX) {
      return problem(400, "answer_needed", `An answer is some text, up to ${TEXT_MAX} characters.`, "Pick an option, or type your own answer.");
    }
    const r = outcome(p, `factory owner answer ${id} …`, await factory(p, ["owner", "answer", id, text], SAY_MS));
    if (r.status === 200) {
      this.queues.delete(p.id); // read again now, and pushed once below
      const queue = await this.queue(p, true);
      this.o.publish({ type: "owner-queue", project: p.id, queue });
      return { status: 200, body: { ...r.body, queue } };
    }
    return r;
  }
}

async function body(req: Request): Promise<Obj> {
  try {
    return obj(await req.json());
  } catch {
    return {};
  }
}
