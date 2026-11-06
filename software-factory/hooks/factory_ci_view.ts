// What the CI view judges and what its actions run (#396), with no I/O and no UI: the web UI's CI channel (#424,
// factory_ui_views.ts) serves it. Its input is the `ci` part of the snapshot (`factory snapshot`, from `factory ci
// status --json`, #304).

type Obj = { [key: string]: unknown };

/** The verdict's colour. */
export type Tone = "green" | "amber" | "red";

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function listOrNull(v: unknown): Obj[] | null {
  return Array.isArray(v) ? v.map(obj) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A string or number as text, without escape sequences or control characters. */
function plain(v: unknown): string {
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];
const QUEUED = ["queued", "waiting", "pending", "requested"];
export const FAILED = ["failure", "timed_out", "cancelled", "startup_failure"];

/** The runs as the view lists them: those still going, oldest first, then the finished ones, newest first. */
export function orderedRuns(ci: Obj): Obj[] {
  const all = listOrNull(ci.runs) ?? [];
  const active = all.filter((r) => ACTIVE.includes(plain(r.state))).sort((a, b) => num(b.minutesAgo) - num(a.minutesAgo));
  const done = all.filter((r) => !ACTIVE.includes(plain(r.state))).sort((a, b) => num(a.minutesAgo) - num(b.minutesAgo));
  return [...active, ...done];
}

/** The pull requests whose run is queued or running, one each, oldest first. */
export function waitingPulls(ci: Obj): Obj[] {
  const seen = new Set<string>();
  return orderedRuns(ci).filter((r) => {
    const ref = plain(r.ref);
    if (!/^#\d+$/.test(ref) || !ACTIVE.includes(plain(r.state)) || seen.has(ref)) return false;
    seen.add(ref);
    return true;
  });
}

/** The machine a runner registered from: its name is `<repo>-ci-<machine>[.<instance>]-<n>` (ci/loop.sh). */
export function machineOf(name: string, repo: string): string {
  const prefix = `${repo.split("/")[1] ?? ""}-ci-`.toLowerCase();
  const rest = prefix !== "-ci-" && name.startsWith(prefix) ? name.slice(prefix.length) : (/-ci-(.+)$/.exec(name)?.[1] ?? "");
  return rest.replace(/-\d+$/, "").replace(/\.[^.]*$/, "") || "unknown machine";
}

/** What CI is doing, in one line, and its colour: stuck, busy, slow, fine, or what can't be told. */
export function ciVerdict(ci: Obj): [string, Tone] {
  const queued = (listOrNull(ci.runs) ?? []).filter((r) => QUEUED.includes(plain(r.state))).length;
  const q = queued ? `${plural(queued, "run")} queued` : "nothing queued";
  const mode = plain(ci.mode);
  if (mode === "github") {
    const long = obj(ci.queuedLong);
    if (num(long.count)) return [`CI is slow: ${plural(num(long.count), "run")} queued over ${num(long.thresholdMinutes)} min on GitHub's runners`, "amber"];
    return [`CI is fine: on GitHub's runners, ${q}`, "green"];
  }
  if (mode !== "local") return ["CI is unknown: gh can't read CI_RUNS_ON", "amber"];
  const heavy = listOrNull(ci.runners);
  if (heavy === null) return ["CI can't be judged: the runners can't be read", "amber"];
  const online = heavy.filter((r) => plain(r.status) === "online");
  if (!online.length) {
    const n = waitingPulls(ci).length;
    const prs = n === 0 ? "no PR is waiting" : n === 1 ? "1 PR is waiting" : `${n} PRs are waiting`;
    return [`CI is stuck: no runner online for ${plain(ci.label)}; ${prs}`, "red"];
  }
  if (online.every((r) => r.busy === true)) {
    const all = online.length === 1 ? "the one runner online is running a job" : `all ${online.length} runners online are running jobs`;
    return [`CI is busy: ${all}; ${q}`, "amber"];
  }
  return [`CI is fine: ${plural(online.length, "runner")} online, ${q}`, "green"];
}

// --- the actions (#396) ------------------------------------------------------------------------------------------------

/** This machine's runner settings, as the caller read them: the heavy count (`ci.runners`, null when it can't be read)
 *  and the light lane (`ci.light`, null when it can't be read). */
export interface CiSettingsSeen {
  heavy: { raw: string; source: string } | null;
  light?: boolean | null;
}

/** What an action does: steps to run after a question (`does` says what changes), a log to open, or a note. */
export type CiAction = { kind: "ask"; steps: string[][]; does: string } | { kind: "open"; steps: string[][] } | { kind: "note"; text: string };

export const MOST_RUNNERS = 16;

/** The actions the CI view offers, by name, in the order it lists them. `rerun` and `log` act on a run. */
export const CI_ACTIONS = ["install", "use-local", "use-github", "runners-up", "runners-down", "light-lane", "clean", "rerun", "log"] as const;
export type CiActionName = (typeof CI_ACTIONS)[number];

function ask(steps: string[][], does: string): CiAction {
  return { kind: "ask", steps, does };
}

function note(text: string): CiAction {
  return { kind: "note", text };
}

function scale(x: CiSettingsSeen, by: number): CiAction {
  const raw = plain(x.heavy?.raw);
  if (!x.heavy || !/^\d+$/.test(raw)) {
    return note("The heavy runner count can't be read here: `factory ci runners` says what it is and where it comes from.");
  }
  const n = Number(raw) + by;
  if (n > MOST_RUNNERS) return note(`${MOST_RUNNERS} heavy runners is the most: \`factory ci runners\` takes 1 to ${MOST_RUNNERS}.`);
  if (n < 1) return note(`1 heavy runner is the fewest: \`factory ci runners\` takes 1 to ${MOST_RUNNERS}.`);
  return ask([["factory", "ci", "runners", String(n)]],
    `saves ${plural(n, "heavy runner")} for this project on this machine (not committed) and reinstalls them`);
}

function lightLane(x: CiSettingsSeen): CiAction {
  if (typeof x.light !== "boolean") return note("The light lane setting (ci.light) can't be read: `factory settings get ci.light` shows why.");
  const turn = x.light ? "off" : "on";
  return ask([["factory", "settings", "set", "--stage", "ci.light", String(!x.light)], ["factory", "settings", "pr"]],
    `turns the light lane ${turn}: .claude/factory.json is protected, so it changes it through a pull request, never on ` +
    "main; that pull request carries any other setting changes you staged too (factory settings diff --staged lists them)");
}

function runLog(r: Obj | undefined): CiAction {
  if (!r) return note("There is no run to open: read the snapshot again.");
  const ref = plain(r.ref);
  if (/^#\d+$/.test(ref)) return { kind: "open", steps: [["factory", "ci", "log", ref.slice(1)]] };
  if (typeof r.id === "number") return { kind: "open", steps: [["factory", "ci", "log", String(r.id)]] };
  return note("This run has no id to open its log by: read the snapshot again.");
}

function rerun(r: Obj | undefined, repo: string): CiAction {
  if (!r || !FAILED.includes(plain(r.state))) return note("Only a failed run can be rerun: pick one.");
  if (typeof r.id !== "number" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return note("This run has no id to rerun it by: read the snapshot again.");
  }
  return ask([["gh", "run", "rerun", String(r.id), "--failed", "--repo", repo]], "reruns that run's failed jobs on GitHub");
}

/** What action `name` does on CI `ci`, with this machine's settings `x`; `run` is the run it acts on (rerun, log). */
export function ciActionOf(name: CiActionName, ci: Obj, x: CiSettingsSeen, run?: Obj): CiAction {
  switch (name) {
    case "install": return ask([["factory", "ci", "install"]], "installs or reinstalls this machine's runners for this project");
    case "use-local": return ask([["factory", "ci", "use", "local"]], "sends CI jobs to the self-hosted runners (the repository's CI_RUNS_ON)");
    case "use-github": return ask([["factory", "ci", "use", "github"]], "sends CI jobs to GitHub's runners (the repository's CI_RUNS_ON)");
    case "runners-up": return scale(x, 1);
    case "runners-down": return scale(x, -1);
    case "light-lane": return lightLane(x);
    case "clean": return ask([["factory", "ci", "clean", "--apply"]], "removes this project's offline idle runners and exited CI containers");
    case "rerun": return rerun(run, plain(ci.repo));
    case "log": return runLog(run);
  }
}
