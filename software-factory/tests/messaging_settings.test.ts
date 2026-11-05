// The `messaging` settings (#404, decision 0004): in the schema and the settings page, checked by `factory settings
// validate`, and read by the composition root to pick the adapter. There is no NATS plugin yet, so "nats" is the
// plugin-missing case: fall back to GitHub (the default) or stop (fallback "none").
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

test("the messaging settings default to GitHub with no url, creds or kinds", () => {
  const d = project({});
  const get = (key: string) => settings(d, ["get", key]);
  expect(get("messaging.transport").code).toBe(0);
  expect(get("messaging.transport").stdout.trim()).toBe('"github"');
  expect(get("messaging.fallback").stdout.trim()).toBe('"github"');
  expect(get("messaging.url").code).toBe(0);
  expect(get("messaging.creds").code).toBe(0);
  expect(get("messaging.kinds").code).toBe(0);
  expect(get("messaging.kinds").stdout.trim()).toBe("[]");
});

test("settings help explains a messaging setting and names its options", () => {
  const p = settings(project({}), ["help", "messaging.fallback"]);
  expect(p.code).toBe(0);
  expect(p.out).toContain("messaging.fallback");
  expect(p.out).toContain("github");
  expect(p.out).toContain("none");
  expect(settings(project({}), ["help", "messaging.transport"]).out).toContain("nats");
});

test("validate refuses an unknown transport and names the setting", () => {
  const p = validate({ transport: "kafka" });
  expect(p.code).toBe(1);
  expect(p.out).toContain("messaging.transport");
});

test("validate accepts a full messaging object without calling any key unknown", () => {
  const p = validate({ transport: "nats", url: "nats://100.64.0.1:4222", creds: "/home/x/.secrets/nats/p", kinds: ["claim", "wake"],
    fallback: "none" });
  expect(p.code).toBe(0);
  expect(p.out).not.toContain("not a factory setting");
});

test("the settings page has a Messaging table listing the five keys", () => {
  const page = read(join(WIKI, "settings.md"));
  const block = page.slice(page.indexOf("<!-- settings:begin -->"), page.indexOf("<!-- settings:end -->"));
  expect(block).toContain("**Messaging**");
  for (const key of ["transport", "url", "creds", "kinds", "fallback"]) expect(block).toContain(`messaging.${key}`);
});

// --- validate: the whole-file checks --------------------------------------------------------------------------------

test("transport nats needs a messaging.url", () => {
  for (const messaging of [{ transport: "nats" }, { transport: "nats", url: "" }]) {
    const p = validate(messaging);
    expect(p.code).toBe(1);
    expect(p.out).toMatch(/(^|\n)(error: )?messaging\.url:/);
  }
});

test("a messaging.url must start with nats:// or tls://", () => {
  const bad = validate({ transport: "nats", url: "http://100.64.0.1:4222" });
  expect(bad.code).toBe(1);
  expect(bad.out).toMatch(/(^|\n)(error: )?messaging\.url:/);
  expect(validate({ transport: "nats", url: "nats://h:4222" }).code).toBe(0);
  expect(validate({ transport: "nats", url: "tls://h:4222" }).code).toBe(0);
});

test("a messaging.kinds item must be a message kind", () => {
  const bad = validate({ kinds: ["claim", "gossip"] });
  expect(bad.code).toBe(1);
  expect(bad.out).toMatch(/(^|\n)(error: )?messaging\.kinds:/);
  expect(bad.out).toContain("gossip");
  const all = ["question", "answer", "mustfix", "approval", "status", "claim", "release", "wake", "handoff"];
  expect(validate({ kinds: all }).code).toBe(0);
});

test("transport github with a url set is fine", () => {
  expect(validate({ transport: "github", url: "nats://h:4222" }).code).toBe(0);
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

function ls(messaging: unknown) {
  const d = tmp();
  dirs.push(d);
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), JSON.stringify(messaging === undefined ? {} : { messaging }));
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}` };
  delete env.FACTORY_AGENT;
  return runHook("factory_messages", ["ls", "--fresh"], { cwd: d, env, timeoutMs: 60_000 });
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

test("transport github reads messages from GitHub and says nothing about a plugin", () => {
  const p = ls({ transport: "github" });
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("haile");
  expect(p.stderr).not.toContain("plugin-missing");
});

test("transport nats with the default fallback goes on with GitHub and says plugin-missing once", () => {
  const base = ls({ transport: "github" });
  const p = ls({ transport: "nats", url: "nats://127.0.0.1:4222" });
  expect(p.code).toBe(0);
  expect(p.stdout).toBe(base.stdout);
  expect(count(p.stderr, "plugin-missing")).toBe(1);
  expect(p.stderr).toContain("messaging.transport");
});

test("transport nats with fallback none stops and says plugin-missing", () => {
  const p = ls({ transport: "nats", url: "nats://127.0.0.1:4222", fallback: "none" });
  expect(p.code).not.toBe(0);
  expect(p.out).toContain("plugin-missing");
  expect(p.stdout).not.toContain("haile");
});

test("a command that does not use messaging is not stopped by nats with fallback none", () => {
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
  expect(p.out).not.toContain("plugin-missing");
});
