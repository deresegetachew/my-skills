// What the web UI (`factory ui`, #421, #422, decision 0005) shows, read through the commands that already know it: the
// projects (this one and `ui.projects`), each one's channels (one per agent, one per view), its agents and machines
// live, and the owner's start and stop. Nothing here talks to a browser: factory_ui_server.ts serves it.
//
// Agents come from the project's own `factory agents ls --json` (this machine's heartbeat file, the other machines' agent
// issues, cached), run in that project's folder, so a project in `ui.projects` is read by its own release. A task's
// title, the CI runners and GitHub's limit come from that project's state folder (the cockpit's cache and the limit file),
// so a read here never calls GitHub itself. Start and stop run that project's `factory owner start|stop`, the commands
// the cockpit and the command line run.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Config, DEFAULTS, roleNames } from "./factory_config.ts";
import { limitSentence } from "./factory_cockpit.ts";
import { run } from "./factory_lib.ts";

const HOOKS = import.meta.dir;
const READ_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 60_000;
const LOG_LINES = 15;

export type Obj = { [key: string]: unknown };
export interface Problem {
  code: string;
  message: string;
  fix: string;
}

export interface UiProject {
  id: string;
  name: string;
  path: string;
  current: boolean;
  problem: Problem | null;
  /** The project's factory.json, as read (null when it has none). */
  config: Config | null;
}

export interface Channel {
  id: string;
  kind: "agent" | "view";
  name: string;
  title: string;
  role?: string;
  /** The owner's image for this agent (#437), as a data address; without one the page draws the agent's own. */
  avatar?: string;
}

export interface Agent {
  name: string;
  role: string;
  state: string;
  detail: string;
  task: string | null;
  taskTitle: string | null;
  on: string | null;
  machine: string | null;
  machineName: string | null;
  here: boolean;
  runs: string;
  session: string | null;
  since: string | null;
  lastSeen: string | null;
  log: string[];
}

export interface Machine {
  id: string;
  name: string;
  here: boolean;
  agents: { name: string; role: string; state: string; detail: string }[];
}

export interface Runner {
  name: string;
  state: "busy" | "idle" | "offline";
}

export interface Limit {
  reset: number;
  message: string;
}

export interface Live {
  agents: Agent[];
  machines: Machine[];
  runners: Runner[];
  limit: Limit | null;
  problems: Problem[];
}

/** The views every project has, in the sidebar's order. The owner queue fills in with #423, tasks, pull requests and CI with #424. */
export const VIEWS: Channel[] = [
  { id: "view:tasks", kind: "view", name: "tasks", title: "Tasks" },
  { id: "view:pull-requests", kind: "view", name: "pull-requests", title: "Pull requests" },
  { id: "view:ci", kind: "view", name: "ci", title: "CI" },
  { id: "view:owner-queue", kind: "view", name: "owner-queue", title: "Owner queue" },
  { id: "view:machines", kind: "view", name: "machines", title: "Machines" },
];

const ROLE_ORDER = ["dev-manager", "product-owner", "coding-agent"];

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : v === null || v === undefined ? null : String(v);
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

// --- projects ----------------------------------------------------------------------------------------------------------

/** The project's factory.json, with the defaults for the agents' names (the roles fall back to theirs on their own). */
function configAt(path: string): Config | null {
  const raw = readJson(join(path, ".claude", "factory.json"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const cfg = raw as Config;
  return Array.isArray(cfg.agents) ? cfg : { ...cfg, agents: DEFAULTS.agents };
}

/** The `ui.projects` setting: the paths it lists. */
export function uiSetting(cfg: Config, key: "projects" | "port" | "pollSeconds"): unknown {
  return obj(cfg.ui)[key];
}

/** This project (at `root`, its settings `cfg`) and each project in `ui.projects`, each with an id unique among them. */
export function projects(cfg: Config, root: string): UiProject[] {
  const listed = uiSetting(cfg, "projects");
  const paths = Array.isArray(listed) ? listed.filter((p): p is string => typeof p === "string" && p.trim() !== "") : [];
  const out: UiProject[] = [];
  const taken = new Set<string>();
  const add = (path: string, current: boolean, config: Config | null, problem: Problem | null): void => {
    const name = repoName(path);
    let id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "project";
    for (let n = 2; taken.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    taken.add(id);
    out.push({ id, name, path, current, problem, config });
  };
  add(root, true, cfg, null);
  for (const given of paths) {
    const path = resolve(root, given.replace(/^~(?=\/|$)/, homedir()));
    if (realpathOr(path) === realpathOr(root)) continue;
    if (!existsSync(path)) {
      add(path, false, null, { code: "ui_project_missing", message: `${path} isn't there.`,
        fix: `Fix the path in ui.projects (factory settings set ui.projects '[...]'), or clone the project there.` });
      continue;
    }
    const config = configAt(path);
    add(path, false, config, config ? null : { code: "ui_project_not_factory", message: `${path} has no .claude/factory.json, so it doesn't run the factory.`,
      fix: `Install the factory there (install.sh), or take it out of ui.projects.` });
  }
  return out;
}

/** The repository's name, as factory_machine.ts's repoKey() has it: the folder holding its git common dir, so a worktree
 * is named after its repository. A path that isn't a repository: its folder's name. */
function repoName(path: string): string {
  const g = existsSync(path) ? run(["git", "-C", path, "rev-parse", "--git-common-dir"]) : null;
  if (!g || g.code !== 0 || !g.stdout.trim()) return basename(path) || path;
  return basename(dirname(resolve(path, g.stdout.trim())));
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// --- channels ----------------------------------------------------------------------------------------------------------

function roleOfKind(kind: string): string {
  const k = kind.replace(/ /g, "-");
  return ROLE_ORDER.includes(k) ? k : "coding-agent";
}

/** One channel per agent (the dev manager's and the product owner's first names, every coding agent, and any other name
 * `seen` reports), then one per view. */
export function channels(p: UiProject, seen: Agent[] = []): Channel[] {
  const cfg = p.config;
  const agents = new Map<string, string>();
  if (cfg) {
    for (const role of ["dev-manager", "product-owner"]) {
      const first = roleNames(cfg, role)[0];
      if (first) agents.set(first, role);
    }
    for (const name of roleNames(cfg, "coding-agent")) if (name && !agents.has(name)) agents.set(name, "coding-agent");
  }
  for (const a of seen) if (!agents.has(a.name)) agents.set(a.name, a.role);
  const list: Channel[] = [...agents].map(([name, role]) => {
    const avatar = ownAvatar(p, name);
    return { id: `agent:${name}`, kind: "agent", name, title: name, role, ...(avatar ? { avatar } : {}) };
  });
  list.sort((a, b) => ROLE_ORDER.indexOf(a.role ?? "") - ROLE_ORDER.indexOf(b.role ?? "") || a.name.localeCompare(b.name));
  return [...list, ...VIEWS];
}

/** The image types an owner's avatar can be, by extension (any case). */
const AVATAR_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  svg: "image/svg+xml" };
const AVATAR_MAX_BYTES = 256 * 1024;

/** The owner's image for agent `name` (#437): the first .claude/factory/avatars/<name>.<png|jpg|jpeg|webp|gif|svg> of at
 * most 256 KB, as a data address; null without one. A name that isn't a plain file name (a heartbeat can report any) is
 * never read. The page shows an image only in an <img>, so an SVG's scripts never run. */
function ownAvatar(p: UiProject, name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  const dir = join(p.path, ".claude", "factory", "avatars");
  let files: string[];
  try {
    files = readdirSync(dir).sort();
  } catch {
    return null;
  }
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    const type = AVATAR_TYPES[f.slice(dot + 1).toLowerCase()];
    if (dot <= 0 || f.slice(0, dot) !== name || !type) continue;
    try {
      const path = join(dir, f);
      const st = lstatSync(path); // a link is not followed: only a file in the folder itself is sent
      if (!st.isFile() || st.size > AVATAR_MAX_BYTES) continue;
      return `data:${type};base64,${readFileSync(path).toString("base64")}`;
    } catch {
      continue;
    }
  }
  return null;
}

/** The role of `name` in project `p`: its channel's, else null when it isn't one of the project's agents. */
export function roleOf(p: UiProject, name: string, seen: Agent[] = []): string | null {
  return channels(p, seen).find((c) => c.kind === "agent" && c.name === name)?.role ?? null;
}

// --- live state --------------------------------------------------------------------------------------------------------

/** The hooks folder that reads project `p`: its own for a project in `ui.projects` that has one, else this one. */
export function hooksOf(p: UiProject): string {
  const own = join(p.path, ".claude", "hooks");
  return !p.current && existsSync(join(own, "factory_agents.ts")) ? own : HOOKS;
}

/** The environment a project's commands run in: this one, minus what would point them at another project. */
export function envFor(p: UiProject): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "FACTORY_ROLE"]) delete env[k];
  env.CLAUDE_PROJECT_DIR = p.path;
  return env;
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export async function spawn(cmd: string[], cwd: string, env: Record<string, string>, ms: number): Promise<Ran> {
  try {
    const proc = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), ms);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** This project's state folder: `$XDG_STATE_HOME/<repo>-factory` (factory_machine.ts), worked out for its path. */
export function stateDirOf(p: UiProject): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, `${repoName(p.path)}-factory`);
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

function lastLines(text: string): string[] {
  return text.replace(ANSI, "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "").slice(-LOG_LINES);
}

/** The last lines an agent on this machine printed: its log file (a loop outside tmux), else its tmux pane. */
async function logOf(row: Obj): Promise<string[]> {
  const file = str(row.log);
  if (file && existsSync(file)) {
    try {
      const text = readFileSync(file, "utf8");
      return lastLines(text.slice(-20_000));
    } catch {
      return [];
    }
  }
  const session = str(row.session);
  if (!session || str(row.state) === "down" || !Bun.which("tmux")) return [];
  const r = await spawn(["tmux", "capture-pane", "-p", "-J", "-t", session, "-S", "-60"], "/", { ...process.env } as Record<string, string>, 5_000);
  return r.code === 0 ? lastLines(r.stdout) : [];
}

function taskTitles(cache: Obj): Map<string, string> {
  const titles = new Map<string, string>();
  for (const t of Array.isArray(obj(cache.tasks).tasks) ? (obj(cache.tasks).tasks as unknown[]).map(obj) : []) {
    if (t.id !== undefined && typeof t.title === "string") titles.set(String(t.id), t.title);
  }
  return titles;
}

function runnersOf(cache: Obj): Runner[] {
  const ci = obj(cache.ci);
  const all = [...(Array.isArray(ci.runners) ? ci.runners : []), ...(Array.isArray(obj(ci.light).runners) ? (obj(ci.light).runners as unknown[]) : [])];
  return all.map(obj).filter((r) => str(r.name)).map((r) => ({ name: str(r.name),
    state: str(r.status) !== "online" ? "offline" : r.busy ? "busy" : "idle" }));
}

/** GitHub's hourly limit while it is used up (from the limit file or the cockpit's cache), else null. */
function limitOf(state: string, cache: Obj, now: number): Limit | null {
  const kept = obj(obj(readJson(join(state, "github-rate.json"))).core);
  const cached = obj(cache.limit);
  for (const c of [kept, cached]) {
    const reset = c.reset;
    const remaining = typeof c.remaining === "number" ? c.remaining : 0;
    if (typeof reset === "number" && reset > now && remaining <= 0) {
      return { reset, message: limitSentence({ limit: Number(c.limit) || 5000, remaining, reset }, now) };
    }
  }
  return null;
}

function machinesOf(agents: Agent[], here: string | null): Machine[] {
  const by = new Map<string, Machine>();
  for (const a of agents) {
    const id = a.machine ?? (a.here ? here ?? "this-machine" : "unknown");
    const m = by.get(id) ?? { id, name: a.machineName ?? id, here: a.here || (here !== null && id === here), agents: [] };
    if (m.name === id && a.machineName) m.name = a.machineName; // a row from GitHub may carry only the id
    m.here ||= a.here;
    m.agents.push({ name: a.name, role: a.role, state: a.state, detail: a.detail });
    by.set(id, m);
  }
  return [...by.values()].sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name));
}

/** Everything live about project `p`: its agents (with their last lines of output when on this machine), its machines,
 * the CI runners, GitHub's limit, and what couldn't be read. */
export async function live(p: UiProject): Promise<Live> {
  if (p.problem) return { agents: [], machines: [], runners: [], limit: null, problems: [p.problem] };
  const problems: Problem[] = [];
  const r = await spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(hooksOf(p), "factory_agents.ts"), "ls", "--json"],
    p.path, envFor(p), READ_TIMEOUT_MS);
  let data: Obj = {};
  try {
    data = obj(JSON.parse(r.stdout) as unknown);
  } catch {
    // said below
  }
  if (!Array.isArray(data.agents)) {
    const last = (r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? "";
    problems.push({ code: "ui_agents_unreadable", message: `The agents of ${p.name} can't be read (${last.slice(0, 200) || `exit ${r.code}`}).`,
      fix: `Run \`factory agents ls\` in ${p.path} to see the whole error.` });
  }
  const github = obj(data.github);
  if (github.ok === false) {
    problems.push({ code: "ui_github_unreadable", message: `The other machines' agents can't be read from GitHub (${str(github.error).slice(0, 200)}).`,
      fix: "Run `gh auth status` (and `gh auth login` if it says so)." });
  }
  const state = stateDirOf(p);
  const cache = obj(readJson(join(state, "cockpit.json")));
  const titles = taskTitles(cache);
  const rows = (Array.isArray(data.agents) ? data.agents : []).map(obj).filter((a) => str(a.name));
  const agents: Agent[] = await Promise.all(rows.map(async (a): Promise<Agent> => {
    const here = a.source === "local";
    const task = strOrNull(a.task);
    return { name: str(a.name), role: roleOf(p, str(a.name)) ?? roleOfKind(str(a.kind)), state: str(a.state) || "unknown",
      detail: str(a.detail) || str(a.state), task, taskTitle: task ? titles.get(task) ?? null : null, on: strOrNull(a.on),
      machine: strOrNull(a.machine), machineName: strOrNull(a.machineName), here, runs: str(a.runs), session: strOrNull(a.session),
      since: strOrNull(a.since), lastSeen: strOrNull(a.lastSeen), log: here ? await logOf(a) : [] };
  }));
  const now = Date.now() / 1000;
  return { agents, machines: machinesOf(agents, strOrNull(data.machine)), runners: runnersOf(cache), limit: limitOf(state, cache, now), problems };
}

// --- the owner's actions -----------------------------------------------------------------------------------------------

export interface ActionResult {
  status: number;
  body: Obj;
}

/** The factory script of project `p`: for this project the one that started `factory ui` (FACTORY_SELF), else its own. */
export function factoryScript(p: UiProject): string {
  const self = process.env.FACTORY_SELF;
  return p.current && self && existsSync(self) ? self : join(p.path, "factory");
}

/** Runs `factory owner <args>` in project `p` and says how it went: 200 with its output, or 500 with its error. */
export async function owner(p: UiProject, args: string[]): Promise<ActionResult> {
  const command = `factory owner ${args.join(" ")}`;
  const r = await spawn(["bash", factoryScript(p), "owner", ...args], p.path, envFor(p), ACTION_TIMEOUT_MS);
  return resultOf(p, command, r, (r.stdout + r.stderr).trim());
}

/** How `command` (run in project `p`, giving `r`) went: 200 with `output`, or 500 with its own {code, message, fix} when
 * its last line on stderr is one, else one that says how to see the whole error. */
export function resultOf(p: UiProject, command: string, r: Ran, output: string): ActionResult {
  if (r.code === 0) return { status: 200, body: { ok: true, command, output } };
  const last = r.stderr.trim().split("\n").at(-1) ?? "";
  let own: Obj = {};
  try {
    own = obj(JSON.parse(last) as unknown);
  } catch {
    // not one of ours
  }
  if (typeof own.code === "string" && typeof own.message === "string" && typeof own.fix === "string") {
    return { status: 500, body: { ok: false, command, code: own.code, message: own.message, fix: own.fix, output } };
  }
  return { status: 500, body: { ok: false, command, code: "ui_command_failed", message: `\`${command}\` failed (${(last || `exit ${r.code}`).slice(0, 200)}).`,
    fix: `Run \`${command}\` in ${p.path} to see the whole error.`, output } };
}
