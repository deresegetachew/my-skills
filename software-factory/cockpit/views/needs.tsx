// The Needs you view (#367, PRD US-10), towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VInbox.dc.html): what
// is waiting on the owner, from the cockpit's snapshot (`needsYou` in `factory cockpit --json`): owner asks (and whether
// the product owner replied, #352) and pull requests only a person merges, each with its link and age. The selected
// one's detail is below the list. j k (or ↑ ↓) move, r reads the snapshot again, q closes. It only reads: answering and
// merging are `factory owner answer` and `factory owner merge`, in the command bar or the Pull requests view.
import { useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { ago, cut, type Line, Lines, list, obj, type Obj, plain, screen, seg, spread } from "./lines.tsx";
import type { Got } from "./read.ts";

export const NEEDS_KEYS = "j k move · r read again · q close";

function minutes(m: unknown): string {
  if (typeof m !== "number") return "";
  return m < 120 ? `${Math.round(m)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

/** One thing that needs the owner, as one sentence with its link. */
function sentence(n: Obj): string {
  if (n.kind === "owner-ask") {
    const replied = n.state === "owner" ? ", the product owner replied" : "";
    return `Owner ask ${plain(n.id)} on #${plain(n.issue)}${replied}: ${plain(n.url)}`;
  }
  if (n.kind === "owner-merges") return `PR #${plain(n.number)} ${plain(n.title)} is yours to merge: ${plain(n.url)}`;
  return JSON.stringify(n); // JSON escapes control characters itself
}

/** What the owner does about the selected one. */
function whatToDo(n: Obj): string {
  if (n.kind === "owner-ask") return `Answer it on the queue issue, or \`factory owner answer ${plain(n.id)} <answer>\` in the command bar.`;
  if (n.kind === "owner-merges") return `Open the Pull requests view (C-a 2) and press m, or \`factory owner merge ${plain(n.number)}\`.`;
  return "Read it on GitHub.";
}

/** One screen of the view, `rows` lines at most, each at most `cols` wide. `snap` undefined: still reading. */
export function needsLines(snap: Got | undefined, selected: number, cols: number, rows: number, repo: string, nowMs: number): Line[] {
  const when = snap && snap !== "late" ? ago(snap.generatedAt, nowMs) : "";
  const heading = spread([seg("factory", "amber"), seg(`  ${repo} · Needs you`)],
    [seg(`from the cockpit's snapshot${when ? ` · ${when}` : ""}`, "dim")], cols);
  let body: Line[];
  if (snap === undefined) body = [[seg("Reading the snapshot…")]];
  else if (snap === "late") body = [[seg("The snapshot took too long to read: run `factory cockpit --json` to see why.")]];
  else if (snap === null) body = [[seg("No snapshot yet: `factory cockpit --json` reads one now.")]];
  else {
    const items = list(snap.needsYou);
    if (!items.length) body = [[seg("Nothing needs you.")]];
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
  return screen([heading, [], ...body], NEEDS_KEYS, cols, rows);
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
}

export function NeedsView(props: NeedsProps): ReactElement {
  const { exit } = useApp();
  const [snap, setSnap] = useState<Got | undefined>(props.snapshot);
  const [selected, setSelected] = useState(0);
  useInput((input, key) => {
    if (snap === undefined) return; // reading
    const count = snap && snap !== "late" ? list(snap.needsYou).length : 0;
    if (input === "q" || (key.ctrl && input === "c")) exit();
    else if (input === "j" || key.downArrow) setSelected((s) => Math.min(s + 1, Math.max(count - 1, 0)));
    else if (input === "k" || key.upArrow) setSelected((s) => Math.max(s - 1, 0));
    else if (input === "r") {
      setSnap(undefined);
      void props.load().then((got) => {
        setSnap(got);
        setSelected((s) => Math.min(s, Math.max((got && got !== "late" ? list(obj(got).needsYou).length : 0) - 1, 0)));
      });
    }
  });
  const lines = needsLines(snap, selected, props.cols, props.rows, props.repo, (props.now ?? Date.now)());
  return <Lines lines={lines.map((l) => cut(l, props.cols))} color={props.color} />;
}
