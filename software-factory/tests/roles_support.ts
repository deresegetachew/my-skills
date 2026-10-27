// A throwaway project for the role tests (roles, orchestrator, product owner, po questions, flow, handover): a bare
// origin and a clone with the real factory, factory-loop.sh and hooks, a fake `claude` (logs its arguments) and a fake
// `gh` (a JSON file). Waits are 0 minutes. Not a test file.
import { chmodSync, copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GH as FAKE_GH_STATEFUL } from "./fakegh.ts";
import { HOOKS, type Proc, SF, sh, tmp, write, writeExe } from "./support.ts";

export { SF };
export const GIT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

export const CLAUDE = [
  "#!/usr/bin/env bash",
  "# Fake claude: logs its arguments; FAKE_CLAUDE_HOOK (a script) may react to the prompt.",
  "# one write per line: sub-managers run side by side, and a long line printed in pieces can be split by another's",
  String.raw`line="$(printf 'claude %s\n' "$(printf '%s' "$*" | tr '\n' ' ')")"; tmp="$(mktemp)"; printf '%s\n' "$line" > "$tmp"; cat "$tmp" >> "$LOOP_LOG"; rm -f "$tmp"`,
  'if [ -n "$' + '{FAKE_CLAUDE_HOOK:-}" ]; then bash "$FAKE_CLAUDE_HOOK" "$@"; exit $?; fi',
  "exit 0",
  "",
].join("\n");

export const GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const db = JSON.parse(readFileSync(process.env.FAKE_DB as string, "utf8")); const a = process.argv.slice(2);
appendFileSync(process.env.LOOP_LOG as string, "gh " + a.join(" ") + "\n");
if (a[0] !== "api") process.exit(1);
const skip = new Set(["GET", "PATCH", "POST", "PUT", "DELETE", "application/vnd.github+json"]);
const path = a.slice(1).filter((x) => !x.startsWith("-") && !skip.has(x))[0] as string;
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = decodeURIComponent(u.pathname.slice(1)); const q = u.searchParams; const page = Number(q.get("page") ?? "1");
function out(x: unknown): never { console.log(JSON.stringify(x)); process.exit(0); }
if (p === "user") out({ login: "me" });
if (p === "issues") {
  let items = db.issues ?? [];
  const lab = q.get("labels");
  if (lab !== null) items = items.filter((i: any) => (i.labels ?? []).map((l: any) => l.name).includes(lab));
  out(page === 1 ? items : []);
}
if (p === "pulls") out(page === 1 ? db.pulls ?? [] : []);
const m = /^issues\/(\d+)\/comments$/.exec(p);
if (m) out(page === 1 ? ((db.comments ?? {})[m[1] as string] ?? []).map((b: string) => ({ body: b, created_at: "2026-10-25T10:00:00Z" })) : []);
out([]);
`;

export type Env = Record<string, string | undefined>;
export type Row = Record<string, unknown>;

export function git(cwd: string, ...args: string[]): Proc {
  const p = sh(["git", ...args], { cwd, env: { ...process.env, ...GIT } });
  if (p.code !== 0) throw new Error(`git ${args.join(" ")}: ${p.out}`);
  return p;
}

export interface ProjectOptions {
  cfg?: Row;
  db?: Row;
  files?: Record<string, string>;
  profile?: boolean;
}

/** [root, work, env]: a clone of a bare origin with the factory, pushed to main, and the fakes on PATH. */
export function project(o: ProjectOptions = {}): [string, string, Env] {
  const d = tmp();
  const origin = join(d, "origin.git");
  const work = join(d, "work");
  const bin = join(d, "bin");
  git(d, "init", "-q", "--bare", "-b", "main", origin);
  git(d, "clone", "-q", origin, work);
  cpSync(HOOKS, join(work, ".claude", "hooks"), { recursive: true, filter: (s) => !s.includes("__pycache__") && !s.includes("node_modules") });
  for (const f of ["factory", "factory-loop.sh"]) {
    copyFileSync(join(SF, f), join(work, f));
    chmodSync(join(work, f), 0o755);
  }
  const base: Row = { waitMinutes: 0, agents: ["menelik", "taytu"],
    roles: { "dev-manager": { names: ["lead", "second"] }, "product-owner": { names: ["eleni", "sabla"], busyMinutes: 0, idleMinutes: 0 } },
    manager: { busyMinutes: 0, idleMinutes: 0 } };
  Object.assign(base, o.cfg ?? {});
  write(join(work, ".claude", "factory.json"), JSON.stringify(base));
  write(join(work, "docs", "build-plan.md"), "# Plan\n\n- [ ] **1.1 First task**\n");
  write(join(work, "CLAUDE.md"), "rules\n");
  write(join(work, ".gitignore"), "__pycache__/\n");
  if (o.profile !== false) write(join(work, ".claude", "manager", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(gh api *)"] } }));
  for (const [name, text] of Object.entries(o.files ?? {})) write(join(work, name), text);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "start");
  git(work, "push", "-q", "origin", "HEAD:main");
  writeExe(join(bin, "claude"), CLAUDE);
  writeExe(join(bin, "gh"), GH);
  writeFileSync(join(d, "db.json"), JSON.stringify(o.db ?? {}));
  const env: Env = { ...process.env, ...GIT, PATH: `${bin}:${process.env.PATH ?? ""}`, LOOP_LOG: join(d, "log"),
    FAKE_DB: join(d, "db.json"), FACTORY_REMOTE_CONTROL: "0", HOME: d };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_ROLE", "FACTORY_NAME", "FACTORY_RELOAD_AGENT",
    "FACTORY_RELOAD_DIR", "FACTORY_RESUME", "CLAUDE_PROJECT_DIR"]) delete env[k];
  writeFileSync(join(d, "log"), "");
  return [d, work, env];
}

export function factory(work: string, env: Env, args: string[], timeoutMs = 90_000): Proc {
  return sh(["bash", "./factory", ...args], { cwd: work, env, timeoutMs });
}

export function log(env: Env): string[] {
  return readFileSync(env.LOOP_LOG as string, "utf8").split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
}

export function claudeCalls(env: Env): string[] {
  return log(env).filter((l) => l.startsWith("claude "));
}

export function porcelain(work: string): string {
  return git(work, "status", "--porcelain").stdout;
}

// --- the product owner's project (test_product_owner.py) ------------------------------------------------------------

export const PRD = `# PRD

## User stories

- US-1: Upload a manual
- US-2: Review the draft guide
### US-3. Publish a guide
- **US-4** Follow a guide offline
- US-4: Follow a guide on a phone
- US-5: Ask the builder helper
`;

export function issue(n: number, title: string, body = "", labels: string[] = [], state = "open", reason: string | null = null): Row {
  return { number: n, title, body, state, labels: labels.map((x) => ({ name: x })), state_reason: reason };
}

export const TASKS = [
  issue(10, "Upload form", "## Brief\n- **PRD:** US-1\n", [], "closed"),
  issue(11, "Upload errors", "PRD: US-1", [], "closed"),
  issue(12, "Review screen", "- **PRD:** US-2\n", ["factory:in-progress"]),
  issue(13, "Publish gate", "PRD: US-3", ["factory:ready"]),
  issue(14, "Dropped idea", "PRD: US-5", [], "closed", "not_planned"),
  issue(15, "Old story", "PRD: US-9", ["factory:ready"]),
  issue(16, "No story named", "## Brief\n- **PRD:** \n", ["factory:ready"]),
];

/** The role project with the stateful fake gh (fakegh.ts) and a PRD. */
export function poProject(o: { db?: Row; cfg?: Row; prd?: string; files?: Record<string, string> } = {}): [string, string, Env] {
  const [d, work, env] = project({ db: o.db ?? { issues: TASKS }, cfg: o.cfg, files: { "docs/PRD.md": o.prd ?? PRD, ...(o.files ?? {}) } });
  writeExe(join(d, "bin", "gh"), FAKE_GH_STATEFUL);
  return [d, work, env];
}

export function posted(d: string): Row[] {
  const db = JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as Row;
  return (db.posted as Row[] | undefined) ?? [];
}

export function exists(p: string): boolean {
  return existsSync(p);
}
