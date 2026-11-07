#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The factory's side of the message board as the record (#502, decision 0007 points 5 and 9). `factory board <verb>`
// runs the board's own command (message-board/bin.ts), except these, which need the project's settings:
//
//   factory board mirror [--watch] [--every <seconds>] [--max-seconds <n>]
//       carries the board to GitHub, one way (message-board/src/github/mirror.ts): a task's state change sets its issue's
//       labels with one short line, owner asks and answers go to the owner-queue issue once, and the owner's answers there
//       come back once. Its place is kept on the board, so it is safe to run twice and goes on after downtime. `board.mirror`
//       false turns it off. --watch keeps running: a pass on each change on the board, and at least every --every seconds
//       (300) for the owner's answers on GitHub. --max-seconds stops a one-off pass that runs longer than n seconds (a hung
//       `gh`, a board that doesn't answer), so it can't stall the dev manager's pass in factory-loop.sh (#511).
//   factory board ask <id> <text>
//       an owner-queue ask: with the owner queue on the board (`tasks.source` board, or ask in `messaging.kinds`), written to
//       the board (kind ask, to the owner, on the owner-queue issue's task) and mirrored; otherwise a comment on the
//       owner-queue issue, as before. `--body -` takes the whole comment (its marker included) from stdin instead.
//   factory board queue [--json]
//       the owner queue as the board has it (#513): the messages on the owner-queue issue's task, oldest first, each in the
//       shape of a GitHub comment (body, user.login, created_at), so `factory prd --stage` and the web UI's Inbox read the
//       board as they read the issue. Exit 3 when the board can't be had: they fall back to GitHub.
//   factory board sweep [--quiet-minutes N] [--max-seconds N]
//       the board's sweep (message-board/bin.ts); --max-seconds stops one that runs longer, as the mirror's does, for the
//       dev manager's pass in factory-loop.sh (#513).
//   factory board import github ...
//       the board's import, with `--board-is-record` when `tasks.source` is board: a status the board changed since the
//       last import is kept (the board is the record); new issues, edited titles and bodies and new comments still come in.
//
// `factory owner answer` (factory_owner.ts) calls answerOnBoard: with the owner queue on the board, the answer goes to the
// board first, then the mirror posts it. Errors are one JSON line `{code, message, fix}` on stderr.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardRepo, ownerQueueOnBoard } from "./core/compose.ts";
import { boardMirror, type Config, load, taskSource } from "./factory_config.ts";
import { comment } from "./factory_issues.ts";
import { countGithubCall, Exit, pyDumps, runMain } from "./factory_lib.ts";
import { OWNER_TITLE, ownerLogin, ownerQueue } from "./factory_orchestrator.ts";
import { breakMarkers, ownerAskIds, trustedOf } from "./factory_prs.ts";
import { Board, BoardError, boardUrl, ghCli, GithubError, isProjects, type Message, type MirrorSummary, mirrorToGithub, Numbers,
  type Task } from "../message-board/src/index.ts";

const BIN = join(import.meta.dir, "..", "message-board", "bin.ts");
const MIRROR_ACTOR = "github-mirror";
const OWNER = "owner";
const USAGE = `factory board mirror [--watch] [--every <seconds>] [--max-seconds <n>]
factory board ask <id> <text>      (or --body - with the whole comment on stdin)
factory board queue [--json]
factory board sweep [--quiet-minutes N] [--max-seconds N]
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
    // its gh calls go to the factory's hourly call log, as the factory's own do (#371, #520); an agent's question to the
    // owner goes on the owner-queue issue (#549), found on the board, else on GitHub (made on demand, as an ask's is)
    return await mirrorToGithub(b, { repo, trusted: [...trustedOf(cfg)], gh: ghCli({ onCall: (a) => countGithubCall(a) }),
      ownerQueue: () => queueIssue(cfg, b, repo) });
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

/** A one-off mirror pass (`args`) in a child process with a group of its own, stopped with whatever it started (a hung
 * `gh`) when it runs longer than `seconds`. A stopped pass loses nothing: its place is kept on the board and the next run
 * sends the rest. */
async function mirrorWithin(seconds: number, args: string[]): Promise<number> {
  return within(seconds, [import.meta.path, "mirror", ...args], () => refuse("mirror_timeout",
    `factory board mirror ran longer than ${seconds} seconds and was stopped. What it sent stays sent; the next run sends the rest.`,
    "Run `factory board mirror` by hand to see where it waits, and check `gh auth status` and `factory board status`."));
}

/** Bun running `script` and its arguments in a child process with a group of its own, stopped with whatever it started
 * when it runs longer than `seconds` (then `late` says so). Its output is this command's. */
async function within(seconds: number, script: string[], late: () => never): Promise<number> {
  const child = spawn(process.execPath, ["--no-env-file", "--config=/dev/null", ...script], { stdio: "inherit", detached: true });
  const stop = (): void => {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      // already gone
    }
  };
  const onSignal = (): void => {
    stop();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  const timeUp = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), seconds * 1000);
  });
  try {
    const r = await Promise.race([ended, timeUp]);
    if (r !== "late") return r;
    stop();
    return late();
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function mirror(cfg: Config, args: string[]): Promise<number> {
  const lim = args.indexOf("--max-seconds");
  if (lim >= 0) {
    const seconds = Number(args[lim + 1]);
    if (!Number.isFinite(seconds) || seconds < 1) refuse("bad_args", "--max-seconds takes a number of seconds, 1 or more.", "factory board mirror --max-seconds 300");
    if (args.includes("--watch")) refuse("bad_args", "--max-seconds is for a one-off pass; --watch keeps running.", "factory board mirror --max-seconds 300");
    if (!boardMirror(cfg)) {
      console.log(OFF);
      return 0;
    }
    return mirrorWithin(seconds, args.filter((_, i) => i !== lim && i !== lim + 1));
  }
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
    // an agent's liveness and a claim's heartbeat change nothing on GitHub (#513): no pass for them
    if (e.kind === "task.heartbeat" || e.kind === "signal.agent" || (e.kind === "value.set" && /^value:[^:]+:agent:/.test(e.subject))) return;
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

/** The open owner-queue issue as the board has it (its newest open owner-queue task), else the one GitHub has (made when
 * there is none, and its task made on the board, so the next pass asks GitHub nothing). */
async function queueIssue(cfg: Config, board: Board, repo: string): Promise<number> {
  const prefix = `github:${repo}#`;
  const open = (await board.tasks({ all: true, limit: 1_000_000 })).filter((t) => t.title === OWNER_TITLE && t.status !== "done" &&
    /^\d+$/.test((t.ref ?? "").slice(prefix.length)) && (t.ref ?? "").startsWith(prefix)).map((t) => Number((t.ref as string).slice(prefix.length)));
  if (open.length) return Math.max(...open);
  const n = ownerQueue(cfg, true) as number;
  await queueTask(board, repo, n);
  return n;
}

/** Question `id` on the board when it is one an agent asked the owner in this repo's project (#549), else null. */
async function ownerQuestion(board: Board, repo: string, id: number): Promise<Message | null> {
  let m: Message;
  try {
    m = await board.message(id);
  } catch (e) {
    if (e instanceof BoardError && e.code === "not-found") return null;
    throw e;
  }
  if (m.kind !== "question" || m.to !== OWNER) return null;
  return isProjects(repo, m, m.taskId === null ? null : await board.get(m.taskId)) ? m : null;
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
 * "absent" when the board has no such ask (the caller answers on GitHub, as before). An id `m<n>` that is no ask names
 * board message n, a question an agent asked the owner (#549): the answer goes in reply to it, to its sender, and marks
 * it answered; "no-question" when the board has no such question for this project. */
export async function answerOnBoard(cfg: Config, id: string, text: string): Promise<"answered" | "already" | "absent" | "no-question"> {
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
    const asked = (await boardAsks(board, repo)).filter((m) => ownerAskIds(m.body).includes(id)).at(-1);
    const n = /^m(\d+)$/.exec(id)?.[1];
    const ask = asked ?? (n === undefined ? null : await ownerQuestion(board, repo, Number(n)));
    if (!ask) return n === undefined ? "absent" : "no-question";
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

// --- the sweep -----------------------------------------------------------------------------------------------------------

/** `factory board sweep [--quiet-minutes N] [--max-seconds N]`: the board's sweep (message-board/bin.ts), stopped after
 * --max-seconds when given, so a board that doesn't answer can't stall the dev manager's pass (#513). */
async function sweep(args: string[]): Promise<number> {
  const lim = args.indexOf("--max-seconds");
  if (lim < 0) return spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", BIN, "sweep", ...args], { stdio: "inherit" }).status ?? 1;
  const seconds = Number(args[lim + 1]);
  if (!Number.isFinite(seconds) || seconds < 1) refuse("bad_args", "--max-seconds takes a number of seconds, 1 or more.", "factory board sweep --max-seconds 60");
  const rest = args.filter((_, i) => i !== lim && i !== lim + 1);
  return within(seconds, [BIN, "sweep", ...rest], () => refuse("sweep_timeout",
    `factory board sweep ran longer than ${seconds} seconds and was stopped. A claim it freed stays freed; the next pass sweeps again.`,
    "Check the board with `factory board status`, then run `factory board sweep` by hand."));
}

// --- the owner queue, read ---------------------------------------------------------------------------------------------

/** One message of the owner queue in the shape of a GitHub comment, so the owner queue's readers (factory_prs.ts's
 * ownerAskStates, factory_flow.ts's approvals, the web UI's Inbox) read the board as they read the issue. */
export interface QueueComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string | null;
  kind: string;
  state: string;
  /** The task it is about, as people name it (#101, b17), when an agent's question has one (#549). */
  task: string | null;
}

export interface BoardQueue {
  source: "board";
  /** The owner-queue issue's number (its task's ref), null when the board has no owner queue for this repo. */
  issue: number | null;
  url: string | null;
  comments: QueueComment[];
}

const OWNER_ANSWER_MARK = /<!--\s*factory-owner-answer\b/;

/** The messages on this repo's owner-queue tasks on the board, and every question an agent asked the owner in this repo's
 * project with the answers to it (#549), oldest first. A question is shown as ask `m<id>` (its words with any marker
 * broken), and an answer without a marker gets the one of what it answers, so each reader pairs them as the board does.
 * An answer read back from GitHub keeps GitHub's time, so the order is the one the issue shows. The board's `owner`
 * actor is the owner. */
async function boardQueue(board: Board, repo: string): Promise<BoardQueue> {
  const prefix = `github:${repo}#`;
  const tasks = await board.tasks({ all: true, limit: 1_000_000 });
  const queues = tasks.filter((t) => t.title === OWNER_TITLE && (t.ref ?? "").startsWith(prefix))
    .sort((a, b) => Number((a.ref as string).slice(prefix.length)) - Number((b.ref as string).slice(prefix.length)));
  const newest = queues.filter((t) => t.status !== "done").at(-1) ?? queues.at(-1);
  const issue = newest ? Number((newest.ref as string).slice(prefix.length)) : null;
  const byId = new Map<number, Message>();
  for (const q of queues) for (const m of await board.thread({ task: q.id })) byId.set(m.id, m);
  const taskOf = new Map(tasks.map((t) => [t.id, t]));
  const all = (await board.messages()).messages;
  const questions = new Set(all.filter((m) => m.kind === "question" && m.to === OWNER &&
    isProjects(repo, m, m.taskId === null ? null : taskOf.get(m.taskId) ?? null)).map((m) => m.id));
  for (const m of all) if (questions.has(m.id) || (m.kind === "answer" && m.inReplyTo !== null && questions.has(m.inReplyTo))) byId.set(m.id, m);
  const messages = [...byId.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  const slugOf = new Map<number, string>();
  for (const m of messages) {
    const slug = questions.has(m.id) ? `m${m.id}` : m.kind === "ask" ? ownerAskIds(m.body)[0] : undefined;
    if (slug) slugOf.set(m.id, slug);
  }
  const bodyOf = (m: Message): string => {
    if (questions.has(m.id)) return `<!-- factory-owner-ask id=m${m.id} -->\n${breakMarkers(m.body.trim())}`;
    const answers = m.kind === "answer" && m.inReplyTo !== null ? slugOf.get(m.inReplyTo) : undefined;
    return answers && !OWNER_ANSWER_MARK.test(m.body) ? `<!-- factory-owner-answer id=${answers} -->\n\n${m.body}` : m.body;
  };
  const queueIds = new Set(queues.map((q) => q.id));
  const numbers = new Numbers(repo);
  const link = (m: Message): string | null => {
    const c = /\/comments\/(\d+)$/.exec(m.ref ?? "")?.[1];
    const n = m.taskId !== null && queueIds.has(m.taskId) ? taskOf.get(m.taskId)?.ref?.slice(prefix.length) : issue; // a question is on the queue's issue
    return c && n ? `https://github.com/${repo}/issues/${n}#issuecomment-${c}` : null;
  };
  const about = (m: Message): string | null => {
    const t = m.taskId === null || queueIds.has(m.taskId) ? undefined : taskOf.get(m.taskId);
    return t ? numbers.label(t) : null;
  };
  return { source: "board", issue, url: issue === null ? null : `https://github.com/${repo}/issues/${issue}`,
    comments: messages.map((m) => ({ id: m.id, body: bodyOf(m), user: { login: m.from }, created_at: m.createdAt.toISOString(), html_url: link(m),
      kind: m.kind, state: m.state, task: about(m) })) };
}

/** `factory board queue [--json]`: the owner queue as the board has it. Exit 3 (NO_BOARD_EXIT) when the board can't be
 * had, so a reader falls back to GitHub. */
async function queue(args: string[]): Promise<number> {
  const asJson = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  if (rest.length) refuse("bad_args", `factory board queue doesn't take \`${rest.join(" ")}\`.`, "factory board queue [--json]");
  const repo = repoOf();
  const board = await open("factory");
  try {
    const q = await boardQueue(board, repo);
    if (asJson) {
      console.log(JSON.stringify(q, null, 2));
      return 0;
    }
    const answered = new Set(q.comments.flatMap((c) => [...c.body.matchAll(/<!--\s*factory-owner-answer\s+id=([\w.-]+)\s*-->/g)].map((m) => m[1] as string)));
    const asks = q.comments.flatMap((c) => ownerAskIds(c.body).map((id): [string, QueueComment] => [id, c]));
    if (!asks.length) console.log("Nothing waits for the owner on the message board. Questions the agents ask the owner appear here.");
    for (const [id, c] of asks) {
      console.log(`${id.padEnd(24)} ${answered.has(id) ? "answered" : "open    "} asked by ${c.user.login}${c.task ? ` about ${c.task}` : ""}, ` +
        c.created_at.slice(0, 16).replace("T", " "));
    }
    return 0;
  } finally {
    await board.end().catch(() => {});
  }
}

// --- questions to a role -------------------------------------------------------------------------------------------------

/** One line per open question on the board addressed to one of `names` in this repo's project (#549), oldest first, so
 * a role whose work check reads GitHub (the dev manager's precheck) also wakes for what an agent asked it through the
 * board's MCP. Empty when this machine has no board or it can't be had: the check goes on with what GitHub says. */
export async function boardQuestionsFor(names: string[]): Promise<string[]> {
  const url = boardUrl();
  if (!url || !names.length) return [];
  const repo = boardRepo();
  let board: Board | null = null;
  try {
    board = await Board.open(url, { as: "factory", session: `factory-board-${process.pid}`, max: 1 });
    const open: Message[] = [];
    for (const name of new Set(names)) open.push(...(await board.onMe(name)).messages.filter((m) => m.kind === "question"));
    const numbers = new Numbers(repo || null);
    const lines: string[] = [];
    for (const m of open.sort((a, b) => a.id - b.id)) {
      const t = m.taskId === null ? null : await board.get(m.taskId);
      if (repo && !isProjects(repo, m, t)) continue;
      const words = m.body.replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      lines.push(`question m${m.id} from ${m.from} to ${m.to}${t ? ` about ${numbers.label(t)}` : ""} (on the board): ${words}`);
    }
    return lines;
  } catch (e) {
    if (e instanceof BoardError) return [];
    throw e;
  } finally {
    await board?.end().catch(() => {});
  }
}

// --- the import ----------------------------------------------------------------------------------------------------------

/** The import runs in the board's own command; it lists its `gh` calls in a file (MB_GH_CALLS_FILE), and they go to the
 * factory's hourly call log from here, so `factory usage --github` counts them (#520). */
function importVerb(cfg: Config, args: string[]): number {
  const more = taskSource(cfg) === "board" && !args.includes("--board-is-record") ? ["--board-is-record"] : [];
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "factory-board-calls-"));
  const file = join(dir, "calls.jsonl");
  try {
    const p = spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", BIN, "import", ...args, ...more],
      { stdio: "inherit", env: { ...process.env, MB_GH_CALLS_FILE: file } });
    logCalls(file);
    return p.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Each `gh` call listed in `file` (one JSON list of arguments a line) into the call log. */
function logCalls(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return; // no call made
  }
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const args: unknown = JSON.parse(line);
      if (Array.isArray(args) && args.every((a) => typeof a === "string")) countGithubCall(args as string[]);
    } catch {
      // a torn last line: that call is not counted
    }
  }
}

/** Exit code 3: the board couldn't be had (none set up, or it doesn't answer), so nothing was written to it. A caller that
 * falls back to GitHub (the dev manager's asks) does so only then; any other failure may have written to the board. */
export const NO_BOARD_EXIT = 3;

function boardCouldNotTake(e: { code: string }): boolean {
  return ["board_missing", "no-answer", "login-refused", "board-unreachable", "failed"].includes(e.code) && !(e instanceof GithubError);
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
    if (verb === "sweep") return await sweep(rest);
    if (verb === "queue") return await queue(rest);
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
