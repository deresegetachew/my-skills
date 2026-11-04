// A view that is one document (#367): CI, Settings, Usage & lessons, Agents & machines, Health & releases. It draws
// every line of its data; on a terminal it shows a screenful, j k (or ↑ ↓, space) scroll, r reads the data again and q
// closes. Off a terminal the caller prints the whole document once. Also the helpers these views share: plain text cut,
// padded and wrapped, and the boxes ("cards") the boards draw.
import { useApp, useInput } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { cut, type Line, Lines, screen, seg, type Style } from "./lines.tsx";
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
}

/** A document on a terminal: a screenful at a time, j k scroll, r reads again, q closes. */
export function DocView(props: DocProps): ReactElement {
  const { exit } = useApp();
  const [data, setData] = useState<Got | undefined>(props.data);
  const [top, setTop] = useState(0);
  useEffect(() => {
    if (props.data === undefined) void props.load().then(setData);
  }, []);
  const doc = props.draw(data, props.cols);
  const room = Math.max(props.rows - 1, 1);
  const last = Math.max(doc.length - room, 0);
  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
    else if (data === undefined) return; // reading
    else if (input === "j" || key.downArrow) setTop((t) => Math.min(t + 1, last));
    else if (input === "k" || key.upArrow) setTop((t) => Math.max(t - 1, 0));
    else if (input === " " || key.pageDown) setTop((t) => Math.min(t + room, last));
    else if (key.pageUp) setTop((t) => Math.max(t - room, 0));
    else if (input === "r") {
      setData(undefined);
      void props.load().then(setData);
    }
  });
  const lines = docScreen(doc, Math.min(top, last), props.cols, props.rows, props.keys ?? DOC_KEYS);
  return <Lines lines={lines.map((l) => cut(l, props.cols))} color={props.color} />;
}
