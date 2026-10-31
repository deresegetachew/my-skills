// The Pull requests view (#338, #367, PRD US-13), towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VPrs.dc.html).
// One row per open PR (number, title and " · protected", by, CI, the dev manager's word, who acts, next), and the
// selected PR's detail below it: branch, head, the newest marker, any review claim or rework, CI job by job, open
// questions, protected paths and the next action. The keys that work are at the bottom. Its data is `factory prs
// --json`, read by the command the hook names. j k (or ↑ ↓) move, r reads again from GitHub, q closes. m merges the
// selected PR after a y/N question, through `factory owner merge <n> --head <the head shown>` (#309), so one that moved
// since is not merged. No Esc to close: over a slow ssh link an arrow key can come in two pieces, the first a lone Esc.
import { useApp, useInput } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { ago, cut, type Line, Lines, list, obj, type Obj, pad, plain, screen, seg, spread, type Style } from "./lines.tsx";
import type { Got } from "./read.ts";

export const PR_KEYS = "j k move · m merge · r read again · q close";
export const NOT_RUN = "Not run: nothing changed.";

function ciStyle(state: string): Style {
  return state === "green" ? "green" : state === "red" ? "red" : "amber";
}

function isProtected(p: Obj): boolean {
  return p.protected === true || obj(p.next).reason === "protected";
}

/** The dev manager's word on the head, short: ✓ approved, ✕ must-fix, or what else the gate reads. */
function reviews(p: Obj): string {
  const gate = plain(p.gate);
  if (gate === "approved") return "✓ approved";
  if (gate.startsWith("must-fix")) return `✕ ${gate}`;
  if (gate) return gate;
  return p.headMarker === "pr-watch" ? "watching" : "—";
}

/** Who acts next, from the next action. */
function whoActs(p: Obj): string {
  const next = obj(p.next);
  const action = plain(next.action);
  if (["merge", "review", "rerun-flake"].includes(action)) return "manager";
  if (action === "held") return plain(next.by) || "manager";
  if (action === "waiting-for-agent") return plain(p.agent) || "author";
  if (action === "wait-ci") return "CI";
  if (action === "owner-merges") return "you";
  return "—";
}

function nextText(p: Obj): string {
  const next = obj(p.next);
  const text = plain(next.text) || plain(next.action) || "—";
  return next.error !== undefined ? `${text} (${plain(next.error)})` : text;
}

interface Column {
  head: string;
  size: number;
  cell: (p: Obj) => Line;
}

const BY: Column = { head: "by", size: 10, cell: (p) => [seg(plain(p.agent) || "—")] };
const CI: Column = { head: "CI", size: 8, cell: (p) => {
  const state = plain(obj(p.ci).state) || "—";
  return [seg(state, ciStyle(state))];
} };
const REVIEWS: Column = { head: "reviews", size: 12, cell: (p) => [seg(reviews(p))] };
const WHO: Column = { head: "who acts", size: 10, cell: (p) => [seg(whoActs(p))] };
const NEXT: Column = { head: "next", size: 26, cell: (p) => [seg(nextText(p))] };

/** The columns after the title that fit in `cols`: the board's, dropping reviews, by, next and who acts in turn. */
function columns(cols: number): Column[] {
  const all = [BY, CI, REVIEWS, WHO, NEXT];
  for (const drop of [REVIEWS, BY, NEXT, WHO]) {
    if (2 + 6 + 16 + all.reduce((n, c) => n + c.size, 0) <= cols) break;
    all.splice(all.indexOf(drop), 1);
  }
  return all;
}

function row(cells: Line[], sizes: number[]): Line {
  return cells.flatMap((c, i) => pad(c, sizes[i] as number));
}

function table(pulls: Obj[], selected: number, cols: number): Line[] {
  const rest = columns(cols);
  const titleSize = Math.max(cols - 2 - 6 - rest.reduce((n, c) => n + c.size, 0), 8);
  const sizes = [6, titleSize, ...rest.map((c) => c.size)];
  const head = [seg("  "), ...row(["PR", "title", ...rest.map((c) => c.head)].map((h) => [seg(h)]), sizes)]
    .map((s) => ({ ...s, style: "dim" as const }));
  const rows = pulls.map((p, i) => {
    const prot = isProtected(p) ? " · protected" : "";
    const room = titleSize - 1; // a space before the next column
    const title: Line = [...cut([seg(plain(p.title))], Math.max(room - prot.length, 1)), ...(prot ? [seg(prot, "amber")] : [])];
    const line = [seg(i === selected ? "› " : "  "), ...row([[seg(`#${plain(p.number)}`)], title, ...rest.map((c) => c.cell(p))], sizes)];
    return i === selected ? line.map((s) => (s.style ? s : { ...s, style: "bold" as const })) : line;
  });
  return [head, ...rows];
}

function short(sha: unknown): string {
  return plain(sha).slice(0, 7);
}

function age(minutes: unknown): string {
  const m = typeof minutes === "number" ? minutes : null;
  if (m === null) return "age unknown";
  return m < 120 ? `${Math.round(m)} min old` : m < 2880 ? `${Math.round(m / 60)} h old` : `${Math.round(m / 1440)} days old`;
}

/** The selected PR's detail, as on the board's card. */
export function detail(p: Obj, questions: Obj[], cols: number): Line[] {
  const head = obj(p.head);
  const ci = obj(p.ci);
  const n = plain(p.number);
  const who = [plain(p.branch), plain(p.agent)].filter(Boolean).join(" · ");
  const labels = Array.isArray(p.labels) ? p.labels.map(plain).filter(Boolean) : [];
  const facts = [`head ${short(head.sha) || "unknown"}`, age(head.ageMinutes), ...(p.draft ? ["draft"] : []),
    ...(labels.length ? [`labels ${labels.join(", ")}`] : [])];

  const word = reviews(p);
  const manager: Line = [seg("dev manager "),
    word === "—" ? seg("no marker for the head") : seg(word, word.startsWith("✓") ? "green" : word.startsWith("✕") ? "red" : undefined)];
  const marks = list(p.markers);
  const last = marks[marks.length - 1];
  if (!p.headMarker && last) manager.push(seg(` (older: ${plain(last.kind).replace(/^factory-/, "")} ${short(last.sha) || "no commit"})`));
  const claim = obj(p.claim);
  if (plain(claim.manager)) manager.push(seg(`   ${plain(claim.manager)} holds the review until ${plain(claim.until)}`));
  const rw = obj(p.rework); // who is reworking this head, on which machine (#355)
  if (plain(rw.agent)) {
    manager.push(seg(`   ${plain(rw.agent)}${plain(rw.host) ? ` on ${plain(rw.host)}` : ""}` +
      `${plain(rw.machine) ? ` (machine ${plain(rw.machine)})` : ""} is reworking it until ${plain(rw.until)}`));
  }

  const state = plain(ci.state) || "unknown";
  const ciLine: Line = [seg("CI "), seg(state, ciStyle(state))];
  const notGreen = list(ci.notGreen);
  for (const j of notGreen) {
    ciLine.push(seg(`   ${plain(j.name)} `), plain(j.state) === "red" ? seg("✕", "red") : seg(plain(j.state), "amber"));
  }
  const others = Math.max(Number(ci.jobs ?? 0) - notGreen.length, 0); // jobs, not runs: re-runs and skipped don't count
  if (others) ciLine.push(seg(`   ${others} other check${others === 1 ? "" : "s"} `), seg("✓", "green"));

  const open = questions.filter((q) => q.kind === "pr" && plain(q.number) === n).length;
  const prot = isProtected(p) ? seg("yes, a person merges it", "amber")
    : seg(p.protected === false ? "none" : "checked once it could merge");
  const lines: Line[] = [
    spread([seg(`#${n} · ${plain(p.title)}`)], [seg(who)], cols),
    [seg(facts.join(" · "))],
    manager,
    ciLine,
    [seg("questions "), open ? seg(`${open} open`, "amber") : seg("none open"), seg("   protected paths "), prot],
    [seg(`next ${nextText(p)}   who acts ${whoActs(p)}`)],
  ];
  if (plain(p.url)) lines.push([seg(plain(p.url), "dim")]);
  return lines.map((l) => cut(l, cols));
}

/** What `m` runs for a PR: `owner merge` pinned to the head this view showed (#309), or null when it has no head. A PR
 *  that moved since is refused by that command (`pr_changed`), never merged at a newer head. */
export function mergeWords(p: Obj): string[] | null {
  const sha = plain(obj(p.head).sha);
  const n = plain(p.number);
  return /^[0-9a-f]{7,40}$/i.test(sha) && /^\d+$/.test(n) ? ["owner", "merge", n, "--head", sha] : null;
}

export function openPulls(data: Got | undefined): Obj[] {
  return data && data !== "late" ? list(data.pulls) : [];
}

export type Problem = { code: string; message: string; fix: string };

/** The index of PR `n` (0 when no number is given), or the refusal when it is not open. */
export function selectedOf(data: Got, n: number | null): number | Problem {
  if (n === null) return 0;
  const at = openPulls(data).findIndex((p) => Number(p.number) === n);
  if (at < 0 && data && data !== "late" && Array.isArray(data.pulls)) {
    return { code: "cockpit_no_pr", message: `#${n} is not an open pull request.`,
      fix: "Run `factory cockpit --prs` to see the open ones, or `factory prs` for the list." };
  }
  return Math.max(at, 0);
}

/** One screen of the view, `rows` lines at most, each at most `cols` wide. `data` undefined: still reading. */
export function prsLines(data: Got | undefined, selected: number, cols: number, rows: number, repo: string, nowMs: number,
  limitSeconds: number): Line[] {
  const when = data && data !== "late" ? ago(data.generatedAt, nowMs) : "";
  const heading = spread([seg("factory", "amber"), seg(`  ${repo} · Pull requests`)],
    [seg(`factory prs · CI judged by the manager's rule${when ? ` · ${when}` : ""}`, "dim")], cols);
  const pulls = data && data !== "late" ? data.pulls : undefined;
  let body: Line[];
  if (data === undefined) {
    body = [[seg("Reading the pull requests…")]];
  } else if (data === "late") {
    body = [[seg(`Can't read the pull requests in ${limitSeconds} s: \`factory prs --json\` was still reading GitHub.`)],
      [seg("Run `factory prs` to see how long it takes; once it has run, the views' cache answers at once.")]];
  } else if (data === null) {
    body = [[seg("Can't read the pull requests: `factory prs --json` printed no data.")],
      [seg("Run `factory prs` to see the whole error; if it is about GitHub, `gh auth status`.")]];
  } else if (!Array.isArray(pulls)) {
    body = [[seg(`Can't read the pull requests from GitHub (${plain(obj(pulls).error).slice(0, 200)}).`)],
      [seg("Run `gh auth status` (and `gh auth login` if it says so), then press r.")]];
  } else if (!pulls.length) {
    body = [[seg("No open pull requests.")]];
  } else {
    const all = pulls.map(obj);
    const at = Math.min(Math.max(selected, 0), all.length - 1);
    const card = detail(all[at] as Obj, list(data.questions), cols);
    const fixed = 3; // the top line, a blank line before the card, the keys
    const want = Math.min(all.length, 3) + 1; // at least a few rows and their heads
    const cardRoom = Math.max(Math.min(card.length, rows - fixed - want), 0);
    const [head, ...rowLines] = table(all, at, cols);
    const room = Math.max(rows - fixed - cardRoom - 1, 1);
    const start = Math.min(Math.max(at - room + 1, 0), Math.max(rowLines.length - room, 0));
    body = [head as Line, ...rowLines.slice(start, start + room)];
    const fill = Math.max(rows - fixed - cardRoom - body.length, 0);
    body.push(...Array.from({ length: fill }, (): Line => []), [], ...card.slice(0, cardRoom));
  }
  return screen([heading, ...body], PR_KEYS, cols, rows);
}

/** The question asked before `m` runs: the command and what it changes, as the command bar asks it. */
export function mergeQuestion(words: string[], changes: string): string {
  return `Run \`factory ${words.join(" ")}\`? It changes ${changes}. [y/N] `;
}

type Mode = { kind: "list" } | { kind: "reading"; text: string } | { kind: "ask"; words: string[] }
  | { kind: "running" } | { kind: "shown"; text: string } | { kind: "note"; text: string };

export interface PrsProps {
  repo: string;
  /** The PR to select first, by number. */
  select: number | null;
  /** What `owner merge` changes, for its question. */
  changes: string;
  cols: number;
  rows: number;
  color: boolean;
  limitSeconds: number;
  /** Reads `factory prs --json`, from GitHub when `fresh`. */
  load: (fresh: boolean) => Promise<Got>;
  /** Runs an action's words (`owner merge 12 --head <sha>`) and gives its output. */
  act: (words: string[]) => Promise<string>;
  /** The PR asked for is not open: the view closes and the caller prints the refusal. */
  refuse: (p: Problem) => void;
  now?: () => number;
}

/** The view on a terminal: it reads, draws, and answers the keys. */
export function PrsView(props: PrsProps): ReactElement {
  const { exit } = useApp();
  const [data, setData] = useState<Got | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  const reload = (fresh: boolean, text: string) => {
    setMode({ kind: "reading", text });
    void props.load(fresh).then((got) => {
      setData(got);
      setSelected((s) => Math.min(s, Math.max(openPulls(got).length - 1, 0)));
      setMode({ kind: "list" });
    });
  };

  useEffect(() => {
    void props.load(false).then((got) => {
      const at = selectedOf(got, props.select);
      if (typeof at !== "number") {
        props.refuse(at);
        exit();
        return;
      }
      setData(got);
      setSelected(at);
    });
  }, []);

  useInput((input, key) => {
    if (mode.kind === "reading" || mode.kind === "running") return;
    if (mode.kind === "shown") {
      reload(true, "Reading the pull requests from GitHub…");
      return;
    }
    if (mode.kind === "note") {
      setMode({ kind: "list" });
      return;
    }
    if (mode.kind === "ask") {
      if (/^y$/i.test(input)) {
        setMode({ kind: "running" });
        void props.act(mode.words).then((text) => setMode({ kind: "shown", text }));
      } else setMode({ kind: "shown", text: NOT_RUN });
      return;
    }
    const count = openPulls(data).length;
    if (input === "q" || (key.ctrl && input === "c")) exit();
    else if (input === "j" || key.downArrow) setSelected((s) => Math.min(s + 1, Math.max(count - 1, 0)));
    else if (input === "k" || key.upArrow) setSelected((s) => Math.max(s - 1, 0));
    else if (input === "r") reload(true, "Reading the pull requests from GitHub…");
    else if (input === "m") {
      const p = openPulls(data)[selected];
      const words = p ? mergeWords(p) : null;
      setMode(words ? { kind: "ask", words }
        : { kind: "note", text: "This view has no head commit for that pull request: press r to read it again." });
    }
  });

  const { cols, rows, color } = props;
  let lines: Line[];
  if (mode.kind === "reading") lines = [[seg(mode.text)]];
  else if (mode.kind === "running") lines = [[seg("Running it…")]];
  else if (mode.kind === "note") lines = [[seg(mode.text)]];
  else if (mode.kind === "ask") {
    lines = [[seg(mergeQuestion(mode.words, props.changes), "amber")], [seg("y runs it · any other key does nothing", "dim")]];
  } else if (mode.kind === "shown") {
    lines = screen([...mode.text.split("\n").map((t): Line => [seg(plain(t))]), [], [seg("Press a key to go on.")]],
      "any key reads the pull requests again", cols, rows);
  } else lines = prsLines(data, selected, cols, rows, props.repo, (props.now ?? Date.now)(), props.limitSeconds);
  return <Lines lines={lines.map((l) => cut(l, cols))} color={color} />;
}
