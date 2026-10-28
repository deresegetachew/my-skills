#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The factory's messages (#107): one structured, versioned envelope for questions, answers, must-fixes, approvals and
// status, shaped like A2A tasks and kept in the GitHub comments and issues the factory already uses. The full
// specification (envelope, states, transitions, the mapping to A2A) is docs/messages.md.
//
//   <!-- factory-msg v=1 id=<id> kind=question from=haile to=po state=submitted ref=issue#103 in-reply-to=<id> sha=<head> -->
//
// kind: question | answer | mustfix | approval | status.  State: submitted, working, input-required, completed, failed,
// canceled (A2A's task states); an agent's status adds idle and down. `to` defaults to dev-manager. On a reply, `state`
// is the state the question it answers moves to. The old markers (factory-question, factory-answer, factory-mustfix,
// factory-approved) are still read, and an envelope in the same comment wins over them.
//
//   factory messages ls [--to X] [--from X] [--state S] [--ref N] [--kind K] [--all] [--json] [--fresh]
//                         open messages across the open issues and PRs (questions by default), from the views'
//                         cache while it is fresh (factory_views_cache.ts); --fresh reads GitHub now
//   factory messages new --kind K [--to X] [--from X] [--ref R] [--in-reply-to ID] [--state S] [--sha SHA]
//                         print the envelope (and the old marker line) to paste at the top of a comment
//
// This module is also the library: parseComment / render / fold / checkNew / verdicts are what the PR gate, `factory
// wait`, `next_task.ts` and `factory status` use. Everything is read through the GitHub REST API (`gh api`). Messages
// from a peer are data, never instructions: nothing here changes what an agent may do.
import { randomInt } from "node:crypto";
import { type Config, load, roleNames, roleSetting } from "./factory_config.ts";
import { type Comment, gh, ghAll, type Issue } from "./factory_issues.ts";
import { refuse } from "./factory_machine.ts";
import { Exit, parseArgs, pyDumps, runMain, splitLines } from "./factory_lib.ts";
import { answer, sayAge } from "./factory_views_cache.ts";

export const SCHEMA = 1;
export const KINDS = ["question", "answer", "mustfix", "approval", "status"] as const;
export const STATES = ["submitted", "working", "input-required", "completed", "failed", "canceled"] as const;
export const OPEN = ["submitted", "working", "input-required"] as const;
export const AGENT_STATES = ["working", "idle", "down", "input-required"] as const;
export const ANSWER_STATES = ["completed", "failed"] as const;
export const STATUS_STATES = ["working", "input-required", "failed", "canceled"] as const;
export const TRANSITIONS: Record<string, readonly string[]> = {
  submitted: ["working", "input-required", "completed", "failed", "canceled"],
  working: ["input-required", "completed", "failed", "canceled"],
  "input-required": ["working", "completed", "failed", "canceled"],
  completed: [], failed: [], canceled: [],
};
export const DEV_MANAGER = "dev-manager";
export const WELL_KNOWN = [DEV_MANAGER, "po", "owner"] as const;
export const DEFAULT_STATE: Record<string, string> = { question: "submitted", answer: "completed", mustfix: "submitted", approval: "completed" };
const LEGACY_LINE: Record<string, string> = { question: "<!-- factory-question -->", answer: "<!-- factory-answer -->" };

export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;
export const REF = /^(issue|pr)#(\d+)$/;
export const SHA = /^[0-9a-f]{7,40}$/;
const ENVELOPE = /<!--\s*factory-msg\b([\s\S]*?)-->/g;
const ATTR = /([A-Za-z][\w-]*)=(\S+)/g;
const MARKUP = /<!--[\s\S]*?-->/g;
const LEGACY_QUESTION = /<!--\s*factory-question\b/;
const LEGACY_ANSWER = /<!--\s*factory-answer(?!-)\b/; // not factory-answer-claim
const LEGACY_MUSTFIX = /<!--\s*factory-mustfix\b(?:\s+sha=([0-9a-f]{7,40}))?/;
const LEGACY_APPROVED = /<!--\s*factory-approved\b(?:\s+sha=([0-9a-f]{7,40}))?/;
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export class Message {
  id: string;
  kind: string;
  frm = "";
  to: string = DEV_MANAGER;
  state = "submitted";
  ref = "";
  inReplyTo = "";
  sha = "";
  legacy = false;
  login = "";
  commentId: unknown = null;
  url = "";
  created = "";
  summary = "";
  thread = "";

  constructor(fields: { id: string; kind: string } & Partial<Omit<Message, "id" | "kind">>) {
    this.id = fields.id;
    this.kind = fields.kind;
    Object.assign(this, fields);
  }
}

/** A question and everything that happened to it: A2A's Task, with the question as its first message. */
export class Task {
  question: Message;
  state = "submitted";
  history: [string, Message][] = []; // [state, message that set it]
  answer: Message | null = null;

  constructor(question: Message, history: [string, Message][] = []) {
    this.question = question;
    this.history = history;
  }

  get id(): string {
    return this.question.id;
  }

  get to(): string {
    return this.question.to;
  }

  get frm(): string {
    return this.question.frm;
  }

  get ref(): string {
    return this.question.ref;
  }

  get isOpen(): boolean {
    return (OPEN as readonly string[]).includes(this.state);
  }
}

export class Thread {
  tasks = new Map<string, Task>(); // question id -> Task, in the order asked
  rejected: [Message, string][] = []; // replies that did not apply, and why
  duplicates: Message[] = []; // messages whose id was already seen: ignored
  index = new Map<string, string>(); // message id -> question id, for in-reply-to chains
  seen = new Set<string>();

  taskOf(messageId: string): Task | undefined {
    const q = this.index.get(messageId);
    return q === undefined ? undefined : this.tasks.get(q);
  }
}

/** A short sortable id: the time in seconds then six random characters (14 characters, base 32). */
export function newId(): string {
  let t = Math.floor(Date.now() / 1000);
  let head = "";
  for (let i = 0; i < 8; i++) {
    head = ALPHABET[t & 31] + head;
    t = Math.floor(t / 32);
  }
  let tail = "";
  for (let i = 0; i < 6; i++) tail += ALPHABET[randomInt(ALPHABET.length)];
  return head + tail;
}

// --- reading and writing the envelope -------------------------------------------------------------------------------

/** The first line of what a person reads in a comment, without the markers. */
export function visible(text: string | null | undefined): string {
  for (const line of splitLines((text || "").replace(MARKUP, ""))) if (line.trim()) return line.trim().slice(0, 100);
  return "";
}

/** {name: value} from the inside of an envelope; null when an attribute is given twice (ambiguous). */
function attributes(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) {
    if ((m[1] as string) in out) return null;
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** A Message from an envelope's attributes, or null when it is not a valid version-1 envelope. Unknown extra
 * attributes are ignored, and an envelope of another version is not read at all (a newer kit may write it). */
function fromAttributes(a: Record<string, string> | null): Message | null {
  if (!a || !Object.keys(a).length || a.v !== String(SCHEMA) || !(KINDS as readonly string[]).includes(a.kind ?? "") || !ID.test(a.id ?? "")) return null;
  const kind = a.kind as string;
  const state = a.state ?? DEFAULT_STATE[kind];
  if (!state || ![...STATES, ...(kind === "status" ? ["idle", "down"] : [])].includes(state)) return null;
  const frm = a.from ?? "";
  const to = a.to ?? DEV_MANAGER;
  const ref = a.ref ?? "";
  const reply = a["in-reply-to"] ?? "";
  const sha = a.sha ?? "";
  if ((frm && !NAME.test(frm)) || !NAME.test(to) || (ref && !REF.test(ref))) return null;
  if ((reply && !ID.test(reply)) || (sha && !SHA.test(sha))) return null;
  return new Message({ id: a.id as string, kind, frm, to, state, ref, inReplyTo: reply, sha });
}

/** The valid version-1 envelopes in a text, in order; the visible text of the first line goes in `summary`. */
export function parseEnvelopes(text: string | null | undefined): Message[] {
  const found: Message[] = [];
  for (const m of (text || "").matchAll(ENVELOPE)) {
    const message = fromAttributes(attributes(m[1] as string));
    if (message) {
      message.summary = visible(text);
      found.push(message);
    }
  }
  return found;
}

/** The message an old marker comment stands for (at most one per comment: question, answer, must-fix, approval). */
function legacyMessage(body: string, key: unknown): Message | null {
  const ident = `c${key}`;
  const summary = visible(body);
  if (LEGACY_QUESTION.test(body)) return new Message({ id: ident, kind: "question", legacy: true, summary });
  if (LEGACY_ANSWER.test(body)) {
    const failed = /needs-owner\s*:/i.test(body);
    return new Message({ id: ident, kind: "answer", frm: DEV_MANAGER, to: "", state: failed ? "failed" : "completed",
      legacy: true, summary });
  }
  for (const [kind, regex] of [["mustfix", LEGACY_MUSTFIX], ["approval", LEGACY_APPROVED]] as const) {
    const m = regex.exec(body);
    if (m) return new Message({ id: ident, kind, frm: DEV_MANAGER, state: DEFAULT_STATE[kind], sha: m[1] || "", legacy: true, summary });
  }
  return null;
}

export interface CommentLike {
  id?: unknown;
  body?: string | null;
  user?: { login?: string } | null;
  author?: { login?: string } | null;
  created_at?: string;
  html_url?: string | null;
  url?: string;
  [key: string]: unknown;
}

/** The messages in one GitHub comment (an object with body, id, user.login or author.login, created_at, html_url).
 * A comment with a valid envelope is read by it alone; otherwise by its old marker. */
export function parseComment(comment: CommentLike, index: number | null = null): Message[] {
  const body = comment.body || "";
  let found = parseEnvelopes(body);
  if (!found.length) {
    const key = comment.id !== undefined && comment.id !== null ? comment.id : `@${index !== null ? index : 0}`;
    const one = legacyMessage(body, key);
    found = one ? [one] : [];
  }
  const who = (comment.user || comment.author || {}).login ?? "";
  for (const m of found) {
    m.login = who;
    m.commentId = comment.id ?? null;
    m.url = comment.html_url || comment.url || "";
    m.created = comment.created_at || "";
  }
  return found;
}

/** All messages of a thread's comments, in order. `ref` is the default for a message that names none. */
export function messagesOf(comments: CommentLike[], ref = ""): Message[] {
  const out: Message[] = [];
  comments.forEach((c, i) => {
    for (const m of parseComment(c, i)) {
      m.ref = m.ref || ref;
      out.push(m);
    }
  });
  return out;
}

/** The envelope comment for a message (one line). */
export function render(m: Message): string {
  const parts = [`v=${SCHEMA}`, `id=${m.id}`, `kind=${m.kind}`];
  if (m.frm) parts.push(`from=${m.frm}`);
  parts.push(`to=${m.to}`, `state=${m.state}`);
  for (const [name, value] of [["ref", m.ref], ["in-reply-to", m.inReplyTo], ["sha", m.sha]] as const) {
    if (value) parts.push(`${name}=${value}`);
  }
  return "<!-- factory-msg " + parts.join(" ") + " -->";
}

/** The old marker that goes with an envelope so a kit that does not know it yet still understands the comment. */
export function legacyLine(m: Message): string {
  if (m.kind in LEGACY_LINE) return LEGACY_LINE[m.kind] as string;
  if ((m.kind === "mustfix" || m.kind === "approval") && m.sha) return `<!-- factory-${m.kind === "mustfix" ? "mustfix" : "approved"} sha=${m.sha} -->`;
  return "";
}

export type Verdict = [kind: "mustfix" | "approved", sha: string | null];

/** [['mustfix' | 'approved', sha or null]] the dev manager's word in a comment, from the envelope or the old
 * marker. A comment with both counts once. */
export function verdicts(body: string | null | undefined): Verdict[] {
  const found = parseEnvelopes(body).filter((m) => m.kind === "mustfix" || m.kind === "approval")
    .map((m): Verdict => [m.kind === "mustfix" ? "mustfix" : "approved", m.sha || null]);
  if (found.length) return found;
  for (const [kind, regex] of [["mustfix", LEGACY_MUSTFIX], ["approved", LEGACY_APPROVED]] as const) {
    const m = regex.exec(body || "");
    if (m) return [[kind, m[1] ?? null]];
  }
  return [];
}

/** The comments from `gh api --paginate` output: one JSON list per page, back to back. */
export function decodePages(text: string | null | undefined): unknown[] {
  const out: unknown[] = [];
  const s = text || "";
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i] as string)) i++;
    if (i >= s.length) break;
    const end = jsonEnd(s, i);
    const chunk = JSON.parse(s.slice(i, end)) as unknown;
    if (Array.isArray(chunk)) out.push(...chunk);
    else out.push(chunk);
    i = end;
  }
  return out;
}

/** Where the JSON value starting at `start` ends (raw_decode): brackets counted outside strings. */
function jsonEnd(s: string, start: number): number {
  const open = s[start];
  if (open !== "[" && open !== "{") {
    const m = /^(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(s.slice(start));
    if (!m) throw new SyntaxError(`Expecting value: char ${start}`);
    return start + m[0].length;
  }
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new SyntaxError("Unterminated JSON value");
}

// --- states ---------------------------------------------------------------------------------------------------------

/** Whether a question in state `old` may go to `next`. Staying where it is is allowed: a repeat does nothing. */
export function canMove(old: string, next: string): boolean {
  return old === next || (TRANSITIONS[old] ?? []).includes(next);
}

interface RoleRow {
  names: string[];
  logins: string[];
}

let ROLES: Record<string, RoleRow> | null = null;

/** {address: {names, logins}} for the roles a message can be addressed to (`po`, `dev-manager`), from the project's
 * factory.json: the names that role's loops run under, and for the product owner the GitHub logins whose answers
 * count (`roles.product-owner.logins`; when empty, every login counts). {} when the config can't be read (then names stand for
 * themselves). Read once per process. */
export function roleTable(): Record<string, RoleRow> {
  if (ROLES === null) {
    try {
      const cfg = load();
      const logins = roleSetting(cfg, "product-owner", "logins", []);
      ROLES = { po: { names: roleNames(cfg, "product-owner"), logins: (Array.isArray(logins) ? logins : []).map(String) },
        [DEV_MANAGER]: { names: roleNames(cfg, "dev-manager"), logins: [] } };
    } catch {
      ROLES = {};
    }
  }
  return ROLES;
}

/** The address a sender answers for: a product owner's own name (eleni) is `po`, a dev manager's is `dev-manager`;
 * any other name is its own address. */
export function addressOf(name: string): string {
  for (const [address, row] of Object.entries(roleTable())) if (row.names.includes(name)) return address;
  return name;
}

/** Why message `m` may not move `task` where it says, or null. Only the addressee answers, works, asks for more
 * or fails a question; only the asker cancels it or resumes it after a clarification; a login in `trusted` may
 * do any of it. */
export function moveProblem(task: Task, m: Message, trusted: Iterable<string> = []): string | null {
  const allowed: readonly string[] = m.kind === "answer" ? ANSWER_STATES : STATUS_STATES;
  if (!allowed.includes(m.state)) return `A ${m.kind} sets one of ${allowed.join(", ")}, not ${m.state}.`;
  if (!canMove(task.state, m.state)) return `The question is ${task.state}; it can't move to ${m.state}.`;
  if (m.state === task.state || (m.login && new Set(trusted).has(m.login))) return null;
  const actor = addressOf(m.frm || (m.legacy ? DEV_MANAGER : ""));
  const asker = addressOf(task.frm);
  if (m.state === "canceled") return actor === asker ? null : `Only the asker (${task.frm || "unknown"}) can cancel a question.`;
  if (task.state === "input-required" && m.state === "working") {
    return actor === asker || actor === task.to ? null : `Only ${task.frm || "the asker"} or ${task.to} can resume it.`;
  }
  if (actor !== task.to) return `This question is addressed to ${task.to}, not ${actor || "an unnamed sender"}.`;
  const logins = roleTable()[actor]?.logins ?? [];
  if (logins.length && m.login && !logins.includes(m.login)) { // an answer for the product owner from a login nobody listed
    return `Only the logins listed in roles.product-owner.logins (${logins.join(", ")}) answer for ${actor}; ` +
      `${m.login} is not one of them, so this is ignored.`;
  }
  return null;
}

/** The tasks (questions) a thread's messages make, in order. A reply moves the question it names, or the one a
 * message in its chain belongs to, when the transition is valid and its sender may make it; anything else is listed
 * in `rejected`. A message whose id was seen before changes nothing, so posting it again is safe. */
export function fold(messages: Message[], trusted: Iterable<string> = []): Thread {
  const trust = [...trusted];
  const t = new Thread();
  for (const m of messages) {
    if (t.seen.has(m.id)) {
      t.duplicates.push(m);
      continue;
    }
    t.seen.add(m.id);
    if (m.kind === "question") {
      if (m.state !== "submitted") {
        t.rejected.push([m, `A question starts as submitted, not ${m.state}.`]);
        continue;
      }
      t.tasks.set(m.id, new Task(m, [["submitted", m]]));
      t.index.set(m.id, m.id);
    } else if (m.kind === "answer" && m.legacy) {
      for (const task of t.tasks.values()) if (task.isOpen && (task.question.legacy || task.to === DEV_MANAGER)) apply(t, task, m);
    } else if ((m.kind === "answer" || m.kind === "status") && m.inReplyTo) {
      const task = t.taskOf(m.inReplyTo);
      const why = !task ? `I can't find message ${m.inReplyTo} in this thread.` : moveProblem(task, m, trust);
      if (why || !task) t.rejected.push([m, why as string]);
      else apply(t, task, m);
    } else if (m.kind === "answer") t.rejected.push([m, "An answer says which message it replies to (in-reply-to)."]);
  }
  return t;
}

function apply(thread: Thread, task: Task, m: Message): void {
  thread.index.set(m.id, task.id);
  if (m.state !== task.state) {
    task.state = m.state;
    task.history.push([m.state, m]);
  }
  if (m.kind === "answer") task.answer = m;
}

/** Why a message an agent is about to post is refused, or null. `thread` is the fold of the thread it goes in
 * (null: only the checks that need no thread). Agents post as themselves, never approve or send must-fixes (the dev
 * manager's), and answer, work on or fail only a question addressed to them; invalid transitions are refused. */
export function checkNew(m: Message, thread: Thread | null, me: string | null = null): string | null {
  if (me && m.frm !== me) return `Post as yourself: from= is ${m.frm || "missing"}, and you are ${me}.`;
  if (me && (m.frm === "po" || m.frm === "owner")) {
    return `The name ${m.frm} stands for a role (the product owner, the owner), not an agent. Post under your own name.`;
  }
  if (m.kind === "approval" || m.kind === "mustfix") return "Approvals and must-fixes are reserved for the dev manager.";
  if (thread !== null && thread.seen.has(m.id)) return null; // the same message again changes nothing
  if (m.kind === "question") return m.state === "submitted" ? null : `A question starts as submitted, not ${m.state}.`;
  if (m.kind === "status" && !m.inReplyTo) {
    return (AGENT_STATES as readonly string[]).includes(m.state) ? null : `An agent's status is one of ${AGENT_STATES.join(", ")}.`;
  }
  if (!m.inReplyTo) return "An answer or a state change says which message it replies to: add in-reply-to=<id>.";
  if (thread === null) return null;
  const task = thread.taskOf(m.inReplyTo);
  if (!task) return `I can't find message ${m.inReplyTo} in this thread. Check the id with \`factory messages ls\`.`;
  return moveProblem(task, m);
}

// --- asking the thread ----------------------------------------------------------------------------------------------

export function refNumber(ref: string | null | undefined): string | null {
  const m = /^(?:(issue|pr))?#?(\d+)$/.exec(ref || "");
  return m ? (m[2] as string) : null;
}

/** `want` is 7, #7, pr#7 or issue#7; a bare number matches either kind. */
export function refMatches(have: string | null | undefined, want: string | null | undefined): boolean {
  const w = /^(?:(issue|pr)#|#)?(\d+)$/.exec(want || "");
  const h = REF.exec(have || "");
  if (!w || !h || w[2] !== h[2]) return false;
  return !w[1] || w[1] === h[1];
}

/** Tasks that are open (or in `state`, or in any state with `everyState`), addressed `to`, asked by `frm`,
 * about `ref`. */
export function select(tasks: Iterable<Task>, to: string | null = null, frm: string | null = null, state: string | null = null,
  ref: string | null = null, everyState = false): Task[] {
  const out: Task[] = [];
  for (const t of tasks) {
    if (state && t.state !== state) continue;
    if (!state && !everyState && !t.isOpen) continue;
    if ((to && t.to !== to) || (frm && t.frm !== frm) || (ref && !refMatches(t.ref, ref))) continue;
    out.push(t);
  }
  return out;
}

export interface Row {
  id: string;
  kind: string;
  from: string;
  to: string;
  state: string;
  ref: string;
  inReplyTo: string;
  sha: string;
  legacy: boolean;
  thread: number;
  url: string;
  created: string;
  summary: string;
}

export function row(m: Message, state: string, thread: number): Row {
  return { id: m.id, kind: m.kind, from: m.frm, to: m.to, state, ref: m.ref, inReplyTo: m.inReplyTo, sha: m.sha,
    legacy: m.legacy, thread, url: m.url, created: m.created, summary: m.summary };
}

export interface LsArgs {
  to: string | null;
  frm: string | null;
  state: string | null;
  ref: string | null;
  kind: string;
  all: boolean;
  json: boolean;
  fresh?: boolean;
}

/** The to / from / state / ref filters, for rows that are plain messages (questions are filtered as tasks). */
function wanted(r: Row, a: LsArgs): boolean {
  return !((a.to && r.to !== a.to) || (a.frm && r.from !== a.frm) || (a.state && r.state !== a.state) ||
    (a.ref && !refMatches(r.ref, a.ref)));
}

function itemsToRead(a: LsArgs): Issue[] {
  if (!a.ref) return ghAll("repos/{owner}/{repo}/issues?state=open");
  const number = refNumber(a.ref);
  if (!number) refuse("bad-ref", `'${a.ref}' isn't an issue or PR number.`, "Use a number, or issue#<n> / pr#<n>.");
  const item = gh<Issue | null>("GET", `repos/{owner}/{repo}/issues/${number}`, undefined, true);
  if (!item) refuse("no-such-item", `There is no issue or PR #${number}.`, "Check the number with `gh pr list`.");
  return [item];
}

/** The rows `factory messages ls` shows, from the open issues and PRs (or the one item `--ref` names, open or
 * not). Agent issues are read for their status only, and only for kind status or all. */
export function collect(cfg: Config, a: LsArgs): Row[] {
  const trusted = new Set((cfg.trustedReviewers as string[] | undefined) || []);
  const rows: Row[] = [];
  for (const item of itemsToRead(a)) {
    const n = item.number;
    const defaultRef = (item.pull_request ? "pr#" : "issue#") + n;
    if (item.labels.some((x) => x.name === "factory:agent")) {
      if (a.kind === "status" || a.kind === "all") {
        const statuses = messagesOf([{ body: item.body || "", html_url: item.html_url ?? null }], defaultRef);
        rows.push(...statuses.filter((m) => m.kind === "status").map((m) => row(m, m.state, n)).filter((r) => wanted(r, a)));
      }
      continue;
    }
    if (!(item.comments ?? 1)) continue; // nothing was said there: no call
    const messages = messagesOf(ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`) as CommentLike[], defaultRef);
    if (a.kind === "question" || a.kind === "all") {
      const thread = fold(messages, trusted);
      rows.push(...select(thread.tasks.values(), a.to, a.frm, a.state, a.ref, a.all).map((t) => row(t.question, t.state, n)));
    }
    const plain = messages.filter((m) => ["answer", "mustfix", "approval"].includes(m.kind) && (a.kind === "all" || a.kind === m.kind))
      .map((m) => row(m, m.state, n));
    rows.push(...plain.filter((r) => wanted(r, a)));
  }
  return rows.sort((x, y) => (x.created < y.created ? -1 : x.created > y.created ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function line(r: Row): string {
  return `${r.id.padEnd(14)} ${r.state.padEnd(14)} ${r.from || "?"} -> ${r.to || "?"}  ${r.ref || "-"}  ${r.summary}`;
}

// --- the command ----------------------------------------------------------------------------------------------------

function cmdLs(a: LsArgs): void {
  const every = [...KINDS, "all"];
  if (!every.includes(a.kind)) refuse("bad-kind", `'${a.kind}' isn't a message kind.`, `Use one of: ${every.join(", ")}.`);
  const states = [...STATES, "idle", "down"];
  if (a.state && !states.includes(a.state)) refuse("bad-state", `'${a.state}' isn't a message state.`, `Use one of: ${states.join(", ")}.`);
  const cfg = load();
  const args = ["ls", ...([["--to", a.to], ["--from", a.frm], ["--state", a.state], ["--ref", a.ref], ["--kind", a.kind]] as const)
    .flatMap(([flag, v]) => (v ? [flag, v] : [])), ...(a.all ? ["--all"] : [])];
  const got = answer(cfg, { name: "messages", hook: import.meta.path, args }, Boolean(a.fresh), () => collect(cfg, a));
  const rows = got.data;
  if (a.json) console.log(pyDumps(rows, { indent: 2 }));
  else if (rows.length) console.log(rows.map(line).join("\n"));
  else console.log("no messages" + (a.state ? "" : " waiting"));
  sayAge(got.age, a.json);
}

interface NewArgs {
  kind: string;
  to: string;
  frm: string | null;
  ref: string | null;
  inReplyTo: string | null;
  state: string | null;
  sha: string | null;
  id: string | null;
  noLegacy: boolean;
}

function cmdNew(a: NewArgs): void {
  if (!(KINDS as readonly string[]).includes(a.kind)) refuse("bad-kind", `'${a.kind}' isn't a message kind.`, `Use one of: ${KINDS.join(", ")}.`);
  const frm = a.frm || process.env.FACTORY_AGENT || "";
  if (!frm) refuse("needs-from", "I don't know who is writing this message.", "Pass --from <name>, or run it as an agent (FACTORY_AGENT).");
  const state = a.state || DEFAULT_STATE[a.kind] || "working";
  const allowed: readonly string[] = { question: ["submitted"], mustfix: ["submitted"], approval: ["completed"],
    answer: ANSWER_STATES, status: a.inReplyTo ? STATUS_STATES : AGENT_STATES }[a.kind] as readonly string[];
  if (!allowed.includes(state)) refuse("bad-state", `A ${a.kind} can't be ${state}.`, `Use one of: ${allowed.join(", ")}.`);
  for (const [flag, value] of [["--from", frm], ["--to", a.to]] as const) {
    if (!NAME.test(value)) refuse("bad-name", `'${value}' isn't a valid name for ${flag}.`, "Use lowercase letters, digits and dashes, e.g. po or haile.");
  }
  if (a.ref && !REF.test(a.ref)) refuse("bad-ref", `'${a.ref}' isn't a ref.`, "Use issue#<n> or pr#<n>.");
  if (a.kind === "answer" && !a.inReplyTo) refuse("needs-in-reply-to", "An answer says which message it replies to.", "Add --in-reply-to <id of the question>.");
  if ((a.kind === "mustfix" || a.kind === "approval") && !(a.sha && SHA.test(a.sha))) {
    refuse("needs-sha", `A ${a.kind} names the commit it is for.`, "Add --sha <head commit, 7 to 40 hex characters>.");
  }
  const m = new Message({ id: a.id || newId(), kind: a.kind, frm, to: a.to, state, ref: a.ref || "", inReplyTo: a.inReplyTo || "", sha: a.sha || "" });
  if (!ID.test(m.id)) refuse("bad-id", `'${m.id}' isn't a valid message id.`, "Use 3 to 40 letters, digits, dashes or underscores, or leave --id out.");
  console.log(render(m));
  if (!a.noLegacy && legacyLine(m)) console.log(legacyLine(m));
}

export function main(argv: string[]): void {
  const prog = "factory messages";
  const cmd = argv[0];
  if (cmd !== "ls" && cmd !== "new") {
    process.stderr.write(`usage: ${prog} [-h] {ls,new} ...\n${prog}: error: ` +
      (cmd ? `argument cmd: invalid choice: '${cmd}' (choose from 'ls', 'new')` : "the following arguments are required: cmd") + "\n");
    throw new Exit(2);
  }
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  if (cmd === "ls") {
    const a = parseArgs(argv.slice(1), { valued: ["--to", "--from", "--state", "--ref", "--kind"], flags: ["--all", "--json", "--fresh"] },
      `${prog} ls`, `usage: ${prog} ls [-h] [--to TO] [--from FRM] [--state STATE] [--ref REF] [--kind KIND] [--all] [--json] [--fresh]`);
    cmdLs({ to: s(a.to), frm: s(a.from), state: s(a.state), ref: s(a.ref), kind: s(a.kind) ?? "question", all: Boolean(a.all),
      json: Boolean(a.json), fresh: Boolean(a.fresh) });
  } else {
    const a = parseArgs(argv.slice(1), { valued: ["--kind", "--to", "--from", "--ref", "--in-reply-to", "--state", "--sha", "--id"],
      flags: ["--no-legacy"], required: ["--kind"] }, `${prog} new`, `usage: ${prog} new [-h] --kind KIND [--to TO] [--from FRM] ...`);
    cmdNew({ kind: a.kind as string, to: s(a.to) ?? DEV_MANAGER, frm: s(a.from), ref: s(a.ref), inReplyTo: s(a["in-reply-to"]),
      state: s(a.state), sha: s(a.sha), id: s(a.id), noLegacy: Boolean(a["no-legacy"]) });
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
