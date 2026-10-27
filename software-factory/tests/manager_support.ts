// Shared helpers for the dev manager's gate tests (manager_gate.test.ts, manager_close.test.ts). Not a test file.
//
// The gate runs as Claude Code runs a PreToolUse hook (the tool call as JSON on stdin; exit 2 blocks) against a fake
// `gh` that reads one JSON file. The profile and the skill are read as files.
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fnmatch, shQuote } from "../hooks/factory_lib.ts";
import { simpleCommands } from "../hooks/factory_shell.ts";
import { envWith, git, HOOKS, KIT, runBun, tmp, write, writeExe } from "./support.ts";

export const GATE = join(HOOKS, "manager_gate.ts");
export const PROFILE = join(KIT, ".claude", "manager", "settings.json");
export const SKILL = join(KIT, ".claude", "skills", "manage-pass", "SKILL.md");

export const HEAD = "a".repeat(40);

export const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const db = JSON.parse(readFileSync(process.env.FAKE_DB as string, "utf8"));
const a = process.argv.slice(2);
function out(x: unknown): never { console.log(JSON.stringify(x)); process.exit(0); }
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
if (a[0] !== "api") fail("fake gh: only gh api");
const path = a.slice(1).filter((x) => !x.startsWith("-") && x.includes("/") && !x.startsWith("Accept"))[0];
if (path.startsWith("repos/{owner}/{repo}/contents/.claude/factory.json")) out(db.factory ?? {});
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = decodeURIComponent(u.pathname.slice(1)); const page = Number(u.searchParams.get("page") ?? "1");
if (db.down) fail("HTTP 500");
let m = /^pulls\/(\d+)$/.exec(p);
if (m) out(db.pulls[m[1]]);
m = /^issues\/(\d+)\/comments$/.exec(p);
if (m) out(page === 1 ? db.comments[m[1]] ?? [] : []);
m = /^commits\/(\w+)\/check-runs$/.exec(p);
if (m) out({ check_runs: db.runs ?? [], total_count: (db.runs ?? []).length });
m = /^commits\/(\w+)\/status$/.exec(p);
if (m) out({ statuses: db.statuses ?? [], total_count: 0 });
fail("fake gh: no route for " + p);
`;

export type Row = Record<string, unknown>;

export function comment(body: string, login = "me"): Row {
  return { body, user: { login } };
}

export function runOk(name: string, o: { at?: string; started?: string; conclusion?: string | null; status?: string; id?: number } = {}): Row {
  const at = o.at ?? "2026-10-25T10:00:00Z";
  return { id: o.id ?? 1, name, status: o.status ?? "completed", conclusion: o.conclusion === undefined ? "success" : o.conclusion,
    started_at: o.started ?? at };
}

export interface World {
  pr?: Row;
  comments?: Row[];
  runs?: Row[];
  statuses?: Row[];
  down?: boolean;
  cfg?: Row;
}

export type Env = Record<string, string | undefined>;

export function world(w: World = {}): [string, Env] {
  const d = tmp();
  write(join(d, ".claude", "factory.json"), JSON.stringify(w.cfg ?? {}));
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const pull = { state: "open", head: { sha: HEAD, ref: "task/12-guard-rails" }, body: "Closes #12", ...(w.pr ?? {}) };
  const db = {
    pulls: { "7": pull },
    comments: { "7": w.comments ?? [comment(`<!-- factory-approved sha=${HEAD.slice(0, 12)} -->\nLooks good.`)] },
    runs: w.runs ?? [runOk("test"), runOk("lint")], statuses: w.statuses ?? [], down: w.down ?? false, factory: w.cfg ?? {},
  };
  write(join(d, "db.json"), JSON.stringify(db));
  git(d, "init", "-q");
  return [d, envWith(join(d, "bin"), { FAKE_DB: join(d, "db.json"), CLAUDE_PROJECT_DIR: d })];
}

export function gate(d: string, env: Env, command: string): [number, string] {
  const p = runBun(GATE, [], { cwd: d, env, input: JSON.stringify({ tool_input: { command } }), timeoutMs: 60_000 });
  return [p.code, p.stderr.trim()];
}

// --- the manager profile, as Claude Code matches it (#202) -----------------------------------------------------------

export interface Permissions {
  allow: string[];
  deny: string[];
}

export function profilePermissions(): Permissions {
  return (JSON.parse(readFileSync(PROFILE, "utf8")) as { permissions: Permissions }).permissions;
}

function ruleMatches(rule: string, kind: string, subject: string): boolean {
  const m = new RegExp(`^${kind}\\((.*)\\)$`, "s").exec(rule);
  return Boolean(m) && fnmatch(subject, m?.[1] as string);
}

/** Whether Claude Code would run `command` without asking: no `$(...)` or backticks, and every simple command in it
 * matches an allow rule and no deny rule. */
export function allowedByProfile(command: string): boolean {
  return allowedBy(profilePermissions(), command);
}

/** The same check against any settings file's permissions (the agents' settings, #182). */
export function allowedBy(profile: Permissions, command: string): boolean {
  if (command.includes("$(") || command.includes("`")) return false; // "can't be checked before it runs"
  for (const tokens of simpleCommands(command)) {
    const text = tokens.map((t) => (/\s/.test(t) ? shQuote(t) : t)).join(" ");
    const raw = tokens.join(" ");
    if (profile.deny.some((r) => [text, raw].some((x) => ruleMatches(r, "Bash", x)))) return false;
    if (!profile.allow.some((r) => [text, raw].some((x) => ruleMatches(r, "Bash", x)))) return false;
  }
  return true;
}

export function expectCode(got: [number, string], code: number, what = ""): void {
  expect(got[0], `${what} ${got[1]}`).toBe(code);
}
