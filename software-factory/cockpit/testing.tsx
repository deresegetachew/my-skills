// The cockpit's screens drawn with ink-testing-library, for the tests (tests/cockpit_ink.test.ts, cockpit_sidebar.test.ts):
// only this folder may import Ink or React (decision 0002), so the tests come through here. Not part of the bundle.
import { render } from "ink-testing-library";
import { App } from "./app.tsx";
import { type Actions, type Data, Sidebar } from "./sidebar.tsx";

/** The screen for `snapshot`, as text, as a terminal would show it. */
export function frameOf(snapshot: unknown): string {
  const r = render(<App snapshot={snapshot} />);
  const frame = r.lastFrame() ?? "";
  r.unmount();
  return frame;
}

export interface SidebarRun {
  /** The screen now, as text. */
  frame(): string;
  /** Types `keys` (raw terminal input, such as "\r" or "\x1b[B") and waits for the screen to be drawn again. */
  press(keys: string): Promise<void>;
  /** Each action a key asked for, as words: "session haile", "view 2", "bar say haile", "reload", "leave". */
  calls: string[];
  unmount(): void;
}

/** The sidebar for `data` at `cols` x `rows`, reading keys, with its actions recorded. */
export function sidebarOf(data: Data, cols = 40, rows = 30, color = false): SidebarRun {
  const calls: string[] = [];
  const actions: Actions = {
    openSession: (name) => calls.push(`session ${name}`),
    openView: (key) => calls.push(`view ${key}`),
    bar: (words) => calls.push(["bar", ...words].join(" ")),
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
    unmount: () => r.unmount(),
  };
}
