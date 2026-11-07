// The board's errors: {code, message, fix}, where fix says what to do next.

export type ErrorCode =
  | "not-found" // no such task or message
  | "not-ready" // a named claim of a task that is held, blocked, assigned to someone else or not open
  | "claim-lost" // a write with a token that no longer holds the task
  | "conflict" // an edit with a version that isn't the task's version any more
  | "cycle" // an edge or a parent that would make a loop
  | "bad-input" // a value the board doesn't take
  | "no-answer" // the database can't be reached
  | "schema-old" // the database hasn't had this version's migrations
  | "login-exists" // a login with that name is already there
  | "login-used" // a login asked to be removed only if unused has been used
  | "login-redeemed" // a join code's login was already redeemed (or one asked to be removed only if unredeemed was)
  | "login-expired" // a join code's login expired before it was redeemed
  | "login-compromised" // after a redeem the login's new password didn't connect: the code may have been copied
  | "login-in-use" // a login (a join code's) is connected as often as it may be: the code may have been copied
  | "login-refused" // the board answers but refuses this login (removed, expired, or a wrong password)
  | "no-rights" // the board's user may not do this (making logins needs the board's own user)
  | "busy"; // the write crossed another one at the same moment (a deadlock or serialization failure) and was undone

/** What a refused login means, and what to do (#514): every surface that meets one says this. */
export const LOGIN_REFUSED = "This machine's board login was refused (removed or expired).";
export const LOGIN_REFUSED_FIX = "Ask the hub for a new code: on the hub run `factory machine add <name> --agent ...`, then " +
  "`factory machine join <code>` here — or `factory machine leave` to stop using the board here.";

const TASK_TOKEN = /\{\{task:(\d+)\}\}/g;

/** A board task named in a refusal (#515): its message and fix say "#<id>", and a caller that names tasks otherwise (the
 * MCP server: "#3" for an issue, "b17") renders them again from the error's `template`. */
export const taskOf = (id: number): string => `{{task:${id}}}`;

const render = (text: string, name: (id: number) => string): string => text.replace(TASK_TOKEN, (_, id: string) => name(Number(id)));
const boardId = (id: number): string => `#${id}`;

export class BoardError extends Error {
  readonly fix: string;
  /** The message and fix with each task the board named as a taskOf() token. */
  readonly template: { message: string; fix: string };

  constructor(readonly code: ErrorCode, message: string, fix: string) {
    super(render(message, boardId));
    this.name = "BoardError";
    this.fix = render(fix, boardId);
    this.template = { message, fix };
  }

  /** The board ids of the tasks it names. */
  tasks(): number[] {
    return [...new Set([...`${this.template.message} ${this.template.fix}`.matchAll(TASK_TOKEN)].map((m) => Number(m[1])))];
  }

  /** Its message and fix with each task it names written by `name`. */
  named(name: (id: number) => string): { message: string; fix: string } {
    return { message: render(this.template.message, name), fix: render(this.template.fix, name) };
  }

  toJSON(): { code: ErrorCode; message: string; fix: string } {
    return { code: this.code, message: this.message, fix: this.fix };
  }
}

export function refuse(code: ErrorCode, message: string, fix: string): never {
  throw new BoardError(code, message, fix);
}
