// The GitHub adapter's mirror (#502, decision 0007 point 5): one way, from the board to GitHub, so people who follow the
// work on GitHub still can once the board is the record.
//
// - A task whose ref is one of the repo's issues (`github:<owner>/<repo>#<n>`) and whose state the board changed (a
//   claim, a release, a move, a close, a hand-off, a sweep, or an update that set its status) gets its state on the
//   issue: one call that sets its labels (the state's label from the mapping, and `agent:<holder>` while in progress,
//   leaving every other label alone) and opens or closes it, and one short line saying the new state. A state that ends
//   where it was last mirrored sends nothing. Tasks with no issue are left alone.
// - An ask addressed to the mapping's `asksTo` (the owner), and an answer to one, posted on the board on a task with an
//   issue (the factory puts them on the owner queue's), is posted there once, as it is, so GitHub notifies the owner;
//   the board's message is then linked to that comment (Board.linkMessage).
// - An answer given on GitHub under an open ask the board mirrored (a `factory-owner-answer id=<ask>` comment, or a plain
//   one after the ask) is read back once, as an import keyed by the comment's id.
// Every comment it writes carries `<!-- factory-mirror ... -->`, which the importer skips (no loop).
//
// Its place is a value on the board (`mirror:github:<owner>/<repo>`): the last event it read and the state it last sent
// for each task. Safe to run twice and after downtime: it reads the events after its place. A GitHub failure keeps the
// place where it was (with the states it did send), so the next run sends what is left, once.
import type { Board } from "../board.ts";
import type { BoardEvent, ImportMessage, Message, Task } from "../types.ts";
import { commentRef, FACTORY_MAPPING, type GhComment, type GhIssue, type Gh, ghCli, GithubError, type GithubMapping, MIRRORED, pages } from "./import.ts";

/** The marker on every comment the mirror writes. */
export const MIRROR_MARK = "factory-mirror";

export interface MirrorOptions {
  /** owner/name, lower case, as the import writes refs. */
  repo: string;
  gh?: Gh;
  mapping?: GithubMapping;
  /** The board value that keeps the mirror's place (default `mirror:github:<repo>`). */
  key?: string;
  /** Logins whose answers on GitHub are read back; empty or left out: anyone's. */
  trusted?: string[];
  /** Read the owner's answers back from GitHub (default true). */
  readBack?: boolean;
}

export interface MirrorSummary {
  repo: string;
  /** Tasks whose new state was sent, and tasks that changed and came back to the state last sent. */
  tasks: { mirrored: number; unchanged: number };
  /** Asks and answers posted to GitHub. */
  messages: number;
  /** Answers read back from GitHub. */
  answers: number;
  /** The `gh api` calls made. */
  calls: number;
  /** The last event read. */
  cursor: number;
}

interface Place {
  seq: number;
  /** The state last sent, by board task id. */
  states: Record<string, string>;
}

/** The board's own moves: the events that change a task's state. */
const MOVES = new Set(["task.claimed", "task.released", "task.closed", "task.moved", "task.assigned", "task.swept", "task.taken_back"]);
const ASK_ID = /<!--\s*factory-owner-ask\s+id=([\w.-]+)/g;
const ANSWER_ID = /<!--\s*factory-owner-answer\s+id=([\w.-]+)\s*-->/;
const ANY_MARKER = /<!--\s*(factory-[a-z][a-z-]*|pr-watch)\b/;
const SINCE_MARGIN_MS = 10 * 60 * 1000;

function placeOf(v: unknown): Place {
  const o = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const states = typeof o.states === "object" && o.states !== null && !Array.isArray(o.states) ? (o.states as Record<string, unknown>) : {};
  return { seq: typeof o.seq === "number" && Number.isInteger(o.seq) && o.seq >= 0 ? o.seq : 0,
    states: Object.fromEntries(Object.entries(states).filter((e): e is [string, string] => typeof e[1] === "string")) };
}

/** The state a task shows on GitHub: ready, in-progress, in-review, blocked (deferred) or done. */
export function mirrorState(t: Task): string {
  if (t.status === "done") return "done";
  if (t.status === "in_progress") return "in-progress";
  if (t.status === "in_review") return "in-review";
  if (t.status === "deferred") return "blocked";
  return "ready";
}

function isMove(e: BoardEvent): boolean {
  if (MOVES.has(e.kind)) return true;
  const f = e.payload.fields;
  return e.kind === "task.updated" && Array.isArray(f) && f.includes("status");
}

const labelNames = (i: GhIssue): string[] => (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
const askIds = (body: string): string[] => [...body.matchAll(ASK_ID)].map((m) => m[1] as string);

/** The one short line under the marker. */
function line(t: Task, state: string, reason: string | null): string {
  if (state === "in-progress") return `**${t.holder}** is working on this (on the board).`;
  if (state === "in-review") return "In review (on the board).";
  if (state === "blocked") return `**Blocked:** ${reason || "see the task on the board"}`;
  if (state === "done") return t.outcome && t.outcome !== "done" ? `Closed on the board (${t.outcome.replace("_", " ")}).` : "Done (on the board).";
  return `Ready (on the board)${reason ? `: ${reason}` : ""}.`;
}

class Run {
  readonly summary: MirrorSummary;
  private readonly prefix: string;

  constructor(private readonly board: Board, private readonly gh: Gh, private readonly o: MirrorOptions, private readonly map: GithubMapping,
    private readonly states: Record<string, string>) {
    this.prefix = `github:${o.repo}#`;
    this.summary = { repo: o.repo, tasks: { mirrored: 0, unchanged: 0 }, messages: 0, answers: 0, calls: 0, cursor: 0 };
  }

  /** The issue number a board task stands for in this repo, or null. */
  issueOf(t: Task): number | null {
    const ref = (t.ref ?? "").toLowerCase();
    if (!ref.startsWith(this.prefix)) return null;
    const n = ref.slice(this.prefix.length);
    return /^\d+$/.test(n) ? Number(n) : null;
  }

  async task(id: number, e: BoardEvent): Promise<void> {
    const t = await this.board.get(id);
    const n = this.issueOf(t);
    if (n === null) return;
    const state = mirrorState(t);
    const key = state === "in-progress" ? `${state}:${t.holder}` : state;
    if (this.states[String(id)] === key) {
      this.summary.tasks.unchanged++;
      return;
    }
    const L = this.map.labels;
    const path = `repos/${this.o.repo}/issues/${n}`;
    const issue = this.gh.get(path) as GhIssue;
    const have = labelNames(issue);
    const stateLabels = new Set([L.ready, L.inProgress, L.inReview, L.blocked]);
    const want = have.filter((l) => !stateLabels.has(l) && !l.startsWith(L.agentPrefix));
    const own: Record<string, string[]> = { ready: [L.ready], "in-progress": [L.inProgress, `${L.agentPrefix}${t.holder}`], "in-review": [L.inReview],
      blocked: [L.blocked], done: [] };
    want.push(...(own[state] ?? []));
    const ghState = state === "done" ? "closed" : "open";
    const same = want.length === have.length && want.every((l) => have.includes(l)) && (issue.state ?? "open") === ghState;
    if (!same) {
      this.gh.send("PATCH", path, { labels: want, state: ghState,
        ...(state === "done" ? { state_reason: t.outcome === "done" || !t.outcome ? "completed" : "not_planned" } : {}) });
    }
    const reason = typeof e.payload.reason === "string" ? e.payload.reason : null;
    this.gh.send("POST", `${path}/comments`, { body: `<!-- ${MIRROR_MARK} v=1 task=${id} state=${state} -->\n${line(t, state, reason)}` });
    this.states[String(id)] = key;
    this.summary.tasks.mirrored++;
  }

  async message(id: number): Promise<void> {
    const m = await this.board.message(id);
    if (m.ref !== null || m.taskId === null) return;
    if (m.kind === "ask" && m.to !== this.map.asksTo) return;
    if (m.kind === "answer") {
      if (m.inReplyTo === null || (await this.board.message(m.inReplyTo)).kind !== "ask") return;
    } else if (m.kind !== "ask") return;
    const n = this.issueOf(await this.board.get(m.taskId));
    if (n === null) return;
    const c = this.gh.send("POST", `repos/${this.o.repo}/issues/${n}/comments`,
      { body: `${m.body.trimEnd()}\n\n<!-- ${MIRROR_MARK} v=1 message=${m.id} -->` }) as { id?: unknown } | null;
    if (typeof c?.id !== "number") throw new GithubError("gh-failed", "GitHub didn't say which comment it made.", "Run `factory board mirror` again.");
    await this.board.linkMessage(m.id, commentRef(this.o.repo, c.id));
    this.summary.messages++;
  }

  /** The owner's answers on GitHub under the open asks the board mirrored, read back once. */
  async readBack(): Promise<void> {
    const open = (await this.board.onMe(this.map.asksTo)).messages.filter((m) => m.kind === "ask" && m.state === "open" && m.taskId !== null &&
      (m.ref ?? "").startsWith(`github:${this.o.repo}/comments/`));
    const byTask = new Map<number, Message[]>();
    for (const m of open) byTask.set(m.taskId as number, [...(byTask.get(m.taskId as number) ?? []), m]);
    const trusted = new Set(this.o.trusted ?? []);
    const messages: ImportMessage[] = [];
    for (const [taskId, asks] of byTask) {
      const t = await this.board.get(taskId);
      const n = this.issueOf(t);
      if (n === null) continue;
      const bySlug = new Map<string, Message>();
      for (const a of asks) for (const slug of askIds(a.body)) bySlug.set(slug, a);
      const since = new Date(Math.min(...asks.map((a) => a.createdAt.getTime())) - SINCE_MARGIN_MS).toISOString();
      const comments = pages<GhComment>(this.gh, `repos/${this.o.repo}/issues/${n}/comments?per_page=100&since=${since}`, (c) => c.id)
        .sort((a, b) => (Date.parse(a.created_at ?? "") || 0) - (Date.parse(b.created_at ?? "") || 0) || a.id - b.id);
      let lastAsk: string | null = null;
      const answered = new Set<number>();
      for (const c of comments) {
        const body = c.body ?? "";
        const asked = askIds(body);
        if (asked.length) {
          lastAsk = asked.at(-1) as string;
          continue;
        }
        if (MIRRORED.test(body) || !body.trim()) continue;
        if (trusted.size && !trusted.has(c.user?.login ?? "")) continue;
        const marked = ANSWER_ID.exec(body)?.[1] ?? null;
        if (!marked && ANY_MARKER.test(body)) continue; // a product owner's reply or another role's note: not the owner's answer
        const ask = bySlug.get(marked ?? lastAsk ?? "");
        if (!ask || answered.has(ask.id)) continue;
        answered.add(ask.id);
        messages.push({ ref: commentRef(this.o.repo, c.id), task: t.ref as string, kind: "answer", tag: marked ? "owner-answer" : "comment",
          from: this.map.asksTo, body, inReplyTo: ask.ref, createdAt: c.created_at ? new Date(c.created_at) : undefined });
      }
    }
    if (!messages.length) return;
    const r = await this.board.import({ source: `github:${this.o.repo}/owner-answers`, tasks: [], messages });
    this.summary.answers += r.messages.created;
  }
}

/** A GitHub failure, with the fix that says the change waits on the board. */
function waits(e: unknown): unknown {
  if (!(e instanceof GithubError)) return e;
  return new GithubError(e.code, e.message, `${e.code === "gh-signed-out" ? "Run `gh auth login`, then run" : e.code === "gh-rate-limited"
    ? "Wait until GitHub's hourly limit is back (`gh api rate_limit` says when), then run" : "Run"} \`factory board mirror\` again: ` +
    "what wasn't sent waits on the board, and nothing is sent twice.");
}

/** Send what changed on the board since the last run to `repo` on GitHub, and read the owner's answers back. */
export async function mirrorToGithub(board: Board, o: MirrorOptions): Promise<MirrorSummary> {
  const gh = o.gh ?? ghCli();
  const map = o.mapping ?? FACTORY_MAPPING;
  const key = o.key ?? `mirror:github:${o.repo}`;
  const place = placeOf(await board.value(key));
  const states = { ...place.states };
  const run = new Run(board, gh, o, map, states);

  const touched = new Map<number, BoardEvent>();
  const posted: number[] = [];
  let top = place.seq;
  let news = false;
  for (let after = place.seq; ;) {
    const page = await board.events(after, 500);
    for (const e of page) {
      top = e.seq;
      if (e.kind === "value.set" && e.subject === `value:${key}`) continue; // its own place
      news = true;
      const id = /^task:(\d+)$/.exec(e.subject)?.[1];
      if (id && isMove(e)) {
        touched.delete(Number(id)); // in the order of their last change
        touched.set(Number(id), e);
      }
      const mid = /^message:(\d+)$/.exec(e.subject)?.[1];
      if (mid && e.kind === "message.posted" && (e.payload.kind === "ask" || e.payload.kind === "answer")) posted.push(Number(mid));
    }
    if (page.length < 500) break;
    after = (page.at(-1) as BoardEvent).seq;
  }

  const sent = (): boolean => JSON.stringify(states) !== JSON.stringify(place.states);
  try {
    for (const [id, e] of touched) await run.task(id, e);
    for (const id of posted) await run.message(id);
  } catch (e) {
    if (sent()) await board.setValue(key, { seq: place.seq, states }).catch(() => {});
    throw waits(e);
  }
  // Only a run that read something new moves its place, so its own write never wakes it again.
  if (news || sent()) await board.setValue(key, { seq: top, states });
  if (o.readBack !== false) {
    try {
      await run.readBack();
    } catch (e) {
      throw waits(e);
    }
  }
  run.summary.calls = gh.calls;
  run.summary.cursor = top;
  return run.summary;
}
