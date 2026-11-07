// The TaskTracker port in memory (decision 0003, #377): for tests of the roles, with no fake `gh` and no files. Claims
// are kept as GitHub keeps them, as events, so a race (`rival`) is decided by the same rule: the earliest claim wins.
import { type Claimant, type ClaimEvent, isMe, winner } from "../../domain/claim.ts";
import { CoreError } from "../../domain/error.ts";
import type { Epic } from "../../domain/epic.ts";
import { checkClaim, type Task, type TaskState, tickTodo, type Todo } from "../../domain/task.ts";
import type { Filed, NewTask, Picked, TaskTracker } from "../../ports/task_tracker.ts";

interface Held {
  task: Task;
  text: string;
  events: ClaimEvent[];
  why: string;
}

export interface Start {
  title: string;
  state?: TaskState;
  dependsOn?: string[];
  todos?: Todo[];
  group?: string;
}

export class MemoryTaskTracker implements TaskTracker {
  private tasks = new Map<string, Held>();

  /** Add a task (ids are 1, 2, 3 ...); returns its id. */
  add(start: Start): string {
    const id = String(this.tasks.size + 1);
    const todos = (start.todos ?? []).map((t) => ({ ...t }));
    this.tasks.set(id, { task: { id, title: start.title, state: start.state ?? "ready", holders: [], dependsOn: start.dependsOn ?? [],
      todos, group: start.group ?? "", tags: [] }, text: todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n"),
    events: [], why: "" });
    return id;
  }

  /** Another agent's claim lands first, before it shows in the task's state (the start of a race). */
  rival(id: string, who: Claimant): void {
    this.held(id).events.push({ claim: { agent: who.agent, machine: who.machine } });
  }

  list(): Task[] {
    return [...this.tasks.values()].filter((h) => h.task.state !== "done").map((h) => copy(h.task));
  }

  show(id: string): string {
    const h = this.held(id);
    return `${id} ${h.task.title}  [${h.task.state}]\n\n${h.text}` + (h.why ? `\n\nBlocked: ${h.why}` : "");
  }

  next(): Task | null {
    const t = [...this.tasks.values()].find((h) => h.task.state === "ready" && !h.task.holders.length && !this.waitingFor(h.task).length);
    return t ? copy(t.task) : null;
  }

  pick(who: Claimant): Picked {
    const own = [...this.tasks.values()].find((h) => h.task.state === "in-progress" && h.task.holders.includes(who.agent) &&
      isMe(winner(h.events), who.agent, who.machine));
    if (own) return { task: copy(own.task) };
    for (const h of this.tasks.values()) {
      if (h.task.state !== "ready" || h.task.holders.length || this.waitingFor(h.task).length) continue;
      if (this.take(h, who)) return { task: copy(h.task) };
    }
    return { task: null };
  }

  claim(id: string, who: Claimant): Task {
    const h = this.tasks.get(id);
    if (!h || h.task.state === "done") throw new CoreError("task-not-found", `${id} is not an open task.`, "Check the id with the task list.");
    const [check, open] = checkClaim(h.task, who.agent, () => isMe(winner(h.events), who.agent, who.machine), () => this.waitingFor(h.task));
    if (check === "mine") return copy(h.task);
    if (check === "taken") throw new CoreError("task-taken", `${id} is already taken by ${h.task.holders[0] ?? "another agent"}.`, "Pick another task.");
    if (check === "blocked") throw new CoreError("task-blocked", `${id} is blocked.`, "Pick another task.");
    if (check === "waiting") throw new CoreError("task-blocked", `${id} waits for ${open.join(", ")}.`, "Build what it depends on first.");
    if (check === "not-ready") throw new CoreError("task-not-ready", `${id} is not ready.`, "Pick another task.");
    if (!this.take(h, who)) throw new CoreError("task-taken", `Another agent claimed ${id} first.`, "Pick another task.");
    return copy(h.task);
  }

  release(id: string): void {
    const h = this.held(id);
    Object.assign(h.task, { state: "ready", holders: [] });
    h.events.push({ release: true });
    h.why = "";
  }

  setState(id: string, state: "in-review" | "done"): string {
    this.held(id).task.state = state;
    return `${id} is ${state === "done" ? "done" : "in review"}.`;
  }

  tick(id: string, index: number): void {
    const h = this.held(id);
    h.text = tickTodo(h.text, index, id);
    (h.task.todos[index - 1] as Todo).done = true;
  }

  block(id: string, reason: string): void {
    const h = this.held(id);
    Object.assign(h.task, { state: "blocked", holders: [] });
    h.events.push({ release: true });
    h.why = reason;
  }

  epics(): Epic[] {
    return [];
  }

  /** Its claims don't run out: nothing to keep. */
  keep(_id: string): boolean {
    return false;
  }

  file(task: NewTask): Filed {
    const id = this.add({ title: task.title, group: task.group });
    return { id, url: `memory:${id}` };
  }

  private held(id: string): Held {
    const h = this.tasks.get(id);
    if (!h) throw new CoreError("task-not-found", `${id} is not a task.`, "Check the id with the task list.");
    return h;
  }

  private waitingFor(t: Task): string[] {
    return t.dependsOn.filter((d) => {
      const dep = this.tasks.get(d);
      return dep !== undefined && dep.task.state !== "done";
    });
  }

  /** Claim `h` for `who`; true when its claim is the earliest standing one. */
  private take(h: Held, who: Claimant): boolean {
    h.events.push({ claim: { agent: who.agent, machine: who.machine } });
    if (!isMe(winner(h.events), who.agent, who.machine)) return false;
    Object.assign(h.task, { state: "in-progress", holders: [who.agent] });
    return true;
  }
}

function copy(t: Task): Task {
  return { ...t, holders: [...t.holders], dependsOn: [...t.dependsOn], todos: t.todos.map((x) => ({ ...x })), tags: [...t.tags] };
}
