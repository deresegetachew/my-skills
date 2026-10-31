#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The cockpit's Ink UI (decision 0002, #365). A release carries it as one JavaScript file, built with `bun build`
// (tools/build_cockpit.ts), installed as .claude/hooks/factory_cockpit_ink.js: a project runs it with Bun and needs no
// node_modules. In this repo it runs from this source.
//
//   ui.tsx --data <file>                 draw the snapshot in <file> (`factory cockpit --json`); on a terminal q or Esc
//                                        leaves, off one it draws once and exits
//   ui.tsx --view <name> --data <file>   one of the cockpit's views (#367): prs, needs. <file> is what the hook gives
//                                        it (the commands that read its data and run the owner's action, the cache).
//                                        On a terminal it reads the keys; off one it draws one frame, sized by COLUMNS
//                                        and LINES, without colour, and exits within a time limit
//   ui.tsx --check                       print "ok": every module loaded (`factory doctor` runs it)
//   ui.tsx --sidebar --factory <script>  the cockpit's left pane, sessions and views (#366, sidebar-host.tsx)
import { readFileSync } from "node:fs";
import { render, useApp, useInput, useStdout } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { App } from "./app.tsx";
import { sidebarMain } from "./sidebar-host.tsx";
import { Lines, obj, plain } from "./views/lines.tsx";
import { needsLines, NeedsView } from "./views/needs.tsx";
import { type Problem, prsLines, PrsView, selectedOf } from "./views/prs.tsx";
import { type Got, readJson, runAction } from "./views/read.ts";

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

/** What the hook (factory_cockpit_ui.ts) gives a view. */
interface Spec {
  repo: string;
  select: number | null;
  read: string[];
  fresh: string[];
  act: string[];
  changes: string;
  snapshot: Got;
}

function specOf(v: unknown): Spec {
  const o = obj(v);
  const snap = o.snapshot;
  return {
    repo: plain(o.repo), select: typeof o.select === "number" ? o.select : null, read: strings(o.read),
    fresh: strings(o.fresh), act: strings(o.act), changes: plain(o.changes) || "things",
    snapshot: typeof snap === "object" && snap !== null && !Array.isArray(snap) ? obj(snap) : null,
  };
}

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
  if (view === "prs") {
    const got = await readJson(spec.read, OFF_TERMINAL_SECONDS * 1000);
    const at = selectedOf(got, spec.select);
    if (typeof at !== "number") return fail(at.code, at.message, at.fix);
    await once(<Lines lines={prsLines(got, at, cols, rows, spec.repo, Date.now(), OFF_TERMINAL_SECONDS)} color={false} />);
    return 0;
  }
  await once(<Lines lines={needsLines(spec.snapshot, 0, cols, rows, spec.repo, Date.now())} color={false} />);
  return 0;
}

async function onTerminal(view: string, spec: Spec): Promise<number> {
  const color = !process.env.NO_COLOR;
  const limit = ON_TERMINAL_SECONDS * 1000;
  const refused: { p: Problem | null } = { p: null };
  const draw = view === "prs"
    ? (cols: number, rows: number) => (
      <PrsView repo={spec.repo} select={spec.select} changes={spec.changes} cols={cols} rows={rows} color={color}
        limitSeconds={ON_TERMINAL_SECONDS} load={(fresh) => readJson(fresh ? spec.fresh : spec.read, limit)}
        act={(words) => runAction([...spec.act, ...words])} refuse={(p) => { refused.p = p; }} />)
    : (cols: number, rows: number) => (
      <NeedsView repo={spec.repo} snapshot={spec.snapshot} cols={cols} rows={rows} color={color}
        load={() => readJson(spec.read, limit)} />);
  await render(<Sized draw={draw} />, ON_A_TERMINAL).waitUntilExit();
  const r = refused.p;
  return r ? fail(r.code, r.message, r.fix) : 0;
}

const VIEWS = ["prs", "needs"];

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
