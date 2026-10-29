// The cockpit's usage view (#341, PRD US-13): `factory cockpit --usage` draws the Usage and lessons board from this
// machine's Claude Code logs and the lessons file: each task against its budget as a bar, the agent and the subagent
// that spent most, a few figures, and the lessons. It works in a plain terminal, on a narrow one and with no colour,
// and the cockpit's Usage & lessons view (key 8) runs it.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { envWith, gitRepo, HOOKS, SF, sh, tmp, write, WIKI, type Proc } from "./support.ts";

const T = 60_000;
type Env = Record<string, string | undefined>;
interface Proj { d: string; root: string; env: Env; xdg: string; logs: string }

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

function setup(factory: Record<string, unknown> = {}, extra: Env = {}): Proj {
  const root = realpathSync(tmp());
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, ...factory }));
  const bin = join(root, "bin");
  write(join(bin, "gh"), FAKE_GH, 0o755);
  write(join(bin, "tmux"), FAKE_TMUX, 0o755);
  mkdirSync(join(root, "log"));
  const xdg = join(root, "state");
  mkdirSync(xdg);
  const home = join(root, "home");
  const logs = join(home, ".claude", "projects");
  mkdirSync(logs, { recursive: true });
  const env = envWith(bin, { FAKE_LOG: join(root, "log"), XDG_STATE_HOME: xdg, HOME: home,
    XDG_CONFIG_HOME: join(root, "config"), FACTORY_CONFIG_DIR: undefined, FACTORY_AGENT: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined, CLAUDECODE: undefined, TMUX: undefined, NO_COLOR: undefined, TERM: "xterm-256color",
    COLUMNS: "120", ...extra });
  return { d, root, env, xdg, logs };
}

const slugOf = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

function prompt(text: string, cwd: string): string {
  return JSON.stringify({ type: "user", timestamp: hoursAgo(3), cwd, message: { role: "user", content: text } });
}

let ids = 0;
function reply(branch: string, cwd: string, o: { write?: number; out?: number; read?: number; ts?: string } = {}): string {
  ids += 1;
  return JSON.stringify({ type: "assistant", timestamp: o.ts ?? hoursAgo(2), gitBranch: branch, cwd,
    message: { id: `m${ids}`, model: "claude-opus-5-5", usage: { input_tokens: 0, cache_creation_input_tokens: o.write ?? 0,
      cache_read_input_tokens: o.read ?? 0, output_tokens: o.out ?? 0 } } });
}

/** One session's log: its first prompt, its replies on `branch`, and a subagent's replies of each kind. */
function session(p: Proj, o: { agent?: string; id: string; first: string; branch: string; write: number; out: number;
  subs?: Array<[string, number]>; ts?: string }): void {
  const cwd = o.agent ? `${p.d}-agents/${o.agent}` : p.d;
  const dir = join(p.logs, slugOf(cwd));
  write(join(dir, `${o.id}.jsonl`), [prompt(o.first, cwd), reply(o.branch, cwd, { write: o.write, out: o.out, read: 5_000_000, ts: o.ts })]
    .join("\n") + "\n");
  for (const [kind, n] of o.subs ?? []) {
    const sub = join(dir, o.id, "subagents", `agent-${kind}`);
    write(`${sub}.jsonl`, reply("HEAD", cwd, { write: n, ts: o.ts }) + "\n");
    write(`${sub}.meta.json`, JSON.stringify({ agentType: kind }));
  }
}

const BUDGET = (b: string) => `/next-task issue-x\n\nBudget for this task: ${b} tokens, counting fresh input (input + cache ` +
  "writes) + output as `factory usage` reports them (cache reads are not counted).";

/** Task 410 by haile at 61% of 300k (test-writer spent most), 390 in the project folder with no budget, 402 by taytu
 * over its 100k budget. */
function seedTasks(p: Proj): void {
  session(p, { agent: "haile", id: "s410", first: BUDGET("300k"), branch: "task/410-draft", write: 60_000, out: 3_000,
    subs: [["test-writer", 80_000], ["reviewer", 40_000]] });
  session(p, { id: "s390", first: "/next-task issue-390", branch: "task/390-notes", write: 90_000, out: 10_000 });
  session(p, { agent: "taytu", id: "s402", first: BUDGET("100k"), branch: "task/402-ci", write: 100_000, out: 12_000,
    subs: [["reviewer", 0]] });
}

function lessons(p: Proj, lines: string[]): void {
  write(join(p.d, ".claude", "factory", "lessons.md"), `# Lessons\n\nShort rules.\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
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

const rowOf = (t: string, task: string) => t.split("\n").find((l) => l.includes(task)) ?? "";

// --- the board -----------------------------------------------------------------------------------------------------------

test("--usage draws each task against its budget: agent, budget, a bar, the percent and the subagent that spent most", () => {
  const p = setup();
  seedTasks(p);
  lessons(p, ["Run the tests before the PR, e.g. `bun tools/run_tests.ts`.", "A test changed after implementation needs a reason (#435)."]);
  const r = cockpit(p, ["--usage"]);
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  const t = stripAnsi(r.stdout);
  for (const s of ["Usage and lessons", "this machine's logs", "last 7 days", "Tasks against their budget",
    "cache reads not counted", "task", "agent", "budget", "used", "spent most"]) {
    expect(t, s).toContain(s);
  }
  // Fresh input + output against the budget the task was claimed with; cache reads are not counted.
  expect(rowOf(t, "#410")).toMatch(/#410\s+haile\s+300k\s+.*61%.*test-writer/);
  expect(rowOf(t, "#402")).toMatch(/#402\s+taytu\s+100k\s+.*112%.*over/);
  // No budget in its prompt and no budget.builder: no percent.
  expect(rowOf(t, "#390")).toMatch(/#390\s+—\s+none\s+.*—/);
  expect(rowOf(t, "#390")).not.toMatch(/\d+%/);
  // The bar: full for a task over its budget, partly full at 61%, with the glyphs carrying it without colour.
  expect(rowOf(t, "#402")).toContain("██████████");
  expect(rowOf(t, "#410")).toMatch(/█+░+/);
}, T);

test("--usage adds the figures: tasks, budget against used, tasks over budget and tokens per task", () => {
  const p = setup({ budget: { builder: 200_000 } });
  seedTasks(p);
  const r = cockpit(p, ["--usage"]);
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout);
  // With budget.builder, task 390 gets that budget: 100k of 200k is 50%.
  expect(rowOf(t, "#390")).toMatch(/#390\s+—\s+200k\s+.*50%/);
  for (const s of ["tasks", "budget vs used, median", "over budget", "per task, median"]) expect(t, s).toContain(s);
  // The median of 0.50, 0.61 and 1.12.
  expect(t).toContain("0.61");
  // Rework and CI runs are on GitHub: the view names the command instead of asking it.
  expect(t).toContain("factory report");
}, T);

test("--usage shows the lessons, how many of lessonsCap, and where they come from", () => {
  const p = setup({ lessonsCap: 12 });
  seedTasks(p);
  lessons(p, ["Run the tests before the PR, e.g. `bun tools/run_tests.ts`.", "A test changed after implementation needs a reason (#435)."]);
  const r = cockpit(p, ["--usage"]);
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout);
  expect(t).toContain("Lessons");
  expect(t).toMatch(/2 of 12/);
  expect(t).toContain(".claude/factory/lessons.md");
  expect(t).toContain("Run the tests before the PR");
  expect(t).toContain("needs a reason (#435)");
  for (const s of ["factory lessons suggest", "factory lessons add", "factory lessons prune"]) expect(t, s).toContain(s);
}, T);

test("--usage names the commands that act on it", () => {
  const p = setup();
  seedTasks(p);
  const r = cockpit(p, ["--usage"]);
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout);
  for (const s of ["factory usage --by agent", "factory usage --since", "factory usage --task"]) expect(t, s).toContain(s);
}, T);

test("--usage leaves out tasks from before the last 7 days", () => {
  const p = setup();
  seedTasks(p);
  session(p, { agent: "haile", id: "s300", first: BUDGET("300k"), branch: "task/300-old", write: 9_000, out: 1_000, ts: hoursAgo(24 * 20) });
  const r = cockpit(p, ["--usage"]);
  expect(r.code, r.out).toBe(0);
  expect(stripAnsi(r.stdout)).not.toContain("#300");
}, T);

// --- nothing to show -----------------------------------------------------------------------------------------------------

test("--usage with no logs and no lessons file says so and exits 0", () => {
  const p = setup();
  const r = cockpit(p, ["--usage"]);
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  const t = stripAnsi(r.stdout);
  expect(t).toMatch(/No task on this machine in the last 7 days/);
  expect(t).toMatch(/No lessons yet/);
  expect(t).toContain("factory lessons add");
}, T);

// --- a plain terminal: narrow, no colour, nothing that drives the terminal -----------------------------------------------

test("--usage on a narrow terminal keeps every line within its width", () => {
  const p = setup();
  seedTasks(p);
  lessons(p, ["A very long lesson that goes on and on about running the whole test suite before a pull request, e.g. `bun tools/run_tests.ts`."]);
  const r = cockpit(p, ["--usage"], { COLUMNS: "40" });
  expect(r.code, r.out).toBe(0);
  expect(widest(r.stdout)).toBeLessThanOrEqual(40);
  const t = stripAnsi(r.stdout);
  for (const s of ["#410", "#402", "#390", "61%", "112%", "test-writer", "Lessons"]) expect(t, s).toContain(s);
}, T);

test("--usage on a wide terminal stays within its width", () => {
  const p = setup();
  seedTasks(p);
  lessons(p, ["Run the tests before the PR, e.g. `bun tools/run_tests.ts`."]);
  const r = cockpit(p, ["--usage"], { COLUMNS: "160" });
  expect(r.code, r.out).toBe(0);
  expect(widest(r.stdout)).toBeLessThanOrEqual(160);
}, T);

test("--usage with NO_COLOR or a dumb terminal prints no escape sequence; otherwise it colours the bars", () => {
  const p = setup();
  seedTasks(p);
  const coloured = cockpit(p, ["--usage"]);
  expect(coloured.code, coloured.out).toBe(0);
  expect(coloured.stdout).toContain("\x1b[");
  for (const extra of [{ NO_COLOR: "1" }, { TERM: "dumb" }]) {
    const r = cockpit(p, ["--usage"], extra);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain("\x1b");
    expect(r.stdout).toContain("Tasks against their budget");
  }
}, T);

test("--usage prints no control characters from a lesson or a subagent's name", () => {
  const p = setup();
  session(p, { agent: "haile", id: "s5", first: BUDGET("50k"), branch: "task/5-x", write: 1_000, out: 0,
    subs: [["evil\x1b]0;owned\x07", 9_000]] });
  lessons(p, ["Bad \x1b[2J\x1b[31mlesson\x07 e.g. `x`."]);
  const r = cockpit(p, ["--usage"], { NO_COLOR: "1" });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).not.toContain("\x1b");
  expect(r.stdout).not.toContain("\x07");
  expect(r.stdout).toContain("evil");
  expect(r.stdout).toContain("lesson");
}, T);

test("--usage takes nothing after it", () => {
  const p = setup();
  const r = cockpit(p, ["--usage", "extra"]);
  expect(r.code).toBe(2);
  const e = JSON.parse(r.stderr.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  expect(e.code).toBe("cockpit_usage");
  expect(String(e.message)).toContain("--usage");
}, T);

// --- where it shows ------------------------------------------------------------------------------------------------------

test("the cockpit's Usage & lessons view (key 8) runs factory cockpit --usage", async () => {
  const p = setup();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit"], { cwd: p.d, env, terminal: { cols: 120, rows: 40, data() {} } });
  const timer = setTimeout(() => proc.kill(9), 50_000);
  await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  const conf = readFileSync(join(p.xdg, "work-factory", "cockpit.tmux.conf"), "utf8");
  const line = conf.split("\n").find((l) => l.startsWith("bind 8 ")) ?? "";
  expect(line, conf).toContain("cockpit --usage");
}, T);

test("factory help and the wiki's commands page list factory cockpit --usage", () => {
  const p = setup();
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/cockpit --usage\s+\S/);
  expect(readFileSync(join(WIKI, "commands.md"), "utf8")).toContain("`factory cockpit --usage`");
}, T);
