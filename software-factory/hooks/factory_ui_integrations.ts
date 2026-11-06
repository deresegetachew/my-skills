// The web UI's integrations page (#441): what a project's factory connects to (GitHub, the messaging hub, the CI runners,
// the plugins, the MCP connectors, the build cache), each one set up or not, its settings in plain words, and a test
// that asks it now. A read only looks at files (the settings, the git remote, .mcp.json, the cockpit's cache, the
// plugins' folder), so it calls no one; only a test does: `gh api user`, a connection to the hub, the project's
// `factory ci status --json`, a request to the build cache. factory_ui_server.ts serves it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { neededPlugins, pluginPath } from "./factory_plugins.ts";
import { type ActionResult, envFor, factoryScript, type Obj, type Problem, readJson, spawn, stateDirOf, type UiProject } from "./factory_ui_data.ts";

const TEST_TIMEOUT_MS = 5_000;
const CI_TIMEOUT_MS = 60_000;

export type IntegrationState = "ok" | "bad" | "off" | "unknown";

export interface Integration {
  id: string;
  name: string;
  /** One grey line: what it is connected to, or why not. */
  sub: string;
  state: IntegrationState;
  stateText: string;
  settings: { label: string; value: string }[];
  problem: Problem | null;
  /** Whether POST .../integrations/:id/test asks it now. */
  testable: boolean;
}

export interface Integrations {
  project: string;
  summary: string;
  counts: { all: number; bad: number; off: number };
  integrations: Integration[];
}

const STATE_TEXT: Record<IntegrationState, string> = { ok: "Set up", bad: "Needs a fix", off: "Not set up", unknown: "Not read yet" };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function item(id: string, name: string, state: IntegrationState, sub: string, more: Partial<Integration> = {}): Integration {
  return { id, name, sub, state, stateText: STATE_TEXT[state], settings: [], problem: null, testable: false, ...more };
}

// --- reading -----------------------------------------------------------------------------------------------------------

/** owner/name of the project's GitHub remote (https or ssh), else null. */
export function githubRepo(path: string): string | null {
  let url = "";
  try {
    const cfg = readFileSync(join(gitDir(path), "config"), "utf8");
    const origin = /\[remote "origin"\]([^[]*)/.exec(cfg)?.[1] ?? "";
    url = /^\s*url\s*=\s*(.+)$/m.exec(origin)?.[1]?.trim() ?? "";
  } catch {
    return null;
  }
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The repository's git folder: .git, or where a worktree's .git file points (its common folder holds the config). */
function gitDir(path: string): string {
  const dot = join(path, ".git");
  try {
    const text = readFileSync(dot, "utf8");
    const dir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!dir) return dot;
    const common = join(dir, "commondir");
    return existsSync(common) ? join(dir, readFileSync(common, "utf8").trim()) : dir;
  } catch {
    return dot; // a folder (EISDIR) or none
  }
}

function github(p: UiProject): Integration {
  const cfg = obj(p.config);
  const source = str(obj(cfg.tasks).source) || "plan";
  const repo = githubRepo(p.path);
  const settings = [
    { label: "Repository", value: repo ?? "none" },
    { label: "Tasks come from", value: source === "issues" ? "GitHub issues" : "the build plan" },
    { label: "Main branch", value: str(cfg.mainBranch) || "main" },
  ];
  if (!repo) {
    return item("github", "GitHub", "bad", "This project has no GitHub remote", { settings, testable: true,
      problem: { code: "ui_github_no_remote", message: "GitHub isn't this project's code host: its origin isn't a GitHub repository.",
        fix: "Add the GitHub repository as origin in the project's checkout, then read this page again." } });
  }
  return item("github", "GitHub", "ok", `${repo} · tasks from ${source === "issues" ? "GitHub issues" : "the build plan"}`, { settings, testable: true });
}

/** host:port of a nats:// or tls:// address, else null. */
function hostPort(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || 4222 };
  } catch {
    return null;
  }
}

function messaging(p: UiProject): Integration {
  const m = obj(obj(p.config).messaging);
  const transport = str(m.transport) || "github";
  const url = str(m.url);
  const kinds = list(m.kinds).filter((k): k is string => typeof k === "string");
  const settings = [
    { label: "Messages go over", value: transport === "nats" ? "the hub (NATS)" : "GitHub" },
    { label: "Address", value: url || "none" },
    { label: "Moved to the hub", value: kinds.length ? kinds.join(", ") : "nothing" },
  ];
  if (transport !== "nats") return item("messaging", "Messaging hub", "off", "Agents talk through GitHub; there is no hub", { settings });
  const at = hostPort(url);
  if (!at) {
    return item("messaging", "Messaging hub", "bad", "The hub is on, but its address is missing", { settings, testable: true,
      problem: { code: "ui_hub_no_address", message: url ? `The hub's address ${url} can't be read.` : "The hub is on, but it has no address.",
        fix: "Set the hub's address (nats://<address>:4222) in the factory's settings, through a settings pull request." } });
  }
  return item("messaging", "Messaging hub", "ok", `${at.host}:${at.port} · ${kinds.length ? `${kinds.join(", ")} over the hub` : "nothing moved yet"}`,
    { settings, testable: true });
}

function ci(p: UiProject): Integration {
  const cache = obj(readJson(join(stateDirOf(p), "cockpit.json")));
  const c = obj(cache.ci);
  const runners = list(c.runners).map(obj);
  const light = list(obj(c.light).runners).map(obj);
  const online = runners.filter((r) => str(r.status) === "online").length;
  const lightOnline = light.filter((r) => str(r.status) === "online").length;
  const mode = str(c.mode);
  const settings = [
    { label: "Jobs run on", value: mode === "github" ? "GitHub's runners" : mode === "local" ? "this project's own runners" : "not read yet" },
    { label: "Runners online", value: `${online} of ${runners.length}` },
    { label: "Light lane", value: light.length ? `${lightOnline} of ${light.length} online` : "none" },
  ];
  if (!mode) return item("ci", "CI runners", "unknown", "The CI page hasn't been read on this machine yet", { settings, testable: true });
  if (mode === "github") return item("ci", "CI runners", "ok", "Jobs run on GitHub's runners", { settings, testable: true });
  const sub = `${online} runner${online === 1 ? "" : "s"} online${light.length ? `, light lane ${lightOnline ? "online" : "offline"}` : ""}`;
  if (!online) {
    return item("ci", "CI runners", "bad", "No runner is online, so CI jobs wait", { settings, testable: true,
      problem: { code: "ui_ci_no_runner", message: "No CI runner is online, so every CI job waits.",
        fix: "Start the runners on the CI machine from the CI page, or send the jobs to GitHub's runners there." } });
  }
  return item("ci", "CI runners", "ok", sub, { settings, testable: true });
}

/** The hooks folder whose plugins project `p` runs: its own, else this release's. */
function hooksOf(p: UiProject): string {
  const own = join(p.path, ".claude", "hooks");
  return !p.current && existsSync(join(own, "factory_plugins.ts")) ? own : import.meta.dir;
}

const PLUGIN_TITLE: Record<string, string> = { nats: "NATS messaging" };

function plugins(p: UiProject): Integration {
  const hooks = hooksOf(p);
  const found = new Set<string>();
  try {
    for (const f of readdirSync(join(hooks, "plugins"))) if (f.endsWith(".js")) found.add(f.slice(0, -3));
  } catch {
    // no bundles: a checkout of my-skills, or none installed
  }
  const needed = neededPlugins(p.config);
  for (const n of needed) if (pluginPath(n, hooks)) found.add(n);
  const missing = needed.filter((n) => !pluginPath(n, hooks));
  const names = [...found].sort().map((n) => PLUGIN_TITLE[n] ?? n);
  const settings = [
    { label: "Installed", value: names.length ? names.join(", ") : "none" },
    { label: "Needed by the settings", value: needed.length ? needed.map((n) => PLUGIN_TITLE[n] ?? n).join(", ") : "none" },
  ];
  if (missing.length) {
    const what = missing.map((n) => PLUGIN_TITLE[n] ?? n).join(", ");
    return item("plugins", "Plugins", "bad", `${what} is needed but not installed`, { settings,
      problem: { code: "ui_plugin_missing", message: `The settings need the ${what} plugin, and it isn't installed.`,
        fix: "Update the factory in this project (Releases and updates): it installs the factory and its plugins together." } });
  }
  if (!needed.length) return item("plugins", "Plugins", "off", names.length ? `${names.join(", ")} installed, not in use` : "No plugin is in use", { settings });
  return item("plugins", "Plugins", "ok", `${names.join(", ")} installed`, { settings });
}

function mcp(p: UiProject): Integration {
  const file = join(p.path, ".mcp.json");
  if (!existsSync(file)) return item("mcp", "MCP connectors", "off", "No connector: the agents use only their own tools", { settings: [{ label: "Connectors", value: "none" }] });
  const raw = readJson(file);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return item("mcp", "MCP connectors", "bad", "The connectors' file can't be read", { settings: [{ label: "Connectors", value: "unreadable" }],
      problem: { code: "ui_mcp_unreadable", message: "The project's .mcp.json isn't valid JSON, so Claude Code starts no connector.",
        fix: "Fix .mcp.json in the project through a pull request (the owner merges it)." } });
  }
  const names = Object.keys(obj((raw as Obj).mcpServers)).sort();
  const settings = [{ label: "Connectors", value: names.length ? names.join(", ") : "none" }];
  if (!names.length) return item("mcp", "MCP connectors", "off", "No connector: the agents use only their own tools", { settings });
  return item("mcp", "MCP connectors", "ok", names.join(", "), { settings });
}

function buildCache(p: UiProject): Integration {
  const t = obj(obj(p.config).turbo);
  const api = str(t.api);
  const settings = [
    { label: "Address", value: api || "none" },
    { label: "Team", value: str(t.team) || "the repository's name" },
  ];
  if (!api) return item("cache", "Build cache", "off", "Agents and CI build without a shared cache", { settings });
  return item("cache", "Build cache", "ok", api, { settings, testable: true });
}

function summaryOf(all: Integration[]): string {
  const bad = all.filter((i) => i.state === "bad");
  const head = `${all.length} connections.`;
  if (!bad.length) return `${head} None needs you.`;
  const first = (bad[0] as Integration).problem?.message ?? (bad[0] as Integration).sub;
  return bad.length === 1 ? `${head} One needs you: ${first}` : `${head} ${bad.length} need you, first: ${first}`;
}

/** Every integration of project `p`, read from its files: no call to GitHub, the hub or the cache. */
export function integrationsOf(p: UiProject): Integrations {
  const all = [github(p), messaging(p), ci(p), plugins(p), mcp(p), buildCache(p)];
  return { project: p.id, summary: summaryOf(all), integrations: all,
    counts: { all: all.length, bad: all.filter((i) => i.state === "bad").length, off: all.filter((i) => i.state === "off").length } };
}

// --- testing -----------------------------------------------------------------------------------------------------------

function passed(id: string, message: string): ActionResult {
  return { status: 200, body: { ok: true, id, message } };
}

function failed(id: string, code: string, message: string, fix: string): ActionResult {
  return { status: 200, body: { ok: false, id, code, message, fix } };
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
}

async function testGithub(p: UiProject): Promise<ActionResult> {
  const r = await spawn(["gh", "api", "user"], p.path, envFor(p), TEST_TIMEOUT_MS * 3);
  let login = "";
  try {
    login = str(obj(JSON.parse(r.stdout) as unknown).login);
  } catch {
    // said below
  }
  if (r.code === 0 && login) return passed("github", `GitHub answers: signed in as ${login}.`);
  return failed("github", "ui_test_github", `GitHub didn't answer (${lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code}`}).`,
    "Sign in to GitHub again on the machine that serves this page (gh auth login), then test again.");
}

/** Whether something accepts a connection at host:port within the timeout. */
function reachable(host: string, port: number): Promise<string | null> {
  return new Promise((done) => {
    const s = connect({ host, port });
    const end = (why: string | null): void => {
      clearTimeout(timer);
      s.destroy();
      done(why);
    };
    const timer = setTimeout(() => end("no answer"), TEST_TIMEOUT_MS);
    s.once("connect", () => end(null));
    s.once("error", (e: Error) => end(e.message.slice(0, 200)));
  });
}

async function testHub(p: UiProject): Promise<ActionResult> {
  const url = str(obj(obj(p.config).messaging).url);
  const at = hostPort(url) as { host: string; port: number };
  const why = await reachable(at.host, at.port);
  if (why === null) return passed("messaging", `The hub answers at ${at.host}:${at.port}.`);
  return failed("messaging", "ui_test_hub", `Nothing answers at ${at.host}:${at.port} (${why}).`,
    "Start the hub on its machine (Machines), or check that this machine can reach it over Tailscale or the LAN.");
}

async function testCi(p: UiProject): Promise<ActionResult> {
  const r = await spawn(["bash", factoryScript(p), "ci", "status", "--json"], p.path, envFor(p), CI_TIMEOUT_MS);
  if (r.code === 0) return passed("ci", "CI answers: its status was read.");
  return failed("ci", "ui_test_ci", `CI's status can't be read (${lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code}`}).`,
    "Open the CI page for what is wrong; it has the step that fixes it.");
}

async function testCache(p: UiProject): Promise<ActionResult> {
  const api = str(obj(obj(p.config).turbo).api);
  try {
    await fetch(api, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    return passed("cache", `The build cache answers at ${api}.`);
  } catch (e) {
    return failed("cache", "ui_test_cache", `Nothing answers at ${api} (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}).`,
      "Start the build cache on its machine, or check that this machine can reach its address.");
  }
}

const TESTS: Record<string, (p: UiProject) => Promise<ActionResult>> = { github: testGithub, messaging: testHub, ci: testCi, cache: testCache };

/** Asks integration `id` of project `p` now: 200 with {ok, message} or {ok: false, code, message, fix}; 404 for an
 * unknown one, 409 for one that isn't set up or has no test. */
export async function testIntegration(p: UiProject, id: string): Promise<ActionResult> {
  const it = integrationsOf(p).integrations.find((i) => i.id === id);
  if (!it) {
    return { status: 404, body: { code: "ui_integration_unknown", message: `There is no integration ${id}.`,
      fix: "GET /api/projects/:p/integrations lists them." } };
  }
  const run = TESTS[id];
  if (!run) {
    return { status: 409, body: { code: "ui_integration_no_test", message: `${it.name} has no test here: its row already says all the page can tell.`,
      fix: "Read its row; it says what is wrong and the step that fixes it." } };
  }
  if (!it.testable) {
    return { status: 409, body: { code: "ui_integration_not_set_up", message: `${it.name} isn't set up, so there is nothing to test.`,
      fix: `Set ${it.name} up first; its row says how.` } };
  }
  if (id === "messaging" && it.problem) {
    return { status: 409, body: { code: "ui_integration_not_set_up", message: it.problem.message, fix: it.problem.fix } };
  }
  return run(p);
}
