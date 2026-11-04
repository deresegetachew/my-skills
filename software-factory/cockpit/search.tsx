// The cockpit's search (#392, PRD US-10): one box that matches as you type, across the rows of every view. The hook
// (`factory cockpit --search`, factory_cockpit_ui.ts) reads the rows once, from the cockpit's cache and this machine's
// files, so a keystroke makes no GitHub call. Results are grouped by view and each says which view it is from; Enter
// ends the search with the row picked, and the caller opens that view on it (ui.tsx); Esc closes. `/` inside a view
// opens the same box with only that view's rows (`scope`).
import { useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { cut, type Line, Lines, plain, screen, seg } from "./views/lines.tsx";

/** One row of one view. `find` is what that view uses to select the row when it opens. */
export interface SearchItem {
  view: string;
  title: string;
  text: string;
  find: string;
}

export type SearchOutcome = { kind: "open"; view: string; find: string } | { kind: "closed" };

export interface SearchProps {
  items: SearchItem[];
  /** A view's key: only that view's rows; null for every view. */
  scope: string | null;
  /** The words typed in already. */
  prefill: string;
  cols: number;
  rows: number;
  color: boolean;
  finish: (o: SearchOutcome) => void;
}

export const SEARCH_KEYS = "Type to narrow · ↑↓ move · Enter opens · Esc closes";

/** The items whose text has every word of `typed` (case-insensitive), grouped by view in the order of the views. */
export function found(items: SearchItem[], scope: string | null, typed: string): SearchItem[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = items.filter((i) => (scope === null || i.view === scope) && words.every((w) => i.text.toLowerCase().includes(w)));
  const order = [...new Set(hits.map((i) => i.view))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return order.flatMap((v) => hits.filter((i) => i.view === v));
}

/** One screen of the search: the box, the keys, and the results with the selected one marked and in view. */
export function searchLines(items: SearchItem[], scope: string | null, typed: string, at: number, cols: number, rows: number): Line[] {
  const hits = found(items, scope, typed);
  const where = scope === null ? "" : ` in ${items.find((i) => i.view === scope)?.title ?? `view ${plain(scope)}`}`;
  const head: Line[] = [[seg(`Search${where}: `, "dim"), seg(typed)], []];
  const body: Line[] = [];
  let selLine = 0;
  if (!hits.length) {
    body.push([seg(typed.trim() ? `No match for "${plain(typed)}".` : "Nothing to search yet.", "dim")]);
  }
  let last = "";
  hits.forEach((h, i) => {
    if (h.view !== last) {
      last = h.view;
      body.push([seg(`${plain(h.view)} ${plain(h.title)}`, "amber")]);
    }
    if (i === at) selLine = body.length;
    body.push(i === at ? [seg(`› ${plain(h.text)}`, "bold")] : [seg(`  ${plain(h.text)}`)]);
  });
  const room = Math.max(rows - head.length - 1, 1);
  const start = Math.min(Math.max(selLine - room + 1, 0), Math.max(body.length - room, 0));
  return screen([...head, ...body.slice(start, start + room)], SEARCH_KEYS, cols, rows);
}

export function SearchView(props: SearchProps): ReactElement {
  const { exit } = useApp();
  const [typed, setTyped] = useState(props.prefill);
  const [at, setAt] = useState(0);
  const end = (o: SearchOutcome) => {
    props.finish(o);
    exit();
  };
  useInput((input, key) => {
    const hits = found(props.items, props.scope, typed);
    if (key.escape || (key.ctrl && input === "c")) return end({ kind: "closed" });
    if (key.return) {
      const h = hits[Math.min(at, hits.length - 1)];
      if (h) end({ kind: "open", view: h.view, find: h.find });
      return;
    }
    if (key.upArrow) return setAt((a) => Math.max(a - 1, 0));
    if (key.downArrow) return setAt((a) => Math.min(a + 1, Math.max(hits.length - 1, 0)));
    if (key.backspace || key.delete) setTyped((t) => t.slice(0, -1));
    else if (/^[\x20-\x7e]+$/.test(input) && !key.ctrl && !key.meta) setTyped((t) => t + input);
    else return;
    setAt(0);
  });
  const lines = searchLines(props.items, props.scope, typed, at, props.cols, props.rows);
  return <Lines lines={lines.map((l) => cut(l, props.cols))} color={props.color} />;
}
