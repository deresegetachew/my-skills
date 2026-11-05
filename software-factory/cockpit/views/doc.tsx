// A view that is one document (#367): CI, Settings, Usage & lessons, Agents & machines, Health & releases. It draws
// every line of its data; on a terminal it shows a screenful, j k (or ↑ ↓, space) scroll, / keeps the lines that match
// what is typed (#392, views/filter.ts), r reads the data again and q closes. Off a terminal the caller prints the whole document once. Also the helpers these views share: plain text cut,
// padded and wrapped, and the boxes ("cards") the boards draw.
import { type Key, useApp, useInput } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { type Filter, filterKey, filterKeys, matchesTyped, NO_FILTER, noMatch } from "./filter.ts";
import { cut, type Line, Lines, plain, screen, seg, type Style, wrap } from "./lines.tsx";
import type { Got } from "./read.ts";

export const DOC_KEYS = "j k scroll · r read again · q close";

/** `s` cut to `w` characters, an ellipsis where it was cut. */
export function clip(s: string, w: number): string {
  const cs = [...s];
  if (w <= 0) return "";
  return cs.length <= w ? s : `${cs.slice(0, w - 1).join("")}…`;
}

/** `s` cut or padded to `w` characters. */
export function padStr(s: string, w: number): string {
  const t = clip(s, w);
  return t + " ".repeat(Math.max(w - [...t].length, 0));
}

/** Words (or the parts between `sep`) wrapped to `w` columns; one longer than that is cut. */
export function wrapText(text: string, w: number, sep = " "): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(sep).filter(Boolean)) {
    if (cur && [...cur].length + [...sep].length + [...word].length > w) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}${sep}${word}` : clip(word, w);
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

/** Text wrapped to `w`, each line in one style. */
export function para(text: string, w: number, style?: Style, sep = " "): Line[] {
  return wrapText(text, w, sep).map((t) => [seg(t, style)]);
}

/** `left` with `right` at the end of a line `w` wide; `right` goes under it when both don't fit. */
export function heading(left: Line, right: string, w: number): Line[] {
  const lw = left.reduce((n, s) => n + [...s.text].length, 0);
  if (w - lw >= [...right].length + 2) return [[...left, seg(" ".repeat(w - lw - [...right].length)), seg(right, "dim")]];
  return [cut(left, w), ...para(right, w, "dim")];
}

export interface Card {
  title: string;
  lines: Array<[string, Style | undefined]>;
  warn: boolean;
}

/** The cards side by side (one row of boxes) from 96 columns, else one under the other. */
export function cards(cs: Card[], w: number): Line[] {
  const side = w >= 96;
  const gap = 2;
  const cw = side ? Math.floor((w - gap * (cs.length - 1)) / cs.length) : w;
  const inner = Math.max(cw - 4, 1);
  const boxes = cs.map((c) => {
    const body: Array<[string, Style | undefined]> = [[c.title, "dim"]];
    for (const [text, style] of c.lines) for (const l of wrapText(text, inner)) body.push([l, style]);
    return { c, body };
  });
  const tall = Math.max(...boxes.map((b) => b.body.length));
  const drawn = boxes.map(({ c, body }) => {
    const edge: Style = c.warn ? "amber" : "dim";
    const rows: Line[] = [[seg(`┌${"─".repeat(Math.max(cw - 2, 0))}┐`, edge)]];
    for (let i = 0; i < (side ? tall : body.length); i++) {
      const [text, style] = body[i] ?? ["", undefined];
      rows.push([seg("│", edge), seg(" "), seg(padStr(text, inner), style), seg(" "), seg("│", edge)]);
    }
    rows.push([seg(`└${"─".repeat(Math.max(cw - 2, 0))}┘`, edge)]);
    return rows;
  });
  if (!side) return drawn.flat();
  return (drawn[0] ?? []).map((_, i) => drawn.flatMap((d, j) => [...(j ? [seg(" ".repeat(gap))] : []), ...(d[i] ?? [])]));
}

/** One screen of a document: `rows` lines from line `top`, the last one the keys. */
export function docScreen(doc: Line[], top: number, cols: number, rows: number, keys = DOC_KEYS): Line[] {
  const room = Math.max(rows - 1, 1);
  const at = Math.min(Math.max(top, 0), Math.max(doc.length - room, 0));
  return screen(doc.slice(at, at + room), keys, cols, rows);
}

/** A line's text, without its styles. */
export function textOf(l: Line): string {
  return l.map((s) => s.text).join("");
}

/** How much of the start of `want` the line shows cut with `…` (as `clip` cuts it); 0 when it shows none. */
function clippedPrefix(text: string, want: string): number {
  const cs = [...want];
  for (let n = cs.length - 1; n > 0; n--) if (text.includes(`${cs.slice(0, n).join("")}…`)) return n;
  return 0;
}

/** Fewer characters than this before a `…` could be the start of almost anything. */
const CLIPPED_MIN = 8;

/** The index of the first line with `find` in it, in any case; else the line that shows the longest start of it cut
 *  short (a narrow screen clips a row), when that is at least CLIPPED_MIN characters; 0 when none has it. */
export function lineWith(doc: Line[], find: string): number {
  const want = find.toLowerCase();
  if (!want) return 0;
  const texts = doc.map((l) => textOf(l).toLowerCase());
  const whole = texts.findIndex((t) => t.includes(want));
  if (whole >= 0) return whole;
  let best = 0;
  let at = 0;
  texts.forEach((t, i) => {
    const n = clippedPrefix(t, want);
    if (n > best) [best, at] = [n, i];
  });
  return best >= CLIPPED_MIN ? at : 0;
}

/** The lines of `doc` that match the filter (#392), or the line that says none does. */
export function filtered(doc: Line[], typed: string): Line[] {
  if (!typed.trim()) return doc;
  const kept = doc.filter((l) => textOf(l).trim() && matchesTyped(textOf(l), typed));
  return kept.length ? kept : [noMatch(typed)];
}

/** What a view's own key does (#396): ask y/N before running steps, run read-only steps at once ("open"), show a note,
 *  or nothing more ("done", the view changed its own state). A step is a command's words. */
export type DocAction = { kind: "ask"; steps: string[][]; does: string } | { kind: "open"; steps: string[][] }
  | { kind: "note"; text: string } | { kind: "done" };

export const NOT_RUN = "Not run: nothing changed.";

/** The question asked before an action's steps run. */
export function stepsQuestion(steps: string[][], does: string): string {
  return `Run \`${steps.map((s) => s.join(" ")).join("` then `")}\`? It ${does}. [y/N] `;
}

type Mode = { kind: "doc" } | { kind: "ask"; steps: string[][]; does: string } | { kind: "running"; steps: string[][] }
  | { kind: "shown"; text: string; reload: boolean } | { kind: "note"; text: string };

export interface DocProps {
  cols: number;
  rows: number;
  color: boolean;
  /** The data the view opens on; undefined: it reads it first. */
  data?: Got;
  /** Every line of the document, for this data (undefined: still reading) at this width. */
  draw: (data: Got | undefined, cols: number) => Line[];
  /** Reads the data again. */
  load: () => Promise<Got>;
  keys?: string;
  /** Opens scrolled to the first line with this text (the search's Enter, #392). */
  find?: string;
  /** The view's own keys, after the document's (#396); null: the key does nothing. */
  act?: (input: string, key: Key, data: Got) => DocAction | null;
  /** Runs an action's steps and gives the output to show. */
  run?: (steps: string[][]) => Promise<string>;
}

/** The screen while an action asks, runs or shows its output. */
function actionLines(mode: Exclude<Mode, { kind: "doc" }>, cols: number, rows: number): Line[] {
  if (mode.kind === "ask") return [...wrap(stepsQuestion(mode.steps, mode.does), cols, "amber"), [seg("y runs it · any other key does nothing", "dim")]];
  if (mode.kind === "running") return wrap(`Running \`${mode.steps.map((s) => s.join(" ")).join("` then `")}\`…`, cols);
  if (mode.kind === "note") return screen([...wrap(mode.text, cols)], "any key goes back", cols, rows);
  const out = mode.text.split("\n").map((t): Line => [seg(plain(t))]);
  const room = Math.max(rows - 3, 1); // the end of the output matters most: a log's failing step, an install's result
  const shown = out.length > room ? [[seg(`… ${out.length - room + 1} lines above`, "dim")], ...out.slice(-(room - 1))] : out;
  return screen([...shown, [], [seg("Press a key to go on.")]], mode.reload ? "any key reads the view again" : "any key goes back", cols, rows);
}

/** A document on a terminal: a screenful at a time, j k scroll, / filters, r reads again, q closes; the view's own keys
 *  (`act`) ask, run and show their output. */
export function DocView(props: DocProps): ReactElement {
  const { exit } = useApp();
  const [data, setData] = useState<Got | undefined>(props.data);
  const [top, setTop] = useState(() => (props.find && props.data !== undefined ? lineWith(props.draw(props.data, props.cols), props.find) : 0));
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [mode, setMode] = useState<Mode>({ kind: "doc" });
  useEffect(() => {
    if (props.data === undefined) {
      void props.load().then((got) => {
        setData(got);
        if (props.find) setTop(lineWith(props.draw(got, props.cols), props.find));
      });
    }
  }, []);
  const doc = filtered(props.draw(data, props.cols), filter.typed);
  const room = Math.max(props.rows - 1, 1);
  const last = Math.max(doc.length - room, 0);
  const runSteps = (steps: string[][], reload: boolean) => {
    setMode({ kind: "running", steps });
    void (props.run ?? (() => Promise.resolve("")))(steps).then((text) => setMode({ kind: "shown", text, reload }));
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") return exit();
    if (mode.kind === "running") return; // an action runs to its end
    if (mode.kind === "ask") {
      if (/^y$/i.test(input)) runSteps(mode.steps, true);
      else setMode({ kind: "note", text: NOT_RUN });
      return;
    }
    if (mode.kind === "shown" && mode.reload) {
      setMode({ kind: "doc" });
      setData(undefined);
      void props.load().then(setData);
      return;
    }
    if (mode.kind !== "doc") return setMode({ kind: "doc" });
    const next = data === undefined ? null : filterKey(filter, input, key);
    if (next) {
      setFilter((f) => filterKey(f, input, key) ?? f); // keys in one chunk each see the one before
      setTop(0);
    } else if (input === "q" || key.escape) exit();
    else if (data === undefined) return; // reading
    else if (input === "j" || key.downArrow) setTop((t) => Math.min(t + 1, last));
    else if (input === "k" || key.upArrow) setTop((t) => Math.max(t - 1, 0));
    else if (input === " " || key.pageDown) setTop((t) => Math.min(t + room, last));
    else if (key.pageUp) setTop((t) => Math.max(t - room, 0));
    else if (input === "r") {
      setData(undefined);
      void props.load().then(setData);
    } else if (props.act) {
      const a = props.act(input, key, data);
      if (a?.kind === "ask") setMode({ kind: "ask", steps: a.steps, does: a.does });
      else if (a?.kind === "open") runSteps(a.steps, false);
      else if (a?.kind === "note") setMode({ kind: "note", text: a.text });
    }
  });
  if (mode.kind !== "doc") return <Lines lines={actionLines(mode, props.cols, props.rows).map((l) => cut(l, props.cols))} color={props.color} />;
  const lines = docScreen(doc, Math.min(top, last), props.cols, props.rows, filterKeys(filter, props.keys ?? DOC_KEYS));
  return <Lines lines={lines.map((l) => cut(l, props.cols))} color={props.color} />;
}
