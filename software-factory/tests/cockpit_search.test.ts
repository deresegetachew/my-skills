// The cockpit's search across the views (#392): `/` in the list opens a popup that finds a row in any view and opens that
// view on it; `/` inside a view filters its rows. The search screen and the filters are drawn with ink-testing-library from
// fixed data; then the same search runs through `factory cockpit --search`, which reads the cache, local settings and logs
// and makes no GitHub call.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drawDoc, drawNeeds, drawPrs, drawSearch, drawTasks, type NeedsProps, type PrsProps, sidebarOf, type TasksProps } from "../cockpit/testing.tsx";
import { CI, copyHookFolders, envWith, gitRepo, HOOKS, SF, sh, tmp, WIKI, write } from "./support.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const ESC = /\x1b\[/;
const ESCAPE_KEY = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const BACKSPACE = "\x7f";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const TITLES = ["Needs you", "Pull requests", "Tasks & PRD", "CI", "Agents & machines", "Settings", "Health & releases", "Usage & lessons"];

// --- fixed data --------------------------------------------------------------------------------------------------------

const SNAPSHOT: Row = {
  generatedAt: "2026-10-31T11:50:00Z",
  needsYou: [
    { kind: "owner-ask", id: "ship-it", issue: 77, url: "https://github.com/o/r/issues/77#c1", ageMinutes: 8, state: "owner" },
    { kind: "owner-merges", number: 9, title: "Update the factory", url: "https://github.com/o/r/pull/9" },
  ],
  pulls: [
    { number: 12, title: "Task 7: the importer", branch: "task/7-x", agent: "menelik", url: "https://github.com/o/r/pull/12" },
    { number: 13, title: "Task 8: the exporter", branch: "task/8-y", agent: "taytu", url: "https://github.com/o/r/pull/13" },
  ],
  tasks: { source: "issues", prd: "docs/PRD.md", tasks: [
    { id: "367", title: "Cockpit on Ink: the views", state: "in-progress", holders: ["menelik"], group: "cockpit" },
    { id: "362", title: "Real tmux tests", state: "new", holders: [], group: "" },
  ] },
  ci: {
    mode: "local", repo: "o/work", label: "work-local", errors: [],
    runs: [{ ref: "main", branch: "main", state: "in_progress", name: "Nightly build", minutesAgo: 4 }],
    runners: [{ name: "work-ci-dev-pc-1", status: "online", busy: true }],
  },
  sessions: [
    { name: "fasil", kind: "dev manager", role: "dev manager", state: "working", task: "380", source: "local", machineName: "dev-pc", session: "work-fasil" },
    { name: "menelik", kind: "coding agent", role: "coding agent", state: "idle", task: null, source: "local", machineName: "dev-pc", session: "work-menelik" },
  ],
  doctor: { ok: 30, fixes: 1, notes: 2, summary: "1 to fix.", fix: ["gh login has admin rights: use a second account with Write"] },
  version: { installed: "0.2.4", source: "release" },
  missing: [],
};

const SETTINGS: Row = {
  repo: "o/work", host: "dev-pc",
  sections: [{ name: "Tasks", rows: [
    { key: "tasks.source", owner: true, value: "issues", from: "main", pending: false, help: "where the tasks come from" },
    { key: "budget.builder", owner: false, value: "300000", from: "default", pending: false, help: "a builder's token budget" },
  ] }],
  machine: [{ key: "ci.runners", owner: false, value: "2", from: "this machine", pending: false, help: "heavy runners here" }],
  staged: { problem: "", changes: [] },
};

const USAGE: Row = {
  tasks: [{ task: "367", agent: "haile", budget: 1_000_000, used: 850_000, top: "reviewer" }],
  lessons: ["Run the tests before the PR."],
};

const DATA: Row = { snapshot: SNAPSHOT, settings: SETTINGS, usage: USAGE };

interface Searched {
  v: ReturnType<typeof drawSearch>;
  done: Array<string[] | null>;
}

function search(o: { prefill?: string; cols?: number; rows?: number; color?: boolean; data?: Row } = {}): Searched {
  const done: Array<string[] | null> = [];
  const v = drawSearch({ data: o.data ?? DATA, cols: o.cols ?? 120, rows: o.rows ?? 40, color: o.color ?? false, prefill: o.prefill,
    done: (args) => done.push(args) });
  return { v, done };
}

/** Types `typed`, presses Enter and gives what the search handed back. */
async function opens(typed: string, cols = 140): Promise<{ args: string[] | null; frame: string }> {
  const s = search({ prefill: typed, cols });
  await s.v.settle();
  const frame = s.v.frame();
  await s.v.press(ENTER);
  await Bun.sleep(80);
  s.v.unmount();
  expect(s.done.length, `done calls for "${typed}"`).toBe(1);
  return { args: s.done[0] ?? null, frame };
}

function lineWith(frame: string, text: string): string {
  return frame.split("\n").find((l) => l.includes(text)) ?? "";
}

function fits(frame: string, cols: number, rows: number): void {
  const all = strip(frame).split("\n");
  expect(all.length, frame).toBeLessThanOrEqual(rows);
  for (const l of all) expect([...l].length, l).toBeLessThanOrEqual(cols);
}

// --- the search screen -------------------------------------------------------------------------------------------------

test("search: the first line is the typed box, the last the keys, every view's group is listed when nothing is typed", async () => {
  const s = search();
  await s.v.settle();
  const f = s.v.frame();
  s.v.unmount();
  const lines = f.split("\n");
  expect(lines[0]).toMatch(/^\/ ?$/);
  expect(lines.at(-1)).toContain("Enter opens");
  expect(lines.at(-1)).toContain("Esc closes");
  for (const t of TITLES) expect(f, t).toContain(t);
  const order = TITLES.map((t) => f.indexOf(t));
  expect(order).toEqual([...order].sort((a, b) => a - b)); // the groups follow the sidebar's order
  for (const row of ["ship-it", "Update the factory", "Task 7: the importer", "Task 8: the exporter", "Cockpit on Ink", "Real tmux tests",
    "Nightly build", "work-ci-dev-pc-1", "fasil", "menelik", "tasks.source", "budget.builder", "gh login has admin rights", "Run the tests before the PR."]) {
    expect(f, row).toContain(row);
  }
  expect(lines.filter((l) => l.startsWith("›")).length).toBe(1);
  expect(f).not.toMatch(ESC);
});

test("search: typing narrows the rows, in any case, and every typed word must match", async () => {
  const s = search();
  await s.v.press("IMPORTER");
  let f = s.v.frame();
  expect(f.split("\n")[0]).toBe("/ IMPORTER");
  expect(f).toContain("Task 7: the importer");
  expect(f).not.toContain("Task 8: the exporter");
  expect(f).not.toContain("Real tmux tests");
  await s.v.press(" taytu");
  f = s.v.frame();
  expect(f).toContain(`No match for "IMPORTER taytu".`); // the importer is menelik's
  await s.v.press(BACKSPACE.repeat(6)); // takes " taytu" back out
  f = s.v.frame();
  expect(f.split("\n")[0]).toBe("/ IMPORTER");
  expect(f).toContain("Task 7: the importer");
  await s.v.press(" menelik");
  expect(s.v.frame()).toContain("Task 7: the importer");
  s.v.unmount();
});

test("search: Backspace removes a character and the rows come back", async () => {
  const s = search({ prefill: "importerx" });
  await s.v.settle();
  expect(s.v.frame()).toContain(`No match for "importerx".`);
  expect(s.v.frame()).not.toContain("Task 7: the importer");
  await s.v.press(BACKSPACE);
  expect(s.v.frame().split("\n")[0]).toBe("/ importer");
  expect(s.v.frame()).toContain("Task 7: the importer");
  s.v.unmount();
});

test("search: a broad word finds rows from at least three views, each under its view's heading and naming its view", async () => {
  const s = search({ prefill: "menelik", cols: 120 });
  await s.v.settle();
  const f = s.v.frame();
  s.v.unmount();
  const headings = TITLES.filter((t) => f.split("\n").some((l) => l.trim().startsWith(t)));
  expect(headings.length, f).toBeGreaterThanOrEqual(3);
  for (const t of ["Pull requests", "Tasks & PRD", "Agents & machines"]) expect(headings, t).toContain(t);
  expect(lineWith(f, "Task 7: the importer")).toContain("Pull requests"); // the row names its view on the right
  expect(lineWith(f, "Cockpit on Ink")).toContain("Tasks & PRD");
});

test("search: nothing matching says so with the typed words", async () => {
  const s = search({ prefill: "zzzzqq" });
  await s.v.settle();
  const f = s.v.frame();
  s.v.unmount();
  expect(f).toContain(`No match for "zzzzqq".`);
  expect(f.split("\n")[0]).toBe("/ zzzzqq");
  expect(f.split("\n").at(-1)).toContain("Esc closes");
});

test("search: the arrows move the selection across every group and Enter opens the selected row", async () => {
  const s = search();
  await s.v.settle();
  const first = s.v.frame().split("\n").findIndex((l) => l.startsWith("›"));
  await s.v.press(DOWN);
  const second = s.v.frame().split("\n").findIndex((l) => l.startsWith("›"));
  expect(second).toBeGreaterThan(first);
  await s.v.press(UP);
  expect(s.v.frame().split("\n").findIndex((l) => l.startsWith("›"))).toBe(first);
  await s.v.press(UP); // already at the top: stays
  expect(s.v.frame().split("\n").findIndex((l) => l.startsWith("›"))).toBe(first);
  await s.v.press(ENTER);
  await Bun.sleep(80);
  expect(s.done.length).toBe(1);
  expect(s.done[0]?.[0]).toBe("--needs"); // the first row is in the first group
  s.v.unmount();
  const last = search();
  await last.v.press(DOWN.repeat(200));
  await last.v.press(ENTER);
  await Bun.sleep(80);
  expect(last.done[0]?.[0]).toBe("--usage"); // across all the groups, down to the last row
  last.v.unmount();
});

test("search: Esc closes with null and nothing opens", async () => {
  const s = search({ prefill: "importer" });
  await s.v.settle();
  await s.v.press(ESCAPE_KEY);
  await Bun.sleep(80); // Ink waits a moment to tell Esc from an arrow key
  expect(s.done).toEqual([null]);
  s.v.unmount();
});

test("search: Enter with no match does not open anything", async () => {
  const s = search({ prefill: "zzzzqq" });
  await s.v.settle();
  await s.v.press(ENTER);
  await Bun.sleep(80);
  expect(s.done.filter((d) => d !== null)).toEqual([]);
  s.v.unmount();
});

// --- Enter opens the view at the row -----------------------------------------------------------------------------------

test("search: Enter on an owner ask opens Needs you at that ask", async () => {
  expect((await opens("ship-it")).args).toEqual(["--needs", "--find", "ship-it"]);
});

test("search: Enter on a pull request only a person merges opens Needs you at #<number>", async () => {
  expect((await opens("Update the factory")).args).toEqual(["--needs", "--find", "#9"]);
});

test("search: Enter on a pull request opens Pull requests at its number", async () => {
  expect((await opens("importer")).args).toEqual(["--prs", "12"]);
});

test("search: Enter on a task opens Tasks & PRD at its id", async () => {
  expect((await opens("Cockpit on Ink")).args).toEqual(["--tasks", "--find", "367"]);
});

test("search: Enter on a CI run or a runner opens CI at text from that row", async () => {
  for (const typed of ["Nightly build", "work-ci-dev-pc-1"]) {
    const { args, frame } = await opens(typed);
    expect(args?.slice(0, 2), typed).toEqual(["--ci", "--find"]);
    expect(args?.length, typed).toBe(3);
    expect(typeof args?.[2]).toBe("string");
    expect((args?.[2] ?? "").length).toBeGreaterThan(0);
    // the row Enter opened (marked ›), not the box, which holds the typed words too
    const row = frame.split("\n").find((l) => l.startsWith("›")) ?? "";
    expect(row.toLowerCase(), typed).toContain((args?.[2] ?? "").toLowerCase());
  }
});

const TWO_RUNS: Row = { ...DATA, snapshot: { ...SNAPSHOT, ci: { ...SNAPSHOT.ci, runs: [
  { ref: "main", branch: "main", state: "in_progress", name: "Nightly build", minutesAgo: 4 },
  { ref: "#13", branch: "task/8-y", state: "success", name: "Nightly build", minutesAgo: 9 },
] } } };

test("search: Enter on one of two CI runs that share a name opens CI at that run's name and branch", async () => {
  for (const [moves, want] of [[0, "Nightly build on main"], [1, "Nightly build on task/8-y"]] as const) {
    const s = search({ prefill: "Nightly", data: TWO_RUNS });
    await s.v.settle();
    for (let i = 0; i < moves; i++) await s.v.press(DOWN);
    await s.v.press(ENTER);
    await Bun.sleep(80);
    s.v.unmount();
    expect(s.done, want).toEqual([["--ci", "--find", want]]);
  }
});

function manyRuns(n: number, branch: (i: number) => string): Row {
  const runs = Array.from({ length: n }, (_, i) => ({ ref: `#${i}`, branch: branch(i), state: "success", name: "CI", minutesAgo: i + 1 }));
  return { ...SNAPSHOT, ci: { ...SNAPSHOT.ci, runs } };
}

test("the CI view: find with a run's name and branch opens on that run, not the first with the same name", async () => {
  const short = (i: number) => `task/${i}-x`;
  const long = (i: number) => `task/${i}-a-branch-name-long-enough-to-be-clipped-on-a-narrow-screen`;
  for (const [cols, branch] of [[140, short], [50, long]] as const) {
    const data = manyRuns(40, branch);
    const load = () => Promise.resolve(data);
    const top = drawDoc("ci", { cols, rows: 12, color: false, data, load });
    await top.settle();
    expect(top.frame(), `${cols} columns`).not.toContain(`task/33-`);
    top.unmount();
    const v = drawDoc("ci", { cols, rows: 12, color: false, data, load, find: `CI on ${branch(33)}` });
    await v.settle();
    const f = v.frame();
    v.unmount();
    expect(f, `${cols} columns`).toContain(`CI on task/33-`);
  }
});

test("search: Enter on a session opens Agents & machines at its name", async () => {
  const { args } = await opens("fasil");
  expect(args?.slice(0, 2)).toEqual(["--agents", "--find"]);
  expect(args?.length).toBe(3);
  expect(args?.[2]).toContain("fasil");
});

test("search: Enter on a setting opens Settings with colour at its key", async () => {
  expect((await opens("budget.builder")).args).toEqual(["--settings", "--color", "--find", "budget.builder"]);
});

test("search: Enter on a doctor fix, and on a lesson, opens Health & releases and Usage & lessons at text from the row", async () => {
  for (const [typed, flag] of [["admin rights", "--health"], ["before the PR", "--usage"]] as const) {
    const { args, frame } = await opens(typed);
    expect(args?.slice(0, 2), typed).toEqual([flag, "--find"]);
    expect(args?.length, typed).toBe(3);
    expect((args?.[2] ?? "").length).toBeGreaterThan(0);
    expect(strip(frame).toLowerCase(), typed).toContain((args?.[2] ?? "").toLowerCase());
  }
});

test("search: a usage task row opens Usage & lessons, and the version opens Health & releases", async () => {
  expect((await opens("reviewer")).args?.slice(0, 2)).toEqual(["--usage", "--find"]);
  expect((await opens("0.2.4")).args?.slice(0, 2)).toEqual(["--health", "--find"]);
});

test("search: without settings or usage data the other views are still searched", async () => {
  const s = search({ data: { snapshot: SNAPSHOT, settings: null, usage: null }, prefill: "importer" });
  await s.v.settle();
  expect(s.v.frame()).toContain("Task 7: the importer");
  s.v.unmount();
  const all = search({ data: { snapshot: SNAPSHOT, settings: null, usage: null } });
  await all.v.settle();
  expect(all.v.frame()).not.toContain("budget.builder");
  expect(all.v.frame()).toContain("Needs you");
  all.v.unmount();
});

// --- sizes and colour --------------------------------------------------------------------------------------------------

test("search: narrow it still fits and the rows keep their group heading", async () => {
  const s = search({ cols: 40, rows: 24, prefill: "menelik" });
  await s.v.settle();
  const f = s.v.frame();
  s.v.unmount();
  fits(f, 40, 24);
  expect(f.split("\n")[0]).toBe("/ menelik");
  expect(f).toContain("Pull requests");
  expect(f).toContain("Tasks & PRD");
  expect(f.split("\n").at(-1)).toContain("Esc");
});

test("search: wide it fits and the right-hand view name is on each row", async () => {
  const s = search({ cols: 120, rows: 40 });
  await s.v.settle();
  const f = s.v.frame();
  s.v.unmount();
  fits(f, 120, 40);
  for (const [row, view] of [["ship-it", "Needs you"], ["Task 8: the exporter", "Pull requests"], ["Real tmux tests", "Tasks & PRD"],
    ["Nightly build", "CI"], ["fasil", "Agents & machines"], ["tasks.source", "Settings"]] as const) {
    const l = lineWith(f, row);
    expect(l.indexOf(view), l).toBeGreaterThan(l.indexOf(row));
  }
});

test("search: colour on gives escape sequences and only the colour changes; colour off gives none", async () => {
  const plain = search({ cols: 60, rows: 40, prefill: "task", color: false });
  const coloured = search({ cols: 60, rows: 40, prefill: "task", color: true });
  await coloured.v.settle();
  const [p, c] = [plain.v.frame(), coloured.v.frame()];
  plain.v.unmount();
  coloured.v.unmount();
  expect(p).not.toMatch(ESC);
  expect(c).toMatch(ESC);
  expect(strip(c)).toBe(p);
});

// --- in the views ------------------------------------------------------------------------------------------------------

const A = "a".repeat(40);
const B = "b".repeat(40);
const NOW = Date.parse("2026-10-31T12:00:00Z");

function pr(number: number, title: string, sha: string, extra: Row = {}): Row {
  return { number, title, url: `https://github.com/o/r/pull/${number}`, branch: `task/${number}-x`, head: { sha, ageMinutes: 30 },
    ci: { state: "green", jobs: 2, notGreen: [] }, next: { action: "review", text: "review" }, ...extra };
}

const PRS: Row = { generatedAt: "2026-10-31T11:59:20Z",
  pulls: [pr(12, "Task 7: the importer", A, { agent: "menelik" }), pr(13, "Task 8: the exporter", B, { agent: "taytu" })], questions: [] };

function prsProps(o: Partial<PrsProps> = {}): PrsProps {
  return { repo: "work", select: null, changes: "GitHub: it merges the pull request", cols: 140, rows: 30, color: false,
    limitSeconds: 20, load: () => Promise.resolve(PRS), act: () => Promise.resolve("merged"), refuse: () => {}, now: () => NOW, ...o };
}

const TASKS: Row = { source: "issues", prd: "docs/PRD.md", tasks: [
  { id: "362", title: "Real tmux tests", state: "new", holders: [], group: "", todos: [] },
  { id: "367", title: "Cockpit on Ink: the views", state: "in-progress", holders: ["haile"], group: "cockpit", todos: [] },
  { id: "300", title: "An old one", state: "done", holders: [], group: "", todos: [] },
] };

function tasksProps(o: Partial<TasksProps> = {}): TasksProps {
  return { repo: "work", cols: 140, rows: 30, color: false, limitSeconds: 20, load: () => Promise.resolve(TASKS), ...o };
}

const NEEDS: Row = { generatedAt: "2026-10-31T11:57:00Z", needsYou: [
  { kind: "owner-merges", number: 9, title: "Update the factory", url: "https://github.com/o/r/pull/9" },
  { kind: "owner-ask", id: "ship-it", issue: 77, url: "https://github.com/o/r/issues/77#c1", ageMinutes: 8, state: "owner" },
  { kind: "owner-ask", id: "other-ask", issue: 78, url: "https://github.com/o/r/issues/78#c2", ageMinutes: 9, state: "open" },
] };

function needsProps(o: Partial<NeedsProps> = {}): NeedsProps {
  return { repo: "work", snapshot: NEEDS, cols: 140, rows: 30, color: false, load: () => Promise.resolve(NEEDS), now: () => NOW, ...o };
}

const selectedLine = (f: string) => f.split("\n").find((l) => l.startsWith("›")) ?? "";

test("tasks: find opens with that task selected first", async () => {
  const v = drawTasks(tasksProps({ find: "300" }));
  await v.settle();
  const f = v.frame();
  v.unmount();
  expect(selectedLine(f)).toMatch(/^› #300\b/);
  const other = drawTasks(tasksProps({ find: "362" }));
  await other.settle();
  expect(selectedLine(other.frame())).toMatch(/^› #362\b/);
  other.unmount();
});

test("tasks: find with an id no task has opens as usual, on the first task", async () => {
  const v = drawTasks(tasksProps({ find: "9999" }));
  await v.settle();
  expect(selectedLine(v.frame())).toMatch(/^› #367\b/); // in progress comes first
  v.unmount();
});

test("needs: find selects the ask with that id, or the pull request #<n>", async () => {
  const ask = drawNeeds(needsProps({ find: "other-ask" }));
  await ask.settle();
  expect(selectedLine(ask.frame())).toContain("other-ask");
  ask.unmount();
  const merge = drawNeeds(needsProps({ find: "#9" }));
  await merge.settle();
  expect(selectedLine(merge.frame())).toContain("PR #9");
  merge.unmount();
  const second = drawNeeds(needsProps({ find: "ship-it" }));
  await second.settle();
  expect(selectedLine(second.frame())).toContain("ship-it");
  second.unmount();
});

function manySettings(n: number): Row {
  const rows = Array.from({ length: n }, (_, i) => ({ key: `group.setting${String(i).padStart(2, "0")}`, owner: false, value: String(i),
    from: "default", pending: false, help: `what setting ${i} does` }));
  return { ...SETTINGS, sections: [{ name: "Many", rows }] };
}

test("a document view: find opens scrolled so the first line with that text is on screen", async () => {
  const data = manySettings(60);
  const load = () => Promise.resolve(data);
  const top = drawDoc("settings", { cols: 140, rows: 12, color: false, data, load });
  await top.settle();
  expect(top.frame()).not.toContain("group.setting55");
  top.unmount();
  const v = drawDoc("settings", { cols: 140, rows: 12, color: false, data, load, find: "group.setting55" });
  await v.settle();
  const f = v.frame();
  v.unmount();
  expect(f).toContain("group.setting55");
  expect(f.split("\n").length).toBeLessThanOrEqual(12);
});

test("a document view: find is matched in any case and a text no line has opens at the top", async () => {
  const data = manySettings(60);
  const load = () => Promise.resolve(data);
  const v = drawDoc("settings", { cols: 140, rows: 12, color: false, data, load, find: "GROUP.SETTING40" });
  await v.settle();
  expect(v.frame()).toContain("group.setting40");
  v.unmount();
  const none = drawDoc("settings", { cols: 140, rows: 12, color: false, data, load, find: "no such text anywhere" });
  await none.settle();
  const plainTop = drawDoc("settings", { cols: 140, rows: 12, color: false, data, load });
  await plainTop.settle();
  expect(none.frame()).toBe(plainTop.frame());
  none.unmount();
  plainTop.unmount();
});

test("a document view, found while reading: the view that reads first also scrolls to the text", async () => {
  const data = manySettings(60);
  const v = drawDoc("settings", { cols: 140, rows: 12, color: false, load: () => Promise.resolve(data), find: "group.setting55" });
  await v.settle();
  await v.settle();
  expect(v.frame()).toContain("group.setting55");
  v.unmount();
});

test("prs: / starts a filter, typing narrows the rows, the keys line shows it, Enter keeps it and Esc clears it", async () => {
  const v = drawPrs(prsProps());
  await v.settle();
  expect(v.frame()).toContain("Task 7: the importer");
  expect(v.frame()).toContain("Task 8: the exporter");
  await v.press("/");
  await v.press("exporter");
  let f = v.frame();
  expect(f).not.toContain("Task 7: the importer");
  expect(f).toContain("Task 8: the exporter");
  expect(f.split("\n").at(-1)).toContain("/ exporter");
  await v.press(ENTER);
  f = v.frame();
  expect(f).not.toContain("Task 7: the importer"); // Enter keeps the filter
  expect(f).toContain("Task 8: the exporter");
  await v.press("/");
  await v.press(ESCAPE_KEY);
  await Bun.sleep(80);
  f = v.frame();
  expect(f).toContain("Task 7: the importer"); // Esc shows every row again
  expect(f).toContain("Task 8: the exporter");
  v.unmount();
});

test("prs: a filter matching no row says so, and while typing q j k r m are text, not keys", async () => {
  let reads = 0;
  const acted: string[] = [];
  const v = drawPrs(prsProps({ load: () => { reads += 1; return Promise.resolve(PRS); }, act: (w) => { acted.push(String(w)); return Promise.resolve("merged"); } }));
  await v.settle();
  const before = reads;
  await v.press("/");
  await v.press("qjkrm");
  const f = v.frame();
  expect(f).toContain(`No match for "qjkrm".`);
  expect(f.split("\n").at(-1)).toContain("/ qjkrm");
  expect(reads).toBe(before); // r did not read again
  expect(acted).toEqual([]); // m did not start a merge
  await v.press(ESCAPE_KEY);
  await Bun.sleep(80);
  expect(v.frame()).toContain("Task 7: the importer");
  v.unmount();
});

test("prs: the filter takes the same words as the search: every word, any case", async () => {
  const v = drawPrs(prsProps());
  await v.settle();
  await v.press("/");
  await v.press("EXPORTER taytu");
  expect(v.frame()).toContain("Task 8: the exporter");
  expect(v.frame()).not.toContain("Task 7: the importer");
  await v.press(" menelik");
  expect(v.frame()).toContain(`No match for "EXPORTER taytu menelik".`);
  v.unmount();
});

test("tasks: / filters the rows, Esc shows them all again, and the keys are text while typing", async () => {
  let reads = 0;
  const v = drawTasks(tasksProps({ load: () => { reads += 1; return Promise.resolve(TASKS); } }));
  await v.settle();
  const before = reads;
  await v.press("/");
  await v.press("tmux");
  let f = v.frame();
  expect(f).toContain("Real tmux tests");
  expect(f).not.toContain("An old one");
  expect(f.split("\n").at(-1)).toContain("/ tmux");
  await v.press("qjkr");
  f = v.frame();
  expect(f).toContain(`No match for "tmuxqjkr".`);
  expect(reads).toBe(before);
  await v.press(BACKSPACE.repeat(4));
  expect(v.frame()).toContain("Real tmux tests");
  await v.press(ESCAPE_KEY);
  await Bun.sleep(80);
  f = v.frame();
  expect(f).toContain("An old one");
  expect(f).toContain("Cockpit on Ink: the views");
  v.unmount();
});

test("needs: / filters the asks and merges, Esc clears it, and no match says so", async () => {
  const v = drawNeeds(needsProps());
  await v.settle();
  await v.press("/");
  await v.press("other-ask");
  let f = v.frame();
  expect(f).toContain("other-ask");
  expect(f).not.toContain("ship-it");
  expect(f).not.toContain("Update the factory");
  expect(f.split("\n").at(-1)).toContain("/ other-ask");
  await v.press("zz");
  expect(v.frame()).toContain(`No match for "other-askzz".`);
  await v.press(ESCAPE_KEY);
  await Bun.sleep(80);
  f = v.frame();
  expect(f).toContain("ship-it");
  expect(f).toContain("Update the factory");
  v.unmount();
});

test("a document view: / narrows the lines, Esc shows the whole document, no match says so, and the keys are text while typing", async () => {
  const data = { ...SNAPSHOT, doctor: { ok: 30, fixes: 1, notes: 2, summary: "1 to fix.", fix: ["gh login has admin rights: use a second account with Write"] } };
  let reads = 0;
  const v = drawDoc("health", { cols: 140, rows: 60, color: false, data, load: () => { reads += 1; return Promise.resolve(data); } });
  await v.settle();
  expect(v.frame()).toContain("Factory version");
  await v.press("/");
  await v.press("admin");
  let f = v.frame();
  expect(f).toContain("gh login has admin rights");
  expect(f).not.toContain("Factory version");
  expect(f.split("\n").at(-1)).toContain("/ admin");
  await v.press(ENTER);
  expect(v.frame()).not.toContain("Factory version"); // Enter keeps it
  await v.press("/");
  await v.press(ESCAPE_KEY);
  await Bun.sleep(80);
  expect(v.frame()).toContain("Factory version");
  await v.press("/");
  await v.press("qjkrm");
  f = v.frame();
  expect(f).toContain(`No match for "qjkrm".`);
  expect(reads).toBe(0); // the document had its data, and r typed as text did not read again
  v.unmount();
});

// --- the list ----------------------------------------------------------------------------------------------------------

const VIEWS = [{ key: "1", title: "Needs you" }, { key: "2", title: "Pull requests" }, { key: "3", title: "Tasks & PRD" }];
const LIST: { snapshot: unknown; views: Array<{ key: string; title: string }> } = {
  snapshot: { sessions: [{ name: "haile", state: "working", kind: "coding agent", where: "this machine", source: "local", machine: "aaaa1111",
    expected: true }], needsYou: [] },
  views: VIEWS,
};

test("the list: / asks for the search", async () => {
  const s = sidebarOf(LIST, 40, 30);
  await s.press("/");
  expect(s.calls).toEqual(["search"]);
  s.unmount();
});

test("the list: the help line shows / search, in the full help and in the short one", () => {
  for (const rows of [30, 16, 10]) {
    const s = sidebarOf(LIST, 40, rows);
    expect(s.frame(), `rows ${rows}`).toContain("/ search");
    s.unmount();
  }
});

// --- through factory ---------------------------------------------------------------------------------------------------

interface Proj { d: string; root: string; env: Record<string, string | undefined>; xdg: string; log: string }

function project(cfg: Row = { tasks: { source: "issues" }, prd: "docs/PRD.md" }): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  write(join(root, "bin", "gh"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\necho '[]'\n`, 0o755);
  write(join(root, "bin", "tmux"), "#!/usr/bin/env bash\nfor a in \"$@\"; do [ \"$a\" = -V ] && { echo 'tmux 3.4'; exit 0; }; done\nexit 0\n", 0o755);
  const xdg = join(root, "state");
  const env = envWith(join(root, "bin"), { XDG_STATE_HOME: xdg, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, CLAUDECODE: undefined,
    FACTORY_CONFIG_DIR: undefined, TMUX: undefined, COLUMNS: "120", LINES: "40", NO_COLOR: "1" });
  mkdirSync(join(root, "home"));
  return { d, root, env, xdg, log };
}

function seed(p: Proj): void {
  write(join(p.xdg, "work-factory", "cockpit.json"), JSON.stringify({ ...SNAPSHOT, generatedAt: new Date().toISOString() }));
}

function cockpit(p: Proj, args: string[], extra: Record<string, string | undefined> = {}) {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: { ...p.env, ...extra }, timeoutMs: 100_000 });
}

function ghCalls(p: Proj): string[] {
  return readFileSync(p.log, "utf8").split("\n").filter((l) => l);
}

test("factory cockpit --search <words> off a terminal prints one frame with the words typed, from at least three views, with no GitHub call", () => {
  const p = project();
  seed(p);
  const r = cockpit(p, ["--search", "menelik"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).not.toContain("\x1b");
  const lines = r.stdout.trimEnd().split("\n");
  expect(lines[0]).toBe("/ menelik");
  expect(lines.at(-1)).toContain("Enter opens");
  const headings = TITLES.filter((t) => lines.some((l) => l.trim().startsWith(t)));
  expect(headings.length, r.stdout).toBeGreaterThanOrEqual(3);
  for (const l of lines) expect([...l].length, l).toBeLessThanOrEqual(120);
  expect(lines.length).toBeLessThanOrEqual(40);
  expect(ghCalls(p)).toEqual([]);
}, 120_000);

test("factory cockpit --search with several words, and with none, sizes the frame by COLUMNS and LINES", () => {
  const p = project();
  seed(p);
  const some = cockpit(p, ["--search", "task", "importer"], { COLUMNS: "50", LINES: "20" });
  expect(some.code, some.out).toBe(0);
  expect(some.stdout.split("\n")[0]).toBe("/ task importer");
  expect(some.stdout).toContain("Task 7: the importer");
  for (const l of some.stdout.trimEnd().split("\n")) expect([...l].length, l).toBeLessThanOrEqual(50);
  expect(some.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(20);
  const none = cockpit(p, ["--search", "zzzzqq"]);
  expect(none.code, none.out).toBe(0);
  expect(none.stdout).toContain(`No match for "zzzzqq".`);
  expect(ghCalls(p)).toEqual([]);
}, 120_000);

test("factory cockpit --search-data prints the snapshot, the settings and the usage as JSON, with no GitHub call", () => {
  const p = project();
  seed(p);
  const r = cockpit(p, ["--search-data"]);
  expect(r.code, r.out).toBe(0);
  const data = JSON.parse(r.stdout) as Row;
  for (const k of ["snapshot", "settings", "usage"]) expect(data, k).toHaveProperty(k);
  expect(data.snapshot.pulls.map((x: Row) => x.number)).toEqual([12, 13]);
  expect(data.snapshot.tasks.tasks.map((t: Row) => t.id)).toEqual(["367", "362"]);
  expect(ghCalls(p)).toEqual([]);
}, 120_000);

test("factory cockpit --search-data with an unknown argument exits 2 with {code, message, fix}", () => {
  const p = project();
  seed(p);
  const r = cockpit(p, ["--search-data", "extra"]);
  expect(r.code, r.out).toBe(2);
  const e = JSON.parse(r.stderr.trim().split("\n").pop() ?? "{}") as Row;
  for (const k of ["code", "message", "fix"]) expect(typeof e[k], k).toBe("string");
  expect(e.fix.length).toBeGreaterThan(0);
  expect(ghCalls(p)).toEqual([]);
}, 120_000);

test("factory cockpit --tasks --find <id> off a terminal puts the selection on that task's row", () => {
  const p = project({ plan: "docs/BUILD_PLAN.md" });
  write(join(p.d, "docs", "BUILD_PLAN.md"), "# Plan\n\n## Phase 1\n\n- [ ] **1.1 The first task**\n- [ ] **1.2 The second task**\n");
  const r = cockpit(p, ["--tasks", "--find", "1.2"]);
  expect(r.code, r.out).toBe(0);
  const selected = r.stdout.split("\n").find((l) => l.startsWith("›")) ?? "";
  expect(selected, r.stdout).toContain("1.2");
  expect(selected).toContain("The second task");
}, 120_000);

test("the cockpit's tmux config binds / to a popup running cockpit --search and the pane border names C-a /", async () => {
  const p = project();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...p.env, NO_COLOR: undefined })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit"], { cwd: p.d, env, terminal: { cols: 120, rows: 40, data() {} } });
  const timer = setTimeout(() => proc.kill(9), 50_000);
  await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  const conf = readFileSync(join(p.xdg, "work-factory", "cockpit.tmux.conf"), "utf8");
  const bind = conf.split("\n").find((l) => /^bind ["']?\/["']? /.test(l)) ?? "";
  expect(bind, conf).toContain("display-popup");
  expect(bind).toContain("cockpit --search");
  expect(bind).not.toContain("less");
  expect(conf).toContain("C-a /");
}, 60_000);

// --- the docs ----------------------------------------------------------------------------------------------------------

test("the wiki's commands page has a row for factory cockpit --search, and the cockpit row names C-a /", () => {
  const wiki = readFileSync(join(WIKI, "commands.md"), "utf8");
  expect(wiki).toMatch(/^\| `factory cockpit --search \[<words>\]` \|/m);
  const row = wiki.split("\n").find((l) => l.startsWith("| `factory cockpit` |")) ?? "";
  expect(row).toContain("C-a /");
});
