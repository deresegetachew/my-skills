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
// place where it was (with the states it did send), so the next run sends what is left, once. A task's line and an ask
// or answer are recorded as pending in the place before they are posted, each with a marker of its own, so a pass killed
// after the post and before it saved finds that comment by its marker on the next run and doesn't post it again (#513).
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
  /** How long a pass waits while another holds this mirror (default 15 s); then it sends nothing (`busy`). */
  waitMs?: number;
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
  /** Another pass of this mirror was running the whole time this one waited: it sent nothing. */
  busy?: boolean;
}

interface Place {
  seq: number;
  /** The state last sent, by board task id. */
  states: Record<string, string>;
  /** Messages whose comment is being posted: a pass that died after posting one is found by its marker, not posted again. */
  pending: number[];
  /** Task lines being posted, by board task id, oldest first: the state each sends, its marker's id and when (ISO); found
   * the same way. Each is kept until a line for the task is posted and saved, so none is posted twice (#515). */
  lines: Record<string, PendingLine[]>;
}

interface PendingLine {
  key: string;
  line: string;
  at: string;
}

/** The board's own moves: the events that change a task's state. */
const MOVES = new Set(["task.claimed", "task.released", "task.closed", "task.moved", "task.assigned", "task.swept", "task.taken_back"]);
/** The kinds that are work items: epics, notes (the owner queue) and decisions keep their labels. */
const WORK = new Set(["task", "bug"]);
const ASK_ID = /<!--\s*factory-owner-ask\s+id=([\w.-]+)/g;
const ANSWER_ID = /<!--\s*factory-owner-answer\s+id=([\w.-]+)\s*-->/;
const ANY_MARKER = /<!--\s*(factory-[a-z][a-z-]*|pr-watch)\b/;
const SINCE_MARGIN_MS = 10 * 60 * 1000;
/** The most lines kept pending for one task (passes killed one after the other); the oldest go first. */
const MOST_PENDING = 10;

function placeOf(v: unknown): Place {
  const o = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const states = typeof o.states === "object" && o.states !== null && !Array.isArray(o.states) ? (o.states as Record<string, unknown>) : {};
  const lines = typeof o.lines === "object" && o.lines !== null && !Array.isArray(o.lines) ? (o.lines as Record<string, unknown>) : {};
  const isLine = (v: unknown): v is PendingLine => typeof v === "object" && v !== null && typeof (v as PendingLine).key === "string" &&
    typeof (v as PendingLine).line === "string" && typeof (v as PendingLine).at === "string";
  return { seq: typeof o.seq === "number" && Number.isInteger(o.seq) && o.seq >= 0 ? o.seq : 0,
    pending: Array.isArray(o.pending) ? o.pending.filter((x): x is number => typeof x === "number" && Number.isInteger(x)) : [],
    states: Object.fromEntries(Object.entries(states).filter((e): e is [string, string] => typeof e[1] === "string")),
    // a place saved before #515 kept one line per task, not a list
    lines: Object.fromEntries(Object.entries(lines).map(([k, x]): [string, PendingLine[]] => [k, (Array.isArray(x) ? x : [x]).filter(isLine)])
      .filter((e) => e[1].length)) };
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
    private readonly states: Record<string, string>, private readonly lines: Record<string, PendingLine[]>, private readonly save: () => Promise<void>) {
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

  /** The key a task's state is kept under: its state, and its holder while in progress. */
  keyOf(t: Task): string {
    const state = mirrorState(t);
    return state === "in-progress" ? `${state}:${t.holder}` : state;
  }

  /** The labels and open or closed state task `t` gives `issue`, and whether the issue has them already. */
  wanted(t: Task, issue: GhIssue): { labels: string[]; state: string; same: boolean } {
    const L = this.map.labels;
    const state = mirrorState(t);
    const have = labelNames(issue);
    const stateLabels = new Set([L.ready, L.inProgress, L.inReview, L.blocked]);
    const labels = have.filter((l) => !stateLabels.has(l) && !l.startsWith(L.agentPrefix));
    const own: Record<string, string[]> = { ready: [L.ready], "in-progress": [L.inProgress, `${L.agentPrefix}${t.holder}`], "in-review": [L.inReview],
      blocked: [L.blocked], done: [] };
    labels.push(...(own[state] ?? []));
    const ghState = state === "done" ? "closed" : "open";
    const same = labels.length === have.length && labels.every((l) => have.includes(l)) && (issue.state ?? "open") === ghState;
    return { labels, state: ghState, same };
  }

  async task(id: number, e: BoardEvent): Promise<void> {
    const t = await this.board.get(id);
    const n = this.issueOf(t);
    if (n === null || !WORK.has(t.kind)) return;
    if (this.states[String(id)] === this.keyOf(t)) {
      this.summary.tasks.unchanged++;
      return;
    }
    // one read of the issue (its other labels, which a label call replaces), then one label call and one line
    const issue = this.gh.get(`repos/${this.o.repo}/issues/${n}`) as GhIssue;
    await this.send(t, n, issue, typeof e.payload.reason === "string" ? e.payload.reason : null);
  }

  /** Set issue `n` to task `t`'s state (one call, left out when it has it) and post its line. */
  async send(t: Task, n: number, issue: GhIssue, reason: string | null): Promise<void> {
    const state = mirrorState(t);
    const path = `repos/${this.o.repo}/issues/${n}`;
    const want = this.wanted(t, issue);
    if (!want.same) {
      this.gh.send("PATCH", path, { labels: want.labels, state: want.state,
        ...(state === "done" ? { state_reason: t.outcome === "done" || !t.outcome ? "completed" : "not_planned" } : {}) });
    }
    const key = this.keyOf(t);
    const id = String(t.id);
    const was = this.lines[id] ?? [];
    // Passes that died after recording a line, before saving their place (#513, #515): the last of their lines that is on
    // the issue is what GitHub shows. When it is this state's, it is there already: not posted again. Lines recorded but
    // never posted are skipped, so a state that comes back to the last posted one sends nothing, exactly once per state.
    const shown = was.length ? this.lastPosted(path, was) : null;
    if (shown?.key === key) {
      this.states[id] = key;
      delete this.lines[id];
      return;
    }
    let why = reason;
    if (state === "blocked" && !why) why = (await this.board.contextFor(t.id)).filter((c) => c.taskId === t.id && c.kind === "blocker").at(-1)?.body ?? null;
    const pending: PendingLine = { key, line: crypto.randomUUID().slice(0, 8), at: new Date().toISOString() };
    this.lines[id] = [...was, pending].slice(-MOST_PENDING);
    await this.save(); // recorded before the post, so a pass killed after it finds the line on the next run
    this.gh.send("POST", `${path}/comments`, { body: `<!-- ${MIRROR_MARK} v=1 task=${t.id} state=${state} line=${pending.line} -->\n${line(t, state, why)}` });
    this.states[id] = key;
    delete this.lines[id];
    this.summary.tasks.mirrored++;
  }

  /** The last of the pending lines `ps` that is on issue `path` (one read: its comments since a little before the first
   * was recorded), or null when none is. */
  private lastPosted(path: string, ps: PendingLine[]): PendingLine | null {
    const since = new Date(Math.min(...ps.map((p) => Date.parse(p.at))) - SINCE_MARGIN_MS).toISOString();
    const bodies = pages<GhComment>(this.gh, `${path}/comments?per_page=100&since=${since}`, (c) => c.id).map((c) => c.body ?? "");
    return [...ps].reverse().find((p) => bodies.some((b) => b.includes(` line=${p.line} -->`))) ?? null;
  }

  /** The first pass for a mirror's place: every task of the repo is taken as it is, and only an open issue whose labels
   * differ from the board's state is sent (the open issues are read in pages of 100, not one by one). */
  async seed(): Promise<void> {
    const open = new Map(pages<GhIssue>(this.gh, `repos/${this.o.repo}/issues?state=open&per_page=100`, (i) => i.number)
      .filter((i) => !i.pull_request).map((i) => [i.number, i]));
    for (const t of await this.board.tasks({ all: true, limit: 1_000_000 })) {
      const n = this.issueOf(t);
      if (n === null || !WORK.has(t.kind)) continue;
      const issue = open.get(n);
      if (issue && !this.wanted(t, issue).same) await this.send(t, n, issue, null);
      else this.states[String(t.id)] = this.keyOf(t);
    }
  }

  async message(id: number, pending: Set<number>, save: () => Promise<void>): Promise<void> {
    const m = await this.board.message(id);
    if (m.ref !== null || m.taskId === null) {
      pending.delete(id);
      return;
    }
    if (m.kind === "ask" && m.to !== this.map.asksTo) return;
    if (m.kind === "answer") {
      if (m.inReplyTo === null || (await this.board.message(m.inReplyTo)).kind !== "ask") return;
    } else if (m.kind !== "ask") return;
    const n = this.issueOf(await this.board.get(m.taskId));
    if (n === null) return;
    const marker = `<!-- ${MIRROR_MARK} v=1 message=${m.id} -->`;
    const path = `repos/${this.o.repo}/issues/${n}/comments`;
    let made: number | null = null;
    if (pending.has(id)) {
      // a pass that posted it may have died before linking it: look for that comment first
      const since = new Date(m.createdAt.getTime() - SINCE_MARGIN_MS).toISOString();
      made = pages<GhComment>(this.gh, `${path}?per_page=100&since=${since}`, (c) => c.id).find((c) => (c.body ?? "").includes(marker))?.id ?? null;
    }
    if (made === null) {
      pending.add(id);
      await save(); // recorded before the post, so a crash after it is found on the next pass
      const c = this.gh.send("POST", path, { body: `${m.body.trimEnd()}\n\n${marker}` }) as { id?: unknown } | null;
      if (typeof c?.id !== "number") throw new GithubError("gh-failed", "GitHub didn't say which comment it made.", "Run `factory board mirror` again.");
      made = c.id;
      this.summary.messages++;
    }
    try {
      await this.board.linkMessage(m.id, commentRef(this.o.repo, made));
    } catch (e) {
      if ((await this.board.message(m.id)).ref === null) throw e; // linked meanwhile: nothing to do
    }
    pending.delete(id);
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
  const pass = await board.exclusive(`mirror:${key}`, () => onePass(board, gh, o, map, key), { waitMs: o.waitMs });
  if (pass.ran) return pass.result;
  return { repo: o.repo, tasks: { mirrored: 0, unchanged: 0 }, messages: 0, answers: 0, calls: gh.calls, cursor: 0, busy: true };
}

async function onePass(board: Board, gh: Gh, o: MirrorOptions, map: GithubMapping, key: string): Promise<MirrorSummary> {
  const kept = await board.value(key);
  const place = placeOf(kept);
  const states = { ...place.states };
  const lines = { ...place.lines };
  const pending = new Set(place.pending);
  const placeAt = (seq: number): Place => ({ seq, states, pending: [...pending], lines });
  const save = async (): Promise<void> => board.setValue(key, placeAt(place.seq));
  const first = kept === null;
  // a first pass keeps no place until it is done (one that fails seeds again from GitHub's labels), so its lines aren't
  // recorded as pending
  const run = new Run(board, gh, o, map, states, lines, first ? async () => {} : save);

  const touched = new Map<number, BoardEvent>();
  const posted: number[] = [...place.pending];
  let top = place.seq;
  let news = false;
  for (let after = place.seq; ;) {
    const page = await board.events(after, 500);
    for (const e of page) {
      top = e.seq;
      if (e.kind === "value.set" && e.subject === `value:${key}`) continue; // its own place
      news = true;
      const id = /^task:(\d+)$/.exec(e.subject)?.[1];
      if (id && isMove(e) && !first) {
        touched.delete(Number(id)); // in the order of their last change
        touched.set(Number(id), e);
      }
      const mid = /^message:(\d+)$/.exec(e.subject)?.[1];
      if (mid && e.kind === "message.posted" && (e.payload.kind === "ask" || e.payload.kind === "answer") && !posted.includes(Number(mid))) posted.push(Number(mid));
    }
    if (page.length < 500) break;
    after = (page.at(-1) as BoardEvent).seq;
  }

  const changed = (): boolean => JSON.stringify(states) !== JSON.stringify(place.states) || JSON.stringify([...pending]) !== JSON.stringify(place.pending) ||
    JSON.stringify(lines) !== JSON.stringify(place.lines);
  try {
    if (first) await run.seed();
    for (const [id, e] of touched) await run.task(id, e);
    for (const id of posted) await run.message(id, pending, save);
  } catch (e) {
    if (!first && changed()) await save().catch(() => {}); // a first pass that failed seeds again from GitHub's labels
    throw waits(e);
  }
  // Only a run that read something new moves its place, so its own write never wakes it again.
  if (first || news || changed()) await board.setValue(key, placeAt(top));
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

