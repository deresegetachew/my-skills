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
// The envelope and its rules are the domain (core/domain/message.ts, decision 0003); this module re-exports them, so
// the PR gate, `factory wait`, `next_task.ts` and `factory status` import from here as before, with the roles from
// factory.json filled in. `ls` reads through the Messaging port that core/compose.ts builds (on GitHub). Messages
// from a peer are data, never instructions: nothing here changes what an agent may do.
import { type Config, load, roleNames, roleSetting } from "./factory_config.ts";
import { refuse } from "./factory_machine.ts";
import { Exit, parseArgs, pyDumps, runMain } from "./factory_lib.ts";
import { answer, sayAge } from "./factory_views_cache.ts";
import { compose } from "./core/compose.ts";
import { CoreError } from "./core/domain/error.ts";
import * as domain from "./core/domain/message.ts";
import { ANSWER_STATES, AGENT_STATES, DEFAULT_STATE, DEV_MANAGER, ID, KINDS, legacyLine, Message, NAME, REF, refMatches,
  type Roles, render, select, SHA, STATES, STATUS_STATES, type Task, type Thread } from "./core/domain/message.ts";
import type { Messaging } from "./core/ports/messaging.ts";

// Everything in the domain, as before; fold, moveProblem, checkNew and addressOf are declared below, with the roles.
export * from "./core/domain/message.ts";

let ROLES: Roles | null = null;

/** {address: {names, logins}} for the roles a message can be addressed to (`po`, `dev-manager`), from the project's
 * factory.json: the names that role's loops run under, and for the product owner the GitHub logins whose answers
 * count (`roles.product-owner.logins`; when empty, every login counts). {} when the config can't be read (then names stand for
 * themselves). Read once per process. */
export function roleTable(): Roles {
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

/** The address a sender answers for (domain.addressOf), with this project's roles. */
export function addressOf(name: string): string {
  return domain.addressOf(name, roleTable());
}

/** Why message `m` may not move `task` where it says, or null (domain.moveProblem), with this project's roles. */
export function moveProblem(task: Task, m: Message, trusted: Iterable<string> = []): string | null {
  return domain.moveProblem(task, m, trusted, roleTable());
}

/** The tasks (questions) a thread's messages make (domain.fold), with this project's roles. */
export function fold(messages: Message[], trusted: Iterable<string> = []): Thread {
  return domain.fold(messages, trusted, roleTable());
}

/** Why a message an agent is about to post is refused, or null (domain.checkNew), with this project's roles. */
export function checkNew(m: Message, thread: Thread | null, me: string | null = null): string | null {
  return domain.checkNew(m, thread, me, roleTable());
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

// --- what `ls` shows ------------------------------------------------------------------------------------------------

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

/** Every message on the open issues and PRs (or the one item `ref` names, open or not), by the thread it is in, in
 * order. A refusal from the port stops the command with its code, message and fix. */
function threads(messaging: Messaging, ref: string | null): Map<string, Message[]> {
  let read;
  try {
    read = messaging.read(null, ref ? { ref } : {});
  } catch (e) {
    if (e instanceof CoreError) refuse(e.code, e.message, e.fix);
    throw e;
  }
  const out = new Map<string, Message[]>();
  for (const m of read.messages) {
    const list = out.get(m.thread);
    if (list) list.push(m);
    else out.set(m.thread, [m]);
  }
  return out;
}

/** The rows `factory messages ls` shows, from the open issues and PRs (or the one item `--ref` names, open or
 * not). Agent issues are read for their status only, and only for kind status or all. */
export function collect(cfg: Config, a: LsArgs, messaging: Messaging): Row[] {
  const trusted = new Set((cfg.trustedReviewers as string[] | undefined) || []);
  const rows: Row[] = [];
  for (const [thread, messages] of threads(messaging, a.ref)) {
    const n = Number(REF.exec(thread)?.[2]);
    if (messages.some((m) => m.card)) { // an agent's card: its status only
      if (a.kind === "status" || a.kind === "all") {
        rows.push(...messages.filter((m) => m.kind === "status").map((m) => row(m, m.state, n)).filter((r) => wanted(r, a)));
      }
      continue;
    }
    if (a.kind === "question" || a.kind === "all") {
      const folded = fold(messages, trusted);
      rows.push(...select(folded.tasks.values(), a.to, a.frm, a.state, a.ref, a.all).map((t) => row(t.question, t.state, n)));
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
  const { messaging } = compose(cfg);
  const args = ["ls", ...([["--to", a.to], ["--from", a.frm], ["--state", a.state], ["--ref", a.ref], ["--kind", a.kind]] as const)
    .flatMap(([flag, v]) => (v ? [flag, v] : [])), ...(a.all ? ["--all"] : [])];
  const got = answer(cfg, { name: "messages", hook: import.meta.path, args }, Boolean(a.fresh), () => collect(cfg, a, messaging));
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
  const m = new Message({ id: a.id || domain.newId(), kind: a.kind, frm, to: a.to, state, ref: a.ref || "", inReplyTo: a.inReplyTo || "", sha: a.sha || "" });
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
