// The cockpit's `:` command bar on Ink (#309, #367): type to pick one of the factory's read-only commands or the owner's
// actions, the best fuzzy match first (hooks/factory_cockpit_match.ts, the same match `factory cockpit --bar` uses off a
// terminal). Enter asks the hook what the line runs (`factory cockpit --bar-resolve`), so the rules about what the
// cockpit never offers (the agents' and the gate's commands, flags, extra words) stay in one place. An action asks
// first, and runs only on y; a read-only command closes the bar and the caller pages its output. Esc closes.
import { useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { matches } from "../hooks/factory_cockpit_match.ts";
import { para } from "./views/doc.tsx";
import { cut, type Line, Lines, plain, screen, seg } from "./views/lines.tsx";

export const NOT_RUN = "Not run: nothing changed.";

export interface Problem {
  code: string;
  message: string;
  fix: string;
}

/** What a line runs, as the hook resolved it. */
export interface Resolved {
  words: string[];
  /** The owner's action it is, or null for a read-only command. */
  action: string | null;
  question: string;
  /** The command to run, as arguments. */
  run: string[];
}

/** How the bar ended: a read-only command to page, a refusal to print, or closed. */
export type Outcome = { kind: "page"; run: string[] } | { kind: "refused"; problem: Problem } | { kind: "closed" };

export interface BarProps {
  /** The words typed in already (`factory cockpit --bar say haile`). */
  prefill: string;
  cols: number;
  rows: number;
  color: boolean;
  /** What the typed line (or the picked command) runs; a Problem when the cockpit refuses it. */
  resolve: (typed: string, pick: string) => Promise<Resolved | Problem>;
  /** Runs an action and gives its output. */
  act: (run: string[]) => Promise<string>;
  finish: (o: Outcome) => void;
}

type Mode = { kind: "typing" } | { kind: "checking" } | { kind: "ask"; r: Resolved } | { kind: "running" }
  | { kind: "shown"; text: string } | { kind: "refused"; p: Problem };

const KEYS = "Type to pick · ↑↓ · Enter runs it (an action asks first) · Esc closes";

/** The bar's screen while typing: the line, the keys, the matches with the picked one marked. */
export function barLines(typed: string, at: number, cols: number, rows: number): Line[] {
  const found = matches(typed);
  const room = Math.max(rows - 3, 1);
  const start = Math.min(Math.max(at - room + 1, 0), Math.max(found.length - room, 0));
  const shown = found.slice(start, start + room).map((m, i): Line =>
    (start + i === at ? [seg(`› ${m}`, "amber")] : [seg(`  ${m}`)]));
  const body: Line[] = [[seg("factory ", "dim"), seg(typed)], [seg(KEYS, "dim")], [],
    ...(found.length ? shown : [[seg("  no command the cockpit offers matches", "dim")]])];
  return body.slice(0, Math.max(rows, 1)).map((l) => cut(l, cols));
}

function isProblem(r: Resolved | Problem): r is Problem {
  return "code" in r;
}

export function CommandBar(props: BarProps): ReactElement {
  const { exit } = useApp();
  const [typed, setTyped] = useState(props.prefill);
  const [at, setAt] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "typing" });
  const end = (o: Outcome) => {
    props.finish(o);
    exit();
  };
  useInput((input, key) => {
    if (mode.kind === "checking" || mode.kind === "running") return;
    if (mode.kind === "shown") return end({ kind: "closed" });
    if (mode.kind === "refused") return end({ kind: "refused", problem: mode.p });
    if (mode.kind === "ask") {
      if (/^y$/i.test(input)) {
        setMode({ kind: "running" });
        void props.act(mode.r.run).then((text) => setMode({ kind: "shown", text }));
      } else setMode({ kind: "shown", text: NOT_RUN });
      return;
    }
    if (key.escape || (key.ctrl && input === "c")) return end({ kind: "closed" });
    if (key.return) {
      setMode({ kind: "checking" });
      void props.resolve(typed, matches(typed)[at] ?? "").then((r) => {
        if (isProblem(r)) setMode({ kind: "refused", p: r });
        else if (r.action) setMode({ kind: "ask", r });
        else end({ kind: "page", run: r.run });
      });
      return;
    }
    if (key.upArrow) return setAt((a) => Math.max(a - 1, 0));
    if (key.downArrow) return setAt((a) => Math.min(a + 1, Math.max(matches(typed).length - 1, 0)));
    if (key.backspace || key.delete) setTyped((t) => t.slice(0, -1));
    else if (/^[\x20-\x7e]+$/.test(input) && !key.ctrl && !key.meta) setTyped((t) => t + input);
    else return;
    setAt(0);
  });
  const { cols, rows } = props;
  let lines: Line[];
  if (mode.kind === "checking") lines = [[seg(`factory ${typed}`)], [seg("Checking it…", "dim")]];
  else if (mode.kind === "running") lines = [[seg("Running it…")]];
  else if (mode.kind === "ask") lines = [[seg(plain(mode.r.question), "amber")], [seg("y runs it · any other key does nothing", "dim")]];
  else if (mode.kind === "shown") {
    lines = screen(mode.text.split("\n").map((t): Line => [seg(plain(t))]), "Press a key to go on.", cols, rows);
  } else if (mode.kind === "refused") {
    lines = screen([...para(plain(mode.p.message), cols, "red"), ...para(`fix: ${plain(mode.p.fix)}`, cols, "dim")],
      "Press a key to close.", cols, rows);
  } else lines = barLines(typed, at, cols, rows);
  return <Lines lines={lines.map((l) => cut(l, cols))} color={props.color} />;
}
