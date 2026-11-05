// The CI view (#339, #367), drawn after its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VCi.dc.html): the verdict in
// one line (#396), three cards (where jobs run, the heavy runners on this machine, the leftovers), each machine's
// runners, the queue and recent runs, the pull requests waiting on CI, and the commands that act on them. Its data is the
// `ci` part of the cockpit's snapshot (`factory ci status --json`, #304), so it makes no GitHub call; the heavy runner
// count and the light lane are this machine's settings, which the hook passes. On a terminal (CiView) its keys act,
// each after a y/N question (#396): i install, l g where jobs run, + - heavy runners, L the light lane (a pull request,
// since .claude/factory.json is protected), c clean, Tab picks a run, Enter its log, R reruns a failed one. The glyphs
// and words carry every state, so without colour nothing is lost.
import type { Key } from "ink";
import { type ReactElement, useState } from "react";
import { type Line, list, obj, type Obj, plain, seg, type Style } from "./lines.tsx";
import { type Card, cards, clip, type DocAction, DocView, heading, padStr, para } from "./doc.tsx";
import type { Got } from "./read.ts";
import { ACTIVE, type CiActionName, ciActionOf, ciVerdict as verdictOf, machineOf, orderedRuns, plural, waitingPulls } from "../../hooks/factory_ci_view.ts";

export { machineOf, orderedRuns, plural };

/** What CI is doing, in one line, and its style (factory_ci_view.ts judges it, for the web UI too). */
export function ciVerdict(ci: Obj): [string, Style] {
  return verdictOf(ci);
}

/** This machine's heavy runner setting (`ci.runners`), as the hook read it; null when factory.json can't be read. */
export interface Heavy {
  raw: string;
  source: string;
}

export interface CiExtra {
  heavy: Heavy | null;
  /** This machine's short name. */
  host: string;
  /** The light lane setting (`ci.light`); null when it can't be read. Only the keys use it. */
  light?: boolean | null;
}

function listOrNull(v: unknown): Obj[] | null {
  return Array.isArray(v) ? list(v) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function len(s: string): number {
  return [...s].length;
}

export function minutesText(minutes: number): string {
  const m = Math.max(Math.floor(minutes), 0);
  return m < 120 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
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

function heavyRunners(ci: Obj, x: CiExtra): Card {
  const lines: Card["lines"] = [];
  if (x.heavy) lines.push([`${plain(x.heavy.raw)} wanted · from ${plain(x.heavy.source)}`, "bold"]);
  else lines.push([".claude/factory.json can't be read", "red"]);
  const here = (listOrNull(ci.instances) ?? []).filter((i) => plain(i.id) !== "light");
  const installed = here.filter((i) => plain(i.state) !== "not_running");
  const down = here.filter((i) => ["loop_down", "not_loaded"].includes(plain(i.state))).length;
  lines.push([installed.length ? `${installed.length} installed here${down ? `, ${down} loop down` : ""}` : "none installed here",
    down ? "amber" : "dim"]);
  lines.push(["change, then reinstall:", "dim"], ["factory ci runners N", "dim"], ["factory ci install", "dim"]);
  return { title: `HEAVY RUNNERS ON ${(plain(x.host) || "this machine").toUpperCase()}`, warn: down > 0, lines };
}

function leftovers(ci: Obj): Card {
  const all = listOrNull(ci.runners);
  if (all === null) {
    return { title: "LEFTOVERS", warn: false, lines: [["the runners can't be read", "dim"], ["factory ci clean lists them", "dim"]] };
  }
  const offline = [...all, ...(listOrNull(obj(ci.light).runners) ?? [])].filter((r) => plain(r.status) === "offline").length;
  return { title: "LEFTOVERS", warn: offline > 0, lines: [[offline ? plural(offline, "offline runner") : "no offline runner", "bold"],
    ["list, then clean on yes:", "dim"], ["factory ci clean", "dim"], ["runner files up to date?", "dim"], ["factory ci stale", "dim"]] };
}

const GLYPH: Record<string, [string, Style]> = { working: ["●", "blue"], idle: ["○", "dim"], down: ["✕", "red"] };

function runners(ci: Obj, x: CiExtra, w: number): Line[] {
  const heavy = listOrNull(ci.runners);
  if (heavy === null) return [[seg("The runners can't be read: see below.", "dim")]];
  const rows = [...heavy.map((r) => ({ r, lane: "heavy" })), ...(listOrNull(obj(ci.light).runners) ?? []).map((r) => ({ r, lane: "light" }))];
  if (!rows.length) {
    const text = plain(ci.mode) === "local"
      ? `No runner has the label ${plain(ci.label)}: factory ci install registers this machine's.`
      : "No self-hosted runner: CI runs on GitHub's runners.";
    return para(text, w, "dim");
  }
  const here = plain(x.host);
  const byMachine = new Map<string, typeof rows>();
  for (const row of rows) {
    const m = machineOf(plain(row.r.name), plain(ci.repo));
    byMachine.set(m, [...(byMachine.get(m) ?? []), row]);
  }
  const machines = [...byMachine.keys()].sort((a, b) => Number(b === here) - Number(a === here) || a.localeCompare(b));
  const nameW = Math.min(Math.max(...rows.map(({ r }) => len(plain(r.name)))), 32);
  const out: Line[] = [];
  for (const m of machines) {
    out.push([seg(m, "bold"), ...(m === here ? [seg(" · this machine", "dim")] : [])]);
    for (const { r, lane } of byMachine.get(m) ?? []) {
      const st = plain(r.status) !== "online" ? "down" : r.busy ? "working" : "idle";
      const [g, gs] = GLYPH[st] as [string, Style];
      const job = st === "down" ? "offline" : st === "working" ? "running a job" : "waiting for a job";
      if (w >= 60) out.push([seg(`  ${g} `, gs), seg(`${padStr(plain(r.name), nameW)}  `), seg(`${padStr(lane, 6)}  `, "dim"), seg(job, "dim")]);
      else out.push([seg(`  ${g} `, gs), seg(plain(r.name))], [seg(`    ${lane} · ${job}`, "dim")]);
    }
  }
  return out;
}

const RUN_STYLE: Record<string, Style> = { queued: "amber", waiting: "amber", pending: "amber", requested: "amber",
  running: "blue", success: "green", skipped: "dim", neutral: "dim" };

function stateWord(r: Obj): string {
  return plain(r.state) === "in_progress" ? "running" : plain(r.state);
}

function waiting(ci: Obj, w: number): Line[] {
  if (listOrNull(ci.runs) === null) return [[seg("The runs can't be read: see below.", "dim")]];
  const pulls = waitingPulls(ci);
  if (!pulls.length) return [[seg("No pull request is waiting on CI.", "dim")]];
  return pulls.map((r) => {
    const state = stateWord(r);
    return [seg(`${padStr(plain(r.ref), 7)} `), seg(padStr(state, 8), RUN_STYLE[state] ?? "amber"),
      seg(padStr(minutesText(num(r.minutesAgo)), 8), "dim"), seg(clip(plain(r.branch), Math.max(w - 24, 1)))];
  });
}

/** The queue and recent runs; `selected` (the CI view's Tab) marks that run with `›`, -1 marks none. */
function runs(ci: Obj, w: number, selected: number): Line[] {
  const all = listOrNull(ci.runs);
  if (all === null) return [[seg("The runs can't be read: see below.", "dim")]];
  if (!all.length) return [[seg("No runs on main or an open pull request.", "dim")]];
  const out: Line[] = [];
  const mark = selected >= 0 ? 2 : 0;
  orderedRuns(ci).forEach((r, i) => {
    const lead = mark ? [seg(i === selected ? "› " : "  ", "bold")] : [];
    const state = stateWord(r);
    const style = RUN_STYLE[state] ?? "red";
    const title = `${plain(r.name) || "CI"} on ${plain(r.branch)}`;
    const age = minutesText(num(r.minutesAgo));
    if (w >= 60) {
      const titleW = w - mark - 10 - 10 - len(age) - 2;
      out.push([...lead, seg(padStr(state, 10), style), seg(padStr(plain(r.ref), 10), "dim"), seg(padStr(title, titleW)), seg(`  ${age}`, "dim")]);
    } else {
      out.push([...lead, seg(padStr(state, 10), style), seg(`${plain(r.ref)}  `, "dim"), seg(age, "dim")],
        [seg(`${" ".repeat(mark)}  ${clip(title, w - 2 - mark)}`)]);
    }
  });
  const q = obj(ci.queuedLong);
  if (num(q.count)) {
    out.push(...para(`${plural(num(q.count), "run")} queued over ${num(q.thresholdMinutes)} min (the longest ${num(q.longestMinutes)} min)`, w, "amber"));
  }
  if (q.noRunnerOnline === true) {
    out.push(...para(`No runner with the label ${plain(ci.label)} is online, so they wait: factory ci install`, w, "red"));
  }
  return out;
}

function problems(ps: Obj[], w: number): Line[] {
  const out: Line[] = [];
  for (const p of ps) {
    out.push(...para(plain(p.message), w, "red"));
    if (plain(p.fix)) out.push(...para(`fix: ${plain(p.fix)}`, w, "dim"));
  }
  return out;
}

const KEYS = "job log: factory ci log <pr or run> · runner logs: factory ci logs · runners: factory ci runners N · " +
  "clean: factory ci clean · reinstall: factory ci install · local or GitHub: factory ci use local|github · " +
  "shared build cache: factory turbo status";

/** The `ci` part of a snapshot, or null when there is none. */
function ciOf(snap: Got | undefined): Obj | null {
  return snap && snap !== "late" && snap.ci !== null && snap.ci !== undefined ? obj(snap.ci) : null;
}

/** Every line of the CI view for a snapshot (undefined: still reading), at most `w` wide; `selected` marks a run (-1:
 *  none, as off a terminal). */
export function ciLines(snap: Got | undefined, x: CiExtra, w: number, nowMs: number, selected = -1): Line[] {
  if (snap === undefined) return [[seg("Reading the snapshot…")]];
  if (snap === "late") return para("The snapshot took too long to read: run `factory cockpit --json` to see why.", w);
  if (snap === null) return para("No snapshot yet: `factory cockpit --json` reads one now.", w);
  const ci = ciOf(snap);
  const repo = plain(ci?.repo);
  const out: Line[] = [...heading([seg("factory", "amber"), seg(`  ${repo ? `${repo} · ` : ""}CI`, "dim")],
    `factory ci status · this machine: ${plain(x.host) || "this machine"}`, w), []];
  if (ci === null) {
    const missing = list(snap.missing).filter((m) => plain(m.code) === "ci_unreadable");
    out.push(...problems(missing.length ? missing : [{ message: "The snapshot has no CI part.", fix: "Run `factory ci status`." }], w));
  } else {
    const [verdict, style] = ciVerdict(ci);
    out.push(...para(verdict, w, style), []);
    out.push(...cards([whereJobsRun(ci), heavyRunners(ci, x), leftovers(ci)], w), []);
    out.push([seg("Runners", "bold")], ...runners(ci, x, w), []);
    out.push([seg("Queue and recent runs", "bold")], ...runs(ci, w, selected), []);
    out.push([seg("Waiting on CI", "bold")], ...waiting(ci, w));
    const errors = list(ci.errors);
    if (errors.length) out.push([], ...problems(errors, w));
  }
  const at = Date.parse(plain(snap.generatedAt));
  const mins = (nowMs - at) / 60_000;
  const age = Number.isNaN(at) ? "age unknown" : mins < 1 ? "as of now" : `as of ${minutesText(mins)} ago`;
  // Wrapped between the commands, so none is split over two lines.
  out.push([], ...para(`${KEYS} · ${age}`, w, "dim", " · "));
  return out;
}

// --- the keys (#396) -------------------------------------------------------------------------------------------------

export const CI_KEYS = "j k scroll · Tab run · Enter log · R rerun · i install · l g local/GitHub · + - runners · " +
  "L light lane · c clean · r read again · q close";

const KEY_ACTIONS: Record<string, CiActionName> = { i: "install", l: "use-local", g: "use-github", "+": "runners-up", "-": "runners-down",
  L: "light-lane", c: "clean", R: "rerun" };

/** What a key does in the CI view: a question, a log to open, a note, or null when the key is not the view's. */
export function ciAction(input: string, key: Key, snap: Got, x: CiExtra, selected: number): DocAction | null {
  const ci = ciOf(snap);
  if (ci === null) return null;
  const run = orderedRuns(ci)[selected];
  if (key.return) return ciActionOf("log", ci, x, run);
  const name = KEY_ACTIONS[input];
  return name ? ciActionOf(name, ci, x, run) : null;
}

export interface CiProps {
  cols: number;
  rows: number;
  color: boolean;
  data?: Got;
  load: () => Promise<Got>;
  x: CiExtra;
  /** Runs an action's steps in order and gives the output to show. */
  run: (steps: string[][]) => Promise<string>;
  now?: () => number;
  find?: string;
}

/** The CI view on a terminal: the document, a run picked with Tab, and the keys that act. */
export function CiView(p: CiProps): ReactElement {
  const [picked, setPicked] = useState(0);
  const count = (d: Got | undefined) => orderedRuns(ciOf(d) ?? {}).length;
  const at = (d: Got | undefined) => (count(d) ? picked % count(d) : -1);
  const draw = (d: Got | undefined, cols: number) => ciLines(d, p.x, cols, (p.now ?? Date.now)(), at(d));
  const act = (input: string, key: Key, d: Got): DocAction | null => {
    if (key.tab) {
      setPicked((n) => (count(d) ? (n + 1) % count(d) : 0));
      return { kind: "done" };
    }
    return ciAction(input, key, d, p.x, at(d));
  };
  return <DocView cols={p.cols} rows={p.rows} color={p.color} data={p.data} draw={draw} load={p.load} find={p.find}
    keys={CI_KEYS} act={act} run={p.run} />;
}
