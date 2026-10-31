// The cockpit's left side on Ink (#366, decision 0002): the SESSIONS list and the VIEWS list. It draws what it is given
// (the snapshot of `factory cockpit --json` and the views) and hands each key to an action; sidebar-host.tsx reads the
// data and runs the actions through `factory cockpit`, so this file has no factory logic and no tmux.
//
// What is listed (bugs 1 and 2 of #362): every session that runs on this machine, or is expected here (its names file)
// and is down; and the other machines' sessions that are alive, marked by machine. A name that is only down somewhere
// else, or only in a roles list, is not listed. The states are the heartbeat's: working, waiting, idle and down; a
// session waiting on a question is waiting and needs you, and one whose machine stopped reporting is unknown.
import { Box, Text, useInput } from "ink";
import { type ReactElement, useState } from "react";

export type State = "working" | "waiting" | "idle" | "down" | "unknown";
export type Row = { name: string; state: State; task: string; machine: string; needsYou: boolean };
export type ViewItem = { key: string; title: string };
export type Data = { snapshot: unknown; views: ViewItem[] };

/** What the keys do; sidebar-host.tsx runs each through `factory cockpit`, the tests record them. */
export interface Actions {
  openSession(name: string): void;
  openView(key: string): void;
  bar(words: string[]): void;
  reload(): void;
  leave(): void;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

/** A string without escape sequences or control characters: a session name can't drive the terminal. */
function plain(v: unknown): string {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

const SHOWN: Record<string, State> = { working: "working", waiting: "waiting", idle: "idle", down: "down",
  "input-required": "waiting" };

function taskNumber(v: unknown): number | null {
  const m = /#?(\d+)/.exec(plain(v));
  return m ? Number(m[1]) : null;
}

/** The machine a row runs on, "" for this one. */
function machineOf(r: Obj): string {
  const where = plain(r.where);
  if (where === "this machine" || plain(r.source) === "local") return "";
  if (where === "cloud") return "cloud";
  const named = (s: string) => (s === "-" ? "" : s); // "-" is a row that names no machine
  return named(plain(r.machine)) || named(where.replace(/^machine /, "")) || "another machine";
}

/** The sessions to list, this machine's first. */
export function sessionRows(snapshot: unknown): Row[] {
  const snap = obj(snapshot);
  const asks = list(snap.needsYou).filter((n) => n.kind === "owner-ask").map((n) => Number(n.issue));
  const rows: Row[] = [];
  for (const r of list(snap.sessions)) {
    const name = plain(r.name);
    if (!name) continue;
    const raw = plain(r.state);
    const state: State = SHOWN[raw] ?? "unknown";
    const machine = machineOf(r);
    if (state === "down" && (machine !== "" || r.expected !== true)) continue; // not run, nor expected, here
    const task = taskNumber(r.task);
    rows.push({ name, state, task: task === null ? "" : `#${task}`, machine,
      needsYou: raw === "input-required" || (task !== null && asks.includes(task)) });
  }
  return [...rows.filter((r) => !r.machine), ...rows.filter((r) => r.machine)];
}

type Entry = { kind: "session"; row: Row } | { kind: "view"; view: ViewItem };

function entriesOf(data: Data): Entry[] {
  return [...sessionRows(data.snapshot).map((row): Entry => ({ kind: "session", row })),
    ...data.views.map((view): Entry => ({ kind: "view", view }))];
}

function entryId(e: Entry): string {
  return e.kind === "session" ? `session ${e.row.name}` : `view ${e.view.key}`;
}

const COLOUR: Record<State, string> = { working: "blue", waiting: "yellow", idle: "gray", down: "red", unknown: "gray" };

type Line = { text: string; state?: State; selected?: boolean; dim?: boolean };

function sessionLine(r: Row, selected: boolean): Line {
  const parts = [r.name, r.state, r.task, r.machine ? `on ${r.machine}` : "", r.needsYou ? "● needs you" : ""];
  return { text: `${selected ? "›" : " "} ${parts.filter(Boolean).join("  ")}`, state: r.state, selected };
}

/** Every line of the list, and which one is selected. */
function body(data: Data, entries: Entry[], selected: number): [Line[], number] {
  const lines: Line[] = [{ text: "SESSIONS", dim: true }];
  let at = 0;
  const sessions = entries.filter((e) => e.kind === "session");
  if (!sessions.length) lines.push({ text: "  No sessions running." }, { text: "  Start one: factory loop -i", dim: true });
  const needs = list(obj(data.snapshot).needsYou).length;
  entries.forEach((e, i) => {
    if (i === sessions.length) lines.push({ text: "" }, { text: "VIEWS", dim: true });
    if (i === selected) at = lines.length;
    if (e.kind === "session") lines.push(sessionLine(e.row, i === selected));
    else {
      const count = e.view.key === "1" && needs ? ` (${needs})` : "";
      lines.push({ text: `${i === selected ? "›" : " "} ${e.view.key} ${e.view.title}${count}`, selected: i === selected });
    }
  });
  if (!entries.length || sessions.length === entries.length) lines.push({ text: "" }, { text: "VIEWS", dim: true });
  return [lines, at];
}

function keysFor(onSession: boolean, rows: number): string[] {
  if (rows < 16) return [onSession ? "↑↓ Enter · : · r · q" : "↑↓ Enter · 1-8 · : · q"];
  return ["", onSession ? "Enter shows it · s say · x stop" : "Enter opens the view", "↑↓ move · 1-8 views · n start",
    ": commands · r reload · q leave"];
}

export interface SidebarProps {
  data: Data;
  cols: number;
  rows: number;
  color: boolean;
  actions: Actions;
  /** Read keys (a terminal or a test); off a terminal the list is drawn once. */
  keys?: boolean;
}

/** The list: at most `rows` lines, each cut to `cols`; the selected row always shows. */
export function Sidebar({ data, cols, rows, color, actions, keys = true }: SidebarProps): ReactElement {
  // kept by name, so a reload that reorders the list keeps the same row; where it was when that row is gone
  const [picked, setPicked] = useState({ id: "", at: 0 });
  const entries = entriesOf(data);
  const found = entries.findIndex((e) => entryId(e) === picked.id);
  const selected = found >= 0 ? found : Math.min(picked.at, Math.max(entries.length - 1, 0));
  const current = entries[selected];
  const pick = (i: number) => setPicked({ id: entries[i] ? entryId(entries[i]) : "", at: i });
  useInput((input, key) => {
    if (key.upArrow || input === "k") pick(Math.max(selected - 1, 0));
    else if (key.downArrow || input === "j") pick(Math.min(selected + 1, Math.max(entries.length - 1, 0)));
    else if (key.return && current?.kind === "session") actions.openSession(current.row.name);
    else if (key.return && current?.kind === "view") actions.openView(current.view.key);
    else if (data.views.some((v) => v.key === input)) actions.openView(input);
    else if (input === ":") actions.bar([]);
    else if (input === "n") actions.bar(["owner", "start"]);
    else if (input === "s" && current?.kind === "session") actions.bar(["say", current.row.name]);
    else if (input === "x" && current?.kind === "session") actions.bar(["owner", "stop", current.row.name]);
    else if (input === "r") actions.reload();
    else if (input === "q") actions.leave();
  }, { isActive: keys });
  const [lines, at] = body(data, entries, selected);
  const help = keysFor(current?.kind === "session", rows).map((text): Line => ({ text, dim: true }));
  const room = Math.max(rows - help.length, 1);
  const start = Math.min(Math.max(at - room + 1, 0), Math.max(lines.length - room, 0));
  const shown = [...lines.slice(start, start + room), ...help].slice(0, Math.max(rows, 1));
  const width = Math.max(cols, 1);
  return (
    <Box flexDirection="column" width={width}>
      {shown.map((l, i) => (
        <Text key={i} wrap="truncate-end" inverse={color && l.selected === true}
          color={color && l.state ? COLOUR[l.state] : undefined} dimColor={color && l.dim === true}>
          {l.text || " "}
        </Text>
      ))}
    </Box>
  );
}
