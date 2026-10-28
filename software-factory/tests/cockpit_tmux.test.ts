// `factory cockpit` (no flags) opens the read-only tmux cockpit (#308): its own tmux server, prefix C-a, a sidebar, a
// command bar, views. tmux is a fake on PATH that logs every call; a real tmux never runs.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CI, HOOKS, SF, envWith, gitRepo, sh, tmp, write, writeExe, type Proc } from "./support.ts";

const T = 60_000;
type Row = Record<string, unknown>;
type Env = Record<string, string | undefined>;
interface Proj { d: string; env: Env; xdg: string; tlog: string }

const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in "repo view") echo main; exit 0 ;; esac
echo "gh: not logged in" >&2; exit 1
`;

const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_TMUX_LOG"
case "$*" in
  *" -V"*|"-V") echo "\${FAKE_TMUX_VERSION:-tmux 3.4}"; exit 0 ;;
  *has-session*) [ -n "$FAKE_TMUX_RUNNING" ]; exit $? ;;
esac
exit 0
`;

const NO_TMUX_TOOLS = ["git", "bun", "bash", "sh", "env", "sleep", "hostname", "cat", "uname", "ps", "dirname", "basename", "mkdir",
  "rm", "touch", "readlink", "tr", "sed", "grep", "awk", "date", "mktemp", "cut", "head", "tail", "sort", "wc", "id", "ls",
  "cp", "mv", "chmod", "ln", "realpath", "tput", "stty", "flock", "uniq", "xargs", "find", "tee", "printf", "test"];

/** A project with copied hooks, a fake gh, an isolated state dir; fake tmux first on PATH unless `tmux` is false. */
function setup(opts: { tmux?: boolean; version?: string; running?: boolean; extra?: Env } = {}): Proj {
  const tmuxOn = opts.tmux ?? true;
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] }));
  const bin = join(root, "bin");
  writeExe(join(bin, "gh"), FAKE_GH);
  const xdg = join(root, "state");
  mkdirSync(xdg);
  mkdirSync(join(root, "home"));
  const tlog = join(root, "tmux.log");
  writeFileSync(tlog, "");
  if (tmuxOn) writeExe(join(bin, "tmux"), FAKE_TMUX);
  const env: Env = envWith(bin, { XDG_STATE_HOME: xdg, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_CONFIG_DIR: undefined,
    FACTORY_AGENTS: undefined, TMUX: undefined, FACTORY_WINDOW: undefined, FAKE_TMUX_LOG: tlog,
    FAKE_TMUX_VERSION: opts.version ? `tmux ${opts.version}` : undefined, FAKE_TMUX_RUNNING: opts.running ? "1" : undefined,
    COLUMNS: undefined, LINES: undefined, ...(opts.extra ?? {}) });
  if (!tmuxOn) {
    for (const t of NO_TMUX_TOOLS) {
      const real = Bun.which(t);
      try {
        if (real) symlinkSync(real, join(bin, t));
      } catch {
        // already there
      }
    }
    env.PATH = bin;
  }
  return { d, env, xdg, tlog };
}

function cockpit(p: Proj, ...args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: p.env, timeoutMs: 50_000 });
}

const tcalls = (p: Proj): string[] => readFileSync(p.tlog, "utf8").split("\n").filter(Boolean);
const lastJson = (s: string): Row => JSON.parse(s.trimEnd().split("\n").pop() as string) as Row;
const ownServer = (l: string): boolean => /^-L factory-cockpit-\S+ /.test(l);
const isVersionCheck = (l: string): boolean => /(^| )-V$/.test(l);

/** The state dir the cockpit made for this project (the one holding cockpit.tmux.conf). */
function stateDir(p: Proj): string {
  const dirs = readdirSync(p.xdg).filter((x) => existsSync(join(p.xdg, x, "cockpit.tmux.conf")));
  expect(dirs.length, `cockpit.tmux.conf under ${p.xdg}: ${readdirSync(p.xdg).join(",")}`).toBe(1);
  return join(p.xdg, dirs[0] as string);
}

/** Seeds cockpit.json with these rows, in the state dir `--json` makes. */
function seed(p: Proj, sessions: Row[]): void {
  cockpit(p, "--json"); // makes the state dir, whatever gh says
  const dirs = readdirSync(p.xdg);
  const dir = join(p.xdg, dirs[0] ?? "x-factory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions, needsYou: [],
    counts: { sessions: sessions.length, working: 0, pulls: 0, needYou: 0 }, missing: [] }));
}

const row = (name: string, kind: string, state: string, source = "local"): Row =>
  ({ name, kind, where: "tmux", state, source, machine: source === "local" ? "this" : "other" });

const VIEWS = ["Needs you", "Pull requests", "Tasks & PRD", "CI", "Agents & machines", "Settings", "Health & releases", "Usage & lessons"];

test("no tmux on PATH: no-tmux error with a fix", () => {
  const p = setup({ tmux: false });
  const r = cockpit(p);
  expect(r.code).not.toBe(0);
  const j = lastJson(r.stderr);
  expect(j.code).toBe("no-tmux");
  expect(typeof j.message).toBe("string");
  expect(typeof j.fix).toBe("string");
}, T);

test("tmux 3.1 is too old: tmux-too-old naming 3.2, and no session is started", () => {
  const p = setup({ version: "3.1" });
  const r = cockpit(p);
  expect(r.code).not.toBe(0);
  const j = lastJson(r.stderr);
  expect(j.code).toBe("tmux-too-old");
  expect(String(j.fix)).toContain("3.2");
  expect(tcalls(p).some((l) => l.includes("new-session"))).toBe(false);
}, T);

for (const v of ["3.2", "3.4", "next-3.5"]) {
  test(`tmux ${v} passes the version check`, () => {
    const p = setup({ version: v });
    const r = cockpit(p);
    expect(r.code, r.out).toBe(0);
    expect(tcalls(p).some((l) => l.includes("new-session"))).toBe(true);
  }, T);
}

test("starts the cockpit on its own tmux server with its config, panes and attaches", () => {
  const p = setup();
  const r = cockpit(p);
  expect(r.code, r.out).toBe(0);
  const calls = tcalls(p).filter((l) => !isVersionCheck(l));
  expect(calls.length).toBeGreaterThan(0);
  for (const l of calls) expect(ownServer(l), l).toBe(true);
  const conf = join(stateDir(p), "cockpit.tmux.conf");
  const text = readFileSync(conf, "utf8");
  const lines = text.split("\n").map((l) => l.trim());
  expect(text).toContain("set -g prefix C-a");
  expect(text).toMatch(/unbind(-key)? C-b/);
  expect(lines.some((l) => /^bind(-key)?\s/.test(l) && /(\s|")[:](\s|")/.test(l) && l.includes("display-popup") && l.includes("cockpit --bar")),
    "a bind for : opening display-popup with cockpit --bar").toBe(true);
  expect(text).toContain("status-position top");
  expect(text).toContain("cockpit --status");
  expect(statSync(conf).mode & 0o777).toBe(0o644);
  const ns = calls.find((l) => l.includes("new-session")) as string;
  expect(ns).toContain("-s cockpit");
  expect(ns).toContain(`-f ${conf}`);
  expect(calls.some((l) => l.includes("split-window"))).toBe(true);
  expect(calls[calls.length - 1]).toMatch(/attach(-session)? .*cockpit/);
}, T);

test("inside another tmux it still attaches to the cockpit's own server", () => {
  const p = setup({ extra: { TMUX: "/tmp/tmux-1000/default,1,0" } });
  const r = cockpit(p);
  expect(r.code, r.out).toBe(0);
  const att = tcalls(p).filter((l) => /attach(-session)? /.test(l));
  expect(att.length).toBe(1);
  expect(ownServer(att[0] as string)).toBe(true);
  expect(att[0]).toContain("cockpit");
}, T);

test("a cockpit already running is attached to, not started again", () => {
  const p = setup({ running: true });
  const r = cockpit(p);
  expect(r.code, r.out).toBe(0);
  const calls = tcalls(p);
  expect(calls.some((l) => l.includes("new-session"))).toBe(false);
  expect(calls.some((l) => /attach(-session)? /.test(l) && l.includes("cockpit"))).toBe(true);
}, T);

test("sidebar lists sessions grouped, with states, a needs-you badge and the views in order", () => {
  const p = setup();
  seed(p, [row("zed", "coding agent", "working"), row("taytu", "coding agent", "waiting"), row("pablo", "product owner", "idle"),
    row("dana", "dev manager", "working"), row("remote1", "coding agent", "idle", "github")]);
  const r = cockpit(p, "--sidebar", "--once");
  expect(r.code, r.out).toBe(0);
  const out = r.stdout;
  expect(out).toContain("SESSIONS");
  const lineOf = (n: string): string => out.split("\n").find((l) => l.includes(n)) as string;
  for (const [n, s] of [["zed", "working"], ["taytu", "waiting"], ["pablo", "idle"], ["dana", "working"]] as const) {
    expect(lineOf(n), `${n} listed`).toBeDefined();
    expect(lineOf(n)).toContain(s);
  }
  expect(lineOf("taytu")).toContain("!");
  expect(lineOf("zed")).not.toContain("!");
  const at = (n: string): number => out.indexOf(n);
  expect(at("dana")).toBeLessThan(at("pablo"));
  expect(at("pablo")).toBeLessThan(at("taytu"));
  expect(at("other machines")).toBeGreaterThan(at("zed"));
  expect(at("remote1")).toBeGreaterThan(at("other machines"));
  const v = at("VIEWS");
  expect(v).toBeGreaterThan(at("remote1"));
  let from = v;
  for (const name of VIEWS) {
    const i = out.indexOf(name, from);
    expect(i, name).toBeGreaterThan(-1);
    from = i + name.length;
  }
}, T);

test("sidebar with no sessions says so, points to factory loop -i and still lists the views", () => {
  const p = setup();
  seed(p, []);
  const r = cockpit(p, "--sidebar", "--once");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("No sessions");
  expect(r.stdout).toContain("factory loop -i");
  expect(r.stdout).toContain("VIEWS");
  for (const name of VIEWS) expect(r.stdout).toContain(name);
}, T);

test("sidebar fits a 20 by 6 terminal", () => {
  const p = setup({ extra: { COLUMNS: "20", LINES: "6" } });
  seed(p, [row("taytu", "coding agent", "waiting"), row("dana", "dev manager", "working")]);
  const r = cockpit(p, "--sidebar", "--once");
  expect(r.code, r.out).toBe(0);
  const lines = r.stdout.replace(/\n$/, "").split("\n");
  expect(lines.length).toBeLessThanOrEqual(6);
  for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(20);
}, T);

test("--commands lists read-only factory commands and none of the internal or action ones", () => {
  const p = setup();
  const r = cockpit(p, "--commands");
  expect(r.code, r.out).toBe(0);
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const c of ["status", "prs", "agents ls", "doctor"]) expect(lines).toContain(c);
  for (const c of ["review-pass", "wait", "run-check", "guard", "rereview", "manager-claims", "owner merge"]) {
    expect(lines.some((l) => l === c || l.startsWith(c + " ")), c).toBe(false);
  }
}, T);

test("--commands filters by fuzzy query", () => {
  const p = setup();
  const a = cockpit(p, "--commands", "prs");
  expect(a.code, a.out).toBe(0);
  expect(a.stdout.split("\n").filter(Boolean)[0]?.trim()).toBe("prs");
  const b = cockpit(p, "--commands", "agls");
  expect(b.stdout.split("\n").map((l) => l.trim())).toContain("agents ls");
  const c = cockpit(p, "--commands", "zzqqxx");
  expect(c.code, c.out).toBe(0);
  expect(c.stdout.trim()).toBe("");
}, T);

test("--view opens a popup on the cockpit server that pages the command", () => {
  const p = setup();
  const r = cockpit(p, "--view", "Pull requests");
  expect(r.code, r.out).toBe(0);
  const pop = tcalls(p).find((l) => l.includes("display-popup")) as string;
  expect(pop).toBeDefined();
  expect(ownServer(pop)).toBe(true);
  expect(pop).toContain("prs");
  expect(pop).toContain("| less -R");
  const q = setup();
  expect(cockpit(q, "--view", "CI").code).toBe(0);
  expect(tcalls(q).find((l) => l.includes("display-popup"))).toContain("ci status");
}, T);

test("--view with an unknown name fails listing the views", () => {
  const p = setup();
  const r = cockpit(p, "--view", "Nope");
  expect(r.code).not.toBe(0);
  const j = lastJson(r.stderr);
  expect(j.code).toBe("unknown-view");
  for (const name of VIEWS) expect(String(j.fix)).toContain(name);
}, T);

test("--open follows a session in the right pane", () => {
  const p = setup();
  const r = cockpit(p, "--open", "taytu");
  expect(r.code, r.out).toBe(0);
  const calls = tcalls(p);
  const rp = calls.find((l) => l.includes("respawn-pane -k")) as string;
  expect(rp).toBeDefined();
  expect(ownServer(rp)).toBe(true);
  expect(rp).toContain("cockpit:0.1");
  expect(rp).toContain("follow taytu");
  const sp = calls.find((l) => l.includes("select-pane")) as string;
  expect(sp).toBeDefined();
  expect(sp).toContain("cockpit:0.1");
  expect(calls.indexOf(sp)).toBeGreaterThan(calls.indexOf(rp));
}, T);

test("an unknown cockpit flag exits 2 with cockpit_usage", () => {
  const p = setup();
  const r = cockpit(p, "--nope");
  expect(r.code).toBe(2);
  expect(lastJson(r.stderr).code).toBe("cockpit_usage");
}, T);

test("factory help describes the cockpit, its prefix and the tmux it needs", () => {
  const p = setup();
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env, timeoutMs: 50_000 });
  const line = r.out.split("\n").find((l) => l.includes("cockpit") && l.includes("C-a")) as string;
  expect(line, r.out).toBeDefined();
  expect(line).toContain("tmux 3.2");
}, T);
