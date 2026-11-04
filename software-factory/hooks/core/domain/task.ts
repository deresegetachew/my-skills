// A task (decision 0003, #377): one thing to build, from a plan line or an issue. Its state says where it is; only a
// ready task whose dependencies are done can be claimed. Plain rules, no I/O: the adapters read and write tasks.
import { CoreError } from "./error.ts";

/** `new`: filed but not ready to pick yet (an issue without the ready label). */
export type TaskState = "new" | "ready" | "in-progress" | "in-review" | "blocked" | "done";

export interface Todo {
  text: string;
  done: boolean;
}

export interface Task {
  id: string; // "42" for an issue, "1.3" for a plan task
  title: string;
  state: TaskState;
  holders: string[]; // the agents it is labelled with or claimed by (normally one)
  dependsOn: string[]; // ids from its "Depends on ..." line, done or not
  todos: Todo[];
  group: string; // the milestone or the plan's phase, "" for none
  tags: string[]; // the tracker's own labels, for commands that print them
}

const BOX = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/gm;

/** The checkboxes in `text`, in order. */
export function todos(text: string): Todo[] {
  return [...text.matchAll(BOX)].map((m) => ({ text: (m[4] as string).trim(), done: m[2] !== " " }));
}

/** `text` with its `index`th checkbox (1-based) ticked and nothing else changed. Refuses (`no-such-todo`) a number
 * that isn't there; `name` is how the task is called in that message ("#42", "1.3"). */
export function tickTodo(text: string, index: number, name: string): string {
  const boxes = [...text.matchAll(BOX)];
  if (!(index > 0 && index <= boxes.length)) {
    throw new CoreError("no-such-todo", `${name} has ${boxes.length} checkboxes; there is no number ${index}`,
      "Count the checkboxes in the task and give a number from 1 to the last one.");
  }
  const m = boxes[index - 1] as RegExpMatchArray;
  const at = (m.index as number) + (m[1] as string).length;
  return text.slice(0, at) + "x" + text.slice(at + 1);
}

const DEPENDS = {
  issue: [/depends on\s+((?:#\d+[\s,and]*)+)/gi, /#(\d+)/g],
  plan: [/depends on\s+((?:\d+(?:\.\d+)+[\s,and]*)+)/gi, /(\d+(?:\.\d+)+)/g],
} as const;

/** The ids a task's text says it depends on ("Depends on #12, #14" for issues, "Depends on 1.2, 2.1" in a plan), each
 * once. Issue numbers come sorted; plan ids in the order they were written. */
export function dependencies(text: string, style: keyof typeof DEPENDS): string[] {
  const [line, id] = DEPENDS[style];
  const found = new Set<string>();
  for (const m of text.matchAll(line)) for (const d of (m[1] as string).matchAll(id)) found.add(d[1] as string);
  const out = [...found];
  return style === "issue" ? out.sort((a, b) => Number(a) - Number(b)) : out;
}

/** Why `agent` may or may not claim `task`, checked in this order: it is already the agent's (`mine`), someone holds it
 * or it is in progress or review (`taken`), it is `blocked`, it is `waiting` for open dependencies (given back), or it
 * isn't ready (`not-ready`). Else `free`. `own` and `waitingFor` are asked only when the answer depends on them, as each
 * may cost the tracker a call. */
export type ClaimCheck = "mine" | "taken" | "blocked" | "waiting" | "not-ready" | "free";

export function checkClaim(task: Task, agent: string, own: () => boolean, waitingFor: () => string[]): [ClaimCheck, string[]] {
  if (task.holders.includes(agent) && task.state === "in-progress" && own()) return ["mine", []];
  if (task.holders.length || task.state === "in-progress" || task.state === "in-review") return ["taken", []];
  if (task.state === "blocked") return ["blocked", []];
  const open = waitingFor();
  if (open.length) return ["waiting", open];
  if (task.state !== "ready") return ["not-ready", []];
  return ["free", []];
}
