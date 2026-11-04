// The Tasks & PRD view (#367), towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VTasks.dc.html): how many
// tasks are in each lane (ready, in progress, in review, blocked, not ready yet, done), the tasks with who holds them,
// and the selected one's detail. Its data is `factory cockpit --view-data tasks`: the project's task tracker (#377), so
// the GitHub issues in issues mode and the build plan otherwise. j k (or ↑ ↓) move, / filters the rows (#392), r reads
// the tasks again, q closes.
// It only reads: claiming, blocking and releasing are the agents' and the dev manager's.
import { useApp, useInput } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { cut, type Line, Lines, list, type Obj, plain, screen, seg, spread, type Style } from "./lines.tsx";
import { clip, padStr, para } from "./doc.tsx";
import { type Filter, filterKey, filterKeys, matchesTyped, NO_FILTER, noMatch } from "./filter.ts";
import type { Got } from "./read.ts";

export const TASKS_KEYS = "j k move · r read again · q close";

const LANES: Array<[string, string, Style]> = [["in-progress", "in progress", "blue"], ["in-review", "in review", "blue"],
  ["ready", "ready", "green"], ["blocked", "blocked", "red"], ["new", "not ready", "dim"], ["done", "done", "dim"]];

const ORDER = LANES.map(([s]) => s);

function stateText(s: string): string {
  return LANES.find(([k]) => k === s)?.[1] ?? s;
}

function who(t: Obj): string {
  const h = Array.isArray(t.holders) ? t.holders.map(plain).filter(Boolean) : [];
  return h.length ? h.join(", ") : "—";
}

/** What the filter and the search match a task by: its number, title, lane, holders and milestone or phase. */
export function taskText(t: Obj): string {
  return [`#${plain(t.id)}`, plain(t.title), stateText(plain(t.state)), who(t), plain(t.group)].join(" ");
}

/** The tasks of the data, in lane order (in progress first, done last), those that match `typed` (#392). */
export function tasksOf(data: Got | undefined, typed = ""): Obj[] {
  if (!data || data === "late") return [];
  const rank = (t: Obj) => {
    const i = ORDER.indexOf(plain(t.state));
    return i < 0 ? ORDER.length : i;
  };
  return list(data.tasks).map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t)
    .filter((t) => matchesTyped(taskText(t), typed));
}

/** The index of task `id` (with a leading # or not) among the tasks, else 0: the search's Enter (#392). */
export function taskAt(data: Got | undefined, id: string): number {
  const want = id.replace(/^#/, "");
  return Math.max(tasksOf(data).findIndex((t) => plain(t.id) === want), 0);
}

function lanes(all: Obj[]): Line {
  const out: Line = [];
  for (const [state, name, style] of LANES) {
    const n = all.filter((t) => plain(t.state) === state).length;
    if (out.length) out.push(seg(" · ", "dim"));
    out.push(seg(`${name} ${n}`, state === "ready" && n === 0 ? "amber" : n ? style : "dim"));
  }
  return out;
}

function row(t: Obj, selected: boolean, cols: number): Line {
  const state = plain(t.state);
  const style = LANES.find(([k]) => k === state)?.[2];
  const mark = selected ? "› " : "  ";
  const idW = 8;
  const stateW = 13;
  const whoW = cols >= 100 ? 18 : 0;
  const titleW = Math.max(cols - 2 - idW - stateW - whoW, 10);
  const line: Line = [seg(mark), seg(padStr(`#${plain(t.id)}`, idW), "dim"), seg(padStr(plain(t.title), titleW)),
    seg(padStr(stateText(state), stateW), style), ...(whoW ? [seg(clip(who(t), whoW))] : [])];
  return selected ? line.map((s) => (s.style ? s : { ...s, style: "bold" as const })) : line;
}

function card(t: Obj, source: string, cols: number): Line[] {
  const todos = list(t.todos);
  const done = todos.filter((x) => x.done === true).length;
  const parts = [stateText(plain(t.state)), `held by ${who(t)}`, plain(t.group), todos.length ? `${done} of ${todos.length} todos done` : ""];
  const show = source === "issues" ? `factory issues show ${plain(t.id)} --comments` : "factory next";
  return [...para(`#${plain(t.id)} · ${plain(t.title)}`, cols, "bold"), ...para(parts.filter(Boolean).join(" · "), cols, "dim"),
    ...para(`read it: ${show}`, cols, "dim")];
}

/** One screen of the view, `rows` lines at most, each at most `cols` wide. `data` undefined: still reading. */
export function tasksLines(data: Got | undefined, selected: number, cols: number, rows: number, repo: string,
  limitSeconds: number, filter: Filter = NO_FILTER): Line[] {
  const source = data && data !== "late" ? plain(data.source) : "";
  const right = source === "issues" ? "factory issues list · factory next" : "factory next · the build plan";
  const head = spread([seg("factory", "amber"), seg(`  ${repo} · Tasks and PRD`)], [seg(right, "dim")], cols);
  let body: Line[];
  if (data === undefined) body = [[seg("Reading the tasks…")]];
  else if (data === "late") {
    body = para(`Can't read the tasks in ${limitSeconds} s: run \`factory issues list\` to see how long it takes.`, cols);
  } else if (data === null) body = para("Can't read the tasks: run `factory next` to see why.", cols);
  else if (plain(data.error)) {
    body = [...para(`Can't read the tasks (${plain(data.error).slice(0, 200)}).`, cols, "red"),
      ...para("Run `factory issues list` to see the whole error; if it is about GitHub, `gh auth status`.", cols, "dim")];
  } else {
    const every = tasksOf(data);
    const all = tasksOf(data, filter.typed);
    const prd = plain(data.prd);
    body = [lanes(every), ...(prd ? para(`PRD: ${prd}`, cols, "dim") : [])];
    const open = every.filter((t) => plain(t.state) !== "done");
    if (open.length && !open.some((t) => plain(t.state) === "ready")) {
      body.push(...para("No task is ready, so the coding agents wait for one.", cols, "amber"));
    }
    body.push([]);
    if (!every.length) body.push([seg("No tasks yet.")]);
    else if (!all.length) body.push(noMatch(filter.typed));
    else {
      const at = Math.min(Math.max(selected, 0), all.length - 1);
      const detail = card(all[at] as Obj, source, cols);
      const room = Math.max(rows - 2 - body.length - detail.length - 2, 1); // the heading, the card and a blank, the keys
      const start = Math.min(Math.max(at - room + 1, 0), Math.max(all.length - room, 0));
      body.push(...all.slice(start, start + room).map((t, i) => row(t, start + i === at, cols)), [], ...detail);
    }
  }
  return screen([head, [], ...body], filterKeys(filter, TASKS_KEYS), cols, rows);
}

export interface TasksProps {
  repo: string;
  cols: number;
  rows: number;
  color: boolean;
  limitSeconds: number;
  /** Reads the tasks (`factory cockpit --view-data tasks`). */
  load: () => Promise<Got>;
  /** The task to select first, by its number: the search's Enter (#392). */
  find?: string;
}

export function TasksView(props: TasksProps): ReactElement {
  const { exit } = useApp();
  const [data, setData] = useState<Got | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const read = (first: boolean) => {
    setData(undefined);
    void props.load().then((got) => {
      setData(got);
      if (first && props.find) setSelected(taskAt(got, props.find));
      else setSelected((s) => Math.min(s, Math.max(tasksOf(got, filter.typed).length - 1, 0)));
    });
  };
  useEffect(() => read(true), []);
  useInput((input, key) => {
    if (key.ctrl && input === "c") return exit();
    const next = data === undefined ? null : filterKey(filter, input, key);
    if (next) {
      setFilter((f) => filterKey(f, input, key) ?? f); // keys in one chunk each see the one before
      setSelected(0);
    } else if (input === "q" || key.escape) exit();
    else if (data === undefined) return; // reading
    else if (input === "j" || key.downArrow) setSelected((s) => Math.min(s + 1, Math.max(tasksOf(data, filter.typed).length - 1, 0)));
    else if (input === "k" || key.upArrow) setSelected((s) => Math.max(s - 1, 0));
    else if (input === "r") read(false);
  });
  const lines = tasksLines(data, selected, props.cols, props.rows, props.repo, props.limitSeconds, filter);
  return <Lines lines={lines.map((l) => cut(l, props.cols))} color={props.color} />;
}
