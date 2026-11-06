// The web UI's integrations page (#441): what the factory connects to, each with its state, one line about it, the fix
// when it needs one, and the command its Test button runs. It reads the project's settings, its git remote, its .mcp.json
// and the cockpit's cache, so a read here never calls GitHub; only a test does, and a test only reads.
// factory_ui_server.ts routes to it.
//
//   GET  /api/projects/:p/integrations             the six rows, the ones that need a fix first, and their counts
//   POST /api/projects/:p/integrations/:id/test    runs that row's test (no confirm: it changes nothing)
//
// Which agent may use which integration is not here yet: no setting says it (asked on the pull request).
import { join } from "node:path";
import { ciVerdict } from "./factory_ci_view.ts";
import { run } from "./factory_lib.ts";
import { neededPlugins, pluginPath } from "./factory_plugins.ts";
import { type ActionResult, envFor, factoryScript, hooksOf, type Obj, type Problem, readJson, resultOf, spawn, stateDirOf,
  type UiProject } from "./factory_ui_data.ts";

const TEST_TIMEOUT_MS = 60_000;

export type IntegrationState = "connected" | "needs-fix" | "not-set-up" | "unknown";

export interface Integration {
  id: string;
  name: string;
  state: IntegrationState;
  stateText: string;
  sub: string;
  /** What to do, when it needs a fix or isn't set up; else null. */
  fix: string | null;
  /** The command its Test button runs, or null when it has none. */
  test: string | null;
}

export interface Integrations {
  integrations: Integration[];
  counts: { all: number; needsFix: number; notSetUp: number };
  problems: Problem[];
}

const STATE_TEXT: Record<IntegrationState, string> = { connected: "Connected", "needs-fix": "Needs a fix", "not-set-up": "Not set up",
  unknown: "Not read yet" };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function row(id: string, name: string, state: IntegrationState, sub: string, fix: string | null, test: string | null): Integration {
  return { id, name, state, stateText: STATE_TEXT[state], sub, fix: state === "needs-fix" || state === "not-set-up" ? fix : null, test };
}

function github(p: UiProject, cfg: Obj): Integration {
  const r = run(["git", "-C", p.path, "remote", "get-url", "origin"]);
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(r?.code === 0 ? r.stdout.trim() : "");
  if (!m) {
    return row("github", "GitHub", "not-set-up", "No GitHub repository is this project's origin",
      "Add it: `git remote add origin https://github.com/<owner>/<name>.git`, then `gh auth login`.", null);
  }
  const tasks = str(obj(cfg.tasks).source) === "issues" ? "tasks from GitHub issues" : "tasks from the build plan";
  return row("github", "GitHub", "connected", `${m[1]} · ${tasks}`, null, "gh auth status");
}

/** The plugins the settings turn on, and those of them this project's factory doesn't have. */
function plugins(p: UiProject, cfg: Obj): { needed: string[]; missing: string[] } {
  const needed = neededPlugins(cfg);
  const hooks = hooksOf(p);
  return { needed, missing: needed.filter((n) => !pluginPath(n, hooks)) };
}

const PLUGIN_FIX = "Run `factory update` to a release that carries it (`factory releases` lists them).";

function hub(p: UiProject, cfg: Obj): Integration {
  const m = obj(cfg.messaging);
  if (str(m.transport) !== "nats") {
    return row("hub", "Messaging hub", "not-set-up", "Agents send messages through GitHub",
      "Start a hub with `factory nats up`, then set messaging.transport to nats and messaging.url to its address.", null);
  }
  const url = str(m.url);
  if (!url) {
    return row("hub", "Messaging hub", "needs-fix", "Messages go to NATS, but no address is set",
      "Set it: `factory settings set messaging.url nats://<address>:4222`.", "factory nats status");
  }
  if (plugins(p, cfg).missing.includes("nats")) {
    return row("hub", "Messaging hub", "needs-fix", "The NATS plugin isn't installed, so messages go through GitHub", PLUGIN_FIX, "factory nats status");
  }
  const kinds = (Array.isArray(m.kinds) ? m.kinds : []).filter((k): k is string => typeof k === "string");
  const where = url.replace(/^[a-z]+:\/\//, "");
  return row("hub", "Messaging hub", "connected", `${where} · ${kinds.length ? kinds.join(", ") : "no message kinds yet"} over NATS`, null,
    "factory nats status");
}

function ci(p: UiProject): Integration {
  const cache = obj(readJson(join(stateDirOf(p), "cockpit.json")));
  if (typeof cache.ci !== "object" || cache.ci === null) {
    return row("ci", "CI runners", "unknown", "No snapshot of CI yet", null, "factory ci status");
  }
  const [text, tone] = ciVerdict(obj(cache.ci));
  return row("ci", "CI runners", tone === "red" ? "needs-fix" : "connected", text,
    "Open the CI channel: it says which runner is down and starts it again.", "factory ci status");
}

function cache(cfg: Obj): Integration {
  const api = str(obj(cfg.turbo).api);
  if (!api) {
    return row("cache", "Build cache", "not-set-up", "Agents and CI build without a shared cache",
      "Start it with `factory turbo install`, then set turbo.api to its address.", null);
  }
  return row("cache", "Build cache", "connected", `${api} · shared by the agents and CI`, null, "factory turbo status");
}

function pluginsRow(p: UiProject, cfg: Obj): Integration {
  const { needed, missing } = plugins(p, cfg);
  if (!needed.length) {
    return row("plugins", "Plugins", "not-set-up", "None turned on", "A setting turns its plugin on: messaging.transport nats turns on nats.", null);
  }
  if (missing.length) return row("plugins", "Plugins", "needs-fix", `${missing.join(", ")} turned on but not installed`, PLUGIN_FIX, null);
  return row("plugins", "Plugins", "connected", `${needed.join(", ")} installed`, null, null);
}

function mcp(p: UiProject): Integration {
  const names = Object.keys(obj(obj(readJson(join(p.path, ".mcp.json"))).mcpServers));
  if (!names.length) {
    return row("mcp", "MCP connectors", "not-set-up", "None in .mcp.json",
      "Add one to .mcp.json at the project's root; it is protected, so a person merges it.", null);
  }
  return row("mcp", "MCP connectors", "connected", names.join(", "), null, null);
}

/** The six rows for project `p`: those that need a fix first, then in a fixed order. */
export function integrationsOf(p: UiProject): Integrations {
  if (p.problem) return { integrations: [], counts: { all: 0, needsFix: 0, notSetUp: 0 }, problems: [p.problem] };
  const cfg = obj(p.config);
  const all = [github(p, cfg), hub(p, cfg), ci(p), cache(cfg), pluginsRow(p, cfg), mcp(p)];
  const integrations = [...all.filter((r) => r.state === "needs-fix"), ...all.filter((r) => r.state !== "needs-fix")];
  return { integrations, problems: [], counts: { all: all.length, needsFix: all.filter((r) => r.state === "needs-fix").length,
    notSetUp: all.filter((r) => r.state === "not-set-up").length } };
}

/** POST /api/projects/:p/integrations/:id/test: runs that row's test in project `p`. */
export async function testIntegration(p: UiProject, id: string): Promise<ActionResult> {
  const r = integrationsOf(p).integrations.find((x) => x.id === id);
  if (!r) {
    return { status: 404, body: { code: "ui_integration_unknown", message: `There is no integration ${id}.`,
      fix: "GET /api/projects/:p/integrations lists them." } };
  }
  if (!r.test) {
    return { status: 400, body: { code: "ui_integration_no_test", message: `${r.name} has nothing to test.`,
      fix: r.fix ?? "Its line on the page says what it is." } };
  }
  const words = r.test.split(" ");
  const cmd = words[0] === "factory" ? ["bash", factoryScript(p), ...words.slice(1)] : words;
  const ran = await spawn(cmd, p.path, envFor(p), TEST_TIMEOUT_MS);
  return resultOf(p, r.test, ran, (ran.stdout + ran.stderr).trim());
}
