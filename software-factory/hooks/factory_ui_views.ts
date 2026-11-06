// The web UI's tasks, pull requests and CI channels (#424): what each shows, read from the project's snapshot cache
// (`snapshot.json`, what `factory snapshot` writes), so a read here never calls GitHub; the CI view's actions (#396),
// each running its factory commands; and a read again that runs `factory snapshot`.
// factory_ui_server.ts routes to it and sends what changed over the WebSocket.
//
//   GET  /api/projects/:p/tasks                 the tasks in build order (the order `factory next` walks), and the next one
//   GET  /api/projects/:p/pull-requests         each open pull request: checks, review, protected files, agent, task
//   GET  /api/projects/:p/ci                    the verdict first, then the runs, the runners and the actions
//   POST /api/projects/:p/ci/actions/:name      {confirm: true[, run: <id>]}: that action's commands (log needs no confirm)
//   POST /api/projects/:p/refresh               runs `factory snapshot` in the background (202)
//
// Each row carries `find`: the text the search within a view and across views matches (#392, factory_match.ts).
// While a page looks at a project, its cache is read again when older than FACTORY_SNAPSHOT_CACHE_SECONDS (300 s),
// never while GitHub's hourly limit is still used up.
import { hostname } from "node:os";
import { join } from "node:path";
import { config as ciConfig, runnerSetting, sourceText } from "../ci/ci_names.ts";
import { branchTask, toFloat } from "./factory_config.ts";
import { CI_ACTIONS, type CiActionName, ciActionOf, type CiSettingsSeen, ciVerdict, FAILED, machineOf, orderedRuns,
  waitingPulls } from "./factory_ci_view.ts";
import { prText, taskStateText, taskText } from "./factory_match.ts";
import { run } from "./factory_lib.ts";
import { type ActionResult, envFor, factoryScript, type Obj, type Problem, readJson, resultOf, spawn, stateDirOf,
  type UiProject } from "./factory_ui_data.ts";

const CI_ACTION_TIMEOUT_MS = 600_000; // an install pulls images and registers runners
const REFRESH_TIMEOUT_MS = 300_000;

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// --- the shapes the API gives ------------------------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  title: string;
  state: string;
  stateText: string;
  holders: string[];
  group: string;
  todos: { done: number; all: number };
  dependsOn: string[];
  url: string | null;
  pr: { number: number; url: string | null } | null;
  next: boolean;
  find: string;
}

export interface TasksView {
  source: string;
  tasks: TaskRow[];
  next: string | null;
  problems: Problem[];
}

export interface PullView {
  number: number;
  title: string;
  url: string | null;
  branch: string;
  draft: boolean;
  agent: string | null;
  task: string | null;
  checks: { state: string; failing: string[] };
  review: { state: "approved" | "changes-asked" | "watching" | "none"; text: string; claim: string | null };
  protected: boolean | null;
  next: { action: string; text: string };
  rework: string | null;
  find: string;
}

export interface PullsView {
  pulls: PullView[];
  problems: Problem[];
}

export interface RunView {
  id: number | null;
  ref: string;
  branch: string;
  state: string;
  name: string;
  minutesAgo: number;
  failed: boolean;
  url: string | null;
  find: string;
}

export interface RunnerView {
  name: string;
  lane: "heavy" | "light";
  machine: string;
  here: boolean;
  state: "busy" | "idle" | "offline";
  find: string;
}

export interface ActionView {
  name: CiActionName;
  label: string;
  /** The commands it runs, joined by " then "; null when it can't run now (`note` says why). */
  command: string | null;
  does: string | null;
  note: string | null;
  /** It acts on a run: rerun and log. */
  onRun: boolean;
}

export interface CiView {
  verdict: { text: string; tone: string } | null;
  mode: string;
  repo: string;
  label: string;
  runs: RunView[];
  runners: RunnerView[];
  waiting: string[];
  host: string;
  settings: CiSettingsSeen;
  actions: ActionView[];
  problems: Problem[];
}

export interface Views {
  generatedAt: string | null;
  /** Seconds since the cache was written, or null with none. */
  age: number | null;
  refreshing: boolean;
  problems: Problem[];
  tasks: TasksView;
  pulls: PullsView;
  ci: CiView;
}

// --- reading the cache -------------------------------------------------------------------------------------------------

function cacheOf(p: UiProject): Obj | null {
  const c = readJson(join(stateDirOf(p), "snapshot.json"));
  return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Obj) : null;
}

const repos = new Map<string, string>();

/** The project's `owner/name` on GitHub: CI's, else the origin remote's; "" when neither says. */
function repoOf(p: UiProject, ci: Obj): string {
  const given = str(ci.repo);
  if (/^[\w.-]+\/[\w.-]+$/.test(given)) return given;
  const kept = repos.get(p.id);
  if (kept !== undefined) return kept;
  const r = run(["git", "-C", p.path, "remote", "get-url", "origin"]);
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(r?.code === 0 ? r.stdout.trim() : "");
  const repo = m ? (m[1] as string) : "";
  repos.set(p.id, repo);
  return repo;
}

function missingOf(cache: Obj, codes: RegExp): Problem[] {
  return list(cache.missing).filter((m) => codes.test(str(m.code))).map((m) => ({ code: str(m.code), message: str(m.message), fix: str(m.fix) }));
}

function tasksView(p: UiProject, cache: Obj, repo: string, pulls: PullView[]): TasksView {
  const part = obj(cache.tasks);
  const source = str(part.source);
  const problems: Problem[] = [];
  if (str(part.error)) {
    problems.push({ code: "ui_tasks_unreadable", message: `The tasks can't be read (${str(part.error).slice(0, 200)}).`,
      fix: `Run \`factory next\` in ${p.path} to see why.` });
  }
  const rows = list(part.tasks).filter((t) => str(t.id));
  const open = new Set(rows.filter((t) => str(t.state) !== "done").map((t) => str(t.id)));
  const prOf = new Map<string, PullView>();
  for (const pr of pulls) if (pr.task && !prOf.has(pr.task)) prOf.set(pr.task, pr);
  let next: string | null = null;
  const tasks = rows.map((t): TaskRow => {
    const id = str(t.id);
    const holders = (Array.isArray(t.holders) ? t.holders : []).map(str).filter(Boolean);
    const dependsOn = (Array.isArray(t.dependsOn) ? t.dependsOn : []).map(str).filter(Boolean);
    const todos = list(t.todos);
    // `factory next`: the first ready task nobody holds whose dependencies are done
    const isNext = next === null && str(t.state) === "ready" && !holders.length && !dependsOn.some((d) => open.has(d.replace(/^#/, "")));
    if (isNext) next = id;
    const pr = prOf.get(id);
    return { id, title: str(t.title), state: str(t.state), stateText: taskStateText(str(t.state)), holders, group: str(t.group),
      todos: { done: todos.filter((d) => d.done === true).length, all: todos.length }, dependsOn,
      url: source === "issues" && repo && /^\d+$/.test(id) ? `https://github.com/${repo}/issues/${id}` : null,
      pr: pr ? { number: pr.number, url: pr.url } : null, next: isNext, find: taskText(t) };
  });
  return { source, tasks, next, problems };
}

function reviewOf(p: Obj): PullView["review"] {
  const claim = str(obj(p.claim).manager) || null;
  const marker = str(p.review);
  const gate = str(p.gate);
  if (marker === "factory-mustfix" || (marker === "factory-approved" && gate.startsWith("must-fix"))) {
    return { state: "changes-asked", text: "changes asked", claim };
  }
  if (marker === "factory-approved") return { state: "approved", text: "approved", claim };
  if (marker === "pr-watch") return { state: "watching", text: "watched by the dev manager", claim };
  return { state: "none", text: claim ? `being reviewed by ${claim}` : "not reviewed yet", claim };
}

function pullsView(cache: Obj): PullsView {
  const problems = missingOf(cache, /^pulls_/);
  const pulls = list(cache.pulls).filter((x) => typeof x.number === "number").map((x): PullView => {
    const branch = str(x.branch);
    return { number: num(x.number), title: str(x.title), url: str(x.url) || null, branch, draft: x.draft === true,
      agent: str(x.agent) || null, task: branchTask(branch), checks: { state: str(x.ci) || "unknown",
        failing: list(x.notGreen).filter((j) => str(j.state) === "red").map((j) => str(j.name)) },
      review: reviewOf(x), protected: typeof x.protected === "boolean" ? x.protected : null,
      next: { action: str(x.next) || "none", text: str(x.nextText) || str(x.next) || "none" }, rework: str(x.rework) || null,
      find: prText(x) };
  });
  return { pulls, problems };
}

/** This machine's runner settings for project `p`: read for the project `factory ui` runs in (they are this folder's), and
 *  the light lane from any project's factory.json. */
function settingsOf(p: UiProject): CiSettingsSeen {
  const ci = obj(obj(p.config).ci);
  const light = ci.light !== false;
  if (!p.current) return { heavy: null, light };
  try {
    const { raw, source } = runnerSetting(ciConfig());
    return { heavy: { raw: str(raw) || String(raw), source: sourceText(source) }, light };
  } catch {
    return { heavy: null, light };
  }
}

function host(): string {
  return hostname().split(".")[0] || "this machine";
}

const LABELS: Record<CiActionName, string> = { install: "Install runners", "use-local": "Use this machine's runners",
  "use-github": "Use GitHub's runners", "runners-up": "One more heavy runner", "runners-down": "One fewer heavy runner",
  "light-lane": "Light lane", clean: "Clean up", rerun: "Rerun failed jobs", log: "Open the log" };

function commandText(steps: string[][]): string {
  return steps.map((s) => s.join(" ")).join(" then ");
}

function actionsOf(ci: Obj, x: CiSettingsSeen): ActionView[] {
  return CI_ACTIONS.map((name): ActionView => {
    const onRun = name === "rerun" || name === "log";
    if (onRun) return { name, label: LABELS[name], command: null, does: null, note: null, onRun };
    const a = ciActionOf(name, ci, x);
    if (a.kind === "note") return { name, label: LABELS[name], command: null, does: null, note: a.text, onRun };
    return { name, label: name === "light-lane" ? `Turn the light lane ${x.light ? "off" : "on"}` : LABELS[name],
      command: commandText(a.steps), does: a.kind === "ask" ? a.does : null, note: null, onRun };
  });
}

function ciView(p: UiProject, cache: Obj, repo: string): CiView {
  const has = typeof cache.ci === "object" && cache.ci !== null;
  const ci = obj(cache.ci);
  const problems = [...missingOf(cache, /^ci_/), ...list(ci.errors).map((e) => ({ code: str(e.code), message: str(e.message), fix: str(e.fix) }))];
  const here = host();
  const runs = orderedRuns(ci).map((r): RunView => {
    const id = typeof r.id === "number" ? r.id : null;
    const title = `${str(r.name) || "CI"} on ${str(r.branch)}`;
    return { id, ref: str(r.ref), branch: str(r.branch), state: str(r.state), name: str(r.name) || "CI", minutesAgo: num(r.minutesAgo),
      failed: FAILED.includes(str(r.state)), url: id !== null && repo ? `https://github.com/${repo}/actions/runs/${id}` : null,
      find: [title, str(r.state), str(r.ref)].join(" · ") };
  });
  const lane = (rs: Obj[], l: "heavy" | "light") => rs.filter((r) => str(r.name)).map((r): RunnerView => {
    const machine = machineOf(str(r.name), repo);
    const state = str(r.status) !== "online" ? "offline" : r.busy === true ? "busy" : "idle";
    return { name: str(r.name), lane: l, machine, here: machine === here, state, find: `runner ${str(r.name)} · ${str(r.status)} ${machine} ${l}` };
  });
  const runners = [...lane(list(ci.runners), "heavy"), ...lane(list(obj(ci.light).runners), "light")];
  const settings = settingsOf(p);
  const [text, tone] = ciVerdict(ci);
  return { verdict: has ? { text, tone } : null, mode: str(ci.mode), repo, label: str(ci.label), runs, runners,
    waiting: waitingPulls(ci).map((r) => str(r.ref)), host: here, settings, actions: has ? actionsOf(ci, settings) : [], problems };
}

const NO_SNAPSHOT = (p: UiProject): Problem => ({ code: "ui_no_snapshot", message: `${p.name} has no snapshot yet; one is being read.`,
  fix: `Wait a minute, or run \`factory snapshot\` in ${p.path}.` });

/** What the three channels show for project `p`, from its snapshot cache. */
export function viewsOf(p: UiProject, refreshing = false, now = Date.now()): Views {
  if (p.problem) {
    const ci: CiView = { verdict: null, mode: "", repo: "", label: "", runs: [], runners: [], waiting: [], host: host(),
      settings: { heavy: null, light: null }, actions: [], problems: [] };
    return { generatedAt: null, age: null, refreshing: false, problems: [p.problem], tasks: { source: "", tasks: [], next: null, problems: [] },
      pulls: { pulls: [], problems: [] }, ci };
  }
  const cache = cacheOf(p);
  const c = cache ?? {};
  const repo = repoOf(p, obj(c.ci));
  const pulls = pullsView(c);
  const at = Date.parse(str(c.generatedAt));
  const limit = list(c.missing).filter((m) => str(m.code) === "github_limit").map((m) => ({ code: str(m.code), message: str(m.message), fix: str(m.fix) }));
  return { generatedAt: str(c.generatedAt) || null, age: Number.isNaN(at) ? null : Math.max(Math.round((now - at) / 1000), 0), refreshing,
    problems: cache ? limit : [NO_SNAPSHOT(p)], tasks: tasksView(p, c, repo, pulls.pulls), pulls, ci: ciView(p, c, repo) };
}

/** The cache's age limit, in seconds: a read costs a few GitHub calls per open pull request, on the agents' token. */
function ttl(): number {
  return toFloat(process.env.FACTORY_SNAPSHOT_CACHE_SECONDS || 300) ?? 300;
}

/** True when project `p`'s cache is missing or older than the limit, and GitHub's hourly limit isn't still used up. */
export function stale(p: UiProject, now = Date.now()): boolean {
  if (p.problem) return false;
  const cache = cacheOf(p);
  if (!cache) return true;
  const lim = obj(cache.limit);
  if (typeof lim.reset === "number" && lim.reset * 1000 > now && !(typeof lim.remaining === "number" && lim.remaining > 0)) return false;
  const at = Date.parse(str(cache.generatedAt));
  return Number.isNaN(at) || (now - at) / 1000 >= ttl();
}

// --- acting ------------------------------------------------------------------------------------------------------------

/** Runs `steps` in project `p` in order, each under its command line, stopping at the first that fails: a step that
 *  starts with "factory" runs through the project's `factory`, any other (gh) as it is. */
async function runSteps(p: UiProject, steps: string[][], ms: number): Promise<ActionResult> {
  const out: string[] = [];
  const command = commandText(steps);
  let last = { code: 0, stdout: "", stderr: "" };
  for (const s of steps) {
    const cmd = s[0] === "factory" ? ["bash", factoryScript(p), ...s.slice(1)] : s;
    last = await spawn(cmd, p.path, envFor(p), ms);
    out.push(`$ ${s.join(" ")}`, (last.stdout + last.stderr).trimEnd());
    if (last.code !== 0) break;
  }
  return resultOf(p, command, last, out.join("\n").trim());
}

export type Answer = ActionResult;

function refusal(status: number, code: string, message: string, fix: string): Answer {
  return { status, body: { code, message, fix } };
}

/** POST /api/projects/:p/ci/actions/:name with `body`. */
export async function ciAction(p: UiProject, name: string, body: unknown): Promise<Answer> {
  if (!(CI_ACTIONS as readonly string[]).includes(name)) {
    return refusal(404, "ui_action_unknown", `The CI view has no action ${name}.`, `Its actions: ${CI_ACTIONS.join(", ")}.`);
  }
  const b = obj(body);
  const action = name as CiActionName;
  if (action !== "log" && b.confirm !== true) {
    return refusal(400, "confirm_needed", `${LABELS[action]} changes how CI runs, so it needs a confirm.`, 'Send {"confirm": true} (the page asks you first).');
  }
  const ci = obj(cacheOf(p)?.ci);
  const runRow = typeof b.run === "number" ? list(ci.runs).find((r) => r.id === b.run) : undefined;
  const a = ciActionOf(action, ci, settingsOf(p), runRow);
  if (a.kind === "note") return refusal(400, "ui_action_unavailable", a.text, "Read the CI channel again, then pick what it offers.");
  return runSteps(p, a.steps, CI_ACTION_TIMEOUT_MS);
}

/** Runs `factory snapshot` in project `p` (its snapshot, written to its cache), at most one at a time per project. */
export class Refresher {
  private readonly busy = new Map<string, Promise<void>>();
  private readonly started = new Map<string, number>();

  constructor(private readonly changed: (p: UiProject) => void) {}

  running(p: UiProject): boolean {
    return this.busy.has(p.id);
  }

  /** Starts a read unless one runs; `force` (the page's read again) ignores when the last one started. */
  start(p: UiProject, force = false): boolean {
    if (p.problem || this.busy.has(p.id)) return false;
    const last = this.started.get(p.id) ?? 0;
    if (!force && Date.now() - last < ttl() * 1000) return false; // one that failed is not tried again at each tick
    this.started.set(p.id, Date.now());
    const job = spawn(["bash", factoryScript(p), "snapshot"], p.path, envFor(p), REFRESH_TIMEOUT_MS)
      .then(() => undefined).finally(() => {
        this.busy.delete(p.id);
        this.changed(p);
      });
    this.busy.set(p.id, job);
    this.changed(p);
    return true;
  }

  /** Starts a read for `p` when its cache is stale. */
  ifStale(p: UiProject): void {
    if (stale(p)) this.start(p);
  }
}
