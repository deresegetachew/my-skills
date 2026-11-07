#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The factory's side of the message board as the record (#502, decision 0007 points 5 and 9). `factory board <verb>`
// runs the board's own command (message-board/bin.ts), except these, which need the project's settings:
//
//   factory board mirror [--watch] [--every <seconds>]
//       carries the board to GitHub, one way (message-board/src/github/mirror.ts): a task's state change sets its issue's
//       labels with one short line, owner asks and answers go to the owner-queue issue once, and the owner's answers there
//       come back once. Its place is kept on the board, so it is safe to run twice and goes on after downtime. `board.mirror`
//       false turns it off. --watch keeps running: a pass on each change on the board, and at least every --every seconds
//       (300) for the owner's answers on GitHub.
//   factory board ask <id> <text>
//       an owner-queue ask: with the owner queue on the board (`tasks.source` board, or ask in `messaging.kinds`), written to
//       the board (kind ask, to the owner, on the owner-queue issue's task) and mirrored; otherwise a comment on the
//       owner-queue issue, as before. `--body -` takes the whole comment (its marker included) from stdin instead.
//   factory board import github ...
//       the board's import, with `--board-is-record` when `tasks.source` is board: a status the board changed since the
//       last import is kept (the board is the record); new issues, edited titles and bodies and new comments still come in.
//
// `factory owner answer` (factory_owner.ts) calls answerOnBoard: with the owner queue on the board, the answer goes to the
// board first, then the mirror posts it. Errors are one JSON line `{code, message, fix}` on stderr.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { boardRepo, ownerQueueOnBoard } from "./core/compose.ts";
import { boardMirror, type Config, load, taskSource } from "./factory_config.ts";
import { comment } from "./factory_issues.ts";
import { Exit, pyDumps, runMain } from "./factory_lib.ts";
import { OWNER_TITLE, ownerLogin, ownerQueue } from "./factory_orchestrator.ts";
import { breakMarkers, ownerAskIds, trustedOf } from "./factory_prs.ts";
import { Board, BoardError, boardUrl, GithubError, type Message, type MirrorSummary, mirrorToGithub, type Task } from "../message-board/src/index.ts";

const BIN = join(import.meta.dir, "..", "message-board", "bin.ts");
const MIRROR_ACTOR = "github-mirror";
const OWNER = "owner";
const USAGE = `factory board mirror [--watch] [--every <seconds>]
factory board ask <id> <text>      (or --body - with the whole comment on stdin)
factory board import github [--closed] [--dry-run] [--repo owner/name]`;

class Refusal extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
  }
}

function refuse(code: string, message: string, fix: string): never {
  throw new Refusal(code, message, fix);
}

/** This project's repo on GitHub, as the board's refs name it. */
function repoOf(): string {
  const repo = boardRepo();
  if (!repo) refuse("no_repo", "This project has no GitHub repo (no origin remote and no GH_REPO), so the board can't be mirrored.", "Add the GitHub remote as origin, or set GH_REPO=owner/name.");
  return repo;
}

/** The board, opened as `as`. */
async function open(as: string): Promise<Board> {
  const url = boardUrl();
  if (!url) refuse("board_missing", "This machine has no message board: MB_URL is unset and there is no url file in its settings folder.", "Start one with `factory board up` (or `factory machine join` on another machine), then run this again.");
  return Board.open(url, { as, session: `factory-board-${process.pid}`, max: 2 });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --- the mirror ----------------------------------------------------------------------------------------------------------

/** One pass of the mirror; null when board.mirror is off. Throws a GithubError when GitHub fails. */
export async function mirrorOnce(cfg: Config, board?: Board): Promise<MirrorSummary | null> {
  if (!boardMirror(cfg)) return null;
  const repo = repoOf();
  const b = board ?? (await open(MIRROR_ACTOR));
  try {
    return await mirrorToGithub(b, { repo, trusted: [...trustedOf(cfg)] });
  } finally {
    if (!board) await b.end().catch(() => {});
  }
}

function report(s: MirrorSummary): void {
  if (s.busy) {
    console.log("Another mirror pass is running (a --watch, or another machine's); this one sent nothing. It sends what changed.");
    return;
  }
  console.log(`Mirrored the message board to ${s.repo}: ${plural(s.tasks.mirrored, "task's new state", "tasks' new states")}, ` +
    `${plural(s.messages, "ask or answer", "asks and answers")} posted, ${plural(s.answers, "answer", "answers")} read back from GitHub` +
    (s.tasks.unchanged ? ` (${plural(s.tasks.unchanged, "task", "tasks")} back where it was last sent: nothing sent)` : "") + ".");
  console.log(`GitHub calls: ${s.calls}`);
}

const OFF = "The mirror is off (board.mirror is false): nothing was sent to GitHub. `factory settings set board.mirror true` turns it on.";

async function mirror(cfg: Config, args: string[]): Promise<number> {
  const watch = args.includes("--watch");
  const at = args.indexOf("--every");
  const every = at >= 0 ? Number(args[at + 1]) : 300;
  const rest = args.filter((a, i) => a !== "--watch" && i !== at && i !== at + 1);
  if (rest.length) refuse("bad_args", `factory board mirror doesn't take \`${rest.join(" ")}\`.`, USAGE.split("\n")[0] as string);
  if (!Number.isFinite(every) || every < 5) refuse("bad_args", "--every takes a number of seconds, 5 or more.", "factory board mirror --watch --every 300");
  if (!boardMirror(cfg)) {
    console.log(OFF);
    return 0;
  }
  if (!watch) {
    report((await mirrorOnce(cfg)) as MirrorSummary);
    return 0;
  }
  const board = await open(MIRROR_ACTOR);
  let wake: () => void = () => {};
  let pending = false; // a change heard while a pass ran: the next pass starts at once
  const key = `value:mirror:github:${repoOf()}`;
  const listener = await board.listen((e) => {
    if (e.kind === "value.set" && e.subject === key) return; // its own place
    pending = true;
    wake();
  });
  try {
    for (;;) {
      pending = false;
      try {
        const s = await mirrorOnce(cfg, board);
        if (s && (s.tasks.mirrored || s.messages || s.answers)) report(s);
      } catch (e) {
        if (!(e instanceof GithubError)) throw e;
        process.stderr.write(pyDumps({ code: e.code, message: e.message, fix: e.fix }) + "\n"); // tried again on the next pass
      }
      if (pending) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, every * 1000);
        wake = () => {
          clearTimeout(timer);
          setTimeout(resolve, 1000); // a burst of changes is one pass
        };
      });
    }
  } finally {
    await listener.close().catch(() => {});
    await board.end().catch(() => {});
  }
}

// --- the owner queue -----------------------------------------------------------------------------------------------------

const askMarker = (id: string): string => `<!-- factory-owner-ask id=${id} -->`;

/** The owner-queue issue's task on the board: found by its ref, else made (a note, as the import makes it). */
async function queueTask(board: Board, repo: string, n: number): Promise<Task> {
  const ref = `github:${repo}#${n}`;
  const found = (await board.tasks({ all: true, limit: 1_000_000 })).find((t) => t.ref === ref);
  return found ?? board.create({ title: OWNER_TITLE, kind: "note", ref });
}

/** The asks on this project's owner-queue tasks on the board, newest last. */
async function boardAsks(board: Board, repo: string): Promise<Message[]> {
  const prefix = `github:${repo}#`;
  const queues = (await board.tasks({ all: true, limit: 1_000_000 })).filter((t) => t.title === OWNER_TITLE && (t.ref ?? "").startsWith(prefix));
  const out: Message[] = [];
  for (const q of queues) out.push(...(await board.thread({ task: q.id })).filter((m) => m.kind === "ask"));
  return out;
}

/** Write ask `id` (`body`, its marker first) to the board on the owner-queue issue's task and mirror it. False when it
 * was already asked there. */
export async function askOnBoard(cfg: Config, id: string, body: string): Promise<boolean> {
  const repo = repoOf();
  const board = await open(process.env.FACTORY_AGENT || "dev-manager");
  try {
    const n = ownerQueue(cfg, true) as number;
    if ((await boardAsks(board, repo)).some((m) => ownerAskIds(m.body).includes(id))) return false;
    const q = await queueTask(board, repo, n);
    await board.post({ task: q.id, kind: "ask", tag: "owner-ask", to: OWNER, body });
    await mirrorAfter(cfg, board, `#${n}`);
    return true;
  } finally {
    await board.end().catch(() => {});
  }
}

/** A mirror pass after a write: a GitHub failure is told, not thrown (what was written stays on the board, and the next
 * `factory board mirror` sends it). */
async function mirrorAfter(cfg: Config, board: Board, where: string): Promise<void> {
  if (!boardMirror(cfg)) {
    console.log(`board.mirror is false, so it is on the board only (not on ${where}).`);
    return;
  }
  try {
    const s = await mirrorOnce(cfg, board);
    console.log(s?.busy ? `Another mirror pass is running; it sends this to ${where}.` : `Mirrored to ${where} on GitHub.`);
  } catch (e) {
    if (!(e instanceof GithubError) && !(e instanceof BoardError)) throw e;
    console.log(`It is on the board; GitHub didn't take the copy yet (${e.message}). \`factory board mirror\` sends it.`);
  }
}

/** `factory owner answer` with the owner queue on the board: the answer is written to the board first, then mirrored.
 * "absent" when the board has no such ask (the caller answers on GitHub, as before). */
export async function answerOnBoard(cfg: Config, id: string, text: string): Promise<"answered" | "already" | "absent"> {
  const repo = repoOf();
  const board = await open(OWNER);
  try {
    if (boardMirror(cfg)) {
      try {
        await mirrorOnce(cfg, board); // an answer given on GitHub meanwhile comes back first
      } catch (e) {
        if (!(e instanceof GithubError) && !(e instanceof BoardError)) throw e;
      }
    }
    const ask = (await boardAsks(board, repo)).filter((m) => ownerAskIds(m.body).includes(id)).at(-1);
    if (!ask) return "absent";
    if (ask.state !== "open") {
      console.log(`${id} is already answered on the message board; nothing written.`);
      return "already";
    }
    // the owner's words carry no marker but this one: a quoted `<!--` is broken (#395)
    await board.post({ task: ask.taskId, kind: "answer", tag: "owner-answer", to: ask.from, inReplyTo: ask.id,
      body: `<!-- factory-owner-answer id=${id} -->\n\n${breakMarkers(text.trim())}` });
    console.log(`Answered ${id} on the message board.`);
    await mirrorAfter(cfg, board, "the owner queue");
    return "answered";
  } finally {
    await board.end().catch(() => {});
  }
}

async function ask(cfg: Config, args: string[]): Promise<number> {
  const [id, ...words] = args;
  if (!id || !/^[\w.-]+$/.test(id)) refuse("needs_id", "Name the ask with an id of letters, digits, dots and dashes.", 'factory board ask palette "Which colour for the buttons?"');
  let body: string;
  if (words[0] === "--body" && words[1] === "-" && words.length === 2) {
    body = await Bun.stdin.text();
    if (!ownerAskIds(body).includes(id)) refuse("bad_body", `The body on stdin doesn't start with ${askMarker(id)}.`, "Start the body with the ask's marker.");
  } else {
    const text = words.join(" ").trim();
    if (!text) refuse("needs_text", `Write what you ask the owner in ${id}.`, `factory board ask ${id} "Which colour for the buttons?"`);
    const login = ownerLogin(cfg);
    body = `${askMarker(id)}\n${login ? `@${login} ` : ""}${breakMarkers(text)}`;
  }
  if (ownerQueueOnBoard(cfg)) {
    if (!(await askOnBoard(cfg, id, body))) console.log(`${id} is already asked on the message board; nothing written.`);
    else console.log(`Asked ${id} on the message board.`);
    return 0;
  }
  const n = ownerQueue(cfg, true) as number;
  comment(n, body);
  console.log(`Asked ${id} on the owner queue (#${n}).`);
  return 0;
}

// --- the import ----------------------------------------------------------------------------------------------------------

function importVerb(cfg: Config, args: string[]): number {
  const more = taskSource(cfg) === "board" && !args.includes("--board-is-record") ? ["--board-is-record"] : [];
  const p = spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", BIN, "import", ...args, ...more], { stdio: "inherit" });
  return p.status ?? 1;
}

/** Exit code 3: the board couldn't be had (none set up, or it doesn't answer), so nothing was written to it. A caller that
 * falls back to GitHub (the dev manager's asks) does so only then; any other failure may have written to the board. */
export const NO_BOARD_EXIT = 3;

function boardCouldNotTake(e: { code: string }): boolean {
  return ["board_missing", "no-answer", "board-unreachable", "failed"].includes(e.code) && !(e instanceof GithubError);
}

// --- the command ---------------------------------------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  try {
    if (!verb || verb === "help" || verb === "--help") {
      console.log(USAGE);
      return 0;
    }
    const cfg = load();
    if (verb === "mirror") return await mirror(cfg, rest);
    if (verb === "ask") return await ask(cfg, rest);
    if (verb === "import") return importVerb(cfg, rest);
    return refuse("unknown_verb", `\`${verb}\` isn't one of this command's verbs.`, "Run `factory board help`.");
  } catch (e) {
    if (e instanceof Refusal || e instanceof GithubError || e instanceof BoardError) {
      process.stderr.write(pyDumps({ code: e.code, message: e.message, fix: e.fix }) + "\n");
      throw new Exit(boardCouldNotTake(e) ? NO_BOARD_EXIT : 1);
    }
    throw e;
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
