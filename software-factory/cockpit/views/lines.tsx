// What every view is drawn from (#367, decision 0002): lines of styled pieces, each cut to the width the view is given,
// so a view fits COLUMNS and LINES off a terminal and the terminal's size on one, and an ink-testing-library test can
// draw it at any size. Colour is the view's `color` prop: off (NO_COLOR, or off a terminal), no style is set at all, so
// the frame has no escape sequence. Anything that came from GitHub or a log goes through `plain` first.
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export type Obj = { [key: string]: unknown };
export type Style = "green" | "red" | "amber" | "blue" | "dim" | "bold";
export type Seg = { text: string; style?: Style };
export type Line = Seg[];

export function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

export function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

/** A string or number as text, without escape sequences or control characters: a title can't drive the terminal. */
export function plain(v: unknown): string {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "") // OSC: a window title, a link
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI: colours, cursor moves, clearing the screen
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function seg(text: string, style?: Style): Seg {
  return style ? { text, style } : { text };
}

export function width(l: Line): number {
  return l.reduce((n, s) => n + [...s.text].length, 0);
}

/** `l` cut to `n` characters, an ellipsis where it was cut. */
export function cut(l: Line, n: number): Line {
  if (width(l) <= n) return l;
  const out: Line = [];
  let room = Math.max(n - 1, 0);
  for (const s of l) {
    const chars = [...s.text];
    if (chars.length <= room) {
      out.push(s);
      room -= chars.length;
      continue;
    }
    if (room > 0) out.push({ ...s, text: chars.slice(0, room).join("") });
    break;
  }
  if (n > 0) out.push(seg("…"));
  return out;
}

/** `l` cut or padded to exactly `n` characters. */
export function pad(l: Line, n: number): Line {
  const c = cut(l, n);
  const gap = n - width(c);
  return gap > 0 ? [...c, seg(" ".repeat(gap))] : c;
}

/** `left` and `right` on one line of `cols`, the right one dropped when both don't fit. */
export function spread(left: Line, right: Line, cols: number): Line {
  const gap = cols - width(left) - width(right);
  return gap >= 2 ? [...left, seg(" ".repeat(gap)), ...right] : cut(left, cols);
}

/** Text as lines of at most `n` characters, broken at spaces. */
export function wrap(text: string, n: number, style?: Style): Line[] {
  const out: Line[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(" ")) {
      if (cur && [...`${cur} ${word}`].length > n) {
        out.push([seg(cur, style)]);
        cur = word;
      } else cur = cur ? `${cur} ${word}` : word;
    }
    out.push([seg(cur, style)]);
  }
  return out.map((l) => cut(l, n));
}

/** "40 s ago", "3 min ago" from an ISO time, or "" when there is none. */
export function ago(iso: unknown, nowMs: number): string {
  const at = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return "";
  const s = Math.max(nowMs - at, 0) / 1000;
  return s < 120 ? `${Math.floor(s)} s ago` : `${Math.floor(s / 60)} min ago`;
}

/** A view's screen: the lines, at most `rows` of them, the last one the keys that work there. */
export function screen(body: Line[], keys: string, cols: number, rows: number): Line[] {
  const room = Math.max(rows - 1, 0);
  return [...body.slice(0, room), [seg(keys, "dim")]].map((l) => cut(l, cols)).slice(-Math.max(rows, 1));
}

function styled(s: Seg, i: number): ReactElement | string {
  switch (s.style) {
    case "green": return <Text key={i} color="green">{s.text}</Text>;
    case "red": return <Text key={i} color="red">{s.text}</Text>;
    case "amber": return <Text key={i} color="yellow">{s.text}</Text>;
    case "blue": return <Text key={i} color="blue">{s.text}</Text>;
    case "dim": return <Text key={i} dimColor>{s.text}</Text>;
    case "bold": return <Text key={i} bold>{s.text}</Text>;
    default: return s.text;
  }
}

/** The lines as Ink draws them; with `color` off, plain text. */
export function Lines({ lines, color }: { lines: Line[]; color: boolean }): ReactElement {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate">{l.length && width(l) ? l.map((s, j) => (color ? styled(s, j) : s.text)) : " "}</Text>
      ))}
    </Box>
  );
}
