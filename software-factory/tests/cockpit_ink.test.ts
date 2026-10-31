// The cockpit on Ink, step 1 (#365, decision 0002): the smallest screen ("cockpit (Ink)" and the sessions of the
// snapshot) drawn with ink-testing-library; the same screen from the bundle `bun build` makes, run by `factory cockpit
// --ink` under Bun in a throwaway project with no node_modules; and `factory doctor` saying the bundle is there and loads.
import { beforeAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleCockpit } from "../../tools/build_cockpit.ts";
import { frameOf } from "../cockpit/testing.tsx";
import { CI, envWith, gitRepo, HOOKS, SF, sh, tmp, WIKI, write, type Proc } from "./support.ts";

const T = 120_000;
type Env = Record<string, string | undefined>;
interface Proj { d: string; root: string; env: Env; hooks: string }

const SESSIONS = [
  { name: "haile", state: "working", role: "coding-agent", machine: "dev-pc" },
  { name: "menelik", state: "idle", role: "dev-manager", machine: "laptop" },
];

const FAKE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] === "api") { console.log("[]"); process.exit(0); }
console.log("ok");
`;

let bundle: Uint8Array;
beforeAll(() => {
  bundle = bundleCockpit(SF);
}, T);

/** A project with a copy of every hook (no link back to my-skills, so no source UI and no node_modules) and a cached
 * snapshot holding `sessions`; with `withBundle`, the bundle where a release installs it. */
function setup(withBundle: boolean, sessions: unknown[] = SESSIONS): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  const hooks = join(d, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(hooks, f));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" } }));
  if (withBundle) writeFileSync(join(hooks, "factory_cockpit_ink.js"), bundle);
  const bin = join(root, "bin");
  write(join(bin, "gh"), FAKE_GH, 0o755);
  const xdg = join(root, "state");
  write(join(xdg, "work-factory", "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions,
    needsYou: [], pulls: [], missing: [] }));
  mkdirSync(join(root, "home"));
  const env = envWith(bin, { XDG_STATE_HOME: xdg, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_CONFIG_DIR: undefined, FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined,
    FACTORY_COCKPIT_CACHE_SECONDS: "3600", TMUX: undefined });
  return { d, root, env, hooks };
}

function factory(p: Proj, ...args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), ...args], { cwd: p.d, env: p.env, timeoutMs: T });
}

/** The bundle run under Bun with auto-install off: offline means nothing is fetched, and the test must show it. */
function runBundle(file: string, args: string[], cwd: string, env?: Env): Proc {
  return sh([process.execPath, "--no-env-file", "--config=/dev/null", "--no-install", file, ...args], { cwd, env });
}

function noTrace(out: string): void {
  expect(out).not.toMatch(/^\s+at .*(:\d+|\))/m);
  expect(out).not.toMatch(/\b(TypeError|ReferenceError|SyntaxError|Unhandled)\b/);
}

test("the screen shows the title and each session with its state, role and machine", () => {
  const frame = frameOf({ sessions: SESSIONS });
  const lines = frame.split("\n");
  expect(lines[0]).toBe("cockpit (Ink)");
  expect(frame).toContain("Sessions");
  expect(lines.find((l) => l.includes("haile"))).toMatch(/haile\s+working\s+coding-agent\s+on dev-pc/);
  expect(lines.find((l) => l.includes("menelik"))).toMatch(/menelik\s+idle\s+dev-manager\s+on laptop/);
});

test("no sessions, or a snapshot that isn't one, says so instead of failing", () => {
  for (const snap of [{ sessions: [] }, {}, null, { sessions: "nope" }]) {
    const frame = frameOf(snap);
    expect(frame).toContain("cockpit (Ink)");
    expect(frame).toContain("no sessions");
  }
  expect(frameOf({ sessions: [{ name: "taytu" }] })).toMatch(/taytu\s+unknown/);
});

test("factory cockpit --ink runs the bundle under Bun in a project with no node_modules", () => {
  const p = setup(true);
  const r = factory(p, "cockpit", "--ink");
  expect(r.code, r.out).toBe(0);
  noTrace(r.out);
  expect(r.stdout).toContain("cockpit (Ink)");
  expect(r.stdout).toMatch(/haile\s+working/);
  expect(r.stdout).toMatch(/menelik\s+idle/);
  for (const dir of [p.d, p.root, join(p.d, ".claude"), p.hooks]) expect(existsSync(join(dir, "node_modules"))).toBe(false);
}, T);

test("factory cockpit --ink on a terminal draws the screen while it runs, also when CI is set (GitHub Actions sets it)", async () => {
  const p = setup(true);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env)) if (v !== undefined) env[k] = v;
  env.CI = "true";
  let shown = "";
  const proc = Bun.spawn(["bash", join(SF, "factory"), "cockpit", "--ink"], {
    cwd: p.d, env, terminal: { cols: 100, rows: 30, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => proc.kill(9), 60_000);
  for (let i = 0; i < 400 && !shown.includes("menelik"); i++) await Bun.sleep(50);
  expect(shown, "the screen is drawn while it runs, not only when it ends").toContain("menelik");
  proc.terminal?.write("q");
  const code = await proc.exited;
  clearTimeout(timer);
  proc.terminal?.close();
  expect(code, shown).toBe(0);
}, T);

test("the bundle runs on its own, offline, from a folder with no node_modules", () => {
  const dir = tmp();
  writeFileSync(join(dir, "factory_cockpit_ink.js"), bundle);
  writeFileSync(join(dir, "snap.json"), JSON.stringify({ sessions: SESSIONS }));
  const env: Env = { PATH: process.env.PATH, HOME: dir, NODE_PATH: undefined, BUN_INSTALL_CACHE_DIR: join(dir, "no-cache") };
  const r = runBundle(join(dir, "factory_cockpit_ink.js"), ["--data", "snap.json"], dir, env);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("cockpit (Ink)");
  expect(r.stdout).toMatch(/haile\s+working/);
  const check = runBundle(join(dir, "factory_cockpit_ink.js"), ["--check"], dir, env);
  expect(check.code, check.out).toBe(0);
  expect(check.stdout.trim()).toBe("ok");
  // Ink looks for react-devtools-core when DEV=true; the bundle holds an empty one and must still run
  const dev = runBundle(join(dir, "factory_cockpit_ink.js"), ["--data", "snap.json"], dir, { ...env, DEV: "true" });
  expect(dev.code, dev.out).toBe(0);
  expect(dev.stdout).toContain("cockpit (Ink)");
  expect(existsSync(join(dir, "node_modules"))).toBe(false);
});

test("the real bundle is the same bytes when built again", () => {
  expect(Buffer.compare(Buffer.from(bundleCockpit(SF)), Buffer.from(bundle))).toBe(0);
}, T);

test("bad arguments or an unreadable snapshot give {code, message, fix}, not a stack trace", () => {
  const dir = tmp();
  writeFileSync(join(dir, "ui.js"), bundle);
  for (const args of [[], ["--data", join(dir, "missing.json")], ["--what"]]) {
    const r = runBundle(join(dir, "ui.js"), args, dir);
    expect(r.code, r.out).toBe(2);
    noTrace(r.out);
    const err = JSON.parse(r.stderr.trim()) as Record<string, string>;
    expect(Object.keys(err).sort()).toEqual(["code", "fix", "message"]);
    expect(err.fix).toContain("factory cockpit");
  }
});

test("factory cockpit --ink without the bundle says to update, with {code, message, fix}", () => {
  const p = setup(false);
  const r = factory(p, "cockpit", "--ink");
  expect(r.code, r.out).toBe(1);
  noTrace(r.out);
  const err = JSON.parse(r.stderr.trim()) as Record<string, string>;
  expect(err.code).toBe("cockpit_ui_missing");
  expect(err.fix).toContain("factory update");
}, T);

test("factory doctor says the cockpit bundle is present and loads, or that it doesn't", () => {
  const p = setup(true);
  let r = factory(p, "doctor");
  expect(r.stdout).toMatch(/^ok\s+cockpit bundle: present and loads$/m);
  writeFileSync(join(p.hooks, "factory_cockpit_ink.js"), "throw new Error('broken bundle');\n");
  r = factory(p, "doctor");
  expect(r.stdout).toMatch(/^fix\s+cockpit bundle: .*factory_cockpit_ink\.js doesn't load .*factory update/m);
  expect(r.code).toBe(1);
}, 2 * T);

test("factory doctor notes a release without the cockpit bundle", () => {
  const p = setup(false);
  const r = factory(p, "doctor");
  expect(r.stdout).toMatch(/^note\s+cockpit bundle: .*factory update/m);
  expect(r.stdout).not.toMatch(/^fix\s+cockpit/m);
}, T);

test("factory help and the wiki's commands page list factory cockpit --ink", () => {
  const p = setup(false);
  const r = factory(p, "help");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/cockpit --ink\s+\S/);
  expect(readFileSync(join(WIKI, "commands.md"), "utf8")).toContain("`factory cockpit --ink`");
}, T);
