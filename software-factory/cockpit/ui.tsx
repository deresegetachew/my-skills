#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The cockpit's Ink UI (decision 0002, #365). A release carries it as one JavaScript file, built with `bun build`
// (tools/build_cockpit.ts), installed as .claude/hooks/factory_cockpit_ink.js: a project runs it with Bun and needs no
// node_modules. In this repo it runs from this source.
//
//   ui.tsx --data <file>                 draw the snapshot in <file> (`factory cockpit --json`); on a terminal q or Esc
//                                        leaves, off one it draws once and exits
//   ui.tsx --view <name> --data <file>   one of the cockpit's views (#367): needs, prs, tasks, ci, agents, settings,
//                                        health, usage, the command bar (bar), or the search across them (search,
//                                        #392: Enter runs the picked view in its place). <file> is what the hook gives it (the
//                                        data, or the command that reads it, and what an action runs). On a terminal it
//                                        reads the keys; off one it draws one frame, sized by COLUMNS (and LINES for
//                                        the lists; a document is printed whole, for a pager), and exits within a time
//                                        limit. Colour off a terminal is the hook's call (`color`, with FORCE_COLOR)
//   ui.tsx --check                       print "ok": every module loaded (`factory doctor` runs it)
//   ui.tsx --sidebar --factory <script>  the cockpit's left pane, sessions and views (#366, sidebar-host.tsx)
import { readFileSync } from "node:fs";
import { render, useApp, useInput, useStdout } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { App } from "./app.tsx";
import { barLines, CommandBar, type Outcome, type Problem as BarProblem, type Resolved } from "./command-bar.tsx";
import { searchLines, SearchView } from "./search.tsx";
import { sidebarMain } from "./sidebar-host.tsx";
import { agentsLines } from "./views/agents.tsx";
import { ciLines, CiView, type Heavy } from "./views/ci.tsx";
import { DocView } from "./views/doc.tsx";
import { healthLines } from "./views/health.tsx";
import { type Line, Lines, obj, plain } from "./views/lines.tsx";
import { needAt, needsLines, NeedsView } from "./views/needs.tsx";
import { type Problem, prsLines, PrsView, selectedOf } from "./views/prs.tsx";
import { type Got, readJson, readOrRefusal, runAction, runSteps } from "./views/read.ts";
import { settingsLines } from "./views/settings.tsx";
import { taskAt, tasksLines, TasksView } from "./views/tasks.tsx";
import { usageLines } from "./views/usage.tsx";

/** How long a view waits for its data: off a terminal it must print its frame and exit (bug 3 in #362). */
const OFF_TERMINAL_SECONDS = 20;
const ON_TERMINAL_SECONDS = 120;

function Interactive({ snapshot }: { snapshot: unknown }): ReactElement {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
  });
  return <App snapshot={snapshot} />;
}

/** The terminal's size, kept as it is resized; one line is left free below the view so Ink never scrolls it. */
function Sized({ draw }: { draw: (cols: number, rows: number) => ReactElement }): ReactElement {
  const { stdout } = useStdout();
  const tty = stdout as NodeJS.WriteStream;
  const get = () => ({ cols: tty.columns || 100, rows: Math.max((tty.rows || 30) - 1, 1) });
  const [size, setSize] = useState(get);
  useEffect(() => {
    const on = () => setSize(get());
    stdout.on("resize", on);
    return () => {
      stdout.off("resize", on);
    };
  }, [stdout]);
  return draw(size.cols, size.rows);
}

function fail(code: string, message: string, fix: string): number {
  process.stderr.write(JSON.stringify({ code, message, fix }) + "\n");
  return 2;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function gotOf(v: unknown): Got {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? obj(v) : null;
}

/** What the hook (factory_cockpit_ui.ts) gives a view. */
interface Spec {
  repo: string;
  select: number | null;
  read: string[];
  fresh: string[];
  act: string[];
  changes: string;
  snapshot: Got;
  /** A document view's data, read by the hook; absent: the view reads `read` first. */
  data: Got | undefined;
  /** Colour off a terminal (the hook's rule for this view). */
  color: boolean;
  host: string;
  heavy: Heavy | null;
  /** The light lane setting (`ci.light`), for the CI view's L; null when the hook couldn't read it. */
  light: boolean | null;
  prefill: string;
  /** The command bar's resolver: the typed line and the picked command go after it. */
  resolve: string[];
  /** The row a view opens on (the search's Enter, #392): a task's number, an ask's id, a line's text. */
  find: string;
  /** The search's Enter runs this with the `factory cockpit` arguments of the row's view (`bash <factory> cockpit`). */
  open: string[];
}

function specOf(v: unknown): Spec {
  const o = obj(v);
  const heavy = obj(o.heavy);
  return {
    repo: plain(o.repo), select: typeof o.select === "number" ? o.select : null, read: strings(o.read),
    fresh: strings(o.fresh), act: strings(o.act), changes: plain(o.changes) || "things", snapshot: gotOf(o.snapshot),
    data: "data" in o ? gotOf(o.data) : undefined, color: o.color === true, host: plain(o.host),
    heavy: typeof heavy.raw === "string" ? { raw: plain(heavy.raw), source: plain(heavy.source) } : null,
    light: typeof o.light === "boolean" ? o.light : null,
    prefill: typeof o.prefill === "string" ? o.prefill : "", resolve: strings(o.resolve),
    find: typeof o.find === "string" ? o.find : "", open: strings(o.open),
  };
}

/** The views that are one document: each draws every line of its data at a width. */
const DOCS: Record<string, (s: Spec) => (data: Got | undefined, cols: number) => Line[]> = {
  ci: (s) => (d, cols) => ciLines(d, { heavy: s.heavy, host: s.host }, cols, Date.now()),
  settings: () => (d, cols) => settingsLines(d, cols),
  usage: () => (d, cols) => usageLines(d, cols),
  agents: (s) => (d, cols) => agentsLines(d, s.repo, s.host, cols),
  health: (s) => (d, cols) => healthLines(d, s.repo, cols),
};

const VIEWS = ["prs", "needs", "tasks", "bar", "search", ...Object.keys(DOCS)];

/** Only used when stdin and stdout are terminals. Ink would otherwise treat a set `CI` as "not interactive" and draw
 * nothing until it unmounts: a blank view that still takes keys. */
const ON_A_TERMINAL = { interactive: true } as const;

/** Draws one frame and waits until it is written. */
async function once(el: ReactElement): Promise<void> {
  const ink = render(el, { patchConsole: false });
  ink.unmount();
  await ink.waitUntilExit();
}

async function offTerminal(view: string, spec: Spec): Promise<number> {
  const cols = Number(process.env.COLUMNS) || 100;
  const rows = Number(process.env.LINES) || 30;
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true }); // Ink lays out to it
  const limit = OFF_TERMINAL_SECONDS * 1000;
  let lines: Line[];
  const doc = DOCS[view];
  if (doc) {
    lines = doc(spec)(spec.data !== undefined ? spec.data : await readJson(spec.read, limit), cols);
  } else if (view === "prs") {
    const got = await readJson(spec.read, limit);
    const at = selectedOf(got, spec.select);
    if (typeof at !== "number") return fail(at.code, at.message, at.fix);
    lines = prsLines(got, at, cols, rows, spec.repo, Date.now(), OFF_TERMINAL_SECONDS);
  } else if (view === "tasks") {
    const got = await readJson(spec.read, limit);
    lines = tasksLines(got, taskAt(got, spec.find), cols, rows, spec.repo, OFF_TERMINAL_SECONDS);
  } else if (view === "bar") {
    lines = barLines(spec.prefill, 0, cols, rows);
  } else if (view === "search") {
    lines = searchLines(spec.data ?? null, spec.prefill, 0, cols, rows);
  } else lines = needsLines(spec.snapshot, needAt(spec.snapshot, spec.find), cols, rows, spec.repo, Date.now());
  await once(<Lines lines={lines} color={spec.color} />);
  return 0;
}

function problemOf(o: { [key: string]: unknown }): BarProblem {
  return { code: plain(o.code) || "cockpit_refused", message: plain(o.message), fix: plain(o.fix) };
}

/** The bar's resolver, as a promise of what the line runs or the refusal. */
function resolver(spec: Spec, limit: number): (typed: string, pick: string) => Promise<Resolved | BarProblem> {
  return async (typed, pick) => {
    const got = await readOrRefusal([...spec.resolve, typed, pick], limit);
    if ("refused" in got) return problemOf(got.refused);
    const d = got.data;
    return { words: strings(d.words), action: typeof d.action === "string" ? d.action : null, question: plain(d.question),
      run: strings(d.run) };
  };
}

/** A read-only command picked in the bar: its output through `less -R`, on this terminal. */
function page(run: string[]): number {
  if (!run.length) return 0;
  const p = Bun.spawnSync(["sh", "-c", '"$@" 2>&1 | less -R', "sh", ...run], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return p.exitCode ?? 1;
}

/** The view the search's Enter picked, on this terminal, in place of the search (in the same popup). */
function openPicked(open: string[], args: string[]): number {
  const p = Bun.spawnSync([...open, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return p.exitCode ?? 1;
}

async function onTerminal(view: string, spec: Spec): Promise<number> {
  const color = !process.env.NO_COLOR;
  const limit = ON_TERMINAL_SECONDS * 1000;
  const refused: { p: Problem | null } = { p: null };
  const ended: { o: Outcome } = { o: { kind: "closed" } };
  const picked: { args: string[] | null } = { args: null };
  const doc = DOCS[view];
  let draw: (cols: number, rows: number) => ReactElement;
  if (view === "ci") {
    draw = (cols, rows) => (
      <CiView cols={cols} rows={rows} color={color} data={spec.data} load={() => readJson(spec.read, limit)} find={spec.find}
        x={{ heavy: spec.heavy, host: spec.host, light: spec.light }} run={(steps) => runSteps(spec.act, steps)} />);
  } else if (doc) {
    const lines = doc(spec);
    draw = (cols, rows) => (
      <DocView cols={cols} rows={rows} color={color} data={spec.data} draw={lines} load={() => readJson(spec.read, limit)}
        find={spec.find} />);
  } else if (view === "prs") {
    draw = (cols, rows) => (
      <PrsView repo={spec.repo} select={spec.select} changes={spec.changes} cols={cols} rows={rows} color={color}
        limitSeconds={ON_TERMINAL_SECONDS} load={(fresh) => readJson(fresh ? spec.fresh : spec.read, limit)}
        act={(words) => runAction([...spec.act, ...words])} refuse={(p) => { refused.p = p; }} />);
  } else if (view === "tasks") {
    draw = (cols, rows) => (
      <TasksView repo={spec.repo} cols={cols} rows={rows} color={color} limitSeconds={ON_TERMINAL_SECONDS}
        load={() => readJson(spec.read, limit)} find={spec.find} />);
  } else if (view === "bar") {
    draw = (cols, rows) => (
      <CommandBar prefill={spec.prefill} cols={cols} rows={rows} color={color} resolve={resolver(spec, limit)}
        act={runAction} finish={(o) => { ended.o = o; }} />);
  } else if (view === "search") {
    draw = (cols, rows) => (
      <SearchView data={spec.data ?? null} prefill={spec.prefill} cols={cols} rows={rows} color={color}
        done={(args) => { picked.args = args; }} />);
  } else {
    draw = (cols, rows) => (
      <NeedsView repo={spec.repo} snapshot={spec.snapshot} cols={cols} rows={rows} color={color}
        load={() => readJson(spec.read, limit)} find={spec.find} />);
  }
  await render(<Sized draw={draw} />, ON_A_TERMINAL).waitUntilExit();
  if (picked.args && spec.open.length) return openPicked(spec.open, picked.args);
  const r = refused.p;
  if (r) return fail(r.code, r.message, r.fix);
  const o = ended.o;
  if (o.kind === "refused") return fail(o.problem.code, o.problem.message, o.problem.fix);
  return o.kind === "page" ? page(o.run) : 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--check") {
    console.log("ok");
    return 0;
  }
  if (argv[0] === "--sidebar") {
    const code = await sidebarMain(argv.slice(1));
    if (code !== null) return code;
    return fail("cockpit_ui_usage", "The cockpit's list takes --sidebar --factory <script>.", "Run `factory cockpit`; its left pane starts the list.");
  }
  const view = argv[0] === "--view" && argv.length === 4 && argv[2] === "--data" ? argv[1] : undefined;
  const file = view !== undefined ? argv[3] : argv[0] === "--data" && argv.length === 2 ? argv[1] : undefined;
  if (file === undefined || (view !== undefined && !VIEWS.includes(view))) {
    return fail("cockpit_ui_usage", "The cockpit UI takes --data <file>, --view <name> --data <file> or --check.",
      "Run `factory cockpit --ink`, or a view such as `factory cockpit --prs`; they pass the data.");
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    return fail("cockpit_ui_data", `The snapshot ${file} can't be read (${e instanceof Error ? e.message : String(e)}).`,
      "Run `factory cockpit --json` to see what the snapshot holds, then `factory cockpit --ink` again.");
  }
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (view !== undefined) return tty ? onTerminal(view, specOf(data)) : offTerminal(view, specOf(data));
  if (tty) {
    await render(<Interactive snapshot={data} />, ON_A_TERMINAL).waitUntilExit();
    return 0;
  }
  await once(<App snapshot={data} />);
  return 0;
}

const code = await main(process.argv.slice(2));
// Exit now, once stdout is written: a read that ran out of time may leave a grandchild holding a pipe open.
process.stdout.write("", () => process.exit(code));
