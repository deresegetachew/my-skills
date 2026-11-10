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
  cites?: string[]; // the decisions and PRD stories its body cites (`decision 0004`, `US-12`), as written
  /** The pull request of the PRD change it comes from, while that change isn't merged (#578): `"62"` for PR #62. It
   * isn't claimable until then. Unset for a task with no PRD change, or once its change merged. */
  waitsForPrd?: string;
}

const PRD_CHANGE = /^[^\S\n]*(?:[-*][^\S\n]+)?PRD change:[^\S\n]*(?:#(\d+)|https?:\/\/\S+?\/pull\/(\d+))\b/im;

/** The pull request number a task's text names on its `PRD change:` line (#578): `PRD change: #62`, or the pull request's
 * link. null for none. The line starts the text or a line of it, so a sentence that mentions a PRD change is not one. */
export function prdChangeIn(text: string): string | null {
  const m = PRD_CHANGE.exec(text);
  return m ? ((m[1] ?? m[2]) as string) : null;
}

/** The words before a task a pull request closes, as GitHub reads them: close(s|d), fix(es|ed), resolve(s|d), any case,
 * with an optional colon. Followed by the task's name (`b25` or `#7`). */
export const CLOSES = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+`;

/** `text` (Markdown) without what GitHub doesn't read closing keywords in (b233): fenced code blocks (``` or ~~~), inline
 * code spans and `>` quoted lines. Each is replaced by a blank, so the words around it stay apart. */
export function plainText(text: string): string {
  return text
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, " ")
    .replace(/(`+)[\s\S]*?\1/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ");
}

/** The tasks `text` (a pull request's body) closes, as people name them: `b25` for a task made on the board, `7` for
 * issue 7; in the order they appear, each once (#545). Code and quotes don't count, as on GitHub (b233). */
export function closedIn(text: string): string[] {
  const out: string[] = [];
  for (const m of plainText(text).matchAll(new RegExp(`${CLOSES}(b\\d+|#\\d+)\\b`, "gi"))) {
    const name = (m[1] as string).toLowerCase().replace(/^#/, "");
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The note for the ready tasks a pick or a look skipped because their PRD change hasn't merged: one line each, or
 * undefined for none. `name` is how the task is called ("#5", "b12", "1.3"). */
export function prdSkipNote(skipped: { name: string; pr: string }[]): string | undefined {
  if (!skipped.length) return undefined;
  return skipped.map((s) => `Skipped ${s.name}: it waits for its PRD change, PR #${s.pr}, to merge.`).join("\n");
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
 * or it is in progress or review (`taken`), it is `blocked`, its PRD change hasn't merged (`prd`, the pull request given
 * back, #578), it is `waiting` for open dependencies (given back), or it isn't ready (`not-ready`). Else `free`. `own`
 * and `waitingFor` are asked only when the answer depends on them, as each may cost the tracker a call. */
export type ClaimCheck = "mine" | "taken" | "blocked" | "prd" | "waiting" | "not-ready" | "free";

export function checkClaim(task: Task, agent: string, own: () => boolean, waitingFor: () => string[]): [ClaimCheck, string[]] {
  if (task.holders.includes(agent) && task.state === "in-progress" && own()) return ["mine", []];
  if (task.holders.length || task.state === "in-progress" || task.state === "in-review") return ["taken", []];
  if (task.state === "blocked") return ["blocked", []];
  if (task.waitsForPrd) return ["prd", [task.waitsForPrd]];
  const open = waitingFor();
  if (open.length) return ["waiting", open];
  if (task.state !== "ready") return ["not-ready", []];
  return ["free", []];
}
