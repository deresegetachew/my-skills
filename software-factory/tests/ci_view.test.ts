// What the CI view judges and what its actions run (#396), tested on factory_ci_view.ts itself: the web UI's CI channel
// (#424) serves it. These were tested through the cockpit's CI view until it was retired (#425); the same cases, the
// same data.
import { expect, test } from "bun:test";
import { ciActionOf, ciVerdict, type CiSettingsSeen, machineOf, orderedRuns, waitingPulls } from "../hooks/factory_ci_view.ts";

type Row = Record<string, unknown>;

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
  runs: RUNS, runners: RUNNERS, queuedLong: { count: 0, longestMinutes: 0, thresholdMinutes: 15, noRunnerOnline: false }, errors: [],
};

const SEEN: CiSettingsSeen = { heavy: { raw: "2", source: "this machine" }, light: true };

const run = (state: string, ref: string, minutesAgo: number, extra: Row = {}): Row =>
  ({ ref, branch: ref === "main" ? "main" : `task/${ref.slice(1)}-x`, state, name: "CI", createdAt: "", minutesAgo, id: 5000 + minutesAgo, ...extra });

const verdict = (ci: Row): string => ciVerdict(ci)[0];

// --- the verdict ------------------------------------------------------------------------------------------------------

test("verdict: no runner online says CI is stuck, red, with how many PRs are waiting", () => {
  const offline = [{ name: "remanual-ci-old-box-7", status: "offline", busy: false }];
  const three = [run("queued", "#1", 5), run("in_progress", "#2", 6), run("waiting", "#3", 7), run("queued", "main", 9)];
  expect(ciVerdict({ ...LOCAL, runners: offline, runs: three })).toEqual(["CI is stuck: no runner online for remanual-local; 3 PRs are waiting", "red"]);
  expect(verdict({ ...LOCAL, runners: [], runs: [run("queued", "#1", 5)] })).toEndWith("; 1 PR is waiting");
  expect(verdict({ ...LOCAL, runners: [], runs: [run("success", "#1", 5)] })).toEndWith("; no PR is waiting");
});

test("verdict: every online runner busy says CI is busy, amber, with what is queued", () => {
  const busy = [{ name: "remanual-ci-dev-pc-1", status: "online", busy: true }, { name: "remanual-ci-dev-pc.2-1", status: "online", busy: true },
    { name: "remanual-ci-old-box-7", status: "offline", busy: false }];
  expect(ciVerdict({ ...LOCAL, runners: busy, runs: [run("queued", "#1", 5)] }))
    .toEqual(["CI is busy: all 2 runners online are running jobs; 1 run queued", "amber"]);
  expect(verdict({ ...LOCAL, runners: busy, runs: [run("success", "#1", 5)] })).toBe("CI is busy: all 2 runners online are running jobs; nothing queued");
  expect(verdict({ ...LOCAL, runners: [busy[0] as Row], runs: [] })).toBe("CI is busy: the one runner online is running a job; nothing queued");
});

test("verdict: a runner that waits for a job says CI is fine, green", () => {
  expect(ciVerdict({ ...LOCAL, runs: [run("success", "#1", 5)] })).toEqual(["CI is fine: 2 runners online, nothing queued", "green"]);
  const queued = [run("queued", "#1", 5), run("pending", "#2", 6), run("requested", "main", 7)];
  expect(verdict({ ...LOCAL, runs: queued })).toBe("CI is fine: 2 runners online, 3 runs queued");
  const one = [{ name: "remanual-ci-dev-pc-1", status: "online", busy: false }];
  expect(verdict({ ...LOCAL, runners: one, runs: [] })).toBe("CI is fine: 1 runner online, nothing queued");
});

test("verdict: on GitHub's runners it says so, and slow (amber) when runs queue long", () => {
  const gh = { ...LOCAL, mode: "github", runsOn: null, runners: [] };
  expect(ciVerdict({ ...gh, runs: [run("success", "#1", 5)] })).toEqual(["CI is fine: on GitHub's runners, nothing queued", "green"]);
  expect(verdict({ ...gh, runs: [run("queued", "#1", 5), run("queued", "#2", 6)] })).toBe("CI is fine: on GitHub's runners, 2 runs queued");
  expect(ciVerdict({ ...gh, runs: [run("queued", "#1", 20), run("queued", "#2", 25)],
    queuedLong: { count: 2, longestMinutes: 25, thresholdMinutes: 15, noRunnerOnline: false } }))
    .toEqual(["CI is slow: 2 runs queued over 15 min on GitHub's runners", "amber"]);
});

test("verdict: an unreadable mode, and runners that can't be read, are said plainly", () => {
  expect(ciVerdict({ ...LOCAL, mode: "unknown", runsOn: null, runs: [] })).toEqual(["CI is unknown: gh can't read CI_RUNS_ON", "amber"]);
  expect(ciVerdict({ ...LOCAL, runners: null, runs: [] })).toEqual(["CI can't be judged: the runners can't be read", "amber"]);
});

// --- the runs and the pull requests waiting on CI ------------------------------------------------------------------------

test("runs still going come first, oldest first, then the finished ones, newest first", () => {
  expect(orderedRuns(LOCAL).map((r) => r.id)).toEqual([9000, 9100, 9001, 9200, 9300]);
});

test("waiting on CI lists each pull request with a queued or running run once, oldest first", () => {
  const runs = [...RUNS, run("in_progress", "#450", 12), run("queued", "#450", 1)];
  expect(waitingPulls({ ...LOCAL, runs }).map((r) => r.ref)).toEqual(["#450", "#445"]);
  expect(waitingPulls({ ...LOCAL, runs: [RUNS[0] as Row, RUNS[3] as Row] })).toEqual([]);
});

// --- the runners, by machine --------------------------------------------------------------------------------------------

test("a runner's machine is read from its registration name", () => {
  expect(machineOf("remanual-ci-dev-pc-1", "o/remanual")).toBe("dev-pc");
  expect(machineOf("remanual-ci-dev-pc.2-1", "o/remanual")).toBe("dev-pc");
  expect(machineOf("remanual-ci-dev-pc.light-1", "o/remanual")).toBe("dev-pc");
  expect(machineOf("remanual-ci-old-box-7", "o/remanual")).toBe("old-box");
  expect(machineOf("other-ci-old-box-7", "")).toBe("old-box");
  expect(machineOf("no-pattern-here", "o/remanual")).toBe("unknown machine");
});

// --- the actions --------------------------------------------------------------------------------------------------------

test("each action asks first and runs the factory command the command line runs", () => {
  const steps = (name: Parameters<typeof ciActionOf>[0]) => {
    const a = ciActionOf(name, LOCAL, SEEN);
    expect(a.kind, name).toBe("ask");
    return a.kind === "ask" ? a.steps : [];
  };
  expect(steps("install")).toEqual([["factory", "ci", "install"]]);
  expect(steps("use-local")).toEqual([["factory", "ci", "use", "local"]]);
  expect(steps("use-github")).toEqual([["factory", "ci", "use", "github"]]);
  expect(steps("runners-up")).toEqual([["factory", "ci", "runners", "3"]]);
  expect(steps("runners-down")).toEqual([["factory", "ci", "runners", "1"]]);
  expect(steps("clean")).toEqual([["factory", "ci", "clean", "--apply"]]);
  expect(steps("light-lane")).toEqual([["factory", "settings", "set", "--stage", "ci.light", "false"], ["factory", "settings", "pr"]]);
});

test("a question says what the action does; the light lane's says it changes .claude/factory.json through a pull request", () => {
  const clean = ciActionOf("clean", LOCAL, SEEN);
  expect(clean.kind === "ask" && clean.does).toMatch(/\S/);
  const light = ciActionOf("light-lane", LOCAL, SEEN);
  expect(light.kind === "ask" && light.does).toContain("pull request");
  expect(light.kind === "ask" && light.does).toContain(".claude/factory.json");
});

test("the light lane off turns it on, and with no setting read it is a note that runs nothing", () => {
  expect(ciActionOf("light-lane", LOCAL, { ...SEEN, light: false }))
    .toMatchObject({ kind: "ask", steps: [["factory", "settings", "set", "--stage", "ci.light", "true"], ["factory", "settings", "pr"]] });
  for (const light of [null, undefined]) {
    const a = ciActionOf("light-lane", LOCAL, { ...SEEN, light });
    expect(a.kind).toBe("note");
    expect(a.kind === "note" && a.text).toMatch(/light/i);
  }
});

test("one more and one fewer runner count from the heavy runner setting", () => {
  const seen = { heavy: { raw: "4", source: "this machine" } };
  expect(ciActionOf("runners-up", LOCAL, seen)).toMatchObject({ steps: [["factory", "ci", "runners", "5"]] });
  expect(ciActionOf("runners-down", LOCAL, seen)).toMatchObject({ steps: [["factory", "ci", "runners", "3"]] });
});

test("one more at 16 runners and one fewer at 1 are notes that run nothing", () => {
  const top = ciActionOf("runners-up", LOCAL, { heavy: { raw: "16", source: "this machine" } });
  expect(top.kind).toBe("note");
  expect(top.kind === "note" && top.text).toContain("16");
  const bottom = ciActionOf("runners-down", LOCAL, { heavy: { raw: "1", source: "this machine" } });
  expect(bottom.kind).toBe("note");
  expect(bottom.kind === "note" && bottom.text).toContain("1 heavy runner is the fewest");
});

test("with no readable heavy runner count, one more and one fewer are notes that run nothing", () => {
  for (const heavy of [null, { raw: "many", source: "this machine" }, { raw: "2.5", source: "this machine" }]) {
    for (const name of ["runners-up", "runners-down"] as const) {
      expect(ciActionOf(name, LOCAL, { heavy }).kind, `${JSON.stringify(heavy)} ${name}`).toBe("note");
    }
  }
});

test("a run's log opens with no question: a pull request by its number, another run by its id, none without either", () => {
  expect(ciActionOf("log", LOCAL, SEEN, RUNS[1])).toEqual({ kind: "open", steps: [["factory", "ci", "log", "445"]] });
  expect(ciActionOf("log", LOCAL, SEEN, RUNS[0])).toEqual({ kind: "open", steps: [["factory", "ci", "log", "9000"]] });
  const noId = ciActionOf("log", LOCAL, SEEN, { ref: "main", branch: "main", state: "success", minutesAgo: 5 });
  expect(noId.kind).toBe("note");
  expect(noId.kind === "note" && noId.text).toMatch(/id/i);
  expect(ciActionOf("log", LOCAL, SEEN).kind).toBe("note");
});

test("rerun reruns the failed jobs of a failed run, after asking", () => {
  expect(ciActionOf("rerun", LOCAL, SEEN, RUNS[2]))
    .toMatchObject({ kind: "ask", steps: [["gh", "run", "rerun", "9001", "--failed", "--repo", "o/remanual"]] });
});

test("rerun reruns a timed out, cancelled or startup failed run too", () => {
  for (const state of ["timed_out", "cancelled", "startup_failure"]) {
    expect(ciActionOf("rerun", LOCAL, SEEN, run(state, "#7", 3, { id: 4242 })), state)
      .toMatchObject({ kind: "ask", steps: [["gh", "run", "rerun", "4242", "--failed", "--repo", "o/remanual"]] });
  }
});

test("rerun of a run that did not fail, or of none, says only a failed run can be rerun", () => {
  for (const r of [RUNS[0], RUNS[1], RUNS[3], undefined]) {
    const a = ciActionOf("rerun", LOCAL, SEEN, r);
    expect(a.kind).toBe("note");
    expect(a.kind === "note" && a.text).toMatch(/only a failed run can be rerun/i);
  }
});

test("rerun of a failed run with no id, or with a repository that isn't owner/name, is a note that runs nothing", () => {
  const noId = { ref: "#435", branch: "task/410-x", state: "failure", name: "CI", createdAt: "", minutesAgo: 9 };
  expect(ciActionOf("rerun", LOCAL, SEEN, noId).kind).toBe("note");
  expect(ciActionOf("rerun", { ...LOCAL, repo: "o/r; rm -rf /" }, SEEN, RUNS[2]).kind).toBe("note");
});
