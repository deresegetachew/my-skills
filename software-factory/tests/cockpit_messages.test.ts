// The cockpit's messages popup (#414): a "Messages" entry (key m) after the talks, which opens `factory messages tail`.
import { beforeAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleCockpit } from "../../tools/build_cockpit.ts";
import { CI, copyHookFolders, envWith, gitRepo, HOOKS, SF, sh, tmp, write } from "./support.ts";

const T = 120_000;
type Obj = Record<string, unknown>;

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

function project() {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  const hooks = join(d, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(hooks, f));
  copyHookFolders(hooks);
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  writeFileSync(join(hooks, "factory_cockpit_ink.js"), bundle);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" } }));
  const bin = join(root, "bin");
  write(join(bin, "gh"), FAKE_GH, 0o755);
  write(join(bin, "tmux"), FAKE_TMUX, 0o755);
  const xdg = join(root, "state");
  write(join(xdg, "work-factory", "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], pulls: [], missing: [] }));
  mkdirSync(join(root, "home"));
  const log = join(root, "tmux.log");
  const env = envWith(bin, { XDG_STATE_HOME: xdg, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), FAKE_LOG: log,
    FACTORY_CONFIG_DIR: undefined, FACTORY_AGENT: undefined, FACTORY_AGENTS: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined, FACTORY_COCKPIT_CACHE_SECONDS: "3600", TMUX: undefined, FACTORY_COCKPIT: "work-cockpit" });
  return { d, env, log };
}

const cockpit = (p: ReturnType<typeof project>, args: string[]) => sh(["bash", join(SF, "factory"), "cockpit", ...args], { cwd: p.d, env: p.env, timeoutMs: T });
const calls = (p: ReturnType<typeof project>) => (existsSync(p.log) ? readFileSync(p.log, "utf8").split("\n").filter(Boolean) : []);

test("--sidebar-data lists Messages (key m) after the talks and keeps the views 1 to 8", () => {
  const p = project();
  const r = cockpit(p, ["--sidebar-data"]);
  expect(r.code, r.out).toBe(0);
  const d = JSON.parse(r.stdout) as { views: Obj[]; talks: Obj[] };
  expect(d.views.map((v) => v.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  expect(d.talks.map((t) => t.key)).toEqual(["9", "0", "m"]);
  expect(d.talks[2]?.title).toBe("Messages");
}, T);

test("--sidebar-open view m opens a popup that runs messages tail", () => {
  const p = project();
  const r = cockpit(p, ["--sidebar-open", "view", "m"]);
  expect(r.code, r.out).toBe(0);
  expect(calls(p).at(-1)).toMatch(/display-popup .*messages tail/);
}, T);
