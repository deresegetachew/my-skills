// factory-message-board's public entry (decision 0007): the only file outside this folder may import.
export { Board, CLAIM_SECONDS, type Listener, type OpenOptions, QUIET_SECONDS } from "./board.ts";
export { BoardError, type ErrorCode } from "./errors.ts";
export { migrationNames } from "./migrate.ts";
export * from "./types.ts";
export { FACTORY_MAPPING, type GithubMapping, GithubError, type ImportSummary, importFromGithub } from "./github/import.ts";
/** Where a user of the board finds it on this machine: MB_URL, else <machine settings folder>/message-board/url. */
export { boardUrl } from "./server.ts";
/** The child a synchronous caller runs with Bun.spawnSync (src/child.ts): one JSON request in, one JSON answer out. */
export type { Answer as ChildAnswer, Call as ChildCall, EventRule, Request as ChildRequest, WaitFor } from "./child.ts";
