// An owner ask answered in place (#395), inside the Needs you view: Enter on an ask shows it whole with its options (the
// lines of the ask that are a list: `- `, `* `, `1. `, `1) `, `A) `, `a. `) and a line to type one's own answer. Enter on
// one asks `[y/N]`; only y posts it, through `factory owner answer <id> <answer>` (the view's `act`); any other key posts
// nothing and says so. Esc goes back to the list. This file has the screen and the keys; needs.tsx runs the action.
import type { Key } from "ink";
import { erased, backspace, typedText } from "./filter.ts";
import { type Line, type Obj, plain, seg, wrap } from "./lines.tsx";

export const OWN = "Type your own answer";
export const NOT_RUN = "Not run: nothing changed.";
export const ASK_KEYS = "j k pick · Enter answer · Esc back";

const OPTION = /^\s*(?:[-*]|\d{1,2}[.)]|[A-Za-z][.)])\s+(.+?)\s*$/;

/** The ask's options: its list lines, without their bullet or label. */
export function optionsOf(text: string): string[] {
  return text.split("\n").map((l) => OPTION.exec(l)?.[1] ?? "").map((o) => plain(o)).filter(Boolean);
}

/** Where the owner is in an ask: the option picked, the answer being typed (null when not typing), the answer waiting
 *  for its y/N (null when none), and what the last answer said (null when nothing ran yet). */
export interface AskState {
  at: number;
  typing: string | null;
  confirm: string | null;
  said: string | null;
}

export const NEW_ASK: AskState = { at: 0, typing: null, confirm: null, said: null };

/** What a key does in an ask: the next state, `post` when y answered the question, `back` for the list. */
export type AskStep = { state: AskState; post?: string; back?: boolean };

export function askKey(s: AskState, choices: string[], input: string, key: Key): AskStep {
  if (s.confirm !== null) {
    if (input === "y" || input === "Y") return { state: { ...s, confirm: null, said: "Posting the answer…" }, post: s.confirm };
    return { state: { ...s, confirm: null, said: NOT_RUN } };
  }
  if (s.typing !== null) {
    if (key.escape) return { state: { ...s, typing: null } };
    if (key.return) return s.typing.trim() ? { state: { ...s, typing: null, confirm: s.typing.trim() } } : { state: s };
    const back = erased(input, key);
    return { state: { ...s, typing: back ? backspace(s.typing, back) : s.typing + typedText(input, key) } };
  }
  if (key.escape || input === "q") return { state: s, back: true };
  if (input === "j" || key.downArrow) return { state: { ...s, at: Math.min(s.at + 1, choices.length - 1), said: null } };
  if (input === "k" || key.upArrow) return { state: { ...s, at: Math.max(s.at - 1, 0), said: null } };
  if (key.return) {
    const pick = choices[s.at] ?? OWN;
    return { state: pick === OWN ? { ...s, typing: "", said: null } : { ...s, confirm: pick, said: null } };
  }
  return { state: s };
}

/** The choices for an ask: its options, then the line to type one's own. */
export function choicesOf(ask: Obj): string[] {
  return [...optionsOf(typeof ask.text === "string" ? ask.text : ""), OWN];
}

/** The ask's lines: its id and issue, its whole text, the choices, and the question or what the answer said. */
export function askBody(ask: Obj, s: AskState, cols: number, rows: number): Line[] {
  const id = plain(ask.id);
  const choices = choicesOf(ask);
  const picks: Line[] = choices.map((c, i) => {
    const mark = i === s.at ? "› " : "  ";
    const typed = c === OWN && s.typing !== null ? `: ${s.typing}▏` : "";
    return [seg(`${mark}${c}${typed}`, i === s.at ? "bold" : undefined)];
  });
  const after: Line[] = [];
  if (s.confirm !== null) {
    after.push(...wrap(`Answer ${id} with “${s.confirm}”? It posts \`factory owner answer ${id} <answer>\` on the owner queue. [y/N]`,
      cols, "amber"));
  }
  if (s.said !== null) after.push(...wrap(s.said, cols));
  const text = typeof ask.text === "string" && ask.text.trim() ? ask.text.split("\n").map((l) => plain(l)).join("\n")
    : "Its text isn't in this snapshot: r in the list reads it again, or open the link.";
  // the heading, the ask's own line, blanks, the choices' heading and the keys keep their room; the text takes the rest
  const room = Math.max(rows - 8 - picks.length - after.length, 1);
  const body = wrap(text, cols);
  const shown = body.length > room ? [...body.slice(0, Math.max(room - 1, 0)), [seg(`… the rest on GitHub: ${plain(ask.url)}`, "dim")]] : body;
  return [[seg(`Owner ask ${id} on #${plain(ask.issue)}`, "amber")], ...shown, [], [seg("ANSWER WITH", "dim")], ...picks,
    ...(after.length ? [[], ...after] : [])];
}
