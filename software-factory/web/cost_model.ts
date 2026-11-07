// What each task took (#580), as the pages show it: the facts on a task's page and on an epic's page, and the "By task"
// table on Usage and cost, sortable. The data comes from GET /api/projects/:p/costs (hooks/factory_ui_ops.ts, worked
// out in hooks/factory_task_cost.ts). No React here, so tests/web_ui_costs_model.test.ts runs it as it is.

export interface CostRow {
  task: string;
  title: string;
  state: string | null;
  epic: string | null;
  startedAt: string | null;
  startFrom: "claim" | "first-reply" | null;
  doneAt: string | null;
  buildMinutes: number | null;
  workingMinutes: number;
  sessions: number;
  replies: number;
  used: number;
  cost: number;
  unpriced: number;
  unpricedShare: number;
  ci: { runs: number; failed: number; failedInARow: number };
  reviews: { rounds: number };
}

export interface EpicCost {
  epic: string;
  tasks: number;
  done: number;
  buildMinutes: number;
  workingMinutes: number;
  sessions: number;
  replies: number;
  used: number;
  cost: number;
  unpriced: number;
  ci: { runs: number; failed: number };
  reviews: { rounds: number };
}

export interface CostsData {
  since: string | null;
  tasks: CostRow[];
  epics: EpicCost[];
  problems: Array<{ code: string; message: string; fix: string }>;
}

/** 95 -> "1h 35m", 40 -> "40m", 3000 -> "2d 2h"; null -> "-". */
export function durationText(minutes: number | null): string {
  if (minutes === null) return "-";
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "$1.24", or "$1.24 (10% of replies unpriced)"; "No price known" when none had one. */
export function costText(cost: number, replies: number, unpriced: number): string {
  if (replies > 0 && unpriced >= replies && cost === 0) return "No price known";
  const share = replies && unpriced ? ` (${Math.round((unpriced / replies) * 100)}% of replies unpriced)` : "";
  return `$${cost.toFixed(2)}${share}`;
}

function ciText(ci: { runs: number; failed: number }): string {
  return ci.runs ? `${plural(ci.runs, "run")}, ${ci.failed} failed` : "None seen";
}

/** A task's facts: build time, working time, sessions, tokens, cost, CI and reviews. */
export function costFacts(r: CostRow): Array<{ label: string; value: string }> {
  const build = r.doneAt ? durationText(r.buildMinutes)
    : r.startedAt ? `Not done yet (started ${r.startFrom === "claim" ? "with its first claim" : "with its first session"})` : "Not started";
  return [
    { label: "Build time", value: build },
    { label: "Agent working", value: `${durationText(r.workingMinutes)} over ${plural(r.sessions, "session")}` },
    { label: "Tokens", value: tokens(r.used) },
    { label: "Cost", value: costText(r.cost, r.replies, r.unpriced) },
    { label: "CI runs", value: ciText(r.ci) },
    { label: "Review rounds", value: r.reviews.rounds ? `${r.reviews.rounds} with must-fixes` : "None with must-fixes" },
  ];
}

/** An epic's totals: what its tasks add up to. */
export function epicCostFacts(e: EpicCost): Array<{ label: string; value: string }> {
  return [
    { label: "Tasks done", value: `${e.done} of ${e.tasks}` },
    { label: "Build time", value: `${durationText(e.buildMinutes)} (its done tasks added up)` },
    { label: "Agent working", value: `${durationText(e.workingMinutes)} over ${plural(e.sessions, "session")}` },
    { label: "Tokens", value: tokens(e.used) },
    { label: "Cost", value: costText(e.cost, e.replies, e.unpriced) },
    { label: "CI runs", value: ciText(e.ci) },
    { label: "Review rounds", value: e.reviews.rounds ? `${e.reviews.rounds} with must-fixes` : "None with must-fixes" },
  ];
}

export const SORT_KEYS = ["task", "build", "working", "sessions", "tokens", "cost", "ci", "reviews"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABEL: Record<SortKey, string> = { task: "Task", build: "Build time", working: "Agent working", sessions: "Sessions",
  tokens: "Tokens", cost: "Cost", ci: "CI runs (failed)", reviews: "Review rounds" };

function valueOf(r: CostRow, k: SortKey): number {
  switch (k) {
    case "build": return r.buildMinutes ?? -1;
    case "working": return r.workingMinutes;
    case "sessions": return r.sessions;
    case "tokens": return r.used;
    case "cost": return r.cost;
    case "ci": return r.ci.failed * 1e6 + r.ci.runs;
    case "reviews": return r.reviews.rounds;
    default: return Number(r.task);
  }
}

/** The rows sorted by `key`, biggest first (`desc`) or smallest first; ties by task number. A task not done yet has no
 *  build time and goes last when biggest are first. */
export function sortCosts(rows: CostRow[], key: SortKey, desc: boolean): CostRow[] {
  const byTask = (a: CostRow, b: CostRow): number => Number(a.task) - Number(b.task) || a.task.localeCompare(b.task);
  return [...rows].sort((a, b) => {
    const d = valueOf(a, key) - valueOf(b, key);
    return (d === 0 ? 0 : desc ? -d : d) || byTask(a, b);
  });
}

/** One row of the table, as text in the order of SORT_KEYS. */
export function costCells(r: CostRow): Record<SortKey, string> {
  return { task: `#${r.task}${r.title ? ` ${r.title}` : ""}`, build: r.doneAt ? durationText(r.buildMinutes) : "Not done", working: durationText(r.workingMinutes),
    sessions: String(r.sessions), tokens: tokens(r.used), cost: costText(r.cost, r.replies, r.unpriced),
    ci: r.ci.runs ? `${r.ci.runs} (${r.ci.failed})` : "0", reviews: String(r.reviews.rounds) };
}
