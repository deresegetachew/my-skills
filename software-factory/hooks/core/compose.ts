// The composition root (decision 0003, #376): the one place that picks the adapters and builds the ports. A command
// calls compose(config) once and passes the ports down; a test passes its own in `overrides`. Only this file (and the
// adapters' own tests) imports core/adapters/: tools/check_skills.ts refuses any other.
//
// Messaging follows `messaging.transport` (#404, #504): "github" is comments, markers and labels; "board" sends the kinds
// in `messaging.kinds` to the message board (decision 0007) as well, through adapters/routed, and takes claims, wake-ups
// and the pull request feed from busFor. Unset, it is "board" on a machine with a board set up (MB_URL, or this
// machine's url file, which `factory board up` and `factory machine join` write), else "github". "nats" was removed
// (#504): it is refused with the fix. A board that can't be reached is a fallback: with `messaging.fallback` "github"
// (the default) the port is GitHub's and `warn` is told once; with "none" reading `messaging` throws.
// The port is built when it is first read, so a command that only uses the task tracker never trips on it. The task
// tracker follows `tasks.source` (#377): "issues" is GitHub Issues, "board" the message board (#500), anything else the
// build plan, as it always was. With `tasks.source` "board" the messages follow the tasks there (every kind).
// The board is reached through its child (adapters/board/child.ts), which finds it as `factory board` does.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Config, taskSource } from "../factory_config.ts";
import { GithubMessaging } from "./adapters/github/messaging.ts";
import { GithubTaskTracker } from "./adapters/github/task_tracker.ts";
import { BoardAgentRoster } from "./adapters/board/agents.ts";
import { BoardBus } from "./adapters/board/bus.ts";
import { BoardChild } from "./adapters/board/child.ts";
import { BoardMessaging } from "./adapters/board/messaging.ts";
import { BoardTaskTracker } from "./adapters/board/task_tracker.ts";
import { ClaimTokens } from "./adapters/board/tokens.ts";
import { PlanTaskTracker } from "./adapters/plan/task_tracker.ts";
import { RoutedMessaging } from "./adapters/routed/messaging.ts";
import { CoreError } from "./domain/error.ts";
import type { AgentRoster } from "./ports/agents.ts";
import type { Leases, Messaging, PrFeed, Wakes } from "./ports/messaging.ts";
import type { TaskTracker } from "./ports/task_tracker.ts";

export interface Ports {
  messaging: Messaging;
  tasks: TaskTracker;
}

export interface MessagingSettings {
  transport: string; // "github" or "board" ("nats" only in an old config, which is refused)
  kinds: string[];
  githubCopy: string[]; // the moved kinds still also written to GitHub (unset: kinds)
  fallback: string;
  pollMinutes: number; // with wake on the board: how long an idle wait listens before it looks at GitHub anyway
}

/** The ports for a project's `config`. `warn` hears of a fallback the command goes on with (nothing in the core prints). */
export function compose(config: Config, overrides: Partial<Ports> = {}, warn: (e: CoreError) => void = () => {}): Ports {
  let messaging = overrides.messaging;
  const tasks = overrides.tasks ?? taskTracker(config);
  return {
    get messaging(): Messaging {
      messaging ??= taskSource(config) === "board" ? boardMessaging() : messagingPort(messagingSettings(config), warn);
      return messaging;
    },
    tasks,
  };
}

/** Whether this machine has a message board set up: MB_URL, or the url file in its settings folder
 * (<FACTORY_CONFIG_DIR, else $XDG_CONFIG_HOME or ~/.config, /software-factory>/message-board/url, as the board finds it). */
export function boardSetUp(): boolean {
  if (process.env.MB_URL) return true;
  const base = process.env.FACTORY_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "software-factory");
  return existsSync(join(base, "message-board", "url"));
}

/** The project's `messaging` settings, each with its default when unset or of the wrong type. */
export function messagingSettings(config: Config): MessagingSettings {
  const m = config.messaging;
  const own: Record<string, unknown> = typeof m === "object" && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  const text = (key: string, dflt: string): string => (typeof own[key] === "string" && own[key] ? (own[key] as string) : dflt);
  const list = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : null);
  const kinds = list(own.kinds) ?? [];
  const poll = Number(own.pollMinutes);
  return { transport: text("transport", boardSetUp() ? "board" : "github"), kinds,
    githubCopy: list(own.githubCopy) ?? kinds, fallback: text("fallback", "github"),
    pollMinutes: typeof own.pollMinutes === "number" && poll > 0 ? poll : 15 };
}

/** The kinds that may be on the board only ("the board's copy is not the record" for the rest): coordination nobody
 * reads later. */
export const BUS_ONLY_KINDS = ["claim", "release", "wake"];

/** Whether `kind` is written to GitHub, on top of the board, by a caller that already has the board for it. False only
 * for a moved kind that may be on the board only and that `messaging.githubCopy` leaves out; every other kind is always
 * written. */
export function githubCopies(config: Config, kind: string): boolean {
  const s = messagingSettings(config);
  return !(s.transport === "board" && s.kinds.includes(kind) && BUS_ONLY_KINDS.includes(kind) && !s.githubCopy.includes(kind));
}

/** Whether the owner queue is on the board (#502, decision 0007 points 5 and 9): with `tasks.source` board, or with ask in
 * `messaging.kinds` on the board transport. Then an ask is written to the board and mirrored to the owner-queue issue. */
export function ownerQueueOnBoard(config: Config): boolean {
  if (taskSource(config) === "board") return true;
  const s = messagingSettings(config);
  return s.transport === "board" && s.kinds.includes("ask");
}

/** The refusal for a config that still names NATS (#504). */
export function transportRemoved(): CoreError {
  return new CoreError("transport-removed", "messaging.transport is nats, but NATS was removed from the factory (decision 0007, #504): " +
    "the message board carries wake-ups, claims and the pull request feed.",
    "Run `factory settings set messaging.transport board` (and `factory board up`, or `factory machine join`, on this machine), " +
    "or `factory settings set messaging.transport github`.");
}

function messagingPort(s: MessagingSettings, warn: (e: CoreError) => void): Messaging {
  if (s.transport === "nats") throw transportRemoved();
  if (s.transport !== "board") return new GithubMessaging();
  boardBusState ??= checkedBoardBus();
  if (boardBusState.port) return new RoutedMessaging(new GithubMessaging(), boardMessaging(), s.kinds, warn);
  fallBack(s, boardBusState.error as CoreError, "Messages go", warn);
  return new GithubMessaging();
}

/** A board that can't be had: thrown with fallback "none", else `warn` hears what goes over GitHub instead. */
function fallBack(s: MessagingSettings, error: CoreError, what: string, warn: (e: CoreError) => void): void {
  const { code, message, fix } = error;
  if (s.fallback === "none") throw new CoreError(code, message, `${fix} Or set \`factory settings set messaging.transport github\`.`);
  warn(new CoreError(code, `${message} ${what} over GitHub for now (messaging.fallback is github).`,
    `${fix} Or set \`factory settings set messaging.transport github\` to stop this notice.`));
}

/** The board's leases, wake-ups and pull request feed for `kind` ("claim", "wake" or "pr"), or null while that kind
 * hasn't moved: `messaging.transport` isn't board or `messaging.kinds` doesn't list it. Then the caller goes on over
 * GitHub as it always did. A board that can't be reached is the same fallback as the messaging port's: null and `warn`
 * is told (fallback "github", the default), or the CoreError is thrown (fallback "none"). An old "nats" is refused. */
export function busFor(config: Config, kind: "claim" | "wake" | "pr", warn: (e: CoreError) => void = () => {}): (Leases & Wakes & PrFeed) | null {
  const s = messagingSettings(config);
  if (s.transport === "nats") throw transportRemoved();
  if (s.transport !== "board" || !s.kinds.includes(kind)) return null;
  boardBusState ??= checkedBoardBus();
  if (boardBusState.port) return boardBusState.port;
  fallBack(s, boardBusState.error as CoreError, kind === "claim" ? "Claims go" : kind === "wake" ? "Wake-ups go" : "Pull requests and CI are read", warn);
  return null;
}

/** The project's name on the board (its keys, values and signals carry it): its origin repository's name (the same in
 * all its worktrees), else its folder's, in lowercase letters, digits and dashes. */
export function messagingProject(cwd: string = process.cwd()): string {
  const git = (...args: string[]): string => {
    const p = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return p.status === 0 ? p.stdout.trim() : "";
  };
  const origin = git("config", "--get", "remote.origin.url");
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const raw = /([^/:]+?)(?:\.git)?\/?$/.exec(origin)?.[1] ?? basename(common ? dirname(common) : resolve(cwd));
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "project";
}

/** Anything thrown with a code and a fix as a CoreError. */
function asCoreError(e: unknown): CoreError {
  if (e instanceof CoreError) return e;
  const x = e as { code?: unknown; message?: unknown; fix?: unknown } | null;
  if (x && typeof x.code === "string" && typeof x.fix === "string") return new CoreError(x.code, String(x.message ?? ""), x.fix);
  throw e;
}

/** The task tracker `source` names, by default the project's `tasks.source`. A command that is about one tracker
 * (`factory issues`) names it. */
export function taskTracker(config: Config, source: string = taskSource(config)): TaskTracker {
  if (source === "board") return boardTracker();
  return source === "issues" ? new GithubTaskTracker(config) : new PlanTaskTracker(config);
}

/** The message board's child. Nothing is asked of the board until a call is made. */
function boardChild(): BoardChild {
  return new BoardChild({ url: process.env.MB_URL ?? "" });
}

/** This project's GitHub repo as the board's refs name it (owner/name, lowercase): GH_REPO, else the origin remote, as
 * `factory board import github` reads it; "" when it has neither. */
export function boardRepo(cwd: string = process.cwd()): string {
  const given = (process.env.GH_REPO ?? "").trim();
  if (given) return given.toLowerCase();
  const p = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" });
  const m = p.status === 0 ? /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(p.stdout.trim()) : null;
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : "";
}

/** Where this project keeps its board claim tokens on this machine: <git common dir>/factory/board-claims.json. */
export function boardTokensFile(cwd: string = process.cwd()): string {
  const p = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  const common = p.status === 0 && p.stdout.trim() ? p.stdout.trim() : resolve(cwd, ".git");
  return join(common, "factory", "board-claims.json");
}

let boardBusState: { port: (Leases & Wakes & PrFeed) | null; error: CoreError | null } | null = null; // one per process

function boardTracker(): TaskTracker {
  return new BoardTaskTracker({ child: boardChild(), repo: boardRepo(), tokens: new ClaimTokens(boardTokensFile()), claimSeconds: boardClaimSeconds() });
}

/** How long a board claim lasts before it needs a heartbeat: FACTORY_BOARD_CLAIM_SECONDS (for tests, and to tune it),
 * else the board's own 30 minutes. */
export function boardClaimSeconds(): number {
  const n = Number(process.env.FACTORY_BOARD_CLAIM_SECONDS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30 * 60; // the board's CLAIM_SECONDS
}

/** Where the agents say they are alive (#513): the message board's roster with `tasks.source` board, else null (issues
 * mode keeps an agent issue each on GitHub, factory_agents.ts; plan mode tracks none). */
export function agentRoster(config: Config): AgentRoster | null {
  if (taskSource(config) !== "board") return null;
  return new BoardAgentRoster({ child: boardChild(), project: messagingProject() });
}

function boardMessaging(): Messaging {
  return new BoardMessaging({ child: boardChild(), repo: boardRepo() });
}

/** The board's leases, wake-ups and pull request feed, the board checked once (it answers, and has its tables). */
function checkedBoardBus(): { port: (Leases & Wakes & PrFeed) | null; error: CoreError | null } {
  const child = boardChild();
  try {
    child.call("factory", [{ op: "lastSeq" }, { op: "leaseHolder", args: ["factory:check"] }]);
  } catch (e) {
    return { port: null, error: asCoreError(e) };
  }
  return { port: new BoardBus({ child, project: messagingProject() }), error: null };
}

/** What `factory doctor` asks of this machine's message board: its server, the migrations applied, those this code has
 * that aren't (`pending`, #570) and its task counts (null before the first migrate). Throws the CoreError that says why
 * it can't be reached. */
export function boardInfo(): { server: string; migrations: string[]; pending?: string[]; counts: Record<string, number> | null } {
  return boardChild().one("factory", "info") as { server: string; migrations: string[]; pending?: string[]; counts: Record<string, number> | null };
}
