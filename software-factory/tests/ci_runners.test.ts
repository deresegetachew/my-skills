// `factory ci runners [<n>]` and `factory ci clean [--apply]` (#282).
//
// The runner count is saved per project and machine (this machine's settings file, not committed), so a later
// `factory ci install` or `factory update` keeps it. Which count wins: FACTORY_CI_RUNNERS, then this machine's saved
// count, then `ci.runners` in .claude/factory.json, then 1. `factory ci clean` lists, and with --apply removes, this
// project's offline idle runners and exited CI containers, with the same code as `factory reset-run`.
//
// gh, launchctl, plutil, docker and scutil are fakes on PATH; HOME and the config folder are temp folders.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CI, HOOKS, git, readmeAndWiki, runCode, sh, SF, tmp, write, writeExe, type Proc } from "./support.ts";

type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;

// db: {runners: [...], variables: [...], containers: [...], deleted: [...]}. --jq runs real jq, as gh does.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const f = process.env.FAKE_DB as string; const db: any = JSON.parse(readFileSync(f, "utf8")); const a = process.argv.slice(2);
appendFileSync(f + ".calls", "gh " + a.join(" ") + "\n");
const save = () => writeFileSync(f, JSON.stringify(db));
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] === "variable") fail("fake gh: the tests never change a variable with gh variable");
if (a[0] !== "api") fail("fake gh: no answer for " + a.join(" "));
let method = "GET", jq: string | null = null, path = ""; const rest = a.slice(1);
for (let k = 0; k < rest.length;) {
  if (rest[k] === "-X") { method = rest[k + 1]; k += 2; }
  else if (rest[k] === "--jq") { jq = rest[k + 1]; k += 2; }
  else if (["-H", "-f", "-F", "--input"].includes(rest[k])) k += 2;
  else if (rest[k].startsWith("-")) k += 1;
  else { path = rest[k]; k += 1; }
}
const p = path.replace("repos/{owner}/{repo}/", "repos/acme/widget/").split("?")[0];
let data: unknown;
if (p === "user") data = { login: "me" };
else if (p.endsWith("/registration-token") && method === "POST") data = { token: "fresh-token" };
else if (p === "repos/acme/widget/actions/runners") data = { runners: db.runners };
else if (p === "repos/acme/widget/actions/variables") data = { variables: db.variables };
else if (p.startsWith("repos/acme/widget/actions/variables/")) {
  const name = p.slice(p.lastIndexOf("/") + 1);
  if (method === "DELETE") { (db.deleted ??= []).push("variable " + name); db.variables = db.variables.filter((v: any) => v.name !== name); save(); data = {}; }
  else {
    const v = db.variables.find((v: any) => v.name === name);
    if (!v) { process.stderr.write("gh: Not Found (HTTP 404)\n"); process.exit(1); }
    data = v;
  }
} else if (p.startsWith("repos/acme/widget/actions/runners/") && method === "DELETE") {
  const id = Number(p.slice(p.lastIndexOf("/") + 1));
  (db.deleted ??= []).push("runner " + id); db.runners = db.runners.filter((r: any) => r.id !== id); save(); data = {};
} else fail("fake gh: no answer for " + method + " " + p);
if (jq) {
  const r = Bun.spawnSync(["jq", "-r", jq], { stdin: new TextEncoder().encode(JSON.stringify(data)) });
  if (r.exitCode !== 0) { process.stderr.write(r.stderr); process.exit(r.exitCode ?? 1); }
  process.stdout.write(r.stdout);
} else console.log(JSON.stringify(data));
`;

const FAKE_DOCKER = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const f = process.env.FAKE_DB as string; const db: any = JSON.parse(readFileSync(f, "utf8")); const a = process.argv.slice(2);
appendFileSync(f + ".calls", "docker " + a.join(" ") + "\n");
if (a[0] === "ps") for (const c of db.containers) console.log([c.id, c.name, c.project].join("\t"));
if (a[0] === "rm") { (db.deleted ??= []).push("container " + a[1]); db.containers = db.containers.filter((c: any) => c.id !== a[1]); writeFileSync(f, JSON.stringify(db)); }
if (a[0] === "build") process.exit(1);
`;

// Loaded agents are files in $FAKE_LAUNCHD/<label>.
const FAKE_LAUNCHCTL = `#!/usr/bin/env bash
echo "launchctl $*" >>"$FAKE_DB.calls"
d="$FAKE_LAUNCHD"; mkdir -p "$d"
case "$1" in
  print) l="\${2##*/}"; [ -f "$d/$l" ] || exit 113; echo "$l = {"; echo "}" ;;
  bootout) l="\${2##*/}"; [ -f "$d/$l" ] || exit 3; rm -f "$d/$l" ;;
  bootstrap) l="$(basename "$3" .plist)"; : >"$d/$l" ;;
esac
`;

interface Project {
  d: string;
  db: string;
  env: Env;
  machineFile: string;
}

function project(ci: Row = {}): Project {
  const root = tmp();
  const d = join(root, "widget");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const x of [d, bin, home]) mkdirSync(x);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  git(d, "remote", "add", "origin", "git@github.com:acme/widget.git");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ ci: { repo: "acme/widget", ...ci } }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  symlinkSync(CI, join(d, ".claude", "ci"));
  git(d, "add", "-A");
  git(d, "commit", "-qm", "x");
  for (const [name, body] of [["gh", FAKE_GH], ["docker", FAKE_DOCKER], ["launchctl", FAKE_LAUNCHCTL],
    ["plutil", "#!/bin/sh\nexit 0\n"], ["scutil", "#!/bin/sh\necho Test-Mac\n"]] as const) {
    writeExe(join(bin, name), body);
  }
  const db = join(root, "db.json");
  writeFileSync(db, JSON.stringify({ runners: [], variables: [], containers: [] }));
  const config = join(root, "config");
  const env: Env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, FAKE_DB: db,
    FAKE_LAUNCHD: join(root, "launchd"), FACTORY_CONFIG_DIR: config, FACTORY_CI_PLATFORM: "mac",
    FACTORY_CI_RUNNERS: undefined, FACTORY_CI_NO_SCALE_DOWN: undefined, FACTORY_CI_FREE_MB: "1000000",
    XDG_CONFIG_HOME: undefined, XDG_STATE_HOME: undefined, XDG_DATA_HOME: undefined, RUNNER_TOKEN: undefined,
    GIT_SSH_COMMAND: "false", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  return { d, db, env, machineFile: join(config, `${basename(d)}.json`) };
}

function factory(p: Project, env: Env, ...args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), ...args], { cwd: p.d, env, timeoutMs: 120_000 });
}

function ciSh(p: Project, env: Env, ...args: string[]): Proc {
  return sh(["bash", join(p.d, ".claude", "ci", "ci.sh"), ...args], { cwd: p.d, env, timeoutMs: 120_000 });
}

function names(p: Project, env: Env): Record<string, string> {
  const r = ciSh(p, env, "names");
  expect(r.code, r.out).toBe(0);
  return Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function agents(p: Project): string[] {
  const dir = join(p.env.HOME as string, "Library", "LaunchAgents");
  return existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/^dev\.software-factory\./, "").replace(/\.plist$/, "")).sort() : [];
}

function dbOf(p: Project): Row {
  return JSON.parse(readFileSync(p.db, "utf8")) as Row;
}

function setDb(p: Project, kw: Row): void {
  writeFileSync(p.db, JSON.stringify({ ...dbOf(p), ...kw }));
}

function calls(p: Project): string[] {
  const f = p.db + ".calls";
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l) : [];
}

function errorOf(r: Proc): Row {
  return JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as Row;
}

// --- which count wins ----------------------------------------------------------------------------------------------

test("the count comes from FACTORY_CI_RUNNERS then this machine then the project then 1", () => {
  const p = project();
  let n = names(p, p.env);
  expect([n.CI_RUNNERS, n.CI_RUNNERS_FROM]).toEqual(["1", "default"]);
  const q = project({ runners: 2 });
  n = names(q, q.env);
  expect([n.CI_RUNNERS, n.CI_RUNNERS_FROM]).toEqual(["2", "project"]);
  write(q.machineFile, JSON.stringify({ agents: ["ada"], "ci.runners": 3 }));
  n = names(q, q.env);
  expect([n.CI_RUNNERS, n.CI_RUNNERS_FROM]).toEqual(["3", "machine"]);
  n = names(q, { ...q.env, FACTORY_CI_RUNNERS: "4" });
  expect([n.CI_RUNNERS, n.CI_RUNNERS_FROM]).toEqual(["4", "env"]);
});

test("factory ci runners shows the count here and where it comes from", () => {
  const p = project({ runners: 2 });
  let r = factory(p, p.env, "ci", "runners");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("2 heavy CI runner(s)");
  expect(r.stdout).toContain("ci.runners in .claude/factory.json");
  expect(r.stdout).toContain("factory ci runners <n>");
  write(p.machineFile, JSON.stringify({ "ci.runners": 5 }));
  r = factory(p, p.env, "ci", "runners");
  expect(r.stdout, r.out).toContain("5 heavy CI runner(s)");
  expect(r.stdout).toContain("this machine's setting");
  expect(r.stdout).toContain(p.machineFile);
  r = factory(p, { ...p.env, FACTORY_CI_RUNNERS: "7" }, "ci", "runners");
  expect(r.stdout, r.out).toContain("7 heavy CI runner(s)");
  expect(r.stdout).toContain("FACTORY_CI_RUNNERS");
  expect(calls(p).filter((c) => c.startsWith("launchctl"))).toEqual([]); // showing it changes nothing
});

// --- saving and applying it --------------------------------------------------------------------------------------------

test("factory ci runners n saves it on this machine and installs that many", () => {
  const p = project();
  write(p.machineFile, JSON.stringify({ agents: ["ada"], autostart: true }));
  let r = factory(p, p.env, "ci", "runners", "3");
  expect(r.code, r.out).toBe(0);
  expect(JSON.parse(readFileSync(p.machineFile, "utf8"))).toEqual({ agents: ["ada"], autostart: true, "ci.runners": 3 });
  expect(agents(p)).toEqual(["widget-ci", "widget-ci-2", "widget-ci-3", "widget-ci-light"]);
  expect(r.stdout).toContain("not committed");
  // a later install (what `factory update` runs) keeps the saved count
  r = ciSh(p, p.env, "install");
  expect(r.code, r.out).toBe(0);
  expect(agents(p)).toEqual(["widget-ci", "widget-ci-2", "widget-ci-3", "widget-ci-light"]);
  // and a smaller number scales this machine down
  r = factory(p, p.env, "ci", "runners", "1");
  expect(r.code, r.out).toBe(0);
  expect(agents(p)).toEqual(["widget-ci", "widget-ci-light"]);
  expect(JSON.parse(readFileSync(p.machineFile, "utf8"))["ci.runners"]).toBe(1);
});

test("a bad count is refused with a fix and nothing is saved or installed", () => {
  const p = project();
  write(p.machineFile, JSON.stringify({ "ci.runners": 2 }));
  for (const bad of [["0"], ["17"], ["two"], ["2.5"], ["-1"], ["3", "4"]]) {
    const r = factory(p, p.env, "ci", "runners", ...bad);
    expect(r.code, `${bad.join(" ")}: ${r.out}`).toBe(1);
    const err = errorOf(r);
    expect(err.code, r.out).toBeDefined();
    expect(String(err.fix)).toContain("factory ci runners");
  }
  expect(JSON.parse(readFileSync(p.machineFile, "utf8"))).toEqual({ "ci.runners": 2 });
  expect(calls(p).filter((c) => c.startsWith("launchctl"))).toEqual([]);
});

test("saving gives the same memory warning as ci install", () => {
  const p = project();
  const r = factory(p, { ...p.env, FACTORY_CI_FREE_MB: "6000" }, "ci", "runners", "3");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("Warning: 3 heavy runner(s) and the light one need about 13312 MB");
  expect(r.stdout).toContain("factory ci runners <n>");
});

test("saving while FACTORY_CI_RUNNERS is set applies the saved count and says the variable wins later", () => {
  const p = project();
  const r = factory(p, { ...p.env, FACTORY_CI_RUNNERS: "4" }, "ci", "runners", "2");
  expect(r.code, r.out).toBe(0);
  expect(agents(p)).toEqual(["widget-ci", "widget-ci-2", "widget-ci-light"]);
  expect(r.out).toContain("FACTORY_CI_RUNNERS=4");
  expect(r.out).toContain("unset FACTORY_CI_RUNNERS");
});

test("the machine setting can be set with factory settings --local too", () => {
  const p = project();
  const env = { ...p.env, CLAUDECODE: undefined, FACTORY_AGENT: undefined, FACTORY_LOOP: undefined };
  let r = factory(p, env, "settings", "--local", "set", "ci.runners", "4");
  expect(r.code, r.out).toBe(0);
  expect(names(p, env).CI_RUNNERS).toBe("4");
  r = factory(p, env, "settings", "--local", "set", "ci.runners", "0");
  expect(r.code, r.out).not.toBe(0);
  r = factory(p, env, "settings", "--local", "set", "ci.runners", "17");
  expect(r.code, r.out).not.toBe(0);
  expect(names(p, env).CI_RUNNERS).toBe("4");
});

// --- factory update never scales a machine down --------------------------------------------------------------------------

test("an install without scale-down keeps the runners a machine has", () => {
  const p = project();
  expect(factory(p, p.env, "ci", "runners", "3").code).toBe(0);
  writeFileSync(p.machineFile, JSON.stringify({})); // the saved count is gone: the project says 1
  let r = ciSh(p, { ...p.env, FACTORY_CI_NO_SCALE_DOWN: "1" }, "install");
  expect(r.code, r.out).toBe(0);
  expect(agents(p)).toEqual(["widget-ci", "widget-ci-2", "widget-ci-3", "widget-ci-light"]);
  expect(r.stdout).toContain("Kept 3 heavy runner(s)");
  r = ciSh(p, p.env, "install"); // a person's own install does scale down
  expect(r.code, r.out).toBe(0);
  expect(agents(p)).toEqual(["widget-ci", "widget-ci-light"]);
});

// --- every reader uses the same count -------------------------------------------------------------------------------------

test("status names the count and where it comes from when the installed number differs", () => {
  const p = project();
  expect(ciSh(p, p.env, "install").code).toBe(0);
  write(p.machineFile, JSON.stringify({ "ci.runners": 2 }));
  setDb(p, { runners: [] });
  const r = ciSh(p, p.env, "status");
  expect(r.out).toContain("2 heavy runner(s) (this machine's setting)");
  expect(r.out).toContain("factory ci install");
});

test("the sandbox doctor wants the count this machine saved", () => {
  const p = project({ runners: 1 });
  write(p.machineFile, JSON.stringify({ "ci.runners": 3 }));
  writeExe(join(p.env.PATH?.split(":")[0] as string, "systemctl"),
    "#!/bin/sh\nprintf 'widget-ci.service loaded active running x\\nwidget-ci-light.service loaded active running x\\n'\n");
  const code = `import { services } from ${JSON.stringify(join(HOOKS, "factory_sandbox.ts"))};
const r = { ok: (w: string) => console.log("ok " + w), fix: (w: string, h: string) => console.log("fix " + w + ": " + h),
  note: (w: string, h: string) => console.log("note " + w + ": " + h) };
services(r as never, { ci: { runners: 1 } });`;
  const r = runCode(code, { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("fix CI runners: 2 active, ci.runners asks for 3");
});

// --- factory ci clean ------------------------------------------------------------------------------------------------------

function leftovers(p: Project): void {
  setDb(p, {
    runners: [{ id: 7, name: "widget-ci-old", status: "offline", busy: false, labels: [{ name: "self-hosted" }, { name: "widget-local" }] },
      { id: 8, name: "other-ci-old", status: "offline", busy: false, labels: [] },
      { id: 9, name: "widget-ci-busy", status: "offline", busy: true, labels: [] },
      { id: 10, name: "widget-ci-live", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "widget-local" }] }],
    variables: [{ name: "CI_RUNS_ON_LIGHT", value: '["self-hosted","widget-light"]' },
      { name: "CI_RUNS_ON", value: '["self-hosted","widget-local"]' }],
    containers: [{ id: "c1", name: "widget-ci-runner-1", project: "widget-ci" }, { id: "c2", name: "unrelated", project: "otherproj" },
      { id: "c3", name: "widget-ci-light-runner", project: "widget-ci-light" }, { id: "c4", name: "lookalike", project: "widget-ci-extra" }],
  });
}

test("factory ci clean lists this projects offline runners and exited containers and changes nothing", () => {
  const p = project();
  leftovers(p);
  const before = JSON.stringify(dbOf(p));
  const r = factory(p, p.env, "ci", "clean");
  expect(r.code, r.out).toBe(0);
  for (const what of ["remove the offline runner widget-ci-old", "remove the exited container widget-ci-runner-1",
    "remove the exited container widget-ci-light-runner", "--apply"]) expect(r.stdout, what).toContain(what);
  for (const not of ["other-ci-old", "widget-ci-busy", "widget-ci-live", "unrelated", "lookalike", "claims", "Agent issue"]) {
    expect(r.stdout, not).not.toContain(not);
  }
  // the runs-on variable whose runner is gone is only named, with the command that changes it
  expect(r.stdout).toContain("CI_RUNS_ON_LIGHT");
  expect(r.stdout).toContain("factory ci use");
  expect(JSON.stringify(dbOf(p))).toBe(before);
});

test("factory ci clean --apply removes them, never a variable, and a second run finds nothing", () => {
  const p = project();
  leftovers(p);
  let r = factory(p, p.env, "ci", "clean", "--apply");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.split("done,").length - 1, r.stdout).toBe(3);
  const after = dbOf(p);
  expect((after.runners as Row[]).map((x) => x.id)).toEqual([8, 9, 10]);
  expect((after.containers as Row[]).map((x) => x.id)).toEqual(["c2", "c4"]);
  expect((after.variables as Row[]).map((x) => x.name)).toEqual(["CI_RUNS_ON_LIGHT", "CI_RUNS_ON"]);
  expect((after.deleted as string[]).filter((x) => x.startsWith("variable"))).toEqual([]);
  r = factory(p, p.env, "ci", "clean", "--apply");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("Nothing to clean.");
  expect(r.stdout).not.toContain("done,");
});

test("factory ci clean refuses an unknown option before anything runs", () => {
  const p = project();
  const r = factory(p, p.env, "ci", "clean", "--force");
  expect(r.code, r.out).toBe(1);
  expect(errorOf(r).code).toBe("usage");
  expect(String(errorOf(r).fix)).toContain("factory ci clean");
  expect(calls(p)).toEqual([]);
});

test("factory reset-run still cleans the same runners and containers", () => {
  const p = project();
  leftovers(p);
  const r = sh([process.execPath, "--no-env-file", join(HOOKS, "factory_reset_run.ts"), "--apply"], { cwd: p.d, env: p.env });
  expect(r.code, r.out).toBe(0);
  const after = dbOf(p);
  expect((after.runners as Row[]).map((x) => x.id)).toEqual([8, 9, 10]);
  expect((after.containers as Row[]).map((x) => x.id)).toEqual(["c2", "c4"]);
  expect((after.variables as Row[]).map((x) => x.name)).toEqual(["CI_RUNS_ON"]); // reset-run still deletes a dangling one
});

// --- help and docs ---------------------------------------------------------------------------------------------------------

test("both commands are in factory help the commands page and the settings table", () => {
  const help = sh(["bash", join(SF, "factory"), "help"], { cwd: project().d }).stdout;
  expect(help).toContain("ci runners [<n>]");
  expect(help).toContain("ci clean [--apply]");
  const docs = readmeAndWiki();
  expect(docs).toContain("`factory ci runners [<n>]`");
  expect(docs).toContain("`factory ci clean [--apply]`");
  const settings = readmeAndWiki("settings.md");
  const machine = settings.slice(settings.indexOf("**Machine (local)**"));
  expect(machine).toContain("| `ci.runners` |");
});
