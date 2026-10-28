// `factory ci`: names from the project, the LaunchAgent it writes, `use local|github`, `status` in both modes, and
// `stop` never killing a process that isn't its loop.
//
// gh, launchctl, plutil, docker and scutil are fakes on PATH, and HOME is a temp folder, so nothing touches the real
// Mac or GitHub. What launchd and macOS show (Login Items, Activity Monitor) can't be tested here.
import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPlist } from "./ci_support.ts";
import { git, KIT, sh, SF, tmp, write, writeExe } from "./support.ts";

const CI = join(SF, "ci", "ci.sh");
const SUPPORT = join(import.meta.dir, "ci_support.ts");

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

// db: {"repo": "acme/Widget" | null, "vars": {...}, "api": {path: json}, "fail": [paths]}. --jq runs real jq.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const f = process.env.FAKE_DB as string; const db = JSON.parse(readFileSync(f, "utf8")); const a = process.argv.slice(2);
appendFileSync(f + ".gh.log", JSON.stringify(a) + "\n");
const save = () => writeFileSync(f, JSON.stringify(db));
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] === "repo" && a[1] === "view") { if (!db.repo) fail("not a github repo"); console.log(db.repo); process.exit(0); }
if (a[0] === "variable") {
  const name = a[2];
  if (a[1] === "set") { (db.vars ??= {})[name] = a[a.indexOf("--body") + 1]; save(); process.exit(0); }
  if (a[1] === "delete") {
    if (db.no_delete) fail("HTTP 403: Resource not accessible");
    delete (db.vars ?? {})[name]; save(); process.exit(0);
  }
}
if (a[0] !== "api") fail("fake gh: no answer for " + JSON.stringify(a));
let method = "GET", jq: string | null = null, path = ""; const rest = a.slice(1);
for (let k = 0; k < rest.length;) {
  if (rest[k] === "-X") { method = rest[k + 1]; k += 2; }
  else if (rest[k] === "--jq") { jq = rest[k + 1]; k += 2; }
  else if (["-H", "-f", "-F", "--input"].includes(rest[k])) k += 2;
  else if (rest[k].startsWith("-")) k += 1;
  else { path = rest[k]; k += 1; }
}
const p = path.split("?")[0];
if ((db.fail ?? []).includes(p)) fail("HTTP 403: Resource not accessible");
const v = p.includes("/actions/variables/") ? p.slice(p.lastIndexOf("/") + 1) : null;
let data: unknown;
if (v !== null) {
  if (!(v in (db.vars ?? {}))) { process.stderr.write("gh: Not Found (HTTP 404)\n"); process.exit(1); }
  data = { name: v, value: db.vars[v] };
} else if (p.endsWith("/registration-token") && method === "POST") {
  if (db.can_register === false) fail("HTTP 403");
  data = { token: "fresh-token" };
} else if (method === "DELETE") {
  (db.deleted ??= []).push(p.slice(p.lastIndexOf("/") + 1)); save(); process.exit(0);
} else if (p in (db.api ?? {})) {
  data = db.api[p];
} else fail("fake gh: no answer for " + p);
if (jq) {
  const r = Bun.spawnSync(["jq", "-r", jq], { stdin: new TextEncoder().encode(JSON.stringify(data)) });
  if (r.exitCode !== 0) { process.stderr.write(r.stderr); process.exit(r.exitCode ?? 1); }
  process.stdout.write(r.stdout);
} else console.log(JSON.stringify(data));
`;

// Loaded agents are files in $FAKE_LAUNCHD/<label>; print shows a pid when the file holds one.
const FAKE_LAUNCHCTL = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DB.launchctl.log"
d="$FAKE_LAUNCHD"; mkdir -p "$d"
case "$1" in
  print) l="\${2##*/}"; [ -f "$d/$l" ] || exit 113; echo "$l = {"; [ -s "$d/$l" ] && echo "	pid = $(cat "$d/$l")"; echo "}" ;;
  bootout) l="\${2##*/}"; [ -f "$d/$l" ] || exit 3; rm -f "$d/$l" ;;
  bootstrap) l="$(basename "$3" .plist)"; echo 4242 >"$d/$l" ;;
esac
`;

const FAKE_PLUTIL = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { parsePlist } from ${JSON.stringify(SUPPORT)};
parsePlist(readFileSync(process.argv[3], "utf8"));
`;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DB.docker.log"
[ "\${FAKE_DOCKER_UP:-1}" = 1 ] || exit 1
case " $* " in
  *" build "*) [ -z "\${FAKE_DOCKER_BUILD_FAILS:-}" ] || exit 1 ;;
  *" info "*"MemTotal"*) [ -n "\${FAKE_DOCKER_MEMTOTAL:-}" ] && echo "$FAKE_DOCKER_MEMTOTAL"; exit 0 ;;
  *" image inspect "*) [ -n "\${FAKE_DOCKER_IMAGE_LABELS:-}" ] || exit 1; echo "$FAKE_DOCKER_IMAGE_LABELS"; exit 0 ;;
  *" run "*) [ -z "\${FAKE_DOCKER_RUN_FAILS:-}" ] || { echo "bash: /opt/factory-ci/entrypoint.sh: Permission denied" >&2; exit 126; } ;;
  *" up "*)  # one round: say whether the runner got the given token, then fail registration (code 3)
    [ "\${RUNNER_TOKEN:-}" = "given-token" ] && echo "token ok" >>"$FAKE_DB.docker.log"
    echo "name $RUNNER_NAME label $RUNNER_LABEL" >>"$FAKE_DB.docker.log"
    exit 3 ;;
esac
exit 0
`;

interface Project {
  d: string;
  db: string;
  env: Env;
}

function project(o: { repo?: string | null; ci?: Json | null; remote?: string } = {}): Project {
  const repo = o.repo === undefined ? "acme/Widget" : o.repo;
  const remote = o.remote ?? "git@github.com:acme/Widget.git";
  const root = tmp();
  const d = join(root, "work");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const x of [d, home, bin]) mkdirSync(x);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  git(d, "remote", "add", "origin", remote);
  write(join(d, ".claude", "factory.json"), JSON.stringify(o.ci ? { ci: o.ci } : {}));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "x");
  for (const [name, body] of [["gh", FAKE_GH], ["launchctl", FAKE_LAUNCHCTL], ["plutil", FAKE_PLUTIL],
    ["docker", FAKE_DOCKER], ["scutil", "#!/bin/sh\necho Test-Mac\n"]] as const) {
    writeExe(join(bin, name), body);
  }
  const db = join(root, "db.json");
  writeFileSync(db, JSON.stringify({ repo, vars: {}, api: {} }));
  const env: Env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, FAKE_DB: db,
    FAKE_LAUNCHD: join(root, "launchd") };
  delete env.XDG_STATE_HOME;
  delete env.RUNNER_TOKEN;
  // `factory ci install` runs `git fetch origin main`. The remote here is made up, so make that fail at once and
  // offline (no ssh, no system git config that rewrites it to https) instead of waiting on a real network call.
  Object.assign(env, { GIT_SSH_COMMAND: "false", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  return { d, db, env };
}

function ci(d: string, env: Env, ...args: string[]): [number, string] {
  const p = sh(["bash", CI, ...args], { cwd: d, env, timeoutMs: 120_000 });
  return [p.code, p.stdout + p.stderr];
}

async function ciAsync(d: string, env: Env, ...args: string[]): Promise<[number, string]> {
  const p = Bun.spawn(["bash", CI, ...args], { cwd: d, env: clean(env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return [code, out + err];
}

function clean(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function names(d: string, env: Env): Record<string, string> {
  const [rc, out] = ci(d, env, "names");
  expect(rc, out).toBe(0);
  const n: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i >= 0) n[line.slice(0, i)] = line.slice(i + 1);
  }
  return n;
}

function dbOf(db: string): Json {
  return JSON.parse(readFileSync(db, "utf8")) as Json;
}

function vars(db: string): Record<string, string> {
  return (dbOf(db).vars ?? {}) as Record<string, string>;
}

function update(db: string, kw: Json): void {
  writeFileSync(db, JSON.stringify({ ...dbOf(db), ...kw }));
}

function log(db: string, what: string): string {
  try {
    return readFileSync(`${db}.${what}.log`, "utf8");
  } catch {
    return "";
  }
}

function runsAndPulls(db: string, runs: Json[], pulls: Json[] = [], runners?: Json[]): void {
  const api: Json = {
    "repos/acme/Widget": { default_branch: "main" },
    "repos/acme/Widget/actions/runs": { workflow_runs: runs },
    "repos/acme/Widget/pulls": pulls,
  };
  if (runners !== undefined) api["repos/acme/Widget/actions/runners"] = { runners };
  update(db, { api });
}

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function run(branch: string, o: { status?: string; conclusion?: string | null; created?: string; name?: string } = {}): Json {
  return { head_branch: branch, status: o.status ?? "completed", conclusion: o.conclusion === undefined ? "success" : o.conclusion,
    created_at: o.created ?? ago(10), name: o.name ?? "CI" };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function contains(out: string, ...parts: string[]): void {
  for (const p of parts) expect(out, p).toContain(p);
}

function lacks(out: string, ...parts: string[]): void {
  for (const p of parts) expect(out, p).not.toContain(p);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- names -------------------------------------------------------------------------------------------------------

test("names come from the repository", () => {
  const { d, env } = project();
  const n = names(d, env);
  const home = env.HOME as string;
  expect([n.CI_REPO, n.CI_NAME, n.CI_LABEL]).toEqual(["acme/Widget", "widget-ci", "widget-local"]);
  expect(n.CI_AGENT).toBe("dev.software-factory.widget-ci");
  expect(n.CI_PLIST).toBe(`${home}/Library/LaunchAgents/dev.software-factory.widget-ci.plist`);
  expect(n.CI_INSTALLED).toBe(`${home}/Library/Application Support/widget-ci`);
  expect([n.CI_STATE, n.CI_HOST]).toEqual([`${home}/.local/state/widget-ci`, "test-mac"]);
});

test("factory json names win and the repo falls back to the remote", () => {
  const { d, env } = project({ repo: null, ci: { name: "shop-runner", label: "shop-mac" }, remote: "https://github.com/acme/shop.git" });
  const n = names(d, env);
  expect([n.CI_REPO, n.CI_NAME, n.CI_LABEL]).toEqual(["acme/shop", "shop-runner", "shop-mac"]);
});

test("an unsafe name is refused", () => {
  const { d, env } = project({ ci: { name: "Bad Name; rm -rf" } });
  const [rc, out] = ci(d, env, "names");
  expect(rc, out).not.toBe(0);
  expect(out).toContain("the name 'Bad Name; rm -rf' must be lowercase");
});

// --- install -----------------------------------------------------------------------------------------------------

test("install writes a launchagent that runs a private named copy", () => {
  const { d, db, env } = project({ ci: { replaces: ["com.example.old-runner"] } });
  const old = join(env.HOME as string, "Library", "LaunchAgents", "com.example.old-runner.plist");
  write(old, "<plist/>");
  write(join(env.FAKE_LAUNCHD as string, "com.example.old-runner"), "7");
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  const n = names(d, env);
  const pl = loadPlist(n.CI_PLIST as string);
  const exe = join(n.CI_INSTALLED as string, "widget-ci");
  expect(pl.Label).toBe("dev.software-factory.widget-ci");
  expect(pl.ProgramArguments).toEqual([exe]);
  expect(pl.RunAtLoad && pl.KeepAlive && pl.ThrottleInterval === 30).toBe(true);
  const e = pl.EnvironmentVariables as Record<string, string>;
  expect([e.CI_NAME, e.CI_LABEL, e.RUNNER_REPO, e.CI_HOST]).toEqual(["widget-ci", "widget-local", "acme/Widget", "test-mac"]);
  expect((e.PATH as string).split(":").every((x) => x.startsWith("/")), e.PATH).toBe(true);
  expect(Object.keys(e).filter((k) => k.includes("TOKEN"))).toEqual([]);
  // The copy, not the checkout: an executable with the project's name and a bash line.
  expect(readFileSync(exe, "utf8").split("\n")[0]).toBe("#!/bin/bash");
  expect(mode(exe)).toBe(0o700);
  expect(exe.startsWith(d)).toBe(false);
  expect(existsSync(join(n.CI_INSTALLED as string, "compose.yaml"))).toBe(true);
  expect(mode(n.CI_INSTALLED as string)).toBe(0o700);
  // The older agent is unloaded and its file removed; then the new one is booted out and bootstrapped.
  const lc = log(db, "launchctl");
  contains(lc, "bootout gui/", "/com.example.old-runner");
  expect(existsSync(old)).toBe(false);
  expect(lc.indexOf("/dev.software-factory.widget-ci")).toBeLessThan(lc.indexOf("bootstrap"));
  expect(JSON.stringify(pl)).not.toContain("fresh-token");
  expect(out).toContain("Installed widget-ci");
});

test("install refuses without a working gh login", () => {
  const { d, db, env } = project();
  update(db, { can_register: false });
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(1);
  expect(out).toContain("gh can't create a runner registration token for acme/Widget");
  expect(existsSync(names(d, env).CI_PLIST as string)).toBe(false);
});

// --- use ---------------------------------------------------------------------------------------------------------

test("use local then github sets and deletes ci runs on", () => {
  const { d, db, env } = project();
  let [rc, out] = ci(d, env, "use", "local");
  expect(rc, out).toBe(0);
  expect(vars(db).CI_RUNS_ON).toBe('["self-hosted","widget-local"]');
  expect(out).toContain("No runner is running on this Mac");
  [rc, out] = ci(d, env, "use", "github");
  expect(rc, out).toBe(0);
  expect("CI_RUNS_ON" in vars(db)).toBe(false);
  expect(out).toContain("GitHub's runners");
  [rc, out] = ci(d, env, "use", "github");
  expect(rc, out).toBe(0);
  expect(out).toContain("already runs on GitHub");
  expect(ci(d, env, "use", "elsewhere")[0]).toBe(1);
});

// --- status ------------------------------------------------------------------------------------------------------

test("status in github mode shows runs and no local runner", () => {
  const { d, db, env } = project();
  runsAndPulls(db, [run("main"), run("feat", { conclusion: "failure" }), run("old")], [{ number: 12, head: { ref: "feat" } }]);
  const [rc, out] = ci(d, env, "status");
  expect(rc, out).toBe(0);
  contains(out, "Mode: github", "main   success", "#12    failure");
  lacks(out, " on old", "Runner widget-ci", "Docker");
});

test("status in local mode shows the agent the runners and a stuck queue", () => {
  const { d, db, env } = project();
  expect(ci(d, env, "install")[0]).toBe(0);
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]' } });
  runsAndPulls(db, [run("feat", { status: "queued", conclusion: null, created: ago(60) })], [{ number: 12, head: { ref: "feat" } }],
    [{ name: "widget-ci-other-1", status: "offline", busy: false, labels: [{ name: "self-hosted" }, { name: "widget-local" }] },
      { name: "someone-else", status: "online", busy: false, labels: [{ name: "x" }] }]);
  const n = names(d, env);
  writeFileSync(join(n.CI_STATE as string, "runner.log"), "2026-10-22T11:59:00Z round 3: job done\n");
  const [rc, out] = ci(d, env, "status");
  expect(rc, out).toBe(0);
  contains(out, "Mode: local", "Runner widget-ci: running (LaunchAgent dev.software-factory.widget-ci, pid 4242)",
    "Docker: running", "widget-ci-other-1: offline", "#12    queued", "no runner with the label widget-local is online",
    "round 3: job done");
  lacks(out, "someone-else");
});

test("status says when github cant be read", () => {
  const { d, db, env } = project();
  update(db, { fail: ["repos/acme/Widget/actions/variables/CI_RUNS_ON", "repos/acme/Widget/actions/runs"] });
  const [rc, out] = ci(d, env, "status");
  expect(rc, out).toBe(0);
  contains(out, "Mode: unknown", "can't be read right now");
});

// --- status --json (#304) ----------------------------------------------------------------------------------------

function ciJson(d: string, env: Env, ...args: string[]): [number, Json, string] {
  const p = sh(["bash", CI, "status", "--json", ...args], { cwd: d, env, timeoutMs: 120_000 });
  let data: Json = {};
  try {
    data = JSON.parse(p.stdout) as Json;
  } catch {
    data = { notJson: p.stdout };
  }
  return [p.code, data, p.stdout + p.stderr];
}

test("status --json on github's runners with no runner installed", () => {
  const { d, db, env } = project();
  runsAndPulls(db, [run("main"), run("feat", { conclusion: "failure" }), run("old")], [{ number: 12, head: { ref: "feat" } }], []);
  const [rc, j, out] = ciJson(d, env);
  expect(rc, out).toBe(0);
  expect(Object.keys(j).sort()).toEqual(
    ["docker", "errors", "instances", "label", "light", "mode", "queuedLong", "repo", "runners", "runs", "runsOn"]);
  expect([j.mode, j.runsOn, j.repo, j.label]).toEqual(["github", null, "acme/Widget", "widget-local"]);
  const runs = j.runs as Json[];
  expect(runs.map((r) => [r.ref, r.branch, r.state, r.name])).toEqual([["main", "main", "success", "CI"], ["#12", "feat", "failure", "CI"]]);
  expect(typeof runs[0]?.createdAt).toBe("string");
  expect(runs[0]?.minutesAgo).toBe(10);
  expect([j.instances, j.runners, j.docker, j.errors]).toEqual([[], [], null, []]);
  expect(j.light).toEqual({ label: "widget-light", variableSet: false, runners: [], noneOnline: true });
  expect(j.queuedLong).toEqual({ count: 0, longestMinutes: 0, thresholdMinutes: 15, noRunnerOnline: false });
  lacks(out, "Mode:", "CI runs (latest");
});

test("status --json on a local runner lists the instance the runners and a stuck queue", () => {
  const { d, db, env } = project();
  expect(ci(d, env, "install")[0]).toBe(0);
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]' } });
  runsAndPulls(db, [run("feat", { status: "queued", conclusion: null, created: ago(60) })], [{ number: 12, head: { ref: "feat" } }],
    [{ name: "widget-ci-other-1", status: "offline", busy: false, labels: [{ name: "self-hosted" }, { name: "widget-local" }] },
      { name: "someone-else", status: "online", busy: false, labels: [{ name: "x" }] }]);
  const n = names(d, env);
  writeFileSync(join(n.CI_STATE as string, "runner.log"), "2026-10-22T11:59:00Z round 3: job done\n");
  const [rc, j, out] = ciJson(d, env);
  expect(rc, out).toBe(0);
  expect([j.mode, j.runsOn, j.docker]).toEqual(["local", '["self-hosted","widget-local"]', true]);
  expect(j.instances).toEqual([{ id: "1", name: "widget-ci", state: "running", manager: "launchd", pid: 4242 },
    { id: "light", name: "widget-ci-light", state: "running", manager: "launchd", pid: 4242 }]);
  expect(j.runners).toEqual([{ name: "widget-ci-other-1", status: "offline", busy: false }]);
  expect((j.runs as Json[]).map((r) => [r.ref, r.state])).toEqual([["#12", "queued"]]);
  const q = j.queuedLong as Json;
  expect([q.count, q.noRunnerOnline]).toEqual([1, true]);
  expect(q.longestMinutes as number).toBeGreaterThanOrEqual(60);
  lacks(out, "round 3: job done", "Docker: running");
});

test("status --json when github cant be read says so as errors", () => {
  const { d, db, env } = project();
  update(db, { fail: ["repos/acme/Widget/actions/variables/CI_RUNS_ON", "repos/acme/Widget/actions/runs"] });
  const [rc, j, out] = ciJson(d, env);
  expect(rc, out).toBe(0);
  expect([j.mode, j.runs]).toEqual(["unknown", null]);
  const errors = j.errors as Json[];
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) expect(Object.keys(e).sort()).toEqual(["code", "fix", "message"]);
  expect(errors.map((e) => e.code)).toContain("github_unreadable");
});

test("status with an unknown flag is a code message fix error", () => {
  const { d, env } = project();
  const p = sh(["bash", CI, "status", "--jsn"], { cwd: d, env, timeoutMs: 120_000 });
  expect(p.code).toBe(1);
  const e = JSON.parse(p.stderr.trim()) as Json;
  expect(e.code).toBe("bad_args");
  expect(String(e.message)).toContain("--jsn");
  expect(String(e.fix)).toContain("factory ci status --json");
  expect(p.stdout).toBe("");
});

// --- start and stop ----------------------------------------------------------------------------------------------

test("stop leaves an unrelated process with the saved pid alone", () => {
  const { d, env } = project();
  const n = names(d, env);
  mkdirSync(n.CI_STATE as string, { recursive: true });
  const other = Bun.spawn(["sleep", "60"]);
  try {
    writeFileSync(join(n.CI_STATE as string, "pid"), String(other.pid));
    const [rc, out] = ci(d, env, "stop");
    expect(rc, out).toBe(0);
    expect(other.exitCode).toBeNull();
    expect(pidAlive(other.pid)).toBe(true);
    expect(existsSync(join(n.CI_STATE as string, "pid"))).toBe(false);
  } finally {
    other.kill(9);
  }
});

test("stop ends its own loop and removes only this macs idle registrations", async () => {
  const { d, db, env } = project();
  const n = names(d, env);
  const exe = join(n.CI_INSTALLED as string, "widget-ci");
  mkdirSync(n.CI_STATE as string, { recursive: true });
  mkdirSync(n.CI_INSTALLED as string, { recursive: true });
  writeExe(exe, "#!/bin/bash\nsleep 60 & wait\n");
  chmodSync(exe, 0o700);
  // A real loop is nobody's child, but this one is ours: `stop` runs without blocking this process, so Bun reaps the
  // loop as soon as it dies (an unreaped child stays a zombie that `ps` still lists, and `stop` would wait 30 s).
  const loop = Bun.spawn(["/bin/bash", exe], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(300);
  writeFileSync(join(n.CI_STATE as string, "pid"), String(loop.pid));
  const runner = (i: number, name: string, status: string, busy = false): Json => ({ id: i, name, status, busy });
  update(db, { api: { "repos/acme/Widget/actions/runners": { runners: [
    runner(1, "widget-ci-test-mac-100", "online"), // this Mac, idle: removed
    runner(2, "widget-ci-test-mac-101", "online", true), // this Mac, busy: kept
    runner(3, "widget-ci-other-200", "online"), // another Mac, online: kept
    runner(4, "widget-ci-other-150", "offline"), // gone away: removed
    runner(5, "unrelated-1", "offline")] } } }); // not this project's: kept
  try {
    const [rc, out] = await ciAsync(d, env, "stop");
    expect(rc, out).toBe(0);
    const ended = await Promise.race([loop.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    expect(ended, out).toBe(true);
    expect([...((dbOf(db).deleted ?? []) as string[])].sort()).toEqual(["1", "4"]);
    contains(log(db, "docker"), "down --volumes", "--project-name widget-ci");
  } finally {
    if (loop.exitCode === null) loop.kill(9);
  }
});

test("stop refuses while launchd would restart it", () => {
  const { d, env } = project();
  expect(ci(d, env, "install")[0]).toBe(0);
  const [rc, out] = ci(d, env, "stop");
  expect(rc, out).toBe(1);
  expect(out).toContain("factory ci uninstall");
});

test("start gives the token on stdin and never writes it", async () => {
  const { d, db, env } = project();
  const [rc, out] = ci(d, { ...env, RUNNER_TOKEN: "given-token" }, "start");
  expect(rc, out).toBe(0);
  expect(out).toContain("started");
  const n = names(d, env);
  const pid = Number(readFileSync(join(n.CI_STATE as string, "pid"), "utf8"));
  for (let i = 0; i < 100 && pidAlive(pid); i++) await Bun.sleep(100);
  const dl = log(db, "docker");
  contains(dl, "token ok", "name widget-ci-test-mac-", "label widget-local");
  for (const f of readdirSync(env.HOME as string, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    const path = join(f.parentPath, f.name);
    expect(readFileSync(path, "latin1"), path).not.toContain("given-token");
  }
  expect(readFileSync(join(n.CI_STATE as string, "runner.log"), "utf8")).toContain("registration failed");
});

// --- Linux: a systemd --user service (#62) -------------------------------------------------------------------------

// Enabled units are files in $FAKE_SYSTEMD/<unit> holding the pid; every call is logged.
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DB.systemctl.log"
d="$FAKE_SYSTEMD"; mkdir -p "$d"
[ "$1" = "--user" ] || { echo "only --user" >&2; exit 1; }
shift
case "$1" in
  daemon-reload) ;;
  enable) [ "$2" = "--now" ] && echo 4343 >"$d/$3" || echo 4343 >"$d/$2" ;;
  disable) rm -f "$d/\${3:-$2}" ;;
  is-enabled) [ -f "$d/\${3:-$2}" ] ;;
  show) [ -f "$d/$2" ] && cat "$d/$2" || echo 0 ;;
esac
`;

function binOf(env: Env): string {
  return (env.PATH as string).split(":")[0] as string;
}

function linuxProject(o: { linger?: string; ci?: Json } = {}): Project {
  const p = project({ ci: o.ci });
  const bin = binOf(p.env);
  for (const name of ["launchctl", "plutil", "scutil"]) rmSync(join(bin, name));
  for (const [name, body] of [["systemctl", FAKE_SYSTEMCTL], ["loginctl", `#!/bin/sh\necho ${o.linger ?? "yes"}\n`],
    ["hostname", "#!/bin/sh\necho Test-Box\n"]] as const) {
    writeExe(join(bin, name), body);
  }
  const root = dirname(p.db);
  Object.assign(p.env, { FACTORY_CI_PLATFORM: "linux", FAKE_SYSTEMD: join(root, "systemd"), XDG_RUNTIME_DIR: join(root, "run") });
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "DOCKER_HOST"]) delete p.env[k];
  mkdirSync(p.env.XDG_RUNTIME_DIR as string);
  return p;
}

function unitEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l.startsWith("Environment=")) continue;
    const kv = l.slice('Environment="'.length, -1);
    const i = kv.indexOf("=");
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

test("linux names use xdg folders and a user unit", () => {
  const { d, env } = linuxProject();
  const n = names(d, env);
  const home = env.HOME as string;
  expect(n.CI_INSTALLED).toBe(`${home}/.local/share/widget-ci`);
  expect(n.CI_UNIT).toBe("widget-ci.service");
  expect(n.CI_UNIT_FILE).toBe(`${home}/.config/systemd/user/widget-ci.service`);
  expect([n.CI_STATE, n.CI_HOST]).toEqual([`${home}/.local/state/widget-ci`, "test-box"]);
});

test("linux install writes and starts a user service that runs the private copy", () => {
  const { d, db, env } = linuxProject();
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  const n = names(d, env);
  const unit = readFileSync(n.CI_UNIT_FILE as string, "utf8");
  const exe = join(n.CI_INSTALLED as string, "widget-ci");
  contains(unit, `ExecStart=/bin/bash "${exe}"`, "Restart=always", "WantedBy=default.target");
  const e = unitEnv(n.CI_UNIT_FILE as string);
  expect([e.CI_NAME, e.CI_LABEL, e.RUNNER_REPO, e.CI_HOST]).toEqual(["widget-ci", "widget-local", "acme/Widget", "test-box"]);
  expect((e.PATH as string).split(":").every((x) => x.startsWith("/")), e.PATH).toBe(true);
  expect(Object.keys(e).filter((k) => k.includes("TOKEN"))).toEqual([]);
  expect(unit).not.toContain("fresh-token");
  expect(readFileSync(exe, "utf8").split("\n")[0]).toBe("#!/bin/bash");
  expect(exe.startsWith(d)).toBe(false);
  expect(mode(n.CI_INSTALLED as string)).toBe(0o700);
  const sc = log(db, "systemctl");
  expect(sc.indexOf("--user daemon-reload")).toBeGreaterThanOrEqual(0);
  expect(sc.indexOf("--user daemon-reload")).toBeLessThan(sc.indexOf("--user enable widget-ci.service"));
  expect(out).toContain("Installed widget-ci");
  expect(out.toLowerCase()).not.toContain("linger");
});

test("linux install says how to keep it running when linger is off", () => {
  const { d, env } = linuxProject({ linger: "no" });
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  expect(out).toContain("sudo loginctl enable-linger");
});

test("linux install finds rootless docker", () => {
  let { d, env } = linuxProject();
  writeFileSync(join(env.XDG_RUNTIME_DIR as string, "docker.sock"), "");
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  let e = unitEnv(names(d, env).CI_UNIT_FILE as string);
  expect(e.DOCKER_HOST).toBe(`unix://${env.XDG_RUNTIME_DIR}/docker.sock`);
  ({ d, env } = linuxProject());
  ci(d, env, "install");
  expect("DOCKER_HOST" in unitEnv(names(d, env).CI_UNIT_FILE as string), "no rootless socket: Docker's default").toBe(false);
  env.DOCKER_HOST = "unix:///custom/docker.sock";
  ci(d, env, "install");
  e = unitEnv(names(d, env).CI_UNIT_FILE as string);
  expect(e.DOCKER_HOST).toBe("unix:///custom/docker.sock");
});

test("linux status stop and uninstall", () => {
  const { d, db, env } = linuxProject();
  expect(ci(d, env, "install")[0]).toBe(0);
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]' } });
  runsAndPulls(db, [run("main")], [], []);
  let [rc, out] = ci(d, env, "status");
  expect(rc, out).toBe(0);
  expect(out).toContain("Runner widget-ci: running (systemd user service widget-ci.service, pid 4343)");
  [rc, out] = ci(d, env, "stop");
  expect(rc, out).toBe(1);
  expect(out).toContain("systemd would start it again");
  const n = names(d, env);
  [rc, out] = ci(d, env, "uninstall");
  expect(rc, out).toBe(0);
  expect(log(db, "systemctl")).toContain("--user disable --now widget-ci.service");
  expect(existsSync(n.CI_UNIT_FILE as string) || existsSync(n.CI_INSTALLED as string), out).toBe(false);
  [rc, out] = ci(d, env, "status");
  expect(out).toContain("not running on this machine");
});

const NO_BUS = '#!/bin/sh\necho "$*" >>"$FAKE_DB.systemctl.log"\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n';

test("linux without a user manager stops before touching anything", () => {
  // `sudo -iu ci` or `su - ci`: no session bus, so every `systemctl --user` fails (dev manager, #87).
  const { d, db, env } = linuxProject();
  writeFileSync(join(binOf(env), "systemctl"), NO_BUS);
  const n = names(d, env);
  for (const cmd of ["install", "uninstall", "stop", "status"]) {
    const [rc, out] = ci(d, env, cmd);
    expect(rc, `${cmd} ${out}`).not.toBe(0);
    contains(out, "user manager", "machinectl shell", "enable-linger", "XDG_RUNTIME_DIR=/run/user/");
    lacks(out, "Installed", "removed", "stopped");
  }
  expect(existsSync(n.CI_UNIT_FILE as string) || existsSync(n.CI_INSTALLED as string), "nothing written").toBe(false);
  const calls = log(db, "systemctl").split("\n").filter((l) => l);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c === "--user show-environment"), calls.join("\n")).toBe(true);
});

test("linux status --json names the systemd service and a missing user manager is a code message fix", () => {
  const { d, db, env } = linuxProject();
  expect(ci(d, env, "install")[0]).toBe(0);
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]' } });
  runsAndPulls(db, [run("main")], [], []);
  const [rc, j, out] = ciJson(d, env);
  expect(rc, out).toBe(0);
  expect((j.instances as Json[])[0]).toEqual({ id: "1", name: "widget-ci", state: "running", manager: "systemd", pid: 4343 });
  writeFileSync(join(binOf(env), "systemctl"), NO_BUS);
  const p = sh(["bash", CI, "status", "--json"], { cwd: d, env, timeoutMs: 120_000 });
  expect(p.code).toBe(1);
  expect(p.stdout).toBe("");
  const e = JSON.parse(p.stderr.trim()) as Json;
  expect(e.code).toBe("no_user_manager");
  expect(String(e.fix)).toContain("enable-linger");
});

test("linux install starts the loop once and escapes the unit", () => {
  const { d, db, env } = linuxProject();
  env.HOME = join(env.HOME as string, "50%$off"); // % and $ mean something to systemd
  mkdirSync(env.HOME);
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  const sc = log(db, "systemctl");
  expect(sc).toContain("--user enable widget-ci.service");
  expect(sc).not.toContain("enable --now");
  expect(sc.indexOf("--user enable widget-ci.service")).toBeLessThan(sc.indexOf("--user restart widget-ci.service"));
  const n = names(d, env);
  const unit = readFileSync(n.CI_UNIT_FILE as string, "utf8");
  expect(unit).not.toContain("network-online");
  expect((unit.split("ExecStart=")[1] as string).split("\n")[0]).toContain('/50%%$$off/.local/share/widget-ci/widget-ci"');
  expect(unit).toContain("WorkingDirectory=" + (n.CI_INSTALLED as string).replaceAll("%", "%%") + "\n");
  expect(unit).toContain("append:" + (n.CI_STATE as string).replaceAll("%", "%%") + "/runner.log");
});

// --- several runners and the light lane (#67, #90) ------------------------------------------------------------------

function agentsDir(env: Env): string {
  return join(env.HOME as string, "Library", "LaunchAgents");
}

function plistEnv(env: Env, label: string): Record<string, string> {
  return loadPlist(join(agentsDir(env), `${label}.plist`)).EnvironmentVariables as Record<string, string>;
}

function agentLabels(env: Env): string[] {
  return readdirSync(agentsDir(env)).map((f) => f.slice(0, -6)).sort();
}

test("two runners and the light lane get their own projects names and logs", () => {
  const { d, db, env } = project({ ci: { runners: 2 } });
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  const labels = agentLabels(env);
  expect(labels).toEqual(["dev.software-factory.widget-ci", "dev.software-factory.widget-ci-2", "dev.software-factory.widget-ci-light"]);
  const envs = labels.map((l) => plistEnv(env, l));
  for (const key of ["CI_PROJECT", "CI_RUNNER_PREFIX", "CI_LOG"]) {
    expect(new Set(envs.map((e) => e[key])).size, key).toBe(3); // nothing shared: own dind, volumes, workspace
  }
  const [one, two, light] = envs as [Record<string, string>, Record<string, string>, Record<string, string>];
  expect([one.CI_PROJECT, two.CI_PROJECT, light.CI_PROJECT]).toEqual(["widget-ci", "widget-ci-2", "widget-ci-light"]);
  expect([two.CI_RUNNER_PREFIX, light.CI_RUNNER_PREFIX]).toEqual(["widget-ci-test-mac.2", "widget-ci-test-mac.light"]);
  expect([one.CI_LABEL, two.CI_LABEL, light.CI_LABEL]).toEqual(["widget-local", "widget-local", "widget-light"]);
  expect([one.CI_COMPOSE, two.CI_COMPOSE, light.CI_COMPOSE]).toEqual(["compose.yaml", "compose.yaml", "compose-light.yaml"]);
  const lc = log(db, "launchctl");
  expect(lc.split("bootstrap").length - 1).toBe(3);
  contains(out, "widget-ci-2: label widget-local", "widget-ci-light: label widget-light (light jobs");
});

test("the light runner has no docker and is small", () => {
  const text = readFileSync(join(SF, "ci", "compose-light.yaml"), "utf8");
  const body = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  lacks(body, "dind", "privileged", "docker.sock");
  expect(body).toContain("RUNNER_DOCKER: '0'");
  expect(body).toMatch(/mem_limit: \d+[mg]/);
  const entry = readFileSync(join(SF, "ci", "entrypoint.sh"), "utf8");
  expect(entry).toContain('if [ "${RUNNER_DOCKER:-1}" != 0 ]');
});

function runLoopOnce(env: Env, e: Record<string, string>, exe: string, cwd: string): void {
  // One round with a given token: the fake runner fails registration (code 3), so the loop ends.
  sh(["/bin/bash", exe], { input: "given-token\n", env: { ...env, ...e, PATH: env.PATH }, timeoutMs: 60_000, cwd });
}

test("each loop runs its own compose project and registration name", () => {
  const { d, db, env } = project({ ci: { runners: 2 } });
  expect(ci(d, env, "install")[0]).toBe(0);
  const n = names(d, env);
  const exe = join(n.CI_INSTALLED as string, "widget-ci");
  for (const label of ["dev.software-factory.widget-ci-2", "dev.software-factory.widget-ci-light"]) {
    runLoopOnce(env, plistEnv(env, label), exe, n.CI_INSTALLED as string);
  }
  const dl = log(db, "docker");
  contains(dl, "--project-name widget-ci-2 up", "name widget-ci-test-mac.2-", "compose-light.yaml --project-name widget-ci-light up",
    "label widget-light", "name widget-ci-test-mac.light-");
});

test("scaling down removes extra instances and their idle registrations but waits for a busy one", () => {
  const { d, db, env } = project({ ci: { runners: 3 } });
  expect(ci(d, env, "install")[0]).toBe(0);
  const runner = (i: number, name: string, busy = false): Json => ({ id: i, name, status: "online", busy });
  update(db, { api: { "repos/acme/Widget/actions/runners": { runners: [
    runner(21, "widget-ci-test-mac.2-100"), // instance 2, idle: removed with it
    runner(31, "widget-ci-test-mac.3-100", true), // instance 3, busy: it stays for now
    runner(11, "widget-ci-test-mac-100")] } } }); // instance 1: kept
  let [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  [rc, out] = ci(d, { ...env, FACTORY_CI_RUNNERS: "1" }, "install");
  expect(rc, out).toBe(0);
  expect(agentLabels(env)).toEqual(["dev.software-factory.widget-ci", "dev.software-factory.widget-ci-3", "dev.software-factory.widget-ci-light"]);
  contains(out, "Instance 3 (widget-ci-3) is running a job", "Removed instance 2 (widget-ci-2)");
  expect(dbOf(db).deleted).toEqual(["21"]);
  contains(log(db, "launchctl"), "bootout gui/", "/dev.software-factory.widget-ci-2");
  expect(log(db, "docker")).toContain("--project-name widget-ci-2 down --volumes");
  update(db, { api: { "repos/acme/Widget/actions/runners": { runners: [] } } }); // its job ended
  [rc, out] = ci(d, { ...env, FACTORY_CI_RUNNERS: "1" }, "install");
  expect(out).toContain("Removed instance 3");
  expect(existsSync(join(agentsDir(env), "dev.software-factory.widget-ci-3.plist")), out).toBe(false);
});

test("light can be turned off and one instance uninstalled", () => {
  let { d, env } = project({ ci: { light: false } });
  expect(ci(d, env, "install")[0]).toBe(0);
  expect(readdirSync(agentsDir(env))).toEqual(["dev.software-factory.widget-ci.plist"]);
  ({ d, env } = project());
  expect(ci(d, env, "install")[0]).toBe(0);
  const [rc, out] = ci(d, env, "uninstall", "light");
  expect(rc, out).toBe(0);
  expect(out).toContain("Removed instance light");
  expect(readdirSync(agentsDir(env))).toEqual(["dev.software-factory.widget-ci.plist"]);
  expect(ci(d, env, "uninstall", "7")[0]).toBe(1);
});

test("install warns when the runners need more memory than is free", () => {
  const { d, env } = project({ ci: { runners: 3 } });
  let [rc, out] = ci(d, { ...env, FACTORY_CI_FREE_MB: "6000" }, "install");
  expect(rc, out).toBe(0);
  expect(out).toContain("Warning: 3 heavy runner(s) and the light one need about 13312 MB");
  [rc, out] = ci(d, { ...env, FACTORY_CI_FREE_MB: "64000" }, "install");
  expect(out).not.toContain("Warning");
});

test("use local also sets the light lane variable and install says it", () => {
  const { d, db, env } = project();
  let [, out] = ci(d, env, "install");
  expect(out).toContain('`factory ci use local` also sets CI_RUNS_ON_LIGHT to ["self-hosted","widget-light"]');
  [, out] = ci(d, env, "use", "local");
  const v = vars(db);
  expect([v.CI_RUNS_ON_LIGHT, v.CI_RUNS_ON]).toEqual(['["self-hosted","widget-light"]', '["self-hosted","widget-local"]']);
  [, out] = ci(d, env, "install"); // in local mode, install sets it itself
  expect(out).toContain('the repo variable CI_RUNS_ON_LIGHT is ["self-hosted","widget-light"]');
  [, out] = ci(d, env, "use", "github");
  expect("CI_RUNS_ON_LIGHT" in vars(db), out).toBe(false);
});

test("status shows the pid when launchctl goes on printing after it", () => {
  // awk must read all of launchctl's output: stopping at the pid line made launchctl die of SIGPIPE when it was
  // still writing, and with pipefail that ended `status` silently after the Mode line (flaky, faster on fast CPUs).
  const { d, db, env } = project();
  expect(ci(d, env, "install")[0]).toBe(0);
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]' } });
  runsAndPulls(db, [run("main")]);
  const slow = join(dirname(env.FAKE_DB as string), "bin", "launchctl");
  const real = readFileSync(slow, "utf8");
  writeFileSync(slow, real.replace('echo "}" ;;', 'echo "}"; sleep 0.3; echo "	more = 1" ;;'));
  // An awk that quits at the first pid line, as gawk does (mawk reads on, which hid this on some machines).
  writeExe(join(dirname(slow), "awk"), `#!/usr/bin/env bun
for await (const line of console) {
  const f = line.trim().split(/\\s+/);
  if (f[0] === "pid" && f[1] === "=") { await Bun.write(Bun.stdout, f[2] + "\\n"); process.exit(0); }
}
`);
  const [rc, out] = ci(d, env, "status");
  expect(rc, out).toBe(0);
  expect(out).toContain("Runner widget-ci: running (LaunchAgent dev.software-factory.widget-ci, pid 4242)");
});

test("status lists every instance and logs takes one", () => {
  const { d, db, env } = project({ ci: { runners: 2 } });
  expect(ci(d, env, "install")[0]).toBe(0);
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]' } });
  runsAndPulls(db, [run("main")], [], [{ name: "widget-ci-test-mac.light-1", status: "online", busy: false,
    labels: [{ name: "self-hosted" }, { name: "widget-light" }] }]);
  let [rc, out] = ci(d, env, "status");
  contains(out, "Runner widget-ci: running (LaunchAgent dev.software-factory.widget-ci, pid 4242)",
    "Runner widget-ci-2: running (LaunchAgent dev.software-factory.widget-ci-2, pid 4242)",
    "Runner widget-ci-light (light lane, label widget-light): running",
    "Light lane (widget-light, the Factory guard):", "widget-ci-test-mac.light-1: online");
  const n = names(d, env);
  writeFileSync(join(n.CI_STATE as string, "runner-2.log"), "round 9: job done\n");
  [rc, out] = ci(d, env, "logs", "2");
  expect(rc, out).toBe(0);
  expect(out).toContain("round 9");
});

test("linux two runners and the light lane are user units and scale down", () => {
  const { d, db, env } = linuxProject({ ci: { runners: 2 } });
  let [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  const unitDir = join(env.HOME as string, ".config", "systemd", "user");
  expect(readdirSync(unitDir).sort()).toEqual(["widget-ci-2.service", "widget-ci-light.service", "widget-ci.service"]);
  const projects = new Set(readdirSync(unitDir).map((u) => unitEnv(join(unitDir, u)).CI_PROJECT));
  expect(projects).toEqual(new Set(["widget-ci", "widget-ci-2", "widget-ci-light"]));
  const sc = log(db, "systemctl");
  for (const u of ["widget-ci.service", "widget-ci-2.service", "widget-ci-light.service"]) {
    contains(sc, `--user enable ${u}`, `--user restart ${u}`);
  }
  update(db, { api: { "repos/acme/Widget/actions/runners": { runners: [] } } }); // GitHub says nothing is busy
  [rc, out] = ci(d, { ...env, FACTORY_CI_RUNNERS: "1" }, "install");
  expect(rc, out).toBe(0);
  expect(readdirSync(unitDir).sort()).toEqual(["widget-ci-light.service", "widget-ci.service"]);
  expect(log(db, "systemctl")).toContain("--user disable --now widget-ci-2.service");
});

test("turning the light lane off removes its variable and status flags a stale one", () => {
  // (#91 review) Otherwise every Factory guard waits for a runner that no longer exists.
  const { d, db, env } = project();
  expect(ci(d, env, "install")[0]).toBe(0);
  expect(ci(d, env, "use", "local")[0]).toBe(0);
  expect("CI_RUNS_ON_LIGHT" in vars(db)).toBe(true);
  writeFileSync(join(d, ".claude", "factory.json"), JSON.stringify({ ci: { light: false } }));
  let [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  expect("CI_RUNS_ON_LIGHT" in vars(db)).toBe(false);
  expect(out).toContain("deleted the repo variable CI_RUNS_ON_LIGHT");
  // use local with the light lane off deletes it too
  update(db, { vars: { CI_RUNS_ON_LIGHT: '["self-hosted","widget-light"]' } });
  [rc, out] = ci(d, env, "use", "local");
  expect("CI_RUNS_ON_LIGHT" in vars(db), out).toBe(false);
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]', CI_RUNS_ON_LIGHT: '["self-hosted","widget-light"]' } });
  // status: a set CI_RUNS_ON_LIGHT that no online runner has is flagged, whatever ci.light says
  runsAndPulls(db, [run("main")], [], []);
  [rc, out] = ci(d, env, "status");
  expect(out).toContain("CI_RUNS_ON_LIGHT asks for widget-light, and no runner with that label is online");
});

test("light variable that gh cant delete is a persons step", () => {
  const { d, db, env } = project({ ci: { light: false } });
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]', CI_RUNS_ON_LIGHT: '["self-hosted","widget-light"]' },
    no_delete: true });
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  expect(out).toContain("Delete the repo variable CI_RUNS_ON_LIGHT");
});

test("registration prefixes dont collide between hosts foo and foo 2", () => {
  // Instance 2 on `foo` and instance 1 on `foo-2` must never match each other (#91 review).
  const { d, db, env } = project({ ci: { runners: 2 } });
  writeFileSync(join(binOf(env), "scutil"), "#!/bin/sh\necho foo\n");
  expect(ci(d, env, "install")[0]).toBe(0);
  const runner = (i: number, name: string, busy = false): Json => ({ id: i, name, status: "online", busy });
  update(db, { api: { "repos/acme/Widget/actions/runners": { runners: [
    runner(1, "widget-ci-foo-2-100", true), // instance 1 on machine foo-2, busy
    runner(2, "widget-ci-foo-2-200"), // instance 1 on machine foo-2, idle
    runner(3, "widget-ci-foo.2-300")] } } }); // instance 2 on this machine (foo), idle
  const [rc, out] = ci(d, { ...env, FACTORY_CI_RUNNERS: "1" }, "install");
  expect(rc, out).toBe(0);
  expect(out).toContain("Removed instance 2"); // foo-2's busy runner didn't hold it back
  expect(dbOf(db).deleted).toEqual(["3"]); // and foo-2's idle one was left alone
});

test("a scale down that cant ask github leaves the instance alone", () => {
  const { d, db, env } = project({ ci: { runners: 2 } });
  expect(ci(d, env, "install")[0]).toBe(0);
  update(db, { fail: ["repos/acme/Widget/actions/runners"] });
  const [rc, out] = ci(d, { ...env, FACTORY_CI_RUNNERS: "1" }, "install");
  expect(rc, out).toBe(0);
  expect(out).toContain("Can't tell whether instance 2 (widget-ci-2) is running a job");
  expect(existsSync(join(agentsDir(env), "dev.software-factory.widget-ci-2.plist"))).toBe(true);
});

test("the memory warning uses docker desktops vm on macos and counts running instances on linux", () => {
  let { d, env } = project({ ci: { runners: 3 } });
  let [rc, out] = ci(d, { ...env, FAKE_DOCKER_MEMTOTAL: String(8 * 1024 ** 3) }, "install");
  contains(out, "Docker Desktop's VM has about 8192 MB", "Warning");
  [rc, out] = ci(d, { ...env, FAKE_DOCKER_MEMTOTAL: String(32 * 1024 ** 3) }, "install");
  expect(out).not.toContain("Warning");
  ({ d, env } = linuxProject({ ci: { runners: 2 } }));
  expect(ci(d, { ...env, FACTORY_CI_FREE_MB: "64000" }, "install")[0]).toBe(0);
  // Re-install with the 2 heavy and the light instance running: only a new third needs memory.
  [rc, out] = ci(d, { ...env, FACTORY_CI_FREE_MB: "5000", FACTORY_CI_RUNNERS: "3" }, "install");
  expect(rc, out).toBe(0);
  expect(out).not.toContain("Warning");
  [rc, out] = ci(d, { ...env, FACTORY_CI_FREE_MB: "3000", FACTORY_CI_RUNNERS: "4" }, "install");
  expect(out).toContain("Warning");
});

test("the light label must differ from the heavy one", () => {
  const { d, env } = project({ ci: { lightLabel: "widget-local" } });
  const [rc, out] = ci(d, env, "names");
  expect(rc, out).not.toBe(0);
  expect(out).toContain("ci.lightLabel must differ from ci.label");
});

test("the workflow template puts the guard on the light lane and forks on github", () => {
  const text = readFileSync(join(KIT, ".github", "workflows", "ci.yml"), "utf8");
  const runsOn: Record<string, string> = {};
  for (const m of text.matchAll(/\n {2}(\w+):\n(?: {4}.*\n)*? {4}runs-on: (.*)/g)) runsOn[m[1] as string] = m[2] as string;
  const fork = "github.event.pull_request.head.repo.full_name != github.repository && '\"ubuntu-latest\"'";
  expect(runsOn.guard).toContain(fork);
  expect(runsOn.check).toContain(fork);
  expect(runsOn.guard).toContain("|| vars.CI_RUNS_ON_LIGHT || vars.CI_RUNS_ON || '\"ubuntu-latest\"'");
  expect(runsOn.check).not.toContain("CI_RUNS_ON_LIGHT");
  expect(runsOn.check).toContain("|| vars.CI_RUNS_ON || '\"ubuntu-latest\"'");
});

// --- faster rounds: a pre-built image and caches that outlive a job (#60) --------------------------------------------

function tooledProject(o: { ci?: Json } = {}): Project {
  const p = project(o);
  writeFileSync(join(p.d, ".nvmrc"), "24\n");
  writeFileSync(join(p.d, "package.json"), JSON.stringify({ packageManager: "pnpm@9.12.0+sha512.abc" }));
  writeFileSync(join(p.d, "pnpm-lock.yaml"), "  '@playwright/test@1.48.2':\n");
  return p;
}

test("the start script can be read by the runner container whose user is not the owner", () => {
  // The runner image's user (uid 1001) is not the person who installed, so a 0600 entrypoint.sh gave the container
  // `/bin/bash: /opt/factory-ci/entrypoint.sh: Permission denied` (exit 126) and no runner ever came online.
  // It holds no secret (the token comes in the environment), and the folder around it stays 0700.
  const { d, env } = linuxProject();
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  const n = names(d, env);
  const m = (f: string): number => mode(join(n.CI_INSTALLED as string, f));
  expect(m("entrypoint.sh") & 0o444).toBe(0o444);
  expect(m("entrypoint.sh") & 0o022, "readable by everyone, writable by no one else").toBe(0);
  expect(mode(n.CI_INSTALLED as string)).toBe(0o700);
  expect(m("compose.yaml")).toBe(0o600);
  expect(m("widget-ci")).toBe(0o700);
});

/** Every file the installed compose files bind-mount into a container (`- ./file:/path[:ro]`). */
function mountedFiles(installed: string): string[] {
  const found = new Set<string>();
  for (const name of readdirSync(installed)) {
    if (name.startsWith("compose") && name.endsWith(".yaml")) {
      for (const m of readFileSync(join(installed, name), "utf8").matchAll(/^\s*-\s+\.\/([^:\s]+):/gm)) found.add(m[1] as string);
    }
  }
  return [...found].sort();
}

/** What a container user who is not the file's owner (the runner image's uid 1001) can do with a bind-mounted file:
 * the others bits decide. (The folder around it does not matter: the Docker daemon mounts the file itself.) */
function seenByAnotherUser(path: string): { read: boolean; write: boolean } {
  const m = mode(path);
  return { read: Boolean(m & 0o004), write: Boolean(m & 0o002) };
}

test("every file a compose file mounts is readable and not writable by the containers user", () => {
  const { d, env } = linuxProject();
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  const installed = names(d, env).CI_INSTALLED as string;
  const mounts = mountedFiles(installed);
  expect(mounts).toContain("entrypoint.sh"); // the parse found the real mounts
  for (const f of mounts) {
    expect(existsSync(join(installed, f)), `compose mounts ${f}, but install did not copy it`).toBe(true);
    expect(seenByAnotherUser(join(installed, f)), f).toEqual({ read: true, write: false });
  }
});

test("a file added to a compose mount later is readable too without touching the install code", () => {
  const { d, env } = linuxProject();
  const kit = join(tmp(), "ci");
  cpSync(join(SF, "ci"), kit, { recursive: true, filter: (src) => !src.includes("__pycache__") });
  writeFileSync(join(kit, "extra.sh"), "#!/bin/bash\n");
  chmodSync(join(kit, "extra.sh"), 0o600); // as a private checkout or a umask 077 could leave it
  for (const yaml of ["compose.yaml", "compose-light.yaml"]) {
    const text = readFileSync(join(kit, yaml), "utf8").replace("      - ./entrypoint.sh:/opt/factory-ci/entrypoint.sh:ro\n",
      "      - ./entrypoint.sh:/opt/factory-ci/entrypoint.sh:ro\n      - ./extra.sh:/opt/factory-ci/extra.sh:ro\n");
    writeFileSync(join(kit, yaml), text);
  }
  const p = sh(["bash", join(kit, "ci.sh"), "install"], { cwd: d, env, timeoutMs: 120_000 });
  expect(p.code, p.out).toBe(0);
  const installed = names(d, env).CI_INSTALLED as string;
  expect(mountedFiles(installed)).toContain("extra.sh");
  expect(seenByAnotherUser(join(installed, "extra.sh"))).toEqual({ read: true, write: false });
});

test("install builds the runner image with the projects tools", () => {
  const { d, db, env } = tooledProject();
  const [rc, out] = ci(d, env, "install");
  expect(rc, out).toBe(0);
  const dl = log(db, "docker");
  contains(dl, "build --quiet --tag widget-ci-runner:latest");
  for (const arg of ["NODE_VERSION=24", "PNPM_VERSION=9.12.0", "PLAYWRIGHT_VERSION=1.48.2"]) contains(dl, `--build-arg ${arg}`);
  const heavy = plistEnv(env, "dev.software-factory.widget-ci");
  const light = plistEnv(env, "dev.software-factory.widget-ci-light");
  expect([heavy.RUNNER_IMAGE, heavy.CI_CACHES]).toEqual(["widget-ci-runner:latest", "1"]);
  expect([light.RUNNER_IMAGE, light.CI_CACHES]).toEqual(["", "0"]); // the light lane stays plain and small
  const n = names(d, env);
  for (const f of ["runner.Dockerfile", "install-tools.sh", "compose-caches.yaml"]) {
    expect(existsSync(join(n.CI_INSTALLED as string, f)), f).toBe(true);
  }
});

test("a failed build falls back to the plain image and the settings turn it all off", () => {
  let { d, db, env } = tooledProject();
  const [rc, out] = ci(d, { ...env, FAKE_DOCKER_BUILD_FAILS: "1" }, "install");
  expect(rc, out).toBe(0);
  expect(out).toContain("the runner image didn't build");
  expect(plistEnv(env, "dev.software-factory.widget-ci").RUNNER_IMAGE).toBe("");
  ({ d, db, env } = tooledProject({ ci: { image: "base", caches: false } }));
  expect(ci(d, env, "install")[0]).toBe(0);
  expect(log(db, "docker")).not.toContain(" build ");
  expect(plistEnv(env, "dev.software-factory.widget-ci").CI_CACHES).toBe("0");
});

test("only the registry mirror outlives a job and no job shares a network or a writable store", () => {
  const ciDir = join(SF, "ci");
  const caches = readFileSync(join(ciDir, "compose-caches.yaml"), "utf8");
  const base = readFileSync(join(ciDir, "compose.yaml"), "utf8");
  const body = (caches + base).split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  // No workspace mount, and no pnpm store (a job could poison it for later jobs; #92 review).
  lacks(body, "_work", "pnpm");
  expect(readFileSync(join(ciDir, "entrypoint.sh"), "utf8")).not.toContain("npm_config_store_dir");
  expect([...caches.matchAll(/^ {2}(\S+):\n {4}external: true/gm)].map((m) => m[1])).toEqual(["cache"]);
  expect(caches).toContain("--registry-mirror=http://${CI_MIRROR:?}:5000");
  const loop = readFileSync(join(ciDir, "loop.sh"), "utf8");
  expect(loop, "each instance its own network").toContain('CI_CACHE_NETWORK="$project-cache"');
  expect(loop).toContain("MIRROR_IMAGE=registry:2.");
  expect(loop, "pinned").toMatch(/registry:2\.\d+\.\d+/);
  expect(loop).toContain('docker network connect "$CI_CACHE_NETWORK" "$CI_MIRROR"');
  const dockerFile = readFileSync(join(ciDir, "runner.Dockerfile"), "utf8");
  contains(dockerFile, "RUNNER_TOOL_CACHE=/opt/hostedtoolcache", "PLAYWRIGHT_BROWSERS_PATH");
  // The jobs' user owns the browsers: Playwright's install writes a lock there even when they're present.
  expect(dockerFile).toMatch(/chown -R runner:runner [^\n]*\/ms-playwright/);
  expect(dockerFile).not.toContain("a+rX /ms-playwright");
  expect(dockerFile).toContain('LABEL factory.node="$NODE_VERSION"');
  expect(readFileSync(join(ciDir, "install-tools.sh"), "utf8")).toContain(".complete");
});

test("two instances get their own cache networks", () => {
  const { d, db, env } = project({ ci: { runners: 2 } });
  expect(ci(d, env, "install")[0]).toBe(0);
  const n = names(d, env);
  const exe = join(n.CI_INSTALLED as string, "widget-ci");
  for (const label of ["dev.software-factory.widget-ci", "dev.software-factory.widget-ci-2"]) {
    runLoopOnce(env, plistEnv(env, label), exe, n.CI_INSTALLED as string);
  }
  const dl = log(db, "docker");
  contains(dl, "network inspect widget-ci-cache", "network inspect widget-ci-2-cache",
    "network connect widget-ci-cache widget-ci-mirror", "network connect widget-ci-2-cache widget-ci-mirror", "registry:2.8.3");
  lacks(dl, "volume create");
});

test("status says when the image is older than the checkouts tools", () => {
  const { d, db, env } = tooledProject();
  expect(ci(d, env, "install")[0]).toBe(0);
  update(db, { vars: { CI_RUNS_ON: '["self-hosted","widget-local"]' } });
  runsAndPulls(db, [run("main")], [], []);
  const old = "node=22 pnpm=9.12.0 playwright=1.48.2";
  let [, out] = ci(d, { ...env, FAKE_DOCKER_IMAGE_LABELS: old }, "status");
  expect(out).toContain(`Runner image: built for ${old}, and this checkout wants node=24 pnpm=9.12.0 playwright=1.48.2`);
  [, out] = ci(d, { ...env, FAKE_DOCKER_IMAGE_LABELS: "node=24 pnpm=9.12.0 playwright=1.48.2" }, "status");
  expect(out).not.toContain("Runner image:");
});

// A Docker that keeps state in files: a project's volumes and workspace live in $STATE/<project>/ until
// `down --volumes`. Each `up` is one job: it says whether it can see the last job's file, then writes its own.
const STATEFUL_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_DB.docker.log"
st="$FAKE_DOCKER_STATE"; mkdir -p "$st/volumes"
project=""; prev=""
for a in "$@"; do [ "$prev" = --project-name ] && project="$a"; prev="$a"; done
case " $* " in
  *" up "*)
    ws="$st/$project/workspace"; mkdir -p "$ws"
    [ -e "$ws/job-file" ] && echo "SAW the last job's file" >>"$FAKE_DB.jobs.log" || echo "clean workspace" >>"$FAKE_DB.jobs.log"
    echo secret >"$ws/job-file"
    exit 0 ;;
  *" down "*"--volumes"*) rm -rf "\${st:?}/$project" ;;
esac
exit 0
`;

test("a job never sees the last jobs files", async () => {
  const { d, db, env } = project();
  expect(ci(d, env, "install")[0]).toBe(0);
  const n = names(d, env);
  const e = plistEnv(env, "dev.software-factory.widget-ci");
  const bin2 = tmp();
  writeExe(join(bin2, "docker"), STATEFUL_DOCKER);
  const runEnv = clean({ ...env, ...e, PATH: `${bin2}:${env.PATH}`, FAKE_DOCKER_STATE: tmp() });
  const loop = Bun.spawn(["/bin/bash", join(n.CI_INSTALLED as string, "widget-ci")], { stdin: "ignore", env: runEnv,
    cwd: n.CI_INSTALLED as string, stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 200; i++) {
      if (log(db, "jobs").split("\n").filter((l) => l).length >= 3) break; // three jobs
      await Bun.sleep(100);
    }
  } finally {
    loop.kill("SIGTERM");
    await Promise.race([loop.exited, Bun.sleep(20_000)]);
  }
  const jobs = log(db, "jobs").split("\n").filter((l) => l);
  expect(jobs.slice(0, 3)).toEqual(["clean workspace", "clean workspace", "clean workspace"]);
  expect(jobs.join("")).not.toContain("SAW");
});

test("stale is quiet when no service is installed and when the copies match the checkout", () => {
  const { d, env } = linuxProject();
  expect(ci(d, env, "stale")).toEqual([0, ""]); // nothing installed here: nothing to refresh
  expect(ci(d, env, "install")[0]).toBe(0);
  expect(ci(d, env, "stale")).toEqual([0, ""]); // just installed: the copies equal the checkout
});

test("stale names a service copy that is older than the checkout and install fixes it", () => {
  const { d, env } = linuxProject();
  expect(ci(d, env, "install")[0]).toBe(0);
  const installed = names(d, env).CI_INSTALLED as string;
  appendFileSync(join(installed, "compose.yaml"), "# an older version\n");
  rmSync(join(installed, "install-tools.sh"));
  const [rc, out] = ci(d, env, "stale");
  expect(rc, out).toBe(3);
  contains(out, "older", "compose.yaml", "missing", "install-tools.sh");
  expect(ci(d, env, "install")[0]).toBe(0);
  expect(ci(d, env, "stale")).toEqual([0, ""]);
});

test("check passes on a fresh install and names a start script the container cannot read", () => {
  const { d, env } = linuxProject();
  expect(ci(d, env, "check")[0]).toBe(0); // nothing installed: nothing to check
  expect(ci(d, env, "install")[0]).toBe(0);
  let [rc, out] = ci(d, env, "check");
  expect(rc, out).toBe(0);
  const entry = join(names(d, env).CI_INSTALLED as string, "entrypoint.sh");
  chmodSync(entry, 0o600); // what #111 was: the runner container's user cannot read it
  [rc, out] = ci(d, env, "check");
  expect(rc, out).toBe(1);
  contains(out, "entrypoint.sh", "can't read");
  chmodSync(entry, 0o666);
  [rc, out] = ci(d, env, "check");
  expect(rc, out).toBe(1);
  contains(out, "entrypoint.sh", "writable");
});

test("check starts the installed start script in the runner image as the containers user", () => {
  const { d, db, env } = linuxProject();
  expect(ci(d, env, "install")[0]).toBe(0);
  const labels = { ...env, FAKE_DOCKER_IMAGE_LABELS: "node=20 pnpm=9 playwright=none" };
  writeFileSync(db + ".docker.log", "");
  let [rc, out] = ci(d, labels, "check");
  const runs = log(db, "docker").split("\n").filter((l) => ` ${l} `.includes(" run "));
  expect(rc, out).toBe(0);
  expect(runs.length, runs.join("\n")).toBe(1);
  const entry = join(names(d, env).CI_INSTALLED as string, "entrypoint.sh");
  contains(runs[0] as string, `${entry}:/opt/factory-ci/entrypoint.sh:ro`,
    "--entrypoint /bin/bash widget-ci-runner:latest -n /opt/factory-ci/entrypoint.sh", "--network none");
  expect(runs[0]).not.toContain("--user"); // the image's own user, as the service runs it
  [rc, out] = ci(d, { ...labels, FAKE_DOCKER_RUN_FAILS: "1" }, "check");
  expect(rc, out).toBe(1);
  contains(out, "runner container", "Permission denied");
});

test("check skips the container probe when docker is off or the image is not here", () => {
  const { d, db, env } = linuxProject();
  expect(ci(d, env, "install")[0]).toBe(0);
  writeFileSync(db + ".docker.log", "");
  expect(ci(d, env, "check")[0]).toBe(0); // no image on this machine
  expect(log(db, "docker")).not.toContain(" run ");
  expect(ci(d, { ...env, FAKE_DOCKER_IMAGE_LABELS: "x", FAKE_DOCKER_UP: "0", FAKE_DOCKER_RUN_FAILS: "1" }, "check")[0]).toBe(0);
});

test("factory help lists the ci commands", () => {
  const out = sh(["bash", join(SF, "factory"), "help"], { cwd: project().d }).stdout;
  for (const c of ["ci status", "ci use local|github", "ci install", "ci uninstall", "ci start | stop", "ci logs"]) {
    expect(out, c).toContain(c);
  }
});

test("factory help and the commands page list ci status --json", () => {
  const out = sh(["bash", join(SF, "factory"), "help"], { cwd: project().d }).stdout;
  expect(out).toContain("ci status [--json]");
  expect(readFileSync(join(SF, "docs", "wiki", "commands.md"), "utf8")).toContain("| `factory ci status [--json]` |");
});
