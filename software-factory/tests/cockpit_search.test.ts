// The cockpit's search across the views (#392): a box that matches as you type over every view's rows, grouped by view;
// Enter opens that view on the row, Esc closes. Drawn with ink-testing-library from fixed items at a narrow and a wide
// size, with and without colour. Then `/` in the views, the `find` they select by, the sidebar's `/`, and, through
// `factory`, `factory cockpit --search` off a terminal: built from the cockpit's cache, and it makes no GitHub call.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  drawDoc, drawNeeds, drawPrs, drawSearch, drawTasks, type NeedsProps, type PrsProps, type SearchItem, type SearchOutcome,
  type SearchProps, sidebarOf, type TasksProps,
} from "../cockpit/testing.tsx";
import { CI, copyHookFolders, envWith, gitRepo, HOOKS, SF, sh, tmp, WIKI, write } from "./support.ts";

type Row = Record<string, unknown>;
const ESC = /\x1b\[/;
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const BACKSPACE = "\x7f";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function fits(frame: string, cols: number, rows: number): void {
  const all = strip(frame).split("\n");
  expect(all.length, frame).toBeLessThanOrEqual(rows);
  for (const l of all) expect([...l].length, l).toBeLessThanOrEqual(cols);
}

// --- the search drawn ---------------------------------------------------------------------------------------------------

const T = {
  needs: "Needs you", prs: "Pull requests", tasks: "Tasks & PRD", agents: "Agents & machines", settings: "Settings",
};

/** Listed out of view order on purpose: the search groups them by view key. */
const ITEMS: SearchItem[] = [
  { view: "5", title: T.agents, text: "haile coding agent idle", find: "haile" },
  { view: "2", title: T.prs, text: "#12 Task 7: the importer task/12-importer menelik", find: "12" },
  { view: "1", title: T.needs, text: "Owner ask ship-it on #77: the importer schema", find: "ship-it" },
  { view: "6", title: T.settings, text: "tasks.source issues where the tasks come from", find: "tasks.source" },
  { view: "2", title: T.prs, text: "#13 Task 8: the exporter task/13-exporter taytu", find: "13" },
  { view: "5", title: T.agents, text: "fasil dev manager working", find: "fasil" },
];

interface Run {
  props: SearchProps;
  outcomes: SearchOutcome[];
}

function run(o: Partial<SearchProps> = {}): Run {
  const outcomes: SearchOutcome[] = [];
  const props: SearchProps = { items: ITEMS, scope: null, prefill: "", cols: 100, rows: 30, color: false,
    finish: (x) => outcomes.push(x), ...o };
  return { props, outcomes };
}

/** The line of the frame that starts with `s`, the selected row's mark included. */
function selectedRow(frame: string): string {
  return strip(frame).split("\n").find((l) => l.startsWith("›")) ?? "";
}

test("search with an empty box lists every row of every view, grouped by view in key order, each group headed by its key and name", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  const f = v.frame();
  v.unmount();
  fits(f, 100, 30);
  expect(f).not.toMatch(ESC);
  const lines = f.split("\n");
  const heads = lines.filter((l) => /^\d \S/.test(l));
  expect(heads).toEqual(["1 Needs you", "2 Pull requests", "5 Agents & machines", "6 Settings"]);
  const at = (s: string) => lines.findIndex((l) => l.includes(s));
  expect(at("Owner ask ship-it")).toBeGreaterThan(at("1 Needs you"));
  expect(at("#12 Task 7")).toBeGreaterThan(at("2 Pull requests"));
  expect(at("#12 Task 7")).toBeLessThan(at("#13 Task 8"));
  expect(at("#13 Task 8")).toBeLessThan(at("5 Agents & machines"));
  expect(at("fasil dev manager")).toBeGreaterThan(at("5 Agents & machines"));
  expect(at("tasks.source")).toBeGreaterThan(at("6 Settings"));
  expect(lines.filter((l) => l.startsWith("› ")).length, "one row is selected").toBe(1);
  expect(selectedRow(f)).toContain("Owner ask ship-it");
  expect(f).toMatch(/^ {2}#12 Task 7/m); // an unselected row is two spaces and its text
});

test("search: the frame has a box line with what is typed, and a keys line with Enter and Esc", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  expect(v.frame()).toMatch(/^Search: $/m);
  await v.press("imp");
  const f = v.frame();
  expect(f).toMatch(/^Search: imp$/m);
  expect(f).toContain("Enter opens");
  expect(f).toContain("Esc closes");
  v.unmount();
});

test("search: typing narrows the rows live, every word must be there in any order and any case, Backspace widens them again", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  await v.press("importer");
  let f = v.frame();
  expect(f).toContain("Task 7: the importer");
  expect(f).toContain("Owner ask ship-it"); // found in two views
  expect(f).not.toContain("exporter");
  expect(f).not.toContain("haile");
  expect(f).not.toContain("5 Agents");
  await v.press(" SCHEMA");
  f = v.frame();
  expect(f).toMatch(/^Search: importer SCHEMA$/m);
  expect(f).toContain("Owner ask ship-it");
  expect(f).not.toContain("Task 7: the importer");
  expect(f).not.toContain("2 Pull requests");
  await v.press(BACKSPACE.repeat(7));
  await v.press(BACKSPACE.repeat(8));
  f = v.frame();
  expect(f).toMatch(/^Search: $/m);
  expect(f).toContain("exporter");
  expect(f).toContain("haile");
  v.unmount();
});

test("search: words in another order still match, and the best-known case: 'IDLE haile' finds the session", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  await v.press("IDLE haile");
  const f = v.frame();
  expect(f).toContain("haile coding agent idle");
  expect(f).not.toContain("fasil");
  v.unmount();
});

test("search: results can come from at least three views at once, each group headed by its view", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  await v.press("a"); // in every view's text
  const heads = v.frame().split("\n").filter((l) => /^\d \S/.test(l));
  expect(heads.length).toBeGreaterThanOrEqual(3);
  v.unmount();
});

test("search: a prefill is typed already and filters the rows", async () => {
  const r = run({ prefill: "exporter" });
  const v = drawSearch(r.props);
  await v.settle();
  const f = v.frame();
  expect(f).toMatch(/^Search: exporter$/m);
  expect(f).toContain("#13 Task 8");
  expect(f).not.toContain("#12 Task 7");
  v.unmount();
});

test("search: with a scope only that view's rows are searched", async () => {
  const r = run({ scope: "2" });
  const v = drawSearch(r.props);
  await v.settle();
  let f = v.frame();
  expect(f).toContain("2 Pull requests");
  expect(f).toContain("#12 Task 7");
  expect(f).not.toContain("Needs you");
  expect(f).not.toContain("haile");
  expect(f).not.toContain("tasks.source");
  await v.press("importer");
  f = v.frame();
  expect(f).toContain("#12 Task 7");
  expect(f).not.toContain("Owner ask"); // the Needs you row has "importer" but is in another view
  v.unmount();
});

test("search: ↑ and ↓ move the mark across the groups, and stop at the first and last row", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  const order = ["Owner ask ship-it", "#12 Task 7", "#13 Task 8", "haile coding", "fasil dev", "tasks.source"];
  expect(selectedRow(v.frame())).toContain(order[0]);
  await v.press(UP);
  expect(selectedRow(v.frame())).toContain(order[0]);
  for (const want of order.slice(1)) {
    await v.press(DOWN);
    expect(selectedRow(v.frame()), want).toContain(want);
  }
  await v.press(DOWN);
  expect(selectedRow(v.frame())).toContain("tasks.source");
  await v.press(UP);
  expect(selectedRow(v.frame())).toContain("fasil dev");
  v.unmount();
});

test("search: Enter opens the selected row's view on that row, and the search is done", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  await v.press(DOWN);
  await v.press(DOWN);
  await v.press("\r");
  await v.settle();
  expect(r.outcomes).toEqual([{ kind: "open", view: "2", find: "13" }]);
  await v.press("x");
  await v.press("\r");
  expect(r.outcomes.length, "later keys do nothing").toBe(1);
  v.unmount();
});

test("search: Enter after typing opens the first match, in the view that has it", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  await v.press("tasks.source");
  await v.press("\r");
  expect(r.outcomes).toEqual([{ kind: "open", view: "6", find: "tasks.source" }]);
  v.unmount();
});

test("search: Esc closes without opening anything", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  await v.press("imp");
  await v.press("\x1b");
  await Bun.sleep(80); // Ink waits a moment to tell Esc from an arrow key
  expect(r.outcomes).toEqual([{ kind: "closed" }]);
  v.unmount();
});

test("search: no match says so, Enter then does nothing, and Backspace brings the rows back", async () => {
  const r = run();
  const v = drawSearch(r.props);
  await v.settle();
  await v.press("zzzzqq");
  const f = v.frame();
  expect(f).toContain("No match");
  expect(f).toMatch(/^Search: zzzzqq$/m);
  expect(f).not.toMatch(/^\d \S/m);
  expect(f).not.toContain("›");
  await v.press("\r");
  await v.settle();
  expect(r.outcomes).toEqual([]);
  await v.press(BACKSPACE.repeat(6));
  expect(v.frame()).not.toContain("No match");
  expect(v.frame()).toContain("Owner ask ship-it");
  v.unmount();
});

test("search with no rows at all says there is no match", async () => {
  const r = run({ items: [] });
  const v = drawSearch(r.props);
  await v.settle();
  expect(v.frame()).toContain("No match");
  await v.press("\r");
  expect(r.outcomes).toEqual([]);
  v.unmount();
});

test("search, narrow: long rows are cut to the width and the frame fits the rows", async () => {
  const long: SearchItem[] = [
    { view: "2", title: T.prs, text: `#1 ${"a very long pull request title ".repeat(8)}`, find: "1" },
    { view: "1", title: T.needs, text: `Owner ask ${"x".repeat(200)}`, find: "x" },
  ];
  const r = run({ items: long, cols: 30, rows: 10 });
  const v = drawSearch(r.props);
  await v.settle();
  fits(v.frame(), 30, 10);
  await v.press("pull");
  fits(v.frame(), 30, 10);
  expect(v.frame()).toContain("#1 a very long");
  v.unmount();
});

test("search, narrow and coloured: it fits and only the colour changes", async () => {
  const p = drawSearch(run({ cols: 30, rows: 14 }).props);
  const c = drawSearch(run({ cols: 30, rows: 14, color: true }).props);
  await c.settle();
  await p.press("a");
  await c.press("a");
  const [pf, cf] = [p.frame(), c.frame()];
  p.unmount();
  c.unmount();
  fits(cf, 30, 14);
  expect(cf).toMatch(ESC);
  expect(pf).not.toMatch(ESC);
  expect(strip(cf)).toBe(pf);
});

test("search, wide and plain: no escape sequence at all", async () => {
  const v = drawSearch(run({ cols: 160, rows: 40 }).props);
  await v.settle();
  await v.press("o");
  expect(v.frame()).not.toMatch(ESC);
  fits(v.frame(), 160, 40);
  v.unmount();
});

test("search: a long list scrolls, the selected row is always shown, and Enter opens it", async () => {
  const many: SearchItem[] = Array.from({ length: 60 }, (_, i) => ({ view: "2", title: T.prs, text: `row number ${i}`, find: `find-${i}` }));
  const r = run({ items: many, rows: 10 });
  const v = drawSearch(r.props);
  await v.settle();
  fits(v.frame(), 100, 10);
  for (let i = 1; i <= 30; i++) {
    await v.press(DOWN);
    expect(selectedRow(v.frame()), `after ${i} downs`).toContain(`row number ${i}`);
    fits(v.frame(), 100, 10);
  }
  expect(v.frame()).toContain("Search:");
  expect(v.frame()).toContain("Esc closes");
  await v.press("\r");
  expect(r.outcomes).toEqual([{ kind: "open", view: "2", find: "find-30" }]);
  v.unmount();
});

test("search: text from GitHub or a log can't drive the terminal", async () => {
  const evil = "x\x1b]0;owned\x07\x1b[2J\x9b31m";
  const v = drawSearch(run({ items: [{ view: "2", title: T.prs, text: `#1 ${evil}`, find: "1" }] }).props);
  await v.settle();
  const f = v.frame();
  v.unmount();
  expect(f).not.toContain("\x1b");
  expect(f).not.toContain("\x07");
  expect(f).not.toContain("\x9b");
});

// --- `/` in the views, and the row they select -------------------------------------------------------------------------

const PRS: Row = {
  pulls: [
    { number: 12, title: "Task 7: the importer", url: "https://github.com/o/r/pull/12", branch: "task/12-x", head: { sha: "a".repeat(40), ageMinutes: 30 },
      ci: { state: "green", jobs: 2, notGreen: [] }, next: { action: "review", text: "review" } },
    { number: 13, title: "Task 8: the exporter", url: "https://github.com/o/r/pull/13", branch: "task/13-x", head: { sha: "b".repeat(40), ageMinutes: 30 },
      ci: { state: "green", jobs: 2, notGreen: [] }, next: { action: "review", text: "review" } },
  ],
};
const NEEDS: Row = {
  generatedAt: "2026-10-31T11:57:00Z",
  needsYou: [
    { kind: "owner-ask", id: "ship-it", issue: 77, url: "https://github.com/o/r/issues/77#c1", ageMinutes: 8, state: "owner" },
    { kind: "owner-merges", number: 9, title: "Update the factory", url: "https://github.com/o/r/pull/9" },
  ],
};
const TASKS: Row = {
  source: "issues", prd: "software-factory/docs/PRD.md",
  tasks: [
    { id: "362", title: "Real tmux tests", state: "new", holders: [], group: "", todos: [] },
    { id: "367", title: "Cockpit on Ink: the views", state: "in-progress", holders: ["haile"], group: "cockpit", todos: [] },
    { id: "370", title: "Waits on the owner", state: "blocked", holders: [], group: "", todos: [] },
  ],
};

const prsProps = (o: Partial<PrsProps> = {}): PrsProps => ({ repo: "work", select: null, changes: "GitHub", cols: 140, rows: 30, color: false,
  limitSeconds: 20, load: () => Promise.resolve(PRS), act: () => Promise.resolve("merged"), refuse: () => {}, ...o });
const needsProps = (o: Partial<NeedsProps> = {}): NeedsProps => ({ repo: "work", snapshot: NEEDS, cols: 140, rows: 30, color: false,
  load: () => Promise.resolve(NEEDS), ...o });
const tasksProps = (o: Partial<TasksProps> = {}): TasksProps => ({ repo: "work", cols: 140, rows: 30, color: false, limitSeconds: 20,
  load: () => Promise.resolve(TASKS), ...o });

test("/ in the Needs you view asks for the search and closes the view", async () => {
  let asked = 0;
  const v = drawNeeds(needsProps({ search: () => asked++ }));
  await v.settle();
  await v.press("/");
  expect(asked).toBe(1);
  const after = v.frame();
  await v.press("j");
  await v.press("/");
  expect(asked, "the view is closed: later keys do nothing").toBe(1);
  expect(v.frame()).toBe(after);
  v.unmount();
});

test("/ in the Pull requests view asks for the search and closes the view", async () => {
  let asked = 0;
  const v = drawPrs(prsProps({ search: () => asked++ }));
  await v.settle();
  await v.press("/");
  expect(asked).toBe(1);
  const after = v.frame();
  await v.press("j");
  expect(v.frame()).toBe(after);
  v.unmount();
});

test("/ in the Tasks & PRD view asks for the search and closes the view", async () => {
  let asked = 0;
  const v = drawTasks(tasksProps({ search: () => asked++ }));
  await v.settle();
  await v.press("/");
  expect(asked).toBe(1);
  const after = v.frame();
  await v.press("j");
  expect(v.frame()).toBe(after);
  v.unmount();
});

test("/ in a document view asks for the search and closes the view", async () => {
  for (const name of ["ci", "settings", "usage", "agents", "health"] as const) {
    let asked = 0;
    const data: Row = { repo: "o/work", sections: [], machine: [], staged: { problem: "", changes: [] }, tasks: [], lessons: [], sessions: [],
      doctor: { ok: 1, fixes: 0, notes: 0, summary: "ok", fix: [] }, version: { installed: "0.2.4", source: "release" },
      ci: { mode: "local", repo: "o/work", label: "l", instances: [], runs: [], runners: [], light: { label: "x", runners: [] }, queuedLong: { count: 0 }, errors: [] } };
    const v = drawDoc(name, { cols: 100, rows: 20, color: false, data, load: () => Promise.resolve(data), search: () => asked++ });
    await v.settle();
    await v.press("/");
    expect(asked, name).toBe(1);
    v.unmount();
  }
});

test("a view without a search prop ignores /", async () => {
  const v = drawTasks(tasksProps());
  await v.settle();
  const before = v.frame();
  await v.press("/");
  expect(v.frame()).toBe(before);
  v.unmount();
});

test("find selects the first Needs you row whose text has it, in any case", async () => {
  const v = drawNeeds(needsProps({ find: "UPDATE the factory" }));
  await v.settle();
  expect(v.frame()).toMatch(/^› .*Update the factory/m);
  expect(v.frame()).not.toMatch(/^› .*Owner ask ship-it/m);
  const w = drawNeeds(needsProps({ find: "nothing like this" }));
  await w.settle();
  expect(w.frame()).toMatch(/^› .*Owner ask ship-it/m); // no row has it: the first stays selected
  v.unmount();
  w.unmount();
});

test("find selects the Tasks & PRD row whose id is it, or whose title has it", async () => {
  const byId = drawTasks(tasksProps({ find: "370" }));
  await byId.settle();
  expect(byId.frame()).toMatch(/^› #370/m);
  const byTitle = drawTasks(tasksProps({ find: "tmux" }));
  await byTitle.settle();
  expect(byTitle.frame()).toMatch(/^› #362/m);
  byId.unmount();
  byTitle.unmount();
});

test("find in a document view scrolls so the first line that has it is at the top, when the document is longer than the screen", async () => {
  const usage: Row = { repo: "work", cap: 40, path: ".claude/factory/lessons.md", lessons: ["a lesson"],
    tasks: Array.from({ length: 40 }, (_, i) => ({ task: String(100 + i), agent: i === 33 ? "needle-agent" : "haile", budget: 1000, used: 10, top: "reviewer" })) };
  const plain = drawDoc("usage", { cols: 100, rows: 8, color: false, data: usage, load: () => Promise.resolve(usage) });
  await plain.settle();
  expect(plain.frame()).not.toContain("needle-agent");
  const v = drawDoc("usage", { cols: 100, rows: 8, color: false, data: usage, load: () => Promise.resolve(usage), find: "NEEDLE-agent" });
  await v.settle();
  const f = v.frame();
  fits(f, 100, 8);
  expect(f.split("\n")[0]).toContain("needle-agent");
  plain.unmount();
  v.unmount();
});

test("find in a document that fits the screen changes nothing", async () => {
  const usage: Row = { repo: "work", cap: 40, path: "p", lessons: ["a lesson"], tasks: [{ task: "1", agent: "haile", budget: 1, used: 1, top: "x" }] };
  const a = drawDoc("usage", { cols: 100, rows: 60, color: false, data: usage, load: () => Promise.resolve(usage) });
  const b = drawDoc("usage", { cols: 100, rows: 60, color: false, data: usage, load: () => Promise.resolve(usage), find: "haile" });
  await a.settle();
  await b.settle();
  expect(b.frame()).toBe(a.frame());
  a.unmount();
  b.unmount();
});

// --- the sidebar -------------------------------------------------------------------------------------------------------

const VIEWS = [{ key: "1", title: "Needs you" }, { key: "2", title: "Pull requests" }, { key: "3", title: "Tasks & PRD" }];
const SESSIONS = [{ name: "haile", state: "idle", kind: "coding agent", where: "this machine", source: "local", machine: "aaaa1111", expected: true }];

test("sidebar: / asks for the search, and the list's help names the key", async () => {
  const s = sidebarOf({ snapshot: { sessions: SESSIONS, needsYou: [] }, views: VIEWS }, 60, 30);
  expect(s.frame()).toContain("/ search");
  await s.press("/");
  expect(s.calls).toEqual(["search"]);
  s.unmount();
});

// --- through factory ---------------------------------------------------------------------------------------------------

interface Proj { d: string; root: string; env: Record<string, string | undefined>; xdg: string }

function project(gh = "#!/usr/bin/env bash\necho '[]'\n"): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, prd: "docs/PRD.md" }));
  write(join(root, "bin", "gh"), gh, 0o755);
  write(join(root, "bin", "tmux"), "#!/usr/bin/env bash\nfor a in \"$@\"; do [ \"$a\" = -V ] && { echo 'tmux 3.4'; exit 0; }; done\nexit 0\n", 0o755);
  const xdg = join(root, "state");
  const env = envWith(join(root, "bin"), { XDG_STATE_HOME: xdg, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, CLAUDECODE: undefined,
    FACTORY_CONFIG_DIR: undefined, TMUX: undefined, COLUMNS: "120", LINES: "40", NO_COLOR: "1" });
  return { d, root, env, xdg };
}

const SNAP: Row = {
  needsYou: [{ kind: "owner-ask", id: "ship-it", issue: 77, url: "https://github.com/o/r/issues/77#c1", ageMinutes: 8, state: "owner" }],
  pulls: [
    { number: 12, title: "Task 7: the zebrafish importer", branch: "task/12-importer", url: "https://github.com/o/r/pull/12", ci: { state: "green" },
      next: { action: "review", text: "review" } },
    { number: 13, title: "Task 8: the exporter", branch: "task/13-exporter", url: "https://github.com/o/r/pull/13", ci: { state: "green" },
      next: { action: "review", text: "review" } },
  ],
  sessions: [{ name: "kassandra", kind: "coding agent", state: "idle", detail: "no ready task", task: null, source: "local", machineName: "dev-pc",
    session: "work-kassandra" }],
  ci: { mode: "local", repo: "o/work", label: "work-local", instances: [], runs: [], runners: [], light: { label: "work-light", runners: [] },
    queuedLong: { count: 0 }, errors: [] },
  doctor: { ok: 30, fixes: 1, notes: 0, summary: "1 to fix.", fix: ["gh login has admin rights: use a second account with Write"] },
  version: { installed: "0.2.4", source: "release" },
  missing: [],
};

function seed(p: Proj, snap: Row): void {
  write(join(p.xdg, "work-factory", "cockpit.json"), JSON.stringify({ ...snap, generatedAt: new Date().toISOString() }));
}

function cockpit(p: Proj, args: string[], extra: Record<string, string | undefined> = {}) {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: { ...p.env, ...extra }, timeoutMs: 60_000 });
}

test("factory cockpit --search finds a term in the cache and names the view of each row", () => {
  const p = project();
  seed(p, SNAP);
  const cases: Array<[string, RegExp, string]> = [
    ["zebrafish", /^2 Pull requests$/m, "zebrafish importer"],
    ["kassandra", /^5 \S/m, "kassandra"],
    ["tasks.source", /^6 \S/m, "tasks.source"],
    ["admin rights", /^7 \S/m, "gh login has admin rights"],
    ["ship-it", /^1 Needs you$/m, "ship-it"],
  ];
  for (const [term, heading, row] of cases) {
    const r = cockpit(p, ["--search", term]);
    expect(r.code, `${term}\n${r.out}`).toBe(0);
    expect(r.stdout, term).not.toContain("\x1b");
    expect(r.stdout, term).toMatch(heading);
    expect(r.stdout, term).toContain(row);
    expect(r.stdout, term).toMatch(new RegExp(`^Search: ${term.replace(/\./g, "\\.")}$`, "m"));
  }
}, 180_000);

test("factory cockpit --search gives rows from at least three views for a term that is in several, each under its own heading", () => {
  const p = project();
  seed(p, { ...SNAP, sessions: [{ ...(SNAP.sessions as Row[])[0], name: "importer-agent" }] });
  const r = cockpit(p, ["--search", "importer"]);
  expect(r.code, r.out).toBe(0);
  const heads = r.stdout.split("\n").filter((l) => /^\d \S/.test(l));
  expect(heads.length, r.stdout).toBeGreaterThanOrEqual(2);
  const all = cockpit(p, ["--search"]);
  expect(all.code, all.out).toBe(0);
  const keys = all.stdout.split("\n").filter((l) => /^\d \S/.test(l)).map((l) => l[0]);
  expect(keys.length, all.stdout).toBeGreaterThanOrEqual(3);
  expect([...keys]).toEqual([...keys].sort());
}, 120_000);

test("factory cockpit --search --in 2 limits the search to the Pull requests", () => {
  const p = project();
  seed(p, SNAP);
  const r = cockpit(p, ["--search", "--in", "2", "task"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/^2 Pull requests$/m);
  expect(r.stdout).toContain("Task 7");
  expect(r.stdout).not.toMatch(/^[13-8] \S/m);
  expect(r.stdout).not.toContain("tasks.source");
}, 60_000);

test("factory cockpit --search says No match, and is sized by COLUMNS", () => {
  const p = project();
  seed(p, SNAP);
  const none = cockpit(p, ["--search", "qqqqzzzz"]);
  expect(none.code, none.out).toBe(0);
  expect(none.stdout).toContain("No match");
  for (const cols of [40, 140]) {
    const r = cockpit(p, ["--search", "task"], { COLUMNS: String(cols) });
    expect(r.code, r.out).toBe(0);
    for (const l of r.stdout.trimEnd().split("\n")) expect([...l].length, l).toBeLessThanOrEqual(cols);
  }
}, 120_000);

test("factory cockpit --search reads the lessons file", () => {
  const p = project();
  seed(p, SNAP);
  write(join(p.d, ".claude", "factory", "lessons.md"), "# Lessons\n\n- Always rinse the flamingo before the review.\n");
  const r = cockpit(p, ["--search", "flamingo"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("flamingo");
  expect(r.stdout).toMatch(/^8 \S/m);
}, 60_000);

test("a search makes no GitHub call at all", () => {
  const calls = join(tmp(), "gh-calls.txt");
  const gh = `#!/usr/bin/env bash\necho "$@" >> ${calls}\necho '[]'\n`;
  const p = project(gh);
  seed(p, SNAP);
  for (const args of [["--search", "importer"], ["--search"], ["--search", "--in", "2", "task"], ["--search", "qqqqzzzz"]]) {
    const r = cockpit(p, args);
    expect(r.code, r.out).toBe(0);
  }
  expect(existsSync(calls) ? readFileSync(calls, "utf8") : "", "gh was called").toBe("");
}, 120_000);

test("the tmux config binds / to the search in a popup", async () => {
  const p = project();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...p.env, NO_COLOR: undefined })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit"], { cwd: p.d, env, terminal: { cols: 120, rows: 40, data() {} } });
  const timer = setTimeout(() => proc.kill(9), 50_000);
  await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  const conf = readFileSync(join(p.xdg, "work-factory", "cockpit.tmux.conf"), "utf8");
  const bind = conf.split("\n").find((l) => l.startsWith("bind / ")) ?? "";
  expect(bind).toContain("cockpit --search");
  expect(bind).toContain("popup");
}, 60_000);

test("factory help and the wiki's commands page list the search and its keys", () => {
  const p = project();
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/cockpit --search\s+\S/);
  const wiki = readFileSync(join(WIKI, "commands.md"), "utf8");
  expect(wiki).toContain("`factory cockpit --search`");
  expect(wiki).toContain("C-a /");
  expect(wiki).toMatch(/`\/`/);
  expect(wiki).toContain("Esc");
}, 60_000);
