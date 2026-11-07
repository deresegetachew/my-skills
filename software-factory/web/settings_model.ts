// The Factory settings pages' rules (#456, design docs/design/web-ui/Settings.dc.html, Releases.dc.html and
// Maintenance.dc.html) that aren't drawing: where a value comes from and a value in words, an agent's name checked, the
// free legend names, search, and the confirms for adding and removing an agent, proposing the staged changes, updating
// and each clean-up, each with its preconditions and what will and won't happen. No command is shown on screen (the
// owner's rule), so none is written here. No React here, so tests/web_ui_settings_model.test.ts runs it as it is.
import type { ConfirmSpec } from "./parts_model.ts";

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

const AFTER_MERGE = "Propose the staged changes as one pull request; once you merge it and this machine has pulled main, ";

/** Adding an agent: it is staged, nothing starts. */
export function addAgentAsk(name: string): ConfirmSpec {
  return {
    title: `Add ${name} to the team?`,
    checks: [],
    happens: `${name} is added to the coding agents as a staged change. ${AFTER_MERGE}${name} shows in Your team and you can start it from its page.`,
    doesNot: "Nothing starts now, no other setting changes, and nothing on GitHub changes until you propose it.",
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
}

/** Removing an agent: stopped first, its task released first; then it leaves the team in a staged change. */
export function removeAgentAsk(a: RemoveFacts): ConfirmSpec {
  const stopHere = a.running && a.here;
  return {
    title: `Remove ${a.name} from the team?`,
    checks: [
      { title: `${a.name} isn't running`, met: !a.running,
        ...(a.running ? { sub: a.here ? "Stop it first; its session ends and its work is kept." : `It runs on ${a.machineName ?? "another machine"}: stop it from a page served there.` } : {}),
        ...(stopHere ? { fix: `Stop ${a.name}` } : {}) },
      { title: `${a.name} holds no task`, met: !a.task,
        ...(a.task ? { sub: `It holds #${a.task}. Releasing it puts the task back to Ready for another agent.`, fix: `Release #${a.task}` } : {}) },
    ],
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
