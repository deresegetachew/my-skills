// The software factory's sign-off and testing queue on the board (#552): with the tasks on the board, the queue is one note
// task of the project (ref `factory:<owner>/<repo>/signoff-queue`), and each entry (an item, a plan, a confirmation, a
// result) is one message on its thread, with the same marker the queue's GitHub issue carries in a comment. The factory
// (hooks/factory_signoff.ts) reads the entries and works out each item's state; the MCP server's board_signoff_add writes
// an item from here. Nothing is edited, so a second run changes nothing. The mirror doesn't carry it to GitHub (it carries
// owner asks and task states only).
import type { Board } from "./board.ts";
import { BoardError, refuse } from "./errors.ts";
import type { Numbers } from "./numbers.ts";
import type { Message, Task } from "./types.ts";

export const SIGNOFF_TITLE = "Sign-off and testing queue";
/** An item's id: letters, digits, dots and dashes, as `factory signoff` takes it. */
export const SIGNOFF_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
const ITEM = /<!--\s*factory-(?:signoff|testplan)\b[^>]*?\bid=([\w.-]+)/;

/** The queue task's ref for project `repo` (null: no repo known). */
export function signoffQueueRef(repo: string | null): string {
  return `factory:${(repo || "local").toLowerCase()}/signoff-queue`;
}

/** The project's queue task; made when `create` and there is none. */
export async function signoffQueue(board: Board, repo: string | null, create = false): Promise<Task | null> {
  const ref = signoffQueueRef(repo);
  const [found] = await board.byRef(ref);
  if (found || !create) return found ?? null;
  try {
    return await board.create({ title: SIGNOFF_TITLE, kind: "note", ref, body: "Things only a person can check, and the tests of " +
      "the running app: one message per entry (`factory signoff add|plan|confirm|result`). The state of an item is read from " +
      "the entries after it; nothing is edited." });
  } catch (e) {
    const [now] = await board.byRef(ref); // made by another writer at the same moment: its ref is unique
    if (now) return now;
    throw e;
  }
}

/** The queue's entries, oldest first ([] with no queue). */
export async function signoffEntries(board: Board, repo: string | null): Promise<Message[]> {
  const q = await signoffQueue(board, repo);
  return q ? board.thread({ task: q.id }) : [];
}

/** Write one entry (`body`, its marker first): a verdict for a confirmation or a result, else a note. */
export async function postSignoff(board: Board, repo: string | null, body: string, verdict: boolean): Promise<Message> {
  const q = (await signoffQueue(board, repo, true)) as Task;
  const tag = /<!--\s*factory-([\w-]+)/.exec(body)?.[1] ?? null;
  return board.post({ task: q.id, kind: verdict ? "verdict" : "note", tag, body });
}

/** The task `input` names as the queue writes it: "12" for the project's issue 12, "b17" for a task made on the board,
 * "owner/name#3" for another repo's issue. A `not-found` refusal when the board has no such task. */
export async function signoffTask(board: Board, numbers: Numbers, input: string | number): Promise<string> {
  const r = await numbers.resolve(board, input);
  try {
    await board.get(r.id);
  } catch (e) {
    if (e instanceof BoardError && e.code === "not-found") {
      refuse("not-found", `There is no task ${r.label} on the message board.`,
        "Check the task's number with `factory board tasks` (b17 for a task made on the board, 12 for issue 12).");
    }
    throw e;
  }
  return r.label.replace(/^#/, "");
}

/** The ids of the items (sign-off items and test plans) in `entries`. */
export function signoffIds(entries: { body: string }[]): Set<string> {
  return new Set(entries.map((m) => ITEM.exec(m.body)?.[1]).filter((x): x is string => Boolean(x)));
}

/** An item's entry: its marker, then how a person checks it. */
export function signoffItemBody(id: string, task: string, check: string): string {
  return `<!-- factory-signoff id=${id} task=${task} -->\nTo check: ${check.trim()}\n`;
}

/** Add sign-off item `id` for the task with board id `taskId`: refused `bad-input` for an id that isn't one, `conflict`
 * when the queue has it already, `not-found` when the board has no such task. */
export async function addSignoff(board: Board, numbers: Numbers, input: { id: string; taskId: number; check: string }):
  Promise<{ id: string; task: string; message: Message }> {
  if (!SIGNOFF_ID.test(input.id)) {
    refuse("bad-input", `${JSON.stringify(input.id)} isn't an item's id.`, "Use letters, digits, dots and dashes, for example login-flow-2.");
  }
  if (!input.check.trim()) refuse("bad-input", "Say how a person checks it.", "Pass check: what to open, do and see.");
  const task = numbers.label(await board.get(input.taskId)).replace(/^#/, "");
  if (signoffIds(await signoffEntries(board, numbers.repo)).has(input.id)) {
    refuse("conflict", `${input.id} is already in the sign-off queue.`, "Pick another id; `factory signoff ls --all` lists the ones taken.");
  }
  const message = await postSignoff(board, numbers.repo, signoffItemBody(input.id, task, input.check), false);
  return { id: input.id, task, message };
}
