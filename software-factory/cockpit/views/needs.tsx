// The Needs you view (#367, PRD US-10), towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VInbox.dc.html): what
// is waiting on the owner, from the cockpit's snapshot (`needsYou` in `factory cockpit --json`): owner asks (and whether
// the product owner replied, #352) and pull requests only a person merges, each with its link and age. The selected
// one's detail is below the list. j k (or ↑ ↓) move, / filters the rows (#392), r reads the snapshot again, q closes.
// Enter on an owner ask shows it whole with its options (#395); a digit picks one and, after a y/N question, posts it with
// `factory owner answer <id> <option>`. Merging is `factory owner merge`, in the command bar or the Pull requests view.
import { useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { type Filter, filterKey, filterKeys, matchesTyped, NO_FILTER, noMatch } from "./filter.ts";
import { ago, cut, type Line, Lines, list, type Obj, plain, screen, seg, spread, wrap } from "./lines.tsx";
import type { Got } from "./read.ts";

export const NEEDS_KEYS = "j k move · r read again · q close";

function minutes(m: unknown): string {
  if (typeof m !== "number") return "";
  return m < 120 ? `${Math.round(m)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

/** One thing that needs the owner, as one sentence with its link. */
export function sentence(n: Obj): string {
  if (n.kind === "owner-ask") {
    const replied = n.state === "owner" ? ", the product owner replied" : "";
    return `Owner ask ${plain(n.id)} on #${plain(n.issue)}${replied}: ${plain(n.url)}`;
  }
  if (n.kind === "owner-merges") return `PR #${plain(n.number)} ${plain(n.title)} is yours to merge: ${plain(n.url)}`;
  return plain(JSON.stringify(n)); // JSON escapes C0 control characters, not C1 (\x80-\x9f)
}

/** What the owner does about the selected one. */
function whatToDo(n: Obj): string {
  if (n.kind === "owner-ask") return `Enter shows it whole and answers it, or \`factory owner answer ${plain(n.id)} <answer>\` in the command bar.`;
  if (n.kind === "owner-merges") return `Open the Pull requests view (C-a 2) and press m, or \`factory owner merge ${plain(n.number)}\`.`;
  return "Read it on GitHub.";
}

/** What the search opens a row by: an owner ask's id, or `#<n>` for a pull request (#392). */
export function needKey(n: Obj): string {
  return n.kind === "owner-ask" ? plain(n.id) : `#${plain(n.number)}`;
}

/** The things that need the owner and match `typed` (#392). */
export function needsOf(snap: Got | undefined, typed = ""): Obj[] {
  return snap && snap !== "late" ? list(snap.needsYou).filter((n) => matchesTyped(sentence(n), typed)) : [];
}

/** The index of the row the search opened (`needKey`), else 0. */
export function needAt(snap: Got | undefined, key: string): number {
  return Math.max(needsOf(snap).findIndex((n) => needKey(n) === key), 0);
}

/** One screen of the view, `rows` lines at most, each at most `cols` wide. `snap` undefined: still reading. */
export function needsLines(snap: Got | undefined, selected: number, cols: number, rows: number, repo: string, nowMs: number,
  filter: Filter = NO_FILTER): Line[] {
  const when = snap && snap !== "late" ? ago(snap.generatedAt, nowMs) : "";
  const heading = spread([seg("factory", "amber"), seg(`  ${repo} · Needs you`)],
    [seg(`from the cockpit's snapshot${when ? ` · ${when}` : ""}`, "dim")], cols);
  let body: Line[];
  if (snap === undefined) body = [[seg("Reading the snapshot…")]];
  else if (snap === "late") body = [[seg("The snapshot took too long to read: run `factory cockpit --json` to see why.")]];
  else if (snap === null) body = [[seg("No snapshot yet: `factory cockpit --json` reads one now.")]];
  else {
    const items = needsOf(snap, filter.typed);
    if (!list(snap.needsYou).length) body = [[seg("Nothing needs you.")]];
    else if (!items.length) body = [noMatch(filter.typed)];
    else {
      const at = Math.min(Math.max(selected, 0), items.length - 1);
      const n = items[at] as Obj;
      const card: Line[] = [[seg(plain(n.kind).replace(/-/g, " "), "amber")], ...[whatToDo(n)].map((t): Line => [seg(t)])];
      const room = Math.max(rows - 5 - card.length, 1); // the heading, a blank, the group, a blank, the keys
      const start = Math.min(Math.max(at - room + 1, 0), Math.max(items.length - room, 0));
      const rowsShown = items.slice(start, start + room).map((it, i): Line => {
        const mark = start + i === at ? "› " : "  ";
        const line = spread([seg(mark), seg(sentence(it))], [seg(minutes(it.ageMinutes), "dim")], cols);
        return start + i === at ? line.map((s) => (s.style ? s : { ...s, style: "bold" as const })) : line;
      });
      body = [[seg(`FOR YOU · ${items.length}`, "dim")], ...rowsShown, [], ...card];
    }
  }
  return screen([heading, [], ...body], filterKeys(filter, NEEDS_KEYS), cols, rows);
}

export const NOT_RUN = "Not run: nothing changed.";
const POSTING = "Posting the answer…";
export const ASK_KEYS = "1-9 answers with that option · Esc back to the list";

/** Where the view is (#395): the list, an ask shown whole, the question before its answer, or what the answer printed. */
type Mode = { kind: "list" } | { kind: "ask"; ask: Obj } | { kind: "confirm"; ask: Obj; option: string } | { kind: "shown"; text: string };

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(plain).filter(Boolean) : [];
}

/** The question asked before an answer is posted. */
export function answerQuestion(id: string, option: string): string {
  return `Run \`factory owner answer ${id} ${option}\`? It changes the owner queue. [y/N]`;
}

/** One screen of an ask shown whole (#395): its text, its options numbered, and the question once one is picked. */
export function askLines(mode: Exclude<Mode, { kind: "list" }>, cols: number, rows: number, repo: string, canAnswer: boolean): Line[] {
  const heading = spread([seg("factory", "amber"), seg(`  ${repo} · Needs you`)], [], cols);
  if (mode.kind === "shown") {
    return screen([heading, [], ...mode.text.split(/\r?\n/).flatMap((l) => wrap(plain(l), cols))], "Esc back to the list", cols, rows);
  }
  const n = mode.ask;
  const text = String(n.text ?? "").split(/\r?\n/).flatMap((l) => wrap(plain(l), cols));
  const options = strings(n.options).map((o, i): Line => [seg(`  ${i + 1} ${o}`)]);
  const body: Line[] = [[seg(`Owner ask ${plain(n.id)} on #${plain(n.issue)}`, "amber"), seg(`  ${plain(n.url)}`, "dim")], [],
    ...(text.length ? text : [[seg("(no text)", "dim")]]), [], [seg("OPTIONS", "dim")], ...options];
  if (!canAnswer) body.push([], [seg(`Answer it in the command bar: factory owner answer ${plain(n.id)} <answer>`, "dim")]);
  if (mode.kind === "confirm") body.push([], [seg(answerQuestion(plain(n.id), mode.option), "bold")]);
  // the question and the options stay on screen: the text gives way first
  const room = Math.max(rows - 3, 2); // the heading, a blank, the keys
  const shown = body.length > room ? [body[0] as Line, ...body.slice(-(room - 1))] : body;
  return screen([heading, [], ...shown], mode.kind === "confirm" ? "y posts it · any other key doesn't" : ASK_KEYS, cols, rows);
}

export interface NeedsProps {
  repo: string;
  /** The snapshot the view opens on (the cache), or null when there is none yet. */
  snapshot: Got;
  cols: number;
  rows: number;
  color: boolean;
  /** Reads the snapshot again (`factory cockpit --json`). */
  load: () => Promise<Got>;
  now?: () => number;
  /** The row to select first (`needKey`): the search's Enter (#392). */
  find?: string;
  /** Runs a factory command (`owner answer <id> <option>`) and gives its output (#395); without it the view only reads. */
  act?: (words: string[]) => Promise<string>;
}

export function NeedsView(props: NeedsProps): ReactElement {
  const { exit } = useApp();
  const [snap, setSnap] = useState<Got | undefined>(props.snapshot);
  const [selected, setSelected] = useState(() => (props.find ? needAt(props.snapshot, props.find) : 0));
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const reload = () => {
    setSnap(undefined);
    void props.load().then((got) => {
      setSnap(got);
      setSelected((s) => Math.min(s, Math.max(needsOf(got, filter.typed).length - 1, 0)));
    });
  };
  /** The keys of an ask shown whole: a digit picks an option, y posts it, Esc (or q) goes back. */
  const askKey = (input: string, escape: boolean): void => {
    if (mode.kind === "list") return;
    if (mode.kind === "confirm") {
      if (input === "y" && props.act) {
        const words = ["owner", "answer", plain(mode.ask.id), mode.option];
        setMode({ kind: "shown", text: POSTING });
        void props.act(words).then((text) => setMode({ kind: "shown", text: text || "Done." }));
      } else setMode({ kind: "shown", text: NOT_RUN });
      return;
    }
    if (mode.kind === "shown" && mode.text === POSTING) return; // its output comes back here
    if (escape || input === "q") {
      const answered = mode.kind === "shown" && mode.text !== NOT_RUN;
      setMode({ kind: "list" });
      if (answered) reload(); // the answered ask leaves the list
      return;
    }
    const option = mode.kind === "ask" && props.act ? strings(mode.ask.options)[Number(input) - 1] : undefined;
    if (mode.kind === "ask" && /^[1-9]$/.test(input) && option) setMode({ kind: "confirm", ask: mode.ask, option });
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") return exit();
    if (mode.kind !== "list") return askKey(input, key.escape);
    const next = snap === undefined ? null : filterKey(filter, input, key);
    if (next) {
      setFilter((f) => filterKey(f, input, key) ?? f); // keys in one chunk each see the one before
      setSelected(0);
      return;
    }
    if (input === "q") return exit(); // closes while it reads too
    if (snap === undefined) return; // reading
    const items = needsOf(snap, filter.typed);
    const count = items.length;
    if (input === "j" || key.downArrow) setSelected((s) => Math.min(s + 1, Math.max(count - 1, 0)));
    else if (input === "k" || key.upArrow) setSelected((s) => Math.max(s - 1, 0));
    else if (input === "r") reload();
    else if (key.return) {
      const n = items[Math.min(Math.max(selected, 0), count - 1)];
      if (n?.kind === "owner-ask") setMode({ kind: "ask", ask: n });
    }
  });
  const lines = mode.kind !== "list" ? askLines(mode, props.cols, props.rows, props.repo, props.act !== undefined)
    : needsLines(snap, selected, props.cols, props.rows, props.repo, (props.now ?? Date.now)(), filter);
  return <Lines lines={lines.map((l) => cut(l, props.cols))} color={props.color} />;
}
