// The cockpit's CI view (#339, PRD US-13): `factory cockpit --ci` draws the CI board from the cockpit's cache: where
// jobs run, the heavy runners, the leftovers, the runners and the queue, and the commands that act on them. It works in
// a plain terminal, on a narrow one and with no colour, and the cockpit's CI view (key 4) runs it.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CI, envWith, gitRepo, HOOKS, SF, sh, tmp, write, WIKI, type Proc } from "./support.ts";

const T = 60_000;
type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;
interface Proj { d: string; root: string; env: Env; xdg: string }

const FAKE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/remanual" : "main"); process.exit(0); }
if (a[0] === "api") { console.log("[]"); process.exit(0); }
console.log("ok");
`;

const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/tmux.log"
for a in "$@"; do [ "$a" = -V ] && { echo "tmux 3.4"; exit 0; }; done
exit 0
`;

function setup(extra: Env = {}): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, ci: { runners: 1 } }));
  const bin = join(root, "bin");
  write(join(bin, "gh"), FAKE_GH, 0o755);
  write(join(bin, "tmux"), FAKE_TMUX, 0o755);
  mkdirSync(join(root, "log"));
  const xdg = join(root, "state");
  mkdirSync(xdg);
  mkdirSync(join(root, "home"));
  const env = envWith(bin, { FAKE_LOG: join(root, "log"), XDG_STATE_HOME: xdg, HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), FACTORY_CONFIG_DIR: undefined, FACTORY_CI_RUNNERS: undefined,
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, TMUX: undefined,
    NO_COLOR: undefined, TERM: "xterm-256color", COLUMNS: "120", ...extra });
  return { d, root, env, xdg };
}

/** The cockpit's cache (cockpit.json in this machine's state folder), as of `minutesOld` ago. */
function seed(p: Proj, snap: Obj, minutesOld = 0): void {
  const at = new Date(Date.now() - minutesOld * 60_000).toISOString();
  write(join(p.xdg, "work-factory", "cockpit.json"), JSON.stringify({ generatedAt: at, sessions: [], needsYou: [],
    pulls: [], missing: [], ...snap }));
}

function cockpit(p: Proj, args: string[], extra: Env = {}): Proc {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: { ...p.env, ...extra }, timeoutMs: 50_000 });
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function noTrace(out: string): void {
  expect(out).not.toMatch(/^\s+at .*(:\d+|\))/m);
  expect(out).not.toMatch(/\b(TypeError|ReferenceError|SyntaxError|Unhandled)\b/);
}

function widest(text: string): number {
  return Math.max(...stripAnsi(text).split("\n").map((l) => [...l].length));
}

const LOCAL: Obj = {
  mode: "local", runsOn: "[\"self-hosted\",\"remanual-local\"]", repo: "o/remanual", label: "remanual-local",
  instances: [
    { id: "1", name: "remanual-ci", state: "running", manager: "systemd", pid: 11 },
    { id: "2", name: "remanual-ci-2", state: "running", manager: "systemd", pid: 12 },
    { id: "3", name: "remanual-ci-3", state: "loop_down", manager: "systemd", pid: null },
    { id: "light", name: "remanual-ci-light", state: "running", manager: "systemd", pid: 14 },
  ],
  docker: 1,
  runs: [
    { ref: "main", branch: "main", state: "in_progress", name: "CI", createdAt: "", minutesAgo: 4 },
    { ref: "#445", branch: "factory-v0.2.1", state: "queued", name: "CI", createdAt: "", minutesAgo: 2 },
    { ref: "#442", branch: "ci-runners-4", state: "success", name: "CI", createdAt: "", minutesAgo: 840 },
    { ref: "#435", branch: "task/410-draft-after-read", state: "failure", name: "CI", createdAt: "", minutesAgo: 900 },
  ],
  runners: [
    { name: "remanual-ci-dev-pc-1", status: "online", busy: true },
    { name: "remanual-ci-dev-pc.2-1", status: "online", busy: false },
    { name: "remanual-ci-old-box-7", status: "offline", busy: false },
  ],
  light: { label: "remanual-light", variableSet: true, runners: [{ name: "remanual-ci-dev-pc.light-1", status: "online", busy: false }],
    noneOnline: false },
  queuedLong: { count: 1, longestMinutes: 20, thresholdMinutes: 15, noRunnerOnline: false },
  errors: [],
};

// --- the board -----------------------------------------------------------------------------------------------------------

test("--ci draws the board: where jobs run, the heavy runners, the leftovers, the runners and the queue", () => {
  const p = setup();
  seed(p, { ci: LOCAL });
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  const t = stripAnsi(r.stdout);
  for (const s of ["CI", "o/remanual", "WHERE JOBS RUN", "local", "remanual-local", "remanual-light", "factory ci use github",
    "HEAVY RUNNERS", "factory ci runners", "LEFTOVERS", "1 offline runner", "factory ci clean", "Runners",
    "Queue and recent runs", "factory ci log"]) {
    expect(t, s).toContain(s);
  }
  // Each runner on its own line, with its lane and what it is doing.
  const line = (name: string) => t.split("\n").find((l) => l.includes(name)) ?? "";
  expect(line("remanual-ci-dev-pc-1 ")).toContain("heavy");
  expect(line("remanual-ci-dev-pc-1 ")).toMatch(/running a job/);
  expect(line("remanual-ci-dev-pc.2-1")).toMatch(/waiting for a job/);
  expect(line("remanual-ci-old-box-7")).toMatch(/offline/);
  expect(line("remanual-ci-dev-pc.light-1")).toContain("light");
  // The board's glyphs carry the state without colour: ● working, ○ idle, ✕ down.
  expect(line("remanual-ci-dev-pc-1 ")).toContain("●");
  expect(line("remanual-ci-dev-pc.2-1")).toContain("○");
  expect(line("remanual-ci-old-box-7")).toContain("✕");
  // Each run: its state, its ref, "<name> on <branch>" and its age.
  expect(line("factory-v0.2.1")).toMatch(/queued.*#445.*CI on factory-v0\.2\.1.*2 min/);
  expect(line("CI on main")).toMatch(/running.*main.*4 min/);
  expect(line("ci-runners-4")).toMatch(/success.*#442.*14 h/);
  expect(line("task/410-draft-after-read")).toMatch(/failure.*#435.*15 h/);
  // Runs waiting long are said once.
  expect(t).toMatch(/1 run queued over 15 min/);
}, T);

test("--ci counts the heavy runners on this machine and says where the count comes from", () => {
  const p = setup({ FACTORY_CI_RUNNERS: "4" });
  seed(p, { ci: LOCAL });
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout);
  expect(t).toMatch(/\b4\b.*FACTORY_CI_RUNNERS|FACTORY_CI_RUNNERS.*\b4\b/);
  // Three heavy instances are installed here, one of them with its loop down.
  expect(t).toMatch(/3 installed/);
  expect(t).toMatch(/1 loop down/);
}, T);

test("--ci with CI on GitHub's runners says so and offers to switch to local", () => {
  const p = setup();
  seed(p, { ci: { ...LOCAL, mode: "github", runsOn: null, instances: [], runners: [], light: null, queuedLong: null } });
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout);
  expect(t).toContain("GitHub's runners");
  expect(t).toContain("factory ci use local");
  expect(t).not.toContain("factory ci use github");
  expect(t).toMatch(/No self-hosted runner/);
}, T);

// --- a plain terminal: narrow, wide, no colour ---------------------------------------------------------------------------

test("--ci on a narrow terminal keeps every line within its width and stacks the cards", () => {
  const p = setup();
  seed(p, { ci: LOCAL });
  const r = cockpit(p, ["--ci"], { COLUMNS: "40" });
  expect(r.code, r.out).toBe(0);
  expect(widest(r.stdout)).toBeLessThanOrEqual(40);
  const t = stripAnsi(r.stdout);
  for (const s of ["WHERE JOBS RUN", "HEAVY RUNNERS", "LEFTOVERS", "Runners", "Queue and recent runs"]) expect(t, s).toContain(s);
  expect(t.split("\n").some((l) => l.includes("WHERE JOBS RUN") && l.includes("LEFTOVERS"))).toBe(false);
  expect(t).toContain("remanual-ci-old-box-7");
}, T);

test("--ci on a wide terminal puts the three cards side by side, within its width", () => {
  const p = setup();
  seed(p, { ci: LOCAL });
  const r = cockpit(p, ["--ci"], { COLUMNS: "140" });
  expect(r.code, r.out).toBe(0);
  expect(widest(r.stdout)).toBeLessThanOrEqual(140);
  const t = stripAnsi(r.stdout);
  expect(t.split("\n").some((l) => l.includes("WHERE JOBS RUN") && l.includes("HEAVY RUNNERS") && l.includes("LEFTOVERS"))).toBe(true);
}, T);

test("--ci with NO_COLOR or a dumb terminal prints no escape sequence; otherwise it colours the states", () => {
  const p = setup();
  seed(p, { ci: LOCAL });
  const coloured = cockpit(p, ["--ci"]);
  expect(coloured.code, coloured.out).toBe(0);
  expect(coloured.stdout).toContain("\x1b[");
  for (const extra of [{ NO_COLOR: "1" }, { TERM: "dumb" }]) {
    const r = cockpit(p, ["--ci"], extra);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain("\x1b");
    expect(r.stdout).toContain("WHERE JOBS RUN");
  }
}, T);

test("--ci prints no control characters from a run's name or branch", () => {
  const p = setup();
  const runs = [{ ref: "#9", branch: "evil\x1b]0;owned\x07\x1b[2J", state: "queued", name: "CI\x1b[31m", createdAt: "", minutesAgo: 1 }];
  seed(p, { ci: { ...LOCAL, runs } });
  const r = cockpit(p, ["--ci"], { NO_COLOR: "1" });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).not.toContain("\x1b");
  expect(r.stdout).not.toContain("\x07");
  expect(r.stdout).toContain("evil");
}, T);

// --- what can't be read --------------------------------------------------------------------------------------------------

test("--ci with no snapshot yet says so and how to read one, and exits 0", () => {
  const p = setup();
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  expect(r.stdout).toContain("No snapshot yet");
  expect(r.stdout).toContain("factory cockpit --json");
}, T);

test("--ci when the snapshot could not read CI shows the problem and its fix", () => {
  const p = setup();
  seed(p, { ci: null, missing: [{ code: "ci_unreadable", message: "CI can't be read right now.", fix: "Run `factory ci status --json`." }] });
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout);
  expect(t).toContain("CI can't be read right now.");
  expect(t).toContain("factory ci status --json");
}, T);

test("--ci shows each error of ci status with its fix, and the runners as unreadable", () => {
  const p = setup();
  const errors = [{ code: "runners_unreadable", message: "The runners on GitHub can't be read (it needs admin on the repository).",
    fix: "Run `gh auth status`, and use an account with admin on the repository." }];
  seed(p, { ci: { ...LOCAL, runners: null, light: null, errors } });
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout);
  expect(t).toContain("The runners on GitHub can't be read");
  expect(t).toContain("gh auth status");
}, T);

test("--ci says how old the snapshot is", () => {
  const p = setup();
  seed(p, { ci: LOCAL }, 30);
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  expect(stripAnsi(r.stdout)).toMatch(/as of 30 min ago/);
}, T);

test("--ci takes nothing after it", () => {
  const p = setup();
  const r = cockpit(p, ["--ci", "extra"]);
  expect(r.code).toBe(2);
  const e = JSON.parse(r.stderr.trim().split("\n").pop() ?? "{}") as Obj;
  expect(e.code).toBe("cockpit_usage");
  expect(String(e.message)).toContain("--ci");
}, T);

// --- where it shows ------------------------------------------------------------------------------------------------------

test("the cockpit's CI view (key 4) runs factory cockpit --ci", async () => {
  const p = setup();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit"], { cwd: p.d, env, terminal: { cols: 120, rows: 40, data() {} } });
  const timer = setTimeout(() => proc.kill(9), 50_000);
  await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  const conf = readFileSync(join(p.xdg, "work-factory", "cockpit.tmux.conf"), "utf8");
  const line = conf.split("\n").find((l) => l.startsWith("bind 4 ")) ?? "";
  expect(line, conf).toContain("cockpit --ci");
}, T);

test("factory help and the wiki's commands page list factory cockpit --ci", () => {
  const p = setup();
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/cockpit --ci\s+\S/);
  expect(readFileSync(join(WIKI, "commands.md"), "utf8")).toContain("`factory cockpit --ci`");
}, T);
