// `factory cockpit --prs` (#338, PRD US-13): the cockpit's Pull requests view, towards its board (VPrs): one row per
// open PR, the selected PR's detail below (head, CI by one rule, the newest marker, reviews, protected paths, next
// action), the keys at the bottom. Its data is `factory prs --json`, here from a fake `gh` that answers from a scenario.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CI, envWith, gitRepo, HOOKS, read, SF, sh, tmp, WIKI, write, type Proc } from "./support.ts";

const T = 120_000;
type Row = Record<string, unknown>;
type Env = Record<string, string | undefined>;
interface Proj { d: string; env: Env; log: string }

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.COCKPIT_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.COCKPIT_LOG as string, a.join(" ") + "\n");
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (s.fail_all) fail("gh: not logged in");
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] !== "api") { console.log("ok"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "POST" && x !== "PATCH" && x !== "Accept: application/vnd.github+json")[0] as string;
const short = raw.replace("repos/{owner}/{repo}/", "").replace(/^repos\/o\/r(\/|$)/, (_m, slash) => slash ? "" : "repo");
const path = new URL(short, "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json" || path.startsWith("actions/variables/")) fail("gh: Not Found (HTTP 404)");
if (path in s) out(s[path]);
if (path.startsWith("issues/") && path.endsWith("/comments")) out([]);
if (path.endsWith("/files")) out([]);
fail("fake gh: no answer for " + path);
`;

const OLD = "2020-01-01T00:00:00Z";

function pr(number: number, title: string, sha: string, ref: string, labels: string[], body = ""): Row {
  return { number, title, draft: false, html_url: `https://github.com/o/r/pull/${number}`, body, head: { sha, ref },
    labels: labels.map((name) => ({ name })) };
}

function green(sha: string): Row {
  return { [`commits/${sha}`]: { commit: { committer: { date: OLD } } },
    [`commits/${sha}/check-runs`]: { check_runs: [{ name: "check", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "success" }] } };
}

/** #12 an agent's protected PR, approved and green; #13 an agent's PR with red CI, a must-fix and an open question;
 *  #14 a person's own PR (no agent, not a task branch), green. */
function scenario(): Row {
  return {
    issues: [],
    pulls: [
      pr(12, "Task 7: the importer", A, "task/7-importer", ["agent:menelik"], "Closes #7\nA person merges this one: CI"),
      pr(13, "Task 8: the exporter", B, "task/8-exporter", ["agent:taytu"], "Closes #8"),
      pr(14, "docs: tidy the readme", C, "docs/readme", []),
    ],
    ...green(A),
    [`commits/${B}`]: { commit: { committer: { date: OLD } } },
    [`commits/${B}/check-runs`]: { check_runs: [{ name: "check", status: "completed", conclusion: "success" },
      { name: "unit shard 2", status: "completed", conclusion: "failure" }] },
    ...green(C),
    "issues/12/comments": [{ body: `<!-- factory-approved sha=${A.slice(0, 12)} -->`, user: { login: "dm" }, created_at: OLD }],
    "issues/13/comments": [
      { body: `<!-- factory-mustfix sha=${B.slice(0, 12)} -->\nfix the shard`, user: { login: "dm" }, created_at: OLD },
      { body: "<!-- factory-question -->\nWhich format?", user: { login: "taytu" }, created_at: OLD,
        html_url: "https://github.com/o/r/pull/13#c2" },
    ],
    repo: { default_branch: "main" },
  };
}

function setup(s: Row = scenario()): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] }));
  write(join(root, "bin", "gh"), FAKE_GH, 0o755);
  write(join(root, "scenario.json"), JSON.stringify(s));
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "home"));
  const log = join(root, "log");
  writeFileSync(log, "");
  const env = envWith(join(root, "bin"), { COCKPIT_SCENARIO: join(root, "scenario.json"), COCKPIT_LOG: log,
    XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENTS: undefined,
    FACTORY_CONFIG_DIR: undefined, FACTORY_COCKPIT_CACHE_SECONDS: undefined, TMUX: undefined, NO_COLOR: undefined });
  return { d, env, log };
}

function prs(p: Proj, args: string[] = [], size: Env = { COLUMNS: "140", LINES: "40" }): Proc {
  return sh(["bash", join(SF, "factory"), "cockpit", "--prs", ...args], { cwd: p.d, env: { ...p.env, ...size }, timeoutMs: 100_000 });
}

function noTrace(out: string): void {
  expect(out).not.toMatch(/^\s+at .*(:\d+|\))/m);
  expect(out).not.toMatch(/\b(TypeError|ReferenceError|SyntaxError|Unhandled)\b/);
}

function lines(out: string): string[] {
  return out.split("\n");
}

/** The table row of PR `n`: the line that starts with its number. */
function rowOf(out: string, n: number): string {
  const found = lines(out).find((l) => new RegExp(`^.?\\s*#${n}\\s`).test(l));
  expect(found, out).toBeDefined();
  return found as string;
}

/** The detail block: everything after the line that starts `#<n> ·`. */
function detail(out: string, n: number): string {
  const all = lines(out);
  const at = all.findIndex((l) => new RegExp(`^\\s*#${n} · `).test(l));
  expect(at, out).toBeGreaterThan(-1);
  return all.slice(at).join("\n");
}

// --- the table ------------------------------------------------------------------------------------------------------

test("one row per open PR, under the board's column heads", () => {
  const p = setup();
  const r = prs(p);
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  expect(r.stdout).toContain("Pull requests");
  expect(r.stdout).toMatch(/PR\s+title\s+by\s+CI\s+reviews\s+who acts\s+next/);
  const a = rowOf(r.stdout, 12);
  expect(a).toContain("Task 7: the importer");
  expect(a).toContain("menelik");
  expect(a).toContain("green");
  const b = rowOf(r.stdout, 13);
  expect(b).toContain("taytu");
  expect(b).toContain("red");
  expect(rowOf(r.stdout, 14)).toContain("docs: tidy the readme");
}, T);

test("a protected PR says so after its title, and the owner acts on it", () => {
  const p = setup();
  const r = prs(p);
  const a = rowOf(r.stdout, 12);
  expect(a).toContain("· protected");
  expect(a).toMatch(/\byou\b/);
  expect(a).toContain("owner merges");
  expect(rowOf(r.stdout, 14)).not.toContain("protected");
}, T);

test("who acts follows the next action: the agent fixes a red PR", () => {
  const p = setup();
  const b = rowOf(prs(p).stdout, 13);
  expect(b.split("red")[1] ?? "", b).toContain("taytu");
  expect(b).toContain("waiting for agent");
}, T);

test("the reviews column shows the dev manager's word on the head", () => {
  const p = setup();
  const r = prs(p);
  expect(rowOf(r.stdout, 12)).toContain("✓");
  expect(rowOf(r.stdout, 13)).toContain("✕");
}, T);

// --- the detail -----------------------------------------------------------------------------------------------------

test("the first PR is selected and its detail is shown below the table", () => {
  const p = setup();
  const r = prs(p);
  const d = detail(r.stdout, 12);
  expect(d).toContain("Task 7: the importer");
  expect(d).toContain("task/7-importer");
  expect(d).toContain(`head ${A.slice(0, 7)}`);
  expect(d).toMatch(/approved/);
  expect(d).toMatch(/protected/);
  expect(d).toContain("https://github.com/o/r/pull/12");
  expect(lines(r.stdout).findIndex((l) => /^\s*#12 · /.test(l))).toBeGreaterThan(lines(r.stdout).indexOf(rowOf(r.stdout, 14)));
}, T);

test("--prs <n> selects that PR: its CI jobs, its must-fix and its open question", () => {
  const p = setup();
  const r = prs(p, ["13"]);
  expect(r.code, r.out).toBe(0);
  const d = detail(r.stdout, 13);
  expect(d).toContain(`head ${B.slice(0, 7)}`);
  expect(d).toContain("unit shard 2");
  expect(d).toMatch(/1 other check/);
  expect(d).toMatch(/must-fix/);
  expect(d).toMatch(/questions\s+1 open/);
  expect(d).toContain("waiting for agent");
  expect(lines(r.stdout).some((l) => /^\s*#12 · /.test(l))).toBe(false);
}, T);

test("the other checks are counted by job: a re-run job and a skipped check are not counted as passing", () => {
  const s = scenario();
  s[`commits/${B}/check-runs`] = { check_runs: [
    { id: 1, name: "unit shard 2", status: "completed", conclusion: "failure", started_at: "2020-01-01T00:00:00Z" },
    { id: 2, name: "unit shard 2", status: "completed", conclusion: "failure", started_at: "2020-01-01T01:00:00Z" },
    { id: 3, name: "check", status: "completed", conclusion: "success", started_at: "2020-01-01T00:00:00Z" },
    { id: 4, name: "deploy", status: "completed", conclusion: "skipped", started_at: "2020-01-01T00:00:00Z" },
  ] };
  const p = setup(s);
  const r = prs(p, ["13"]);
  expect(r.code, r.out).toBe(0);
  const d = detail(r.stdout, 13);
  expect(d).toContain("unit shard 2");
  expect(d).toMatch(/1 other check\b/);
  expect(d).not.toMatch(/[2-9] other checks/);
}, T);

test("the keys that work are at the bottom", () => {
  const p = setup();
  const all = lines(prs(p).stdout.trimEnd());
  expect(all[all.length - 1]).toMatch(/j k\b.*move/);
  expect(all[all.length - 1]).toMatch(/q\b.*close/);
}, T);

// --- narrow, plain, hostile ------------------------------------------------------------------------------------------

test("a narrow terminal gets lines no wider than it, with the number, CI and title still there", () => {
  const p = setup();
  const r = prs(p, [], { COLUMNS: "60", LINES: "30" });
  expect(r.code, r.out).toBe(0);
  for (const l of lines(r.stdout)) expect([...l].length, l).toBeLessThanOrEqual(60);
  const b = rowOf(r.stdout, 13);
  expect(b).toContain("red");
  expect(b).toContain("Task 8");
}, T);

test("a short terminal gets no more lines than it has", () => {
  const p = setup();
  const r = prs(p, [], { COLUMNS: "100", LINES: "12" });
  expect(r.code, r.out).toBe(0);
  expect(lines(r.stdout.replace(/\n$/, "")).length).toBeLessThanOrEqual(12);
}, T);

test("off a terminal there is no colour or escape sequence", () => {
  const p = setup();
  const r = prs(p);
  expect(r.stdout.replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f]/);
}, T);

test("a PR title or branch can't drive the terminal", () => {
  const s = scenario();
  (s.pulls as Row[])[0] = pr(12, "evil\x1b]0;pwned\x07 \x1b[31mred\x1b[0m\rtitle", A, "task/7-\x1b[2Jx", ["agent:menelik"]);
  const p = setup(s);
  const r = prs(p);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("evil");
  expect(r.stdout.replace(/\n/g, ""), JSON.stringify(r.stdout)).not.toMatch(/[\x00-\x1f\x7f]/);
}, T);

// --- nothing, or no GitHub --------------------------------------------------------------------------------------------

test("no open pull requests says so", () => {
  const s = scenario();
  s.pulls = [];
  const p = setup(s);
  const r = prs(p);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("No open pull requests");
}, T);

test("when GitHub can't be read the view says so and what to do", () => {
  const p = setup({ fail_all: true });
  const r = prs(p);
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  expect(r.stdout).toMatch(/can't read the pull requests/i);
  expect(r.stdout).toContain("gh auth status");
}, T);

test("a number that is not an open PR is refused with code, message and fix", () => {
  const p = setup();
  const r = prs(p, ["99"]);
  expect(r.code, r.out).toBe(2);
  const e = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "") as Row;
  expect(e.code).toBe("cockpit_no_pr");
  for (const k of ["message", "fix"]) expect(typeof e[k]).toBe("string");
}, T);

test("a word that is not a number is refused with code, message and fix", () => {
  const p = setup();
  const r = prs(p, ["abc"]);
  expect(r.code, r.out).toBe(2);
  const e = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "") as Row;
  expect(e.code).toBe("cockpit_usage");
  for (const k of ["message", "fix"]) expect(typeof e[k]).toBe("string");
}, T);

// --- on a terminal --------------------------------------------------------------------------------------------------

test("on a terminal j moves to the next PR and q closes the view", async () => {
  const p = setup();
  let shown = "";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", "--prs"], {
    cwd: p.d, env, terminal: { cols: 140, rows: 40, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 60_000);
  const until = async (re: RegExp) => {
    for (let i = 0; i < 600 && !re.test(shown); i++) await Bun.sleep(100);
  };
  await until(/#12 · /);
  expect(shown).toMatch(/#12 · /);
  await Bun.sleep(300);
  proc.terminal?.write("j");
  await until(/#13 · /);
  expect(shown).toMatch(/#13 · /);
  proc.terminal?.write("q");
  const code = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  expect(code).toBe(0);
}, T);

test("on a terminal with CI set the view is still drawn before any key, and q closes it", async () => {
  const p = setup();
  let shown = "";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (v !== undefined) env[k] = v;
  env.CI = "true"; // GitHub Actions sets it, and Ink then draws nothing until it unmounts unless told it is interactive
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", "--prs"], {
    cwd: p.d, env, terminal: { cols: 140, rows: 40, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 40_000);
  for (let i = 0; i < 300 && !/#12 · /.test(shown); i++) await Bun.sleep(100);
  const drawn = /#12 · /.test(shown);
  proc.terminal?.write("q");
  const code = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  expect(drawn, shown).toBe(true);
  expect(code).toBe(0);
}, T);

// --- the cockpit's view 2, help and docs ----------------------------------------------------------------------------

test("the cockpit's Pull requests view runs this view, not a pager", () => {
  const r = sh([process.execPath, "--no-env-file", "-e",
    `const ui = await import(${JSON.stringify(join(HOOKS, "factory_cockpit_ui.ts"))});
     const v = ui.views().find((x) => x.title === "Pull requests");
     console.log(ui.viewCommand("/f/factory", v));`]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("cockpit --prs");
  expect(r.stdout).not.toContain("less -R");
});

test("factory help lists cockpit --prs", () => {
  const p = setup();
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/^ {2}cockpit --prs\b/m);
});

test("the commands page has a row for factory cockpit --prs", () => {
  expect(read(join(WIKI, "commands.md"))).toMatch(/^\| `factory cockpit --prs/m);
});

test("the view leaves no file in the project", () => {
  const p = setup();
  prs(p);
  expect(existsSync(join(p.d, "tmp"))).toBe(false);
  expect(readFileSync(p.log, "utf8")).toContain("pulls");
}, T);
