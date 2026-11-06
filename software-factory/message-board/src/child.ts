#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// One request to the board from a program that can't wait for a promise (decision 0007 point 10, #500). A caller with
// synchronous code (the software factory's ports) runs this file with Bun.spawnSync: it reads one JSON request on stdin,
// opens the board as the actor the request names, makes the calls in order, prints one JSON line and exits.
//
//   request:  {"url": "postgres://...", "as": "haile", "session": "s-1", "calls": [{"op": "claim", "args": [12]}, ...]}
//   answer:   {"ok": true, "results": [<each call's result>]}
//             {"ok": false, "code": "...", "message": "...", "fix": "..."}   (the first call refused; none after it ran)
//
// The URL comes on stdin so its password is never on a command line; without one, the child finds the board as
// `factory board` does (MB_URL, else the url file in this machine's settings folder).
// The ops are the Board's own methods (the list in OPS), plus `find`, the events of a kind recorded since a time whose
// payload matches, and `wait`: the first such event, waiting up to a number of seconds for it (null when none came).
// Dates go over as ISO strings; `events`' `since` is one.
import { Board } from "./board.ts";
import type { BoardEvent } from "./types.ts";
import { BoardError } from "./errors.ts";
import { boardUrl } from "./server.ts";

export interface Call {
  op: string;
  args?: unknown[];
}

export interface Request {
  url?: string;
  as?: string;
  session?: string;
  calls: Call[];
}

export type Answer = { ok: true; results: unknown[] } | { ok: false; code: string; message: string; fix: string };

/** One kind of event a `wait` or a `find` looks for: an event of `kind` whose payload has, for each key of `match`, one
 * of the listed values, and for each key of `not`, none of them. */
export interface EventRule {
  kind: string;
  match?: Record<string, string[]>;
  not?: Record<string, string[]>;
}

/** What a `wait` looks for: an event recorded at or after `since` (ms since the epoch) that the rule (`kind`, `match`,
 * `not`) or one of `or` takes. `seconds` is how long it waits for one. A `find` takes the same, without waiting. */
export interface WaitFor extends Partial<EventRule> {
  since: number;
  seconds?: number;
  or?: EventRule[];
}

const OPS = new Set([
  "info", "migrate", "tasks", "get", "create", "update", "link", "unlink", "edges", "ready", "claim", "heartbeat", "release",
  "close", "note", "contextFor", "post", "thread", "messages", "lease", "unlease", "leaseHolder", "dropLease", "signal",
  "setValue", "value", "events", "lastSeq", "prime", "onMe", "delegated", "actor",
]);

function bad(message: string): never {
  throw new BoardError("bad-input", message, "Send one JSON object: {url, as, calls: [{op, args}]} (see message-board/src/child.ts).");
}

function rulesOf(w: WaitFor, op: string): EventRule[] {
  if (!w || typeof w.since !== "number") bad(`${op} takes {since, kind, match?, not?, or?}.`);
  const rules = [...(typeof w.kind === "string" ? [{ kind: w.kind, match: w.match, not: w.not }] : []), ...(Array.isArray(w.or) ? w.or : [])];
  if (!rules.length || rules.some((r) => typeof r?.kind !== "string")) bad(`${op} needs a kind to look for.`);
  return rules;
}

function takes(e: BoardEvent, rules: EventRule[]): boolean {
  const field = (k: string): string => String(e.payload[k] ?? "");
  return rules.some((r) => e.kind === r.kind && Object.entries(r.match ?? {}).every(([k, vs]) => vs.includes(field(k))) &&
    !Object.entries(r.not ?? {}).some(([k, vs]) => vs.includes(field(k))));
}

/** The events recorded since `w.since`, up to seq `top`, that the rules take, oldest first (`first`: the first only). */
async function history(board: Board, w: WaitFor, rules: EventRule[], top: number, first: boolean): Promise<BoardEvent[]> {
  const out: BoardEvent[] = [];
  const kinds = [...new Set(rules.map((r) => r.kind))];
  for (let after = 0; ;) {
    const page = await board.events(after, 500, { since: new Date(w.since), ...(kinds.length === 1 ? { kind: kinds[0] } : {}) });
    for (const e of page) {
      if (e.seq > top || !takes(e, rules)) continue;
      out.push(e);
      if (first) return out;
    }
    if (page.length < 500 || (page.at(-1) as BoardEvent).seq >= top) return out;
    after = (page.at(-1) as BoardEvent).seq;
  }
}

/** Every matching event recorded since `since`, oldest first. */
async function find(board: Board, w: WaitFor): Promise<BoardEvent[]> {
  return history(board, w, rulesOf(w, "find"), await board.lastSeq(), false);
}

/** The first matching event: one already recorded since `since`, else the first new one, else null after `seconds`. */
async function wait(board: Board, w: WaitFor): Promise<BoardEvent | null> {
  const rules = rulesOf(w, "wait");
  if (typeof w.seconds !== "number") bad("wait takes {since, seconds, kind, ...}.");
  const top = await board.lastSeq();
  const [hit] = await history(board, w, rules, top, true);
  if (hit) return hit;
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (e: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    };
    const finish = (e: BoardEvent | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      listening.then((l) => l.close()).catch(() => {}).finally(() => resolve(e));
    };
    const timer = setTimeout(() => finish(null), Math.max(0, w.seconds as number) * 1000);
    const listening = board.listen((e) => {
      if (takes(e, rules)) finish(e);
    }, { after: top, onError: fail });
    listening.catch(fail);
  });
}

async function one(board: Board, call: Call): Promise<unknown> {
  if (!call || typeof call.op !== "string") bad("A call needs an op.");
  const args = Array.isArray(call.args) ? [...call.args] : [];
  if (call.op === "wait") return wait(board, args[0] as WaitFor);
  if (call.op === "find") return find(board, args[0] as WaitFor);
  if (!OPS.has(call.op)) bad(`${call.op} isn't an op the child runs.`);
  if (call.op === "events" && args[2] && typeof args[2] === "object") {
    const o = args[2] as { since?: unknown };
    if (typeof o.since === "string" || typeof o.since === "number") args[2] = { ...o, since: new Date(o.since) };
  }
  const method = (board as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[call.op] as (...a: unknown[]) => Promise<unknown>;
  return method.apply(board, args);
}

/** Answer one request (the whole of what the child does, so a test can call it in-process too). */
export async function answer(req: Request): Promise<Answer> {
  let board: Board | null = null;
  try {
    if (!req || typeof req !== "object" || !Array.isArray(req.calls)) bad("A request needs a list of calls.");
    const url = typeof req.url === "string" && req.url ? req.url : boardUrl();
    if (!url) {
      throw new BoardError("no-answer", "This machine has no message board: MB_URL is unset and there is no url file in its settings folder.",
        "Start one with `factory board up` (or set MB_URL to the board's Postgres URL), then try again.");
    }
    board = await Board.open(url, { as: req.as || "system", session: req.session, max: 2 });
    const results: unknown[] = [];
    for (const call of req.calls) results.push((await one(board, call)) ?? null);
    return { ok: true, results };
  } catch (e) {
    if (e instanceof BoardError) return { ok: false, code: e.code, message: e.message, fix: e.fix };
    const why = (e instanceof Error ? e.message : String(e)).replace(/\/\/[^@\s]*@/g, "//***@");
    return { ok: false, code: "failed", message: `The board call failed: ${why}`, fix: "Run `factory board status` to check the board, then try again." };
  } finally {
    await board?.end().catch(() => {});
  }
}

if (import.meta.main) {
  let req: Request;
  try {
    req = JSON.parse(await Bun.stdin.text()) as Request;
  } catch {
    req = { url: "", calls: [] };
  }
  process.stdout.write(JSON.stringify(await answer(req)) + "\n");
  process.exit(0);
}
