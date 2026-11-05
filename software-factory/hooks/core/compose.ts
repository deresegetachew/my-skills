// The composition root (decision 0003, #376): the one place that picks the adapters and builds the ports. A command
// calls compose(config) once and passes the ports down; a test passes its own in `overrides`. Only this file (and the
// adapters' own tests) imports core/adapters/: tools/check_skills.ts refuses any other.
//
// Messaging follows `messaging.transport` (#404): "github", the default, is comments, markers and labels. "nats" needs
// the NATS plugin (decision 0004), which is not built yet, so it is the plugin-missing case: with `messaging.fallback`
// "github" (the default) the ports go on over GitHub and `warn` is told once; with "none" reading `messaging` throws.
// The port is built when it is first read, so a command that only uses the task tracker never trips on it. The task
// tracker follows `tasks.source` (#377): "issues" is GitHub Issues, anything else the build plan, as it always was.
import { type Config, taskSource } from "../factory_config.ts";
import { GithubMessaging } from "./adapters/github/messaging.ts";
import { GithubTaskTracker } from "./adapters/github/task_tracker.ts";
import { PlanTaskTracker } from "./adapters/plan/task_tracker.ts";
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
  const missing = new CoreError("plugin-missing", "messaging.transport is nats, but the NATS plugin isn't in this release yet.",
    s.fallback === "none" ? "Set it back with `factory settings set messaging.transport github`."
      : "Messages go over GitHub for now. Set `factory settings set messaging.transport github` to stop this notice.");
  if (s.fallback === "none") throw missing;
  warn(missing);
  return new GithubMessaging();
}

/** The task tracker `source` names, by default the project's `tasks.source`. A command that is about one tracker
 * (`factory issues`) names it. */
export function taskTracker(config: Config, source: string = taskSource(config)): TaskTracker {
  return source === "issues" ? new GithubTaskTracker(config) : new PlanTaskTracker(config);
}
