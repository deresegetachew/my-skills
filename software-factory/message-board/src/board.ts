// The Board: factory-message-board's API over one Postgres (decision 0007 point 10). Each write is one transaction
// that also inserts its event and NOTIFYs mb_events with the event's seq, so a listener re-reads from its cursor.
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { BoardError, LOGIN_REFUSED, LOGIN_REFUSED_FIX, refuse, taskOf } from "./errors.ts";
import { GRAPH_LOCK, type NewEvent, reaches, recordEvents } from "./graph.ts";
import { applyImport } from "./import.ts";
import { addLogin, dropExpiredLogins, listLogins, type Login, redeemLogin, removeLogin, tidyLogins } from "./logins.ts";
import { applied, migrate } from "./migrate.ts";
import { CONTEXT_COLS, EVENT_COLS, MESSAGE_COLS, type Row, TASK_SELECT, toContext, toEvent, toMessage, toTask } from "./rows.ts";
import {
  BLOCKING, type BoardEvent, type Claim, CONTEXT_KINDS, type ContextEntry, type ContextKind, type Delegated, type ImportBatch, type ImportResult, EDGE_KINDS, type EdgeKind,
  type Message, MESSAGE_KINDS, type Move, MOVE_TARGETS, type NewMessage, type NewTask, type Next, type OnMe, type Outcome, OUTCOMES, type Prime, type Task,
  TASK_KINDS, type TaskChanges,
} from "./types.ts";

/** How long a claim lasts before it needs a heartbeat, and how long a holder may be silent before the sweep. */
export const CLAIM_SECONDS = 30 * 60;
export const QUIET_SECONDS = 30 * 60;
/** The actor that stands for the project's owner: only it answers a question addressed to it (#549). */
const OWNER_ACTOR = "owner";
/** The kinds a claim takes: epics, notes and decisions are not work items. */
const CLAIMABLE_KINDS = ["task", "bug"] as const;
const CLAIMABLE = CLAIMABLE_KINDS.map((k) => `'${k}'`).join(", ");
const MIGRATE_FIX = "Run `factory board migrate` (or board.migrate()), then try again.";

export interface OpenOptions {
  /** The actor this board writes as (default "system"). */
  as?: string;
  /** The writer's session, recorded on its events. */
  session?: string;
  /** The most connections it opens (default 4). */
  max?: number;
}

export interface Listener {
  close(): Promise<void>;
}

type Tx = SQL;

/** Thrown inside a dry run's transaction to roll it back. */
class DryRun extends Error {}

function rows(r: unknown): Row[] {
  return r as Row[];
}

/** A Postgres or connection error as a BoardError; a BoardError as it is. `connecting`: the error came while
 * connecting, where a permission refusal is the login's (it may not reach this database). */
function translate(e: unknown, connecting = false): unknown {
  if (e instanceof BoardError) return e;
  const err = e as { errno?: string; code?: string; message?: string };
  const state = err.errno ?? "";
  const msg = (err.message ?? String(e)).replace(/\/\/[^@\s]*@/g, "//***@");
  // 28P01: a wrong password, an expired login (VALID UNTIL) or a role that is gone; 28000: a role that may not log in
  if (connecting && state === "53300" && /for role/.test(msg)) { // too many connections for this role (a join code allows two), not for the server
    return new BoardError("login-in-use", `This login is already connected elsewhere as often as it may be (${msg}): if it is a join code's, the code may have been copied.`,
      "On the hub run `factory machine remove <name>`, then `factory machine add <name> --agent ...` for a new code, and join with that.");
  }
  if (state === "28P01" || state === "28000" || (connecting && state === "42501")) {
    return new BoardError("login-refused", `${LOGIN_REFUSED} The board said: ${msg}.`, LOGIN_REFUSED_FIX);
  }
  if (state === "42P01" || state === "42703") return new BoardError("schema-old", `The board's tables are missing or old: ${msg}`, MIGRATE_FIX);
  if (state === "40P01" || state === "40001") {
    return new BoardError("busy", "Another write to the same tasks crossed this one, so the board undid it; nothing was changed.", "Try again.");
  }
  if (state === "23503") return new BoardError("not-found", `That refers to something that isn't on the board: ${msg}`, "Check the id, then try again.");
  if (state === "23505") return new BoardError("bad-input", `That is already on the board: ${msg}`, "Use the one that is there (an external ref is unique).");
  if (state === "42501") {
    return new BoardError("no-rights", `The board's user here may not do that: ${msg}`,
      "Run it on the machine that runs the board (`factory board up`), whose URL has the board's own user.");
  }
  if (state === "23514" || state === "22P02" || state === "23502") return new BoardError("bad-input", `The board doesn't take that value: ${msg}`, "Check the value against the README's API.");
  if (/^ERR_POSTGRES_(CONNECTION|SOCKET|TLS)|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(`${err.code ?? ""} ${msg}`)) {
    return new BoardError("no-answer", `The board's database doesn't answer: ${msg}`, "Start it (`factory board up`) or check its URL, then try again.");
  }
  return e;
}

function oneOf<T extends string>(what: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    refuse("bad-input", `${what} must be one of ${allowed.join(", ")}, not ${JSON.stringify(value)}.`, `Use one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function wholeNumber(what: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) refuse("bad-input", `${what} must be a whole number, not ${JSON.stringify(value)}.`, `Pass ${what} as a whole number.`);
  return value;
}

function named(what: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) refuse("bad-input", `${what} must be a name of 1 to 200 characters.`, `Pass ${what.toLowerCase()} as text.`);
  return value;
}

function said(what: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) refuse("bad-input", `${what} can't be empty.`, `Say it in a sentence.`);
  return value;
}

function signalName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(name)) {
    refuse("bad-input", `A signal's name is lowercase letters, digits, - and _, not ${JSON.stringify(name)}.`, "Name it like wake.");
  }
  return name;
}

function seconds(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) refuse("bad-input", `A time in seconds must be 0 or more, not ${value}.`, "Pass a number of seconds.");
  return value;
}

export class Board {
  private constructor(private readonly sql: SQL, readonly as: string, readonly session: string | null, private readonly url: string) {}

  /** Connect to the board's database at `url` (checked with one query). */
  static async open(url: string, options: OpenOptions = {}): Promise<Board> {
    const as = options.as ?? "system";
    if (!as.trim()) refuse("bad-input", "An actor needs a name.", "Open the board with { as: \"<name>\" }.");
    const sql = new SQL(url, { max: options.max ?? 4, connectionTimeout: 10 });
    try {
      await sql`SELECT 1`;
    } catch (e) {
      await sql.close().catch(() => {});
      const t = translate(e, true);
      if (t instanceof BoardError) throw t;
      throw new BoardError("no-answer", `The board's database doesn't answer: ${String(translate(e)).replace(/\/\/[^@\s]*@/g, "//***@")}`,
        "Start it (`factory board up`) or check its URL, then try again.");
    }
    return new Board(sql, as, options.session ?? null, url);
  }

  /** Close the connections. (`close` closes a task.) */
  async end(): Promise<void> {
    await this.sql.close();
  }

  /** Apply the migrations not applied yet; returns their names. */
  async migrate(): Promise<string[]> {
    return this.run(() => migrate(this.sql));
  }

  /** Makes a login of its own for another machine (logins.ts); the caller shows `password` once and keeps nothing.
   * With `validFor` (seconds) it is a join code's login: Postgres refuses it after that, unless it is redeemed first. */
  async addLogin(name: string, password: string, options: { validFor?: number } = {}): Promise<{ name: string; role: string }> {
    return this.run(() => addLogin(this.sql, name, password, options));
  }

  /** Redeems this connection's own join-code login once (logins.ts): `keep` gets its fresh role and password before the commit, and
   * a `keep` that throws undoes the redeem. */
  async redeemLogin(keep: (login: { role: string; password: string }) => Promise<void> | void): Promise<void> {
    return this.run(() => redeemLogin(this.sql, this.url, keep));
  }

  /** Drops the join codes' logins that expired unredeemed, ending their sessions, and the spent code roles (logins.ts);
   * the names, and a warning for each that couldn't be dropped. Only the board's own user can; for anyone else, none. */
  async dropExpiredLogins(): Promise<{ dropped: string[]; warnings: string[] }> {
    return this.run(() => dropExpiredLogins(this.sql));
  }

  /** Drops the spent join code roles (logins.ts); a warning for each that couldn't be. Only the board's own user can. */
  async tidyLogins(): Promise<string[]> {
    return this.run(() => tidyLogins(this.sql));
  }

  /** Every login, with when it was first used and whether it is connected now. */
  async logins(): Promise<Login[]> {
    return this.run(() => listLogins(this.sql));
  }

  /** Drops a login and ends its connections; with `unused`, only one that was never used. */
  async removeLogin(name: string, options: { unused?: boolean; unredeemed?: boolean } = {}): Promise<{ name: string; role: string }> {
    return this.run(() => removeLogin(this.sql, name, options));
  }

  /** The server's version, the migrations applied, and how many tasks there are in each status. */
  async info(): Promise<{ server: string; migrations: string[]; counts: Record<string, number> | null }> {
    return this.run(async () => {
      const server = `PostgreSQL ${String(rows(await this.sql`SHOW server_version`)[0]?.server_version ?? "?")}`;
      const migrations = await applied(this.sql);
      if (!migrations.length) return { server, migrations, counts: null };
      const counts: Record<string, number> = {};
      for (const r of rows(await this.sql`SELECT status, count(*)::int AS n FROM tasks GROUP BY status ORDER BY status`)) counts[String(r.status)] = Number(r.n);
      return { server, migrations, counts };
    });
  }

  // ---------- plumbing ----------
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw translate(e);
    }
  }

  /** One write: `fn` in a transaction, which returns the event to record; the event and NOTIFY go last. */
  private write<T>(fn: (tx: Tx) => Promise<{ result: T; event: { kind: string; subject: string; payload: Record<string, unknown> } | null }>): Promise<T> {
    return this.run(() =>
      this.sql.begin(async (tx) => {
        const { result, event } = await fn(tx);
        if (event) await recordEvents(tx, this.as, this.session, [event]);
        return result;
      }) as Promise<T>,
    );
  }

  private async taskIn(tx: Tx, id: number): Promise<Task | null> {
    const r = rows(await tx.unsafe(`${TASK_SELECT} WHERE t.id = $1`, [id]));
    return r[0] ? toTask(r[0]) : null;
  }

  private async mustTask(tx: Tx, id: number): Promise<Task> {
    const t = await this.taskIn(tx, wholeNumber("A task id", id));
    if (!t) refuse("not-found", `There is no task ${taskOf(id)} on the board.`, "Check the id (`factory board tasks` lists them).");
    return t;
  }

  private async tasksWhere(where: string, params: unknown[], order = "t.priority, t.created_at, t.id", limit = 500): Promise<Task[]> {
    return this.run(async () => rows(await this.sql.unsafe(`${TASK_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ${Math.floor(limit)}`, params)).map(toTask));
  }

  private async seen(tx: Tx, actor: string): Promise<void> {
    await tx`INSERT INTO actors (id, seen_at) VALUES (${actor}, now()) ON CONFLICT (id) DO UPDATE SET seen_at = now()`;
  }

  // ---------- actors ----------
  /** Record an actor: an agent or a person, with the role the user of the board gives it. */
  async actor(id: string, info: { kind?: "agent" | "person"; role?: string } = {}): Promise<void> {
    const kind = oneOf("An actor's kind", info.kind ?? "agent", ["agent", "person"] as const);
    return this.write(async (tx) => {
      await tx`INSERT INTO actors (id, kind, role) VALUES (${id}, ${kind}, ${info.role ?? ""})
        ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, role = EXCLUDED.role`;
      return { result: undefined, event: { kind: "actor.saved", subject: `actor:${id}`, payload: { kind, role: info.role ?? "" } } };
    });
  }

  // ---------- tasks ----------
  async create(input: NewTask): Promise<Task> {
    if (typeof input.title !== "string" || !input.title.trim()) refuse("bad-input", "A task needs a title.", "Pass { title: \"...\" }.");
    const kind = oneOf("A task's kind", input.kind ?? "task", TASK_KINDS);
    const priority = wholeNumber("A priority", input.priority ?? 2);
    return this.write(async (tx) => {
      const r = rows(await tx`INSERT INTO tasks (title, body, kind, priority, parent_id, external_ref, created_by)
        VALUES (${input.title}, ${input.body ?? ""}, ${kind}, ${priority}, ${input.parentId ?? null}, ${input.ref ?? null}, ${this.as})
        RETURNING id::int AS id`);
      const task = await this.mustTask(tx, Number(r[0]?.id));
      return { result: task, event: { kind: "task.created", subject: `task:${task.id}`, payload: { title: task.title, kind, parent: task.parentId, ref: task.ref } } };
    });
  }

  async get(id: number): Promise<Task> {
    return this.run(() => this.mustTask(this.sql, id));
  }

  /** The tasks whose outside ref is `ref`, in any case (refs are unique, so at most one), or with `anyRepo` every task
   * whose ref is a GitHub issue numbered like `ref` in any repo (`github:<owner>/<name>#<n>`). Read-only: it lets a
   * person name a task by its issue number (#515). */
  async byRef(ref: string, options: { anyRepo?: boolean } = {}): Promise<Task[]> {
    if (options.anyRepo) {
      const n = /#(\d+)$/.exec(ref)?.[1];
      if (!n) return [];
      return this.tasksWhere("t.external_ref ~ $1", [`^github:[^#]+#${n}$`]);
    }
    return this.tasksWhere("lower(t.external_ref) = lower($1)", [ref]);
  }

  /** Edit a task. `version` is the one the caller read: a different one is a `conflict` and nothing changes. */
  async update(id: number, changes: TaskChanges): Promise<Task> {
    const version = wholeNumber("A version", changes.version);
    const set: string[] = [];
    const params: unknown[] = [id, version];
    const add = (col: string, v: unknown): void => {
      params.push(v);
      set.push(`${col} = $${params.length}`);
    };
    if (changes.title !== undefined) {
      if (!changes.title.trim()) refuse("bad-input", "A task needs a title.", "Pass a title that isn't empty.");
      add("title", changes.title);
    }
    if (changes.body !== undefined) add("body", changes.body);
    if (changes.kind !== undefined) add("kind", oneOf("A task's kind", changes.kind, TASK_KINDS));
    if (changes.priority !== undefined) add("priority", wholeNumber("A priority", changes.priority));
    if (changes.ref !== undefined) add("external_ref", changes.ref);
    if (changes.parentId !== undefined) add("parent_id", changes.parentId === null ? null : wholeNumber("A parent id", changes.parentId));
    if (changes.status !== undefined) add("status", oneOf("A status set by update", changes.status, ["open", "in_review", "deferred"] as const));
    if (changes.status === "open" || changes.status === "deferred") set.push("outcome = NULL"); // reopened: no outcome yet
    return this.write(async (tx) => {
      const before = await this.mustTask(tx, id);
      if (changes.parentId !== undefined && changes.parentId !== null) {
        await tx`SELECT pg_advisory_xact_lock(${GRAPH_LOCK})`;
        if (changes.parentId === id || (await reaches(tx, id, changes.parentId))) {
          refuse("cycle", `${taskOf(changes.parentId)} can't be the parent of ${taskOf(id)}: that makes a loop (it is ${taskOf(id)} itself, under it, or waits on it).`,
            "Choose another parent, or remove the edge that makes the loop first.");
        }
      }
      if (changes.status && changes.status !== "in_review" && before.holder) {
        refuse("bad-input", `${taskOf(id)} is held by ${before.holder}; update can't move it to ${changes.status}.`,
          "The holder releases it (board.release with next ready or deferred), or the sweep does once the claim is stale.");
      }
      const r = rows(await tx.unsafe(`UPDATE tasks SET ${[...set, "version = version + 1", "updated_at = now()"].join(", ")}
        WHERE id = $1 AND version = $2 RETURNING id`, params));
      if (!r.length) {
        refuse("conflict", `${taskOf(id)} has changed since you read it (you read version ${version}; it is at ${before.version}).`,
          "Read it again (board.get), apply your change to what is there now, and send it with the new version.");
      }
      const task = (await this.taskIn(tx, id)) as Task;
      const fields = Object.keys(changes).filter((k) => k !== "version");
      return { result: task, event: { kind: "task.updated", subject: `task:${id}`, payload: { fields, version: task.version } } };
    });
  }

  /** Link two tasks: `from` blocks, waits for, was discovered from ... `to`. blocks: from must be done before to can
   * start; waits_for: from can't start until to is done. A loop of blocking edges is refused. */
  async link(from: number, to: number, kind: EdgeKind): Promise<boolean> {
    const k = oneOf("An edge's kind", kind, EDGE_KINDS);
    return this.write(async (tx) => {
      const event = await this.linkIn(tx, from, to, k);
      return { result: event !== null, event };
    });
  }

  /** Add one edge inside a transaction, refusing a loop; its event, or null when the edge was already there. */
  private async linkIn(tx: Tx, from: number, to: number, k: EdgeKind): Promise<NewEvent | null> {
    await this.mustTask(tx, from);
    await this.mustTask(tx, to);
    if (from === to) {
      refuse(BLOCKING.includes(k) ? "cycle" : "bad-input", `A task can't ${k.replace("_", " ")} itself (${taskOf(from)}).`, "Link two different tasks.");
    }
    if (BLOCKING.includes(k)) {
      // blocks: from comes first. waits_for: to comes first (from waits for to).
      const [first, then] = k === "waits_for" ? [to, from] : [from, to];
      await tx`SELECT pg_advisory_xact_lock(${GRAPH_LOCK})`;
      if (await reaches(tx, then, first)) {
        refuse("cycle", `${taskOf(from)} ${k.replace("_", " ")} ${taskOf(to)} would make a loop: ${taskOf(first)} already waits on ${taskOf(then)}, or is under it.`,
          "Remove the edge that makes the loop first, or link them the other way.");
      }
    }
    const r = rows(await tx`INSERT INTO edges (from_id, to_id, kind, created_by) VALUES (${from}, ${to}, ${k}, ${this.as})
      ON CONFLICT DO NOTHING RETURNING from_id`);
    return r.length ? { kind: "edge.linked", subject: `task:${from}`, payload: { from, to, kind: k } } : null;
  }

  async unlink(from: number, to: number, kind: EdgeKind): Promise<boolean> {
    const k = oneOf("An edge's kind", kind, EDGE_KINDS);
    return this.write(async (tx) => {
      const r = rows(await tx`DELETE FROM edges WHERE from_id = ${from} AND to_id = ${to} AND kind = ${k} RETURNING from_id`);
      return { result: r.length > 0, event: r.length ? { kind: "edge.unlinked", subject: `task:${from}`, payload: { from, to, kind: k } } : null };
    });
  }

  /** The edges from or to a task; with no id, every edge on the board. */
  async edges(id?: number): Promise<{ from: number; to: number; kind: EdgeKind }[]> {
    const which = id === undefined ? null : wholeNumber("A task id", id);
    return this.run(async () => rows(await this.sql`SELECT from_id::int AS f, to_id::int AS t, kind FROM edges
      WHERE ${which}::bigint IS NULL OR from_id = ${which} OR to_id = ${which} ORDER BY created_at, from_id, to_id`)
      .map((r) => ({ from: Number(r.f), to: Number(r.t), kind: r.kind as EdgeKind })));
  }

  /** The ready queue, in claim order: tasks and bugs that are open, not blocked and held by nobody. A task handed to an
   * actor is in that actor's queue (`for`) only. */
  async ready(options: { for?: string; limit?: number } = {}): Promise<Task[]> {
    const who = options.for ?? null;
    return this.tasksWhere("t.id IN (SELECT id FROM ready) AND (t.assignee IS NULL OR t.assignee = $1::text)", [who],
      undefined, options.limit ?? 500);
  }

  /** Every task (or only those not done), in queue order. */
  async tasks(options: { all?: boolean; limit?: number } = {}): Promise<Task[]> {
    return this.tasksWhere(options.all ? "TRUE" : "t.status <> 'done'", [], undefined, options.limit ?? 500);
  }

  /** Claim the first ready task (`id` omitted; null when none is ready) or a named one (refused unless it is ready or
   * already yours). The returned token goes with every later write by the holder. */
  async claim(id?: number, options: { ttlSeconds?: number } = {}): Promise<Claim | null> {
    const ttl = seconds(options.ttlSeconds, CLAIM_SECONDS);
    const token = randomUUID();
    return this.write(async (tx) => {
      let r: Row[];
      if (id === undefined) {
        r = await this.claimFirst(tx, token, ttl);
        if (!r.length) return { result: null, event: null };
      } else {
        wholeNumber("A task id", id);
        r = rows(await tx.unsafe(`
          UPDATE tasks t SET holder = $1, claim_token = $2, claimed_at = now(), claim_until = now() + make_interval(secs => $3),
            status = CASE WHEN t.holder = $1 THEN t.status ELSE 'in_progress' END, version = t.version + 1, updated_at = now()
          WHERE t.id = $4 AND (t.holder = $1 OR (t.status = 'open' AND t.holder IS NULL AND (t.assignee IS NULL OR t.assignee = $1)
            AND t.kind IN (${CLAIMABLE})
            AND NOT EXISTS (SELECT 1 FROM task_blockers k WHERE k.task_id = t.id)))
          RETURNING t.id`, [this.as, token, ttl, id]));
        if (!r.length) await this.whyNotReady(tx, id);
      }
      await this.seen(tx, this.as);
      const task = (await this.taskIn(tx, Number(r[0]?.id))) as Task;
      return { result: { task, token }, event: { kind: "task.claimed", subject: `task:${task.id}`, payload: { holder: this.as, until: task.claimUntil } } };
    });
  }

  /** The first ready task, claimed. A candidate a concurrent claim changed after this statement's snapshot drops out of
   * the UPDATE; then it tries again, a few times, while something is still ready. */
  private async claimFirst(tx: Tx, token: string, ttl: number): Promise<Row[]> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = rows(await tx.unsafe(`
        WITH pick AS (
          SELECT id FROM tasks
          WHERE status = 'open' AND holder IS NULL AND (assignee IS NULL OR assignee = $1) AND kind IN (${CLAIMABLE})
            AND NOT EXISTS (SELECT 1 FROM task_blockers k WHERE k.task_id = tasks.id)
          ORDER BY priority, created_at, id
          LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE tasks t SET holder = $1, claim_token = $2, claimed_at = now(), claim_until = now() + make_interval(secs => $3),
          status = 'in_progress', version = t.version + 1, updated_at = now()
        FROM pick WHERE t.id = pick.id AND t.status = 'open' AND t.holder IS NULL
        RETURNING t.id`, [this.as, token, ttl]));
      if (r.length) return r;
      const left = rows(await tx.unsafe("SELECT EXISTS (SELECT 1 FROM ready WHERE assignee IS NULL OR assignee = $1) AS any", [this.as]));
      if (!left[0]?.any) return [];
    }
    return [];
  }

  private async whyNotReady(tx: Tx, id: number): Promise<never> {
    const t = await this.mustTask(tx, id);
    const why = !(CLAIMABLE_KINDS as readonly string[]).includes(t.kind) ? `it is ${/^[aeiou]/.test(t.kind) ? "an" : "a"} ${t.kind}; only tasks and bugs are claimed`
      : t.holder ? `${t.holder} holds it`
      : t.blocked ? `it is blocked by ${t.blockedBy.map((b) => taskOf(b)).join(", ")}`
      : t.status !== "open" ? `it is ${t.status}`
      : t.assignee && t.assignee !== this.as ? `it was handed to ${t.assignee}`
      : "it changed while you claimed it";
    return refuse("not-ready", `${taskOf(id)} isn't ready for ${this.as}: ${why}.`, "Claim another task (`board.claim()` takes the first ready one), or wait for it.");
  }

  /** A token-checked update; refused with `claim-lost` when the token no longer holds the task. */
  private async fenced(tx: Tx, id: number, token: string, setSql: string, params: unknown[]): Promise<Task> {
    const r = rows(await tx.unsafe(`UPDATE tasks SET ${setSql}, version = version + 1, updated_at = now()
      WHERE id = $1 AND claim_token = $2 RETURNING id`, [id, token, ...params]));
    if (!r.length) {
      const t = await this.mustTask(tx, id);
      refuse("claim-lost", `Your claim on ${taskOf(id)} is gone: ${t.holder ? `${t.holder} holds it now` : "nobody holds it now"}.`,
        "Stop working on it. Claim it again if it is ready (`board.claim(id)`), or take another task.");
    }
    return (await this.taskIn(tx, id)) as Task;
  }

  /** Keep a claim: move its time on (default 30 minutes from now), and mark the holder as heard from. */
  async heartbeat(id: number, token: string, options: { ttlSeconds?: number } = {}): Promise<Task> {
    const ttl = seconds(options.ttlSeconds, CLAIM_SECONDS);
    return this.write(async (tx) => {
      const task = await this.fenced(tx, id, token, "claim_until = now() + make_interval(secs => $3)", [ttl]);
      await this.seen(tx, this.as);
      return { result: task, event: { kind: "task.heartbeat", subject: `task:${id}`, payload: { until: task.claimUntil } } };
    });
  }

  /** Give a held task back, saying what happens next: ready (anyone may claim it), deferred, review (its work waits for a
   * review: in review, held by nobody, so anyone may close it or send it back), or handed to one actor. */
  async release(id: number, token: string, next: Next): Promise<Task> {
    const n = oneOf("next", next.next, ["ready", "deferred", "review", "handoff"] as const);
    if (typeof next.reason !== "string" || !next.reason.trim()) refuse("bad-input", "A release says why.", "Pass { next, reason: \"...\" }.");
    const to = next.next === "handoff" ? next.to : undefined;
    if (n === "handoff" && (typeof to !== "string" || !to.trim())) refuse("bad-input", "A hand-off names who takes it.", "Pass { next: \"handoff\", to: \"<actor>\", reason }.");
    const status = n === "deferred" ? "deferred" : n === "review" ? "in_review" : "open";
    return this.write(async (tx) => {
      const task = await this.fenced(tx, id, token,
        "holder = NULL, claim_token = NULL, claimed_at = NULL, claim_until = NULL, status = $3, assignee = $4", [status, to ?? null]);
      return { result: task, event: { kind: "task.released", subject: `task:${id}`, payload: { next: n, to: to ?? null, reason: next.reason } } };
    });
  }

  /** Close a task with its outcome. A held task needs its token; a token that no longer holds it is `claim-lost`. */
  async close(id: number, options: { outcome: Outcome; token?: string; reason?: string }): Promise<Task> {
    const outcome = oneOf("An outcome", options.outcome, OUTCOMES);
    const clear = "holder = NULL, claim_token = NULL, claimed_at = NULL, claim_until = NULL, assignee = NULL, status = 'done', outcome = $3";
    return this.write(async (tx) => {
      let task: Task;
      if (options.token !== undefined) task = await this.fenced(tx, id, options.token, clear, [outcome]);
      else {
        const r = rows(await tx.unsafe(`UPDATE tasks SET ${clear.replace("$3", "$2")}, version = version + 1, updated_at = now()
          WHERE id = $1 AND holder IS NULL AND status <> 'done' RETURNING id`, [id, outcome]));
        if (!r.length) {
          const t = await this.mustTask(tx, id);
          if (!t.holder) {
            refuse("bad-input", `${taskOf(id)} is already done (${t.outcome ?? "no outcome"}).`,
              "Move it back to ready first (board_move with to ready, which the owner and the dev manager have; board.move in code), then close it with the new outcome.");
          }
          refuse("claim-lost", `${taskOf(id)} is held by ${t.holder}; only its holder closes it, with its token.`,
            "Ask the holder to close it, or wait until it is released.");
        }
        task = (await this.taskIn(tx, id)) as Task;
      }
      return { result: task, event: { kind: "task.closed", subject: `task:${id}`, payload: { outcome, reason: options.reason ?? null } } };
    });
  }

  /** Move a task to a column, as the owner or the dev manager does from the board (#503): ready, in_review, deferred,
   * done (with an outcome, default done) or blocked (by `blockedBy`, each linked to it with a `blocks` edge, or by a
   * `reason` alone, which defers it). A reason given with blocked is kept as a `blocker` context entry. A held task is
   * taken back from its holder, which needs a reason: the holder's token stops working, and a `task.taken_back` event
   * names the holder and the reason. in_progress is refused unless the task is already held: only a claim puts a task
   * there. All of it is one transaction, recorded as a `task.moved` event. This is the board's authorised move: it
   * takes no token, so only a caller acting for the owner or the dev manager uses it (the MCP server offers it only with
   * --role owner or manager). */
  async move(id: number, m: Move): Promise<Task> {
    const to = oneOf("to", m.to, MOVE_TARGETS);
    const reason = m.reason === undefined ? undefined : said("A reason", m.reason);
    const blockedBy = [...new Set((m.blockedBy ?? []).map((b) => wholeNumber("A blocking task's id", b)))];
    if (blockedBy.length && to !== "blocked") refuse("bad-input", "blockedBy goes only with to blocked.", "Leave blockedBy out, or move it to blocked.");
    if (m.outcome !== undefined && to !== "done") refuse("bad-input", "An outcome goes only with to done.", "Leave outcome out, or move it to done.");
    const outcome = to === "done" ? oneOf("An outcome", m.outcome ?? "done", OUTCOMES) : null;
    if (to === "blocked" && !blockedBy.length && reason === undefined) {
      refuse("bad-input", "A move to blocked says what blocks it: a reason, or the tasks it waits on (blockedBy).", "Pass reason, blockedBy, or both.");
    }
    return this.run(() =>
      this.sql.begin(async (tx) => {
        // Lock order: the graph lock before the row, as update and link take them, so two writes can't wait on each other.
        if (blockedBy.length) await tx`SELECT pg_advisory_xact_lock(${GRAPH_LOCK})`;
        await tx`SELECT id FROM tasks WHERE id = ${wholeNumber("A task id", id)} FOR NO KEY UPDATE`;
        const before = await this.mustTask(tx, id);
        if (to === "in_progress") {
          if (before.holder) return before;
          refuse("bad-input", `${taskOf(id)} isn't held: in progress means an agent holds it, and only a claim puts a task there.`,
            "Hand it to the agent (board_assign) so they claim it, or move it to ready.");
        }
        const events: NewEvent[] = [];
        if (before.holder) events.push(this.takeBackEvent(before, reason, to));
        for (const b of blockedBy) {
          const e = await this.linkIn(tx, b, id, "blocks");
          if (e) events.push(e);
        }
        const status = to === "ready" ? "open" : to === "blocked" ? (blockedBy.length ? "open" : "deferred") : to === "in_review" ? "in_review" : to;
        const keepAssignee = !before.holder && to !== "done";
        await tx.unsafe(`UPDATE tasks SET status = $2, outcome = $3, holder = NULL, claim_token = NULL, claimed_at = NULL, claim_until = NULL,
          assignee = CASE WHEN $4 THEN assignee ELSE NULL END, version = version + 1, updated_at = now() WHERE id = $1`, [id, status, outcome, keepAssignee]);
        if (to === "blocked" && reason !== undefined) events.push((await this.noteIn(tx, id, "blocker", reason)).event);
        events.push({ kind: "task.moved", subject: `task:${id}`,
          payload: { from: before.status, to, status, outcome, reason: reason ?? null, blockedBy, holder: before.holder } });
        await recordEvents(tx, this.as, this.session, events);
        return (await this.taskIn(tx, id)) as Task;
      }) as Promise<Task>,
    );
  }

  /** Hand a task to one actor (#503): only they may claim it. It keeps its column; a held one is taken back from its
   * holder first, which needs a reason (a `task.taken_back` event), and goes back to open for them. A done task is
   * refused: move it to ready first. Like move, it takes no token: for the owner and the dev manager. */
  async assign(id: number, to: string, options: { reason?: string } = {}): Promise<Task> {
    const who = named("Who it goes to", to);
    const reason = options.reason === undefined ? undefined : said("A reason", options.reason);
    return this.run(() =>
      this.sql.begin(async (tx) => {
        await tx`SELECT id FROM tasks WHERE id = ${wholeNumber("A task id", id)} FOR NO KEY UPDATE`;
        const before = await this.mustTask(tx, id);
        if (before.status === "done") refuse("bad-input", `${taskOf(id)} is done; a done task isn't handed on.`, "Move it to ready first (board_move), then assign it.");
        const events: NewEvent[] = [];
        if (before.holder) events.push(this.takeBackEvent(before, reason, "assign"));
        await tx.unsafe(`UPDATE tasks SET assignee = $2, status = CASE WHEN holder IS NULL THEN status ELSE 'open' END, holder = NULL,
          claim_token = NULL, claimed_at = NULL, claim_until = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [id, who]);
        events.push({ kind: "task.assigned", subject: `task:${id}`, payload: { to: who, from: before.assignee, reason: reason ?? null } });
        await recordEvents(tx, this.as, this.session, events);
        return (await this.taskIn(tx, id)) as Task;
      }) as Promise<Task>,
    );
  }

  /** The event for taking a held task back from its holder; refused without a reason. */
  private takeBackEvent(t: Task, reason: string | undefined, why: string): NewEvent {
    if (reason === undefined) {
      refuse("bad-input", `${taskOf(t.id)} is held by ${t.holder}; this takes the claim back from them, so it needs a reason.`,
        "Pass reason: why you take it back (the holder and the board's events show it).");
    }
    return { kind: "task.taken_back", subject: `task:${t.id}`, payload: { holder: t.holder, reason, for: why } };
  }

  /** Release the claims whose time has passed and whose holder hasn't been heard from for `quietSeconds` (default 30
   * minutes). Both are checked again inside the UPDATE, so a heartbeat that lands meanwhile wins. */
  async sweep(options: { quietSeconds?: number } = {}): Promise<{ id: number; holder: string }[]> {
    const quiet = seconds(options.quietSeconds, QUIET_SECONDS);
    const stale = `t.holder IS NOT NULL AND t.claim_until < now()
      AND NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = t.holder AND a.seen_at > now() - make_interval(secs => $1))`;
    return this.run(async () => {
      const r = rows(await this.sql.begin(async (tx) => {
        const swept = rows(await tx.unsafe(`
          WITH stale AS (SELECT t.id, t.holder FROM tasks t WHERE ${stale} FOR UPDATE SKIP LOCKED)
          UPDATE tasks t SET holder = NULL, claim_token = NULL, claimed_at = NULL, claim_until = NULL,
            status = CASE WHEN t.status = 'in_review' THEN 'in_review' ELSE 'open' END, version = t.version + 1, updated_at = now()
          FROM stale WHERE t.id = stale.id AND t.holder = stale.holder AND ${stale}
          RETURNING t.id::int AS id, stale.holder AS holder`, [quiet]));
        await recordEvents(tx, "system", this.session,
          swept.map((s) => ({ kind: "task.swept", subject: `task:${s.id}`, payload: { holder: s.holder, quietSeconds: quiet } })));
        return swept;
      }));
      return r.map((s) => ({ id: Number(s.id), holder: String(s.holder) }));
    });
  }

  // ---------- threads ----------
  /** Post a message, on a task or not. A reply joins its parent's thread; an answer marks the question answered. */
  async post(input: NewMessage): Promise<Message> {
    const kind = oneOf("A message's kind", input.kind, MESSAGE_KINDS);
    if (typeof input.body !== "string" || !input.body.trim()) refuse("bad-input", "A message needs a body.", "Pass { body: \"...\" }.");
    return this.write(async (tx) => {
      let thread: number | null = null;
      let task = input.task ?? null;
      if (input.inReplyTo != null) {
        const p = rows(await tx`SELECT thread_id::int AS thread, task_id::int AS task, state, addressee FROM messages WHERE id = ${input.inReplyTo} FOR UPDATE`);
        if (!p[0]) refuse("not-found", `There is no message ${input.inReplyTo} to reply to.`, "Check the id (board.thread lists a thread).");
        thread = Number(p[0].thread);
        task = task ?? (p[0].task === null ? null : Number(p[0].task));
        // only the owner answers what was asked of the owner (#549): another actor's reply there leaves it open
        const answers = p[0].addressee !== OWNER_ACTOR || this.as === OWNER_ACTOR;
        if (kind === "answer" && answers && p[0].state === "open") await tx`UPDATE messages SET state = 'answered' WHERE id = ${input.inReplyTo}`;
      }
      const id = Number(rows(await tx`SELECT nextval(pg_get_serial_sequence('messages', 'id'))::int AS id`)[0]?.id);
      const state = kind === "question" || kind === "ask" ? "open" : "closed";
      const r = rows(await tx.unsafe(`INSERT INTO messages (id, task_id, thread_id, kind, sender, addressee, state, in_reply_to, body, tag)
        OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${MESSAGE_COLS}`,
        [id, task, thread ?? id, kind, this.as, input.to ?? null, state, input.inReplyTo ?? null, input.body, input.tag ?? null]));
      const m = toMessage(r[0] as Row);
      return { result: m, event: { kind: "message.posted", subject: `message:${m.id}`, payload: { task: m.taskId, thread: m.threadId, kind, to: m.to, inReplyTo: m.inReplyTo } } };
    });
  }

  // ---------- one at a time ----------
  /** Run `fn` while holding the named lock, so two callers anywhere (other processes, other machines) never run it at
   * once. The lock is a Postgres session lock on a connection kept for the whole run: a caller that dies lets it go.
   * Waits up to `waitMs` (default 15 s) for it; `{ ran: false }` when it is still held then. */
  async exclusive<T>(name: string, fn: () => Promise<T>, options: { waitMs?: number } = {}): Promise<{ ran: true; result: T } | { ran: false }> {
    named("A lock's name", name);
    const conn = await this.run(() => this.sql.reserve());
    try {
      const deadline = Date.now() + (options.waitMs ?? 15_000);
      for (;;) {
        const r = rows(await conn`SELECT pg_try_advisory_lock(7007, hashtext(${name})) AS got`);
        if (r[0]?.got) break;
        if (Date.now() >= deadline) return { ran: false };
        await Bun.sleep(200);
      }
      try {
        return { ran: true, result: await fn() };
      } finally {
        await conn`SELECT pg_advisory_unlock(7007, hashtext(${name}))`.catch(() => {});
      }
    } finally {
      conn.release();
    }
  }

  /** One message, by its id. */
  async message(id: number): Promise<Message> {
    return this.run(async () => {
      const r = rows(await this.sql.unsafe(`SELECT ${MESSAGE_COLS} FROM messages WHERE id = $1`, [wholeNumber("A message id", id)]));
      if (!r[0]) refuse("not-found", `There is no message ${id}.`, "Check the id (board.thread lists a thread).");
      return toMessage(r[0]);
    });
  }

  /** Record where a message was copied to outside (`github:owner/repo/comments/123`), so an import that meets it there
   * knows it as this message: a reply to it joins its thread, and it is never brought in twice. Linking it again to the
   * same ref changes nothing; a message already linked elsewhere, or a ref another message has, is refused. */
  async linkMessage(id: number, ref: string): Promise<Message> {
    named("A message's ref", ref);
    return this.write(async (tx) => {
      const r = rows(await tx.unsafe(`SELECT ${MESSAGE_COLS} FROM messages WHERE id = $1 FOR UPDATE`, [wholeNumber("A message id", id)]));
      if (!r[0]) refuse("not-found", `There is no message ${id}.`, "Check the id (board.thread lists a thread).");
      const m = toMessage(r[0]);
      if (m.ref === ref) return { result: m, event: null };
      if (m.ref !== null) refuse("bad-input", `Message ${id} is already linked to ${m.ref}.`, "Leave it linked where it is.");
      const other = rows(await tx`SELECT id::int AS id FROM messages WHERE external_ref = ${ref}`);
      if (other[0]) refuse("bad-input", `${ref} is already message ${other[0].id}.`, "Link each outside copy to one message.");
      const u = rows(await tx.unsafe(`UPDATE messages SET external_ref = $2 WHERE id = $1 RETURNING ${MESSAGE_COLS}`, [id, ref]));
      return { result: toMessage(u[0] as Row), event: { kind: "message.linked", subject: `message:${id}`, payload: { ref } } };
    });
  }

  /** A thread's messages, oldest first: by thread id, or every message on a task. */
  async thread(ref: { thread: number } | { task: number }): Promise<Message[]> {
    return this.run(async () => {
      const r = "thread" in ref
        ? await this.sql.unsafe(`SELECT ${MESSAGE_COLS} FROM messages WHERE thread_id = $1 ORDER BY id`, [ref.thread])
        : await this.sql.unsafe(`SELECT ${MESSAGE_COLS} FROM messages WHERE task_id = $1 ORDER BY id`, [ref.task]);
      return rows(r).map(toMessage);
    });
  }

  /** The messages posted after `after` (an event seq, from an earlier call's cursor), in the order they were posted, and
   * the cursor to pass next. With no `after`, every message on the board (imported ones too), oldest first. A reader
   * that keeps its own place reads each posted message once this way: the events' order is the order they committed. */
  async messages(options: { after?: number; limit?: number } = {}): Promise<{ messages: Message[]; cursor: number }> {
    const limit = Math.floor(options.limit ?? 1000);
    return this.run(async () => {
      if (options.after === undefined) {
        const top = Number(rows(await this.sql`SELECT COALESCE(max(seq), 0)::bigint::text AS seq FROM events`)[0]?.seq ?? 0);
        const r = rows(await this.sql.unsafe(`SELECT ${MESSAGE_COLS} FROM messages m WHERE NOT EXISTS (SELECT 1 FROM events e
          WHERE e.kind = 'message.posted' AND e.subject = 'message:' || m.id AND e.seq > $1) ORDER BY m.id`, [top]));
        return { messages: r.map(toMessage), cursor: top };
      }
      const after = wholeNumber("A cursor", options.after);
      const r = rows(await this.sql.unsafe(`SELECT ${MESSAGE_COLS.split(", ").map((c) => `m.${c}`).join(", ")}, e.seq::text AS seq
        FROM events e JOIN messages m ON e.subject = 'message:' || m.id
        WHERE e.kind = 'message.posted' AND e.seq > $1 ORDER BY e.seq LIMIT $2`, [after, limit]));
      return { messages: r.map(toMessage), cursor: r.length ? Number(r.at(-1)?.seq) : after };
    });
  }

  // ---------- leases ----------
  /** Hold `key` for `holder` for `ttlSeconds` when nobody holds it or its time ran out; the holder taking it again moves
   * its time on. Says whether `holder` holds it now, and who does. */
  async lease(key: string, holder: string, ttlSeconds: number): Promise<{ held: boolean; holder: string }> {
    const ttl = seconds(ttlSeconds, 0);
    named("A lease key", key);
    named("A lease holder", holder);
    return this.write<{ held: boolean; holder: string }>(async (tx) => {
      const r = rows(await tx`INSERT INTO leases (key, holder, until) VALUES (${key}, ${holder}, now() + make_interval(secs => ${ttl}))
        ON CONFLICT (key) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until, updated_at = now()
        WHERE leases.holder = EXCLUDED.holder OR leases.until <= now() RETURNING holder`);
      if (r.length) return { result: { held: true, holder }, event: { kind: "lease.taken", subject: `lease:${key}`, payload: { holder, ttl } } };
      const now = rows(await tx`SELECT holder FROM leases WHERE key = ${key}`);
      return { result: { held: false, holder: String(now[0]?.holder ?? "") }, event: null };
    });
  }

  /** Give a lease back; false (nothing changes) when `holder` doesn't hold it. */
  async unlease(key: string, holder: string): Promise<boolean> {
    return this.write(async (tx) => {
      const r = rows(await tx`DELETE FROM leases WHERE key = ${key} AND holder = ${holder} AND until > now() RETURNING key`);
      return { result: r.length > 0, event: r.length ? { kind: "lease.released", subject: `lease:${key}`, payload: { holder } } : null };
    });
  }

  /** Who holds a lease now: "" for nobody. */
  async leaseHolder(key: string): Promise<string> {
    return this.run(async () => String(rows(await this.sql`SELECT holder FROM leases WHERE key = ${key} AND until > now()`)[0]?.holder ?? ""));
  }

  /** Free a lease whoever holds it; false when nobody did. */
  async dropLease(key: string): Promise<boolean> {
    return this.write(async (tx) => {
      const r = rows(await tx`DELETE FROM leases WHERE key = ${key} RETURNING holder, until > now() AS live`);
      const live = Boolean(r[0]?.live);
      return { result: live, event: live ? { kind: "lease.dropped", subject: `lease:${key}`, payload: { holder: r[0]?.holder } } : null };
    });
  }

  // ---------- values ----------
  /** Keep `value` under `key`, replacing what was there, and record `signals` (each `signal.<name>`) in the same
   * transaction: a watcher's snapshot and the changes it saw land together or not at all. */
  async setValue(key: string, value: unknown, signals: { name: string; payload: Record<string, unknown> }[] = []): Promise<void> {
    named("A value's key", key);
    if (value === undefined) refuse("bad-input", "A value can't be undefined.", "Pass any JSON value (null included).");
    for (const s of signals) signalName(s.name);
    return this.run(() =>
      this.sql.begin(async (tx) => {
        await tx`INSERT INTO "values" (key, value, updated_by) VALUES (${key}, ${value as object}, ${this.as})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        await recordEvents(tx, this.as, this.session, [{ kind: "value.set", subject: `value:${key}`, payload: {} },
          ...signals.map((s) => ({ kind: `signal.${s.name}`, subject: `signal:${s.name}`, payload: s.payload }))]);
      }) as Promise<void>,
    );
  }

  /** The value kept under `key`, or null when there is none. */
  async value(key: string): Promise<unknown> {
    return this.run(async () => {
      const r = rows(await this.sql`SELECT value FROM "values" WHERE key = ${key}`);
      if (!r[0]) return null;
      const v = r[0].value;
      return typeof v === "string" ? (JSON.parse(v) as unknown) : v;
    });
  }

  /** Every value whose key starts with `prefix`, by key: its value, who wrote it last and when. */
  async values(prefix: string): Promise<{ key: string; value: unknown; updatedBy: string; updatedAt: Date }[]> {
    named("A value's key prefix", prefix);
    return this.run(async () => {
      const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return rows(await this.sql`SELECT key, value, updated_by, updated_at FROM "values" WHERE key LIKE ${like} ORDER BY key`).map((r) => ({
        key: String(r.key), value: typeof r.value === "string" ? (JSON.parse(r.value) as unknown) : r.value, updatedBy: String(r.updated_by),
        updatedAt: new Date(r.updated_at as string | Date),
      }));
    });
  }

  // ---------- signals ----------
  /** Record a signal: an event and nothing else (kind `signal.<name>`), for listeners such as a waiting agent. */
  async signal(name: string, payload: Record<string, unknown> = {}): Promise<void> {
    signalName(name);
    return this.write(async () => ({ result: undefined, event: { kind: `signal.${name}`, subject: `signal:${name}`, payload } }));
  }

  // ---------- context ----------
  /** Record a discovery, decision, blocker or result on a task: the next agent on a linked task starts with it. */
  async note(taskId: number, entry: { kind: ContextKind; body: string }): Promise<ContextEntry> {
    const kind = oneOf("A context entry's kind", entry.kind, CONTEXT_KINDS);
    if (typeof entry.body !== "string" || !entry.body.trim()) refuse("bad-input", "A context entry needs a body.", "Pass { body: \"...\" }.");
    return this.write(async (tx) => {
      await this.mustTask(tx, taskId);
      const { entry: c, event } = await this.noteIn(tx, taskId, kind, entry.body);
      return { result: c, event };
    });
  }

  /** Insert one context entry inside a transaction; its event. */
  private async noteIn(tx: Tx, taskId: number, kind: ContextKind, body: string): Promise<{ entry: ContextEntry; event: NewEvent }> {
    const r = rows(await tx.unsafe(`INSERT INTO context (task_id, kind, body, author) VALUES ($1, $2, $3, $4) RETURNING ${CONTEXT_COLS}`,
      [taskId, kind, body, this.as]));
    const c = toContext(r[0] as Row);
    return { entry: c, event: { kind: "context.noted", subject: `task:${taskId}`, payload: { id: c.id, kind } } };
  }

  /** A task's own context entries and those of every task linked to it by an edge (either way), oldest first. */
  async contextFor(taskId: number): Promise<ContextEntry[]> {
    return this.run(async () => rows(await this.sql.unsafe(`
      SELECT ${CONTEXT_COLS} FROM context WHERE task_id = $1
        OR task_id IN (SELECT to_id FROM edges WHERE from_id = $1 UNION SELECT from_id FROM edges WHERE to_id = $1)
      ORDER BY id`, [taskId])).map(toContext));
  }

  // ---------- views ----------
  /** An actor's start: what it holds (each with its context), what it may claim, what is blocked, recent events. */
  async prime(actor: string): Promise<Prime> {
    const holding = await this.tasksWhere("t.holder = $1", [actor]);
    return {
      actor,
      holding: await Promise.all(holding.map(async (task) => ({ task, context: await this.contextFor(task.id) }))),
      ready: await this.ready({ for: actor, limit: 50 }),
      blocked: await this.tasksWhere("t.status IN ('open', 'deferred') AND kb.blockers IS NOT NULL", [], undefined, 50),
      recent: (await this.recentEvents(20)),
    };
  }

  /** What waits on an actor: the tasks it holds or was handed, and the open messages addressed to it. */
  async onMe(actor: string): Promise<OnMe> {
    const tasks = await this.tasksWhere("t.holder = $1 OR (t.assignee = $1 AND t.holder IS NULL AND t.status = 'open')", [actor]);
    const messages = await this.run(async () => rows(await this.sql.unsafe(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE addressee = $1 AND state = 'open' ORDER BY id`, [actor])).map(toMessage));
    return { tasks, messages };
  }

  /** What an actor asked for and where each is: the tasks it made that it doesn't hold, and its open questions. */
  async delegated(actor: string): Promise<Delegated> {
    const tasks = await this.tasksWhere("t.created_by = $1 AND t.holder IS DISTINCT FROM $1", [actor], "t.updated_at DESC, t.id DESC", 200);
    const messages = await this.run(async () => rows(await this.sql.unsafe(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE sender = $1 AND state = 'open' ORDER BY id`, [actor])).map(toMessage));
    return { tasks, messages };
  }

  // ---------- import ----------
  /** Bring in tasks and their threads from somewhere else, keyed by outside ids: safe to run twice (a second run updates
   * what changed and adds what is new). All of it is one transaction. `dryRun` does the same work and rolls it back, so
   * the counts are what a real run would do and nothing is written. Writes events `task.imported` and `import.applied`.
   * `keepBoardStatus`: the board is the record, so a task whose status the board changed since the last import from this
   * source keeps it (a held task always does); its title, body, edges and new messages still come in. */
  async import(batch: ImportBatch, options: { dryRun?: boolean; keepBoardStatus?: boolean } = {}): Promise<ImportResult> {
    const dryRun = options.dryRun === true;
    let out: ImportResult | null = null;
    try {
      await this.run(() =>
        this.sql.begin(async (tx) => {
          const { result, events } = await applyImport(tx, batch, this.as, dryRun, options.keepBoardStatus === true);
          out = result;
          if (dryRun) throw new DryRun();
          await recordEvents(tx, this.as, this.session, events);
        }),
      );
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    return out as unknown as ImportResult;
  }

  /** The last import from `source`: when it was recorded and the options it kept; null when there was none. */
  async lastImport(source: string): Promise<{ at: Date; options: Record<string, unknown> } | null> {
    return this.run(async () => {
      const r = rows(await this.sql.unsafe(`SELECT ${EVENT_COLS} FROM events WHERE kind = 'import.applied' AND subject = $1 ORDER BY seq DESC LIMIT 1`,
        [`import:${source}`]));
      if (!r[0]) return null;
      const e = toEvent(r[0]);
      const o = e.payload.options;
      return { at: e.at, options: typeof o === "object" && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : {} };
    });
  }

  // ---------- events ----------
  /** The events after `after` (a seq), oldest first; with `since`, only those recorded at or after that time, and with
   * `kind`, only that kind. */
  async events(after = 0, limit = 500, options: { since?: Date; kind?: string } = {}): Promise<BoardEvent[]> {
    const since = options.since === undefined ? null : options.since.toISOString();
    return this.run(async () => rows(await this.sql.unsafe(`SELECT ${EVENT_COLS} FROM events WHERE seq > $1
      AND ($3::timestamptz IS NULL OR at >= $3::timestamptz) AND ($4::text IS NULL OR kind = $4::text) ORDER BY seq LIMIT $2`,
      [after, Math.floor(limit), since, options.kind ?? null])).map(toEvent));
  }

  /** The board's clock now: what a caller compares its own clock with (events carry the board's times). */
  async now(): Promise<Date> {
    return this.run(async () => {
      const v = rows(await this.sql`SELECT clock_timestamp() AS now`)[0]?.now;
      return v instanceof Date ? v : new Date(String(v));
    });
  }

  /** The last event's seq: 0 when there is none. */
  async lastSeq(): Promise<number> {
    return this.run(async () => Number(rows(await this.sql`SELECT COALESCE(max(seq), 0)::bigint::text AS seq FROM events`)[0]?.seq ?? 0));
  }

  private async recentEvents(n: number): Promise<BoardEvent[]> {
    return this.run(async () => rows(await this.sql.unsafe(`SELECT ${EVENT_COLS} FROM (SELECT * FROM events ORDER BY seq DESC LIMIT $1) e ORDER BY seq`,
      [n])).map(toEvent));
  }

  /** Call `onEvent` for each new event, in order and once each: after `after` (default: from now). A notification only
   * says something changed; the events are read from the table, again after a reconnect, so none is missed. */
  async listen(onEvent: (e: BoardEvent) => void | Promise<void>, options: { after?: number; onError?: (e: unknown) => void } = {}): Promise<Listener> {
    let cursor = options.after ?? (await this.recentEvents(1)).at(-1)?.seq ?? 0;
    let chain: Promise<void> = Promise.resolve();
    let closed = false;
    const pump = (): void => {
      chain = chain.then(async () => {
        for (;;) {
          if (closed) return;
          const batch = await this.events(cursor);
          for (const e of batch) {
            if (closed || e.seq <= cursor) continue;
            cursor = e.seq;
            await onEvent(e);
          }
          if (batch.length < 500) return;
        }
      }).catch((e: unknown) => options.onError?.(e));
    };
    const sub = await this.run(() => this.sql.listen("mb_events", () => pump(), () => pump()));
    pump();
    return {
      close: async () => {
        closed = true;
        await sub.unlisten();
        await chain;
      },
    };
  }
}
