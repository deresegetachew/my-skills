// Every agent in the cockpit (#395): how each one runs (tmux, nohup, cloud) on its line, the other projects' agents from
// their state files, and the TALK TO entries that open a chat. Drawn from fixed snapshots, then `factory agents ls --json
// --local` and `factory cockpit --json` against throwaway state folders.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { sidebarOf, type SidebarRun } from "../cockpit/testing.tsx";
import { CI, copyHookFolders, envWith, gitRepo, HOOKS, runHook, SF, sh, tmp, write } from "./support.ts";

type Obj = Record<string, unknown>;

const VIEWS = [{ key: "1", title: "Needs you" }, { key: "2", title: "Pull requests" }, { key: "3", title: "Tasks & PRD" }];
const DOWN = "\x1b[B";
const ENTER = "\r";

const here = (name: string, state: string, more: Obj = {}): Obj =>
  ({ name, state, kind: "coding agent", where: "this machine", source: "local", machine: "aaaa1111", expected: true, ...more });
// The data type of the sidebar does not have `projects` yet: the tests pass it as the snapshot will.
const data = (sessions: Obj[], projects?: Obj[]) => ({ snapshot: { sessions, needsYou: [], ...(projects ? { projects } : {}) }, views: VIEWS });
const lineOf = (frame: string, name: string) => frame.split("\n").find((l) => new RegExp(`\\b${name}\\b`).test(l)) ?? "";

async function reach(s: SidebarRun, call: string): Promise<void> {
  for (let i = 0; i < 20 && !s.calls.includes(call); i++) {
    await s.press(DOWN);
    await s.press(ENTER);
  }
}

// --- how an agent runs ----------------------------------------------------------------------------------------------------

test("a nohup agent says nohup on its line; a tmux agent does not", () => {
  const s = sidebarOf(data([here("menelik", "working", { task: "12", runs: "nohup" }), here("haile", "working", { task: "5", runs: "tmux" }),
    here("tewodros", "down", { runs: null })]) as never, 80);
  const f = s.frame();
  expect(lineOf(f, "menelik")).toMatch(/menelik\s+working\s+#12.*nohup/);
  expect(lineOf(f, "haile")).toMatch(/haile\s+working\s+#5/);
  expect(lineOf(f, "haile")).not.toContain("nohup");
  expect(lineOf(f, "tewodros")).toMatch(/tewodros\s+down/);
  expect(lineOf(f, "tewodros")).not.toContain("nohup");
  s.unmount();
});

// --- the other projects --------------------------------------------------------------------------------------------------

const REMANUAL = (fresh: boolean) => [{ project: "remanual", fresh, agents: [
  { name: "fasil", state: "working", task: "3", runs: "tmux" }, { name: "haile", state: "down", task: null, runs: null }] }];

test("OTHER PROJECTS lists another project's agents with their state", () => {
  const s = sidebarOf(data([here("haile", "working", { task: "9" })], REMANUAL(true)) as never, 80, 40);
  const f = s.frame();
  expect(f).toContain("OTHER PROJECTS");
  expect(f).toContain("remanual");
  expect(lineOf(f, "fasil")).toMatch(/fasil\s+working\s+#3/);
  // the same name in both projects: two rows, each with its own state
  const haile = f.split("\n").filter((l) => /\bhaile\b/.test(l));
  expect(haile).toHaveLength(2);
  expect(haile.some((l) => /haile\s+working\s+#9/.test(l))).toBe(true);
  expect(haile.some((l) => /haile\s+down/.test(l))).toBe(true);
  s.unmount();
});

test("a project whose state file is not fresh shows its agents as unknown", () => {
  const s = sidebarOf(data([], REMANUAL(false)) as never, 80, 40);
  const f = s.frame();
  expect(lineOf(f, "fasil")).toMatch(/fasil\s+unknown/);
  expect(lineOf(f, "fasil")).not.toContain("working");
  s.unmount();
});

test("another project's agents cannot be selected: no key opens their session", async () => {
  const s = sidebarOf(data([here("haile", "working")], REMANUAL(true)) as never, 80, 40);
  for (let i = 0; i < 12; i++) {
    await s.press(DOWN);
    await s.press(ENTER);
  }
  expect(s.calls).not.toContain("session fasil");
  expect(s.calls.filter((c) => c === "session haile").length).toBeLessThanOrEqual(12);
  s.unmount();
});

// --- TALK TO ---------------------------------------------------------------------------------------------------------------

test("TALK TO lists the dev manager and the product owner after the views", () => {
  const s = sidebarOf(data([here("haile", "working")]) as never, 60, 30);
  const f = s.frame();
  expect(f).toContain("TALK TO");
  expect(f).toContain("dev manager");
  expect(f).toContain("product owner");
  expect(f.indexOf("VIEWS")).toBeLessThan(f.indexOf("TALK TO"));
  expect(f.indexOf("TALK TO")).toBeLessThan(f.indexOf("dev manager"));
  expect(f.indexOf("dev manager")).toBeLessThan(f.indexOf("product owner"));
  s.unmount();
});

test("Enter on dev manager asks for a chat with the dev manager; on product owner, with the product owner", async () => {
  const s = sidebarOf(data([]) as never, 60, 30);
  await reach(s, "chat dev-manager");
  expect(s.calls).toContain("chat dev-manager");
  expect(s.calls).not.toContain("chat product-owner");
  await reach(s, "chat product-owner");
  expect(s.calls).toContain("chat product-owner");
  s.unmount();
});

test("sessions still come first and the views next: Enter on the first row opens the first session", async () => {
  const s = sidebarOf(data([here("haile", "working")]) as never, 60, 30);
  await s.press(ENTER);
  expect(s.calls).toEqual(["session haile"]);
  s.unmount();
});

// --- factory agents ls --json --local ------------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

function repoWith(rows: Record<string, Obj>): { d: string; env: Env } {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "haile", "tewodros"] }));
  const state = join(root, "state");
  const now = Math.floor(Date.now() / 1000);
  write(join(state, `${basename(d)}-factory`, "heartbeat.json"), JSON.stringify({ machine: "aaaa1111", pid: process.pid, updated: now, interval: 20,
    agents: rows }));
  const env: Env = envWith(null, { XDG_STATE_HOME: state, HOME: join(root, "home"), FACTORY_NOW: undefined, FACTORY_AGENT: undefined,
    FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: join(root, "cfg") });
  return { d, env };
}

const beat = (name: string, state: string, more: Obj = {}): Obj => ({ name, kind: "coding-agent", machine: "aaaa1111", path: null, pid: null,
  session: null, follow: null, activity: null, state, detail: state, task: null, on: null, ...more });

test("agents ls --json --local says how each agent runs: nohup, tmux, or nothing when down", () => {
  const r = repoWith({
    menelik: beat("menelik", "working", { pid: process.pid, task: "12", session: null }),
    haile: beat("haile", "working", { pid: process.pid, task: "5", session: "work-haile" }),
    tewodros: beat("tewodros", "down"),
  });
  const p = runHook("factory_agents", ["ls", "--json", "--local"], { cwd: r.d, env: r.env });
  expect(p.code, p.out).toBe(0);
  const rows = new Map((JSON.parse(p.stdout) as { agents: Obj[] }).agents.map((a) => [a.name as string, a]));
  expect(rows.get("menelik")?.runs).toBe("nohup");
  expect(rows.get("haile")?.runs).toBe("tmux");
  expect(rows.get("tewodros")?.runs).toBeNull();
});

// --- factory cockpit --json ---------------------------------------------------------------------------------------------

const FAKE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] !== "api") { console.log("ok"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", "").replace(/^repos\/o\/r(\/|$)/, (_m, s) => (s ? "" : "repo")), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json" || path.startsWith("actions/variables/")) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
if (path === "issues" || path === "pulls" || path === "issues/comments" || path === "branches") out([]);
if (path === "repo") out({ default_branch: "main" });
if (path === "actions/runs") out({ workflow_runs: [] });
if (path === "actions/runners") out({ runners: [] });
if (path.startsWith("issues/") && path.endsWith("/comments")) out([]);
console.error("fake gh: no answer for " + path);
process.exit(1);
`;

test("cockpit --json lists another project's agents from its state file, and leaves this project out", () => {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik"] }));
  write(join(root, "bin", "gh"), FAKE_GH, 0o755);
  const state = join(root, "state");
  const now = Math.floor(Date.now() / 1000);
  const beatFile = (repo: string, agents: Record<string, Obj>) =>
    write(join(state, `${repo}-factory`, "heartbeat.json"), JSON.stringify({ machine: "aaaa1111", pid: process.pid, updated: now, interval: 20, agents }));
  beatFile("remanual", { fasil: beat("fasil", "working", { pid: process.pid, task: "3", session: "remanual-fasil" }), haile: beat("haile", "down") });
  beatFile("work", { menelik: beat("menelik", "idle", { pid: process.pid }) });
  mkdirSync(join(root, "home"));
  const env = envWith(join(root, "bin"), { XDG_STATE_HOME: state, HOME: join(root, "home"), FACTORY_AGENT: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined, FACTORY_COCKPIT_CACHE_SECONDS: undefined, FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: undefined,
    XDG_CONFIG_HOME: join(root, "config") });
  const p = sh(["bash", join(SF, "factory"), "cockpit", "--json"], { cwd: d, env, timeoutMs: 170_000 });
  expect(p.code, p.out).toBe(0);
  const snap = JSON.parse(p.stdout) as { projects?: { project: string; fresh: boolean; agents: Obj[] }[] };
  expect(snap.projects?.map((x) => x.project)).toEqual(["remanual"]);
  const remanual = snap.projects?.[0];
  expect(remanual?.fresh).toBe(true);
  const fasil = remanual?.agents.find((a) => a.name === "fasil");
  expect(fasil).toMatchObject({ name: "fasil", state: "working", task: "3", runs: "tmux" });
  const haile = remanual?.agents.find((a) => a.name === "haile");
  expect(haile).toMatchObject({ state: "down", runs: null });
}, 180_000);
