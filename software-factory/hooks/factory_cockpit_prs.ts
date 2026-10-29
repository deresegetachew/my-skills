// `factory cockpit --prs [<n>]` (#338, PRD US-13): the cockpit's Pull requests view (`C-a 2`), towards its board
// (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VPrs.dc.html). One row per open PR (number, title and " · protected", by, CI,
// the dev manager's word, who acts, next), and the selected PR's detail below it: branch, head, the newest marker, any
// review claim, CI job by job, open questions, protected paths and the next action. The keys that work are at the
// bottom. Its data is `factory prs --json` (the views cache keeps it, #305), so CI is judged by the manager's one rule.
//
// On a terminal: j k (or ↑ ↓) move, r reads again from GitHub, q closes. Off a terminal it prints one frame sized by
// COLUMNS and LINES, with <n> selected (else the first PR), and no colour. NO_COLOR turns the colour off on a terminal.
// Read-only like the rest of the cockpit: merging, labels and comments come with US-11.
import { basename, join } from "node:path";
import { run } from "./factory_lib.ts";
import { refuse } from "./factory_machine.ts";

type Obj = { [key: string]: unknown };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

/** A string or number as text, without escape sequences or control characters: a title can't drive the terminal. */
function plain(v: unknown): string {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

// --- reading -----------------------------------------------------------------------------------------------------------

/** `factory prs --json`, or null when it printed no JSON. */
export function readPrs(fresh: boolean): Obj | null {
  const hook = join(import.meta.dir, "factory_prs.ts");
  const p = run([process.execPath, "--no-env-file", "--config=/dev/null", hook, "--json", ...(fresh ? ["--fresh"] : [])],
    { timeoutMs: 120_000 });
  try {
    const data: unknown = JSON.parse(p.stdout);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Obj) : null;
  } catch {
    return null;
  }
}

// --- one PR's cells ------------------------------------------------------------------------------------------------------

const PAINT: Record<string, string> = { green: "32", red: "31", amber: "33", dim: "90" };

function paint(text: string, colour: string, color: boolean): string {
  return color && text ? `\x1b[${PAINT[colour]}m${text}\x1b[0m` : text;
}

function ciColour(state: string): string {
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

// --- layout --------------------------------------------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*m/g;

function width(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

/** Cuts `s` to `n` visible characters (an ellipsis when cut), dropping colour when it has to cut. */
function cut(s: string, n: number): string {
  if (width(s) <= n) return s;
  const chars = [...s.replace(ANSI, "")];
  return n <= 0 ? "" : `${chars.slice(0, n - 1).join("")}…`;
}

function pad(s: string, n: number): string {
  const c = cut(s, n);
  return c + " ".repeat(Math.max(n - width(c), 0));
}

/** `left` and `right` on one line of `cols`, the right one dropped when both don't fit. */
function spread(left: string, right: string, cols: number): string {
  const gap = cols - width(left) - width(right);
  return gap >= 2 ? left + " ".repeat(gap) + right : cut(left, cols);
}

interface Column {
  head: string;
  size: number;
  cell: (p: Obj, color: boolean) => string;
}

const BY: Column = { head: "by", size: 10, cell: (p) => plain(p.agent) || "—" };
const CI: Column = { head: "CI", size: 8, cell: (p, color) => {
  const state = plain(obj(p.ci).state) || "—";
  return paint(state, ciColour(state), color);
} };
const REVIEWS: Column = { head: "reviews", size: 12, cell: (p) => reviews(p) };
const WHO: Column = { head: "who acts", size: 10, cell: (p) => whoActs(p) };
const NEXT: Column = { head: "next", size: 26, cell: (p) => nextText(p) };

/** The columns after the title that fit in `cols`: the board's, dropping reviews, by, next and who acts in turn. */
function columns(cols: number): Column[] {
  const all = [BY, CI, REVIEWS, WHO, NEXT];
  for (const drop of [REVIEWS, BY, NEXT, WHO]) {
    if (2 + 6 + 16 + all.reduce((n, c) => n + c.size, 0) <= cols) break;
    all.splice(all.indexOf(drop), 1);
  }
  return all;
}

function tableRow(cells: string[], sizes: number[]): string {
  return cells.map((c, i) => pad(c, sizes[i] as number)).join("");
}

function table(pulls: Obj[], selected: number, cols: number, color: boolean): string[] {
  const rest = columns(cols);
  const titleSize = Math.max(cols - 2 - 6 - rest.reduce((n, c) => n + c.size, 0), 8);
  const sizes = [6, titleSize, ...rest.map((c) => c.size)];
  const head = "  " + tableRow(["PR", "title", ...rest.map((c) => c.head)], sizes);
  const rows = pulls.map((p, i) => {
    const prot = isProtected(p) ? " · protected" : "";
    const room = titleSize - 1; // a space before the next column
    const title = cut(plain(p.title), Math.max(room - prot.length, 1)) + paint(prot, "amber", color);
    const line = (i === selected ? "› " : "  ") + tableRow([`#${plain(p.number)}`, title, ...rest.map((c) => c.cell(p, color))], sizes);
    return color && i === selected ? `\x1b[1m${line}\x1b[0m` : line;
  });
  return [paint(head, "dim", color), ...rows];
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
export function detail(p: Obj, questions: Obj[], cols: number, color: boolean): string[] {
  const head = obj(p.head);
  const ci = obj(p.ci);
  const ok = (s: string) => paint(s, "green", color);
  const bad = (s: string) => paint(s, "red", color);
  const n = plain(p.number);
  const who = [plain(p.branch), plain(p.agent)].filter(Boolean).join(" · ");
  const labels = Array.isArray(p.labels) ? p.labels.map(plain).filter(Boolean) : [];
  const facts = [`head ${short(head.sha) || "unknown"}`, age(head.ageMinutes), ...(p.draft ? ["draft"] : []),
    ...(labels.length ? [`labels ${labels.join(", ")}`] : [])];

  const word = reviews(p);
  const marked = word.startsWith("✓") ? ok(word) : word.startsWith("✕") ? bad(word) : word;
  let manager = `dev manager ${word === "—" ? "no marker for the head" : marked}`;
  const marks = list(p.markers);
  const last = marks[marks.length - 1];
  if (!p.headMarker && last) manager += ` (older: ${plain(last.kind).replace(/^factory-/, "")} ${short(last.sha) || "no commit"})`;
  const claim = obj(p.claim);
  if (plain(claim.manager)) manager += `   ${plain(claim.manager)} holds the review until ${plain(claim.until)}`;

  const state = plain(ci.state) || "unknown";
  const notGreen = list(ci.notGreen);
  const jobs = notGreen.map((j) => `${plain(j.name)} ${plain(j.state) === "red" ? bad("✕") : paint(plain(j.state), "amber", color)}`);
  const others = Math.max(Number(ci.runs ?? 0) - notGreen.length, 0);
  if (others) jobs.push(`${others} other check${others === 1 ? "" : "s"} ${ok("✓")}`);
  const ciLine = `CI ${paint(state, ciColour(state), color)}${jobs.length ? `   ${jobs.join("   ")}` : ""}`;

  const open = questions.filter((q) => q.kind === "pr" && plain(q.number) === n).length;
  const prot = isProtected(p) ? paint("yes, a person merges it", "amber", color)
    : p.protected === false ? "none" : "checked once it could merge";
  const lines = [
    spread(`#${n} · ${plain(p.title)}`, who, cols),
    facts.join(" · "),
    manager,
    ciLine,
    `questions ${open ? paint(`${open} open`, "amber", color) : "none open"}   protected paths ${prot}`,
    `next ${nextText(p)}   who acts ${whoActs(p)}`,
  ];
  if (plain(p.url)) lines.push(paint(plain(p.url), "dim", color));
  return lines.map((l) => cut(l, cols));
}

const KEYS = "j k move · r read again · q close";
const GH_FIX = "Run `gh auth status` (and `gh auth login` if it says so), then press r.";

/** One screen of the view, `rows` lines at most, each at most `cols` wide. */
export function frame(data: Obj | null, selected: number, cols: number, rows: number, color: boolean, repo: string): string[] {
  const at0 = data?.generatedAt;
  const when = typeof at0 === "string" ? Math.max(Date.now() - Date.parse(at0), 0) / 1000 : null;
  const ago = when === null || Number.isNaN(when) ? "" : when < 120 ? ` · ${Math.floor(when)} s ago` : ` · ${Math.floor(when / 60)} min ago`;
  const top = spread(`factory  ${repo} · Pull requests`, `factory prs · CI judged by the manager's rule${ago}`, cols);
  const pulls = data?.pulls;
  let body: string[];
  if (data === null) {
    body = ["Can't read the pull requests: `factory prs --json` printed no data.",
      "Run `factory prs` to see the whole error; if it is about GitHub, `gh auth status`."];
  } else if (!Array.isArray(pulls)) {
    body = [`Can't read the pull requests from GitHub (${plain(obj(pulls).error).slice(0, 200)}).`, GH_FIX];
  } else if (!pulls.length) {
    body = ["No open pull requests."];
  } else {
    const all = pulls.map(obj);
    const at = Math.min(Math.max(selected, 0), all.length - 1);
    const card = detail(all[at] as Obj, list(data.questions), cols, color);
    const fixed = 3; // the top line, a blank line before the card, the keys
    const want = Math.min(all.length, 3) + 1; // at least a few rows and their heads
    const cardRoom = Math.max(Math.min(card.length, rows - fixed - want), 0);
    const [head, ...rowLines] = table(all, at, cols, color);
    const room = Math.max(rows - fixed - cardRoom - 1, 1);
    const start = Math.min(Math.max(at - room + 1, 0), Math.max(rowLines.length - room, 0));
    body = [head as string, ...rowLines.slice(start, start + room)];
    const fill = Math.max(rows - fixed - cardRoom - body.length, 0);
    body.push(...Array<string>(fill).fill(""), "", ...card.slice(0, cardRoom));
  }
  const out = [top, ...body.map((l) => cut(l, cols))];
  const keys = paint(cut(KEYS, cols), "dim", color);
  return [...out.slice(0, Math.max(rows - 1, 0)), keys].slice(-Math.max(rows, 1));
}

// --- the command -------------------------------------------------------------------------------------------------------

function repoName(): string {
  const p = run(["git", "rev-parse", "--show-toplevel"]);
  return basename(p.code === 0 && p.stdout.trim() ? p.stdout.trim() : process.cwd());
}

function pulls(data: Obj | null): Obj[] {
  return list(data?.pulls);
}

/** The index of PR `n`, refused when it is not open; 0 when no number is given. */
function selectedOf(data: Obj | null, n: number | null): number {
  if (n === null) return 0;
  const at = pulls(data).findIndex((p) => Number(p.number) === n);
  if (at < 0 && Array.isArray(data?.pulls)) {
    refuse("cockpit_no_pr", `#${n} is not an open pull request.`,
      "Run `factory cockpit --prs` to see the open ones, or `factory prs` for the list.", 2);
  }
  return Math.max(at, 0);
}

async function loop(n: number | null): Promise<number> {
  const color = !process.env.NO_COLOR;
  const repo = repoName();
  let data: Obj | null = null;
  let selected = 0;
  const draw = (note = "") => {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const lines = note ? [note] : frame(data, selected, cols, rows, color, repo);
    process.stdout.write("\x1b[H\x1b[2J" + lines.join("\r\n"));
  };
  process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?25l");
  draw("Reading the pull requests…");
  data = readPrs(false);
  try {
    selected = selectedOf(data, n);
  } catch (e) {
    process.stdin.setRawMode(false); // the refusal prints on a normal terminal
    process.stdout.write("\x1b[?25h\r\n");
    throw e;
  }
  process.stdout.on("resize", () => draw());
  draw();
  for await (const chunk of process.stdin) {
    const key = String(chunk);
    const count = pulls(data).length;
    if (key === "q" || key === "\x1b" || key === "\x03") break;
    if (key === "j" || key === "\x1b[B") selected = Math.min(selected + 1, Math.max(count - 1, 0));
    else if (key === "k" || key === "\x1b[A") selected = Math.max(selected - 1, 0);
    else if (key === "r") {
      draw("Reading the pull requests from GitHub…");
      data = readPrs(true);
      selected = Math.min(selected, Math.max(pulls(data).length - 1, 0));
    }
    draw();
  }
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?25h\x1b[H\x1b[2J");
  return 0;
}

/** `factory cockpit --prs [<n>]`. */
export function prsView(args: string[]): Promise<number> | number {
  const word = args[0];
  if (args.length > 1 || (word !== undefined && !/^#?\d+$/.test(word))) {
    refuse("cockpit_usage", "factory cockpit --prs takes no argument, or the number of an open pull request.",
      "Run `factory cockpit --prs` for every open PR, or `factory cockpit --prs 12` to open #12's detail.", 2);
  }
  const n = word === undefined ? null : Number(word.replace("#", ""));
  if (process.stdin.isTTY && process.stdout.isTTY) return loop(n);
  const data = readPrs(false);
  const selected = selectedOf(data, n);
  const cols = Number(process.env.COLUMNS) || 100;
  const rows = Number(process.env.LINES) || 30;
  console.log(frame(data, selected, cols, rows, false, repoName()).join("\n"));
  return 0;
}
