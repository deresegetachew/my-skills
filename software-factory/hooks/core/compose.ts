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
// tracker follows `tasks.source` (#377): "issues" is GitHub Issues, anything else the build plan, as it always was.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Config, taskSource } from "../factory_config.ts";
import { loadPlugin } from "../factory_plugins.ts";
import { GithubMessaging } from "./adapters/github/messaging.ts";
import { GithubTaskTracker } from "./adapters/github/task_tracker.ts";
import { PlanTaskTracker } from "./adapters/plan/task_tracker.ts";
import { RoutedMessaging } from "./adapters/routed/messaging.ts";
import { CoreError } from "./domain/error.ts";
import type { Leases, Messaging, Wakes } from "./ports/messaging.ts";
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
  fallback: string;
  pollMinutes: number; // with wake on NATS: how long an idle wait listens before it looks at GitHub anyway
}

/** The ports for a project's `config`. `warn` hears of a fallback the command goes on with (nothing in the core prints). */
export function compose(config: Config, overrides: Partial<Ports> = {}, warn: (e: CoreError) => void = () => {}): Ports {
  let messaging = overrides.messaging;
  const tasks = overrides.tasks ?? taskTracker(config);
  return {
    get messaging(): Messaging {
      messaging ??= messagingPort(messagingSettings(config), warn);
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
  const kinds = Array.isArray(own.kinds) ? own.kinds.filter((k): k is string => typeof k === "string") : [];
  const poll = Number(own.pollMinutes);
  return { transport: text("transport", "github"), url: text("url", ""), creds: text("creds", ""), kinds,
    fallback: text("fallback", "github"), pollMinutes: typeof own.pollMinutes === "number" && poll > 0 ? poll : 15 };
}

function messagingPort(s: MessagingSettings, warn: (e: CoreError) => void): Messaging {
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

type NatsPort = Messaging & Leases & Wakes & { check(): void };
type NatsFactory = (o: { url: string; project: string; seed?: string }) => NatsPort;

let bus: { port: NatsPort | null; error: CoreError | null } | null = null; // one per process: the settings don't change

/** NATS's leases and wake-ups for `kind` ("claim" or "wake", decision 0004 point 8), or null while that kind hasn't
 * moved: `messaging.transport` isn't nats or `messaging.kinds` doesn't list it. Then the caller goes on over GitHub as it
 * always did. A plugin or server that can't be had is the same fallback as the messaging port's: null and `warn` is
 * told (fallback "github", the default), or the CoreError is thrown (fallback "none"). */
export function natsFor(config: Config, kind: "claim" | "wake", warn: (e: CoreError) => void = () => {}): (Leases & Wakes) | null {
  const s = messagingSettings(config);
  if (s.transport !== "nats" || !s.kinds.includes(kind)) return null;
  if (!bus) {
    try {
      bus = { port: rawNatsPort(s), error: null };
    } catch (e) {
      bus = { port: null, error: asCoreError(e) };
    }
  }
  if (bus.port) return withCoreErrorsBus(bus.port);
  const { code, message, fix } = bus.error as CoreError;
  if (s.fallback === "none") throw new CoreError(code, message, `${fix} Or set \`factory settings set messaging.transport github\`.`);
  warn(new CoreError(code, `${message} ${kind === "claim" ? "Claims" : "Wake-ups"} go over GitHub for now (messaging.fallback is github).`,
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
function withCoreErrorsBus(port: NatsPort): Leases & Wakes {
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
  };
}

/** The task tracker `source` names, by default the project's `tasks.source`. A command that is about one tracker
 * (`factory issues`) names it. */
export function taskTracker(config: Config, source: string = taskSource(config)): TaskTracker {
  return source === "issues" ? new GithubTaskTracker(config) : new PlanTaskTracker(config);
}
