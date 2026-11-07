// The owner's actions (#309, PRD US-11): `factory owner start|stop` and `owner merge --head`, which the web UI runs too.
// gh is a small fake with a JSON db and a log of every call; tmux is a fake on PATH that logs every call and remembers
// whether a session was started. Nothing real is called.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CI, copyHookFolders, envWith, gitRepo, HOOKS, read, SF, sh, tmp, WIKI, write, type Proc } from "./support.ts";

const T = 120_000;
type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;
interface Proj { root: string; d: string; env: Env; ghLog: string; tmuxDir: string }

const SHA = "0123456789abcdef0123456789abcdef01234567";
const STALE = "fedcba9876543210fedcba9876543210fedcba98";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const file = process.env.FAKE_DB as string;
const db = JSON.parse(readFileSync(file, "utf8"));
const valueFlags = new Set(["-X", "--method", "-H", "--header", "--input", "-q", "--jq", "-f", "-F", "--json"]);
let stdin = "";
if (a.includes("--input")) stdin = await Bun.stdin.text();
appendFileSync(process.env.FAKE_GH_LOG as string, JSON.stringify({ argv: a, stdin }) + "\n");
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
const fail = (m: string): never => { process.stderr.write(m + "\n"); process.exit(1); };
const save = () => writeFileSync(file, JSON.stringify(db));
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] === "pr" && a[1] === "merge") { (db.merged ??= []).push(a.slice(2)); save(); process.exit(0); }
if (a[0] !== "api") fail("unexpected gh " + a.join(" "));
let method = "GET"; let path = "";
for (let i = 1; i < a.length; i++) {
  const x = a[i] as string;
  if (x === "-X" || x === "--method") method = a[++i] as string;
  else if (valueFlags.has(x)) i++;
  else if (x.startsWith("-")) continue;
  else if (!path) path = x;
}
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = decodeURIComponent(u.pathname.slice(1)); const page = Number(u.searchParams.get("page") ?? "1");
const paged = (xs: unknown[]) => out(a.includes("--paginate") || page === 1 ? xs : []);
let m: RegExpExecArray | null;
if (p === "contents/.claude/factory.json") fail("gh: Not Found (HTTP 404)");
if ((m = /^pulls\/(\d+)$/.exec(p))) { const pr = db.prs?.[m[1] as string]; if (!pr) fail("gh: Not Found (HTTP 404)"); out(pr); }
if ((m = /^pulls\/(\d+)\/files$/.exec(p))) paged([{ filename: "src/a.ts" }]);
if ((m = /^commits\/([0-9a-f]+)\/check-runs$/.exec(p))) out({ check_runs: db.checkRuns?.[m[1] as string] ?? [] });
if ((m = /^commits\/([0-9a-f]+)\/status$/.exec(p))) out({ statuses: [] });
if (p === "labels" && method === "GET") paged((db.labels ?? []).map((name: string) => ({ name })));
if ((m = /^issues\/(\d+)\/comments$/.exec(p))) {
  if (method === "POST") { (db.posted ??= []).push({ issue: m[1], body: JSON.parse(stdin).body }); save(); out({ id: 1 }); }
  paged([]);
}
if ((m = /^issues\/(\d+)\/labels$/.exec(p)) && method === "POST") { (db.labelled ??= []).push({ issue: m[1], ...JSON.parse(stdin) }); save(); out([]); }
if ((m = /^issues\/(\d+)\/labels\/(.+)$/.exec(p)) && method === "DELETE") { (db.unlabelled ??= []).push({ issue: m[1], label: m[2] }); save(); out([]); }
if (p === "issues" && method === "GET") paged(db.issues ?? []);
if ((m = /^issues\/(\d+)$/.exec(p)) && method === "GET") {
  const i = (db.issues ?? []).find((x: { number: number }) => String(x.number) === m![1]);
  if (!i) fail("gh: Not Found (HTTP 404)"); out(i);
}
fail("gh: Not Found (HTTP 404) for " + method + " " + path);
`;

// has-session succeeds when FAKE_HAS is set, a session was started (new-session) and not killed since, or the session is
// one of FAKE_RUNNING (space-separated session names).
const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_TMUX_DIR/tmux.log"
case "$1" in
  -V) echo "tmux 3.4" ;;
  has-session) [ -n "$FAKE_HAS" ] || [ -e "$FAKE_TMUX_DIR/up" ] || case " $FAKE_RUNNING " in *" \${3#=} "*) true ;; *) false ;; esac ;;
  list-sessions) if [ -n "$FAKE_HAS" ] || [ -e "$FAKE_TMUX_DIR/up" ]; then echo work-taytu; fi ;;
  new-session) touch "$FAKE_TMUX_DIR/up" ;;
  kill-session) rm -f "$FAKE_TMUX_DIR/up" ;;
esac
`;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GREEN = [{ name: "build", status: "completed", conclusion: "success", started_at: "2026-10-25T10:00:00Z", id: 1 }];
const DB: Obj = {
  prs: { "7": { number: 7, state: "open", draft: false, mergeable: true, mergeable_state: "clean", title: "A change", head: { sha: SHA, ref: "task/x" }, body: "" } },
  checkRuns: { [SHA]: GREEN },
  labels: ["factory:ready", "factory:blocked"],
  issues: [{ number: 12, state: "open", title: "A task", labels: [] }],
};

/** A project named "work" (so its tmux sessions are work-<name>) with the hooks copied, fake gh and tmux on PATH. */
function setup(o: { has?: boolean } = {}): Proj {
  const root = tmp();
  roots.push(root);
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] }));
  const bin = join(root, "bin");
  write(join(bin, "gh"), FAKE_GH, 0o755);
  write(join(bin, "tmux"), FAKE_TMUX, 0o755);
  const tmuxDir = join(root, "tmuxlog");
  mkdirSync(tmuxDir);
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "db.json"), JSON.stringify(DB));
  const ghLog = join(root, "gh.log");
  writeFileSync(ghLog, "");
  const env = envWith(bin, { FAKE_DB: join(root, "db.json"), FAKE_GH_LOG: ghLog, FAKE_TMUX_DIR: tmuxDir, FAKE_HAS: o.has ? "1" : undefined,
    XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, FACTORY_ROLE: undefined, FACTORY_NAME: undefined, FACTORY_WINDOW: undefined,
    FACTORY_ITEM: undefined, CLAUDECODE: undefined, CLAUDE_PROJECT_DIR: undefined,
    FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: undefined, TMUX: undefined, NO_COLOR: undefined });
  return { root, d, env, ghLog, tmuxDir };
}

const OWNER: Env = {};
const MANAGER: Env = { FACTORY_AGENT: "lead", FACTORY_ROLE: "dev-manager" };
const CODER: Env = { FACTORY_AGENT: "menelik" };

function owner(p: Proj, who: Env, ...args: string[]): Proc {
  return sh([process.execPath, "--no-env-file", "--config=/dev/null", join(p.d, ".claude", "hooks", "factory_owner.ts"), ...args],
    { cwd: p.d, env: { ...p.env, ...who } });
}

function ghCalls(p: Proj): { argv: string[]; stdin: string }[] {
  return readFileSync(p.ghLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string });
}
const merges = (p: Proj) => ghCalls(p).filter((c) => c.argv[0] === "pr" && c.argv[1] === "merge");

function tmuxLines(p: Proj): string[] {
  const f = join(p.tmuxDir, "tmux.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
}
const tmuxCalled = (p: Proj, sub: string) => tmuxLines(p).filter((l) => l.split(" ").includes(sub));
const changedTmux = (p: Proj) => tmuxLines(p).filter((l) => /(^| )(new-session|kill-session|send-keys)( |$)/.test(l));

function err(r: Proc): { code: string; message: string; fix: string } {
  const line = r.stderr.trim().split("\n").filter(Boolean).pop() ?? "";
  const j: unknown = JSON.parse(line);
  expect(typeof j === "object" && j !== null, r.out).toBe(true);
  return j as { code: string; message: string; fix: string };
}

function refused(r: Proc, code: string): void {
  expect(r.code, r.out).not.toBe(0);
  const e = err(r);
  expect(e.code).toBe(code);
  expect(e.message.length).toBeGreaterThan(0);
  expect(e.fix.length).toBeGreaterThan(0);
}

// --- A: factory owner merge --head ---------------------------------------------------------------------------------------

test("owner merge --head refuses a pull request whose head moved: pr_changed names the new head and nothing is merged", () => {
  const p = setup();
  const r = owner(p, OWNER, "merge", "7", "--head", STALE);
  refused(r, "pr_changed");
  expect(err(r).message).toContain(SHA.slice(0, 7));
  expect(merges(p)).toEqual([]);
});

test("owner merge --head merges when the head is the same, in full or as a 7+ character prefix", () => {
  for (const given of [SHA, SHA.slice(0, 7), SHA.slice(0, 12)]) {
    const p = setup();
    const r = owner(p, OWNER, "merge", "7", "--head", given);
    expect(r.code, r.out).toBe(0);
    expect(merges(p).map((c) => c.argv)).toEqual([["pr", "merge", "7", "--merge", "--delete-branch", "--match-head-commit", SHA]]);
  }
});

test("owner merge --head with no value is refused with needs_head", () => {
  const p = setup();
  refused(owner(p, OWNER, "merge", "7", "--head"), "needs_head");
  expect(merges(p)).toEqual([]);
});

// --- A: factory owner start ----------------------------------------------------------------------------------------------

test("owner start starts the role's loop in its own tmux session and window, says so, and does not attach", () => {
  const p = setup();
  const r = owner(p, OWNER, "start", "coding-agent", "taytu");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("Started coding-agent-taytu");
  const made = tmuxCalled(p, "new-session");
  expect(made).toHaveLength(1);
  const line = made[0] as string;
  expect(line).toMatch(/(^| )-d( |$)/);
  expect(line).toContain("-s work-taytu ");
  expect(line).toContain("-n coding-agent-taytu ");
  const command = line.replace(/'/g, "");
  expect(command).toContain("factory loop -i");
  expect(command).toContain("FACTORY_ROLE=coding-agent");
  expect(command).toContain("FACTORY_NAME=taytu");
  expect(command).toContain("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1"); // the survey would swallow `factory say` (#558)
  expect(tmuxCalled(p, "attach-session")).toEqual([]);
  expect(tmuxCalled(p, "switch-client")).toEqual([]);
});

test("owner start works for the dev manager and product owner roles too", () => {
  for (const role of ["dev-manager", "product-owner"]) {
    const p = setup();
    const r = owner(p, OWNER, "start", role, "zemen");
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain(`Started ${role}-zemen`);
    expect((tmuxCalled(p, "new-session")[0] ?? "").replace(/'/g, "")).toContain(`FACTORY_ROLE=${role}`);
  }
});

test("owner start of a session that is already running is refused with already_running and starts nothing", () => {
  const p = setup({ has: true });
  const r = owner(p, OWNER, "start", "coding-agent", "taytu");
  refused(r, "already_running");
  expect(err(r).message.toLowerCase()).toContain("already running");
  expect(err(r).message).toContain("work-taytu");
  expect(err(r).fix).toContain("factory owner stop taytu");
  expect(tmuxCalled(p, "new-session")).toEqual([]);
});

// systemctl and loginctl fakes: every call logged, an enabled unit is a file (as in autostart_support.ts)
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_TMUX_DIR/systemctl.log"
d="$FAKE_TMUX_DIR/systemd"; mkdir -p "$d"
[ "$1" = "--user" ] || exit 1
shift
case "$1" in
  enable) u="$2"; [ "$2" = "--now" ] && u="$3"; echo 1 >"$d/$u" ;;
  is-enabled) [ -f "$d/\${3:-$2}" ] ;;
esac
`;

function withServices(p: Proj): Env {
  write(join(p.root, "bin", "systemctl"), FAKE_SYSTEMCTL, 0o755);
  write(join(p.root, "bin", "loginctl"), '#!/bin/sh\n[ "$1" = show-user ] && echo yes\nexit 0\n', 0o755);
  return { FACTORY_SETUP_HEARTBEAT: undefined, FACTORY_AUTOSTART_PLATFORM: "linux" };
}

function systemctlCalls(p: Proj): string[] {
  const f = join(p.tmuxDir, "systemctl.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
}

test("owner start installs and starts the heartbeat daemon first, and a second start does not install it again", () => {
  const p = setup();
  const env = withServices(p);
  const r = owner(p, { ...OWNER, ...env }, "start", "coding-agent", "taytu");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("heartbeat: Installed");
  expect(systemctlCalls(p)).toContain("--user enable --now work-factory-heartbeat.service");
  const unit = read(join(p.root, "config", "systemd", "user", "work-factory-heartbeat.service"));
  expect(unit).toContain("heartbeat run");
  // installed, its daemon not running yet (no state file): the second start starts it, and writes nothing again
  rmSync(join(p.tmuxDir, "up")); // the fake tmux has one session at a time: taytu's has ended
  const again = owner(p, { ...OWNER, ...env }, "start", "coding-agent", "menelik");
  expect(again.code, again.out).toBe(0);
  expect(systemctlCalls(p).filter((l) => l.startsWith("--user enable "))).toHaveLength(1);
  expect(systemctlCalls(p)).toContain("--user start work-factory-heartbeat.service");
});

test("owner start of a running session refuses before it touches the heartbeat service", () => {
  const p = setup({ has: true });
  const env = withServices(p);
  refused(owner(p, { ...OWNER, ...env }, "start", "coding-agent", "taytu"), "already_running");
  expect(systemctlCalls(p)).toEqual([]);
});

test("owner start says why the heartbeat daemon can't run, with the fix, and still starts the session", () => {
  const p = setup();
  const env = withServices(p);
  // systemd's user manager can't be reached (a user switched to with su, no login session)
  write(join(p.root, "bin", "systemctl"), '#!/bin/sh\necho "$*" >>"$FAKE_TMUX_DIR/systemctl.log"\necho "Failed to connect to bus" >&2\nexit 1\n', 0o755);
  const r = owner(p, { ...OWNER, ...env }, "start", "coding-agent", "taytu");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("heartbeat: NOT running (no-user-manager)");
  expect(r.stdout).toContain("Fix:");
  expect(systemctlCalls(p).filter((l) => l.startsWith("--user enable "))).toEqual([]);
  expect(tmuxCalled(p, "new-session")).toHaveLength(1);
});

test("owner start refuses a role that is not one of the three, and asks nothing of tmux", () => {
  const p = setup();
  refused(owner(p, OWNER, "start", "wizard", "taytu"), "bad_role");
  expect(changedTmux(p)).toEqual([]);
});

// #581: this machine's maxCodingAgents caps how many coding agents run here at once.
function capped(p: Proj, max: number): void {
  write(join(p.root, "config", "software-factory", "work.json"), JSON.stringify({ maxCodingAgents: max }));
}

test("owner start of one coding agent more than this machine's maxCodingAgents is refused with the fix, and starts nothing", () => {
  const p = setup();
  capped(p, 1);
  const r = owner(p, { FAKE_RUNNING: "work-menelik" }, "start", "coding-agent", "taytu");
  refused(r, "too_many_agents");
  expect(err(r).message).toContain("menelik");
  expect(err(r).message).toContain("at most 1");
  expect(err(r).fix).toContain("factory owner stop menelik");
  expect(err(r).fix).toContain("maxCodingAgents 2");
  expect(tmuxCalled(p, "new-session")).toEqual([]);
});

test("owner start under the cap starts it, and the dev manager and product owner don't count against it", () => {
  const p = setup();
  capped(p, 2);
  expect(owner(p, { FAKE_RUNNING: "work-menelik work-fasil" }, "start", "coding-agent", "taytu").code).toBe(0);
  const q = setup();
  capped(q, 1);
  const r = owner(q, { FAKE_RUNNING: "work-menelik" }, "start", "dev-manager", "fasil");
  expect(r.code, r.out).toBe(0);
  expect(tmuxCalled(q, "new-session")).toHaveLength(1);
});

test("owner start and stop are the owner's: the dev manager and a coding agent get owner_only and tmux is not changed", () => {
  for (const who of [MANAGER, CODER]) {
    const p = setup({ has: true });
    refused(owner(p, who, "start", "coding-agent", "taytu"), "owner_only");
    refused(owner(p, who, "stop", "taytu"), "owner_only");
    expect(changedTmux(p)).toEqual([]);
  }
});

// --- A: factory owner stop -----------------------------------------------------------------------------------------------

test("owner stop ends a running session and says so", () => {
  const p = setup({ has: true });
  const r = owner(p, OWNER, "stop", "taytu");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("Stopped taytu");
  expect(tmuxCalled(p, "kill-session").map((l) => l.replace(/^.*kill-session /, ""))).toEqual(["-t =work-taytu"]);
});

test("owner stop of a session that already ended says there is nothing to stop and kills nothing", () => {
  const p = setup();
  const r = owner(p, OWNER, "stop", "taytu");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("nothing to stop");
  expect(tmuxCalled(p, "kill-session")).toEqual([]);
});

test("owner stop refuses a name with odd characters with bad_name and calls nothing", () => {
  const p = setup({ has: true });
  for (const name of ["bad name", "a/b", "x;rm", "$(id)"]) refused(owner(p, OWNER, "stop", name), "bad_name");
  expect(changedTmux(p)).toEqual([]);
});

test("owner help lists start and stop", () => {
  const p = setup();
  const r = owner(p, OWNER, "help");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/^\s+start <role>/m);
  expect(r.stdout).toMatch(/^\s+stop <name>/m);
});

// --- help and docs -------------------------------------------------------------------------------------------------------

test("factory help lists owner start and owner stop, and owner merge mentions --head", () => {
  const p = setup();
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/^ {2}owner start /m);
  expect(r.stdout).toMatch(/^ {2}owner stop /m);
  const all = r.stdout.split("\n");
  const at = all.findIndex((l) => /^ {2}owner merge /.test(l));
  expect(at, "an owner merge line").toBeGreaterThan(-1);
  const rest = all.slice(at + 1).findIndex((l) => /^ {2}\S/.test(l));
  const block = all.slice(at, rest < 0 ? undefined : at + 1 + rest).join("\n");
  expect(block).toContain("--head");
  expect(r.stdout).not.toContain("Read-only for now");
}, T);

test("the commands page has rows for owner start and owner stop, and the owner merge row mentions --head", () => {
  const page = read(join(WIKI, "commands.md"));
  expect(page).toContain("| `factory owner start <role> [name]` |");
  expect(page).toContain("| `factory owner stop <name>` |");
  const row = page.split("\n").find((l) => l.startsWith("| `factory owner merge")) ?? "";
  expect(row).toContain("--head");
});
