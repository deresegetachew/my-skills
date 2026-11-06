#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// One request to the board from a program that can't wait for a promise (decision 0007 point 10, #500). A caller with
// synchronous code (the software factory's ports) runs this file with Bun.spawnSync: it reads one JSON request on stdin,
// opens the board as the actor the request names, makes the calls in order, prints one JSON line and exits.
//
//   request:  {"url": "postgres://...", "as": "haile", "session": "s-1", "calls": [{"op": "claim", "args": [12]}, ...]}
//   answer:   {"ok": true, "results": [<each call's result>]}
//             {"ok": false, "code": "...", "message": "...", "fix": "..."}   (the first call refused; none after it ran)
//
// The URL comes on stdin so its password is never on a command line. The ops are the Board's own methods (the list in
// OPS), plus `wait`: the first event of a kind, recorded since a time, whose payload matches, waiting up to a number of
// seconds for it (null when none came). Dates go over as ISO strings; `events`' `since` is one.
import { Board } from "./board.ts";
import type { BoardEvent } from "./types.ts";
import { BoardError } from "./errors.ts";

export interface Call {
  op: string;
  args?: unknown[];
}

export interface Request {
  url: string;
  as?: string;
  session?: string;
  calls: Call[];
}

export type Answer = { ok: true; results: unknown[] } | { ok: false; code: string; message: string; fix: string };

/** What a `wait` looks for: an event of `kind` recorded at or after `since` (ms since the epoch) whose payload has, for
 * each key of `match`, one of the listed values, and for each key of `not`, none of them. */
export interface WaitFor {
  kind: string;
  since: number;
  seconds: number;
  match?: Record<string, string[]>;
  not?: Record<string, string[]>;
}

const OPS = new Set([
  "info", "migrate", "tasks", "get", "create", "update", "link", "unlink", "edges", "ready", "claim", "heartbeat", "release",
  "close", "note", "contextFor", "post", "thread", "messages", "lease", "unlease", "leaseHolder", "dropLease", "signal",
  "events", "lastSeq", "prime", "onMe", "delegated", "actor",
]);

function bad(message: string): never {
  throw new BoardError("bad-input", message, "Send one JSON object: {url, as, calls: [{op, args}]} (see message-board/src/child.ts).");
}

function matches(e: BoardEvent, w: WaitFor): boolean {
  const field = (k: string): string => String(e.payload[k] ?? "");
  for (const [k, vs] of Object.entries(w.match ?? {})) if (!vs.includes(field(k))) return false;
  for (const [k, vs] of Object.entries(w.not ?? {})) if (vs.includes(field(k))) return false;
  return true;
}

/** The first matching event: one already recorded since `since`, else the first new one, else null after `seconds`. */
async function wait(board: Board, w: WaitFor): Promise<BoardEvent | null> {
  if (typeof w?.kind !== "string" || typeof w.since !== "number" || typeof w.seconds !== "number") bad("wait takes {kind, since, seconds}.");
  const top = await board.lastSeq();
  for (let after = 0; ;) {
    const page = await board.events(after, 500, { since: new Date(w.since), kind: w.kind });
    const hit = page.find((e) => e.seq <= top && matches(e, w));
    if (hit) return hit;
    if (page.length < 500 || (page.at(-1) as BoardEvent).seq >= top) break;
    after = (page.at(-1) as BoardEvent).seq;
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (e: BoardEvent | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      listening.then((l) => l.close()).catch(() => {}).finally(() => resolve(e));
    };
    const timer = setTimeout(() => finish(null), Math.max(0, w.seconds) * 1000);
    const listening = board.listen((e) => {
      if (e.kind === w.kind && matches(e, w)) finish(e);
    }, { after: top, onError: (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } } });
    listening.catch((e: unknown) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}

async function one(board: Board, call: Call): Promise<unknown> {
  if (!call || typeof call.op !== "string") bad("A call needs an op.");
  const args = Array.isArray(call.args) ? [...call.args] : [];
  if (call.op === "wait") return wait(board, args[0] as WaitFor);
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
    if (!req || typeof req.url !== "string" || !req.url || !Array.isArray(req.calls)) bad("A request needs a url and a list of calls.");
    board = await Board.open(req.url, { as: req.as || "system", session: req.session, max: 2 });
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
