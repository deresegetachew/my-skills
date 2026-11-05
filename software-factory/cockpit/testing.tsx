// The cockpit's screens drawn with ink-testing-library, for the tests (tests/cockpit_ink.test.ts, cockpit_views.test.ts,
// cockpit_sidebar.test.ts, cockpit_chat.test.ts): only this folder may import Ink or React (decision 0002), so the tests come through here.
// Not part of the bundle.
import chalk from "chalk";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { App } from "./app.tsx";
import { type BarProps, CommandBar, type Outcome, type Problem, type Resolved } from "./command-bar.tsx";
import { type ChatProps, type ChatReply, ChatView, type Turn } from "./views/chat.tsx";
import { type SearchProps, SearchView } from "./search.tsx";
import { type Actions, type Data, Sidebar } from "./sidebar.tsx";
import { agentsLines } from "./views/agents.tsx";
import { ciLines, CiView, type Heavy } from "./views/ci.tsx";
import { DocView } from "./views/doc.tsx";
import { healthLines } from "./views/health.tsx";
import type { Line } from "./views/lines.tsx";
import { type NeedsProps, NeedsView } from "./views/needs.tsx";
import { type PrsProps, PrsView } from "./views/prs.tsx";
import type { Got } from "./views/read.ts";
import { settingsLines } from "./views/settings.tsx";
import { type TasksProps, TasksView } from "./views/tasks.tsx";
import { usageLines } from "./views/usage.tsx";

/** The screen for `snapshot`, as text, as a terminal would show it. */
export function frameOf(snapshot: unknown): string {
  const r = render(<App snapshot={snapshot} />);
  const frame = r.lastFrame() ?? "";
  r.unmount();
  return frame;
}

export interface Drawn {
  /** The screen now, as the terminal shows it (with escape sequences when colour is on). */
  frame: () => string;
  /** Types keys, then waits for the view to draw again. */
  press: (keys: string) => Promise<void>;
  /** Waits for reads and actions the view started. */
  settle: () => Promise<void>;
  unmount: () => void;
}

/** Draws `el` on a terminal `cols` wide; `color` turns the terminal's colours on (the test runner sets NO_COLOR). */
function draw(el: ReactElement, cols: number, color: boolean): Drawn {
  chalk.level = color ? 1 : 0;
  const r = render(el);
  Object.defineProperty(r.stdout, "columns", { value: cols, configurable: true });
  r.stdout.emit("resize");
  r.rerender(el);
  const settle = () => Bun.sleep(30);
  return {
    frame: () => r.lastFrame() ?? "",
    press: async (keys: string) => {
      await settle();
      r.stdin.write(keys);
      await settle();
    },
    settle,
    unmount: () => r.unmount(),
  };
}

export type { BarProps, ChatProps, ChatReply, NeedsProps, Outcome, Problem, PrsProps, Resolved, SearchProps, TasksProps, Turn };

/** The talk with a role (#395). */
export function drawChat(p: ChatProps): Drawn {
  return draw(<ChatView {...p} />, p.cols, p.color);
}

export function drawPrs(p: PrsProps): Drawn {
  return draw(<PrsView {...p} />, p.cols, p.color);
}

export function drawNeeds(p: NeedsProps): Drawn {
  return draw(<NeedsView {...p} />, p.cols, p.color);
}

export function drawTasks(p: TasksProps): Drawn {
  return draw(<TasksView {...p} />, p.cols, p.color);
}

export function drawBar(p: BarProps): Drawn {
  return draw(<CommandBar {...p} />, p.cols, p.color);
}

export function drawSearch(p: SearchProps): Drawn {
  return draw(<SearchView {...p} />, p.cols, p.color);
}

/** The views that are one document, by the name `ui.tsx --view` takes. */
export type DocName = "ci" | "settings" | "usage" | "agents" | "health";

export interface DocOpts {
  cols: number;
  rows: number;
  color: boolean;
  /** The data it opens on; undefined: it reads first. */
  data?: Got;
  load: () => Promise<Got>;
  repo?: string;
  host?: string;
  heavy?: Heavy | null;
  /** The clock, for the CI view's "as of". */
  now?: number;
  /** Opens scrolled to the first line with this text (#392). */
  find?: string;
}

export function drawDoc(name: DocName, o: DocOpts): Drawn {
  const repo = o.repo ?? "work";
  const host = o.host ?? "dev-pc";
  const lines: Record<DocName, (d: Got | undefined, cols: number) => Line[]> = {
    ci: (d, cols) => ciLines(d, { heavy: o.heavy === undefined ? { raw: "2", source: "this machine" } : o.heavy, host }, cols, o.now ?? Date.now()),
    settings: (d, cols) => settingsLines(d, cols),
    usage: (d, cols) => usageLines(d, cols),
    agents: (d, cols) => agentsLines(d, repo, host, cols),
    health: (d, cols) => healthLines(d, repo, cols),
  };
  return draw(<DocView cols={o.cols} rows={o.rows} color={o.color} data={o.data} draw={lines[name]} load={o.load} find={o.find} />,
    o.cols, o.color);
}

export interface CiOpts {
  cols: number;
  rows: number;
  color: boolean;
  /** The snapshot it opens on; undefined: it reads first. */
  data?: Got;
  load: () => Promise<Got>;
  host?: string;
  heavy?: Heavy | null;
  /** The light lane setting (`ci.light`); default on. */
  light?: boolean | null;
  now?: number;
  /** Runs an action's steps (a factory step starts with "factory") and gives the output to show. */
  run: (steps: string[][]) => Promise<string>;
}

/** The CI view on a terminal, with its keys (#396). */
export function drawCi(o: CiOpts): Drawn {
  const x = { heavy: o.heavy === undefined ? { raw: "2", source: "this machine" } : o.heavy, host: o.host ?? "dev-pc",
    light: o.light === undefined ? true : o.light };
  return draw(<CiView cols={o.cols} rows={o.rows} color={o.color} data={o.data} load={o.load} x={x} run={o.run}
    now={() => o.now ?? Date.now()} />, o.cols, o.color);
}

export interface SidebarRun {
  /** The screen now, as text. */
  frame(): string;
  /** Types `keys` (raw terminal input, such as "\r" or "\x1b[B") and waits for the screen to be drawn again. */
  press(keys: string): Promise<void>;
  /** Each action a key asked for, as words: "session haile", "view 2", "bar say haile", "search", "reload", "leave". */
  calls: string[];
  /** Draws the list again with new data, as a reload does. */
  update(data: Data): Promise<void>;
  unmount(): void;
}

/** The sidebar for `data` at `cols` x `rows`, reading keys, with its actions recorded. */
export function sidebarOf(data: Data, cols = 40, rows = 30, color = false): SidebarRun {
  const calls: string[] = [];
  const actions: Actions = {
    openSession: (name) => calls.push(`session ${name}`),
    openView: (key) => calls.push(`view ${key}`),
    bar: (words) => calls.push(["bar", ...words].join(" ")),
    search: () => calls.push("search"),
    reload: () => calls.push("reload"),
    leave: () => calls.push("leave"),
  };
  const r = render(<Sidebar data={data} cols={cols} rows={rows} color={color} actions={actions} />);
  return {
    frame: () => r.lastFrame() ?? "",
    press: async (keys) => {
      r.stdin.write(keys);
      await new Promise((done) => setTimeout(done, 30));
    },
    calls,
    update: async (next) => {
      r.rerender(<Sidebar data={next} cols={cols} rows={rows} color={color} actions={actions} />);
      await new Promise((done) => setTimeout(done, 30));
    },
    unmount: () => r.unmount(),
  };
}
