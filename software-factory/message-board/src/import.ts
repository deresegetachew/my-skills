// An import, applied in one transaction (#494, decision 0007 point 4): tasks, parents, blocking edges, context entries
// and messages, each keyed by its outside id, so a second run updates what changed and never duplicates. The board's
// rules hold: a task held on the board keeps its status, an edge or parent that would make a loop is left out, and an
// answer marks the question it replies to answered. Knows nothing of GitHub: the adapters build the batch.
import type { SQL } from "bun";
import { refuse } from "./errors.ts";
import { GRAPH_LOCK, type NewEvent, reaches } from "./graph.ts";
import type { Row } from "./rows.ts";
import {
  CONTEXT_KINDS, type ImportBatch, type ImportMessage, type ImportResult, type ImportTask, MESSAGE_KINDS, OUTCOMES, TASK_KINDS,
} from "./types.ts";

const IMPORT_STATUSES = ["open", "in_review", "deferred", "done"] as const;

interface Current {
  id: number;
  title: string;
  body: string;
  kind: string;
  status: string;
  outcome: string | null;
  parentId: number | null;
  holder: string | null;
}

class Run {
  readonly result: ImportResult;
  readonly events: NewEvent[] = [];
  /** ref -> task id, for the batch's tasks and the board's tasks they name. */
  private readonly ids = new Map<string, number>();
  private readonly changed = new Map<number, Set<string>>();
  private readonly created = new Set<number>();

  constructor(private readonly tx: SQL, private readonly as: string, dryRun: boolean) {
    this.result = {
      dryRun,
      tasks: { created: 0, updated: 0, unchanged: 0 },
      edges: { added: 0, removed: 0 },
      parents: 0,
      messages: { created: 0, updated: 0, unchanged: 0 },
      notes: { created: 0, updated: 0, removed: 0 },
      skipped: [],
    };
  }

  private skip(ref: string, why: string): void {
    this.result.skipped.push({ ref, why });
  }

  private mark(id: number, field: string): void {
    const s = this.changed.get(id) ?? new Set<string>();
    s.add(field);
    this.changed.set(id, s);
  }

  /** The id of the task with this ref: in the batch, or already on the board; null when neither. */
  async idOf(ref: string): Promise<number | null> {
    const known = this.ids.get(ref);
    if (known !== undefined) return known;
    const r = (await this.tx`SELECT id::int AS id FROM tasks WHERE external_ref = ${ref}`) as Row[];
    if (!r[0]) return null;
    this.ids.set(ref, Number(r[0].id));
    return Number(r[0].id);
  }

  private async current(ref: string): Promise<Current | null> {
    const r = (await this.tx`SELECT id::int AS id, title, body, kind, status, outcome, parent_id::int AS parent_id, holder
      FROM tasks WHERE external_ref = ${ref} FOR UPDATE`) as Row[];
    const c = r[0];
    if (!c) return null;
    return { id: Number(c.id), title: String(c.title), body: String(c.body), kind: String(c.kind), status: String(c.status),
      outcome: c.outcome === null ? null : String(c.outcome), parentId: c.parent_id === null ? null : Number(c.parent_id),
      holder: c.holder === null ? null : String(c.holder) };
  }

  async task(t: ImportTask): Promise<void> {
    const kind = t.kind ?? "task";
    const outcome = t.status === "done" ? (t.outcome ?? "done") : null;
    const body = t.body ?? "";
    const now = await this.current(t.ref);
    if (!now) {
      const r = (await this.tx`INSERT INTO tasks (title, body, kind, status, outcome, external_ref, created_by, created_at)
        VALUES (${t.title}, ${body}, ${kind}, ${t.status}, ${outcome}, ${t.ref}, ${this.as}, ${t.createdAt ?? new Date()})
        RETURNING id::int AS id`) as Row[];
      const id = Number(r[0]?.id);
      this.ids.set(t.ref, id);
      this.created.add(id);
      this.result.tasks.created++;
      return;
    }
    this.ids.set(t.ref, now.id);
    const set: string[] = [];
    const params: unknown[] = [now.id];
    const put = (col: string, field: string, v: unknown): void => {
      params.push(v);
      set.push(`${col} = $${params.length}`);
      this.mark(now.id, field);
    };
    if (now.title !== t.title) put("title", "title", t.title);
    if (now.body !== body) put("body", "body", body);
    if (now.kind !== kind) put("kind", "kind", kind);
    if (now.status !== t.status || now.outcome !== outcome) {
      if (now.holder) this.skip(t.ref, `status kept: held on the board by ${now.holder}`);
      else {
        if (now.status !== t.status) put("status", "status", t.status);
        if (now.outcome !== outcome) put("outcome", "outcome", outcome);
      }
    }
    if (set.length) await this.tx.unsafe(`UPDATE tasks SET ${set.join(", ")}, version = version + 1, updated_at = now() WHERE id = $1`, params);
  }

  async parent(t: ImportTask): Promise<void> {
    if (t.parentRef === undefined) return;
    const id = this.ids.get(t.ref) as number;
    const r = (await this.tx`SELECT t.parent_id::int AS parent, p.external_ref AS pref FROM tasks t LEFT JOIN tasks p ON p.id = t.parent_id
      WHERE t.id = ${id}`) as Row[];
    const before = r[0]?.parent === null || r[0]?.parent === undefined ? null : Number(r[0].parent);
    let want: number | null = null;
    if (t.parentRef === null) {
      if (before === null || r[0]?.pref === null) return; // no parent, or one set on the board: kept
    } else {
      want = await this.idOf(t.parentRef);
      if (want === null) return this.skip(t.ref, `its parent ${t.parentRef} isn't on the board`);
      if (want === before) return;
      if (want === id || (await reaches(this.tx, id, want))) return this.skip(t.ref, `parent ${t.parentRef} left out: it would make a loop`);
    }
    await this.tx`UPDATE tasks SET parent_id = ${want}, version = version + 1, updated_at = now() WHERE id = ${id}`;
    this.mark(id, "parent");
    this.result.parents++;
  }

  async edges(t: ImportTask): Promise<void> {
    if (t.blockedBy === undefined) return;
    const to = this.ids.get(t.ref) as number;
    const want = new Set<number>();
    for (const ref of t.blockedBy) {
      const from = await this.idOf(ref);
      if (from === null) this.skip(t.ref, `depends on ${ref}, which isn't on the board`);
      else want.add(from);
    }
    const have = new Map<number, string>();
    for (const e of (await this.tx`SELECT from_id::int AS f, created_by FROM edges WHERE to_id = ${to} AND kind = 'blocks'`) as Row[]) {
      have.set(Number(e.f), String(e.created_by));
    }
    for (const [from, by] of have) {
      if (want.has(from) || by !== this.as) continue;
      await this.tx`DELETE FROM edges WHERE from_id = ${from} AND to_id = ${to} AND kind = 'blocks'`;
      this.mark(to, "edges");
      this.result.edges.removed++;
    }
    for (const from of want) {
      if (have.has(from)) continue;
      if (from === to || (await reaches(this.tx, to, from))) {
        this.skip(t.ref, `the edge from ${t.blockedBy.find((r) => this.ids.get(r) === from) ?? from} left out: it would make a loop`);
        continue;
      }
      await this.tx`INSERT INTO edges (from_id, to_id, kind, created_by) VALUES (${from}, ${to}, 'blocks', ${this.as})`;
      this.mark(to, "edges");
      this.result.edges.added++;
    }
  }

  async notes(t: ImportTask): Promise<void> {
    if (t.notes === undefined) return;
    const id = this.ids.get(t.ref) as number;
    const keep = new Set(t.notes.map((n) => n.ref));
    for (const r of (await this.tx`SELECT id::int AS id, external_ref FROM context WHERE task_id = ${id} AND external_ref IS NOT NULL`) as Row[]) {
      if (keep.has(String(r.external_ref))) continue;
      await this.tx`DELETE FROM context WHERE id = ${Number(r.id)}`;
      this.mark(id, "context");
      this.result.notes.removed++;
    }
    for (const n of t.notes) {
      const r = (await this.tx`SELECT id::int AS id, kind, body, task_id::int AS task FROM context WHERE external_ref = ${n.ref}`) as Row[];
      const c = r[0];
      if (!c) {
        await this.tx`INSERT INTO context (task_id, kind, body, author, external_ref) VALUES (${id}, ${n.kind}, ${n.body}, ${this.as}, ${n.ref})`;
        this.result.notes.created++;
      } else if (String(c.kind) !== n.kind || String(c.body) !== n.body || Number(c.task) !== id) {
        await this.tx`UPDATE context SET kind = ${n.kind}, body = ${n.body}, task_id = ${id} WHERE id = ${Number(c.id)}`;
        this.result.notes.updated++;
      } else continue;
      this.mark(id, "context");
    }
  }

  async message(m: ImportMessage): Promise<void> {
    const task = await this.idOf(m.task);
    if (task === null) return this.skip(m.ref, `on ${m.task}, which isn't on the board`);
    const to = m.to ?? null;
    const tag = m.tag ?? null;
    const parent = m.inReplyTo ? ((await this.tx`SELECT id::int AS id, thread_id::int AS thread, state FROM messages
      WHERE external_ref = ${m.inReplyTo} FOR UPDATE`) as Row[])[0] ?? null : null;
    const r = (await this.tx`SELECT id::int AS id, kind, tag, sender, addressee, body, in_reply_to::int AS reply FROM messages
      WHERE external_ref = ${m.ref}`) as Row[];
    const now = r[0];
    if (now) {
      // A reply whose target this run couldn't find (on an issue with nothing new, or not on the board) keeps its link.
      const reply = parent ? Number(parent.id) : now.reply === null ? null : Number(now.reply);
      const same = String(now.kind) === m.kind && (now.tag ?? null) === tag && String(now.sender) === m.from && (now.addressee ?? null) === to &&
        String(now.body) === m.body && (now.reply === null ? null : Number(now.reply)) === reply;
      if (same) {
        this.result.messages.unchanged++;
        return;
      }
      await this.tx`UPDATE messages SET kind = ${m.kind}, tag = ${tag}, sender = ${m.from}, addressee = ${to}, body = ${m.body},
        in_reply_to = ${reply} WHERE id = ${Number(now.id)}`;
      this.result.messages.updated++;
      this.mark(task, "thread");
      return;
    }
    const id = Number(((await this.tx`SELECT nextval(pg_get_serial_sequence('messages', 'id'))::int AS id`) as Row[])[0]?.id);
    let thread = parent ? Number(parent.thread) : null;
    if (thread === null) {
      const first = (await this.tx`SELECT thread_id::int AS thread FROM messages WHERE task_id = ${task} AND external_ref IS NOT NULL
        AND in_reply_to IS NULL ORDER BY id LIMIT 1`) as Row[];
      thread = first[0] ? Number(first[0].thread) : id;
    }
    if (m.kind === "answer" && parent && parent.state === "open") await this.tx`UPDATE messages SET state = 'answered' WHERE id = ${Number(parent.id)}`;
    const state = m.kind === "question" || m.kind === "ask" ? "open" : "closed";
    await this.tx.unsafe(`INSERT INTO messages (id, external_ref, tag, task_id, thread_id, kind, sender, addressee, state, in_reply_to, body, created_at)
      OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, m.ref, tag, task, thread, m.kind, m.from, to, state, parent ? Number(parent.id) : null, m.body, m.createdAt ?? new Date()]);
    this.result.messages.created++;
    this.mark(task, "thread");
  }

  /** One event per task made or changed, then the run's own. */
  close(batch: ImportBatch): void {
    for (const [ref, id] of this.ids) {
      if (this.created.has(id)) this.events.push({ kind: "task.imported", subject: `task:${id}`, payload: { ref, created: true } });
      else if (this.changed.has(id)) this.events.push({ kind: "task.imported", subject: `task:${id}`, payload: { ref, created: false, fields: [...(this.changed.get(id) ?? [])] } });
    }
    const { dryRun: _, ...counts } = this.result;
    this.events.push({ kind: "import.applied", subject: `import:${batch.source}`, payload: { source: batch.source, options: batch.options ?? {}, ...counts } });
  }

  /** A task counts as updated when a field, its parent, its edges or its context changed. */
  tallyTasks(batch: ImportBatch): void {
    for (const t of batch.tasks) {
      const id = this.ids.get(t.ref) as number;
      if (this.created.has(id)) continue;
      const f = this.changed.get(id);
      if (f && [...f].some((x) => x !== "thread")) this.result.tasks.updated++;
      else this.result.tasks.unchanged++;
    }
  }
}

function check(batch: ImportBatch): void {
  if (typeof batch.source !== "string" || !batch.source.trim()) refuse("bad-input", "An import names its source.", "Pass { source: \"github:owner/repo\", ... }.");
  const seen = new Set<string>();
  for (const t of batch.tasks) {
    if (typeof t.ref !== "string" || !t.ref.trim()) refuse("bad-input", "Every imported task needs a ref.", "Give each task its outside id as `ref`.");
    if (seen.has(t.ref)) refuse("bad-input", `${t.ref} is in the import twice.`, "Give each task once.");
    seen.add(t.ref);
    if (typeof t.title !== "string" || !t.title.trim()) refuse("bad-input", `${t.ref} has no title.`, "Give each task a title.");
    if (!(IMPORT_STATUSES as readonly string[]).includes(t.status)) refuse("bad-input", `${t.ref}: status ${JSON.stringify(t.status)} can't be imported.`, `Use one of: ${IMPORT_STATUSES.join(", ")}.`);
    if (t.kind !== undefined && !(TASK_KINDS as readonly string[]).includes(t.kind)) refuse("bad-input", `${t.ref}: kind ${JSON.stringify(t.kind)} isn't a task kind.`, `Use one of: ${TASK_KINDS.join(", ")}.`);
    if (t.outcome != null && !(OUTCOMES as readonly string[]).includes(t.outcome)) refuse("bad-input", `${t.ref}: outcome ${JSON.stringify(t.outcome)} isn't one.`, `Use one of: ${OUTCOMES.join(", ")}.`);
    for (const n of t.notes ?? []) {
      if (!(CONTEXT_KINDS as readonly string[]).includes(n.kind)) refuse("bad-input", `${t.ref}: context kind ${JSON.stringify(n.kind)} isn't one.`, `Use one of: ${CONTEXT_KINDS.join(", ")}.`);
    }
  }
  for (const m of batch.messages) {
    if (!(MESSAGE_KINDS as readonly string[]).includes(m.kind)) refuse("bad-input", `${m.ref}: message kind ${JSON.stringify(m.kind)} isn't one.`, `Use one of: ${MESSAGE_KINDS.join(", ")}.`);
    if (typeof m.body !== "string" || !m.body.trim() || !m.from) refuse("bad-input", `${m.ref} needs a body and a sender.`, "Leave out empty messages.");
  }
}

/** Apply `batch` in `tx` as `as`; returns what it did and the events to record. */
export async function applyImport(tx: SQL, batch: ImportBatch, as: string, dryRun: boolean): Promise<{ result: ImportResult; events: NewEvent[] }> {
  check(batch);
  const run = new Run(tx, as, dryRun);
  // The graph lock before any row lock, as every write that touches edges or parents takes them (#503), so an import
  // and an edit can't wait on each other.
  await tx`SELECT pg_advisory_xact_lock(${GRAPH_LOCK})`;
  for (const t of batch.tasks) await run.task(t);
  for (const t of batch.tasks) await run.parent(t);
  for (const t of batch.tasks) await run.edges(t);
  for (const t of batch.tasks) await run.notes(t);
  for (const m of batch.messages) await run.message(m);
  run.tallyTasks(batch);
  run.close(batch);
  return { result: run.result, events: run.events };
}
