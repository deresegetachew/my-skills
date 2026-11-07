// How people name a task (#515): one number for one task, the one they see on GitHub and in the web UI.
//
// - A task that came from one of the project's issues (`github:<owner>/<repo>#3`) is "#3"; one from another repo's issue
//   is "<owner>/<repo>#3"; a task made on the board is "b17" (its board id). With no project repo known, any GitHub
//   issue's task is "#n".
// - What a person types is read back the same way: 3, "3" or "#3" is issue 3 of the project, "b17" the board's task 17,
//   "<owner>/<repo>#3" another repo's issue.
//
// The board's own API keeps taking board ids: this is the lookup in front of it, for the CLI (bin.ts) and the MCP
// server (mcp.ts). The mirror keeps the board id in its HTML marker, where nobody reads it.
import { randomUUID } from "node:crypto";
import type { Board } from "./board.ts";
import { refuse } from "./errors.ts";
import type { Message, Task } from "./types.ts";

/** A task's number as typed: a board id (b17), or an issue (3, #3, owner/name#3). */
export type Named = { board: number } | { issue: number; repo: string | null };

const ISSUE = /^github:([^#]+)#(\d+)$/i;
const TYPED = /^(?:b(\d+)|#?(\d+)|([\w.-]+\/[\w.-]+)#(\d+))$/i;

/** How to name a task, for a fix. */
export const HOW_TO_NAME = "Name a task by its number: 3 or #3 for issue 3, b17 for a task made on the board.";

/** The tag a message posted for a project carries (#549): `project:<owner>/<repo>`, lower case, so a message on no task
 *  still says whose it is on a board that projects share. */
export function projectTag(repo: string): string {
  return `project:${repo.toLowerCase()}`;
}

/** Whether message `m` (on `task`, when it has one) is project `repo`'s (#549): its task is one of the repo's issues or a
 *  card made for it; else its tag names the project. A message with neither (posted where no project was known) counts
 *  for every project, so it is never lost. */
export function isProjects(repo: string, m: Pick<Message, "tag">, task: Pick<Task, "ref"> | null): boolean {
  const r = repo.toLowerCase();
  const ref = (task?.ref ?? "").toLowerCase();
  if (ref.startsWith("github:") || ref.startsWith("factory:")) return ref.startsWith(`github:${r}#`) || ref.startsWith(`factory:${r}/`);
  const tag = (m.tag ?? "").toLowerCase();
  return tag.startsWith("project:") ? tag === projectTag(r) : true;
}

export class Numbers {
  /** `repo`: the project's GitHub repo (owner/name), or null when it isn't known. */
  constructor(readonly repo: string | null) {
    this.repo = repo ? repo.toLowerCase() : null;
  }

  /** The number people see for task `t`: "#3", "owner/name#3" or "b17". */
  label(t: { id: number; ref: string | null }): string {
    const m = ISSUE.exec(t.ref ?? "");
    if (!m) return `b${t.id}`;
    const repo = (m[1] as string).toLowerCase();
    return this.repo === null || repo === this.repo ? `#${m[2]}` : `${repo}#${m[2]}`;
  }

  /** The ref for a task made on the board for the project (#528): `factory:<owner>/<repo>/<uuid>`, as the factory's task
   *  tracker files them, so the project's `factory next` and the web UI count it as theirs. Null when no repo is known. */
  newRef(): string | null {
    return this.repo ? `factory:${this.repo}/${randomUUID()}` : null;
  }

  /** Whether `text` reads as a task's number. */
  static valid(text: string): boolean {
    return TYPED.test(text.trim());
  }

  /** What a typed number names; a `bad-input` refusal when it isn't one. */
  parse(input: string | number): Named {
    if (typeof input === "number") {
      if (!Number.isInteger(input) || input < 1) refuse("bad-input", `A task's number must be a whole number from 1, not ${input}.`, HOW_TO_NAME);
      return { issue: input, repo: this.repo };
    }
    const m = TYPED.exec(input.trim());
    if (!m) refuse("bad-input", `${JSON.stringify(input)} isn't a task's number.`, HOW_TO_NAME);
    if (m[1] !== undefined) return { board: Number(m[1]) };
    if (m[2] !== undefined) return { issue: Number(m[2]), repo: this.repo };
    return { issue: Number(m[4]), repo: (m[3] as string).toLowerCase() };
  }

  /** The board id of the task `input` names; a `not-found` refusal when no task on the board is that issue, and a
   * `bad-input` one when the project's repo isn't known and two repos have that issue number. A board id is passed on
   * as it is: the board says when it has no such task. */
  async resolve(board: Board, input: string | number): Promise<{ id: number; label: string }> {
    const named = this.parse(input);
    if ("board" in named) return { id: named.board, label: `b${named.board}` };
    const found = named.repo
      ? await board.byRef(`github:${named.repo}#${named.issue}`)
      : await board.byRef(`#${named.issue}`, { anyRepo: true });
    const shown = named.repo && named.repo !== this.repo ? `${named.repo}#${named.issue}` : `#${named.issue}`;
    if (!found.length) {
      refuse("not-found", `There is no task for issue ${shown} on the board.`,
        `Check the number (the ready queue and \`factory board tasks\` list them). ${HOW_TO_NAME}`);
    }
    if (found.length > 1) {
      refuse("bad-input", `Issue ${shown} is a task of more than one repo on the board (${found.map((t) => t.ref).join(", ")}).`,
        "Name it with its repo, like owner/name#3, or start the server or command in the project's folder (or with --repo owner/name).");
    }
    return { id: (found[0] as Task).id, label: shown };
  }
}
