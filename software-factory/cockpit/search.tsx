// The cockpit's search across its views (#392): `/` in the list, or C-a /. A box at the top matches as you type, the
// same way as `/` inside a view (views/filter.ts), over every view's rows at once: what needs you, the pull requests
// (number, title, branch, author), the tasks (number, title, lane, holders), the CI runs and runners, the sessions, the
// settings (name, value, help), the doctor and the version, the usage by task and the lessons. The results are grouped
// by view, each row naming its view; ↑ ↓ move, Enter opens that view on that row and Esc closes. Its data is `factory
// cockpit --search-data`: the cockpit's cache and what is on this machine, read once when it opens, so typing makes no
// GitHub call.
import { useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { clip } from "./views/doc.tsx";
import { backspace, erased, matchesTyped, typedText } from "./views/filter.ts";
import { cut, type Line, Lines, list, obj, type Obj, plain, seg, spread } from "./views/lines.tsx";
import { needKey, sentence } from "./views/needs.tsx";
import { prText } from "./views/prs.tsx";
import type { Got } from "./views/read.ts";
import { taskText } from "./views/tasks.tsx";

export const SEARCH_KEYS = "type to search · ↑↓ move · Enter opens · Esc closes";

/** One row the search can find: the view it is from, what it shows, what it matches by, and the `factory cockpit`
 *  arguments that open its view on it. */
export interface Hit {
  title: string;
  text: string;
  hay: string;
  args: string[];
}

/** The views in the list's order, by the title the list gives them. */
const TITLES = ["Needs you", "Pull requests", "Tasks & PRD", "CI", "Agents & machines", "Settings", "Health & releases",
  "Usage & lessons"] as const;

type Title = (typeof TITLES)[number];

function hit(title: Title, text: string, args: string[], hay = text): Hit {
  return { title, text, hay: `${hay} ${title}`, args };
}

/** A short piece of a line for a document view to scroll to: its start, before it wraps. */
function lead(text: string): string {
  return clip(text, 24).replace(/…$/, "");
}

function joined(parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

function needs(snap: Obj): Hit[] {
  return list(snap.needsYou).map((n) => hit("Needs you", sentence(n), ["--needs", "--find", needKey(n)]));
}

function pulls(snap: Obj): Hit[] {
  return list(snap.pulls).filter((p) => plain(p.number)).map((p) =>
    hit("Pull requests", joined([`#${plain(p.number)} ${plain(p.title)}`, plain(p.branch), plain(p.agent)]), ["--prs", plain(p.number)],
      prText(p)));
}

function tasks(snap: Obj): Hit[] {
  return list(obj(snap.tasks).tasks).filter((t) => plain(t.id)).map((t) => {
    const holders = Array.isArray(t.holders) ? t.holders.map(plain).filter(Boolean).join(", ") : "";
    return hit("Tasks & PRD", joined([`#${plain(t.id)} ${plain(t.title)}`, plain(t.state), holders]),
      ["--tasks", "--find", plain(t.id)], taskText(t));
  });
}

function ci(snap: Obj): Hit[] {
  const c = obj(snap.ci);
  const runs = list(c.runs).map((r) => {
    // the title the CI view gives the run: runs often share a workflow name, so the branch tells them apart
    const title = `${plain(r.name) || "CI"} on ${plain(r.branch)}`;
    return hit("CI", joined([title, plain(r.state), plain(r.ref)]), ["--ci", "--find", title]);
  });
  const runners = [...list(c.runners), ...list(obj(c.light).runners)].filter((r) => plain(r.name)).map((r) =>
    hit("CI", joined([`runner ${plain(r.name)}`, plain(r.status)]), ["--ci", "--find", plain(r.name)]));
  return [...runs, ...runners];
}

function agents(snap: Obj): Hit[] {
  return list(snap.sessions).filter((s) => plain(s.name)).map((s) => {
    const machine = plain(s.machineName) || plain(s.machine);
    return hit("Agents & machines", joined([plain(s.name), plain(s.role), plain(s.state), plain(s.task),
      machine ? `on ${machine}` : ""]), ["--agents", "--find", plain(s.name)]);
  });
}

function settings(data: Obj): Hit[] {
  const rows = [...list(data.sections).flatMap((s) => list(s.rows)), ...list(data.machine)];
  return rows.filter((r) => plain(r.key)).map((r) =>
    hit("Settings", joined([`${plain(r.key)} = ${plain(r.value)}`, plain(r.help)]), ["--settings", "--color", "--find", plain(r.key)]));
}

function health(snap: Obj): Hit[] {
  const doc = obj(snap.doctor);
  const lines = [...(Array.isArray(doc.fix) ? doc.fix.map(plain) : []), plain(doc.summary)].filter(Boolean);
  const out = lines.map((l) => hit("Health & releases", l, ["--health", "--find", lead(l)]));
  const installed = plain(obj(snap.version).installed);
  if (installed) out.push(hit("Health & releases", `factory version v${installed.replace(/^v/, "")} installed here`, ["--health", "--find", "installed here"]));
  return out;
}

function usage(data: Obj): Hit[] {
  const tasks = list(data.tasks).filter((t) => plain(t.task)).map((t) =>
    hit("Usage & lessons", joined([`task ${plain(t.task)}`, plain(t.agent), `${plain(t.used) || "0"} tokens`,
      plain(t.top) && plain(t.top) !== "—" ? `most by ${plain(t.top)}` : ""]),
      ["--usage", "--find", plain(t.task)]));
  const lessons = (Array.isArray(data.lessons) ? data.lessons.map(plain) : []).filter(Boolean).map((l) =>
    hit("Usage & lessons", `lesson: ${l}`, ["--usage", "--find", lead(l)]));
  return [...tasks, ...lessons];
}

/** Every row the search can find in its data, in the list's order of the views. */
export function hitsOf(data: Got | undefined): Hit[] {
  if (!data || data === "late") return [];
  const snap = obj(data.snapshot);
  return [...needs(snap), ...pulls(snap), ...tasks(snap), ...ci(snap), ...agents(snap), ...settings(obj(data.settings)),
    ...health(snap), ...usage(obj(data.usage))];
}

/** The rows that match `typed`, grouped by view. */
export function found(data: Got | undefined, typed: string): Hit[] {
  return hitsOf(data).filter((h) => matchesTyped(h.hay, typed));
}

function heading(title: string, n: number): Line {
  return [seg(`${title} · ${n}`, "bold")];
}

/** The search's screen: the box, the results by view with `selected` marked, and the keys; `rows` lines at most. */
export function searchLines(data: Got | undefined, typed: string, selected: number, cols: number, rows: number): Line[] {
  const box: Line = [seg("/ ", "amber"), seg(typed, "bold")];
  const keys: Line = [seg(cols >= SEARCH_KEYS.length ? SEARCH_KEYS : "↑↓ · Enter opens · Esc closes", "dim")];
  const hits = found(data, typed);
  const body: Line[] = [];
  let at = 0;
  if (data === undefined) body.push([seg("Reading the cockpit's cache…")]);
  else if (!hitsOf(data).length) body.push([seg("Nothing to search yet: `factory cockpit --json` reads the snapshot.")]);
  else if (!hits.length) body.push([seg(`No match for "${plain(typed)}".`)]);
  hits.forEach((h, i) => {
    if (i === 0 || hits[i - 1]?.title !== h.title) {
      if (i) body.push([]);
      body.push(heading(h.title, hits.filter((x) => x.title === h.title).length));
    }
    if (i === selected) at = body.length;
    const mark = i === selected ? "› " : "  ";
    const line = spread([seg(mark), seg(plain(h.text))], [seg(h.title, "dim")], cols);
    body.push(i === selected ? line.map((s) => (s.style ? s : { ...s, style: "bold" as const })) : line);
  });
  const room = Math.max(rows - 3, 1); // the box, a blank line, the keys
  const start = Math.min(Math.max(at - room + 1, 0), Math.max(body.length - room, 0));
  return [box, [], ...body.slice(start, start + room), keys].slice(0, Math.max(rows, 1)).map((l) => cut(l, cols));
}

export interface SearchProps {
  /** What `factory cockpit --search-data` printed: the cache's snapshot, the settings and the usage. */
  data: Got;
  cols: number;
  rows: number;
  color: boolean;
  /** Typed in already. */
  prefill?: string;
  /** Enter: the `factory cockpit` arguments that open the row's view on it; Esc: null. */
  done: (args: string[] | null) => void;
}

export function SearchView(props: SearchProps): ReactElement {
  const { exit } = useApp();
  const [typed, setTyped] = useState(props.prefill ?? "");
  const [selected, setSelected] = useState(0);
  const end = (args: string[] | null) => {
    props.done(args);
    exit();
  };
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return end(null);
    const hits = found(props.data, typed);
    if (key.return) {
      const h = hits[selected];
      if (h) end(h.args);
      return;
    }
    if (key.upArrow) return setSelected((s) => Math.max(s - 1, 0));
    if (key.downArrow) return setSelected((s) => Math.min(s + 1, Math.max(hits.length - 1, 0)));
    // from the typed text as it is by then: keys that come in one chunk run before the screen is drawn again
    const back = erased(input, key);
    const text = typedText(input, key);
    if (!back && !text) return;
    setTyped((t) => (back ? backspace(t, back) : t + text));
    setSelected(0);
  });
  const lines = searchLines(props.data, typed, selected, props.cols, props.rows);
  return <Lines lines={lines} color={props.color} />;
}
