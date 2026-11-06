// The task board's rules that aren't drawing (#439): its columns, one per factory label, and its swim lanes, by the
// agent that holds a task or by its epic (#440; a task in none goes by its milestone, or the plan's phase). The filter is the tasks channel's own
// (filterRows), applied before the board is laid out. No React here, so tests/web_ui_board_model.test.ts runs it as it is.
import type { TaskRow } from "./views_model.ts";

export interface Column {
  state: string;
  title: string;
}

export type LaneBy = "agent" | "epic";

export interface Lane {
  /** The agent's name or the epic; "" for the last lane (nobody holds them, or no epic). */
  key: string;
  title: string;
  count: number;
  /** The lane's tasks by state, one entry per column (empty when none), in build order. */
  cells: Record<string, TaskRow[]>;
}

/** The columns, left to right, from the factory's labels. */
export const COLUMNS: Column[] = [
  { state: "ready", title: "Ready" },
  { state: "in-progress", title: "In progress" },
  { state: "in-review", title: "In review" },
  { state: "blocked", title: "Blocked" },
  { state: "done", title: "Done" },
];

const NOT_READY: Column = { state: "new", title: "Not ready" };

/** The columns for `tasks`: a Not ready column first only when some task has no ready label yet. */
export function columnsOf(tasks: TaskRow[]): Column[] {
  return tasks.some((t) => t.state === NOT_READY.state) ? [NOT_READY, ...COLUMNS] : COLUMNS;
}

function emptyCells(): Record<string, TaskRow[]> {
  return Object.fromEntries([NOT_READY, ...COLUMNS].map((c) => [c.state, [] as TaskRow[]]));
}

/** The lane a task goes in by epic: the epic (#440) that lists it, keyed `#<id>`, else its group (milestone or phase). */
function epicKey(t: TaskRow, known: Map<string, string>): [string, string] {
  if (t.epic && known.has(t.epic)) return [`#${t.epic}`, known.get(t.epic) as string];
  return [t.group, t.group];
}

/** The swim lanes for `tasks`. By agent: one per first holder, by name, then Nobody. By epic: one per epic in `epics`'
 *  order, then one per group in the order they first come (build order), then No epic. A lane with no task isn't there. */
export function boardOf(tasks: TaskRow[], by: LaneBy, epics: { id: string; title: string }[] = []): Lane[] {
  const known = new Map(epics.map((e) => [e.id, `#${e.id} ${e.title}`]));
  const lanes = new Map<string, Lane>();
  for (const t of tasks) {
    const [key, title] = by === "agent" ? [t.holders[0] ?? "", t.holders[0] ?? ""] : epicKey(t, known);
    let lane = lanes.get(key);
    if (!lane) {
      lane = { key, title: title || (by === "agent" ? "Nobody" : "No epic"), count: 0, cells: emptyCells() };
      lanes.set(key, lane);
    }
    (lane.cells[t.state] ??= []).push(t);
    lane.count++;
  }
  const named = [...lanes.values()].filter((l) => l.key);
  if (by === "agent") named.sort((a, b) => a.key.localeCompare(b.key));
  else {
    const order = epics.map((e) => `#${e.id}`);
    const rank = (l: Lane) => (order.includes(l.key) ? order.indexOf(l.key) : order.length);
    named.sort((a, b) => rank(a) - rank(b)); // stable: the groups keep the order they came in
  }
  const last = lanes.get("");
  return last ? [...named, last] : named;
}
