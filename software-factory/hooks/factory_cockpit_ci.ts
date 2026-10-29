// `factory cockpit --ci` (#339, PRD US-13): the cockpit's CI view, drawn after its board
// (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VCi.dc.html). Three cards (where jobs run, the heavy runners on this machine,
// the leftovers), the runners, the queue and recent runs, and the commands that act on them. Its data is the `ci` part of
// the cockpit's cache (`factory ci status --json`, #304), so it makes no GitHub call; the heavy runner count is this
// machine's setting (ci_names.ts). Read-only: it names the commands, the owner runs them.
//
// A plain terminal: it fits COLUMNS (else the terminal's width, else 80), stacks the cards under 96 columns, and the
// glyphs and words carry every state, so NO_COLOR (or TERM=dumb) only drops the colours.
import { hostname } from "node:os";
import { config as ciConfig, runnerSetting, sourceText } from "../ci/ci_names.ts";
import { readCache } from "./factory_cockpit.ts";
import { plain } from "./factory_cockpit_ui.ts";

type Obj = { [key: string]: unknown };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function list(v: unknown): Obj[] | null {
  return Array.isArray(v) ? v.map(obj) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// --- text that fits ------------------------------------------------------------------------------------------------

/** The board's colours, as 256-colour codes. */
const STYLE = { bold: "1", dim: "38;5;247", amber: "38;5;215", blue: "38;5;75", green: "38;5;71", red: "38;5;210" } as const;
type Style = keyof typeof STYLE | "";
type Seg = [string, Style];

let COLOR = false;

function paint(text: string, style: Style): string {
  return COLOR && style && text ? `\x1b[${STYLE[style]}m${text}\x1b[0m` : text;
}

function len(s: string): number {
  return [...s].length;
}

function cut(s: string, w: number): string {
  const cs = [...s];
  return cs.length <= w ? s : `${cs.slice(0, Math.max(w - 1, 0)).join("")}…`;
}

function pad(s: string, w: number): string {
  const t = cut(s, w);
  return t + " ".repeat(Math.max(w - len(t), 0));
}

/** One line of segments, cut to `w` visible characters, coloured after cutting. */
function line(segs: Seg[], w: number): string {
  let left = w;
  let out = "";
  for (const [text, style] of segs) {
    if (left <= 0) break;
    const t = len(text) > left ? cut(text, left) : text;
    out += paint(t, style);
    left -= len(t);
  }
  return out;
}

/** Words (or the parts between `sep`) wrapped to `w` columns; one longer than that is cut. */
function wrap(text: string, w: number, sep = " "): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(sep).filter(Boolean)) {
    if (cur && len(cur) + len(sep) + len(word) > w) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}${sep}${word}` : cut(word, w);
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

function width(): number {
  const given = Number(process.env.COLUMNS) || process.stdout.columns;
  if (given) return Math.max(given, 20);
  if (process.stdin.isTTY) {
    // In the cockpit's popup stdout is less's pipe, but stdin is the popup's terminal.
    const p = Bun.spawnSync(["stty", "size"], { stdin: "inherit", stdout: "pipe", stderr: "ignore" });
    const cols = Number(p.stdout.toString().trim().split(/\s+/)[1]);
    if (cols) return Math.max(cols, 20);
  }
  return 80;
}

function ago(minutes: number): string {
  const m = Math.max(Math.floor(minutes), 0);
  return m < 120 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --- the cards -----------------------------------------------------------------------------------------------------

interface Card { title: string; lines: Array<[string, Style]>; warn: boolean }

function host(): string {
  return plain(hostname().split(".")[0]) || "this machine";
}

function whereJobsRun(ci: Obj): Card {
  const mode = plain(ci.mode);
  const light = obj(ci.light);
  const lane = plain(light.label) ? ` · light lane ${plain(light.label)}` : "";
  if (mode === "local") {
    return { title: "WHERE JOBS RUN", warn: false, lines: [["local · self-hosted", "bold"],
      [`CI_RUNS_ON ${plain(ci.label)}${lane}`, "dim"], ["switch to GitHub's runners:", "dim"], ["factory ci use github", "dim"]] };
  }
  if (mode === "github") {
    return { title: "WHERE JOBS RUN", warn: false, lines: [["GitHub's runners", "bold"], ["CI_RUNS_ON is not set", "dim"],
      ["switch to this machine's runners:", "dim"], ["factory ci use local", "dim"]] };
  }
  return { title: "WHERE JOBS RUN", warn: true, lines: [["unknown", "bold"],
    ["gh can't read CI_RUNS_ON; it needs admin on the repository", "dim"]] };
}

function heavyRunners(ci: Obj): Card {
  const lines: Array<[string, Style]> = [];
  try {
    const { raw, source } = runnerSetting(ciConfig());
    lines.push([`${plain(raw)} wanted · from ${sourceText(source)}`, "bold"]);
  } catch {
    lines.push([".claude/factory.json can't be read", "red"]);
  }
  const here = (list(ci.instances) ?? []).filter((i) => plain(i.id) !== "light");
  const installed = here.filter((i) => plain(i.state) !== "not_running");
  const down = here.filter((i) => ["loop_down", "not_loaded"].includes(plain(i.state))).length;
  lines.push([installed.length ? `${installed.length} installed here${down ? `, ${down} loop down` : ""}` : "none installed here",
    down ? "amber" : "dim"]);
  lines.push(["change, then reinstall:", "dim"], ["factory ci runners N", "dim"], ["factory ci install", "dim"]);
  return { title: `HEAVY RUNNERS ON ${host().toUpperCase()}`, warn: down > 0, lines };
}

function leftovers(ci: Obj): Card {
  const all = list(ci.runners);
  if (all === null) {
    return { title: "LEFTOVERS", warn: false, lines: [["the runners can't be read", "dim"], ["factory ci clean lists them", "dim"]] };
  }
  const offline = [...all, ...(list(obj(ci.light).runners) ?? [])].filter((r) => plain(r.status) === "offline").length;
  return { title: "LEFTOVERS", warn: offline > 0, lines: [[offline ? `${plural(offline, "offline runner")}` : "no offline runner", "bold"],
    ["list, then clean on yes:", "dim"], ["factory ci clean", "dim"], ["runner files up to date?", "dim"], ["factory ci stale", "dim"]] };
}

/** The cards side by side (one row of boxes), or stacked when the terminal is narrow. */
function drawCards(cards: Card[], w: number): string[] {
  const side = w >= 96;
  const gap = 2;
  const cw = side ? Math.floor((w - gap * (cards.length - 1)) / cards.length) : w;
  const inner = cw - 4;
  const boxes = cards.map((c) => {
    const body: Array<[string, Style]> = [[c.title, "dim"]];
    for (const [text, style] of c.lines) for (const l of wrap(text, inner)) body.push([l, style]);
    return { c, body };
  });
  const tall = Math.max(...boxes.map((b) => b.body.length));
  const drawn = boxes.map(({ c, body }) => {
    const edge: Style = c.warn ? "amber" : "dim";
    const rows = [paint(`┌${"─".repeat(cw - 2)}┐`, edge)];
    for (let i = 0; i < (side ? tall : body.length); i++) {
      const [text, style] = body[i] ?? ["", ""];
      rows.push(paint("│", edge) + " " + paint(pad(text, inner), style) + " " + paint("│", edge));
    }
    rows.push(paint(`└${"─".repeat(cw - 2)}┘`, edge));
    return rows;
  });
  if (!side) return drawn.flat();
  return (drawn[0] ?? []).map((_, i) => drawn.map((d) => d[i] ?? "").join(" ".repeat(gap)));
}

// --- the runners and the runs --------------------------------------------------------------------------------------

const GLYPH: Record<string, [string, Style]> = { working: ["●", "blue"], idle: ["○", "dim"], down: ["✕", "red"] };

function drawRunners(ci: Obj, w: number): string[] {
  const heavy = list(ci.runners);
  if (heavy === null) return [line([["The runners can't be read: see below.", "dim"]], w)];
  const rows = [...heavy.map((r) => ({ r, lane: "heavy" })), ...(list(obj(ci.light).runners) ?? []).map((r) => ({ r, lane: "light" }))];
  if (!rows.length) {
    const text = plain(ci.mode) === "local"
      ? `No runner has the label ${plain(ci.label)}: factory ci install registers this machine's.`
      : "No self-hosted runner: CI runs on GitHub's runners.";
    return wrap(text, w).map((l) => line([[l, "dim"]], w));
  }
  const nameW = Math.min(Math.max(...rows.map(({ r }) => len(plain(r.name)))), 32);
  const out: string[] = [];
  for (const { r, lane } of rows) {
    const st = plain(r.status) !== "online" ? "down" : r.busy ? "working" : "idle";
    const [g, gs] = GLYPH[st] as [string, Style];
    const job = st === "down" ? "offline" : st === "working" ? "running a job" : "waiting for a job";
    if (w >= 60) {
      out.push(line([[`${g} `, gs], [`${pad(plain(r.name), nameW)}  `, ""], [`${pad(lane, 6)}  `, "dim"], [job, "dim"]], w));
    } else {
      out.push(line([[`${g} `, gs], [plain(r.name), ""]], w), line([[`  ${lane} · ${job}`, "dim"]], w));
    }
  }
  return out;
}

const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];
const RUN_STYLE: Record<string, Style> = { queued: "amber", waiting: "amber", pending: "amber", requested: "amber",
  running: "blue", success: "green", skipped: "dim", neutral: "dim" };

function drawRuns(ci: Obj, w: number): string[] {
  const runs = list(ci.runs);
  if (runs === null) return [line([["The runs can't be read: see below.", "dim"]], w)];
  if (!runs.length) return [line([["No runs on main or an open pull request.", "dim"]], w)];
  const active = runs.filter((r) => ACTIVE.includes(plain(r.state))).sort((a, b) => num(b.minutesAgo) - num(a.minutesAgo));
  const done = runs.filter((r) => !ACTIVE.includes(plain(r.state))).sort((a, b) => num(a.minutesAgo) - num(b.minutesAgo));
  const out: string[] = [];
  for (const r of [...active, ...done]) {
    const state = plain(r.state) === "in_progress" ? "running" : plain(r.state);
    const style = RUN_STYLE[state] ?? "red";
    const title = `${plain(r.name) || "CI"} on ${plain(r.branch)}`;
    const age = ago(num(r.minutesAgo));
    if (w >= 60) {
      const titleW = w - 10 - 10 - len(age) - 2;
      out.push(line([[pad(state, 10), style], [pad(plain(r.ref), 10), "dim"], [pad(title, titleW), ""], [`  ${age}`, "dim"]], w));
    } else {
      out.push(line([[pad(state, 10), style], [`${plain(r.ref)}  `, "dim"], [age, "dim"]], w), line([[`  ${title}`, ""]], w));
    }
  }
  const q = obj(ci.queuedLong);
  if (num(q.count)) {
    out.push(...wrap(`${plural(num(q.count), "run")} queued over ${num(q.thresholdMinutes)} min (the longest ${num(q.longestMinutes)} min)`, w)
      .map((l) => line([[l, "amber"]], w)));
  }
  if (q.noRunnerOnline === true) {
    out.push(...wrap(`No runner with the label ${plain(ci.label)} is online, so they wait: factory ci install`, w).map((l) => line([[l, "red"]], w)));
  }
  return out;
}

function drawProblems(problems: Obj[], w: number): string[] {
  const out: string[] = [];
  for (const p of problems) {
    out.push(...wrap(plain(p.message), w).map((l) => line([[l, "red"]], w)));
    if (plain(p.fix)) out.push(...wrap(`fix: ${plain(p.fix)}`, w).map((l) => line([[l, "dim"]], w)));
  }
  return out;
}

// --- the view ------------------------------------------------------------------------------------------------------

const KEYS = "job log: factory ci log <pr or run> · runner logs: factory ci logs · runners: factory ci runners N · " +
  "clean: factory ci clean · reinstall: factory ci install · local or GitHub: factory ci use local|github · " +
  "shared build cache: factory turbo status";

/** The CI view of a snapshot (the cockpit's cache), as lines at most `w` wide. */
export function render(snap: Obj | null, w: number, nowMs: number): string[] {
  if (snap === null) return wrap("No snapshot yet: `factory cockpit --json` reads one now.", w);
  const ci = snap.ci === null || snap.ci === undefined ? null : obj(snap.ci);
  const repo = plain(ci?.repo);
  const right = `factory ci status · this machine: ${host()}`;
  const left: Seg[] = [["factory", "amber"], [`  ${repo ? `${repo} · ` : ""}CI`, "dim"]];
  const leftW = len("factory") + 2 + len(repo ? `${repo} · CI` : "CI");
  const out = [w - leftW >= len(right) + 2 ? line([...left, [" ".repeat(w - leftW - len(right)), ""], [right, "dim"]], w) : line(left, w), ""];
  if (ci === null) {
    const missing = (list(snap.missing) ?? []).filter((m) => plain(m.code) === "ci_unreadable");
    out.push(...drawProblems(missing.length ? missing : [{ message: "The snapshot has no CI part.", fix: "Run `factory ci status`." }], w));
  } else {
    out.push(...drawCards([whereJobsRun(ci), heavyRunners(ci), leftovers(ci)], w), "");
    out.push(line([["Runners", "bold"]], w), ...drawRunners(ci, w), "");
    out.push(line([["Queue and recent runs", "bold"]], w), ...drawRuns(ci, w));
    const errors = list(ci.errors) ?? [];
    if (errors.length) out.push("", ...drawProblems(errors, w));
  }
  const at = Date.parse(plain(snap.generatedAt));
  const mins = (nowMs - at) / 60_000;
  const age = Number.isNaN(at) ? "age unknown" : mins < 1 ? "as of now" : `as of ${ago(mins)} ago`;
  // Wrapped between the commands, so none is split over two lines.
  out.push("", ...wrap(`${KEYS} · ${age}`, w, " · ").map((l) => line([[l, "dim"]], w)));
  return out;
}

export function ciView(): number {
  COLOR = !process.env.NO_COLOR && !["", "dumb"].includes(process.env.TERM ?? "");
  console.log(render(readCache(), width(), Date.now()).join("\n"));
  return 0;
}
