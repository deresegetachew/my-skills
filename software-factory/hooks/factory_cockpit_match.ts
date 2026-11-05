// What the cockpit's command bar offers, and how what was typed matches it (#309, #367). No I/O and no imports, so the
// bar's Ink screen (cockpit/command-bar.tsx) and `factory cockpit --bar` off a terminal rank the same way.

/** The read-only commands the `:` bar offers (the owner's actions are ACTIONS_OFFERED). */
export const OFFERED = ["status", "prs", "next", "claims list", "agents ls", "messages ls", "issues list", "issues show",
  "ci status", "ci log", "ci runners", "settings list", "settings show", "settings get", "settings help", "settings diff",
  "usage", "report", "lessons show", "doctor", "version", "env", "machine show", "remote list", "help"];

/** The owner's actions (#309, US-11), each the factory command the command line runs, and what it changes. The bar asks
 *  before it runs one; the rest of the line (flags too, such as `--remove` or `--head`) goes to that command as typed. */
export const ACTIONS_OFFERED: Record<string, string> = {
  "owner merge": "GitHub: it merges the pull request",
  "owner label": "GitHub: it adds or removes a label",
  "owner answer": "GitHub: it posts the answer in the owner queue",
  "owner release": "GitHub: it tags main and pushes the tag, which publishes a release",
  "owner start": "this machine: it starts a session in tmux",
  "owner stop": "this machine: it ends that session",
  say: "a session: it types the message into it",
};

export const ACTION_NAMES = Object.keys(ACTIONS_OFFERED);

/** How well `name` matches what was typed: lower is better, null for no match (start, then letters in order). */
export function rank(name: string, typed: string): number | null {
  if (!typed) return 0;
  if (name.startsWith(typed)) return name.length - typed.length;
  let at = 0;
  for (const ch of typed) {
    at = name.indexOf(ch, at) + 1;
    if (at === 0) return null;
  }
  return 1000 + at;
}

/** Everything the bar offers that matches `typed`, best first. */
export function matches(typed: string): string[] {
  const ranked = [...OFFERED, ...ACTION_NAMES].map((n) => [n, rank(n, typed)] as const).filter((x): x is readonly [string, number] => x[1] !== null);
  return ranked.sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}

// --- the search inside a view and across views (#392) ------------------------------------------------------------------
// The cockpit's views (cockpit/views/filter.ts, tasks.tsx, prs.tsx) and the web UI's (#424) match rows the same way.

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
