// factory-message-board's public entry (decision 0007): the only file outside this folder may import.
export { Board, CLAIM_SECONDS, type Listener, type OpenOptions, QUIET_SECONDS } from "./board.ts";
export { BoardError, type ErrorCode, LOGIN_REFUSED, LOGIN_REFUSED_FIX } from "./errors.ts";
export { migrationNames } from "./migrate.ts";
export { isProjects, Numbers, projectTag } from "./numbers.ts";
export { LOGIN_NAME, type Login } from "./logins.ts";
export * from "./types.ts";
export { FACTORY_MAPPING, type Gh, ghCli, type GithubMapping, GithubError, type ImportSummary, importFromGithub } from "./github/import.ts";
export { MIRROR_MARK, type MirrorOptions, mirrorState, type MirrorSummary, mirrorToGithub } from "./github/mirror.ts";
/** Where a user of the board finds it on this machine: MB_URL, else <machine settings folder>/message-board/url. */
export { boardDir, boardUrl } from "./server.ts";
/** The child a synchronous caller runs with Bun.spawnSync (src/child.ts): one JSON request in, one JSON answer out. */
export type { Answer as ChildAnswer, Call as ChildCall, EventRule, Request as ChildRequest, WaitFor } from "./child.ts";
/** The factory's sign-off and testing queue on the board (#552). */
export { addSignoff, postSignoff, SIGNOFF_TITLE, signoffEntries, signoffIds, signoffItemBody, signoffQueue, signoffQueueRef, signoffTask } from "./signoff.ts";
/** Attachments (#637): files on a task, a pull request (with its head), a sign-off item or an epic, kept on the hub. */
export { ATTACHMENT_ID, ATTACHMENT_KINDS, type AttachInput, type AttachLimits, type Attachment, type AttachmentKind, attach, attachmentById,
  classify, CONTENT_TYPES, DEFAULT_LIMITS, INLINE_TYPES, isHub, limitsOf, listAttachments, MAX_FILES, type NewFile, pruneAttachments, readBytes,
  repoKey, safeName, storeDir, storePath, type Target, TARGET_KINDS, type TargetKind, targetOf } from "./attachments.ts";
