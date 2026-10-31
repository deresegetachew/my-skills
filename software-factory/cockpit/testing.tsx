// The cockpit's screens drawn with ink-testing-library, for the tests (tests/cockpit_ink.test.ts): only this folder may
// import Ink or React (decision 0002), so the tests come through here. Not part of the bundle.
import { render } from "ink-testing-library";
import { App } from "./app.tsx";

/** The screen for `snapshot`, as text, as a terminal would show it. */
export function frameOf(snapshot: unknown): string {
  const r = render(<App snapshot={snapshot} />);
  const frame = r.lastFrame() ?? "";
  r.unmount();
  return frame;
}
