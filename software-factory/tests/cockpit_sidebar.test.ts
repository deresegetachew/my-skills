// The cockpit's left side on Ink (#366, decision 0002): the SESSIONS and VIEWS lists drawn with ink-testing-library from
// fixed snapshots (each state, who is listed, narrow and wide, no colour, each key), then the same list run by
// `factory cockpit --sidebar` from the release's bundle in a throwaway project, with a fake tmux taking its actions.
import { beforeAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleCockpit } from "../../tools/build_cockpit.ts";
import { sidebarOf } from "../cockpit/testing.tsx";
import { CI, envWith, gitRepo, HOOKS, SF, sh, tmp, write, type Proc } from "./support.ts";

const T = 120_000;
type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;

const VIEWS = [{ key: "1", title: "Needs you" }, { key: "2", title: "Pull requests" }, { key: "3", title: "Tasks & PRD" }];

const here = (name: string, state: string, more: Obj = {}): Obj =>
  ({ name, state, kind: "coding agent", where: "this machine", source: "local", machine: "aaaa1111", expected: true, ...more });
const there = (name: string, state: string, machine: string, more: Obj = {}): Obj =>
  ({ name, state, kind: "coding agent", where: `machine ${machine}`, source: "github", machine, expected: false, ...more });

const data = (sessions: Obj[], needsYou: Obj[] = []) => ({ snapshot: { sessions, needsYou }, views: VIEWS });
const lineOf = (frame: string, name: string) => frame.split("\n").find((l) => new RegExp(`\\b${name}\\b`).test(l)) ?? "";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

// --- the states ---------------------------------------------------------------------------------------------------------

test("each session shows its real state: working, waiting, idle, down, and unknown for a machine that stopped reporting", () => {
  const s = sidebarOf(data([here("haile", "working", { task: "551" }), here("fasil", "working", { kind: "dev manager" }),
    here("taytu", "waiting", { task: "42" }), here("menelik", "idle"), here("tewodros", "down"),
    there("kassa", "silent", "bbbb2222")]), 80);
  const f = s.frame();
  expect(lineOf(f, "haile")).toMatch(/haile\s+working\s+#551/);
  expect(lineOf(f, "fasil")).toMatch(/fasil\s+working/);
  expect(lineOf(f, "taytu")).toMatch(/taytu\s+waiting\s+#42/);
  expect(lineOf(f, "menelik")).toMatch(/menelik\s+idle/);
  expect(lineOf(f, "tewodros")).toMatch(/tewodros\s+down/);
  expect(lineOf(f, "kassa")).toMatch(/kassa\s+unknown\s+on bbbb2222/);
  s.unmount();
});

test("a session waiting on a question, or whose task has an owner ask, needs you", () => {
  const s = sidebarOf(data([here("haile", "input-required"), here("taytu", "working", { task: "#42" }), here("menelik", "idle")],
    [{ kind: "owner-ask", issue: 42 }]), 80);
  const f = s.frame();
  expect(lineOf(f, "haile")).toMatch(/haile\s+waiting.*● needs you/);
  expect(lineOf(f, "taytu")).toContain("● needs you");
  expect(lineOf(f, "menelik")).not.toContain("needs you");
  expect(f).toContain("1 Needs you (1)");
  s.unmount();
});

// --- who is listed (bug 2 of #362) --------------------------------------------------------------------------------------

test("only sessions that run or are expected here are listed, plus the other machines' live sessions marked by machine", () => {
  const s = sidebarOf(data([
    there("yohannes", "working", "bbbb2222", { task: "7" }),
    here("haile", "working"),
    here("menelik", "down"), // in this machine's names: expected here, so its down shows
    here("abebe", "down", { expected: false }), // an old checkout here, not expected
    there("taytu", "down", "cccc3333"), // only down somewhere else
    there("tewodros", "down", ""), // a name in the roles list nobody runs
    { name: "zara", state: "idle", where: "cloud", source: "github" },
  ]), 80);
  const f = s.frame();
  for (const name of ["haile", "menelik", "yohannes", "zara"]) expect(f, name).toMatch(new RegExp(`\\b${name}\\b`));
  for (const name of ["abebe", "taytu", "tewodros"]) expect(f, name).not.toMatch(new RegExp(`\\b${name}\\b`));
  expect(lineOf(f, "yohannes")).toMatch(/yohannes\s+working\s+#7\s+on bbbb2222/);
  expect(lineOf(f, "zara")).toContain("on cloud");
  expect(lineOf(f, "haile")).not.toContain(" on ");
  const order = ["haile", "menelik", "yohannes"].map((n) => f.indexOf(lineOf(f, n)));
  expect(order).toEqual([...order].sort((a, b) => a - b)); // this machine's first
  s.unmount();
});

test("no sessions says so and names the command that starts one; the views are still there", () => {
  for (const snapshot of [{ sessions: [] }, null, { sessions: "nope" }, { sessions: [there("taytu", "down", "x")] }]) {
    const s = sidebarOf({ snapshot, views: VIEWS });
    const f = s.frame();
    expect(f).toContain("No sessions running.");
    expect(f).toContain("factory loop -i");
    expect(f).toContain("VIEWS");
    expect(f).toContain("2 Pull requests");
    s.unmount();
  }
});

test("a session name or state can't put control characters on the screen", () => {
  const s = sidebarOf(data([here("tay\x1b]0;pwned\x07tu", "work\x1b[2Jing")]), 60);
  const f = s.frame();
  expect(f).toContain("taytu");
  expect(f.replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f]/);
  s.unmount();
});

// --- sizes and colour ---------------------------------------------------------------------------------------------------

const MANY = data([here("haile", "working", { task: "551" }), here("menelik", "idle"),
  there("yohannes-the-long-named", "waiting", "bbbb2222", { task: "12" })], [{ kind: "owner-ask", issue: 12 }]);

test("in a narrow pane no line is wider than the pane", () => {
  const s = sidebarOf(MANY, 24, 30);
  const lines = s.frame().split("\n");
  for (const l of lines) expect([...l].length, l).toBeLessThanOrEqual(24);
  expect(s.frame()).toContain("SESSIONS");
  expect(lineOf(s.frame(), "haile")).toContain("working");
  s.unmount();
});

test("in a wide pane every row is whole", () => {
  const s = sidebarOf(MANY, 120, 30);
  expect(lineOf(s.frame(), "yohannes-the-long-named")).toMatch(/yohannes-the-long-named\s+waiting\s+#12\s+on bbbb2222\s+● needs you/);
  for (const l of s.frame().split("\n")) expect([...l].length).toBeLessThanOrEqual(120);
  s.unmount();
});

test("with no colour the frame has no escape codes and the selected row is still marked", () => {
  const s = sidebarOf(MANY, 60, 30, false);
  expect(s.frame()).not.toContain("\x1b");
  expect(lineOf(s.frame(), "haile").startsWith("›")).toBe(true);
  s.unmount();
  const c = sidebarOf(MANY, 60, 30, true);
  expect(lineOf(c.frame(), "haile").replace(/\x1b\[[0-9;]*m/g, "").startsWith("›")).toBe(true);
  c.unmount();
});

test("in a short pane the selected row stays in view as it moves down the list", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `agent${String(i).padStart(2, "0")}`);
  const s = sidebarOf(data(names.map((n) => here(n, "idle"))), 40, 8);
  expect(s.frame().split("\n").length).toBeLessThanOrEqual(8);
  for (let i = 1; i < names.length; i++) {
    await s.press(DOWN);
    const f = s.frame();
    expect(f.split("\n").length).toBeLessThanOrEqual(8);
    expect(lineOf(f, names[i] as string).startsWith("›"), f).toBe(true);
  }
  s.unmount();
});

// --- the keys -----------------------------------------------------------------------------------------------------------

test("arrows move, and Enter opens the selected session, or the selected view", async () => {
  const s = sidebarOf(MANY, 60);
  await s.press(UP); // already at the top: stays
  await s.press(DOWN);
  expect(lineOf(s.frame(), "menelik").startsWith("›")).toBe(true);
  await s.press(ENTER);
  expect(s.calls).toEqual(["session menelik"]);
  await s.press("j");
  await s.press("j");
  await s.press(ENTER);
  expect(s.calls.at(-1)).toBe("view 1");
  await s.press("k");
  await s.press(ENTER);
  expect(s.calls.at(-1)).toBe("session yohannes-the-long-named");
  s.unmount();
});

test("a number opens its view, : the command bar, r reloads and q leaves", async () => {
  const s = sidebarOf(MANY, 60);
  for (const k of ["2", ":", "r", "q", "9"]) await s.press(k);
  expect(s.calls).toEqual(["view 2", "bar", "reload", "leave"]);
  s.unmount();
});

test("on a session s says, x stops it and n starts one, each through the bar", async () => {
  const s = sidebarOf(MANY, 60);
  for (const k of ["s", "x", "n"]) await s.press(k);
  expect(s.calls).toEqual(["bar say haile", "bar owner stop haile", "bar owner start"]);
  s.unmount();
});

// --- factory cockpit --sidebar, from the release's bundle ---------------------------------------------------------------

const FAKE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] === "api") { console.log("[]"); process.exit(0); }
console.log("ok");
`;

const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG"
[ "$1" = "-V" ] && echo "tmux 3.4"
exit 0
`;

let bundle: Uint8Array;
beforeAll(() => {
  bundle = bundleCockpit(SF);
}, T);

interface Proj { d: string; env: Env; log: string }

/** A project with copied hooks, the bundle where a release installs it, a fake gh and tmux, and a cached snapshot. */
function project(sessions: Obj[], needsYou: Obj[] = []): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  const hooks = join(d, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(hooks, f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  writeFileSync(join(hooks, "factory_cockpit_ink.js"), bundle);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" } }));
  const bin = join(root, "bin");
  write(join(bin, "gh"), FAKE_GH, 0o755);
  write(join(bin, "tmux"), FAKE_TMUX, 0o755);
  const xdg = join(root, "state");
  write(join(xdg, "work-factory", "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions,
    needsYou, pulls: [], missing: [] }));
  mkdirSync(join(root, "home"));
  const log = join(root, "tmux.log");
  const env = envWith(bin, { XDG_STATE_HOME: xdg, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), FAKE_LOG: log,
    FACTORY_CONFIG_DIR: undefined, FACTORY_AGENT: undefined, FACTORY_AGENTS: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined, FACTORY_COCKPIT_CACHE_SECONDS: "3600", TMUX: undefined, FACTORY_COCKPIT: "work-cockpit" });
  return { d, env, log };
}

function cockpit(p: Proj, args: string[], extra: Env = {}): Proc {
  return sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: { ...p.env, ...extra }, timeoutMs: T });
}

const tmuxCalls = (p: Proj) => (existsSync(p.log) ? readFileSync(p.log, "utf8").split("\n").filter(Boolean) : []);

function noTrace(out: string): void {
  expect(out).not.toMatch(/^\s+at .*(:\d+|\))/m);
  expect(out).not.toMatch(/\b(TypeError|ReferenceError|SyntaxError|Unhandled)\b/);
}

test("factory cockpit --sidebar draws the Ink list off a terminal, sized by COLUMNS and LINES", () => {
  const p = project([here("haile", "working", { task: "551" }), there("taytu", "down", "cccc3333"),
    there("yohannes", "idle", "bbbb2222")]);
  const r = cockpit(p, ["--sidebar"], { COLUMNS: "30", LINES: "20" });
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  const lines = r.stdout.replace(/\x07/g, "").split("\n");
  expect(lineOf(r.stdout, "haile")).toMatch(/haile\s+working\s+#551/);
  expect(lineOf(r.stdout, "yohannes")).toMatch(/yohannes\s+idle/);
  expect(r.stdout).not.toMatch(/\btaytu\b/);
  expect(r.stdout).toContain("VIEWS");
  expect(r.stdout).toContain("2 Pull requests");
  expect(r.stdout).not.toContain("\x1b[");
  for (const l of lines) expect([...l].length, l).toBeLessThanOrEqual(30);
  expect(lines.filter(Boolean).length).toBeLessThanOrEqual(20);
}, T);

test("factory cockpit --sidebar-data gives the snapshot, the views and one bell for a new owner ask", () => {
  const p = project([here("haile", "working")]);
  const first = cockpit(p, ["--sidebar-data"]);
  expect(first.code, first.out).toBe(0);
  const d = JSON.parse(first.stdout) as { snapshot: { sessions: Obj[] }; views: Obj[]; bell: number };
  expect(d.snapshot.sessions.map((s) => s.name)).toEqual(["haile"]);
  expect(d.views.map((v) => v.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  expect(d.bell).toBe(0);
  const p2 = project([here("haile", "working")]);
  cockpit(p2, ["--sidebar-data"]);
  write(join(p2.env.XDG_STATE_HOME as string, "work-factory", "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(),
    sessions: [], needsYou: [{ kind: "owner-ask", id: "a", issue: 4 }], pulls: [], missing: [] }));
  expect((JSON.parse(cockpit(p2, ["--sidebar-data"]).stdout) as { bell: number }).bell).toBe(1);
  expect((JSON.parse(cockpit(p2, ["--sidebar-data"]).stdout) as { bell: number }).bell).toBe(0);
}, T);

test("factory cockpit --sidebar-open does each key's action in the cockpit's tmux", () => {
  const p = project([]);
  let r = cockpit(p, ["--sidebar-open", "session", "haile"]);
  expect(r.code, r.out).toBe(0);
  const calls = tmuxCalls(p);
  expect(calls.find((c) => c.includes("respawn-pane"))).toMatch(/-t =work-cockpit:0\.1 .*follow haile/);
  expect(calls.find((c) => c.includes("select-pane"))).toContain("=work-cockpit:0.1");
  r = cockpit(p, ["--sidebar-open", "view", "2"]);
  expect(r.code, r.out).toBe(0);
  expect(tmuxCalls(p).at(-1)).toMatch(/display-popup .*cockpit --prs/);
  r = cockpit(p, ["--sidebar-open", "bar", "say", "haile"]);
  expect(tmuxCalls(p).at(-1)).toMatch(/display-popup .*cockpit --bar say haile/);
  r = cockpit(p, ["--sidebar-open", "leave"]);
  expect(tmuxCalls(p).at(-1)).toMatch(/detach-client/);
  for (const bad of [["view", "42"], ["nothing"], ["session"]]) {
    const n = tmuxCalls(p).length;
    r = cockpit(p, ["--sidebar-open", ...bad]);
    expect(r.code, r.out).toBe(2);
    expect((JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as Obj).code).toBe("cockpit_usage");
    expect(tmuxCalls(p).length).toBe(n);
  }
}, T);

test("on a terminal the Ink list opens the session Enter picks, and C-c ends it", async () => {
  const p = project([here("haile", "working"), here("menelik", "idle")]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (v !== undefined) env[k] = v;
  let shown = "";
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", "--sidebar"], {
    cwd: p.d, env, terminal: { cols: 50, rows: 24, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 60_000);
  for (let i = 0; i < 400 && !shown.includes("menelik"); i++) await Bun.sleep(50);
  expect(shown, "the list is drawn").toContain("menelik");
  proc.terminal?.write(DOWN);
  await Bun.sleep(300);
  proc.terminal?.write(ENTER);
  for (let i = 0; i < 400 && !tmuxCalls(p).some((c) => c.includes("select-pane")); i++) await Bun.sleep(50);
  proc.terminal?.write("\x03");
  const code = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  expect(code, shown).toBe(0);
  expect(tmuxCalls(p).find((c) => c.includes("respawn-pane"))).toMatch(/follow menelik/);
}, T);

test("on a terminal q leaves the cockpit (detach) and the list keeps running for the next visit", async () => {
  const p = project([here("haile", "working")]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (v !== undefined) env[k] = v;
  let shown = "";
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", "--sidebar"], {
    cwd: p.d, env, terminal: { cols: 50, rows: 24, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 60_000);
  for (let i = 0; i < 400 && !shown.includes("haile"); i++) await Bun.sleep(50);
  expect(shown, "the list is drawn").toContain("haile");
  proc.terminal?.write("q");
  for (let i = 0; i < 400 && !tmuxCalls(p).some((c) => c.includes("detach-client")); i++) await Bun.sleep(50);
  expect(tmuxCalls(p).some((c) => c.includes("detach-client")), shown).toBe(true);
  await Bun.sleep(500);
  expect(proc.exitCode, "the list must keep running, or its pane closes").toBeNull();
  proc.terminal?.write("\x03");
  const code = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  expect(code, shown).toBe(0);
}, T);

test("on a terminal the Ink list is drawn when CI is set in the environment (GitHub Actions sets it)", async () => {
  const p = project([here("haile", "working")]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (v !== undefined) env[k] = v;
  env.CI = "true";
  let shown = "";
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", "--sidebar"], {
    cwd: p.d, env, terminal: { cols: 50, rows: 24, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 60_000);
  for (let i = 0; i < 400 && !shown.includes("haile"); i++) await Bun.sleep(50);
  expect(shown, "the list is drawn while it runs, not only when it ends").toContain("haile");
  proc.terminal?.write("\x03");
  const code = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  expect(code, shown).toBe(0);
}, T);
