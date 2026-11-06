// How the search inside a view and across views matches a row (#392): the web UI's channels (#424) and its views model
// match the same way. No I/O and no imports.

/** True when every word of `typed` is in `text`, in any case; nothing typed matches everything. */
export function matchesTyped(text: string, typed: string): boolean {
  const hay = text.toLowerCase();
  return typed.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** A task's lanes, in the Tasks view's order, with the words it shows for each state. */
export const TASK_LANES: Array<[string, string]> = [["in-progress", "in progress"], ["in-review", "in review"], ["ready", "ready"],
  ["blocked", "blocked"], ["new", "not ready"], ["done", "done"]];

/** The words for a task's state ("not ready" for new). */
export function taskStateText(s: string): string {
  return TASK_LANES.find(([k]) => k === s)?.[1] ?? s;
}

type Row = { [key: string]: unknown };

function textOf(v: unknown): string {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Who holds a task: its holders, or "—". */
export function taskHolders(t: Row): string {
  const h = Array.isArray(t.holders) ? t.holders.map(textOf).filter(Boolean) : [];
  return h.length ? h.join(", ") : "—";
}

/** What the filter and the search match a task by: its number, title, lane, holders and milestone or phase. */
export function taskText(t: Row): string {
  return [`#${textOf(t.id)}`, textOf(t.title), taskStateText(textOf(t.state)), taskHolders(t), textOf(t.group)].join(" ");
}

/** What the filter and the search match a pull request by: its number, title, branch and author. */
export function prText(p: Row): string {
  return [`#${textOf(p.number)}`, textOf(p.title), textOf(p.branch), textOf(p.agent)].join(" ");
}
