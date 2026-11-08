// `factory snapshot` and doctor (#473): with FACTORY_SNAPSHOT_DOCTOR_SECONDS the web UI's snapshots reuse the doctor
// part of the cached snapshot while it is young; a person running `factory snapshot` always gets doctor run.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CI, copyHookFolders, envWith, gitRepo, HOOKS, sh, SF, tmp, write, type Proc } from "./support.ts";

const T = 180_000;

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.SNAPSHOT_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.SNAPSHOT_LOG as string, a.join(" ") + "\n");
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] !== "api") { console.log("ok"); process.exit(0); }
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "POST" && x !== "PATCH" && x !== "Accept: application/vnd.github+json")[0] as string;
const short = raw.replace("repos/{owner}/{repo}/", "").replace(/^repos\/o\/r(\/|$)/, (_m, slash) => slash ? "" : "repo");
const path = new URL(short, "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json" || path.startsWith("actions/variables/")) fail("gh: Not Found (HTTP 404)");
if (path in s) out(s[path]);
if (path.startsWith("issues/") && path.endsWith("/comments")) out([]);
fail("fake gh: no answer for " + path);
`;

type Row = Record<string, any>;
type Env = Record<string, string | undefined>;
interface Proj { d: string; env: Env; xdg: string; log: string }

const CFG = { tasks: { source: "issues" }, reviewMarkers: "tmp/reviews", agents: ["menelik", "taytu"] };
const SCENARIO: Row = {
  issues: [], pulls: [], repo: { default_branch: "main" },
  "actions/runs": { workflow_runs: [] }, "actions/runners": { runners: [] },
};

function setup(): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  cpSync(CI, join(d, ".claude", "ci"), { recursive: true });
  write(join(d, ".claude", "factory.json"), JSON.stringify(CFG));
  write(join(root, "bin", "gh"), FAKE_GH, 0o755);
  write(join(root, "scenario.json"), JSON.stringify(SCENARIO));
  const xdg = join(root, "state");
  mkdirSync(xdg);
  mkdirSync(join(root, "home"));
  const log = join(root, "log");
  writeFileSync(log, "");
  const env = envWith(join(root, "bin"), { SNAPSHOT_SCENARIO: join(root, "scenario.json"), SNAPSHOT_LOG: log, XDG_STATE_HOME: xdg,
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), FACTORY_AGENT: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENTS: undefined, FACTORY_CONFIG_DIR: undefined, FACTORY_SNAPSHOT_DOCTOR_SECONDS: undefined });
  return { d, env, xdg, log };
}

function snap(p: Proj, extra: Env = {}): { j: Row; calls: string[] } {
  writeFileSync(p.log, "");
  const r: Proc = sh(["bash", join(SF, "factory"), "snapshot"], { cwd: p.d, env: { ...p.env, ...extra }, timeoutMs: 120_000 });
  expect(r.code, r.out).toBe(0);
  return { j: JSON.parse(r.stdout) as Row, calls: readFileSync(p.log, "utf8").split("\n").filter(Boolean) };
}

/** The calls only doctor makes. */
const DOCTOR = /branches\/main\/protection|rules\/branches\/main|auth status/;
const doctorCalls = (calls: string[]): string[] => calls.filter((c) => DOCTOR.test(c));

function cacheFile(p: Proj): string {
  return join(p.xdg, "work-factory", "snapshot.json");
}

const HOUR = { FACTORY_SNAPSHOT_DOCTOR_SECONDS: "3600" };

test("a snapshot with FACTORY_SNAPSHOT_DOCTOR_SECONDS reuses a young doctor result: no doctor calls, the same doctor, doctorAt kept", () => {
  const p = setup();
  const first = snap(p, HOUR);
  expect(doctorCalls(first.calls).length, first.calls.join("\n")).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(first.j.doctorAt)), "doctorAt is an ISO time").toBe(false);
  const second = snap(p, HOUR);
  expect(doctorCalls(second.calls)).toEqual([]);
  expect(second.j.doctor).toEqual(first.j.doctor);
  expect(second.j.doctorAt).toBe(first.j.doctorAt);
}, T);

test("without the variable, doctor runs on every snapshot", () => {
  const p = setup();
  snap(p, HOUR);
  const again = snap(p);
  expect(doctorCalls(again.calls).length, again.calls.join("\n")).toBeGreaterThan(0);
}, T);

test("a doctor result older than the limit is read again, and doctorAt moves", () => {
  const p = setup();
  const first = snap(p, HOUR);
  const cached = JSON.parse(readFileSync(cacheFile(p), "utf8")) as Row;
  cached.doctorAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  writeFileSync(cacheFile(p), JSON.stringify(cached));
  const again = snap(p, HOUR);
  expect(doctorCalls(again.calls).length, again.calls.join("\n")).toBeGreaterThan(0);
  expect(Date.parse(again.j.doctorAt)).toBeGreaterThan(Date.parse(first.j.doctorAt) - 1);
  expect(Date.now() - Date.parse(again.j.doctorAt)).toBeLessThan(3600 * 1000);
}, T);
