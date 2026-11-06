// factory-message-board's public entry (decision 0007): the only file outside this folder may import.
export { Board, CLAIM_SECONDS, type Listener, type OpenOptions, QUIET_SECONDS } from "./board.ts";
export { BoardError, type ErrorCode } from "./errors.ts";
export { migrationNames } from "./migrate.ts";
export * from "./types.ts";
