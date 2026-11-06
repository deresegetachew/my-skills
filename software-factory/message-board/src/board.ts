// The Board: factory-message-board's API over one Postgres (decision 0007 point 10). Each write is one transaction
// that also inserts its event and NOTIFYs mb_events with the event's seq, so a listener re-reads from its cursor.
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { BoardError, refuse } from "./errors.ts";
import { applied, migrate } from "./migrate.ts";
import { CONTEXT_COLS, EVENT_COLS, MESSAGE_COLS, type Row, TASK_SELECT, toContext, toEvent, toMessage, toTask } from "./rows.ts";
import {
  BLOCKING, type BoardEvent, type Claim, CONTEXT_KINDS, type ContextEntry, type ContextKind, type Delegated, EDGE_KINDS, type EdgeKind,
  type Message, MESSAGE_KINDS, type NewMessage, type NewTask, type Next, type OnMe, type Outcome, OUTCOMES, type Prime, type Task,
  TASK_KINDS, type TaskChanges,
} from "./types.ts";

/** How long a claim lasts before it needs a heartbeat, and how long a holder may be silent before the sweep. */
export const CLAIM_SECONDS = 30 * 60;
export const QUIET_SECONDS = 30 * 60;
const GRAPH_LOCK = 4_891_008; // serialises edge and parent writes, so two of them can't close a loop together
const EVENT_LOCK = 4_891_009; // serialises event inserts to commit order, so a reader's cursor never skips one
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

function rows(r: unknown): Row[] {
  return r as Row[];
}

/** A Postgres or connection error as a BoardError; a BoardError as it is. */
function translate(e: unknown): unknown {
  if (e instanceof BoardError) return e;
  const err = e as { errno?: string; code?: string; message?: string };
  const state = err.errno ?? "";
  const msg = (err.message ?? String(e)).replace(/\/\/[^@\s]*@/g, "//***@");
  if (state === "42P01" || state === "42703") return new BoardError("schema-old", `The board's tables are missing or old: ${msg}`, MIGRATE_FIX);
  if (state === "23503") return new BoardError("not-found", `That refers to something that isn't on the board: ${msg}`, "Check the id, then try again.");
  if (state === "23505") return new BoardError("bad-input", `That is already on the board: ${msg}`, "Use the one that is there (an external ref is unique).");
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

function seconds(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) refuse("bad-input", `A time in seconds must be 0 or more, not ${value}.`, "Pass a number of seconds.");
  return value;
}

export class Board {
  private constructor(private readonly sql: SQL, readonly as: string, readonly session: string | null) {}

  /** Connect to the board's database at `url` (checked with one query). */
  static async open(url: string, options: OpenOptions = {}): Promise<Board> {
    const as = options.as ?? "system";
    if (!as.trim()) refuse("bad-input", "An actor needs a name.", "Open the board with { as: \"<name>\" }.");
    const sql = new SQL(url, { max: options.max ?? 4, connectionTimeout: 10 });
    try {
      await sql`SELECT 1`;
    } catch (e) {
      await sql.close().catch(() => {});
      const t = translate(e);
      if (t instanceof BoardError) throw t;
      throw new BoardError("no-answer", `The board's database doesn't answer: ${String(translate(e)).replace(/\/\/[^@\s]*@/g, "//***@")}`,
        "Start it (`factory board up`) or check its URL, then try again.");
    }
    return new Board(sql, as, options.session ?? null);
  }

  /** Close the connections. (`close` closes a task.) */
  async end(): Promise<void> {
    await this.sql.close();
  }

  /** Apply the migrations not applied yet; returns their names. */
  async migrate(): Promise<string[]> {
    return this.run(() => migrate(this.sql));
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
        if (event) {
          await tx`SELECT pg_advisory_xact_lock(${EVENT_LOCK})`;
          const ev = rows(await tx`INSERT INTO events (kind, subject, actor, actor_session, payload)
            VALUES (${event.kind}, ${event.subject}, ${this.as}, ${this.session}, ${event.payload})
            RETURNING seq::text AS seq`);
          await tx`SELECT pg_notify('mb_events', ${String(ev[0]?.seq)})`;
        }
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
    if (!t) refuse("not-found", `There is no task #${id} on the board.`, "Check the id (`factory board tasks` lists them).");
    return t;
  }

  private async tasksWhere(where: string, params: unknown[], order = "t.priority, t.created_at, t.id", limit = 500): Promise<Task[]> {
    return this.run(async () => rows(await this.sql.unsafe(`${TASK_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ${Math.floor(limit)}`, params)).map(toTask));
  }

  private async seen(tx: Tx, actor: string): Promise<void> {
    await tx`INSERT INTO actors (id, seen_at) VALUES (${actor}, now()) ON CONFLICT (id) DO UPDATE SET seen_at = now()`;
  }

  /** Whether `target` is reachable from `start` by blocking edges and parent-to-child steps (a block on a task also
   * blocks its children). An edge or parent that adds a step back from `target` to `start` would close a loop. */
  private async reaches(tx: Tx, start: number, target: number): Promise<boolean> {
    const r = rows(await tx.unsafe(`
      WITH RECURSIVE reach (id) AS (
        SELECT $1::bigint
        UNION
        SELECT n.id FROM reach r CROSS JOIN LATERAL (
          SELECT e.to_id AS id FROM edges e WHERE e.from_id = r.id AND e.kind IN ('blocks', 'waits_for')
          UNION ALL
          SELECT c.id FROM tasks c WHERE c.parent_id = r.id
        ) n
      )
      SELECT EXISTS (SELECT 1 FROM reach WHERE id = $2::bigint) AS hit`, [start, target]));
    return Boolean(r[0]?.hit);
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
    return this.write(async (tx) => {
      const before = await this.mustTask(tx, id);
      if (changes.parentId !== undefined && changes.parentId !== null) {
        await tx`SELECT pg_advisory_xact_lock(${GRAPH_LOCK})`;
        if (changes.parentId === id || (await this.reaches(tx, id, changes.parentId))) {
          refuse("cycle", `#${changes.parentId} can't be the parent of #${id}: that makes a loop (it is #${id} itself, under it, or waits on it).`,
            "Choose another parent, or remove the edge that makes the loop first.");
        }
      }
      if (changes.status && changes.status !== "in_review" && before.holder) {
        refuse("bad-input", `#${id} is held by ${before.holder}; update can't move it to ${changes.status}.`,
          "The holder releases it (board.release with next ready or deferred), or the sweep does once the claim is stale.");
      }
      const r = rows(await tx.unsafe(`UPDATE tasks SET ${[...set, "version = version + 1", "updated_at = now()"].join(", ")}
        WHERE id = $1 AND version = $2 RETURNING id`, params));
      if (!r.length) {
        refuse("conflict", `#${id} has changed since you read it (you read version ${version}; it is at ${before.version}).`,
          "Read it again (board.get), apply your change to what is there now, and send it with the new version.");
      }
      const task = (await this.taskIn(tx, id)) as Task;
      const fields = Object.keys(changes).filter((k) => k !== "version");
      return { result: task, event: { kind: "task.updated", subject: `task:${id}`, payload: { fields, version: task.version } } };
    });
  }

  /** Link two tasks: `from` blocks, waits for, was discovered from ... `to`. A loop of blocking edges is refused. */
  async link(from: number, to: number, kind: EdgeKind): Promise<boolean> {
    const k = oneOf("An edge's kind", kind, EDGE_KINDS);
    return this.write(async (tx) => {
      await this.mustTask(tx, from);
      await this.mustTask(tx, to);
      if (from === to) {
        refuse(BLOCKING.includes(k) ? "cycle" : "bad-input", `A task can't ${k.replace("_", " ")} itself (#${from}).`, "Link two different tasks.");
      }
      if (BLOCKING.includes(k)) {
        await tx`SELECT pg_advisory_xact_lock(${GRAPH_LOCK})`;
        if (await this.reaches(tx, to, from)) {
          refuse("cycle", `#${from} ${k.replace("_", " ")} #${to} would make a loop: #${from} already waits on #${to}, or is under it.`,
            "Remove the edge that makes the loop first, or link them the other way.");
        }
      }
      const r = rows(await tx`INSERT INTO edges (from_id, to_id, kind, created_by) VALUES (${from}, ${to}, ${k}, ${this.as})
        ON CONFLICT DO NOTHING RETURNING from_id`);
      return { result: r.length > 0, event: r.length ? { kind: "edge.linked", subject: `task:${from}`, payload: { from, to, kind: k } } : null };
    });
  }

  async unlink(from: number, to: number, kind: EdgeKind): Promise<boolean> {
    const k = oneOf("An edge's kind", kind, EDGE_KINDS);
    return this.write(async (tx) => {
      const r = rows(await tx`DELETE FROM edges WHERE from_id = ${from} AND to_id = ${to} AND kind = ${k} RETURNING from_id`);
      return { result: r.length > 0, event: r.length ? { kind: "edge.unlinked", subject: `task:${from}`, payload: { from, to, kind: k } } : null };
    });
  }

  /** The edges from or to a task. */
  async edges(id: number): Promise<{ from: number; to: number; kind: EdgeKind }[]> {
    return this.run(async () => rows(await this.sql`SELECT from_id::int AS f, to_id::int AS t, kind FROM edges
      WHERE from_id = ${id} OR to_id = ${id} ORDER BY created_at, from_id, to_id`).map((r) => ({ from: Number(r.f), to: Number(r.t), kind: r.kind as EdgeKind })));
  }

  /** The ready queue, in claim order: open, not blocked, held by nobody (and handed to nobody else than `for`). */
  async ready(options: { for?: string; limit?: number } = {}): Promise<Task[]> {
    const who = options.for ?? null;
    return this.tasksWhere("t.id IN (SELECT id FROM ready) AND (t.assignee IS NULL OR t.assignee = $1::text OR $1::text IS NULL)", [who],
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
        r = rows(await tx.unsafe(`
          WITH pick AS (
            SELECT id FROM tasks
            WHERE status = 'open' AND holder IS NULL AND (assignee IS NULL OR assignee = $1)
              AND NOT EXISTS (SELECT 1 FROM task_blockers k WHERE k.task_id = tasks.id)
            ORDER BY priority, created_at, id
            LIMIT 1 FOR UPDATE SKIP LOCKED
          )
          UPDATE tasks t SET holder = $1, claim_token = $2, claimed_at = now(), claim_until = now() + make_interval(secs => $3),
            status = 'in_progress', version = t.version + 1, updated_at = now()
          FROM pick WHERE t.id = pick.id AND t.status = 'open' AND t.holder IS NULL
          RETURNING t.id`, [this.as, token, ttl]));
        if (!r.length) return { result: null, event: null };
      } else {
        wholeNumber("A task id", id);
        r = rows(await tx.unsafe(`
          UPDATE tasks t SET holder = $1, claim_token = $2, claimed_at = now(), claim_until = now() + make_interval(secs => $3),
            status = CASE WHEN t.holder = $1 THEN t.status ELSE 'in_progress' END, version = t.version + 1, updated_at = now()
          WHERE t.id = $4 AND (t.holder = $1 OR (t.status = 'open' AND t.holder IS NULL AND (t.assignee IS NULL OR t.assignee = $1)
            AND NOT EXISTS (SELECT 1 FROM task_blockers k WHERE k.task_id = t.id)))
          RETURNING t.id`, [this.as, token, ttl, id]));
        if (!r.length) await this.whyNotReady(tx, id);
      }
      await this.seen(tx, this.as);
      const task = (await this.taskIn(tx, Number(r[0]?.id))) as Task;
      return { result: { task, token }, event: { kind: "task.claimed", subject: `task:${task.id}`, payload: { holder: this.as, until: task.claimUntil } } };
    });
  }

  private async whyNotReady(tx: Tx, id: number): Promise<never> {
    const t = await this.mustTask(tx, id);
    const why = t.holder ? `${t.holder} holds it`
      : t.blocked ? `it is blocked by ${t.blockedBy.map((b) => `#${b}`).join(", ")}`
      : t.status !== "open" ? `it is ${t.status}`
      : t.assignee && t.assignee !== this.as ? `it was handed to ${t.assignee}`
      : "it changed while you claimed it";
    return refuse("not-ready", `#${id} isn't ready for ${this.as}: ${why}.`, "Claim another task (`board.claim()` takes the first ready one), or wait for it.");
  }

  /** A token-checked update; refused with `claim-lost` when the token no longer holds the task. */
  private async fenced(tx: Tx, id: number, token: string, setSql: string, params: unknown[]): Promise<Task> {
    const r = rows(await tx.unsafe(`UPDATE tasks SET ${setSql}, version = version + 1, updated_at = now()
      WHERE id = $1 AND claim_token = $2 RETURNING id`, [id, token, ...params]));
    if (!r.length) {
      const t = await this.mustTask(tx, id);
      refuse("claim-lost", `Your claim on #${id} is gone: ${t.holder ? `${t.holder} holds it now` : "nobody holds it now"}.`,
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

  /** Give a held task back, saying what happens next: ready (anyone may claim it), deferred, or handed to one actor. */
  async release(id: number, token: string, next: Next): Promise<Task> {
    const n = oneOf("next", next.next, ["ready", "deferred", "handoff"] as const);
    if (typeof next.reason !== "string" || !next.reason.trim()) refuse("bad-input", "A release says why.", "Pass { next, reason: \"...\" }.");
    const to = next.next === "handoff" ? next.to : undefined;
    if (n === "handoff" && (typeof to !== "string" || !to.trim())) refuse("bad-input", "A hand-off names who takes it.", "Pass { next: \"handoff\", to: \"<actor>\", reason }.");
    const status = n === "deferred" ? "deferred" : "open";
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
          WHERE id = $1 AND holder IS NULL RETURNING id`, [id, outcome]));
        if (!r.length) {
          const t = await this.mustTask(tx, id);
          refuse("claim-lost", `#${id} is held by ${t.holder}; only its holder closes it, with its token.`,
            "Ask the holder to close it, or wait until it is released.");
        }
        task = (await this.taskIn(tx, id)) as Task;
      }
      return { result: task, event: { kind: "task.closed", subject: `task:${id}`, payload: { outcome, reason: options.reason ?? null } } };
    });
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
          UPDATE tasks t SET holder = NULL, claim_token = NULL, claimed_at = NULL, claim_until = NULL, status = 'open',
            version = t.version + 1, updated_at = now()
          FROM stale WHERE t.id = stale.id AND t.holder = stale.holder AND ${stale}
          RETURNING t.id::int AS id, stale.holder AS holder`, [quiet]));
        if (swept.length) {
          await tx`SELECT pg_advisory_xact_lock(${EVENT_LOCK})`;
          for (const s of swept) {
            const ev = rows(await tx`INSERT INTO events (kind, subject, actor, actor_session, payload)
              VALUES ('task.swept', ${`task:${s.id}`}, 'system', ${this.session}, ${{ holder: s.holder, quietSeconds: quiet }}) RETURNING seq::text AS seq`);
            await tx`SELECT pg_notify('mb_events', ${String(ev[0]?.seq)})`;
          }
        }
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
        const p = rows(await tx`SELECT thread_id::int AS thread, task_id::int AS task, state FROM messages WHERE id = ${input.inReplyTo} FOR UPDATE`);
        if (!p[0]) refuse("not-found", `There is no message ${input.inReplyTo} to reply to.`, "Check the id (board.thread lists a thread).");
        thread = Number(p[0].thread);
        task = task ?? (p[0].task === null ? null : Number(p[0].task));
        if (kind === "answer" && p[0].state === "open") await tx`UPDATE messages SET state = 'answered' WHERE id = ${input.inReplyTo}`;
      }
      const id = Number(rows(await tx`SELECT nextval(pg_get_serial_sequence('messages', 'id'))::int AS id`)[0]?.id);
      const state = kind === "question" || kind === "ask" ? "open" : "closed";
      const r = rows(await tx.unsafe(`INSERT INTO messages (id, task_id, thread_id, kind, sender, addressee, state, in_reply_to, body)
        OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${MESSAGE_COLS}`,
        [id, task, thread ?? id, kind, this.as, input.to ?? null, state, input.inReplyTo ?? null, input.body]));
      const m = toMessage(r[0] as Row);
      return { result: m, event: { kind: "message.posted", subject: `message:${m.id}`, payload: { task: m.taskId, thread: m.threadId, kind, to: m.to, inReplyTo: m.inReplyTo } } };
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

  // ---------- context ----------
  /** Record a discovery, decision, blocker or result on a task: the next agent on a linked task starts with it. */
  async note(taskId: number, entry: { kind: ContextKind; body: string }): Promise<ContextEntry> {
    const kind = oneOf("A context entry's kind", entry.kind, CONTEXT_KINDS);
    if (typeof entry.body !== "string" || !entry.body.trim()) refuse("bad-input", "A context entry needs a body.", "Pass { body: \"...\" }.");
    return this.write(async (tx) => {
      await this.mustTask(tx, taskId);
      const r = rows(await tx.unsafe(`INSERT INTO context (task_id, kind, body, author) VALUES ($1, $2, $3, $4) RETURNING ${CONTEXT_COLS}`,
        [taskId, kind, entry.body, this.as]));
      const c = toContext(r[0] as Row);
      return { result: c, event: { kind: "context.noted", subject: `task:${taskId}`, payload: { id: c.id, kind } } };
    });
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

  // ---------- events ----------
  /** The events after `after` (a seq), oldest first. */
  async events(after = 0, limit = 500): Promise<BoardEvent[]> {
    return this.run(async () => rows(await this.sql.unsafe(`SELECT ${EVENT_COLS} FROM events WHERE seq > $1 ORDER BY seq LIMIT $2`,
      [after, Math.floor(limit)])).map(toEvent));
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
