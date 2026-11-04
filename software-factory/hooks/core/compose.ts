// The composition root (decision 0003, #376): the one place that picks the adapters and builds the ports. A command
// calls compose(config) once and passes the ports down; a test passes its own in `overrides`. Only this file (and the
// adapters' own tests) imports core/adapters/: tools/check_skills.ts refuses any other.
//
// Messaging is on GitHub; a `messaging.transport` setting comes with the second real adapter (NATS, #373). The task
// tracker follows `tasks.source` (#377): "issues" is GitHub Issues, anything else the build plan, as it always was.
import { type Config, taskSource } from "../factory_config.ts";
import { GithubMessaging } from "./adapters/github/messaging.ts";
import { GithubTaskTracker } from "./adapters/github/task_tracker.ts";
import { PlanTaskTracker } from "./adapters/plan/task_tracker.ts";
import type { Messaging } from "./ports/messaging.ts";
import type { TaskTracker } from "./ports/task_tracker.ts";

export interface Ports {
  messaging: Messaging;
  tasks: TaskTracker;
}

/** The ports for a project's `config`. */
export function compose(config: Config, overrides: Partial<Ports> = {}): Ports {
  return { messaging: overrides.messaging ?? new GithubMessaging(), tasks: overrides.tasks ?? taskTracker(config) };
}

/** The task tracker `source` names, by default the project's `tasks.source`. A command that is about one tracker
 * (`factory issues`) names it. */
export function taskTracker(config: Config, source: string = taskSource(config)): TaskTracker {
  return source === "issues" ? new GithubTaskTracker(config) : new PlanTaskTracker(config);
}
