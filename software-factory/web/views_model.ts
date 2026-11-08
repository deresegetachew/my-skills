// The rules of the web app's tasks, pull requests and CI channels (#424) that aren't drawing: the API's shapes
// (factory_ui_views.ts), the search within a view and across views (#392: every word typed is in the row's text, in any
// case, factory_match.ts), and the tone of each state. No React here, so tests/web_ui_views_model.test.ts
// runs it as it is.
import { matchesTyped } from "../hooks/factory_match.ts";
import type { Tone } from "./model.ts";

export { matchesTyped };

export interface ProblemView {
  code: string;
  message: string;
  fix: string;
}

export interface TaskRow {
  id: string;
  title: string;
  state: string;
  stateText: string;
  holders: string[];
  /** Who it was handed to (Reassign) while nobody holds it, from the message board (#545); missing or null with nobody. */
  assignee?: string | null;
  group: string;
  todos: { done: number; all: number };
  dependsOn: string[];
  /** The open tasks that block it, from the message board (#498); missing or [] on the GitHub path. */
  blockedBy?: string[];
  url: string | null;
  pr: { number: number; url: string | null; checks?: { state: string; failing: string[] } } | null;
  /** The PRD change it waits for, while that pull request hasn't merged (#578); missing or null with none. */
  prd?: { number: number; url: string | null } | null;
  next: boolean;
  /** What the board offers on it (#439): release, block, reassign. */
  actions?: string[];
  /** The id of the first epic that names this task (#440), or null. */
  epic: string | null;
  cites?: string[]; // the decisions and PRD stories its body cites
  find: string;
}

export interface EpicRow {
  id: string;
  title: string;
  stage: string;
  stageText: string;
  done: number;
  all: number;
  tasks: { id: string; done: boolean }[];
  prd: string;
  decisions: string[];
  summary?: string; // the first plain line of its body
  cites?: string[]; // the decisions and PRD stories its title and body cite
  url: string | null;
  find: string;
}

/** The width of an epic's bar: percent of its tasks done, rounded; 0 for an epic with none. */
export function epicBar(e: { done: number; all: number }): number {
  return e.all > 0 ? Math.round((e.done / e.all) * 100) : 0;
}

/** The tasks under their epics, in the epics' order, then the tasks in none; a group with no task is left out. */
export function groupByEpic(tasks: TaskRow[], epics: EpicRow[]): { epic: EpicRow | null; tasks: TaskRow[] }[] {
  const groups = epics.map((epic) => ({ epic: epic as EpicRow | null, tasks: tasks.filter((t) => t.epic === epic.id) }));
  const known = new Set(epics.map((e) => e.id));
  groups.push({ epic: null, tasks: tasks.filter((t) => t.epic === null || !known.has(t.epic)) });
  return groups.filter((g) => g.tasks.length > 0);
}

export function epicTone(stage: string): Tone {
  if (stage === "building") return "good";
  if (stage === "done") return "quiet";
  if (stage === "parked") return "quiet";
  return "warn";
}

export interface PullRow {
  number: number;
  title: string;
  url: string | null;
  branch: string;
  draft: boolean;
  agent: string | null;
  /** Who opened it (#453): an agent, the product owner, the dev manager or a person. */
  author?: { name: string | null; role: string; text: string };
  /** Its head commit, when the snapshot has it. */
  head?: string | null;
  task: string | null;
  checks: { state: string; failing: string[] };
  review: { state: "approved" | "changes-asked" | "watching" | "none"; text: string; claim: string | null };
  protected: boolean | null;
  next: { action: string; text: string };
  /** It waits for the owner (#453); Home's "Needs you" reads it. */
  needsYou?: boolean;
  rework: string | null;
  cites?: string[]; // the decisions and PRD stories its body cites
  find: string;
}

export interface RunRow {
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

export interface RunnerRow {
  name: string;
  lane: "heavy" | "light";
  machine: string;
  here: boolean;
  state: "busy" | "idle" | "offline";
  find: string;
}

export interface ActionRow {
  name: string;
  label: string;
  command: string | null;
  does: string | null;
  note: string | null;
  onRun: boolean;
}

export interface ViewsData {
  generatedAt: string | null;
  /** Seconds since the snapshot was written, when the server sent this. */
  age: number | null;
  /** When this page got it (ms, this page's clock): the server sends views only when they change, not when `age` grows
   *  (#529), so the page counts the age on from here (ageNow). */
  receivedAt?: number;
  refreshing: boolean;
  problems: ProblemView[];
  /** `done`: the tasks finished in the last days (the message board's, #545), for the Done column. */
  tasks: { source: string; tasks: TaskRow[]; done?: TaskRow[]; next: string | null; problems: ProblemView[] } & Origin;
  epics: { source: string; epics: EpicRow[]; problems: ProblemView[] } & Origin;
  pulls: { pulls: PullRow[]; problems: ProblemView[] };
  ci: {
    verdict: { text: string; tone: string } | null;
    mode: string;
    repo: string;
    label: string;
    runs: RunRow[];
    runners: RunnerRow[];
    waiting: string[];
    host: string;
    settings: { heavy: { raw: string; source: string } | null; light?: boolean | null };
    actions: ActionRow[];
    problems: ProblemView[];
  };
}

/** Where the tasks come from (#498): the message board, live, or GitHub, read every `every` seconds; unknown while the
 *  board is the record and can't be read (#515: one notice says so). Left out by an older server. */
export interface Origin {
  from?: "board" | "github" | "unknown";
  every?: number | null;
}

function everyText(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200 && seconds % 3600 !== 0) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** "From the message board, live", or "From GitHub, read every 5 min"; "" when the server doesn't say. */
/** How old the views are now, in seconds: the age the server sent plus the time since it came (#529); null with none. */
export function ageNow(v: Pick<ViewsData, "age" | "receivedAt">, nowMs: number): number | null {
  if (v.age === null) return null;
  const since = v.receivedAt === undefined ? 0 : Math.max(Math.round((nowMs - v.receivedAt) / 1000), 0);
  return v.age + since;
}

export function originText(o: Origin): string {
  if (o.from === "board") return "From the message board, live";
  if (o.from === "github") return typeof o.every === "number" && o.every > 0 ? `From GitHub, read every ${everyText(o.every)}` : "From GitHub";
  return "";
}

/** The rows whose `find` text holds every word of `typed`; nothing typed keeps them all. */
export function filterRows<T extends { find: string }>(rows: T[], typed: string): T[] {
  return rows.filter((r) => matchesTyped(r.find, typed));
}

/** One row the search across views found: its project, the channel that shows it, and what to filter that channel by. */
export interface RowHit {
  project: string;
  projectName: string;
  channel: "view:tasks" | "view:epics" | "view:pull-requests" | "view:ci";
  view: string;
  title: string;
  detail: string;
  /** What the channel's filter is set to when the hit is opened: the row's own key. */
  find: string;
}

/** The rows of every project's tasks, pull requests and CI that match `query` (each word, any case), at most `most`. An
 * empty query finds nothing. */
export function searchRows(projects: { id: string; name: string }[], views: Record<string, ViewsData | undefined>, query: string,
  most = 30): RowHit[] {
  if (!query.trim()) return [];
  const hits: RowHit[] = [];
  for (const p of projects) {
    const v = views[p.id];
    if (!v) continue;
    const base = { project: p.id, projectName: p.name };
    for (const t of filterRows(v.tasks.tasks, query)) {
      hits.push({ ...base, channel: "view:tasks", view: "Tasks", title: `#${t.id} ${t.title}`,
        detail: [t.stateText, t.holders.join(", ")].filter(Boolean).join(" · "), find: `#${t.id}` });
    }
    for (const e of filterRows(v.epics.epics, query)) {
      hits.push({ ...base, channel: "view:epics", view: "Epics", title: `#${e.id} ${e.title}`, detail: `${e.stageText} · ${e.done} of ${e.all} tasks`,
        find: `#${e.id}` });
    }
    for (const pr of filterRows(v.pulls.pulls, query)) {
      hits.push({ ...base, channel: "view:pull-requests", view: "Pull requests", title: `#${pr.number} ${pr.title}`,
        detail: [pr.branch, pr.agent ?? ""].filter(Boolean).join(" · "), find: `#${pr.number}` });
    }
    for (const r of filterRows(v.ci.runs, query)) {
      hits.push({ ...base, channel: "view:ci", view: "CI", title: `${r.name} on ${r.branch}`, detail: `${runStateText(r.state)} · ${r.ref}`,
        find: `${r.name} on ${r.branch}` });
    }
    for (const r of filterRows(v.ci.runners, query)) {
      hits.push({ ...base, channel: "view:ci", view: "CI", title: `runner ${r.name}`, detail: runnerText(r.state), find: r.name });
    }
  }
  return hits.slice(0, most);
}

// --- words and tones ---------------------------------------------------------------------------------------------------

export function taskTone(state: string): Tone {
  if (state === "in-progress" || state === "in-review") return "good";
  if (state === "blocked") return "bad";
  if (state === "ready") return "warn";
  return "quiet";
}

export function checksTone(state: string): Tone {
  if (state === "green") return "good";
  if (state === "red") return "bad";
  if (state === "running" || state === "queued") return "warn";
  return "quiet";
}

export function checksText(c: { state: string; failing: string[] }): string {
  if (c.state === "red") return c.failing.length ? `failing: ${c.failing.join(", ")}` : "failing";
  if (c.state === "none") return "no runs yet";
  return c.state;
}

export function reviewTone(state: string): Tone {
  if (state === "approved") return "good";
  if (state === "changes-asked") return "bad";
  if (state === "watching") return "warn";
  return "quiet";
}

export function protectedText(p: boolean | null): string {
  return p === true ? "touches protected files: the owner merges" : p === false ? "no protected file" : "not checked yet (checked once approved and green)";
}

export function runStateText(state: string): string {
  return state === "in_progress" ? "running" : state;
}

export function runTone(state: string): Tone {
  if (state === "success") return "good";
  if (["failure", "timed_out", "cancelled", "startup_failure"].includes(state)) return "bad";
  if (["queued", "in_progress", "waiting", "pending", "requested"].includes(state)) return "warn";
  return "quiet";
}

export function runnerText(state: string): string {
  return state === "busy" ? "running a job" : state === "idle" ? "waiting for a job" : "offline";
}

export function runnerTone(state: string): Tone {
  return state === "busy" ? "good" : state === "offline" ? "bad" : "quiet";
}

/** The verdict's tone, from factory_ci_view.ts's green, amber and red. */
export function verdictTone(tone: string): Tone {
  return tone === "green" ? "good" : tone === "red" ? "bad" : "warn";
}

/** "3 min", "2 h", "4 d": how long ago, in the CI channel. */
export function minutesText(minutes: number): string {
  const m = Math.max(Math.floor(minutes), 0);
  return m < 120 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}
