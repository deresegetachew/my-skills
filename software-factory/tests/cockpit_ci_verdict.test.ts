// The CI view's verdict and waiting list through `factory` (#396): `factory cockpit --ci` off a terminal, `factory ci
// status --json` giving each run its GitHub id, and the wiki listing the view's keys.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CI, copyHookFolders, envWith, git, gitRepo, HOOKS, SF, sh, tmp, write, WIKI, type Proc } from "./support.ts";

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
  copyHookFolders(join(d, ".claude", "hooks"));
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
    NO_COLOR: undefined, TERM: "xterm-256color", COLUMNS: "140", ...extra });
  return { d, root, env, xdg };
}

function seed(p: Proj, snap: Obj): void {
  write(join(p.xdg, "work-factory", "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [],
    pulls: [], missing: [], ...snap }));
}

function cockpit(p: Proj, args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: p.env, timeoutMs: 50_000 });
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const LOCAL: Obj = {
  mode: "local", runsOn: "[\"self-hosted\",\"remanual-local\"]", repo: "o/remanual", label: "remanual-local",
  instances: [{ id: "1", name: "remanual-ci", state: "running", manager: "systemd", pid: 11 }],
  docker: 1,
  runs: [
    { ref: "main", branch: "main", state: "in_progress", name: "CI", createdAt: "", minutesAgo: 4, id: 9000 },
    { ref: "#445", branch: "factory-v0.2.1", state: "queued", name: "CI", createdAt: "", minutesAgo: 2, id: 9100 },
    { ref: "#435", branch: "task/410-x", state: "failure", name: "CI", createdAt: "", minutesAgo: 900, id: 9300 },
  ],
  runners: [
    { name: "remanual-ci-dev-pc-1", status: "online", busy: true },
    { name: "remanual-ci-dev-pc.2-1", status: "online", busy: false },
  ],
  light: null,
  queuedLong: { count: 0, longestMinutes: 0, thresholdMinutes: 15, noRunnerOnline: false },
  errors: [],
};

test("--ci prints the verdict first and lists the pull requests waiting on CI", () => {
  const p = setup();
  seed(p, { ci: LOCAL });
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout);
  expect(t).toContain("CI is fine: 2 runners online, 1 run queued");
  expect(t).toContain("Waiting on CI");
  expect(t).toMatch(/#445\s+queued\s+2 min\s+factory-v0\.2\.1/);
  const lines = t.split("\n");
  const at = (s: string) => lines.findIndex((l) => l.includes(s));
  expect(at("CI is fine"), "the verdict comes before the cards").toBeLessThan(at("WHERE JOBS RUN"));
}, T);

test("--ci says CI is stuck when no heavy runner is online", () => {
  const p = setup();
  seed(p, { ci: { ...LOCAL, runners: [{ name: "remanual-ci-old-box-7", status: "offline", busy: false }] } });
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  expect(stripAnsi(r.stdout)).toContain("CI is stuck: no runner online for remanual-local; 1 PR is waiting");
}, T);

test("--ci says no pull request is waiting when none is", () => {
  const p = setup();
  seed(p, { ci: { ...LOCAL, runs: (LOCAL.runs as Obj[]).slice(0, 1) } });
  const r = cockpit(p, ["--ci"]);
  expect(r.code, r.out).toBe(0);
  expect(stripAnsi(r.stdout)).toContain("No pull request is waiting on CI.");
}, T);

// --- factory ci status --json gives each run its id ------------------------------------------------------------------

const STATUS_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log("acme/Widget"); process.exit(0); }
if (a[0] !== "api") { console.error("no answer"); process.exit(1); }
const path = a.filter((x) => !x.startsWith("-"))[1] ?? "";
const p = path.split("?")[0];
if (p.includes("/actions/variables/")) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
const created = new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const data: Record<string, unknown> = {
  "repos/acme/Widget": { default_branch: "main" },
  "repos/acme/Widget/actions/runs": { workflow_runs: [
    { id: 777001, head_branch: "main", status: "completed", conclusion: "failure", created_at: created, name: "CI" },
    { id: 777002, head_branch: "feat", status: "queued", conclusion: null, created_at: created, name: "CI" } ] },
  "repos/acme/Widget/pulls": [{ number: 12, head: { ref: "feat" } }],
  "repos/acme/Widget/actions/runners": { runners: [] },
};
if (!(p in data)) { console.error("no answer for " + p); process.exit(1); }
console.log(JSON.stringify(data[p]));
`;

test("factory ci status --json gives each run its GitHub run id", () => {
  const root = tmp();
  const d = join(root, "work");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const x of [d, bin, home]) mkdirSync(x);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  git(d, "remote", "add", "origin", "git@github.com:acme/Widget.git");
  write(join(d, ".claude", "factory.json"), "{}");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "x");
  write(join(bin, "gh"), STATUS_GH, 0o755);
  const env = envWith(bin, { HOME: home, XDG_STATE_HOME: undefined });
  const p = sh(["bash", join(CI, "ci.sh"), "status", "--json"], { cwd: d, env, timeoutMs: 120_000 });
  expect(p.code, p.out).toBe(0);
  const j = JSON.parse(p.stdout) as { runs: Obj[] };
  expect(j.runs.map((r) => [r.ref, r.id])).toEqual([["main", 777001], ["#12", 777002]]);
}, T);

// --- the wiki ---------------------------------------------------------------------------------------------------------

test("the wiki's commands page lists the CI view's keys on the factory cockpit --ci row", () => {
  const row = readFileSync(join(WIKI, "commands.md"), "utf8").split("\n").find((l) => l.startsWith("| `factory cockpit --ci`")) ?? "";
  expect(row).not.toBe("");
  for (const k of ["`i`", "`l`", "`g`", "`+`", "`-`", "`L`", "`c`", "`R`", "Enter"]) expect(row, k).toContain(k);
});
