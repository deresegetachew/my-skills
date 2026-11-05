// The cockpit's CI view (#396): a verdict first, a list of the pull requests waiting on CI, the runners grouped by machine,
// and the keys that install, switch and scale runners (each asks y/N first, and runs through a fake). Drawn with
// ink-testing-library through cockpit/testing.tsx.
import { expect, test } from "bun:test";
import * as view from "../cockpit/testing.tsx";
import type { Drawn } from "../cockpit/testing.tsx";

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-10-31T12:00:00Z");
const ESC = /\x1b\[/;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const RUNNERS: Row[] = [
  { name: "remanual-ci-dev-pc-1", status: "online", busy: true },
  { name: "remanual-ci-dev-pc.2-1", status: "online", busy: false },
  { name: "remanual-ci-old-box-7", status: "offline", busy: false },
];

const RUNS: Row[] = [
  { ref: "main", branch: "main", state: "in_progress", name: "CI", createdAt: "", minutesAgo: 4, id: 9000 },
  { ref: "#445", branch: "factory-v0.2.1", state: "queued", name: "CI", createdAt: "", minutesAgo: 2, id: 9100 },
  { ref: "main", branch: "main", state: "failure", name: "CI", createdAt: "", minutesAgo: 30, id: 9001 },
  { ref: "#442", branch: "ci-runners-4", state: "success", name: "CI", createdAt: "", minutesAgo: 840, id: 9200 },
  { ref: "#435", branch: "task/410-draft-after-read", state: "failure", name: "CI", createdAt: "", minutesAgo: 900, id: 9300 },
];

const LOCAL: Row = {
  mode: "local", runsOn: "[\"self-hosted\",\"remanual-local\"]", repo: "o/remanual", label: "remanual-local",
  instances: [{ id: "1", name: "remanual-ci", state: "running", manager: "systemd", pid: 11 }],
  docker: 1,
  runs: RUNS,
  runners: RUNNERS,
  light: { label: "remanual-light", variableSet: true, runners: [{ name: "remanual-ci-dev-pc.light-1", status: "online", busy: false }],
    noneOnline: false },
  queuedLong: { count: 0, longestMinutes: 0, thresholdMinutes: 15, noRunnerOnline: false },
  errors: [],
};

function snap(ci: Row): Row {
  return { generatedAt: "2026-10-31T11:50:00Z", ci, sessions: [], needsYou: [], pulls: [], missing: [] };
}

const run = (state: string, ref: string, minutesAgo: number, extra: Row = {}): Row =>
  ({ ref, branch: ref === "main" ? "main" : `task/${ref.slice(1)}-x`, state, name: "CI", createdAt: "", minutesAgo, id: 5000 + minutesAgo, ...extra });

/** The first line under the CI view's heading that is not blank: the verdict. */
async function verdict(ci: Row, host = "dev-pc"): Promise<string> {
  const data = snap(ci);
  const v = view.drawDoc("ci", { cols: 140, rows: 80, color: false, data, load: () => Promise.resolve(data), host, now: NOW });
  await v.settle();
  const f = strip(v.frame());
  v.unmount();
  return f.split("\n").find((l) => l.trim().startsWith("CI is") || l.trim().startsWith("CI can't be judged")) ?? `no verdict in:\n${f}`;
}

// --- the verdict ------------------------------------------------------------------------------------------------------

test("verdict: no runner online says CI is stuck, with how many PRs are waiting", async () => {
  const offline = [{ name: "remanual-ci-old-box-7", status: "offline", busy: false }];
  const three = [run("queued", "#1", 5), run("in_progress", "#2", 6), run("waiting", "#3", 7), run("queued", "main", 9)];
  expect(await verdict({ ...LOCAL, runners: offline, runs: three })).toContain("CI is stuck: no runner online for remanual-local; 3 PRs are waiting");
  expect(await verdict({ ...LOCAL, runners: [], runs: [run("queued", "#1", 5)] })).toContain("; 1 PR is waiting");
  expect(await verdict({ ...LOCAL, runners: [], runs: [run("success", "#1", 5)] })).toContain("; no PR is waiting");
});

test("verdict: every online runner busy says CI is busy, with what is queued", async () => {
  const busy = [{ name: "remanual-ci-dev-pc-1", status: "online", busy: true }, { name: "remanual-ci-dev-pc.2-1", status: "online", busy: true },
    { name: "remanual-ci-old-box-7", status: "offline", busy: false }];
  expect(await verdict({ ...LOCAL, runners: busy, runs: [run("queued", "#1", 5)] }))
    .toContain("CI is busy: all 2 runners online are running jobs; 1 run queued");
  expect(await verdict({ ...LOCAL, runners: busy, runs: [run("success", "#1", 5)] }))
    .toContain("CI is busy: all 2 runners online are running jobs; nothing queued");
});

test("verdict: a runner that waits for a job says CI is fine", async () => {
  expect(await verdict({ ...LOCAL, runs: [run("success", "#1", 5)] })).toContain("CI is fine: 2 runners online, nothing queued");
  const queued = [run("queued", "#1", 5), run("pending", "#2", 6), run("requested", "main", 7)];
  expect(await verdict({ ...LOCAL, runs: queued })).toContain("CI is fine: 2 runners online, 3 runs queued");
  const one = [{ name: "remanual-ci-dev-pc-1", status: "online", busy: false }];
  expect(await verdict({ ...LOCAL, runners: one, runs: [] })).toContain("CI is fine: 1 runner online, nothing queued");
});

test("verdict: on GitHub's runners it says so, and slow when runs queue long", async () => {
  const gh = { ...LOCAL, mode: "github", runsOn: null, instances: [], runners: [], light: null };
  expect(await verdict({ ...gh, runs: [run("success", "#1", 5)] })).toContain("CI is fine: on GitHub's runners, nothing queued");
  expect(await verdict({ ...gh, runs: [run("queued", "#1", 5), run("queued", "#2", 6)] }))
    .toContain("CI is fine: on GitHub's runners, 2 runs queued");
  expect(await verdict({ ...gh, runs: [run("queued", "#1", 20), run("queued", "#2", 25)],
    queuedLong: { count: 2, longestMinutes: 25, thresholdMinutes: 15, noRunnerOnline: false } }))
    .toContain("CI is slow: 2 runs queued over 15 min on GitHub's runners");
});

test("verdict: an unreadable mode, and runners that can't be read, are said plainly", async () => {
  expect(await verdict({ ...LOCAL, mode: "unknown", runsOn: null, runs: [] })).toContain("CI is unknown: gh can't read CI_RUNS_ON");
  expect(await verdict({ ...LOCAL, runners: null, light: null, runs: [] })).toContain("CI can't be judged: the runners can't be read");
});

test("the verdict is the first line under the heading, before the cards", async () => {
  const data = snap(LOCAL);
  const v = view.drawDoc("ci", { cols: 140, rows: 80, color: false, data, load: () => Promise.resolve(data), now: NOW });
  await v.settle();
  const lines = strip(v.frame()).split("\n");
  v.unmount();
  const at = (s: string) => lines.findIndex((l) => l.includes(s));
  expect(at("CI is fine")).toBeLessThan(at("WHERE JOBS RUN"));
  expect(at("CI is fine")).toBeLessThan(at("Runners"));
});

test("the verdict is coloured when the terminal has colour, and the words are the same without it", async () => {
  const data = snap(LOCAL);
  const draw = (color: boolean) => view.drawDoc("ci", { cols: 140, rows: 80, color, data, load: () => Promise.resolve(data), now: NOW });
  const [plain, coloured] = [draw(false), draw(true)];
  await coloured.settle();
  expect(plain.frame()).toContain("CI is fine");
  expect(plain.frame()).not.toMatch(ESC);
  expect(coloured.frame()).toMatch(ESC);
  expect(strip(coloured.frame())).toBe(plain.frame());
  plain.unmount();
  coloured.unmount();
});

// --- Waiting on CI ------------------------------------------------------------------------------------------------------

async function doc(ci: Row, cols = 140): Promise<string> {
  const data = snap(ci);
  const v = view.drawDoc("ci", { cols, rows: 120, color: false, data, load: () => Promise.resolve(data), now: NOW });
  await v.settle();
  const f = v.frame();
  v.unmount();
  return f;
}

test("Waiting on CI lists each pull request with its state, how long and its branch", async () => {
  const f = await doc({ ...LOCAL, runs: [...RUNS, run("in_progress", "#450", 12, { branch: "task/450-y" })] });
  expect(f).toContain("Waiting on CI");
  expect(f).toMatch(/^\s*#445\s+queued\s+2 min\s+factory-v0\.2\.1\s*$/m);
  expect(f).toMatch(/^\s*#450\s+running\s+12 min\s+task\/450-y\s*$/m);
  // A success and a failure are not waiting on anything (the queue lists them state first, so this matches only the waiting list).
  expect(f).not.toMatch(/^\s*#(442|435)\s+\S+\s+\d+ (min|h)\s+\S/m);
});

test("Waiting on CI says so when no pull request is waiting", async () => {
  const f = await doc({ ...LOCAL, runs: [RUNS[0], RUNS[3]] });
  expect(f).toContain("Waiting on CI");
  expect(f).toContain("No pull request is waiting on CI.");
});

// --- the runners, by machine --------------------------------------------------------------------------------------------

/** The machine header each runner line sits under: the nearest earlier line that is only a machine's name. */
function machineOf(f: string, runner: string, machines: string[]): string {
  const lines = strip(f).split("\n");
  const at = lines.findIndex((l) => l.includes(runner));
  expect(at, `${runner} in\n${f}`).toBeGreaterThan(-1);
  for (let i = at - 1; i >= 0; i--) {
    const m = machines.find((name) => (lines[i] ?? "").trim() === name || (lines[i] ?? "").trim() === `${name} · this machine`);
    if (m) return m;
  }
  return "";
}

test("Runners are grouped by machine, read from the registration name, with this machine marked", async () => {
  const f = await doc(LOCAL);
  const lines = f.split("\n").map((l) => l.trim());
  expect(lines).toContain("dev-pc · this machine");
  expect(lines).toContain("old-box");
  const machines = ["dev-pc", "old-box"];
  expect(machineOf(f, "remanual-ci-dev-pc-1 ", machines)).toBe("dev-pc");
  expect(machineOf(f, "remanual-ci-dev-pc.2-1", machines)).toBe("dev-pc");
  expect(machineOf(f, "remanual-ci-dev-pc.light-1", machines)).toBe("dev-pc");
  expect(machineOf(f, "remanual-ci-old-box-7", machines)).toBe("old-box");
});

test("Runners keep their line: glyph, name, lane and what it does", async () => {
  const f = await doc(LOCAL);
  const line = (n: string) => f.split("\n").find((l) => l.includes(n)) ?? "";
  expect(line("remanual-ci-dev-pc-1 ")).toMatch(/●.*remanual-ci-dev-pc-1.*heavy.*running a job/);
  expect(line("remanual-ci-dev-pc.2-1")).toMatch(/○.*heavy.*waiting for a job/);
  expect(line("remanual-ci-old-box-7")).toMatch(/✕.*heavy.*offline/);
  expect(line("remanual-ci-dev-pc.light-1")).toMatch(/○.*light.*waiting for a job/);
});

test("another host name does not mark dev-pc as this machine", async () => {
  const data = snap(LOCAL);
  const v = view.drawDoc("ci", { cols: 140, rows: 120, color: false, data, load: () => Promise.resolve(data), host: "old-box", now: NOW });
  await v.settle();
  const lines = v.frame().split("\n").map((l) => l.trim());
  v.unmount();
  expect(lines).toContain("old-box · this machine");
  expect(lines).toContain("dev-pc");
});

// --- the keys ------------------------------------------------------------------------------------------------------------

interface Rig {
  v: Drawn;
  ran: string[][][];
  loads: { n: number };
  frame: () => string;
}

interface RigOpts {
  ci?: Row;
  heavy?: view.CiOpts["heavy"];
  light?: view.CiOpts["light"];
  cols?: number;
  output?: string;
}

function rig(o: RigOpts = {}): Rig {
  const ran: string[][][] = [];
  const loads = { n: 0 };
  const data = snap(o.ci ?? LOCAL);
  const v = view.drawCi({
    cols: o.cols ?? 200, rows: 120, color: false, data, now: NOW,
    load: () => {
      loads.n++;
      return Promise.resolve(data);
    },
    heavy: o.heavy, light: o.light,
    run: (steps) => {
      ran.push(steps);
      return Promise.resolve(o.output ?? "RAN-OUTPUT-TEXT");
    },
  });
  return { v, ran, loads, frame: () => strip(v.frame()) };
}

/** Presses a key that asks, and checks the question shows the commands and the y/N. */
async function asks(r: Rig, key: string, ...commands: string[]): Promise<void> {
  await r.v.press(key);
  const f = r.frame();
  for (const c of commands) expect(f, c).toContain(c);
  expect(f).toContain("[y/N]");
  expect(r.ran).toEqual([]);
}

const ACTIONS: Array<[string, string, string[][], string[]]> = [
  ["i", "install", [["factory", "ci", "install"]], ["factory ci install"]],
  ["l", "use local", [["factory", "ci", "use", "local"]], ["factory ci use local"]],
  ["g", "use github", [["factory", "ci", "use", "github"]], ["factory ci use github"]],
  ["+", "one more heavy runner", [["factory", "ci", "runners", "3"]], ["factory ci runners 3"]],
  ["-", "one fewer heavy runner", [["factory", "ci", "runners", "1"]], ["factory ci runners 1"]],
  ["c", "clean", [["factory", "ci", "clean", "--apply"]], ["factory ci clean --apply"]],
  ["L", "turn the light lane off", [["factory", "settings", "set", "--stage", "ci.light", "false"], ["factory", "settings", "pr"]],
    ["factory settings set --stage ci.light false", "factory settings pr"]],
];

for (const [key, what, steps, commands] of ACTIONS) {
  test(`${what} (${key}): asks first, y runs the steps once and shows the output, then any key reads again`, async () => {
    const r = rig();
    await r.v.settle();
    expect(r.loads.n).toBe(0);
    await asks(r, key, ...commands);
    await r.v.press("y");
    await r.v.settle();
    expect(r.ran).toEqual([steps]);
    expect(r.frame()).toContain("RAN-OUTPUT-TEXT");
    expect(r.frame()).toContain("Press a key to go on.");
    expect(r.loads.n).toBe(0);
    await r.v.press("x");
    await r.v.settle();
    expect(r.loads.n).toBe(1);
    expect(r.ran.length).toBe(1);
    expect(r.frame()).toContain("Queue and recent runs");
    expect(r.frame()).not.toContain("Press a key to go on.");
    expect(r.frame()).not.toContain("[y/N]");
    r.v.unmount();
  });

  test(`${what} (${key}): n runs nothing and says nothing changed, then any key shows the document`, async () => {
    const r = rig();
    await asks(r, key, ...commands);
    await r.v.press("n");
    await r.v.settle();
    expect(r.ran).toEqual([]);
    expect(r.frame()).toContain("Not run: nothing changed.");
    expect(r.frame()).not.toContain("[y/N]");
    await r.v.press("x");
    expect(r.ran).toEqual([]);
    expect(r.loads.n).toBe(0);
    expect(r.frame()).toContain("Queue and recent runs");
    expect(r.frame()).not.toContain("Not run:");
    r.v.unmount();
  });
}

test("a key other than y (Escape, a letter) at the question runs nothing", async () => {
  for (const other of ["x", "\x1b"]) {
    const r = rig();
    await asks(r, "i", "factory ci install");
    await r.v.press(other);
    await r.v.settle();
    expect(r.ran, JSON.stringify(other)).toEqual([]);
    r.v.unmount();
  }
});

test("a question says what the action does", async () => {
  const r = rig();
  await r.v.press("c");
  expect(r.frame()).toMatch(/Run `factory ci clean --apply`\? \S/);
  r.v.unmount();
});

test("L asks with both steps, says it changes .claude/factory.json through a pull request", async () => {
  const r = rig();
  await r.v.press("L");
  const f = r.frame();
  expect(f).toMatch(/Run `factory settings set --stage ci\.light false` then `factory settings pr`\?/);
  expect(f).toContain("pull request");
  expect(f).toContain(".claude/factory.json");
  r.v.unmount();
});

test("L with the light lane off turns it on, and with no setting read says why nothing runs", async () => {
  const off = rig({ light: false });
  await off.v.press("L");
  await off.v.press("y");
  await off.v.settle();
  expect(off.ran).toEqual([[["factory", "settings", "set", "--stage", "ci.light", "true"], ["factory", "settings", "pr"]]]);
  off.v.unmount();
  const none = rig({ light: null });
  await none.v.press("L");
  expect(none.frame()).not.toContain("[y/N]");
  expect(none.frame()).toMatch(/light/i);
  await none.v.press("y");
  expect(none.ran).toEqual([]);
  none.v.unmount();
});

test("+ and - count from the heavy runner setting", async () => {
  const r = rig({ heavy: { raw: "4", source: "this machine" } });
  await r.v.press("+");
  await r.v.press("y");
  await r.v.settle();
  expect(r.ran).toEqual([[["factory", "ci", "runners", "5"]]]);
  await r.v.press("x");
  await r.v.press("-");
  await r.v.press("y");
  await r.v.settle();
  expect(r.ran).toEqual([[["factory", "ci", "runners", "5"]], [["factory", "ci", "runners", "3"]]]);
  r.v.unmount();
});

test("+ at 16 runners and - at 1 show a note and ask nothing", async () => {
  const top = rig({ heavy: { raw: "16", source: "this machine" } });
  await top.v.press("+");
  expect(top.frame()).toContain("16");
  expect(top.frame()).not.toContain("[y/N]");
  await top.v.press("y");
  expect(top.ran).toEqual([]);
  top.v.unmount();
  const bottom = rig({ heavy: { raw: "1", source: "this machine" } });
  await bottom.v.press("-");
  expect(bottom.frame()).toContain("1");
  expect(bottom.frame()).not.toContain("[y/N]");
  await bottom.v.press("y");
  expect(bottom.ran).toEqual([]);
  bottom.v.unmount();
});

test("+ and - with no readable heavy runner count show a note and run nothing", async () => {
  for (const heavy of [null, { raw: "many", source: "this machine" }, { raw: "2.5", source: "this machine" }]) {
    for (const key of ["+", "-"]) {
      const r = rig({ heavy });
      await r.v.press(key);
      expect(r.frame(), `${JSON.stringify(heavy)} ${key}`).not.toContain("[y/N]");
      await r.v.press("y");
      expect(r.ran).toEqual([]);
      r.v.unmount();
    }
  }
});

test("Tab selects the next run, starting at the first: active runs oldest first, then finished ones newest first", async () => {
  const r = rig();
  await r.v.settle();
  const sel = () => r.frame().split("\n").filter((l) => l.trimStart().startsWith("›"));
  expect(sel().length).toBe(1);
  expect(sel()[0]).toMatch(/running.*main/);
  await r.v.press("\t");
  expect(sel().length).toBe(1);
  expect(sel()[0]).toContain("#445");
  await r.v.press("\t");
  expect(sel()[0]).toMatch(/failure.*main.*30 min/);
  await r.v.press("\t");
  expect(sel()[0]).toContain("#442");
  expect(r.ran).toEqual([]);
  r.v.unmount();
});

test("Enter opens the log of the selected run with no question: a pull request by its number", async () => {
  const r = rig();
  await r.v.press("\t");
  await r.v.press("\r");
  await r.v.settle();
  expect(r.frame()).not.toContain("[y/N]");
  expect(r.ran).toEqual([[["factory", "ci", "log", "445"]]]);
  expect(r.frame()).toContain("RAN-OUTPUT-TEXT");
  expect(r.frame()).toContain("Press a key to go on.");
  r.v.unmount();
});

test("Enter on a run that is not a pull request opens its log by the run id", async () => {
  const r = rig();
  await r.v.press("\r");
  await r.v.settle();
  expect(r.ran).toEqual([[["factory", "ci", "log", "9000"]]]);
  r.v.unmount();
});

test("Enter on a run with no id and no pull request number shows a note and runs nothing", async () => {
  const runs = [{ ref: "main", branch: "main", state: "success", name: "CI", createdAt: "", minutesAgo: 5 }];
  const r = rig({ ci: { ...LOCAL, runs } });
  await r.v.press("\r");
  await r.v.settle();
  expect(r.ran).toEqual([]);
  expect(r.frame()).not.toContain("[y/N]");
  expect(r.frame()).not.toContain("Press a key to go on.");
  expect(r.frame()).toMatch(/id/i);
  r.v.unmount();
});

test("R reruns the failed jobs of the selected failed run, after asking", async () => {
  const r = rig();
  await r.v.press("\t");
  await r.v.press("\t");
  await asks(r, "R", "gh run rerun 9001 --failed --repo o/remanual");
  await r.v.press("y");
  await r.v.settle();
  expect(r.ran).toEqual([[["gh", "run", "rerun", "9001", "--failed", "--repo", "o/remanual"]]]);
  expect(r.frame()).toContain("RAN-OUTPUT-TEXT");
  r.v.unmount();
});

test("R on a run that did not fail says only a failed run can be rerun, and asks nothing", async () => {
  for (const tabs of [0, 1, 3]) {
    const r = rig();
    for (let i = 0; i < tabs; i++) await r.v.press("\t");
    await r.v.press("R");
    expect(r.frame(), `after ${tabs} tabs`).toMatch(/only a failed run can be rerun/i);
    expect(r.frame()).not.toContain("[y/N]");
    await r.v.press("y");
    expect(r.ran).toEqual([]);
    r.v.unmount();
  }
});

test("R on a failed run with no id says nothing can be rerun and asks nothing", async () => {
  const runs = [{ ref: "#435", branch: "task/410-x", state: "failure", name: "CI", createdAt: "", minutesAgo: 9 }];
  const r = rig({ ci: { ...LOCAL, runs } });
  await r.v.press("R");
  expect(r.frame()).not.toContain("[y/N]");
  await r.v.press("y");
  expect(r.ran).toEqual([]);
  r.v.unmount();
});

test("R reruns a timed out, cancelled or startup failed run too", async () => {
  for (const state of ["timed_out", "cancelled", "startup_failure"]) {
    const r = rig({ ci: { ...LOCAL, runs: [run(state, "#7", 3, { id: 4242 })] } });
    await asks(r, "R", "gh run rerun 4242");
    await r.v.press("y");
    await r.v.settle();
    expect(r.ran, state).toEqual([[["gh", "run", "rerun", "4242", "--failed", "--repo", "o/remanual"]]]);
    r.v.unmount();
  }
});

test("the keys line names the CI view's keys", async () => {
  const r = rig({ cols: 140 });
  await r.v.settle();
  const f = r.frame();
  expect(f).toContain("i install");
  expect(f).toContain("c clean");
  expect(f).toContain("Enter log");
  expect(f.split("\n").at(-1)).toContain("q close");
  r.v.unmount();
});

test("letters typed into the filter go to the filter, not the actions", async () => {
  const r = rig();
  await r.v.press("/");
  await r.v.press("i");
  await r.v.press("c");
  await r.v.press("L");
  expect(r.ran).toEqual([]);
  expect(r.frame()).not.toContain("[y/N]");
  r.v.unmount();
});

test("q closes the view and later keys do nothing; r reads again and asks nothing", async () => {
  const r = rig();
  await r.v.press("r");
  await r.v.settle();
  expect(r.loads.n).toBe(1);
  expect(r.ran).toEqual([]);
  expect(r.frame()).not.toContain("[y/N]");
  await r.v.press("q");
  const after = r.frame();
  await r.v.press("i");
  expect(r.frame()).toBe(after);
  expect(r.ran).toEqual([]);
  r.v.unmount();
});

test("drawDoc ci stays read-only: i asks nothing", async () => {
  const data = snap(LOCAL);
  const v = view.drawDoc("ci", { cols: 200, rows: 120, color: false, data, load: () => Promise.resolve(data), now: NOW });
  await v.press("i");
  expect(v.frame()).not.toContain("[y/N]");
  expect(v.frame().split("\n").at(-1)).toBe("j k scroll · r read again · q close");
  v.unmount();
});
