// The cockpit's left pane on Ink (#366): `ui.tsx --sidebar --factory <script>`, started by `factory cockpit --sidebar`.
// It reads its data from `factory cockpit --sidebar-data` (the cached snapshot, the views and how many new owner asks
// ring the bell), again every 5 s and on r, and runs each key's action with `factory cockpit --sidebar-open`, which
// talks to the cockpit's tmux. Off a terminal it draws one frame sized by COLUMNS and LINES, with no colour.
import { render } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { type Actions, type Data, Sidebar, type ViewItem } from "./sidebar.tsx";

const BEL = "\x07";
const RELOAD_MS = 5_000;

type Loaded = Data & { bell: number };

function factoryRun(factory: string, args: string[], output: "pipe" | "ignore"): { code: number; stdout: string } {
  const p = Bun.spawnSync(["bash", factory, "cockpit", ...args], { stdin: "ignore", stdout: output, stderr: "ignore" });
  return { code: p.exitCode ?? 1, stdout: p.stdout?.toString() ?? "" };
}

function views(v: unknown): ViewItem[] {
  return (Array.isArray(v) ? v : []).filter((x): x is { key: unknown; title: unknown } => typeof x === "object" && x !== null)
    .map((x) => ({ key: String(x.key), title: String(x.title) }));
}

/** The data, or null when `factory cockpit --sidebar-data` can't give it (the list keeps what it had). */
function load(factory: string): Loaded | null {
  const r = factoryRun(factory, ["--sidebar-data"], "pipe");
  try {
    const d = JSON.parse(r.stdout) as Record<string, unknown>;
    return { snapshot: d.snapshot ?? null, views: views(d.views), bell: Number(d.bell) || 0 };
  } catch {
    return null;
  }
}

/** `load` without blocking: the list keeps reading keys while Bun starts the factory. */
async function loadLater(factory: string): Promise<Loaded | null> {
  const p = Bun.spawn(["bash", factory, "cockpit", "--sidebar-data"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  try {
    const d = JSON.parse(out) as Record<string, unknown>;
    return { snapshot: d.snapshot ?? null, views: views(d.views), bell: Number(d.bell) || 0 };
  } catch {
    return null;
  }
}

function ring(d: Loaded | null): void {
  if (d && d.bell > 0) process.stdout.write(BEL.repeat(d.bell));
}

function Live({ factory, first }: { factory: string; first: Data }): ReactElement {
  const stdout = process.stdout;
  const [data, setData] = useState<Data>(first);
  const [size, setSize] = useState({ cols: stdout.columns || 32, rows: stdout.rows || 30 });
  const reload = () => {
    void loadLater(factory).then((d) => {
      ring(d);
      if (d) setData(d);
    });
  };
  useEffect(() => {
    const timer = setInterval(reload, RELOAD_MS);
    const resized = () => setSize({ cols: stdout.columns || 32, rows: stdout.rows || 30 });
    stdout.on("resize", resized);
    return () => {
      clearInterval(timer);
      stdout.off("resize", resized);
    };
  }, []);
  const open = (...args: string[]) => factoryRun(factory, ["--sidebar-open", ...args], "ignore");
  const actions: Actions = {
    openSession: (name) => open("session", name),
    openView: (key) => open("view", key),
    bar: (words) => open("bar", ...words),
    reload,
    // Only detach: the pane runs this list with exec, so the list ending would close the pane for the next visit.
    leave: () => open("leave"),
  };
  return <Sidebar data={data} cols={size.cols} rows={size.rows} color={true} actions={actions} />;
}

const NONE: Actions = { openSession() {}, openView() {}, bar() {}, reload() {}, leave() {} };

/** `--sidebar --factory <script>`; returns the exit code, or null for arguments that aren't these. */
export async function sidebarMain(argv: string[]): Promise<number | null> {
  const factory = argv[0] === "--factory" && argv.length === 2 ? argv[1] : undefined;
  if (factory === undefined) return null;
  const first = load(factory);
  ring(first);
  const data: Data = first ?? { snapshot: null, views: [] };
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await render(<Live factory={factory} first={data} />).waitUntilExit();
    return 0;
  }
  const cols = Number(process.env.COLUMNS) || 32;
  const rows = Number(process.env.LINES) || 30;
  const ink = render(<Sidebar data={data} cols={cols} rows={rows} color={false} actions={NONE} keys={false} />,
    { patchConsole: false });
  ink.unmount();
  await ink.waitUntilExit();
  return 0;
}
