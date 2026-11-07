// The TaskTracker port on the message board (#500, decision 0007 point 10): `tasks.source` "board". Each call runs the
// board's child (child.ts); the board's rules decide (a claim is one UPDATE, ready and blocked are worked out when read).
//
// How the factory's words map onto the board's:
// - A project's tasks are the board's tasks and bugs whose ref names its GitHub repo: `github:<owner>/<repo>#<n>`, as
//   `factory board import github` writes them, with the issue number n as the factory's id; and the ones this port filed,
//   ref `factory:<owner>/<repo>/<uuid>`, whose id is `b<board id>`. Other projects on the same board are left out. With
//   no repo known (no GitHub origin and no GH_REPO), every task on the board is the project's.
// - States: open is ready, in_progress in progress, in_review in review, done done, and deferred blocked (a block sends
//   the task there, with its reason as a `blocker` note). Dependencies are the `blocks` edges into it and the `waits_for`
//   edges out of it (from waits for to).
// - A claim's token is kept on this machine (tokens.ts) and sent with release, review, done, block and tick. A task
//   another agent holds can't be released, closed or blocked from here: the board's sweep frees a stale claim. Going to
//   review ends the claim (in review, held by nobody), so the dev manager on any machine can mark it done. A holder whose
//   token was lost here (the file, or a claim whose answer timed out) takes the claim back on its next pick.
// - Heartbeats: a claim lasts 30 minutes (the board's CLAIM_SECONDS; `claimSeconds` sets it). A tick sends one, and
//   keep() sends one: while a builder's session runs, the loop keeps its claim alive every few minutes (factory_agents.ts
//   keep, #513), so a long quiet build isn't swept. Once the session is gone, `factory board sweep` frees the claim when
//   its time has passed and its holder has been quiet that long.
// - Epics are the project's tasks of kind epic; their tasks are the `- [ ] #n` lines and the board's children.
import { randomUUID } from "node:crypto";
import type { Edge, Task as BoardTask } from "../../../../message-board/src/index.ts";
import { citesIn } from "../../domain/cites.ts";
import type { Claimant } from "../../domain/claim.ts";
import { CoreError } from "../../domain/error.ts";
import { type Epic, parseEpic } from "../../domain/epic.ts";
import { checkClaim, type Task, type TaskState, tickTodo, todos } from "../../domain/task.ts";
import type { Filed, NewTask, Picked, TaskTracker } from "../../ports/task_tracker.ts";
import type { BoardChild } from "./child.ts";
import type { ClaimTokens } from "./tokens.ts";

export interface BoardTrackerOptions {
  child: BoardChild;
  /** The project's GitHub repo, owner/name ("" when it has none). */
  repo: string;
  tokens: ClaimTokens;
  /** Who writes what isn't a claim (default FACTORY_AGENT, else "factory"). */
  actor?: string;
  /** How long a claim lasts before it needs a heartbeat (default: the board's, 30 minutes). */
  claimSeconds?: number;
}

const WORK = new Set(["task", "bug"]);
const NOT_FOUND_FIX = "Check the id with `factory next` or `factory board tasks`.";

/** The task that waits and the one it waits for, from a blocking edge; null for any other kind. blocks: from must be
 * done before to can start. waits_for: from can't start until to is done. */
function waiterAndBlocker(e: Edge): [number, number] | null {
  if (e.kind === "blocks") return [e.to, e.from];
  if (e.kind === "waits_for") return [e.from, e.to];
  return null;
}

/** The board's tasks as this project sees them, read once per port call. */
class View {
  readonly mine: BoardTask[];
  private readonly ids = new Map<number, string>();
  private readonly byId = new Map<string, BoardTask>();
  private readonly deps = new Map<number, number[]>();

  constructor(all: BoardTask[], edges: Edge[], repo: string) {
    const gh = repo ? `github:${repo.toLowerCase()}#` : null;
    const filed = repo ? `factory:${repo.toLowerCase()}/` : null;
    this.mine = all.filter((t) => {
      const ref = (t.ref ?? "").toLowerCase();
      let id: string | null = null;
      if (gh === null) id = /^github:[^#]+#(\d+)$/.exec(ref)?.[1] ?? `b${t.id}`;
      else if (ref.startsWith(gh) && /^\d+$/.test(ref.slice(gh.length))) id = ref.slice(gh.length);
      else if (filed !== null && ref.startsWith(filed)) id = `b${t.id}`;
      if (id === null) return false;
      this.ids.set(t.id, id);
      this.byId.set(id, t);
      return true;
    });
    for (const e of edges) {
      if (!this.ids.has(e.to) || !this.ids.has(e.from)) continue;
      const pair = waiterAndBlocker(e);
      if (!pair) continue;
      const [waiter, blocker] = pair;
      const list = this.deps.get(waiter) ?? [];
      if (!list.includes(blocker)) list.push(blocker);
      this.deps.set(waiter, list);
    }
  }

  idOf(t: BoardTask): string {
    return this.ids.get(t.id) ?? `b${t.id}`;
  }

  find(id: string): BoardTask | null {
    return this.byId.get(id) ?? null;
  }

  /** The task `id` names, or a `task-not-found` refusal. */
  must(id: string, open = false): BoardTask {
    const t = this.find(id);
    if (!t || (open && t.status === "done")) throw new CoreError("task-not-found", `${id} is not ${open ? "an open" : "a"} task on the board.`, NOT_FOUND_FIX);
    return t;
  }

  dependsOn(t: BoardTask): BoardTask[] {
    return (this.deps.get(t.id) ?? []).slice().sort((a, b) => a - b).map((d) => this.mine.find((x) => x.id === d) as BoardTask);
  }

  /** Its dependencies that aren't done, as factory ids. */
  waitingFor(t: BoardTask): string[] {
    return this.dependsOn(t).filter((d) => d.status !== "done").map((d) => this.idOf(d));
  }

  task(t: BoardTask): Task {
    const group = /^Milestone:[ \t]*(.+)$/m.exec(t.body)?.[1]?.trim() ?? "";
    return { id: this.idOf(t), title: t.title, state: stateOf(t), holders: t.holder ? [t.holder] : [],
      dependsOn: this.dependsOn(t).map((d) => this.idOf(d)), todos: todos(t.body), group, tags: t.kind === "bug" ? ["bug"] : [],
      cites: citesIn(`${t.title}\n${t.body}`) };
  }
}

function stateOf(t: BoardTask): TaskState {
  if (t.status === "done") return "done";
  if (t.status === "in_review") return "in-review";
  if (t.status === "in_progress") return "in-progress";
  if (t.status === "deferred") return "blocked";
  return "ready";
}

export class BoardTaskTracker implements TaskTracker {
  private readonly actor: string;

  constructor(private readonly o: BoardTrackerOptions) {
    this.actor = o.actor || process.env.FACTORY_AGENT || "factory";
  }

  list(): Task[] {
    const v = this.view();
    return v.mine.filter((t) => WORK.has(t.kind) && t.status !== "done").map((t) => v.task(t));
  }

  show(id: string): string {
    const v = this.view();
    const t = v.must(id);
    const [context, thread] = this.o.child.call(this.actor, [{ op: "contextFor", args: [t.id] }, { op: "thread", args: [{ task: t.id }] }]) as
      [{ taskId: number; kind: string; body: string; author: string }[], { from: string; body: string }[]];
    let text = `${id} ${t.title}  [${stateOf(t)}${t.holder ? `, held by ${t.holder}` : ""}]\n\n${t.body}`;
    for (const c of context.filter((c) => c.taskId === t.id)) text += `\n\n--- ${c.kind} by ${c.author} ---\n${c.body.trim()}`;
    for (const m of thread) text += `\n\n--- comment by ${m.from} ---\n${m.body.trim()}`;
    return text;
  }

  next(): Task | null {
    const v = this.view();
    const t = this.candidates(v, null)[0];
    return t ? v.task(t) : null;
  }

  pick(who: Claimant): Picked {
    const v = this.view();
    const own = v.mine.find((t) => t.status === "in_progress" && t.holder === who.agent && this.mineHere(t, who));
    if (own) return { task: v.task(own) };
    const lost = v.mine.find((t) => this.lostHere(t, who));
    const back = lost ? this.take(lost, who) : null; // held on the board with no token here: take the claim back
    if (back) return { task: v.task(back) };
    for (const t of this.candidates(v, who.agent)) {
      const got = this.take(t, who);
      if (got) return { task: v.task(got) };
    }
    return { task: null };
  }

  claim(id: string, who: Claimant): Task {
    const v = this.view();
    const t = v.must(id, true);
    if (!WORK.has(t.kind)) throw new CoreError("task-not-ready", `${id} is ${t.kind === "epic" ? "an" : "a"} ${t.kind}; only tasks and bugs are claimed.`, "Pick another task.");
    if (this.lostHere(t, who)) {
      const back = this.take(t, who);
      if (back) return v.task(back);
    }
    const task = v.task(t);
    const [check, open] = checkClaim(task, who.agent, () => this.mineHere(t, who), () => v.waitingFor(t));
    if (check === "mine") return task;
    if (check === "taken") throw new CoreError("task-taken", `${id} is already taken by ${t.holder ?? "another agent"}.`, "Pick another task.");
    if (check === "blocked") throw new CoreError("task-blocked", `${id} is blocked.`, "Pick another task.");
    if (check === "waiting") throw new CoreError("task-blocked", `${id} waits for ${open.join(", ")}.`, "Build what it depends on first.");
    if (check === "not-ready") throw new CoreError("task-not-ready", `${id} is not ready.`, "Pick another task.");
    if (t.assignee && t.assignee !== who.agent) throw new CoreError("task-taken", `${id} was handed to ${t.assignee}.`, "Pick another task.");
    const got = this.take(t, who);
    if (!got) throw new CoreError("task-taken", `Another agent claimed ${id} first.`, "Pick another task.");
    return v.task(got);
  }

  release(id: string, reason = ""): void {
    const v = this.view();
    const t = v.must(id);
    const held = this.o.tokens.get(t.id);
    const why = reason.trim() || "released";
    if (t.holder) {
      if (!held) throw this.heldElsewhere(id, t, "release");
      this.o.child.call(held.agent, [{ op: "release", args: [t.id, held.token, { next: "ready", reason: why }] }]);
      this.o.tokens.drop(t.id);
      return;
    }
    if (t.status === "deferred" || t.status === "in_review") {
      this.o.child.call(this.actor, [{ op: "update", args: [t.id, { version: t.version, status: "open" }] }]);
    }
  }

  setState(id: string, state: "in-review" | "done"): string {
    const v = this.view();
    const t = v.must(id);
    const held = t.holder ? this.o.tokens.get(t.id) : null;
    if (t.holder && !held) throw this.heldElsewhere(id, t, state === "done" ? "close" : "move to review");
    if (state === "done") {
      this.o.child.call(held?.agent ?? this.actor, [{ op: "close", args: [t.id, { outcome: "done", ...(held ? { token: held.token } : {}) }] }]);
      if (held) this.o.tokens.drop(t.id);
      return `${id} is done.`;
    }
    // In review, the builder's claim ends (a release to review, with its token): the token lives only on the builder's
    // machine, so a task still held could be closed by nobody else, and nothing sweeps a task in review.
    if (held) {
      this.o.child.call(held.agent, [{ op: "release", args: [t.id, held.token, { next: "review", reason: "its pull request is open" }] }]);
      this.o.tokens.drop(t.id);
    } else this.o.child.call(this.actor, [{ op: "update", args: [t.id, { version: t.version, status: "in_review" }] }]);
    return `${id} is in review.`;
  }

  tick(id: string, index: number): void {
    const v = this.view();
    const t = v.must(id);
    const held = t.holder ? this.o.tokens.get(t.id) : null;
    const body = tickTodo(t.body, index, id);
    if (body === t.body) return;
    const calls = held
      ? [{ op: "heartbeat", args: [t.id, held.token, this.ttl()] }, { op: "update", args: [t.id, { version: t.version + 1, body }] }]
      : [{ op: "update", args: [t.id, { version: t.version, body }] }];
    this.o.child.call(held?.agent ?? this.actor, calls);
  }

  block(id: string, reason: string): void {
    const v = this.view();
    const t = v.must(id, true);
    const held = t.holder ? this.o.tokens.get(t.id) : null;
    if (t.holder && !held) throw this.heldElsewhere(id, t, "block");
    const note = { op: "note", args: [t.id, { kind: "blocker", body: reason }] };
    if (held) {
      this.o.child.call(held.agent, [{ op: "release", args: [t.id, held.token, { next: "deferred", reason }] }, note]);
      this.o.tokens.drop(t.id);
    } else this.o.child.call(this.actor, [{ op: "update", args: [t.id, { version: t.version, status: "deferred" }] }, note]);
  }

  epics(): Epic[] {
    const v = this.view();
    const open = new Set(v.mine.filter((t) => WORK.has(t.kind) && t.status !== "done").map((t) => v.idOf(t)));
    const url = (id: string): string | null => (this.o.repo && /^\d+$/.test(id) ? `https://github.com/${this.o.repo}/issues/${id}` : null);
    return v.mine.filter((t) => t.kind === "epic").map((e) => {
      const id = v.idOf(e);
      const parsed = parseEpic({ number: 0, title: e.title, body: e.body, labels: [], closed: e.status === "done", openIds: open });
      const tasks = [...parsed.tasks];
      for (const c of v.mine.filter((x) => x.parentId === e.id && WORK.has(x.kind))) {
        const cid = v.idOf(c);
        if (!tasks.some((x) => x.id === cid)) tasks.push({ id: cid, done: c.status === "done" });
      }
      return { ...parsed, id, tasks, stage: e.status === "deferred" ? "parked" : parsed.stage, url: url(id) };
    }).sort((a, b) => order(a.id) - order(b.id));
  }

  keep(id: string): boolean {
    const t = this.view().find(id);
    const held = t ? this.o.tokens.get(t.id) : null;
    if (!t || !held) return false;
    this.o.child.call(held.agent, [{ op: "heartbeat", args: [t.id, held.token, this.ttl()] }]);
    return true;
  }

  file(task: NewTask): Filed {
    const body = task.group && !task.body.includes(`Milestone: ${task.group}`) ? `${task.body.trimEnd()}\n\nMilestone: ${task.group}` : task.body;
    const ref = `factory:${(this.o.repo || "local").toLowerCase()}/${randomUUID()}`;
    const kind = (task.tags ?? []).includes("bug") ? "bug" : "task";
    const t = this.o.child.one(this.actor, "create", { title: task.title, body, kind, ref }) as BoardTask;
    return { id: `b${t.id}`, url: `board:${t.id}` };
  }

  // ---------- helpers ----------
  /** The claim's time for a claim or a heartbeat: the board's own unless `claimSeconds` sets it. */
  private ttl(): { ttlSeconds?: number } {
    return this.o.claimSeconds ? { ttlSeconds: this.o.claimSeconds } : {};
  }

  private view(): View {
    const [all, edges] = this.o.child.call(this.actor, [{ op: "tasks", args: [{ all: true, limit: 100_000 }] }, { op: "edges", args: [] }]) as
      [BoardTask[], Edge[]];
    return new View(all, edges, this.o.repo);
  }

  /** The ready tasks `agent` may take, in the board's order (null: anyone's view, for `next`). */
  private candidates(v: View, agent: string | null): BoardTask[] {
    return v.mine.filter((t) => WORK.has(t.kind) && t.status === "open" && !t.holder && !v.waitingFor(t).length &&
      (t.assignee === null || t.assignee === agent));
  }

  /** Whether this machine holds `t`'s claim for `who`. */
  private mineHere(t: BoardTask, who: Claimant): boolean {
    const held = this.o.tokens.get(t.id);
    return held !== null && held.agent === who.agent && (!held.machine || !who.machine || held.machine === who.machine);
  }

  /** Whether `who` holds `t` on the board but this machine has no token for it: the token file was lost, or the claim
   * landed and its answer didn't (a time limit). The board gives its holder a new token on a claim of the same task. */
  private lostHere(t: BoardTask, who: Claimant): boolean {
    return t.status === "in_progress" && t.holder === who.agent && this.o.tokens.get(t.id) === null;
  }

  /** Claim `t` on the board for `who` and keep its token; null when it was no longer ready (someone was first). A token
   * that can't be kept here gives the claim back at once, so no task is held that nobody can release. */
  private take(t: BoardTask, who: Claimant): BoardTask | null {
    let got: { task: BoardTask; token: string };
    try {
      got = this.o.child.one(who.agent, "claim", t.id, this.ttl()) as { task: BoardTask; token: string };
    } catch (e) {
      if (e instanceof CoreError && e.code === "not-ready") return null;
      throw e;
    }
    try {
      this.o.tokens.put(t.id, { agent: who.agent, machine: who.machine, token: got.token });
    } catch (e) {
      try {
        this.o.child.call(who.agent, [{ op: "release", args: [t.id, got.token, { next: "ready", reason: "its claim token couldn't be kept on this machine" }] }]);
      } catch {
        // the claim stays until the board's sweep; the refusal below says what happened
      }
      if (e instanceof CoreError) throw e;
      throw new CoreError("board-claims-unwritable", `The claim on board task ${t.id} was given back: its token couldn't be kept in ${this.o.tokens.file} (${
        e instanceof Error ? e.message : String(e)}).`, `Make ${this.o.tokens.file}'s folder writable, then claim again.`);
    }
    return got.task;
  }

  private heldElsewhere(id: string, t: BoardTask, what: string): CoreError {
    return new CoreError("task-held", `${id} is held by ${t.holder} on the board, and this machine has no claim on it to ${what} it with.`,
      `Ask ${t.holder} to do it, or run \`factory board sweep\` once the claim is stale (its time passed and ${t.holder} went quiet).`);
  }
}

/** Issue numbers first, in order, then board ids. */
function order(id: string): number {
  return /^\d+$/.test(id) ? Number(id) : 1e12 + Number(id.slice(1));
}
