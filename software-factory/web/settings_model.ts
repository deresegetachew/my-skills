// The Factory settings pages' rules (#456, design docs/design/web-ui/Settings.dc.html, Releases.dc.html and
// Maintenance.dc.html) that aren't drawing: where a value comes from and a value in words, an agent's name checked, the
// free legend names, search, and the confirms for adding and removing an agent, proposing the staged changes, updating
// and each clean-up, each with its preconditions and what will and won't happen. No command is shown on screen (the
// owner's rule), so none is written here. No React here, so tests/web_ui_settings_model.test.ts runs it as it is.
import type { Check, ConfirmSpec } from "./parts_model.ts";

export type Staged = { value: unknown } | { unset: true };

/** One setting as GET /api/projects/:p/settings sends it. */
export interface SettingRow {
  key: string;
  name: string;
  help: string;
  kind: string;
  options: string[] | null;
  value: unknown;
  default: unknown;
  from: "main" | "default" | "staged" | "machine";
  staged: Staged | null;
  needs: string;
  main: boolean;
}

export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A value in words: on and off, a list joined, empty text said. */
export function valueText(v: unknown): string {
  if (v === true) return "On";
  if (v === false) return "Off";
  if (v === null || v === undefined) return "Not set";
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ") : "None";
  if (typeof v === "string") return v === "" ? "Empty" : v;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/** Where a value comes from, as the design says it. */
export function fromText(r: { from: string; staged: Staged | null; value: unknown }): string {
  if (r.from === "staged" && r.staged) return "value" in r.staged ? `Staged, was ${valueText(r.value)}` : "Staged: back to the default";
  if (r.from === "main") return "From main";
  if (r.from === "machine") return "This machine only";
  return "Default";
}

/** The kind of field a setting is edited in. */
export function fieldOf(kind: string): "text" | "number" | "toggle" | "choice" | "json" {
  if (kind === "int") return "number";
  if (kind === "bool") return "toggle";
  if (kind === "enum") return "choice";
  if (kind === "list" || kind === "dict") return "json";
  return "text";
}

/** What a field holds, as the text the setting takes. */
export function rawOf(kind: string, input: unknown): string {
  if (kind === "bool") return input === true || input === "true" ? "true" : "false";
  return typeof input === "string" ? input : JSON.stringify(input);
}

/** The field's first text for a value. */
export function inputOf(kind: string, value: unknown): string {
  if (kind === "list" || kind === "dict") return JSON.stringify(value ?? (kind === "list" ? [] : {}));
  if (kind === "bool") return value === true ? "true" : "false";
  return value === null || value === undefined ? "" : String(value);
}

/** Why `name` can't be an agent's name, or null when it can. */
export function nameProblem(name: string, taken: string[]): string | null {
  if (!name) return "Type a name, or pick a free one.";
  if (!AGENT_NAME.test(name)) return "Use lowercase letters, digits and dashes, starting with a letter or digit, at most 40 characters.";
  if (taken.includes(name)) return `${name} is already on the team.`;
  return null;
}

/** The legend names no agent uses yet, in their order. */
export function freeNames(legends: string[], taken: string[]): string[] {
  return legends.filter((n) => !taken.includes(n));
}

/** The settings whose name, help or key has every word of `q`. */
export function searchSettings<T extends { key: string; name: string; help: string }>(rows: T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const text = `${r.key} ${r.name} ${r.help}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Which agents run on this machine, and where that comes from. */
export function machineAgentsText(m: { agents: string[]; from: string }): string {
  if (m.from === "env") return `${m.agents.join(", ")}, set by this terminal's environment when the web UI started`;
  if (m.from === "machine") return `${m.agents.join(", ")}, saved for this machine`;
  return "Every agent of the project (none chosen for this machine)";
}

/** "3 changes staged". */
export function stagedText(n: number): string {
  return `${n} change${n === 1 ? "" : "s"} staged`;
}

const AFTER_MERGE = "Propose the staged changes as one pull request; once you merge it here, this machine's checkout is brought up to date " +
  "(when it is on main with nothing uncommitted; else This machine says what to do), and ";

/** This machine's checkout against main on GitHub, as GET /api/projects/:p/settings/checkout sends it (#566). */
export interface CheckoutFacts {
  path: string;
  main: string;
  branch: string | null;
  behind: number | null;
  ahead: number | null;
  changed: string[];
  onMain: boolean;
  clean: boolean;
  canUpdate: boolean;
  problem: { code: string; message: string; fix: string } | null;
}

const commits = (n: number): string => `${n} commit${n === 1 ? "" : "s"}`;

/** How far the checkout is from main: "2 commits behind main", "Up to date with main", "Unknown". */
export function checkoutText(c: CheckoutFacts): string {
  if (c.behind === null) return "Unknown";
  return c.behind === 0 ? `Up to date with ${c.main}` : `${commits(c.behind)} behind ${c.main}`;
}

/** What only a look at the checkout can say (it isn't one of the preconditions below). */
const OWN_CHECKS = ["checkout_not_on_main", "checkout_dirty", "checkout_diverged"];

/** Bring this machine up to date: the checkout moves forward to main, only when that is safe. */
export function syncAsk(c: CheckoutFacts): ConfirmSpec {
  const main = c.main;
  const n = c.behind ?? 0;
  const odd = c.problem && !OWN_CHECKS.includes(c.problem.code) ? c.problem : null;
  const checks: Check[] = odd
    ? [{ title: odd.code === "checkout_agent_worktree" ? "It is the project's own folder, not an agent's" : `${main[0]?.toUpperCase()}${main.slice(1)} can be read from GitHub`,
      met: false, sub: `${odd.message} ${odd.fix}` }]
    : [
      { title: `It is on ${main}`, met: c.onMain,
        ...(c.onMain ? {} : { sub: `It is on ${c.branch ?? "a commit of its own"}: an agent may be working there. Wait until ${main} is checked out there again.` }) },
      { title: "It has no uncommitted changes", met: c.clean,
        ...(c.clean ? {} : { sub: `Changed: ${c.changed.join(", ") || "unknown"}. Commit them on a branch or put them aside first.` }) },
      { title: `It has nothing ${main} on GitHub lacks`, met: c.ahead === 0,
        ...(c.ahead === 0 ? {} : { sub: `It has ${commits(c.ahead ?? 0)} of its own: put them in a pull request, or drop them, first.` }) },
      { title: `${main[0]?.toUpperCase()}${main.slice(1)} on GitHub has something new`, met: n > 0, ...(n > 0 ? {} : { sub: "This machine is up to date already." }) },
    ];
  return {
    title: "Bring this machine up to date?",
    checks,
    happens: `Your checkout at ${c.path} moves forward to ${main} as GitHub has it (${commits(n)}). What was merged, such as a new agent or a ` +
      "changed setting, applies on this machine from then on.",
    doesNot: "Nothing is committed or pushed, no branch or uncommitted change is touched, and the agents' own worktrees aren't changed: " +
      "their loops bring themselves up to date.",
    action: "Bring this machine up to date",
    tone: "primary",
  };
}

/** Where a new agent will run (#581): "here", another machine's name, or "later"; its label as the page shows it, and
 * whether this machine runs a list of its own (else it runs every agent). */
export interface AddWhere {
  machine: string;
  label: string;
  ownList: boolean;
}

function whereWords(name: string, w: AddWhere | undefined): { happens: string; doesNot: string } {
  if (!w || w.machine === "later") return { happens: "", doesNot: "" };
  if (w.machine === "here") {
    return { happens: w.ownList ? ` It is kept for ${w.label} and joins the agents that run there once the change is merged and on this machine.`
      : ` ${w.label} runs every agent of the project, so ${name} runs there once the change is merged.`, doesNot: "" };
  }
  return { happens: ` It is meant for ${w.label}: choose it there, on that machine's Team page, once the change is merged.`,
    doesNot: ` Nothing is saved on this machine for ${name}.` };
}

/** Adding an agent: it is staged, nothing starts. */
export function addAgentAsk(name: string, where?: AddWhere): ConfirmSpec {
  const w = whereWords(name, where);
  return {
    title: `Add ${name} to the team?`,
    checks: [],
    happens: `${name} is added to the coding agents as a staged change. ${AFTER_MERGE}${name} shows in Your team and you can start it from its page.${w.happens}`,
    doesNot: `Nothing starts now, no other setting changes, and nothing on GitHub changes until you propose it.${w.doesNot}`,
    action: `Stage ${name}`,
    tone: "primary",
  };
}

export interface RemoveFacts {
  name: string;
  role: string;
  /** It runs now (any machine). */
  running: boolean;
  /** It runs on the machine that serves the page, so it can be stopped from here. */
  here: boolean;
  machineName: string | null;
  task: string | null;
  /** Its Stop or Release button ran and the page is reading the agent again until that shows (#589). */
  checking?: Fixing | null;
}

/** What a precondition's own button did: stopped the agent, or released its task. */
export type Fixing = "stop" | "release";

/** An agent as it runs now: the shell's live state, or GET /api/projects/:p/agents/:name's `agent`. */
export interface LiveAgent {
  name: string;
  state: string;
  task: string | null;
  here: boolean;
  machineName: string | null;
}

const CHECKING = "Checking…";

/** The remove dialog's facts from the live push and the agent read again after a fix (#589): whichever shows a
 * precondition met wins, since each fix only ever moves it that way. */
export function removeFactsOf(role: string, live: LiveAgent | undefined, fresh: LiveAgent | null): RemoveFacts {
  const a = fresh ?? live;
  const runs = (x: LiveAgent | undefined): boolean => !!x && x.state !== "down";
  const running = runs(live) && (fresh === null || runs(fresh));
  const liveTask = live?.task ?? null;
  const task = fresh === null ? liveTask : liveTask && fresh.task ? fresh.task : null;
  return { name: a?.name ?? "", role, running, here: a?.here ?? false, machineName: a?.machineName ?? null, task };
}

/** The agent out of what GET /api/projects/:p/agents/:name answered: the agent; down when it isn't reported any more;
 * null when the read failed, so the next one tries again. */
export function agentOfAnswer(name: string, body: unknown): LiveAgent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { agent?: unknown; code?: unknown };
  if (b.code === "ui_agent_unknown") return { name, state: "down", task: null, here: true, machineName: null };
  const a = b.agent;
  if (typeof a !== "object" || a === null) return null;
  const x = a as Record<string, unknown>;
  if (typeof x.state !== "string") return null;
  return { name: typeof x.name === "string" ? x.name : name, state: x.state, task: typeof x.task === "string" ? x.task : null,
    here: x.here === true, machineName: typeof x.machineName === "string" ? x.machineName : null };
}

/** Whether a fix shows on the agent: stopped, or its task released. */
export function fixShows(done: Fixing, a: LiveAgent): boolean {
  return done === "stop" ? a.state === "down" : !a.task;
}

/** After a precondition's own button ran (#589): read the agent every `everyMs` (2 s) for at most `forMs` (30 s), each
 * read shown at once through `seen`, until the fix shows, the dialog closes (`gone`) or the time is up. The live push
 * keeps working beside it. Gives the last read (null when none could be made). */
export async function recheckAgent(o: { read: () => Promise<LiveAgent | null>; done: Fixing; seen: (a: LiveAgent) => void;
  sleep?: (ms: number) => Promise<void>; gone?: () => boolean; everyMs?: number; forMs?: number }): Promise<LiveAgent | null> {
  const every = o.everyMs ?? 2000;
  const limit = o.forMs ?? 30_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: LiveAgent | null = null;
  for (let waited = 0; ; waited += every) {
    const a = await o.read().catch(() => null);
    if (o.gone?.()) return last;
    if (a) {
      last = a;
      o.seen(a);
      if (fixShows(o.done, a)) return a;
    }
    if (waited + every > limit) return last;
    await sleep(every);
    if (o.gone?.()) return last;
  }
}

/** Removing an agent: stopped first, its task released first; then it leaves the team in a staged change. */
/** What remove and rename both need first, each with its own button: it isn't running, and it holds no task. */
export function idleChecks(a: RemoveFacts): Check[] {
  const stopHere = a.running && a.here;
  const wait = (f: Fixing): { waiting: string } | null => (a.checking === f ? { waiting: CHECKING } : null);
  return [
    { title: `${a.name} isn't running`, met: !a.running,
      ...(a.running ? { sub: a.here ? "Stop it first; its session ends and its work is kept." : `It runs on ${a.machineName ?? "another machine"}: stop it from a page served there.` } : {}),
      ...(stopHere ? wait("stop") ?? { fix: `Stop ${a.name}` } : {}) },
    { title: `${a.name} holds no task`, met: !a.task,
      ...(a.task ? { sub: `Release its work first: #${a.task} goes back to Ready for another agent.`, ...(wait("release") ?? { fix: `Release #${a.task}` }) } : {}) },
  ];
}

export function removeAgentAsk(a: RemoveFacts): ConfirmSpec {
  return {
    title: `Remove ${a.name} from the team?`,
    checks: idleChecks(a),
    happens: `${a.name} leaves the team as a staged change. ${AFTER_MERGE}it is gone from Your team.`,
    doesNot: `${a.name}'s branches, pull requests, messages and finished tasks are kept, and nothing on GitHub changes until you propose it.`,
    action: `Remove ${a.name}`,
    tone: "danger",
    typeName: a.name,
  };
}

/** Proposing the staged changes as one pull request. */
export function proposeAsk(n: number): ConfirmSpec {
  return {
    title: `Propose ${n} change${n === 1 ? "" : "s"}?`,
    checks: [{ title: "Something is staged", met: n > 0, ...(n > 0 ? {} : { sub: "Stage a change first." }) }],
    happens: "The staged changes go out as one pull request against main, built on main as GitHub has it now. You merge it; until then nothing changes.",
    doesNot: "Your checkout, the running agents and this machine's settings aren't touched. The agents can't merge it: it changes their own rules.",
    action: "Propose as a pull request",
    tone: "primary",
  };
}

export interface ReleaseFacts {
  installed: string | null;
  newest: string | null;
  newer: boolean;
  pinned: string | null;
  dirty: boolean;
  /** The agents working on this machine now. */
  working: string[];
}

/** Updating the factory in this project: on releases, a newer one exists, a clean checkout, no agent at work here. */
export function updateAsk(r: ReleaseFacts): ConfirmSpec {
  return {
    title: r.newest ? `Update to ${r.newest}?` : "Update the factory?",
    checks: [
      { title: "This project takes the factory from releases", met: r.pinned !== null,
        ...(r.pinned ? {} : { sub: "It runs the factory from its own source or a submodule, so there is nothing to update here." }) },
      { title: "A newer release exists", met: r.newer, ...(r.newer ? {} : { sub: `${r.installed ?? "This project"} is the newest.` }) },
      { title: "The checkout has no uncommitted changes", met: !r.dirty,
        ...(r.dirty ? { sub: "Commit or put them aside first: the update refuses a checkout with changes." } : {}) },
      { title: "No agent is working on this machine", met: !r.working.length,
        ...(r.working.length ? { sub: `Working now: ${r.working.join(", ")}. Stop them first, or wait until they are idle.` } : {}) },
    ],
    happens: `The release is downloaded, its checksum checked and its files installed in this checkout; this machine's CI runners are refreshed and the install checked. The new files are left for a pull request that pins ${r.newest ?? "the release"}.`,
    doesNot: "Nothing is published, no tag is pushed, nothing is committed to main, and other machines keep their version until they pull.",
    action: r.newest ? `Update to ${r.newest}` : "Update",
    tone: "primary",
  };
}

export interface Cleanup {
  id: string;
  title: string;
  /** What it will touch. */
  will: string;
  /** What it won't. */
  wont: string;
  /** It can list what it would do first. */
  preview: boolean;
  action: string;
}

/** The clean-ups the factory already has. */
export const MAINTENANCE: Cleanup[] = [
  { id: "clean", title: "Old worktrees and branches",
    will: "Removes the agents' worktrees no agent is using and that hold no uncommitted work, and the local task branches whose task is done.",
    wont: "A worktree in use or with uncommitted work is kept, and branches on GitHub and pull requests aren't touched.",
    preview: false, action: "Clean up" },
  { id: "ci-clean", title: "CI runners and containers",
    will: "Removes this project's offline idle CI runners and its exited CI containers.",
    wont: "Running jobs, other projects' runners and containers, and where CI jobs run are left as they are.",
    preview: true, action: "Remove" },
  { id: "reset-run", title: "Left from an earlier run",
    will: "Clears what an earlier run left in this project: stale claims on this machine, agent issues of agents that never ran or died, exited CI containers and offline runners.",
    wont: "Only this project is touched; a down agent of another machine, open pull requests and branches are kept.",
    preview: true, action: "Clean" },
];

/** The confirm for a clean-up: what it will and won't touch. */
export function maintenanceAsk(c: Cleanup): ConfirmSpec {
  return { title: `${c.title}: clean up?`, checks: [], happens: c.will, doesNot: c.wont, action: c.action, tone: "danger" };
}
