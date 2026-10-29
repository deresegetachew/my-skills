// Actions from the cockpit (#309, PRD US-11): `factory owner start|stop`, `owner merge --head`, and the command bar asking
// "[y/N]" before it runs a command that changes things. gh is a small fake with a JSON db and a log of every call; tmux is
// a fake on PATH that logs every call and remembers whether a session was started. Nothing real is called.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CI, envWith, gitRepo, HOOKS, read, SF, sh, tmp, WIKI, write, type Proc } from "./support.ts";

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

// The sidebar and the pull requests view only need gh to answer with an empty list.
const QUIET_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] === "api") { console.log("[]"); process.exit(0); }
console.log("ok");
`;

// has-session succeeds when FAKE_HAS is set or a session was started (new-session) and not killed since.
const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_TMUX_DIR/tmux.log"
case "$1" in
  -V) echo "tmux 3.4" ;;
  has-session) [ -n "$FAKE_HAS" ] || [ -e "$FAKE_TMUX_DIR/up" ] ;;
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
function setup(o: { quiet?: boolean; has?: boolean } = {}): Proj {
  const root = tmp();
  roots.push(root);
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] }));
  const bin = join(root, "bin");
  write(join(bin, "gh"), o.quiet ? QUIET_GH : FAKE_GH, 0o755);
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
    FACTORY_ITEM: undefined, CLAUDECODE: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_COCKPIT_CACHE_SECONDS: undefined,
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

/** `factory cockpit --bar` off a terminal: the first stdin line is the command, the second answers its question. */
function bar(p: Proj, command: string, answer?: string): Proc {
  const input = answer === undefined ? `${command}\n` : `${command}\n${answer}\n`;
  return sh(["bash", join(SF, "factory"), "cockpit", "--bar"], { cwd: p.d, env: p.env, input, timeoutMs: 100_000 });
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

const tags = (p: Proj) => sh(["git", "-C", p.d, "tag", "--list"]).stdout.trim();
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

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

test("owner start of a session that is already running says so and starts nothing", () => {
  const p = setup({ has: true });
  const r = owner(p, OWNER, "start", "coding-agent", "taytu");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.toLowerCase()).toContain("already running");
  expect(tmuxCalled(p, "new-session")).toEqual([]);
});

test("owner start refuses a role that is not one of the three, and asks nothing of tmux", () => {
  const p = setup();
  refused(owner(p, OWNER, "start", "wizard", "taytu"), "bad_role");
  expect(changedTmux(p)).toEqual([]);
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

// --- B: the command bar asks first ---------------------------------------------------------------------------------------

interface Action { line: string; release?: boolean }
const ACTIONS: Action[] = [
  { line: "owner merge 7" },
  { line: "owner label 12 factory:blocked" },
  { line: "owner answer palette yes" },
  { line: "owner release 1.2.3", release: true },
  { line: "owner start coding-agent taytu" },
  { line: "owner stop taytu" },
  { line: "say taytu hello" },
];

for (const a of ACTIONS) {
  test(`bar asks before "${a.line}" and a no (n, an empty line or the end of input) changes nothing`, () => {
    const p = setup({ has: true });
    for (const answer of ["n", "", undefined]) {
      const r = bar(p, a.line, answer);
      const shown = stripAnsi(r.stdout);
      expect(r.code, r.out).toBe(0);
      expect(shown, r.out).toContain(`factory ${a.line}`);
      expect(shown).toContain("[y/N]");
      expect(shown).toContain("Not run: nothing changed.");
    }
    expect(ghCalls(p)).toEqual([]);
    expect(changedTmux(p)).toEqual([]);
    if (a.release) expect(tags(p)).toBe("");
  }, T);
}

test("bar: a yes (y, yes or Y) runs the command, and the question comes first", () => {
  for (const yes of ["y", "yes", "Y"]) {
    const p = setup();
    const r = bar(p, "owner label 12 factory:blocked", yes);
    expect(r.code, r.out).toBe(0);
    const shown = stripAnsi(r.stdout);
    expect(shown).toContain("factory owner label 12 factory:blocked");
    expect(shown).toContain("#12: added factory:blocked.");
    expect(shown.indexOf("[y/N]")).toBeGreaterThan(-1);
    expect(shown.indexOf("[y/N]")).toBeLessThan(shown.indexOf("#12: added"));
    const post = ghCalls(p).find((c) => c.argv.includes("POST") && c.argv.some((x) => x.endsWith("issues/12/labels")));
    expect(JSON.parse(post?.stdin ?? "null")).toEqual({ labels: ["factory:blocked"] });
  }
}, T);

test("bar: a yes to owner stop kills the running session", () => {
  const p = setup({ has: true });
  const r = bar(p, "owner stop taytu", "y");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("Stopped taytu");
  expect(tmuxCalled(p, "kill-session")).toHaveLength(1);
}, T);

test("bar: flags are allowed after an action command (--remove, --head)", () => {
  const p = setup();
  const removed = bar(p, "owner label 12 factory:blocked --remove", "y");
  expect(removed.code, removed.out).toBe(0);
  expect(removed.stdout).toContain("#12: removed factory:blocked.");
  const merged = bar(p, `owner merge 7 --head ${SHA.slice(0, 10)}`, "y");
  expect(merged.code, merged.out).toBe(0);
  expect(merges(p)).toHaveLength(1);
}, T);

test("bar: a merge pinned to a head that moved after the view opened is refused with pr_changed and merges nothing", () => {
  const p = setup();
  const r = bar(p, `owner merge 7 --head ${STALE}`, "y");
  refused(r, "pr_changed");
  expect(merges(p)).toEqual([]);
}, T);

test("bar: a read-only command still runs with no question, and read-only commands with flags are still not offered", () => {
  const p = setup();
  const v = bar(p, "version");
  expect(v.code, v.out).toBe(0);
  expect(v.stdout).not.toContain("[y/N]");
  const flagged = bar(p, "claims list --pid 1");
  expect(flagged.code, flagged.out).toBe(2);
  expect(err(flagged).code).toBe("cockpit_not_offered");
}, T);

// --- C: screens and docs -------------------------------------------------------------------------------------------------

test("the pull requests view's keys offer m merge", () => {
  const p = setup({ quiet: true });
  const r = sh(["bash", join(SF, "factory"), "cockpit", "--prs"], { cwd: p.d, env: { ...p.env, COLUMNS: "140", LINES: "40" }, timeoutMs: 100_000 });
  expect(r.code, r.out).toBe(0);
  const last = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  expect(last).toContain("m merge");
}, T);

test("the sidebar's keys offer s say and x stop when a session is selected", () => {
  const p = setup({ quiet: true });
  const first = sh(["bash", join(SF, "factory"), "cockpit", "--json"], { cwd: p.d, env: p.env, timeoutMs: 100_000 });
  expect(first.code, first.out).toBe(0);
  const snap: Obj = JSON.parse(first.stdout);
  const dir = readdirSync(p.env.XDG_STATE_HOME as string).find((x) => existsSync(join(p.env.XDG_STATE_HOME as string, x, "cockpit.json")));
  expect(dir, "cockpit --json wrote a cache").toBeDefined();
  const file = join(p.env.XDG_STATE_HOME as string, dir as string, "cockpit.json");
  const cached: Obj = JSON.parse(read(file));
  writeFileSync(file, JSON.stringify({ ...snap, ...cached, generatedAt: new Date().toISOString(), needsYou: [],
    sessions: [{ name: "taytu", kind: "coding-agent", state: "working", where: "this machine", task: "#42" }] }));
  const r = sh(["bash", join(SF, "factory"), "cockpit", "--sidebar"], { cwd: p.d, env: { ...p.env, COLUMNS: "60", LINES: "30" }, timeoutMs: 100_000 });
  expect(r.code, r.out).toBe(0);
  const text = stripAnsi(r.stdout);
  expect(text).toContain("taytu");
  expect(text).toContain("s say");
  expect(text).toContain("x stop");
}, T);

test("factory help lists owner start and owner stop, and owner merge mentions --head; the cockpit is no longer read-only", () => {
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
