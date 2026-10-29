// `factory cockpit` opens the tmux cockpit (#308, PRD US-10): its own tmux server and config, a left pane (`--sidebar`),
// a command bar in a popup (`--bar`) and `--needs`. tmux is a fake on PATH that logs every call; a real tmux never runs.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CI, envWith, gitRepo, HOOKS, read, SF, sh, tmp, write, WIKI, type Proc } from "./support.ts";

const T = 120_000;
type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;
interface Proj { d: string; root: string; env: Env; xdg: string; log: string }

const FAKE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] === "api") { console.log("[]"); process.exit(0); }
console.log("ok");
`;

const FAKE_TMUX = `#!/usr/bin/env bash
echo "TMUX=\${TMUX:-} $*" >>"$FAKE_LOG/tmux.log"
args=("$@"); i=0; sub=""
while [ $i -lt $# ]; do
  a="\${args[$i]}"
  case "$a" in
    -V) echo "\${FAKE_TMUX_VERSION:-tmux 3.4}"; exit 0 ;;
    -L|-f|-S) i=$((i+2)) ;;
    -*) i=$((i+1)) ;;
    *) sub="$a"; break ;;
  esac
done
case "$sub" in
  has-session) [ -n "\${FAKE_HAS:-}" ] ;;
  *) ;;
esac
`;

const VIEWS = ["Needs you", "Pull requests", "Tasks & PRD", "CI", "Agents & machines", "Settings", "Health & releases", "Usage & lessons"];

/** A project with copied hooks, a fake gh, a fake tmux on PATH and an isolated state dir. */
function setup(tmux = true, extra: Env = {}): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] }));
  const bin = join(root, "bin");
  write(join(bin, "gh"), FAKE_GH, 0o755);
  const logDir = join(root, "tmuxlog");
  mkdirSync(logDir);
  let path: string | undefined;
  if (tmux) {
    write(join(bin, "tmux"), FAKE_TMUX, 0o755);
  } else {
    const only = join(root, "bin-notmux");
    mkdirSync(only);
    symlinkSync(join(bin, "gh"), join(only, "gh"));
    for (const t of ["git", "bun", "bash", "sh", "env", "sleep", "hostname", "cat", "uname", "ps", "dirname", "basename", "mkdir", "rm", "touch",
      "readlink", "tr", "sed", "grep", "awk", "date", "mktemp", "cut", "head", "tail", "sort", "wc", "id", "ls", "cp", "mv", "chmod", "ln",
      "realpath", "tput", "stty", "flock", "uniq", "xargs", "find", "tee", "printf", "test"]) {
      const real = Bun.which(t);
      try { if (real) symlinkSync(real, join(only, t)); } catch { /* already there */ }
    }
    path = only;
  }
  const xdg = join(root, "state");
  mkdirSync(xdg);
  mkdirSync(join(root, "home"));
  const env = envWith(tmux ? bin : null, { FAKE_LOG: logDir, XDG_STATE_HOME: xdg, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_COCKPIT_CACHE_SECONDS: undefined,
    FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: undefined, TMUX: undefined, FACTORY_WINDOW: undefined, FAKE_HAS: undefined, ...extra });
  if (path) env.PATH = path;
  return { d, root, env, xdg, log: join(logDir, "tmux.log") };
}

function cockpit(p: Proj, args: string[], input?: string, extra: Env = {}): Proc {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: { ...p.env, ...extra }, input, timeoutMs: 100_000 });
}

/** `factory cockpit <args>` on a pseudo-terminal: [exit code, everything it showed]. */
async function onATerminal(p: Proj, args: string[], extra: Env = {}): Promise<[number, string]> {
  let shown = "";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...p.env, ...extra })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", ...args], {
    cwd: p.d, env,
    terminal: { cols: 200, rows: 50, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 60_000);
  const code = await proc.exited;
  clearTimeout(timer);
  await Bun.sleep(50);
  proc.terminal?.close();
  return [code, shown];
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function errorOf(text: string): Obj {
  const j: unknown = JSON.parse(lastLine(text));
  expect(typeof j === "object" && j !== null, text).toBe(true);
  const o = j as Obj;
  for (const k of ["code", "message", "fix"]) expect(typeof o[k], text).toBe("string");
  return o;
}

function noTrace(out: string): void {
  expect(out).not.toMatch(/^\s+at .*(:\d+|\))/m);
  expect(out).not.toMatch(/^error:/m);
  expect(out).not.toMatch(/\b(TypeError|ReferenceError|SyntaxError|Unhandled)\b/);
}

interface Call { tmux: string; args: string[]; sub: string; line: string }

/** The fake tmux's log, one entry per call, with the subcommand found after the server flags. */
function calls(p: Proj): Call[] {
  if (!existsSync(p.log)) return [];
  return readFileSync(p.log, "utf8").split("\n").filter(Boolean).map((line) => {
    const m = /^TMUX=(\S*) ?(.*)$/.exec(line);
    const args = ((m?.[2] ?? "").split(/\s+/)).filter(Boolean);
    let i = 0;
    while (i < args.length && (args[i] as string).startsWith("-")) i += ["-L", "-f", "-S"].includes(args[i] as string) ? 2 : 1;
    return { tmux: m?.[1] ?? "?", args, sub: args[i] ?? "", line };
  });
}
const real = (p: Proj) => calls(p).filter((c) => c.args[0] !== "-V");
const subs = (p: Proj, name: string) => calls(p).filter((c) => c.sub === name);

/** Run --json once to make the cache, then rewrite it with the given sessions and needsYou, as of now. */
function seed(p: Proj, sessions: Obj[], needsYou: Obj[]): void {
  const r = cockpit(p, ["--json"]);
  expect(r.code, r.out).toBe(0);
  const j: Obj = JSON.parse(r.stdout);
  for (const dir of readdirSync(p.xdg)) {
    const f = join(p.xdg, dir, "cockpit.json");
    if (existsSync(f)) {
      const cached: Obj = JSON.parse(read(f));
      writeFileSync(f, JSON.stringify({ ...j, ...cached, generatedAt: new Date().toISOString(), sessions, needsYou }));
      return;
    }
  }
  throw new Error("cockpit --json wrote no cockpit.json under " + p.xdg);
}

const TAYTU: Obj = { name: "taytu", kind: "coding-agent", state: "working", where: "this machine", task: "#42" };
const ZEMEN: Obj = { name: "zemen", kind: "dev-manager", state: "input-required", where: "machine m-other" };

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

// --- A: opening the cockpit ---------------------------------------------------------------------------------------------

test("without tmux the cockpit refuses with no-tmux", async () => {
  const p = setup(false);
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).toBe(2);
  expect(errorOf(shown).code).toBe("no-tmux");
  noTrace(shown);
}, T);

test("a tmux older than 3.2 is refused and nothing is started", async () => {
  const p = setup(true, { FAKE_TMUX_VERSION: "tmux 3.1c" });
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).toBe(2);
  const e = errorOf(shown);
  expect(e.code).toBe("tmux-too-old");
  expect(e.message).toContain("3.2");
  expect(subs(p, "new-session")).toEqual([]);
  expect(subs(p, "attach-session")).toEqual([]);
}, T);

test("not on a terminal the cockpit says it needs one and starts nothing", () => {
  const p = setup();
  const r = cockpit(p, []);
  expect(r.code, r.out).toBe(2);
  expect(errorOf(r.stderr).code).toBe("cockpit_needs_terminal");
  expect(subs(p, "new-session")).toEqual([]);
  noTrace(r.out);
}, T);

function checkOpened(p: Proj, shown: string): string {
  const all = real(p);
  expect(all.length, shown).toBeGreaterThan(0);
  for (const c of all) {
    expect(c.args[0], c.line).toBe("-L");
    expect(c.args[1], c.line).toMatch(/^factory-cockpit(-[\w-]+)?$/); // its own server, one per project
    expect(c.tmux, "the cockpit must not inherit an outer TMUX: " + c.line).toBe("");
  }
  const ns = subs(p, "new-session");
  expect(ns.length, shown).toBe(1);
  const n = ns[0] as Call;
  const at = n.args.indexOf("-s");
  expect(at).toBeGreaterThan(-1);
  const session = n.args[at + 1] as string;
  expect(session).toMatch(/-cockpit$/);
  expect(n.args).toContain("-d");
  expect(n.args.indexOf("-f"), n.line).toBeGreaterThan(-1);
  expect(subs(p, "split-window").length).toBeGreaterThan(0);
  expect((all[all.length - 1] as Call).sub).toBe("attach-session");
  expect((all[all.length - 1] as Call).args.join(" ")).toContain(`attach-session -t =${session}`);
  expect(subs(p, "switch-client")).toEqual([]);
  return n.args[n.args.indexOf("-f") + 1] as string;
}

test("on a terminal it starts its own tmux server with a config, splits, and attaches last", async () => {
  const p = setup();
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).toBe(0);
  checkOpened(p, shown);
}, T);

test("the config is private, uses C-a, shows the status line, the views and the command bar, and offers no agent commands", async () => {
  const p = setup();
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).toBe(0);
  const conf = checkOpened(p, shown);
  expect(existsSync(conf), conf).toBe(true);
  expect(statSync(conf).mode & 0o022, "no group or other write").toBe(0);
  const text = read(conf);
  expect(text).toMatch(/^set(-option)? -g prefix C-a$/m);
  expect(text).toMatch(/^unbind(-key)? C-b$/m);
  expect(text).toContain("status-position top");
  expect(text).toMatch(/#\([^)]*cockpit --status[^)]*\)/);
  expect(text).toContain("display-popup");
  expect(text).toContain("less -R");
  for (const v of VIEWS) expect(text, v).toContain(v);
  expect(text).not.toMatch(/bind(-key)?\s+(-n|-T\s*root)\s+["']?[/:]["']?\s/);
  expect(text).not.toMatch(/review-pass|run-check|rereview|manager-claims|factory_guard/);
  expect(text).not.toMatch(/factory[ _-](wait|guard)\b/);
}, T);

test("inside another tmux it still attaches to its own server and never switches the client", async () => {
  const p = setup(true, { TMUX: "/tmp/tmux-1/default,1,0" });
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).toBe(0);
  checkOpened(p, shown);
}, T);

test("when the cockpit is already running it is not started again, its config is reloaded, and it is attached", async () => {
  const p = setup(true, { FAKE_HAS: "1" });
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).toBe(0);
  expect(subs(p, "new-session")).toEqual([]);
  const src = subs(p, "source-file");
  expect(src.length, shown).toBeGreaterThan(0);
  expect((src[0] as Call).args[(src[0] as Call).args.indexOf("source-file") + 1]).toBeTruthy();
  expect((real(p).pop() as Call).sub).toBe("attach-session");
  expect(subs(p, "switch-client")).toEqual([]);
}, T);

// --- B: the sidebar -----------------------------------------------------------------------------------------------------

test("sidebar shows sessions with their state and a needs-you badge, and the views", () => {
  const p = setup();
  seed(p, [TAYTU, ZEMEN], []);
  const r = cockpit(p, ["--sidebar"], undefined, { COLUMNS: "50", LINES: "40" });
  expect(r.code, r.out).toBe(0);
  const lines = stripAnsi(r.stdout).split("\n");
  expect(lines.join("\n")).toContain("SESSIONS");
  const t = lines.find((l) => l.includes("taytu")) as string;
  const z = lines.find((l) => l.includes("zemen")) as string;
  expect(t, r.stdout).toBeDefined();
  expect(z, r.stdout).toBeDefined();
  expect(t).toContain("working");
  expect(t).not.toContain("needs you");
  expect(z).toContain("needs you");
  expect(lines.join("\n")).toContain("VIEWS");
  for (const v of VIEWS) expect(r.stdout, v).toContain(v);
  noTrace(r.out);
}, T);

test("sidebar gives a session the needs-you badge when an owner ask is about its task", () => {
  const p = setup();
  seed(p, [TAYTU, ZEMEN], [{ kind: "owner-ask", issue: 42 }]);
  const r = cockpit(p, ["--sidebar"], undefined, { COLUMNS: "50", LINES: "40" });
  expect(r.code, r.out).toBe(0);
  const t = stripAnsi(r.stdout).split("\n").find((l) => l.includes("taytu")) as string;
  expect(t, r.stdout).toContain("needs you");
}, T);

test("sidebar in a narrow small pane never draws a line wider than the pane", () => {
  const p = setup();
  seed(p, [TAYTU, ZEMEN], []);
  const r = cockpit(p, ["--sidebar"], undefined, { COLUMNS: "24", LINES: "12" });
  expect(r.code, r.out).toBe(0);
  const lines = stripAnsi(r.stdout).split("\n");
  for (const l of lines) expect([...l.replace(/\r$/, "")].length, l).toBeLessThanOrEqual(24);
  expect(lines.join("\n")).toContain("SESSIONS");
}, T);

test("sidebar with no sessions says so and names the command that starts one", () => {
  const p = setup();
  seed(p, [], []);
  const r = cockpit(p, ["--sidebar"], undefined, { COLUMNS: "60", LINES: "30" });
  expect(r.code, r.out).toBe(0);
  const text = stripAnsi(r.stdout);
  expect(text).toContain("No sessions");
  expect(text).toContain("factory loop -i");
}, T);

test("sidebar with no cache still draws the views and does not crash", () => {
  const p = setup();
  const r = cockpit(p, ["--sidebar"], undefined, { COLUMNS: "60", LINES: "30" });
  expect(r.code, r.out).toBe(0);
  expect(stripAnsi(r.stdout)).toContain("VIEWS");
  noTrace(r.out);
}, T);

test("on a terminal, Enter on a session shows it on the right through factory follow, and C-c ends the list", async () => {
  const p = setup();
  seed(p, [TAYTU, ZEMEN], []);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...p.env, FACTORY_COCKPIT: "work-cockpit" })) if (v !== undefined) env[k] = v;
  let shown = "";
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", "--sidebar"], {
    cwd: p.d, env,
    terminal: { cols: 60, rows: 30, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 60_000);
  for (let i = 0; i < 200 && !shown.includes("taytu"); i++) await Bun.sleep(50);
  expect(stripAnsi(shown), "the list is drawn").toContain("taytu");
  proc.terminal?.write("\r");
  for (let i = 0; i < 200 && !subs(p, "select-pane").length; i++) await Bun.sleep(50);
  proc.terminal?.write("\x03");
  const code = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  expect(code, shown).toBe(0);
  const respawn = subs(p, "respawn-pane");
  expect(respawn.length, shown).toBe(1);
  const line = (respawn[0] as Call).line;
  expect(line).toContain("-t =work-cockpit:0.1");
  expect(line).toMatch(/follow taytu/);
  expect((subs(p, "select-pane")[0] as Call).line).toContain("=work-cockpit:0.1");
}, T);

// --- C: the command bar -------------------------------------------------------------------------------------------------

function version(p: Proj): string {
  const v = sh(["bash", join(SF, "factory"), "version"], { cwd: p.d, env: p.env });
  expect(v.code, v.out).toBe(0);
  return v.stdout.split("\n")[0] as string;
}

test("bar runs the command typed in full and prints its output", () => {
  const p = setup();
  const want = version(p);
  expect(want.length).toBeGreaterThan(0);
  const r = cockpit(p, ["--bar"], "version\n");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.split("\n")[0] ?? "").toContain(want);
  expect(r.stdout).toContain(want);
}, T);

test("bar picks a command from a prefix", () => {
  const p = setup();
  const want = version(p);
  const r = cockpit(p, ["--bar"], "vers\n");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain(want);
}, T);

for (const word of ["review-pass", "wait", "run-check", "guard", "rereview", "manager-claims"]) {
  test(`bar does not offer ${word}`, () => {
    const p = setup();
    const r = cockpit(p, ["--bar"], word + "\n");
    expect(r.code, r.out).toBe(2);
    expect(errorOf(r.stderr).code).toBe("cockpit_not_offered");
  }, T);
}

for (const line of ["claims release --agent taytu", "claims done --agent taytu --task 42", "next --claim taytu --issue 42",
  "usage --record x", "claims list --pid 1", "prs --since-days 3 extra"]) {
  test(`bar refuses "${line}", which goes past what the cockpit offers`, () => {
    const p = setup();
    const r = cockpit(p, ["--bar"], line + "\n");
    expect(r.code, r.out).toBe(2);
    expect(errorOf(r.stderr).code).toBe("cockpit_not_offered");
    noTrace(r.out);
  }, T);
}

test("bar runs an offered command with the word it takes", () => {
  const p = setup();
  const r = cockpit(p, ["--bar"], "help cockpit\n");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("cockpit");
}, T);

test("bar with text that matches nothing says so", () => {
  const p = setup();
  const r = cockpit(p, ["--bar"], "zzqq\n");
  expect(r.code, r.out).toBe(2);
  expect(errorOf(r.stderr).code).toBe("cockpit_no_match");
}, T);

// --- D: --needs ---------------------------------------------------------------------------------------------------------

test("needs prints each thing that needs the owner, with its link", () => {
  const p = setup();
  seed(p, [], [{ kind: "owner-ask", id: "ship-it", issue: 77, url: "https://github.com/o/r/issues/77#c1" }]);
  const r = cockpit(p, ["--needs"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("ship-it");
  expect(r.stdout).toContain("https://github.com/o/r/issues/77#c1");
}, T);

test("needs prints no control characters from a PR title or link", () => {
  const p = setup();
  seed(p, [], [{ kind: "owner-merges", number: 9, title: "evil\x1b]0;pwned\x07 \x1b[31mred\x1b[0m\rtitle",
    url: "https://github.com/o/r/pull/9\x1b[2J" }]);
  const r = cockpit(p, ["--needs"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("PR #9");
  expect(r.stdout).toContain("https://github.com/o/r/pull/9");
  expect(r.stdout.replace(/\n/g, ""), JSON.stringify(r.stdout)).not.toMatch(/[\x00-\x1f\x7f]/);
}, T);

test("sidebar prints no control characters from a session name or state", () => {
  const p = setup();
  seed(p, [{ ...TAYTU, name: "tay\x1b]0;pwned\x07tu", state: "work\x1b[2Jing" }], []);
  const r = cockpit(p, ["--sidebar"], undefined, { COLUMNS: "60", LINES: "30" });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("taytu");
  expect(r.stdout.replace(/\n/g, ""), JSON.stringify(r.stdout)).not.toMatch(/[\x00-\x1f\x7f]/);
}, T);

test("needs says so when nothing needs the owner", () => {
  const p = setup();
  seed(p, [], []);
  const r = cockpit(p, ["--needs"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("Nothing needs you");
}, T);

// --- E: help and docs ---------------------------------------------------------------------------------------------------

test("factory help lists the bare cockpit command", () => {
  const p = setup();
  const r = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/^ {2}cockpit\s{2,}\S/m);
}, T);

test("the commands page has a row for factory cockpit", () => {
  expect(read(join(WIKI, "commands.md"))).toMatch(/^\| `factory cockpit` \|/m);
});
