// The cockpit's `/` (#392): the search across the views (cockpit/search.tsx) and the filter inside a view match the same
// way. What was typed is cut into words; a row matches when each word is in its text, in any case. In a view, `/` starts
// the filter: what is typed then is text (q, j, k, r and m too), Backspace takes a character back, Enter keeps the filter
// and gives the view its keys again, and Esc clears it.
import type { Key } from "ink";
import { type Line, plain, seg } from "./lines.tsx";

/** True when every word of `typed` is in `text`, in any case (factory_cockpit_match.ts, shared with the web UI). */
export { matchesTyped } from "../../hooks/factory_cockpit_match.ts";

export interface Filter {
  typed: string;
  /** Keys go to the filter, not the view. */
  typing: boolean;
}

export const NO_FILTER: Filter = { typed: "", typing: false };

/** The text a key types: printable characters only, so a key can't put an escape sequence on the screen. */
export function typedText(input: string, key: Key): string {
  if (key.ctrl || key.meta || key.escape || key.return || key.tab) return "";
  return plain(input);
}

/** How many characters a key takes back: Backspace or Delete, or several Backspaces that came in as one chunk. */
export function erased(input: string, key: Key): number {
  const n = (input.match(/[\x7f\b]/g) ?? []).length;
  return key.backspace || key.delete ? Math.max(n, 1) : n;
}

/** `typed` with its last `n` characters taken back. */
export function backspace(typed: string, n = 1): string {
  return [...typed].slice(0, Math.max([...typed].length - n, 0)).join("");
}

/** The filter after a key, or null when the key is the view's (it is not typing and the key is not `/` or a clearing
 *  Esc). */
export function filterKey(f: Filter, input: string, key: Key): Filter | null {
  if (f.typing) {
    if (key.escape) return NO_FILTER;
    if (key.return) return { typed: f.typed, typing: false };
    const back = erased(input, key);
    if (back) return { ...f, typed: backspace(f.typed, back) };
    return { ...f, typed: f.typed + typedText(input, key) };
  }
  if (input === "/" && !key.ctrl && !key.meta) return { typed: "", typing: true };
  if (key.escape && f.typed) return NO_FILTER;
  return null;
}

/** The keys line of a view with a filter: the view's own keys, or what was typed and how to leave it. */
export function filterKeys(f: Filter, keys: string): string {
  if (f.typing) return `/ ${f.typed}▏ · Enter keeps it · Esc clears it`;
  if (f.typed) return `/ ${f.typed} · Esc clears it · ${keys}`;
  return keys;
}

/** What a view says when nothing matches. */
export function noMatch(typed: string): Line {
  return [seg(`No match for "${plain(typed)}".`)];
}
