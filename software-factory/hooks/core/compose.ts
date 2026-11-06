// The composition root (decision 0003, #376): the one place that picks the adapters and builds the ports. A command
// calls compose(config) once and passes the ports down; a test passes its own in `overrides`. Only this file (and the
// adapters' own tests) imports core/adapters/: tools/check_skills.ts refuses any other.
//
// Messaging follows `messaging.transport` (#404): "github", the default, is comments, markers and labels. "nats" loads
// the NATS plugin (decision 0004, #409) with hooks/factory_plugins.ts and checks that its server answers; the kinds in
// `messaging.kinds` then go over NATS and GitHub, the rest over GitHub (adapters/routed). A plugin that is missing or
// fails to load, or a server that can't be reached, is a fallback: with `messaging.fallback` "github" (the default) the
// port is GitHub's and `warn` is told once; with "none" reading `messaging` throws.
// The port is built when it is first read, so a command that only uses the task tracker never trips on it. The task
// tracker follows `tasks.source` (#377): "issues" is GitHub Issues, "board" the message board (#500), anything else the
// build plan, as it always was.
//
// The message board (decision 0007, #500): with `tasks.source` "board" the messages follow the tasks there (every kind).
// With `messaging.transport` "board", the kinds in `messaging.kinds` go to the board as they went to NATS: messages
// through adapters/routed, and claims, wake-ups and the pull request feed from natsFor. The board is reached through
// its child (adapters/board/child.ts), which finds it as `factory board` does (MB_URL, else this machine's url file).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Config, taskSource } from "../factory_config.ts";
import { loadPlugin } from "../factory_plugins.ts";
import { GithubMessaging } from "./adapters/github/messaging.ts";
import { GithubTaskTracker } from "./adapters/github/task_tracker.ts";
import { BoardBus } from "./adapters/board/bus.ts";
import { BoardChild } from "./adapters/board/child.ts";
import { BoardMessaging } from "./adapters/board/messaging.ts";
import { BoardTaskTracker } from "./adapters/board/task_tracker.ts";
import { ClaimTokens } from "./adapters/board/tokens.ts";
import { PlanTaskTracker } from "./adapters/plan/task_tracker.ts";
import { RoutedMessaging } from "./adapters/routed/messaging.ts";
import { CoreError } from "./domain/error.ts";
import type { Leases, Messaging, PrFeed, Wakes } from "./ports/messaging.ts";
import type { TaskTracker } from "./ports/task_tracker.ts";

export interface Ports {
  messaging: Messaging;
  tasks: TaskTracker;
}

export interface MessagingSettings {
  transport: string;
  url: string;
  creds: string;
  kinds: string[];
  githubCopy: string[]; // the moved kinds still also written to GitHub (unset: kinds)
  fallback: string;
  pollMinutes: number; // with wake on NATS: how long an idle wait listens before it looks at GitHub anyway
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

/** The project's `messaging` settings, each with its default when unset or of the wrong type. */
export function messagingSettings(config: Config): MessagingSettings {
  const m = config.messaging;
  const own: Record<string, unknown> = typeof m === "object" && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  const text = (key: string, dflt: string): string => (typeof own[key] === "string" && own[key] ? (own[key] as string) : dflt);
  const list = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : null);
  const kinds = list(own.kinds) ?? [];
  const poll = Number(own.pollMinutes);
  return { transport: text("transport", "github"), url: text("url", ""), creds: text("creds", ""), kinds,
    githubCopy: list(own.githubCopy) ?? kinds, fallback: text("fallback", "github"),
    pollMinutes: typeof own.pollMinutes === "number" && poll > 0 ? poll : 15 };
}

/** The kinds that may be on NATS only (6 Nov 2026, "NATS is not the record"): coordination nobody reads later. */
export const NATS_ONLY_KINDS = ["claim", "release", "wake"];

/** Whether `kind` is written to GitHub, on top of NATS, by a caller that already has NATS for it. False only for a
 * moved kind that may be NATS-only and that `messaging.githubCopy` leaves out; every record kind is always written. */
export function githubCopies(config: Config, kind: string): boolean {
  const s = messagingSettings(config);
  return !(busTransport(s) && s.kinds.includes(kind) && NATS_ONLY_KINDS.includes(kind) && !s.githubCopy.includes(kind));
}

/** Whether the settings send the moved kinds over a coordination transport: NATS or the message board. */
export function busTransport(s: MessagingSettings): boolean {
  return s.transport === "nats" || s.transport === "board";
}

function messagingPort(s: MessagingSettings, warn: (e: CoreError) => void): Messaging {
  if (s.transport === "board") return new RoutedMessaging(new GithubMessaging(), boardMessaging(), s.kinds, warn);
  if (s.transport !== "nats") return new GithubMessaging();
  let nats: Messaging;
  try {
    nats = natsPort(s);
  } catch (e) {
    const { code, message, fix } = asCoreError(e);
    if (s.fallback === "none") throw new CoreError(code, message, `${fix} Or set \`factory settings set messaging.transport github\`.`);
    warn(new CoreError(code, `${message} Messages go over GitHub for now (messaging.fallback is github).`,
      `${fix} Or set \`factory settings set messaging.transport github\` to stop this notice.`));
    return new GithubMessaging();
  }
  return new RoutedMessaging(new GithubMessaging(), nats, s.kinds, warn);
}

type NatsPort = Messaging & Leases & Wakes & PrFeed & { check(): void };
type NatsFactory = (o: { url: string; project: string; seed?: string }) => NatsPort;

let bus: { port: NatsPort | null; error: CoreError | null } | null = null; // one per process: the settings don't change

/** NATS's leases, wake-ups and pull request feed for `kind` ("claim", "wake" or "pr", decision 0004 point 8), or null
 * while that kind hasn't moved: `messaging.transport` isn't nats or `messaging.kinds` doesn't list it. Then the caller
 * goes on over GitHub as it always did. A plugin or server that can't be had is the same fallback as the messaging
 * port's: null and `warn` is told (fallback "github", the default), or the CoreError is thrown (fallback "none"). */
export function natsFor(config: Config, kind: "claim" | "wake" | "pr", warn: (e: CoreError) => void = () => {}): (Leases & Wakes & PrFeed) | null {
  const s = messagingSettings(config);
  if (!busTransport(s) || !s.kinds.includes(kind)) return null;
  let error: CoreError;
  if (s.transport === "board") {
    boardBusState ??= checkedBoardBus();
    if (boardBusState.port) return boardBusState.port;
    error = boardBusState.error as CoreError;
  } else {
    if (!bus) {
      try {
        bus = { port: rawNatsPort(s), error: null };
      } catch (e) {
        bus = { port: null, error: asCoreError(e) };
      }
    }
    if (bus.port) return withCoreErrorsBus(bus.port);
    error = bus.error as CoreError;
  }
  const { code, message, fix } = error;
  if (s.fallback === "none") throw new CoreError(code, message, `${fix} Or set \`factory settings set messaging.transport github\`.`);
  const what = kind === "claim" ? "Claims go" : kind === "wake" ? "Wake-ups go" : "Pull requests and CI are read";
  warn(new CoreError(code, `${message} ${what} over GitHub for now (messaging.fallback is github).`,
    `${fix} Or set \`factory settings set messaging.transport github\` to stop this notice.`));
  return null;
}

/** The NATS plugin's port for this project, its server checked. Throws {code, message, fix} when it can't be had. */
function natsPort(s: MessagingSettings): Messaging {
  return withCoreErrors(rawNatsPort(s));
}

function rawNatsPort(s: MessagingSettings): NatsPort {
  if (!s.url) {
    throw new CoreError("nats-unreachable", "messaging.transport is nats, but messaging.url names no server.",
      "Set it with `factory settings set messaging.url nats://<address>:4222`.");
  }
  const create = loadPlugin("nats").createMessaging;
  if (typeof create !== "function") {
    throw new CoreError("plugin-load", "The nats plugin has no createMessaging.", "Run `factory update` to a release that carries it.");
  }
  const project = messagingProject();
  const port = (create as NatsFactory)({ url: s.url, project, ...seedOf(s, project) });
  port.check();
  return port;
}

/** The project's name on NATS: its origin repository's name (the same in all its worktrees), else its folder's, in
 * lowercase letters, digits and dashes. */
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

/** The folder of the agents' seeds: `creds` (messaging.creds, ~/ for the home folder), else ~/.secrets/nats/<project>.
 * `factory nats user add` writes there and an agent reads from there, so the two always agree. */
export function seedFolder(creds: string, project: string): string {
  if (creds === "~" || creds.startsWith("~/")) return join(homedir(), creds.slice(2));
  return creds || join(homedir(), ".secrets", "nats", project);
}

/** This agent's seed file, when it has one: <seedFolder>/<FACTORY_AGENT>.nk. */
function seedOf(s: MessagingSettings, project: string): { seed?: string } {
  const agent = process.env.FACTORY_AGENT;
  if (!agent) return {};
  const seed = join(seedFolder(s.creds, project), `${agent}.nk`);
  return existsSync(seed) ? { seed } : {};
}

/** Anything thrown with a code and a fix (a plugin's own error class, the loader's FactoryError) as a CoreError. */
function asCoreError(e: unknown): CoreError {
  if (e instanceof CoreError) return e;
  const x = e as { code?: unknown; message?: unknown; fix?: unknown } | null;
  if (x && typeof x.code === "string" && typeof x.fix === "string") return new CoreError(x.code, String(x.message ?? ""), x.fix);
  throw e;
}

/** The plugin's port, with what it throws as the core's CoreError (a bundle carries its own copy of the class). */
function withCoreErrors(port: Messaging): Messaging {
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      throw asCoreError(e);
    }
  };
  return {
    send: (m, text) => wrap(() => port.send(m, text)),
    read: (cursor, scope) => wrap(() => port.read(cursor, scope)),
    ack: (id) => wrap(() => port.ack(id)),
  };
}

/** The plugin's leases and wake-ups, with what they throw as the core's CoreError. */
function withCoreErrorsBus(port: NatsPort): Leases & Wakes & PrFeed {
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      throw asCoreError(e);
    }
  };
  return {
    claim: (key, holder, ttl) => wrap(() => port.claim(key, holder, ttl)),
    release: (key, holder) => wrap(() => port.release(key, holder)),
    holder: (key) => wrap(() => port.holder(key)),
    drop: (key) => wrap(() => port.drop(key)),
    wake: (w) => wrap(() => port.wake(w)),
    waitWake: (w) => wrap(() => port.waitWake(w)),
    putPrs: (s, events) => wrap(() => port.putPrs(s, events)),
    prs: () => wrap(() => port.prs()),
    prEvents: (w) => wrap(() => port.prEvents(w)),
  };
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

function boardTracker(): TaskTracker {
  return new BoardTaskTracker({ child: boardChild(), repo: boardRepo(), tokens: new ClaimTokens(boardTokensFile()) });
}

function boardMessaging(): Messaging {
  return new BoardMessaging({ child: boardChild(), repo: boardRepo() });
}

let boardBusState: { port: (Leases & Wakes & PrFeed) | null; error: CoreError | null } | null = null; // one per process

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

/** What `factory doctor` asks of this machine's message board: its server, the migrations applied and its task counts
 * (null before the first migrate). Throws the CoreError that says why it can't be reached. */
export function boardInfo(): { server: string; migrations: string[]; counts: Record<string, number> | null } {
  return boardChild().one("factory", "info") as { server: string; migrations: string[]; counts: Record<string, number> | null };
}
