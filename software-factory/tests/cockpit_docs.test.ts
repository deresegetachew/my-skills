// The rest of the cockpit's views on Ink (#367, decision 0002): CI, Settings, Usage & lessons, Agents & machines and
// Health & releases (each one document), Tasks & PRD, and the command bar. Each is drawn with ink-testing-library from
// fixed data at a narrow and a wide size, with and without colour, with its keys (j k, r, q). Then, through `factory`:
// off a terminal each view prints one frame within its time limit, the tmux config opens each view on Ink, and the bar's
// resolver keeps the commands the cockpit never offers out.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BarProps, type DocName, drawBar, drawDoc, drawTasks, type Outcome, type TasksProps } from "../cockpit/testing.tsx";
import { CI, copyHookFolders, envWith, gitRepo, HOOKS, SF, sh, tmp, WIKI, write } from "./support.ts";

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-10-31T12:00:00Z");
const ESC = /\x1b\[/;

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function fits(frame: string, cols: number, rows: number): void {
  const all = strip(frame).split("\n");
  expect(all.length, frame).toBeLessThanOrEqual(rows);
  for (const l of all) expect([...l].length, l).toBeLessThanOrEqual(cols);
}

// --- fixed data --------------------------------------------------------------------------------------------------------

const CI_PART: Row = {
  mode: "local", repo: "o/work", label: "work-local",
  instances: [{ id: "1", name: "work-ci", state: "running" }, { id: "2", name: "work-ci-2", state: "loop_down" }],
  runs: [
    { ref: "main", branch: "main", state: "in_progress", name: "CI", minutesAgo: 4 },
    { ref: "#445", branch: "task/445-x", state: "failure", name: "CI", minutesAgo: 900 },
  ],
  runners: [{ name: "work-ci-dev-pc-1", status: "online", busy: true }, { name: "work-ci-old-7", status: "offline", busy: false }],
  light: { label: "work-light", runners: [] },
  queuedLong: { count: 0 },
  errors: [],
};

const SNAP: Row = {
  generatedAt: "2026-10-31T11:50:00Z",
  ci: CI_PART,
  sessions: [
    { name: "fasil", kind: "dev manager", state: "working", detail: "reviewing", task: "380", source: "local", machineName: "dev-pc",
      session: "work-fasil" },
    { name: "haile", kind: "coding agent", state: "idle", detail: "no ready task", task: null, source: "local", machineName: "dev-pc",
      session: "work-haile" },
    { name: "taytu", kind: "coding agent", state: "down", detail: "down", task: "410", source: "github", machineName: "mac", where: "mac" },
  ],
  doctor: { ok: 30, fixes: 1, notes: 2, summary: "1 to fix.", fix: ["gh login has admin rights: use a second account with Write"] },
  version: { installed: "0.2.4", source: "release" },
  missing: [],
};

const SETTINGS: Row = {
  repo: "o/work", host: "dev-pc",
  sections: [{ name: "Tasks", rows: [
    { key: "tasks.source", owner: true, value: "issues", from: "main", pending: false, help: "where the tasks come from" },
    { key: "budget.builder", owner: false, value: "300000", from: "your change", pending: true, help: "a builder's token budget" },
  ] }],
  machine: [{ key: "ci.runners", owner: false, value: "2", from: "this machine", pending: false, help: "heavy runners here" }],
  staged: { problem: "", changes: [{ key: "\"budget.builder\"", was: null, now: "300000" }] },
};

const USAGE: Row = {
  repo: "work", cap: 40, path: ".claude/factory/lessons.md", lessons: ["Run the tests before the PR."],
  tasks: [
    { task: "367", agent: "haile", budget: 1_000_000, used: 850_000, top: "reviewer" },
    { task: "366", agent: "taytu", budget: null, used: 20_000, top: "—" },
  ],
};

/** What each document view shows of its data, and the second read's data with what that shows. */
const DOCS: Record<DocName, { data: Row; want: string[]; again: Row; shows: string }> = {
  ci: { data: SNAP, want: ["WHERE JOBS RUN", "HEAVY RUNNERS ON DEV-PC", "2 wanted · from this machine", "1 offline runner",
    "work-ci-dev-pc-1", "running a job", "Queue and recent runs", "factory ci log"],
  again: { ...SNAP, ci: { ...CI_PART, runners: [] } }, shows: "No runner has the label work-local" },
  settings: { data: SETTINGS, want: ["PROJECT (via PR)", "tasks.source", "◆", "300000 (pending)", "THIS MACHINE (direct) · dev-pc",
    "1 project change waiting", "+ \"budget.builder\": 300000", "factory settings pr"],
  again: { ...SETTINGS, staged: { problem: "", changes: [] } }, shows: "No project changes waiting." },
  usage: { data: USAGE, want: ["Usage and lessons", "#367", "haile", "85%", "reviewer", "Lessons", "1 of 40", "Run the tests before the PR."],
  again: { ...USAGE, tasks: [] }, shows: "No task on this machine in the last 7 days." },
  agents: { data: SNAP, want: ["dev-pc", "this machine", "fasil", "dev manager", "working", "reviewing · #380", "mac", "taytu", "1 down"],
  again: { ...SNAP, sessions: [] }, shows: "No sessions on any machine." },
  health: { data: SNAP, want: ["Doctor", "30 ok", "1 to fix", "2 notes", "gh login has admin rights", "Factory version", "v0.2.4",
    "from the release pin"],
  again: { ...SNAP, doctor: { ok: 31, fixes: 0, notes: 2, summary: "All the checks pass.", fix: [] } }, shows: "All the checks pass." },
};

const NAMES = Object.keys(DOCS) as DocName[];

// --- the document views ------------------------------------------------------------------------------------------------

for (const name of NAMES) {
  const d = DOCS[name];

  test(`${name}: wide and plain, every part of its board, no escape sequence, the keys last`, async () => {
    const v = drawDoc(name, { cols: 140, rows: 60, color: false, data: d.data, load: () => Promise.resolve(d.data), now: NOW });
    await v.settle();
    const f = v.frame();
    v.unmount();
    fits(f, 140, 60);
    expect(f).not.toMatch(ESC);
    for (const s of d.want) expect(f, s).toContain(s);
    expect(f.split("\n").at(-1)).toBe("j k scroll · r read again · q close");
  });

  test(`${name}: narrow and coloured, it still fits and only the colour changes`, async () => {
    const plain = drawDoc(name, { cols: 40, rows: 200, color: false, data: d.data, load: () => Promise.resolve(d.data), now: NOW });
    const coloured = drawDoc(name, { cols: 40, rows: 200, color: true, data: d.data, load: () => Promise.resolve(d.data), now: NOW });
    await coloured.settle();
    const [p, c] = [plain.frame(), coloured.frame()];
    plain.unmount();
    coloured.unmount();
    fits(c, 40, 200);
    expect(c).toMatch(ESC);
    expect(p).not.toMatch(ESC);
    expect(strip(c)).toBe(p);
  });

  test(`${name}: j and k scroll a screenful, r reads again, q closes and later keys do nothing`, async () => {
    let reads = 0;
    const load = () => {
      reads++;
      return Promise.resolve(d.again);
    };
    const v = drawDoc(name, { cols: 100, rows: 6, color: false, data: d.data, load, now: NOW });
    await v.settle();
    const first = v.frame();
    fits(first, 100, 6);
    await v.press("j");
    const down = v.frame();
    expect(down).not.toBe(first);
    expect(down.split("\n")[0]).toBe(first.split("\n")[1]);
    await v.press("k");
    expect(v.frame()).toBe(first);
    await v.press("r");
    await v.settle();
    expect(reads).toBe(1);
    const all = drawDoc(name, { cols: 100, rows: 200, color: false, data: d.again, load, now: NOW });
    await all.settle();
    expect(all.frame()).toContain(d.shows);
    all.unmount();
    await v.press("q");
    const after = v.frame();
    await v.press("r");
    expect(reads).toBe(1);
    expect(v.frame()).toBe(after);
    v.unmount();
  });
}

test("a document view with no data yet reads it, and q closes even while it reads", async () => {
  let reads = 0;
  const v = drawDoc("ci", { cols: 100, rows: 20, color: false, load: () => {
    reads++;
    return new Promise(() => {}); // never answers
  } });
  await v.settle();
  expect(reads).toBe(1);
  expect(v.frame()).toContain("Reading the snapshot…");
  await v.press("q");
  await v.press("r");
  expect(reads).toBe(1);
  v.unmount();
});

test("the snapshot views say when there is no snapshot yet, or it took too long", async () => {
  for (const name of ["ci", "agents", "health"] as DocName[]) {
    for (const [got, text] of [[null, "No snapshot yet: `factory cockpit --json` reads one now."], ["late", "took too long"]] as const) {
      const v = drawDoc(name, { cols: 120, rows: 20, color: false, data: got, load: () => Promise.resolve(null) });
      await v.settle();
      expect(v.frame(), `${name} ${String(got)}`).toContain(text);
      v.unmount();
    }
  }
});

test("text from GitHub or a log can't drive the terminal in any document view", async () => {
  const evil = "x\x1b]0;owned\x07\x1b[2J\x9b31m";
  const data: Record<DocName, Row> = {
    ci: { ...SNAP, ci: { ...CI_PART, runners: [{ name: evil, status: "online", busy: false }] } },
    settings: { ...SETTINGS, repo: evil },
    usage: { ...USAGE, lessons: [evil] },
    agents: { ...SNAP, sessions: [{ name: evil, kind: "coding agent", state: "idle", detail: evil, source: "local" }] },
    health: { ...SNAP, doctor: { ok: 1, fixes: 1, notes: 0, summary: "1 to fix.", fix: [evil] } },
  };
  for (const name of NAMES) {
    const v = drawDoc(name, { cols: 120, rows: 80, color: false, data: data[name], load: () => Promise.resolve(null), now: NOW });
    await v.settle();
    const f = v.frame();
    v.unmount();
    expect(f, name).not.toContain("\x1b");
    expect(f, name).not.toContain("\x07");
    expect(f, name).not.toContain("\x9b");
  }
});

// --- the Tasks & PRD view ----------------------------------------------------------------------------------------------

const TASKS: Row = {
  source: "issues", prd: "software-factory/docs/PRD.md",
  tasks: [
    { id: "362", title: "Real tmux tests", state: "new", holders: [], group: "", todos: [] },
    { id: "367", title: "Cockpit on Ink: the views", state: "in-progress", holders: ["haile"], group: "cockpit",
      todos: [{ done: true }, { done: false }] },
    { id: "300", title: "An old one", state: "done", holders: [], group: "", todos: [] },
    { id: "370", title: "Waits on the owner", state: "blocked", holders: [], group: "", todos: [] },
  ],
};

function tasksProps(o: Partial<TasksProps> = {}): TasksProps {
  return { repo: "work", cols: 140, rows: 30, color: false, limitSeconds: 20, load: () => Promise.resolve(TASKS), ...o };
}

test("tasks, wide and plain: the lanes, the tasks in lane order, the first one's detail, the keys last", async () => {
  const v = drawTasks(tasksProps());
  await v.settle();
  const f = v.frame();
  v.unmount();
  fits(f, 140, 30);
  expect(f).not.toMatch(ESC);
  const lines = f.split("\n");
  expect(lines[0]).toMatch(/^factory {2}work · Tasks and PRD\s+factory issues list · factory next$/);
  expect(f).toContain("in progress 1 · in review 0 · ready 0 · blocked 1 · not ready 1 · done 1");
  expect(f).toContain("PRD: software-factory/docs/PRD.md");
  expect(f).toContain("No task is ready, so the coding agents wait for one.");
  const rows = lines.filter((l) => /^(›| ) #\d+/.test(l));
  expect(rows.map((l) => /#(\d+)/.exec(l)?.[1])).toEqual(["367", "370", "362", "300"]);
  expect(rows[0]).toMatch(/^› #367\s+Cockpit on Ink: the views\s+in progress\s+haile$/);
  expect(f).toContain("#367 · Cockpit on Ink: the views");
  expect(f).toContain("in progress · held by haile · cockpit · 1 of 2 todos done");
  expect(f).toContain("factory issues show 367 --comments");
  expect(lines.at(-1)).toBe("j k move · r read again · q close");
});

test("tasks, narrow and coloured: it fits, and only the colour changes", async () => {
  const p = drawTasks(tasksProps({ cols: 40, rows: 16 }));
  const c = drawTasks(tasksProps({ cols: 40, rows: 16, color: true }));
  await c.settle();
  const [pf, cf] = [p.frame(), c.frame()];
  p.unmount();
  c.unmount();
  fits(cf, 40, 16);
  expect(cf).toMatch(ESC);
  expect(strip(cf)).toBe(pf);
});

test("tasks: j and k move, r reads again, q closes and later keys do nothing", async () => {
  let reads = 0;
  const v = drawTasks(tasksProps({ load: () => {
    reads++;
    return Promise.resolve(reads === 1 ? TASKS : { ...TASKS, tasks: [] });
  } }));
  await v.settle();
  await v.press("j");
  expect(v.frame()).toMatch(/^› #370/m);
  expect(v.frame()).toContain("#370 · Waits on the owner");
  await v.press("j");
  await v.press("j");
  await v.press("j");
  expect(v.frame()).toMatch(/^› #300/m);
  await v.press("k");
  expect(v.frame()).toMatch(/^› #362/m);
  await v.press("r");
  await v.settle();
  expect(reads).toBe(2);
  expect(v.frame()).toContain("No tasks yet.");
  await v.press("q");
  await v.press("r");
  expect(reads).toBe(2);
  v.unmount();
});

test("tasks: a read that failed, or ran out of time, says so and what to run", async () => {
  for (const [got, text] of [[{ source: "issues", error: "gh: not logged in" }, "Can't read the tasks (gh: not logged in)."],
    ["late", "Can't read the tasks in 20 s"], [null, "Can't read the tasks: run `factory next` to see why."]] as const) {
    const v = drawTasks(tasksProps({ load: () => Promise.resolve(got) }));
    await v.settle();
    expect(v.frame()).toContain(text);
    v.unmount();
  }
});

// --- the command bar ---------------------------------------------------------------------------------------------------

interface BarRun {
  props: BarProps;
  outcome: () => Outcome | null;
  resolved: Array<[string, string]>;
  acted: string[][];
}

function barRun(o: Partial<BarProps> = {}, answer?: (typed: string, pick: string) => ReturnType<BarProps["resolve"]>): BarRun {
  let ended: Outcome | null = null;
  const resolved: Array<[string, string]> = [];
  const acted: string[][] = [];
  const props: BarProps = {
    prefill: "", cols: 100, rows: 20, color: false,
    resolve: (typed, pick) => {
      resolved.push([typed, pick]);
      if (answer) return answer(typed, pick);
      const words = (pick || typed).trim().split(/\s+/);
      const line = typed.trim() || pick;
      const action = line.startsWith("owner") || line.startsWith("say") ? words.slice(0, line.startsWith("say") ? 1 : 2).join(" ") : null;
      return Promise.resolve({ words, action, question: action ? `Run \`factory ${typed.trim()}\`? It changes GitHub. [y/N] ` : "",
        run: ["bash", "/f/factory", ...(action ? typed.trim().split(/\s+/) : words)] });
    },
    act: (run) => {
      acted.push(run);
      return Promise.resolve("merged #12");
    },
    finish: (x) => {
      ended = x;
    },
    ...o,
  };
  return { props, outcome: () => ended, resolved, acted };
}

test("bar: typing fuzzy-matches the offered commands, the best first, and never offers what the agents use", async () => {
  const b = barRun();
  const v = drawBar(b.props);
  await v.settle();
  let f = v.frame();
  fits(f, 100, 20);
  expect(f.split("\n")[0]).toBe("factory");
  expect(f).toContain("Type to pick · ↑↓ · Enter runs it (an action asks first) · Esc closes");
  expect(f).toMatch(/^› status$/m);
  await v.press("vers");
  f = v.frame();
  expect(f.split("\n")[0]).toBe("factory vers");
  expect(f).toMatch(/^› version$/m);
  await v.press("\x7f\x7f\x7f\x7f");
  await v.press("ownmrg");
  expect(v.frame()).toMatch(/^› owner merge$/m);
  for (const word of ["review-pass", "run-check", "rereview", "manager-claims", "guard"]) {
    await v.press("\x7f".repeat(20));
    await v.press(word);
    expect(v.frame(), word).not.toMatch(new RegExp(`^[› ] ${word}$`, "m"));
  }
  v.unmount();
});

test("bar: narrow and coloured, it fits and only the colour changes", async () => {
  const p = drawBar(barRun({ cols: 30, rows: 10, prefill: "ci " }).props);
  const c = drawBar(barRun({ cols: 30, rows: 10, prefill: "ci ", color: true }).props);
  await c.settle();
  const [pf, cf] = [p.frame(), c.frame()];
  p.unmount();
  c.unmount();
  fits(cf, 30, 10);
  expect(cf).toMatch(ESC);
  expect(strip(cf)).toBe(pf);
});

test("bar: ↑ ↓ pick a match, and Enter on a read-only command closes the bar to page it", async () => {
  const b = barRun({ prefill: "ci " });
  const v = drawBar(b.props);
  await v.settle();
  expect(v.frame()).toMatch(/^› ci log$/m);
  await v.press("\x1b[B");
  const picked = /^› (.+)$/m.exec(v.frame())?.[1] ?? "";
  expect(picked).not.toBe("ci log");
  await v.press("\r");
  await v.settle();
  expect(b.resolved).toEqual([["ci ", picked]]);
  expect(b.outcome()).toEqual({ kind: "page", run: ["bash", "/f/factory", ...picked.split(" ")] });
  v.unmount();
});

test("bar: an action asks first; y runs it and shows its output, and the next key closes", async () => {
  const b = barRun({ prefill: "owner merge 12" });
  const v = drawBar(b.props);
  await v.settle();
  await v.press("\r");
  await v.settle();
  expect(v.frame()).toContain("Run `factory owner merge 12`? It changes GitHub. [y/N]");
  expect(v.frame()).toContain("y runs it · any other key does nothing");
  expect(b.acted).toEqual([]);
  await v.press("y");
  await v.settle();
  expect(b.acted).toEqual([["bash", "/f/factory", "owner", "merge", "12"]]);
  expect(v.frame()).toContain("merged #12");
  expect(b.outcome()).toBeNull();
  await v.press("x");
  expect(b.outcome()).toEqual({ kind: "closed" });
  v.unmount();
});

test("bar: any answer but y runs nothing", async () => {
  const b = barRun({ prefill: "owner merge 12" });
  const v = drawBar(b.props);
  await v.settle();
  await v.press("\r");
  await v.settle();
  await v.press("n");
  expect(v.frame()).toContain("Not run: nothing changed.");
  expect(b.acted).toEqual([]);
  v.unmount();
});

test("bar: a refused line shows its message and fix, and the next key closes with the refusal", async () => {
  const refusal = { code: "cockpit_not_offered", message: "`factory review-pass` is for the agents and the gate.", fix: "Leave it to them." };
  const b = barRun({ prefill: "review-pass" }, () => Promise.resolve(refusal));
  const v = drawBar(b.props);
  await v.settle();
  await v.press("\r");
  await v.settle();
  expect(v.frame()).toContain("`factory review-pass` is for the agents and the gate.");
  expect(v.frame()).toContain("fix: Leave it to them.");
  await v.press("x");
  expect(b.outcome()).toEqual({ kind: "refused", problem: refusal });
  v.unmount();
});

test("bar: Esc closes without running anything", async () => {
  const b = barRun({ prefill: "status" });
  const v = drawBar(b.props);
  await v.settle();
  await v.press("\x1b");
  await Bun.sleep(80); // Ink waits a moment to tell Esc from an arrow key
  expect(b.outcome()).toEqual({ kind: "closed" });
  expect(b.resolved).toEqual([]);
  v.unmount();
});

// --- through factory -------------------------------------------------------------------------------------------------

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
    FACTORY_CONFIG_DIR: undefined, TMUX: undefined, COLUMNS: "120", LINES: "30", NO_COLOR: "1" });
  return { d, root, env, xdg };
}

function seed(p: Proj, snap: Row): void {
  write(join(p.xdg, "work-factory", "cockpit.json"), JSON.stringify({ ...snap, generatedAt: new Date().toISOString() }));
}

function cockpit(p: Proj, args: string[], extra: Record<string, string | undefined> = {}) {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: { ...p.env, ...extra }, timeoutMs: 60_000 });
}

test("factory cockpit --agents and --health off a terminal print the view from the cache, sized by COLUMNS", () => {
  const p = project();
  seed(p, SNAP);
  for (const [flag, want] of [["--agents", ["Agents and machines", "fasil", "reviewing · #380", "taytu"]],
    ["--health", ["Health and releases", "30 ok", "gh login has admin rights", "v0.2.4"]]] as const) {
    for (const cols of [40, 140]) {
      const r = cockpit(p, [flag], { COLUMNS: String(cols) });
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).not.toContain("\x1b");
      for (const s of want) expect(r.stdout, `${flag} ${s}`).toContain(s);
      for (const l of r.stdout.trimEnd().split("\n")) expect([...l].length, l).toBeLessThanOrEqual(cols);
    }
  }
}, 120_000);

test("factory cockpit --tasks off a terminal prints one frame within the time limit when GitHub never answers", () => {
  const p = project("#!/usr/bin/env bash\nsleep 90 &\nwait\n");
  const started = Date.now();
  const r = cockpit(p, ["--tasks"]);
  const took = (Date.now() - started) / 1000;
  expect(r.code, r.out).toBe(0);
  expect(took, r.out).toBeLessThan(40);
  expect(r.stdout).toContain("Can't read the tasks in 20 s");
  expect(r.stdout).toContain("q close");
}, 90_000);

test("factory cockpit --view-data tasks reads the build plan in plan mode", () => {
  const p = project();
  write(join(p.d, ".claude", "factory.json"), JSON.stringify({ plan: "docs/BUILD_PLAN.md" }));
  write(join(p.d, "docs", "BUILD_PLAN.md"), "# Plan\n\n## Phase 1\n\n- [x] **1.1 The first task**\n- [ ] **1.2 The second task**\n");
  const r = cockpit(p, ["--view-data", "tasks"]);
  expect(r.code, r.out).toBe(0);
  const data = JSON.parse(r.stdout) as { source: string; tasks: Row[] };
  expect(data.source).toBe("plan");
  expect(data.tasks.map((t) => [t.id, t.state])).toEqual([["1.2", "ready"]]); // the tracker lists what is not done
  const bad = cockpit(p, ["--view-data", "nope"]);
  expect(bad.code).toBe(2);
  expect(JSON.parse(bad.stderr.trim().split("\n").pop() ?? "{}").code).toBe("cockpit_usage");
}, 60_000);

test("the bar's resolver: a prefix runs its command, an action names its question, the agents' commands are refused", () => {
  const p = project();
  const read = cockpit(p, ["--bar-resolve", "vers", "version"]);
  expect(read.code, read.out).toBe(0);
  const r = JSON.parse(read.stdout) as Row;
  expect(r.words).toEqual(["version"]);
  expect(r.action).toBeNull();
  expect((r.run as string[]).slice(-1)).toEqual(["version"]);
  const act = JSON.parse(cockpit(p, ["--bar-resolve", "say haile hello there", "say"]).stdout) as Row;
  expect(act.action).toBe("say");
  expect(String(act.question)).toContain("Run `factory say haile hello there`? It changes a session");
  expect((act.run as string[]).slice(-3)).toEqual(["say", "haile", "hello there"]);
  for (const line of ["review-pass", "claims release --agent taytu"]) {
    const no = cockpit(p, ["--bar-resolve", line, ""]);
    expect(no.code, line).toBe(2);
    expect(JSON.parse(no.stderr.trim().split("\n").pop() ?? "{}").code, line).toBe("cockpit_not_offered");
  }
}, 60_000);

/** `factory cockpit <args>` on a pseudo-terminal with CI set (as on GitHub Actions): waits until `ready` is shown, types
 *  `keys`, and gives the exit code and everything shown. */
async function onATerminal(p: Proj, args: string[], ready: RegExp, keys: string[]): Promise<[number, string, boolean]> {
  let shown = "";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...p.env, CI: "true" })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", ...args], {
    cwd: p.d, env, terminal: { cols: 120, rows: 30, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 40_000);
  for (let i = 0; i < 300 && !ready.test(strip(shown)); i++) await Bun.sleep(100);
  const drawn = ready.test(strip(shown));
  for (const k of keys) {
    proc.terminal?.write(k);
    await Bun.sleep(300);
  }
  const code = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  return [code, shown, drawn];
}

test("on a terminal with CI set, a document view is drawn before any key, j scrolls and q closes it", async () => {
  const p = project();
  seed(p, SNAP);
  const [code, shown, drawn] = await onATerminal(p, ["--health"], /30 ok/, ["j", "q"]);
  expect(drawn, shown).toBe(true);
  expect(code, shown).toBe(0);
}, 60_000);

test("on a terminal the bar shows a refusal with its fix, and the next key closes it with the refusal's exit code", async () => {
  const p = project();
  const [code, shown, drawn] = await onATerminal(p, ["--bar"], /Type to pick/, ["review-pass", "\r", "x"]);
  expect(drawn, shown).toBe(true);
  expect(strip(shown)).toContain("is for the agents and the gate");
  expect(code, shown).toBe(2);
}, 60_000);

test("the cockpit opens every view on Ink: 3, 5 and 7 run their own views, and only Settings goes through less", async () => {
  const p = project();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...p.env, NO_COLOR: undefined })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit"], { cwd: p.d, env, terminal: { cols: 120, rows: 40, data() {} } });
  const timer = setTimeout(() => proc.kill(9), 50_000);
  await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  const conf = readFileSync(join(p.xdg, "work-factory", "cockpit.tmux.conf"), "utf8");
  const bind = (k: string) => conf.split("\n").find((l) => l.startsWith(`bind ${k} `)) ?? "";
  for (const [k, flag] of [["1", "--needs"], ["2", "--prs"], ["3", "--tasks"], ["4", "--ci"], ["5", "--agents"], ["7", "--health"],
    ["8", "--usage"]] as const) {
    expect(bind(k), k).toContain(`cockpit ${flag}`);
    expect(bind(k), k).not.toContain("less");
  }
  expect(bind("6")).toContain("less -R");
}, 60_000);

test("factory help and the wiki's commands page list the new views", () => {
  const p = project();
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  const wiki = readFileSync(join(WIKI, "commands.md"), "utf8");
  for (const flag of ["--tasks", "--agents", "--health"]) {
    expect(r.stdout).toMatch(new RegExp(`cockpit ${flag}\\s+\\S`));
    expect(wiki).toContain(`\`factory cockpit ${flag}\``);
  }
}, 60_000);
