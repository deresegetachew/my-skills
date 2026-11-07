// The web UI's tasks from the message board, live (#498, decision 0007 points 6 and 10, step 3a). When this machine has
// a board (MB_URL, else <machine settings folder>/message-board/url, as `factory board` finds it), `factory ui` opens
// one connection to it as `web-ui` and keeps one listen(). On each event it reads the tasks again and tells the server
// which projects changed, so the server pushes only those over the WebSocket.
//
// A project's tasks are the board's tasks whose ref is its GitHub repo's (`github:<owner>/<repo>#<n>`, as `factory board
// import github` writes them); the card keeps the issue number as its id. A task made on the board for the project (ref
// `factory:<owner>/<repo>/<uuid>`, by the task tracker or the MCP server's board_create, #528) is its task too, as b<board id>. A project with none on the board, or a board
// that isn't set up, keeps the GitHub path (the snapshot's cache). A board that can't be read gives a notice and every
// project falls back to GitHub until it answers again (tried every few seconds).
//
// What it gives per project is the snapshot's tasks part in the same shape (factory_snapshot.ts --tasks), so the views
// fill the Board page the same way: status to column, blocked and ready as the board works them out, lanes by epic from
// parents and by agent from holders, and each card's blockers.
//
// With `tasks.source` board the board is the record (#502): a card's Release, Block and Reassign write to it (write()):
// release is a move to ready with its reason (a held task is taken back from its holder), block a move to blocked with a
// blocker note (deferred), reassign a hand-off (only that agent may claim it). `factory board mirror` carries each to GitHub.
// A deferred task is "blocked", as the task tracker says (adapters/board/task_tracker.ts): one word on both.
//
// The board's code sits beside the hooks folder (.claude/message-board: linked in my-skills and a linked project,
// shipped by a release since #500). It is loaded when the server starts, and without it there is no board: the GitHub
// path, as before.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Board, BoardEvent, ContextEntry, Listener, Message, Task } from "../message-board/src/index.ts";
import { citesIn } from "./core/domain/cites.ts";
import { parseEpic } from "./core/domain/epic.ts";
import { todos } from "./core/domain/task.ts";
import type { Obj, Problem, UiProject } from "./factory_ui_data.ts";
import type { ActivityItem, ActivityKind } from "./factory_ui_ops.ts";

/** The actor the web UI reads and writes as. It writes only a card's Release, Block and Reassign, and only for a project
 *  whose tasks.source is board (#502); otherwise those go through GitHub (0007 point 9). */
export const ACTOR = "web-ui";
const RETRY_MS = 5_000;
const CHECK_MS = 5_000;
const MOST = 5_000;

type BoardApi = typeof import("../message-board/src/index.ts");

const ENTRY = join(import.meta.dir, "..", "message-board", "src", "index.ts");

/** True when this machine may have a board, told at once, without loading its code: the code is here, and MB_URL or the
 *  url file (where the board's own boardUrl() looks) names one. False: no board, the GitHub path from the start. */
function maybeBoard(): boolean {
  if (!existsSync(ENTRY)) return false;
  if (process.env.MB_URL) return true;
  const base = process.env.FACTORY_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "software-factory");
  return existsSync(join(base, "message-board", "url"));
}

/** The board's public entry, or null when this install has none (a release, for now). */
async function loadBoard(): Promise<BoardApi | null> {
  const entry = ENTRY;
  if (!existsSync(entry)) return null;
  try {
    return (await import(entry)) as BoardApi;
  } catch {
    return null;
  }
}

/** `text` with any password in a URL in it hidden. */
function masked(text: string): string {
  return text.replace(/\/\/[^@\s/]*@/g, "//***@");
}

/** Where the board stands for this server (#515): none set up here, being opened the first time, read live, or down. */
export type BoardState = "none" | "opening" | "live" | "down";

/** What a page sees about the board for one project: the tasks part when it reads from the board, the notice when the
 *  board can't be read, and where the board stands (a project whose tasks.source is board shows its tasks as unknown,
 *  not GitHub's, while it isn't live). */
export interface BoardView {
  part: Obj | null;
  problem: Problem | null;
  state: BoardState;
}

function unreachable(why: string): Problem {
  return { code: "ui_board_unreachable", message: `The message board can't be read (${masked(why).slice(0, 200)}), so tasks come from GitHub for now.`,
    fix: "Start the message board on the machine that keeps it (or check its address in this machine's settings); the page switches back by itself." };
}

/** `github:<owner>/<repo>#` in lower case, as the import writes refs; "" when the repo isn't known. */
function prefixOf(repo: string): string {
  return repo ? `github:${repo.toLowerCase()}#` : "";
}

/** A task's id on the page: its issue number for the project's issues, `b<board id>` for a task made on the board for
 *  the project (ref `factory:<owner>/<repo>/<uuid>`, #528), as the task tracker names them; null for another project's. */
function numberOf(t: Task, prefix: string): string | null {
  if (!prefix || !t.ref) return null;
  const ref = t.ref.toLowerCase();
  if (ref.startsWith(prefix)) {
    const n = t.ref.slice(prefix.length);
    return /^\d+$/.test(n) ? n : null;
  }
  return ref.startsWith(`factory:${prefix.slice("github:".length, -1)}/`) ? `b${t.id}` : null;
}

/** The factory's state words for a board task: done, in review, in progress, blocked (the board's blocking edges, or
 *  deferred: a block sends a task there, #502), and ready (open and not blocked). */
function stateOf(t: Task): string {
  if (t.status === "done") return "done";
  if (t.status === "in_review") return "in-review";
  if (t.status === "in_progress") return "in-progress";
  if (t.status === "deferred") return "blocked";
  return t.blocked ? "blocked" : "ready";
}

const WORK = new Set(["task", "bug"]);

/** How long a done task stays on the Board page's Done column (#545: finished work mustn't vanish at once). */
export const DONE_DAYS = 7;

/** Project `repo`'s tasks part from all the board's tasks, or null when none of them is the project's: its open tasks
 *  (`tasks`) and, apart, those done in the last DONE_DAYS (`done`, newest first), each with who holds it and who it was
 *  handed to. */
export function partOf(all: Task[], repo: string, now: number = Date.now()): Obj | null {
  const prefix = prefixOf(repo);
  const ids = new Map<number, string>();
  for (const t of all) {
    const n = numberOf(t, prefix);
    if (n !== null) ids.set(t.id, n);
  }
  if (!ids.size) return null;
  const byId = new Map(all.map((t) => [t.id, t]));
  /** The nearest epic above task `t` that is this project's, or null. */
  const epicOf = (t: Task): Task | null => {
    const seen = new Set<number>();
    for (let up = t.parentId === null ? undefined : byId.get(t.parentId); up && !seen.has(up.id); up = up.parentId === null ? undefined : byId.get(up.parentId)) {
      seen.add(up.id);
      if (up.kind === "epic" && ids.has(up.id)) return up;
    }
    return null;
  };
  const named = (id: number): string => ids.get(id) ?? byId.get(id)?.ref ?? `board task ${id}`;
  const mine = all.filter((t) => ids.has(t.id));
  const work = mine.filter((t) => WORK.has(t.kind));
  const since = now - DONE_DAYS * 86_400_000;
  const doneAt = (t: Task): number => new Date(t.updatedAt).getTime();
  const recent = work.filter((t) => t.status === "done" && doneAt(t) >= since).sort((a, b) => doneAt(b) - doneAt(a));
  const rowOf = (t: Task): Obj => {
    const epic = epicOf(t);
    const blockedBy = t.status === "done" ? [] : t.blockedBy.map(named);
    return { id: ids.get(t.id), title: t.title, state: stateOf(t), holders: t.holder ? [t.holder] : [], assignee: t.assignee ?? null,
      group: /^Milestone:[ \t]*(.+)$/m.exec(t.body)?.[1]?.trim() ?? "", todos: todos(t.body).map((d) => ({ done: d.done })),
      dependsOn: blockedBy, blockedBy, cites: citesIn(t.body), epic: epic ? ids.get(epic.id) : null };
  };
  const tasks = work.filter((t) => t.status !== "done").map(rowOf);
  const done = recent.map(rowOf);
  const epics = mine.filter((t) => t.kind === "epic").map((e) => {
    const id = ids.get(e.id) as string;
    const parsed = parseEpic({ number: Number(id), title: e.title, body: e.body, labels: [], closed: e.status === "done", openIds: new Set() });
    const children = work.filter((t) => epicOf(t)?.id === e.id).map((t) => ({ id: ids.get(t.id) as string, done: t.status === "done" }));
    // the stage is an epic:<stage> label on GitHub, which the board doesn't hold: "" lets the views keep the snapshot's
    const stage = e.status === "done" ? "done" : e.status === "deferred" ? "parked" : "";
    return { id, title: e.title, stage, prd: parsed.prd, decisions: parsed.decisions, summary: parsed.summary, cites: parsed.cites, tasks: children, url: null };
  });
  return { source: "issues", from: "board", tasks, done, epics };
}

/** The one connection to the board, its listen(), and the tasks part of each project, read again on every event. */
export class BoardFeed {
  private board: Board | null = null;
  private listener: Listener | null = null;
  private all: Task[] = [];
  private parts = new Map<string, string>();
  private down: Problem | null = null;
  private busy: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private tried = false;
  private api: BoardApi | null = null;
  /** The board's URL: given, or found when the server starts (undefined until then); null with none. */
  private url: string | null | undefined;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private check: ReturnType<typeof setInterval> | null = null;

  /** `url`: the board's; left out, this machine's (MB_URL, else the settings folder's url file, as `factory board`). */
  constructor(private readonly projects: UiProject[], private readonly o: { url?: string | null; repoOf: (p: UiProject) => string;
    changed: (p: UiProject) => void; fellBack?: (p: UiProject, wasLive: boolean) => void; log?: (line: string) => void;
    /** An event Activity shows was recorded (#455). */
    event?: () => void }) {
    // fellBack(p, wasLive): p's tasks come from GitHub again (wasLive), or turned out not to come from the board
    // known at once when there is no board, so a project without one waits for nothing
    this.url = o.url !== undefined ? o.url : maybeBoard() ? undefined : null;
  }

  /** Opens the board and starts listening; with no board set up it does nothing. Never throws: a failure is the notice. */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (!this.api) {
      this.api = await loadBoard();
      if (this.url === undefined) this.url = this.api ? this.api.boardUrl() : null;
      if (!this.api) this.url = null;
    }
    if (!this.url || !this.api) {
      this.url = null;
      this.settle();
      return;
    }
    if (!this.check) {
      // a backstop for a dropped connection: a read every few seconds, which also finds a board that went away
      this.check = setInterval(() => { if (this.board) this.schedule(); }, CHECK_MS);
      (this.check as { unref?: () => void }).unref?.();
    }
    try {
      // the board counts as live (this.board) only once its tasks are read and the listen is on (#523): before that a
      // page would show an empty board "from the board", and an action sent then would be refused
      const board = await this.api.Board.open(this.url, { as: ACTOR, session: `ui-${process.pid}`, max: 2 });
      let listener: Listener | null = null;
      // an error from the listen before the board is kept is this open's to handle: fail() would close nothing yet
      let starting = true;
      let failed: { e: unknown } | null = null;
      try {
        const all = await board.tasks({ all: true, limit: MOST });
        listener = await board.listen((e: BoardEvent) => {
          this.schedule();
          if (SHOWN.has(e.kind)) this.o.event?.();
        }, {
          onError: (e) => {
            if (starting) failed = { e };
            else void this.fail(e);
          },
        });
        if (this.stopped) throw new Error("stopped");
        if (failed) throw (failed as { e: unknown }).e;
        starting = false;
        this.all = all;
      } catch (e) {
        await listener?.close().catch(() => {});
        await board.end().catch(() => {});
        if (this.stopped) return;
        throw e;
      }
      this.board = board;
      this.listener = listener;
      if (this.down) this.o.log?.("message board: reconnected; tasks come from it again, live.");
      this.down = null;
      this.publish(true);
      this.settle();
    } catch (e) {
      await this.fail(e);
      this.settle();
    }
  }

  /** The first open is over: each project whose tasks don't come from the board is told (fellBack), so a snapshot that
   *  left its tasks out while that wasn't known reads them. */
  private settle(): void {
    if (this.tried) return;
    this.tried = true;
    for (const p of this.projects) if (!this.live(p)) this.o.fellBack?.(p, false);
  }

  /** The board's part for project `p` and its notice. */
  view(p: UiProject): BoardView {
    if (!this.url) return { part: null, problem: null, state: this.url === null ? "none" : "opening" };
    const text = this.down ? undefined : this.parts.get(p.id);
    const state: BoardState = this.down ? "down" : this.board ? "live" : "opening";
    return { part: text ? (JSON.parse(text) as Obj) : null, problem: this.down, state };
  }

  /** False while the board is being opened the first time: whether tasks come from it isn't known yet. */
  settled(): boolean {
    return this.url === null || this.tried;
  }

  /** True while project `p`'s tasks come from the board. */
  live(p: UiProject): boolean {
    return this.view(p).part !== null;
  }

  /** A task's page from the board (#498): the task, its thread and its context entries. */
  async detail(p: UiProject, id: string): Promise<{ status: number; body: Obj }> {
    const prefix = prefixOf(this.o.repoOf(p));
    const task = this.board && this.live(p) ? this.all.find((t) => numberOf(t, prefix) === id) : undefined;
    if (!this.board || !task) {
      return { status: 404, body: this.live(p)
        ? { code: "ui_task_unknown", message: `#${id} isn't one of ${p.name}'s tasks on the message board.`, fix: "Pick a task the board shows." }
        : { code: "ui_board_absent", message: `${p.name}'s tasks aren't read from a message board, so a task's thread isn't shown here.`,
          fix: "Bring the project's issues into the message board on the machine that keeps it; its threads then show here." } };
    }
    try {
      const [thread, context] = await Promise.all([this.board.thread({ task: task.id }), this.board.contextFor(task.id)]);
      const view = JSON.parse(this.parts.get(p.id) ?? "{}") as Obj;
      const row = (Array.isArray(view.tasks) ? (view.tasks as Obj[]) : []).find((t) => t.id === id) ?? { id, title: task.title, state: stateOf(task) };
      // the task's own words (#543: a card opens the task), when it was made and last changed
      return { status: 200, body: { project: p.id, from: "board", task: row, body: task.body, createdAt: new Date(task.createdAt).toISOString(),
        updatedAt: new Date(task.updatedAt).toISOString(), thread: thread.map(messageOf), context: context.map(contextOf) } };
    } catch (e) {
      await this.fail(e);
      return { status: 503, body: { ...(this.down ?? unreachable(String(e))) } };
    }
  }

  /** A card's action written to the board (#502): release (to ready, with its reason), block (to blocked, with its reason
   *  as a blocker note) or reassign (handed to `to`). Throws a Problem-shaped error when the board can't take it. */
  async write(p: UiProject, id: string, action: "release" | "block" | "reassign", reason: string, to = ""): Promise<Task> {
    const prefix = prefixOf(this.o.repoOf(p));
    const board = this.board;
    if (!board || !this.live(p)) throw this.down ?? unreachable("it isn't open on this server");
    const task = this.all.find((t) => numberOf(t, prefix) === id);
    if (!task) throw { code: "ui_task_unknown", message: `#${id} isn't one of ${p.name}'s tasks on the message board.`, fix: "Read the board again, then pick a task it shows." };
    if (action === "reassign") return board.assign(task.id, to, { reason });
    return board.move(task.id, { to: action === "block" ? "blocked" : "ready", reason });
  }

  /** Activity (#455): the board's events about project `p`'s tasks, newest first, from the last `most` events: claims,
   *  moves, comments, closes, hand-offs, new tasks and notes. Null while `p`'s tasks aren't read from the board. */
  async activity(p: UiProject, most = 400): Promise<ActivityItem[] | null> {
    const board = this.board;
    if (!board || !this.live(p)) return null;
    const prefix = prefixOf(this.o.repoOf(p));
    const ids = new Map<number, string>();
    for (const t of this.all) {
      const n = numberOf(t, prefix);
      if (n !== null) ids.set(t.id, n);
    }
    const titles = new Map(this.all.map((t) => [t.id, t.title]));
    try {
      const last = await board.lastSeq();
      const events = await board.events(Math.max(0, last - most), most);
      return events.map((e) => itemOf(e, ids, titles)).filter((x): x is ActivityItem => x !== null).reverse();
    } catch (e) {
      await this.fail(e);
      return null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.check) clearInterval(this.check);
    void this.close();
  }

  // --- inside ----------------------------------------------------------------------------------------------------------

  /** Reads again now, or once more after the read under way (events in a burst cost at most two reads). */
  private schedule(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = this.read().finally(() => {
      this.busy = null;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    });
  }

  private async read(): Promise<void> {
    const board = this.board;
    if (!board) return;
    try {
      this.all = await board.tasks({ all: true, limit: MOST });
      this.publish(false);
    } catch (e) {
      await this.fail(e);
    }
  }

  /** Works out each project's part and tells the server about each one that changed (`all`: every project). */
  private publish(all: boolean): void {
    for (const p of this.projects) {
      const part = partOf(this.all, this.o.repoOf(p));
      const text = part ? JSON.stringify(part) : undefined;
      const before = this.parts.get(p.id);
      if (text === undefined) this.parts.delete(p.id);
      else this.parts.set(p.id, text);
      if (all || text !== before) this.o.changed(p);
    }
  }

  private async fail(e: unknown): Promise<void> {
    if (this.stopped) return;
    const wasLive = this.projects.filter((p) => this.live(p));
    const first = this.down === null;
    this.down = unreachable(e instanceof Error ? e.message : String(e));
    if (first) this.o.log?.(`message board: can't be read (${masked(e instanceof Error ? e.message : String(e)).slice(0, 200)}); trying again every ${RETRY_MS / 1000} s.`);
    await this.close();
    this.parts.clear();
    if (first) {
      for (const p of this.projects) this.o.changed(p);
      for (const p of wasLive) this.o.fellBack?.(p, true); // its tasks were not read from GitHub: read them now (or right after)
    }
    if (!this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.start();
      }, RETRY_MS);
      (this.retry as { unref?: () => void }).unref?.();
    }
  }

  private async close(): Promise<void> {
    const listener = this.listener;
    const board = this.board;
    this.listener = null;
    this.board = null;
    await listener?.close().catch(() => {});
    await board?.end().catch(() => {});
  }
}

/** The board's event kinds Activity shows, and the kind of item each is. */
const KIND: Record<string, ActivityKind> = { "task.claimed": "claim", "task.moved": "move", "task.closed": "close", "task.released": "handoff",
  "task.assigned": "handoff", "task.swept": "handoff", "task.created": "new", "message.posted": "comment", "context.noted": "note" };
const SHOWN = new Set(Object.keys(KIND));

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** One board event as an Activity item, or null when it isn't about one of the project's tasks (`ids`: board id to the
 *  task's id on the page) or isn't a kind Activity shows. */
function itemOf(e: BoardEvent, ids: Map<number, string>, titles: Map<number, string>): ActivityItem | null {
  const kind = KIND[e.kind];
  if (!kind) return null;
  const board = e.subject.startsWith("task:") ? Number(e.subject.slice(5)) : typeof e.payload.task === "number" ? e.payload.task : NaN;
  const id = ids.get(board);
  if (id === undefined) return null;
  const pay = e.payload;
  const n = /^\d+$/.test(id) ? `#${id}` : id;
  const why = text(pay.reason) ? `: ${text(pay.reason).slice(0, 200)}` : "";
  const words: Record<string, () => string> = {
    "task.claimed": () => `claimed ${n} ${titles.get(board) ?? ""}`.trim(),
    "task.moved": () => `moved ${n} to ${text(pay.to).replace(/_/g, " ")}${why}`,
    "task.closed": () => `closed ${n} (${text(pay.outcome) || "done"})${why}`,
    "task.released": () => `released ${n}${why}`,
    "task.assigned": () => `handed ${n} to ${text(pay.to) || "nobody"}${why}`,
    "task.swept": () => `${n} was freed: ${text(pay.holder) || "its holder"} went quiet`,
    "task.created": () => `filed ${n}: ${text(pay.title) || titles.get(board) || ""}`,
    "message.posted": () => {
      const to = Array.isArray(pay.to) ? pay.to.map(text).filter(Boolean).join(", ") : text(pay.to);
      const verb = pay.kind === "question" ? "asked" : pay.kind === "answer" ? "answered" : "wrote to";
      return `${verb} ${to || "the team"} on ${n}`;
    },
    "context.noted": () => `noted a ${text(pay.kind) || "note"} on ${n}`,
  };
  return { id: `board-${e.seq}`, at: e.at.toISOString(), agent: e.actor || null, kind, text: (words[e.kind] as () => string)(), task: id, pr: null,
    link: "view:tasks", find: n };
}

function messageOf(m: Message): Obj {
  return { id: m.id, kind: m.kind, tag: m.tag, from: m.from, to: m.to, state: m.state, inReplyTo: m.inReplyTo, body: m.body, at: m.createdAt.toISOString() };
}

function contextOf(c: ContextEntry): Obj {
  return { id: c.id, taskId: c.taskId, kind: c.kind, body: c.body, author: c.author, at: c.createdAt.toISOString() };
}
