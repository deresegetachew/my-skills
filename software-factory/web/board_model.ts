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

/** The columns, left to right, from the factory's labels. The tasks are the open work (the task tracker's list(), and the
 *  board feed's partOf()), so Done is empty while `factory board status` counts done tasks too: docs/wiki/board.md,
 *  "What the Board page shows" (#520). */
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

/** A card's one status, on its right (the reference design's tag): "Needs you" (with the red dot) when its pull request
 *  waits for the owner to merge, "Checks failing" when that PR's checks are red, else the task's state in words. */
export function cardTag(t: TaskRow, pull?: { next: { action: string } }): { text: string; needsYou: boolean } {
  if (pull?.next.action === "owner-merges") return { text: "Needs you", needsYou: true };
  if (t.pr?.checks?.state === "red") return { text: "Checks failing", needsYou: false };
  return { text: t.stateText, needsYou: false };
}

/** The lane a task goes in by epic: the epic (#440) that lists it, keyed `#<id>`, else its group (milestone or phase). */
function epicKey(t: TaskRow, known: Map<string, string>): [string, string] {
  if (t.epic && known.has(t.epic)) return [`#${t.epic}`, known.get(t.epic) as string];
  return [t.group, t.group];
}

/** An agent lane's grey line (#545): how many tasks it has, then its state as the sidebar says it ("1 task · idle"), so
 *  the lane never looks busy for an agent that is down. */
export function agentLaneSub(count: number, state: string | undefined): string {
  return [`${count} ${count === 1 ? "task" : "tasks"}`, state ?? ""].filter(Boolean).join(" · ");
}

/** How a task is named on screen: `#7` for an issue, `b3` for a task made on the message board (#545). */
export function taskLabel(id: string): string {
  return /^\d+$/.test(id) ? `#${id}` : id;
}

/** Who a card belongs to: the agent that holds it, else the one it was handed to (Reassign), else nobody (""). */
export function ownerOf(t: { holders: string[]; assignee?: string | null }): string {
  return t.holders[0] ?? t.assignee ?? "";
}

/** The words on a card for who has it when nobody holds it: "For taytu" when it was handed to taytu, else "Unassigned". */
export function unheldText(t: { assignee?: string | null }): string {
  return t.assignee ? `For ${t.assignee}` : "Unassigned";
}

/** The swim lanes for `tasks`. By agent: one per first holder (or the agent it was handed to), by name, then Nobody. By epic: one per epic in `epics`'
 *  order, then one per group in the order they first come (build order), then No epic. A lane with no task isn't there. */
export function boardOf(tasks: TaskRow[], by: LaneBy, epics: { id: string; title: string }[] = []): Lane[] {
  const known = new Map(epics.map((e) => [e.id, `#${e.id} ${e.title}`]));
  const lanes = new Map<string, Lane>();
  for (const t of tasks) {
    const [key, title] = by === "agent" ? [ownerOf(t), ownerOf(t)] : epicKey(t, known);
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

/** The palette's categories an epic's chip dot takes, in the epics' order (the reference design's: violet, pink, green,
 *  blue), then round again. */
const EPIC_COLOURS = ["violet", "pink", "green", "blue", "yellow"];

/** The category colour of the epic at `index` in the epics' order. */
export function epicColour(index: number): string {
  return EPIC_COLOURS[((index % EPIC_COLOURS.length) + EPIC_COLOURS.length) % EPIC_COLOURS.length] as string;
}

/** The palette category of a role's lane: the product owner's, the dev manager's, else a builder's. */
function roleColour(role: string | undefined): string {
  return role === "product-owner" ? "product" : role === "dev-manager" ? "manager" : "builder";
}

/** Each lane's palette category, for the dot by its title (owner, 6 Nov: the lanes must be told apart). By epic: an epic's
 *  lane takes its chip's colour (its place in `epics`, every epic), a milestone or phase lane the next colours round
 *  after the epics, in the order the lanes come. By agent: the agent's role colour from `agents` (an unknown role is a
 *  builder). The last lane (No epic, Nobody) is grey. */
export function laneColours(lanes: { key: string }[], by: LaneBy, epics: { id: string }[] = [],
  agents: Record<string, { role?: string }> = {}): string[] {
  let groups = 0;
  return lanes.map((l) => {
    if (!l.key) return "grey";
    if (by === "agent") return roleColour(agents[l.key]?.role);
    const at = epics.findIndex((e) => `#${e.id}` === l.key);
    return epicColour(at >= 0 ? at : epics.length + groups++);
  });
}

/** A card's left edge (owner, 6 Nov: the colour is on the cards, not the lanes). By epic: its lane's colour. By agent:
 *  its epic's colour (its place in `epics`), so the epic still shows; a task in no epic is grey. */
export function cardEdge(t: { epic?: string | null }, by: LaneBy, laneColour: string, epics: { id: string }[] = []): string {
  if (by === "epic") return laneColour;
  const at = t.epic ? epics.findIndex((e) => e.id === t.epic) : -1;
  return at >= 0 ? epicColour(at) : "grey";
}

/** A card's blockers in words (#498): "Blocked by #11, #12", or "" with none. */
export function blockersText(t: { blockedBy?: string[] }): string {
  const b = t.blockedBy ?? [];
  return b.length ? `Blocked by ${b.map((x) => (/^\d+$/.test(x) ? `#${x}` : x)).join(", ")}` : "";
}

/** A card's actions, and Needs attention's close (#579: a task or an epic whose work is done; never on a card). */
export type TaskAction = "release" | "block" | "reassign" | "close";

/** What a card's action does and doesn't do, in plain words, for its confirm. The commands change the issue's labels
 *  and claim; they don't stop a session already working on the task, so the confirm says so. `agent` is the one picked
 *  for reassign ("" before one is). */
export function taskAsk(action: TaskAction, t: { id: string; holders: string[] }, agent = ""): { happens: string; doesNot: string } {
  const id = taskLabel(t.id);
  const who = t.holders[0];
  const claim = who ? ` ${who}'s claim comes off.` : "";
  const session = who ? "A session already working on it isn't stopped. " : "";
  if (action === "release") return { happens: `${id} goes back to Ready and the next free agent takes it.${claim}`, doesNot: `${session}Its branch and pull request stay.` };
  if (action === "block") return { happens: `${id} moves to Blocked with your reason.${claim}`, doesNot: `${session}Nothing is deleted: Release puts it back to Ready.` };
  if (action === "close") return { happens: `${id} is closed as done.${claim}`, doesNot: `${session}Its branch and pull request stay, and nothing is deleted.` };
  return { happens: `${id} goes back to Ready, then ${agent || "the agent you pick"} is told to take it.${claim}`,
    doesNot: `${session}${who ? `${who}'s branch stays.` : "Nothing is deleted."}` };
}
