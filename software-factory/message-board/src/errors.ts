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
  | "busy"; // the write crossed another one at the same moment (a deadlock or serialization failure) and was undone

export class BoardError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly fix: string) {
    super(message);
    this.name = "BoardError";
  }

  toJSON(): { code: ErrorCode; message: string; fix: string } {
    return { code: this.code, message: this.message, fix: this.fix };
  }
}

export function refuse(code: ErrorCode, message: string, fix: string): never {
  throw new BoardError(code, message, fix);
}
