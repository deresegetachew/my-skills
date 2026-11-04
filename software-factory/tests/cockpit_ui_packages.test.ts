// #391: in a my-skills checkout the cockpit's list runs cockpit/ui.tsx from source. Without software-factory/node_modules
// (Ink and React) it used to die inside tmux and leave a blank pane. Now `factory cockpit` refuses before tmux opens,
// `--sidebar` and `factory doctor` say what to run, and a pane that still fails keeps the error on screen.
// tmux is a fake on PATH that logs every call; a real tmux never runs.
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CI, copyHookFolders, envWith, gitRepo, HOOKS, SF, sh, tmp, write, type Proc } from "./support.ts";

const T = 120_000;
type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;
interface Proj { d: string; root: string; env: Env; log: string; fakeLog: string }

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
  new-session) printf '%s' "\${@: -1}" > "$FAKE_LOG/pane0.cmd" ;;
  has-session) [ -n "\${FAKE_HAS:-}" ] ;;
  *) ;;
esac
`;

function isolatedEnv(root: string, bin: string, logDir: string): Env {
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  return envWith(bin, { FAKE_LOG: logDir, XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_COCKPIT_CACHE_SECONDS: undefined,
    FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: undefined, TMUX: undefined, FACTORY_WINDOW: undefined, FAKE_HAS: undefined,
    FACTORY_COCKPIT: undefined, FACTORY_SELF: undefined });
}

function fakes(root: string): { bin: string; logDir: string } {
  const bin = join(root, "bin");
  write(join(bin, "gh"), FAKE_GH, 0o755);
  write(join(bin, "tmux"), FAKE_TMUX, 0o755);
  const logDir = join(root, "tmuxlog");
  mkdirSync(logDir);
  return { bin, logDir };
}

/** A fake my-skills checkout: the factory's source in software-factory/, linked into .claude/, and no node_modules. */
function checkout(opts: { fakePackages?: boolean } = {}): Proj {
  const root = tmp();
  const ms = join(root, "ms");
  mkdirSync(ms);
  gitRepo(ms);
  const sf = join(ms, "software-factory");
  mkdirSync(sf);
  copyFileSync(join(SF, "factory"), join(sf, "factory"));
  chmodSync(join(sf, "factory"), 0o755);
  cpSync(HOOKS, join(sf, "hooks"), { recursive: true });
  cpSync(join(SF, "cockpit"), join(sf, "cockpit"), { recursive: true, filter: (s) => !s.split("/").includes("node_modules") });
  cpSync(CI, join(sf, "ci"), { recursive: true });
  for (const f of ["package.json", "bun.lock", "VERSION", "tsconfig.json"]) if (existsSync(join(SF, f))) copyFileSync(join(SF, f), join(sf, f));
  mkdirSync(join(ms, ".claude", "hooks"), { recursive: true });
  for (const e of readdirSync(join(sf, "hooks"))) symlinkSync(`../../software-factory/hooks/${e}`, join(ms, ".claude", "hooks", e));
  symlinkSync("../software-factory/ci", join(ms, ".claude", "ci"));
  write(join(ms, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" } }));
  symlinkSync("software-factory/factory", join(ms, "factory"));
  if (opts.fakePackages) {
    write(join(sf, "node_modules", "ink", "package.json"), JSON.stringify({ name: "ink" }));
    write(join(sf, "node_modules", "react", "package.json"), JSON.stringify({ name: "react" }));
  } else {
    // The check must be real: nothing from here up to the tmp root may supply the packages.
    for (let p = ms; ; p = dirname(p)) {
      expect(existsSync(join(p, "node_modules")), p).toBe(false);
      if (p === resolve(root)) break;
    }
    expect(existsSync(join(sf, "node_modules"))).toBe(false);
  }
  const { bin, logDir } = fakes(root);
  return { d: ms, root, env: isolatedEnv(root, bin, logDir), log: join(logDir, "tmux.log"), fakeLog: logDir };
}

/** A project with copied hooks and no bundle, as a project gets the factory. */
function copied(): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" } }));
  const { bin, logDir } = fakes(root);
  return { d, root, env: isolatedEnv(root, bin, logDir), log: join(logDir, "tmux.log"), fakeLog: logDir };
}

const factoryPath = (p: Proj) => (existsSync(join(p.d, "software-factory", "factory")) ? join(p.d, "software-factory", "factory") : join(SF, "factory"));
const run = (p: Proj, args: string[]): Proc => sh(["bash", factoryPath(p), ...args], { cwd: p.d, env: p.env, timeoutMs: 100_000 });

function cleanEnv(e: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined) env[k] = v;
  return env;
}

/** `factory cockpit <args>` on a pseudo-terminal: [exit code, everything it showed]. */
async function onATerminal(p: Proj, args: string[]): Promise<[number, string]> {
  let shown = "";
  const proc = Bun.spawn(["bash", factoryPath(p), "cockpit", ...args], {
    cwd: p.d, env: cleanEnv(p.env),
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
  expect(out).not.toContain("Cannot find module");
}

const FIX = "cd software-factory && bun install --frozen-lockfile";

function checkRefusal(e: Obj): void {
  expect(e.code).toBe("cockpit_ui_packages_missing");
  expect(e.fix as string).toContain(FIX);
  expect(e.message as string).toMatch(/\b(ink|react)\b/i);
}

const tmuxCalls = (p: Proj): string[] => (existsSync(p.log) ? readFileSync(p.log, "utf8").split("\n").filter(Boolean) : []);
const withSub = (p: Proj, sub: string) => tmuxCalls(p).filter((l) => new RegExp(`\\s${sub}(\\s|$)`).test(l));

test("factory cockpit without Ink and React installed refuses before tmux opens, with the command to run", async () => {
  const p = checkout();
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).not.toBe(0);
  checkRefusal(errorOf(shown));
  expect(withSub(p, "new-session"), shown).toEqual([]);
  expect(withSub(p, "attach-session")).toEqual([]);
}, T);

test("factory cockpit --sidebar without the packages prints the error and exits 1, with no stack trace", () => {
  const p = checkout();
  const r = run(p, ["cockpit", "--sidebar"]);
  expect(r.code, r.out).toBe(1);
  checkRefusal(errorOf(r.stderr));
  noTrace(r.out);
}, T);

test("when the list still fails inside tmux the pane keeps the error on screen and says what to do", async () => {
  const p = checkout({ fakePackages: true });
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).toBe(0);
  expect(withSub(p, "new-session").length, shown).toBe(1);
  const cmdFile = join(p.fakeLog, "pane0.cmd");
  expect(existsSync(cmdFile)).toBe(true);
  const cmd = readFileSync(cmdFile, "utf8");
  const pane = Bun.spawn(["bash", "-c", cmd], { cwd: p.d, env: { ...cleanEnv(p.env), FACTORY_COCKPIT: "ms-cockpit" }, stdout: "pipe", stderr: "pipe" });
  let out = "";
  const drain = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) out += new TextDecoder().decode(c); };
  const reading = Promise.all([drain(pane.stdout), drain(pane.stderr)]);
  let exited = false;
  void pane.exited.then(() => { exited = true; });
  for (let i = 0; i < 150 && !exited; i++) await Bun.sleep(100);
  const held = !exited;
  pane.kill(9);
  await pane.exited;
  await Promise.race([reading, Bun.sleep(2000)]);
  expect(held, "the pane closed on its own, which leaves a blank pane. It showed: " + out).toBe(true);
  expect(out).toMatch(/Cannot find module|ink/i);
  expect(out).toMatch(/list (stopped|failed)/i);
}, T);

test("factory doctor in a checkout without the packages has a fix line naming the install command, and exits 1", () => {
  const p = checkout();
  const r = run(p, ["doctor"]);
  expect(r.stdout).toMatch(/^fix\s+cockpit UI: .*cd software-factory && bun install --frozen-lockfile/m);
  expect(r.code, r.out).toBe(1);
}, T);

test("a project with copied hooks and no bundle still opens the cockpit: its drawn list needs no packages", async () => {
  const p = copied();
  const [rc, shown] = await onATerminal(p, []);
  expect(rc, shown).toBe(0);
  expect(withSub(p, "new-session").length, shown).toBe(1);
  expect(shown).not.toContain("cockpit_ui_packages_missing");
}, T);
