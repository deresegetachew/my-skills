// The CI view (#339, #367), drawn after its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VCi.dc.html): three cards
// (where jobs run, the heavy runners on this machine, the leftovers), the runners, the queue and recent runs, and the
// commands that act on them. Its data is the `ci` part of the cockpit's snapshot (`factory ci status --json`, #304), so
// it makes no GitHub call; the heavy runner count is this machine's setting, which the hook passes. Read-only: it names
// the commands, the owner runs them. The glyphs and words carry every state, so without colour nothing is lost.
import { type Line, list, obj, type Obj, plain, seg, type Style } from "./lines.tsx";
import { type Card, cards, clip, heading, padStr, para } from "./doc.tsx";
import type { Got } from "./read.ts";

/** This machine's heavy runner setting (`ci.runners`), as the hook read it; null when factory.json can't be read. */
export interface Heavy {
  raw: string;
  source: string;
}

export interface CiExtra {
  heavy: Heavy | null;
  /** This machine's short name. */
  host: string;
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

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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

function runners(ci: Obj, w: number): Line[] {
  const heavy = listOrNull(ci.runners);
  if (heavy === null) return [[seg("The runners can't be read: see below.", "dim")]];
  const rows = [...heavy.map((r) => ({ r, lane: "heavy" })), ...(listOrNull(obj(ci.light).runners) ?? []).map((r) => ({ r, lane: "light" }))];
  if (!rows.length) {
    const text = plain(ci.mode) === "local"
      ? `No runner has the label ${plain(ci.label)}: factory ci install registers this machine's.`
      : "No self-hosted runner: CI runs on GitHub's runners.";
    return para(text, w, "dim");
  }
  const nameW = Math.min(Math.max(...rows.map(({ r }) => len(plain(r.name)))), 32);
  const out: Line[] = [];
  for (const { r, lane } of rows) {
    const st = plain(r.status) !== "online" ? "down" : r.busy ? "working" : "idle";
    const [g, gs] = GLYPH[st] as [string, Style];
    const job = st === "down" ? "offline" : st === "working" ? "running a job" : "waiting for a job";
    if (w >= 60) out.push([seg(`${g} `, gs), seg(`${padStr(plain(r.name), nameW)}  `), seg(`${padStr(lane, 6)}  `, "dim"), seg(job, "dim")]);
    else out.push([seg(`${g} `, gs), seg(plain(r.name))], [seg(`  ${lane} · ${job}`, "dim")]);
  }
  return out;
}

const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];
const RUN_STYLE: Record<string, Style> = { queued: "amber", waiting: "amber", pending: "amber", requested: "amber",
  running: "blue", success: "green", skipped: "dim", neutral: "dim" };

function runs(ci: Obj, w: number): Line[] {
  const all = listOrNull(ci.runs);
  if (all === null) return [[seg("The runs can't be read: see below.", "dim")]];
  if (!all.length) return [[seg("No runs on main or an open pull request.", "dim")]];
  const active = all.filter((r) => ACTIVE.includes(plain(r.state))).sort((a, b) => num(b.minutesAgo) - num(a.minutesAgo));
  const done = all.filter((r) => !ACTIVE.includes(plain(r.state))).sort((a, b) => num(a.minutesAgo) - num(b.minutesAgo));
  const out: Line[] = [];
  for (const r of [...active, ...done]) {
    const state = plain(r.state) === "in_progress" ? "running" : plain(r.state);
    const style = RUN_STYLE[state] ?? "red";
    const title = `${plain(r.name) || "CI"} on ${plain(r.branch)}`;
    const age = minutesText(num(r.minutesAgo));
    if (w >= 60) {
      const titleW = w - 10 - 10 - len(age) - 2;
      out.push([seg(padStr(state, 10), style), seg(padStr(plain(r.ref), 10), "dim"), seg(padStr(title, titleW)), seg(`  ${age}`, "dim")]);
    } else {
      out.push([seg(padStr(state, 10), style), seg(`${plain(r.ref)}  `, "dim"), seg(age, "dim")], [seg(`  ${clip(title, w - 2)}`)]);
    }
  }
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

/** Every line of the CI view for a snapshot (undefined: still reading), at most `w` wide. */
export function ciLines(snap: Got | undefined, x: CiExtra, w: number, nowMs: number): Line[] {
  if (snap === undefined) return [[seg("Reading the snapshot…")]];
  if (snap === "late") return para("The snapshot took too long to read: run `factory cockpit --json` to see why.", w);
  if (snap === null) return para("No snapshot yet: `factory cockpit --json` reads one now.", w);
  const ci = snap.ci === null || snap.ci === undefined ? null : obj(snap.ci);
  const repo = plain(ci?.repo);
  const out: Line[] = [...heading([seg("factory", "amber"), seg(`  ${repo ? `${repo} · ` : ""}CI`, "dim")],
    `factory ci status · this machine: ${plain(x.host) || "this machine"}`, w), []];
  if (ci === null) {
    const missing = list(snap.missing).filter((m) => plain(m.code) === "ci_unreadable");
    out.push(...problems(missing.length ? missing : [{ message: "The snapshot has no CI part.", fix: "Run `factory ci status`." }], w));
  } else {
    out.push(...cards([whereJobsRun(ci), heavyRunners(ci, x), leftovers(ci)], w), []);
    out.push([seg("Runners", "bold")], ...runners(ci, w), []);
    out.push([seg("Queue and recent runs", "bold")], ...runs(ci, w));
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
