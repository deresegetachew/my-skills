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
import type { Messaging } from "./ports/messaging.ts";
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
  return { transport: text("transport", "github"), url: text("url", ""), creds: text("creds", ""), kinds,
    fallback: text("fallback", "github") };
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

type NatsFactory = (o: { url: string; project: string; seed?: string }) => Messaging & { check(): void };

/** The NATS plugin's port for this project, its server checked. Throws {code, message, fix} when it can't be had. */
function natsPort(s: MessagingSettings): Messaging {
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
  return withCoreErrors(port);
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

/** This agent's seed file, when it has one: <messaging.creds, else ~/.secrets/nats/<project>>/<FACTORY_AGENT>.nk. */
function seedOf(s: MessagingSettings, project: string): { seed?: string } {
  const agent = process.env.FACTORY_AGENT;
  if (!agent) return {};
  const seed = join(s.creds || join(homedir(), ".secrets", "nats", project), `${agent}.nk`);
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

/** The task tracker `source` names, by default the project's `tasks.source`. A command that is about one tracker
 * (`factory issues`) names it. */
export function taskTracker(config: Config, source: string = taskSource(config)): TaskTracker {
  return source === "issues" ? new GithubTaskTracker(config) : new PlanTaskTracker(config);
}
