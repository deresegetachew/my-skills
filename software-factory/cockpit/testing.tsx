// The cockpit's screens drawn with ink-testing-library, for the tests (tests/cockpit_ink.test.ts, cockpit_views.test.ts):
// only this folder may import Ink or React (decision 0002), so the tests come through here. Not part of the bundle.
import chalk from "chalk";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { App } from "./app.tsx";
import { type NeedsProps, NeedsView } from "./views/needs.tsx";
import { type PrsProps, PrsView } from "./views/prs.tsx";

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

export type { NeedsProps, PrsProps };

export function drawPrs(p: PrsProps): Drawn {
  return draw(<PrsView {...p} />, p.cols, p.color);
}

export function drawNeeds(p: NeedsProps): Drawn {
  return draw(<NeedsView {...p} />, p.cols, p.color);
}
