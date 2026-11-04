// The composition root (decision 0003, #376): the one place that picks the adapters and builds the ports. A command
// calls compose(config) once and passes the ports down; a test passes its own in `overrides`. Only this file (and the
// adapters' own tests) imports core/adapters/: tools/check_skills.ts refuses any other.
//
// For now there is one port, messaging, on GitHub. A `messaging.transport` setting comes with the second real adapter
// (NATS, #373).
import type { Config } from "../factory_config.ts";
import { GithubMessaging } from "./adapters/github/messaging.ts";
import type { Messaging } from "./ports/messaging.ts";

export interface Ports {
  messaging: Messaging;
}

/** The ports for a project's `config` (read once a port has more than one adapter to choose from). */
export function compose(config: Config, overrides: Partial<Ports> = {}): Ports {
  return { messaging: overrides.messaging ?? new GithubMessaging() };
}
