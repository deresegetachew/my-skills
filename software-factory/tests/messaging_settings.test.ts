// The `messaging` settings (#404, #504): in the schema and the settings page, checked by `factory settings validate`,
// and read by the composition root to pick the adapter. The transport is github or board; unset, it is board on a
// machine with a message board set up (MB_URL or its url file), else github. NATS was removed (#504, decision 0007):
// a config that still says nats is refused with the fix. With board and a board that can't be reached (here nothing
// listens on port 9), the command falls back to GitHub (the default) or stops (fallback "none").
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, read, runBun, runHook, sh, tmp, WIKI, write, writeExe } from "./support.ts";

type Env = Record<string, string | undefined>;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function personEnv(): Env {
  const env: Env = { ...process.env };
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) delete env[name];
  return env;
}

function project(cfg: unknown): string {
  const d = tmp();
  dirs.push(d);
  sh(["git", "init", "-q", d]);
  mkdirSync(join(d, ".claude"));
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  return d;
}

function settings(d: string, args: string[]) {
  return runBun(join(HOOKS, "factory_settings.ts"), args, { cwd: d, env: personEnv() });
}

function validate(messaging: unknown) {
  return settings(project({ messaging }), ["validate"]);
}

// --- the schema ---------------------------------------------------------------------------------------------------

test("messaging.transport is unset by default (board with a board set up, else github), with no kinds", () => {
  const d = project({});
  const get = (key: string) => settings(d, ["get", key]);
  expect(get("messaging.transport").code).toBe(0);
  expect(get("messaging.transport").stdout.trim()).toBe("null");
  expect(get("messaging.fallback").stdout.trim()).toBe('"github"');
  expect(get("messaging.kinds").stdout.trim()).toBe("[]");
  expect(get("messaging.url").code).not.toBe(0); // NATS's server address: removed with NATS
  expect(get("messaging.creds").code).not.toBe(0);
});

test("settings help explains a messaging setting and names its options", () => {
  const p = settings(project({}), ["help", "messaging.fallback"]);
  expect(p.code).toBe(0);
  expect(p.out).toContain("messaging.fallback");
  expect(p.out).toContain("github");
  expect(p.out).toContain("none");
  const t = settings(project({}), ["help", "messaging.transport"]).out;
  expect(t).toContain("board");
  expect(t).toContain("github");
  expect(t).toContain("factory board up");
});

test("validate refuses an unknown transport and names the setting", () => {
  const p = validate({ transport: "kafka" });
  expect(p.code).toBe(1);
  expect(p.out).toContain("messaging.transport");
});

test("validate refuses transport nats: it was removed, and the fix says to use the board", () => {
  const p = validate({ transport: "nats", url: "nats://100.64.0.1:4222", kinds: ["claim"] });
  expect(p.code).toBe(1);
  expect(p.out).toMatch(/(^|\n)(error: )?messaging\.transport:.*removed/);
  expect(p.out).toContain("factory settings set messaging.transport board");
});

test("settings set messaging.transport nats is refused and changes nothing", () => {
  const d = project({});
  const p = settings(d, ["set", "messaging.transport", "nats"]);
  expect(p.code).not.toBe(0);
  expect(p.out).toContain("board");
  expect(JSON.parse(read(join(d, ".claude", "factory.json")))).toEqual({});
});

test("validate accepts a full messaging object without calling any key unknown", () => {
  const p = validate({ transport: "board", kinds: ["claim", "wake", "pr"], githubCopy: [], pollMinutes: 20, fallback: "none" });
  expect(p.code).toBe(0);
  expect(p.out).not.toContain("not a factory setting");
});

test("an old messaging.url is kept and ignored, with a warning", () => {
  const p = validate({ transport: "board", url: "nats://127.0.0.1:4222" });
  expect(p.code).toBe(0);
  expect(p.out).toContain("messaging.url: not a factory setting");
});

test("the settings page has a Messaging table with its keys, and none of NATS's", () => {
  const page = read(join(WIKI, "settings.md"));
  const block = page.slice(page.indexOf("<!-- settings:begin -->"), page.indexOf("<!-- settings:end -->"));
  expect(block).toContain("**Messaging**");
  for (const key of ["transport", "kinds", "githubCopy", "pollMinutes", "fallback"]) expect(block).toContain(`messaging.${key}`);
  for (const key of ["url", "creds"]) expect(block).not.toContain(`messaging.${key}`);
  expect(block).not.toMatch(/nats/i);
});

// --- validate: the whole-file checks --------------------------------------------------------------------------------

test("messaging.githubCopy is unset by default (the same as messaging.kinds), and its help says which kinds may drop it", () => {
  const d = project({});
  const get = settings(d, ["get", "messaging.githubCopy"]);
  expect(get.code, get.out).toBe(0);
  expect(get.stdout.trim()).toBe("null");
  const help = settings(d, ["help", "messaging.githubCopy"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("messaging.kinds");
  for (const kind of ["claim", "release", "wake"]) expect(help.out).toContain(kind);
});

test("a messaging.githubCopy item must be a message kind; an empty list is fine", () => {
  const bad = validate({ kinds: ["claim"], githubCopy: ["gossip"] });
  expect(bad.code).toBe(1);
  expect(bad.out).toMatch(/(^|\n)(error: )?messaging\.githubCopy:/);
  expect(bad.out).toContain("gossip");
  expect(validate({ kinds: ["claim", "wake"], githubCopy: [] }).code).toBe(0);
  expect(validate({ kinds: ["claim", "wake"], githubCopy: ["claim"] }).code).toBe(0);
});

test("a messaging.kinds item must be a message kind", () => {
  const bad = validate({ kinds: ["claim", "gossip"] });
  expect(bad.code).toBe(1);
  expect(bad.out).toMatch(/(^|\n)(error: )?messaging\.kinds:/);
  expect(bad.out).toContain("gossip");
  const all = ["question", "answer", "mustfix", "approval", "status", "claim", "release", "wake", "handoff"];
  expect(validate({ kinds: all }).code).toBe(0);
});

// --- the composition root ----------------------------------------------------------------------------------------

const FAKE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
const path = a.slice(1).filter((x) => !x.startsWith("-") && !["GET", "Accept: application/vnd.github+json"].includes(x))[0] as string;
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1); const page = Number(u.searchParams.get("page") ?? "1");
const item = { number: 7, title: "t", state: "open", comments: 1, labels: [], html_url: "https://github.test/r/7", body: "" };
const note = { id: 1, body: "<!-- factory-msg v=1 id=01abc23def kind=question from=haile to=po state=submitted ref=issue#7 -->\nWhich colour?",
  user: { login: "me" }, created_at: "2026-10-25T10:00:00Z", html_url: "https://github.test/c/1" };
const out = (x: unknown) => { process.stdout.write(JSON.stringify(x) + "\n"); process.exit(0); };
if (a[0] === "api" && p === "issues") out(page === 1 ? [item] : []);
if (a[0] === "api" && p === "issues/7/comments") out(page === 1 ? [note] : []);
if (a[0] === "api" && p === "issues/7") out(item);
process.stderr.write("fake gh: no route for " + a.join(" ") + "\n");
process.exit(1);
`;

/** `factory messages ls` in a project with `messaging` (undefined: none); `board` writes this machine's board URL (one
 * nothing answers on) to its settings folder. */
function ls(messaging: unknown, board = false) {
  const d = tmp();
  dirs.push(d);
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), JSON.stringify(messaging === undefined ? {} : { messaging }));
  const cfg = join(d, "cfg");
  if (board) write(join(cfg, "message-board", "url"), "postgres://factory:secret-pw@127.0.0.1:9/board\n", 0o600);
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, FACTORY_CONFIG_DIR: cfg };
  delete env.FACTORY_AGENT;
  delete env.MB_URL;
  return runHook("factory_messages", ["ls", "--fresh"], { cwd: d, env, timeoutMs: 60_000 });
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test("transport github reads messages from GitHub and says nothing about the board", () => {
  const p = ls({ transport: "github" }, true);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("haile");
  expect(p.stderr).not.toContain("board");
});

test("unset, the transport is github on a machine with no board", () => {
  const p = ls(undefined);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("haile");
  expect(p.stderr).not.toContain("board");
});

test("unset, the transport is board on a machine with a board: one that can't be reached falls back to GitHub, said once", () => {
  const base = ls({ transport: "github" });
  const p = ls(undefined, true);
  expect(p.code).toBe(0);
  expect(p.stdout).toBe(base.stdout);
  expect(count(p.stderr, "board-unreachable")).toBe(1);
  expect(p.stderr).toContain("messaging.transport");
  expect(p.out).not.toContain("secret-pw");
});

test("transport board with a board that can't be reached and fallback none stops and says board-unreachable", () => {
  const p = ls({ transport: "board", fallback: "none" }, true);
  expect(p.code).not.toBe(0);
  expect(p.out).toContain("board-unreachable");
  expect(p.stdout).not.toContain("haile");
});

test("transport nats is refused when messages are read, with the fix", () => {
  const p = ls({ transport: "nats", url: "nats://127.0.0.1:4222" });
  expect(p.code).not.toBe(0);
  expect(p.out).toContain("transport-removed");
  expect(p.out).toContain("factory settings set messaging.transport board");
  expect(p.stdout).not.toContain("haile");
});

test("a command that does not use messaging is not stopped by an old transport nats", () => {
  const d = tmp();
  dirs.push(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ messaging: { transport: "nats", url: "nats://127.0.0.1:4222", fallback: "none" } }));
  write(join(d, "docs", "build-plan.md"), "## Phase 1\n\n- [ ] **1.1 One.** Build.\n");
  write(join(d, "docs", "blocked.md"), "# Blocked\n");
  const env: Env = { ...process.env, CLAUDE_PROJECT_DIR: d };
  delete env.FACTORY_AGENT;
  delete env.FACTORY_PID;
  const p = runHook("next_task", ["--no-rework"], { cwd: d, env });
  expect(p.code).toBe(0);
  expect(p.stdout.trim()).toBe("1.1 One");
  expect(p.out).not.toContain("transport-removed");
});
