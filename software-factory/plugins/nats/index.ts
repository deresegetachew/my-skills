// The NATS transport (decision 0004, #409): the Messaging port over JetStream, and claims over its key-value bucket.
// The core loads it with hooks/factory_plugins.ts when `messaging.transport` is "nats" and calls createMessaging().
//
// Where things go (0004 point 6):
//   - one stream per project, `factory-<project>`, holding `factory.<project>.>`;
//   - a message to issue or PR n from <from> is published on `factory.<project>.<issue|pr>.<n>.<from>` as JSON with the
//     envelope's fields (v, id, kind, from, to, state, ref, in-reply-to, sha) plus text and at;
//   - claims are the key-value bucket `claims-<project>`: a value names its holder and until when it holds.
// A reader drops a message whose `from` isn't its subject's last token (the sender the server's permissions checked).
//
// The cursor is the stream's sequence (`nats1:<seq>`): a read gives every matching message after it, so a reader that
// was away gets what it missed, as a durable consumer would, but the reader keeps its cursor wherever it keeps GitHub's.
//
// The port is synchronous and the NATS client is not. Each call runs this same file (the source, or the release's
// bundle) as a child Bun with Bun.spawnSync, which connects, does the one thing, prints the answer as JSON on stdout and
// exits: no new dependency, no state shared between calls, and a hung server costs at most the call's time limit.
import { readFileSync } from "node:fs";
import { DiscardPolicy, jetstream, jetstreamManager, type JetStreamManager, RetentionPolicy, StorageType }
  from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, type NatsConnection, nanos, nkeyAuthenticator } from "@nats-io/transport-node";
import { CoreError } from "../../hooks/core/domain/error.ts";
import { badCursor, ID, Message, NAME, needsRef, REF, unknownMessage, visible } from "../../hooks/core/domain/message.ts";
import type { Cursor, Messaging, Read, Scope } from "../../hooks/core/ports/messaging.ts";

export interface NatsOptions {
  url: string; // nats://<address>:4222 or tls://
  project: string; // lowercase letters, digits and dashes
  seed?: string; // a file holding this agent's nkey seed (<creds>/<name>.nk); none: connect without credentials
  timeoutMs?: number; // how long one call may take in all (default 10 s); connecting gets a third of it
}

export interface ClaimResult {
  held: boolean; // the caller holds it now
  holder: string; // who holds it
}

const PREFIX = "nats1:";
const PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLAIM_KEY = /^[-_=.a-zA-Z0-9/]+$/;
const HELPER_ENV = "FACTORY_NATS_HELPER";

type Op =
  | { op: "check" }
  | { op: "send"; subject: string; msgId: string; payload: string }
  | { op: "read"; after: number; filter: string }
  | { op: "claim"; key: string; holder: string; ttl: number }
  | { op: "release"; key: string; holder: string };

type Answer = { ok: true; result: unknown } | { ok: false; code: string; message: string; fix: string };

interface Stored {
  seq: number;
  subject: string;
  data: string;
}

/** The NATS Messaging port for one project (plus claims, which the port doesn't have yet). Refuses (`bad-project`) a
 * project name that isn't a NATS subject token. */
export function createMessaging(opts: NatsOptions): NatsMessaging {
  return new NatsMessaging(opts);
}

export class NatsMessaging implements Messaging {
  private known = new Set<string>();
  private readonly opts: NatsOptions;

  constructor(opts: NatsOptions) {
    if (!PROJECT.test(opts.project)) {
      throw new CoreError("bad-project", `'${opts.project}' can't name a NATS stream: use lowercase letters, digits and dashes.`,
        "The project's name comes from its origin remote; rename the remote's repository, or report it as a bug.");
    }
    this.opts = opts;
  }

  /** Throws nats-unreachable (or nats-creds) when the server can't be reached or refuses this agent. */
  check(): void {
    this.call({ op: "check" });
  }

  send(m: Message, text: string): Message {
    const ref = REF.exec(m.ref);
    if (!ref) throw needsRef(m);
    const payload = JSON.stringify({ v: 1, id: m.id, kind: m.kind, from: m.frm, to: m.to, state: m.state, ref: m.ref,
      "in-reply-to": m.inReplyTo, sha: m.sha, text, at: new Date().toISOString() });
    this.call({ op: "send", subject: `${this.base()}.${ref[1]}.${ref[2]}.${m.frm || "-"}`, msgId: `${m.ref}:${m.id}`, payload });
    this.known.add(m.id);
    return m;
  }

  read(cursor: Cursor | null, scope: Scope = {}): Read {
    const after = cursor === null ? 0 : position(cursor);
    const got = this.call({ op: "read", after, filter: this.filter(scope.ref) }) as { last: number; messages: Stored[] };
    const seen = new Set<string>(); // an id once per thread, as the other transports read it
    const messages: Message[] = [];
    for (const s of got.messages) {
      const m = parse(s, this.base());
      if (!m || seen.has(`${m.thread} ${m.id}`)) continue;
      seen.add(`${m.thread} ${m.id}`);
      this.known.add(m.id);
      messages.push(m);
    }
    return { messages, cursor: PREFIX + Math.max(after, got.last) };
  }

  ack(id: string): void {
    if (!this.known.has(id)) throw unknownMessage(id);
  }

  /** Take claim `key` for `holder` for `ttl` seconds, or say who holds it. Taking it again refreshes it. */
  claim(key: string, holder: string, ttl: number): ClaimResult {
    checkKey(key);
    return this.call({ op: "claim", key, holder, ttl }) as ClaimResult;
  }

  /** Give claim `key` back. False (and nothing changes) when `holder` doesn't hold it. */
  release(key: string, holder: string): boolean {
    checkKey(key);
    return this.call({ op: "release", key, holder }) as boolean;
  }

  private base(): string {
    return `factory.${this.opts.project}`;
  }

  private filter(ref: string | undefined): string {
    if (!ref) return `${this.base()}.>`;
    const m = /^(?:(issue|pr)#|#)?(\d+)$/.exec(ref);
    if (!m) throw new CoreError("bad-ref", `'${ref}' isn't an issue or PR number.`, "Use a number, or issue#<n> / pr#<n>.");
    return `${this.base()}.${m[1] ?? "*"}.${m[2]}.*`;
  }

  /** Run one operation in a child Bun (see the top of the file) and give back its result or throw its error. */
  private call(op: Op): unknown {
    const timeout = this.opts.timeoutMs ?? 10_000;
    const request = JSON.stringify({ ...op, url: this.opts.url, project: this.opts.project, seed: this.opts.seed ?? "", timeout });
    const p = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", import.meta.path], {
      stdin: Buffer.from(request), stdout: "pipe", stderr: "pipe", timeout: timeout + 5_000,
      env: { ...process.env, [HELPER_ENV]: "1", NO_COLOR: "1" },
    });
    let answer: Answer | null = null;
    try {
      answer = JSON.parse(p.stdout.toString().trim().split("\n").at(-1) ?? "") as Answer;
    } catch {
      answer = null;
    }
    if (!answer) {
      const why = p.signalCode ? `it took longer than ${Math.round(timeout / 1000)} s` : (p.stderr.toString().trim().split("\n").at(-1) ?? `exit ${p.exitCode}`);
      throw unreachable(this.opts.url, why);
    }
    if (!answer.ok) throw new CoreError(answer.code, answer.message, answer.fix);
    return answer.result;
  }
}

function position(cursor: Cursor): number {
  const m = /^nats1:(\d+)$/.exec(cursor);
  if (!m) throw badCursor(cursor);
  return Number(m[1]);
}

function checkKey(key: string): void {
  if (!CLAIM_KEY.test(key)) {
    throw new CoreError("bad-claim-key", `'${key.slice(0, 60)}' can't be a claim key: use letters, digits and - _ = . /.`,
      "Name the claim like task.409 or pr.12.review.");
  }
}

function unreachable(url: string, why: string): CoreError {
  return new CoreError("nats-unreachable", `The NATS server at ${url} can't be reached: ${why.slice(0, 200)}`,
    "Check that it runs (`factory nats status`) and that messaging.url is its address; `factory doctor` checks both.");
}

/** The Message a stored JetStream message holds, or null when it isn't a valid one from the sender its subject names. */
function parse(s: Stored, base: string): Message | null {
  const sub = new RegExp(`^${base.replace(/[.-]/g, "\\$&")}\\.(issue|pr)\\.(\\d+)\\.([^.]+)$`).exec(s.subject);
  if (!sub) return null;
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(s.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");
  const thread = `${sub[1]}#${sub[2]}`;
  const frm = str("from");
  if (b.v !== 1 || !ID.test(str("id")) || !str("kind") || str("ref") !== thread || (frm || "-") !== sub[3]) return null;
  if ((frm && !NAME.test(frm)) || !NAME.test(str("to") || "x")) return null;
  return new Message({ id: str("id"), kind: str("kind"), frm, to: str("to"), state: str("state"), ref: thread,
    inReplyTo: str("in-reply-to"), sha: str("sha"), summary: visible(str("text")), thread, created: str("at") });
}

// --- the child: one operation against the server ---------------------------------------------------------------------

interface Request {
  op: Op["op"];
  url: string;
  project: string;
  seed: string;
  timeout: number;
  [key: string]: unknown;
}

async function helper(): Promise<Answer> {
  const req = JSON.parse(await Bun.stdin.text()) as Request;
  let seed: Uint8Array | undefined;
  if (req.seed) {
    try {
      seed = new TextEncoder().encode(readFileSync(req.seed, "utf8").trim());
    } catch (e) {
      return { ok: false, code: "nats-creds", message: `This agent's NATS seed ${req.seed} can't be read: ${(e as Error).message}`,
        fix: "Make it with `factory nats user add <name> --role <role>`, or set messaging.creds to the folder that holds it." };
    }
  }
  let nc: NatsConnection;
  try {
    nc = await connect({ servers: req.url, timeout: Math.max(1000, Math.floor(req.timeout / 3)), reconnect: false,
      maxReconnectAttempts: 0, ...(seed ? { authenticator: nkeyAuthenticator(seed) } : {}) });
  } catch (e) {
    const u = unreachable(req.url, (e as Error).message || String(e));
    return { ok: false, code: u.code, message: u.message, fix: u.fix };
  }
  try {
    return { ok: true, result: await run(nc, req) };
  } catch (e) {
    if (e instanceof CoreError) return { ok: false, code: e.code, message: e.message, fix: e.fix };
    const u = unreachable(req.url, (e as Error).message || String(e));
    return { ok: false, code: u.code, message: u.message, fix: u.fix };
  } finally {
    await nc.close().catch(() => {});
  }
}

const streamName = (project: string): string => `factory-${project}`;

async function ensureStream(jsm: JetStreamManager, project: string): Promise<void> {
  try {
    await jsm.streams.info(streamName(project));
  } catch {
    await jsm.streams.add({ name: streamName(project), subjects: [`factory.${project}.>`], storage: StorageType.File,
      retention: RetentionPolicy.Limits, discard: DiscardPolicy.Old, allow_direct: true,
      duplicate_window: nanos(60 * 60 * 1000) }).catch(async (e: unknown) => {
      await jsm.streams.info(streamName(project)).catch(() => {
        throw e; // made by someone else meanwhile is fine; anything else is not
      });
    });
  }
}

async function run(nc: NatsConnection, req: Request): Promise<unknown> {
  const jsm = await jetstreamManager(nc, { timeout: req.timeout });
  const project = req.project;
  if (req.op === "check") return true;
  if (req.op === "send") {
    await ensureStream(jsm, project);
    await jetstream(nc, { timeout: req.timeout }).publish(req.subject as string, req.payload as string, { msgID: req.msgId as string });
    return true;
  }
  if (req.op === "read") return read(jsm, project, req.after as number, req.filter as string);
  const kv = await new Kvm(nc).create(`claims-${project}`, { history: 1 });
  const key = req.key as string;
  const holder = req.holder as string;
  const current = async (): Promise<{ holder: string; until: number; revision: number } | null> => {
    const e = await kv.get(key);
    if (!e || e.operation !== "PUT") return null;
    const v = e.json<{ holder?: unknown; until?: unknown }>();
    return { holder: String(v.holder ?? ""), until: Number(v.until ?? 0), revision: e.revision };
  };
  if (req.op === "release") {
    const c = await current();
    if (!c || c.holder !== holder) return false;
    try {
      await kv.delete(key, { previousSeq: c.revision });
      return true;
    } catch {
      return false; // it changed meanwhile: whoever changed it holds it
    }
  }
  const value = JSON.stringify({ holder, until: Date.now() + (req.ttl as number) * 1000 });
  for (let attempt = 0; attempt < 10; attempt++) {
    const c = await current();
    try {
      if (!c) await kv.create(key, value);
      else if (c.holder === holder || c.until <= Date.now()) await kv.update(key, value, c.revision);
      else return { held: false, holder: c.holder };
      return { held: true, holder };
    } catch {
      // someone wrote first (the compare-and-set failed): look again
    }
  }
  const c = await current();
  return { held: c?.holder === holder, holder: c?.holder ?? "" };
}

async function read(jsm: JetStreamManager, project: string, after: number, filter: string): Promise<{ last: number; messages: Stored[] }> {
  let last: number;
  try {
    last = (await jsm.streams.info(streamName(project))).state.last_seq;
  } catch {
    return { last: after, messages: [] }; // no stream yet: nothing was said
  }
  const messages: Stored[] = [];
  for (let seq = after + 1; seq <= last;) {
    const m = await jsm.direct.getMessage(streamName(project), { seq, next_by_subj: filter });
    if (!m || m.seq > last) break;
    messages.push({ seq: m.seq, subject: m.subject, data: new TextDecoder().decode(m.data) });
    seq = m.seq + 1;
  }
  return { last, messages };
}

if (import.meta.main && process.env[HELPER_ENV] === "1") {
  void helper().then((a) => {
    process.stdout.write(JSON.stringify(a) + "\n");
    process.exit(0);
  }, (e: unknown) => {
    process.stdout.write(JSON.stringify({ ok: false, code: "nats-plugin", message: `The NATS plugin failed: ${String(e).slice(0, 300)}`,
      fix: "Report it with the command you ran; meanwhile `factory settings set messaging.transport github`." }) + "\n");
    process.exit(0);
  });
}
