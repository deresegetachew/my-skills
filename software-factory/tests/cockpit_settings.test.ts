// `factory cockpit --settings` (#340, PRD US-13): the cockpit's Settings view, towards its board
// (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VSettings.dc.html). The settings as a table (setting, value, from, what it
// does), project settings by section and this machine's own, the staged project changes in one box, and the keys.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { envWith, git, gitRepo, HOOKS, SF, sh, tmp, WIKI, write, type Proc } from "./support.ts";

const T = 60_000;
type Env = Record<string, string | undefined>;
interface Proj { d: string; env: Env }

const CLEAN: Env = { FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDECODE: undefined, CLAUDE_PROJECT_DIR: undefined,
  FACTORY_CONFIG_DIR: undefined, NO_COLOR: undefined, COLUMNS: undefined, LINES: undefined };

function setup(factory: Record<string, unknown>, machine?: Record<string, unknown>): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  write(join(d, ".claude", "factory.json"), JSON.stringify(factory, null, 2) + "\n");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "factory.json");
  const config = join(root, "config");
  const env = envWith(null, { ...CLEAN, HOME: join(root, "home"), XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(root, "state") });
  if (machine) {
    // this machine's own file: `factory settings --local` writes it, so let it say where
    const r = sh(["bash", join(SF, "factory"), "settings", "--local", "set", "autostart", "false"], { cwd: d, env });
    expect(r.code, r.out).toBe(0);
    const path = /in (\S+\.json)/.exec(r.stdout)?.[1] ?? "";
    expect(path, r.out).not.toBe("");
    write(path, JSON.stringify(machine, null, 2) + "\n");
  }
  return { d, env };
}

function factory(p: Proj, args: string[], extra: Env = {}): Proc {
  return sh(["bash", join(SF, "factory"), ...args], { cwd: p.d, env: { ...p.env, ...extra }, timeoutMs: 50_000 });
}

function view(p: Proj, extra: Env = {}, args: string[] = []): Proc {
  return factory(p, ["cockpit", "--settings", ...args], { COLUMNS: "160", ...extra });
}

function stage(p: Proj, key: string, value?: string): void {
  const r = factory(p, value === undefined ? ["settings", "unset", "--stage", key] : ["settings", "set", "--stage", key, value]);
  expect(r.code, r.out).toBe(0);
}

/** The line of the table that starts with the setting `key` (after the selection marker, if any). */
function rowOf(out: string, key: string): string {
  const line = out.split("\n").find((l) => l.replace(/^[\s›>│|]+/, "").startsWith(key + " ") || l.replace(/^[\s›>│|]+/, "").startsWith(key + "\t"));
  expect(line, `no row for ${key} in:\n${out}`).toBeDefined();
  return line as string;
}

const BASE = { tasks: { source: "issues" }, trustedReviewers: ["deresegetachew"], agents: ["menelik", "taytu"] };

test("the table has the board's columns and says where each value comes from", () => {
  const p = setup(BASE);
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/setting\s+value\s+from\s+what it does/);
  const trusted = rowOf(r.stdout, "trustedReviewers");
  expect(trusted).toContain('["deresegetachew"]');
  expect(trusted).toMatch(/\bmain\b/);
  const budget = rowOf(r.stdout, "budget.builder");
  expect(budget).toMatch(/\bdefault\b/);
  expect(r.stdout).toContain("values from main, this machine's file, defaults");
}, T);

test("settings that need the owner's decision carry the ◆ mark, others do not", () => {
  const p = setup(BASE);
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  expect(rowOf(r.stdout, "trustedReviewers")).toMatch(/^[^a-z]*trustedReviewers ◆/);
  expect(rowOf(r.stdout, "tasks.source")).not.toContain("◆");
  expect(r.stdout).toMatch(/◆[^\n]*owner/); // a legend says what the mark means
}, T);

test("project settings are grouped under PROJECT (via PR) by section, machine ones under THIS MACHINE (direct)", () => {
  const p = setup(BASE, { ci: { runners: 4 }, agents: ["menelik"] });
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  const out = r.stdout;
  const project = out.indexOf("PROJECT (via PR)");
  const machine = out.indexOf("THIS MACHINE (direct)");
  expect(project, out).toBeGreaterThanOrEqual(0);
  expect(machine, out).toBeGreaterThan(project);
  for (const title of ["Agents & loops", "Issues mode", "CI"]) expect(out).toContain(title);
  expect(out.slice(machine)).toContain(hostname());
  // the machine's own value, from this machine
  const lines = out.slice(machine).split("\n");
  const agents = lines.find((l) => /^[\s›>│|]*agents\s/.test(l));
  expect(agents, out).toBeDefined();
  expect(agents).toContain("menelik");
  expect(agents).toContain("this machine");
}, T);

test("staged project changes show as pending, and the box lists them as one pull request", () => {
  const p = setup({ ...BASE, roles: { "product-owner": { artifacts: false } } });
  stage(p, "roles.product-owner.artifacts", "true");
  stage(p, "budget.builder", "300000");
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  const artifacts = rowOf(r.stdout, "roles.product-owner.artifacts");
  expect(artifacts).toContain("true (pending)");
  expect(artifacts).toContain("your change");
  expect(rowOf(r.stdout, "budget.builder")).toContain("(pending)");
  expect(r.stdout).toContain("2 project changes waiting · they go to main as one pull request");
  expect(r.stdout).toContain('- "roles.product-owner.artifacts": false');
  expect(r.stdout).toContain('+ "roles.product-owner.artifacts": true');
  expect(r.stdout).toContain('+ "budget.builder": 300000');
  expect(r.stdout).toContain("factory settings pr");
  expect(r.stdout).toContain(".claude/factory.json is protected");
}, T);

test("a staged unset shows the default as pending", () => {
  const p = setup(BASE);
  stage(p, "trustedReviewers");
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  expect(rowOf(r.stdout, "trustedReviewers")).toContain("(pending)");
  expect(r.stdout).toContain("1 project change waiting");
  expect(r.stdout).toContain('- "trustedReviewers": ["deresegetachew"]');
}, T);

test("with nothing staged the box says so and how to stage", () => {
  const p = setup(BASE);
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("No project changes waiting");
  expect(r.stdout).toContain("factory settings set --stage");
}, T);

test("a damaged staging file does not stop the view: the box says what to do", () => {
  const p = setup(BASE);
  const common = git(p.d, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  write(join(common, "factory", "settings-staged.json"), "{ not json");
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("factory settings unstage");
}, T);

test("the keys line names the commands for edit, help, default, search and the PR", () => {
  const p = setup(BASE);
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  for (const s of ["factory settings set --stage", "factory settings help", "factory settings unset --stage", "factory settings pr"]) {
    expect(r.stdout).toContain(s);
  }
}, T);

test("no colour unless asked; --color colours it; NO_COLOR wins", () => {
  const p = setup(BASE);
  stage(p, "budget.builder", "300000");
  const plain = view(p);
  expect(plain.code, plain.out).toBe(0);
  expect(plain.stdout).not.toContain("\x1b");
  const coloured = view(p, {}, ["--color"]);
  expect(coloured.code, coloured.out).toBe(0);
  expect(coloured.stdout).toContain("\x1b[");
  const off = view(p, { NO_COLOR: "1" }, ["--color"]);
  expect(off.code, off.out).toBe(0);
  expect(off.stdout).not.toContain("\x1b");
}, T);

test("on a narrow terminal no line is wider than it, and every setting is still there", () => {
  const p = setup(BASE);
  stage(p, "roles.product-owner.artifacts", "true");
  for (const cols of [40, 60, 80]) {
    const r = view(p, { COLUMNS: String(cols) });
    expect(r.code, r.out).toBe(0);
    for (const line of r.stdout.split("\n")) expect([...line].length, `${cols}: ${line}`).toBeLessThanOrEqual(cols);
    expect(r.stdout).toContain("trustedReviewers");
    expect(r.stdout).toContain("budget.builder");
    expect(r.stdout).toContain("(pending)");
  }
}, T);

test("a wide terminal keeps the lines within it too", () => {
  const p = setup(BASE);
  const r = view(p, { COLUMNS: "120" });
  expect(r.code, r.out).toBe(0);
  for (const line of r.stdout.split("\n")) expect([...line].length, line).toBeLessThanOrEqual(120);
}, T);

test("a value or help text can't drive the terminal", () => {
  const p = setup({ ...BASE, mainBranch: "ma\x1b[2Jin\x07" });
  const r = view(p);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).not.toContain("\x1b");
  expect(r.stdout).not.toContain("\x07");
}, T);

for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
  test(`in an agent session (${name} set) the view refuses with {code, message, fix}`, () => {
    const p = setup(BASE);
    const r = view(p, { [name]: name === "CLAUDECODE" ? "1" : "taytu" });
    expect(r.code, r.out).not.toBe(0);
    expect(r.stdout).not.toContain("trustedReviewers");
    const last = r.stderr.trim().split("\n").pop() ?? "";
    const j = JSON.parse(last) as Record<string, unknown>;
    expect(j.code).toBe("cockpit_agent_session");
    expect(typeof j.message).toBe("string");
    expect(typeof j.fix).toBe("string");
  }, T);
}

test("--settings takes nothing after it", () => {
  const p = setup(BASE);
  const r = factory(p, ["cockpit", "--settings", "extra"]);
  expect(r.code, r.out).toBe(2);
  const j = JSON.parse(r.stderr.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
  expect(j.code).toBe("cockpit_usage");
}, T);

test("factory help and the wiki's commands page list factory cockpit --settings", () => {
  const p = setup(BASE);
  const r = factory(p, ["help"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/cockpit --settings\s+\S/);
  const page = readFileSync(join(WIKI, "commands.md"), "utf8");
  expect(page).toContain("factory cockpit --settings");
}, T);
