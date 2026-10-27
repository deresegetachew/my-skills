// `factory settings` and the Stop check's changed-only commands.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULTS } from "../hooks/factory_config.ts";
import { isFreeForm, isKnownPath, SETTINGS as table } from "../hooks/factory_settings_schema.ts";
import { HOOKS, KIT, type Proc, read, readJson, runBun, runHook, SF, sh, tmp, WIKI, write, writeExe } from "./support.ts";

type Env = Record<string, string | undefined>;
const SETTINGS = join(HOOKS, "factory_settings.ts");
const CHECK = join(HOOKS, "check.ts");

function project(cfg?: unknown): string {
  const d = tmp();
  sh(["git", "init", "-q", d]);
  mkdirSync(join(d, ".claude"));
  if (cfg !== undefined) write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  return d;
}

function personEnv(): Env {
  const env: Env = { ...process.env };
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) delete env[name];
  return env;
}

function settings(d: string, args: string[], env?: Env): Proc {
  return runBun(SETTINGS, args, { cwd: d, env: env ?? personEnv() });
}

function saved(d: string): Record<string, unknown> {
  return readJson(join(d, ".claude", "factory.json"));
}

test("list shows values here defaults and other keys", () => {
  const d = project({ _about: "x", maxOpenPRs: 4, custom: 1 });
  const p = settings(d, []);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("maxOpenPRs");
  expect(p.stdout).toContain("4");
  expect(p.stdout).toContain('"plan"  (default)'); // tasks.source, not set here
  expect(p.stdout).toContain("custom");
  expect(p.stdout.split("Other keys").at(-1)).not.toContain("_about");
});

test("the release repository is a setting with a default and can be changed", () => {
  const d = project({});
  const p = settings(d, ["show", "release.repo"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("deresegetachew/my-skills");
  expect(p.stdout).toContain("factory update");
  expect(settings(d, ["set", "release.repo", "acme/factory"]).code).toBe(0);
  expect(saved(d).release).toEqual({ repo: "acme/factory" });
});

test("show names the options", () => {
  const p = settings(project({}), ["show", "tasks.source"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("plan, issues");
  expect(p.stdout).toContain("here: (default)");
});

test("set checks the type and keeps everything else", () => {
  const d = project({ _about: "keep me", tasks: { source: "issues" }, custom: [1] });
  expect(settings(d, ["set", "tasks.pingMinutes", "10"]).code).toBe(0);
  expect(settings(d, ["set", "tasks.showWhere", "yes"]).code).toBe(0);
  expect(settings(d, ["set", "agents", '["ada","grace"]']).code).toBe(0);
  expect(saved(d)).toEqual({ _about: "keep me", tasks: { source: "issues", pingMinutes: 10, showWhere: true },
    custom: [1], agents: ["ada", "grace"] });
  for (const [key, bad] of [["tasks.source", "plans"], ["maxOpenPRs", "four"], ["maxOpenPRs", "-1"],
    ["agents", '["../x"]'], ["agents", "ada"], ["tasks.showWhere", "maybe"]] as const) {
    const p = settings(d, ["set", key, bad]);
    expect(p.code, `${key} ${bad}`).not.toBe(0);
  }
  expect((saved(d).tasks as Record<string, unknown>).source).toBe("issues");
});

test("an unknown key is refused and nothing is written", () => {
  const d = project({ maxOpenPRs: 4 });
  const p = settings(d, ["set", "protectedd", "[]"]);
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("isn't a setting");
  expect(saved(d)).toEqual({ maxOpenPRs: 4 });
});

test("unset goes back to the default", () => {
  const d = project({ maxOpenPRs: 4, tasks: { source: "issues" } });
  expect(settings(d, ["unset", "maxOpenPRs"]).code).toBe(0);
  expect(settings(d, ["get", "maxOpenPRs"]).stdout.trim()).toBe("3");
  expect(saved(d)).toEqual({ tasks: { source: "issues" } });
});

test("an agent session can read but never change settings", () => {
  const d = project({ maxOpenPRs: 4, protected: ["^\\.claude/"] });
  for (const [name, value] of [["FACTORY_AGENT", "1"], ["FACTORY_LOOP", "1"], ["CLAUDECODE", "1"], ["CLAUDECODE", ""]] as const) {
    const env = { ...personEnv(), [name]: value };
    expect(settings(d, ["set", "protected", "[]"], env).code).not.toBe(0);
    expect(settings(d, ["unset", "protected"], env).code).not.toBe(0);
    expect(settings(d, ["get", "maxOpenPRs"], env).stdout.trim()).toBe("4");
  }
  expect(saved(d)).toEqual({ maxOpenPRs: 4, protected: ["^\\.claude/"] });
});

test("agents are denied the settings command", () => {
  const rules = readJson<{ permissions: { deny: string[] } }>(join(KIT, ".claude", "settings.json")).permissions.deny;
  for (const rule of ["Bash(factory settings set*)", "Bash(factory settings unset*)", "Bash(*factory_setting*)"]) {
    expect(rules).toContain(rule);
  }
});

/** The Stop check in a factory run (`factory-loop.sh` exports FACTORY_LOOP=1), unless `loop` is false. */
function stopCheck(d: string, commands: Record<string, string>, outLines?: unknown, loop = true): Proc {
  mkdirSync(join(d, "src"), { recursive: true });
  const cfg: Record<string, unknown> = { codePaths: ["src"], commands };
  if (outLines) cfg.checkOutputLines = outLines;
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  write(join(d, "src", "a.ts"), "x"); // an untracked change under codePaths
  const env: Env = { ...personEnv(), CLAUDE_PROJECT_DIR: d };
  if (loop) env.FACTORY_LOOP = "1";
  return runBun(CHECK, [], { cwd: d, input: "{}", env });
}

test("the stop check runs nothing outside a factory run", () => {
  // #256: the owner's own session (FACTORY_AGENT set by the session hook, but no loop) never waits on the tests
  const d = project();
  for (const agent of [undefined, "menelik"]) {
    const env: Env = { ...personEnv(), CLAUDE_PROJECT_DIR: d };
    if (agent) env.FACTORY_AGENT = agent;
    mkdirSync(join(d, "src"), { recursive: true });
    write(join(d, ".claude", "factory.json"), JSON.stringify({ codePaths: ["src"], commands: { test: "echo ran > ran; exit 1" } }));
    write(join(d, "src", "a.ts"), "x");
    const p = runBun(CHECK, [], { cwd: d, input: "{}", env });
    expect(p.code, p.stderr).toBe(0);
    expect(existsSync(join(d, "ran")), `agent ${agent}`).toBe(false);
    expect(existsSync(join(d, "tmp")), "and writes no log").toBe(false);
  }
  expect(stopCheck(d, { test: "echo ran > ran; exit 1" }).code, "in a factory run it still runs and blocks").toBe(2);
  expect(existsSync(join(d, "ran"))).toBe(true);
});

test("the stop check runs the changed only command when set", () => {
  const d = project();
  const p = stopCheck(d, { test: "echo full > ran; exit 0", testChanged: "echo changed > ran; exit 0" });
  expect(p.code).toBe(0);
  expect(read(join(d, "ran")).trim()).toBe("changed");
  stopCheck(d, { test: "echo full > ran; exit 0" });
  expect(read(join(d, "ran")).trim()).toBe("full");
});

test("a bad output limit never skips the check", () => {
  const d = project();
  const p = stopCheck(d, { test: "echo 'FAIL x'; exit 1" }, "forty");
  expect(p.code).toBe(2);
  expect(p.stderr).toContain("FAIL x");
});

test("a failing check shows the failures first within the limit", () => {
  const d = project();
  const script = [...Array.from({ length: 200 }, (_, i) => `echo noise ${i}`), "echo 'FAIL src/a.test.ts > adds'",
    ...Array.from({ length: 200 }, (_, i) => `echo more ${i}`), "exit 1"].join("; ");
  const p = stopCheck(d, { test: script }, 10);
  expect(p.code).toBe(2);
  const shown = p.stderr.split("\n").filter((l, i, all) => i < all.length - 1 || l !== "").slice(1);
  expect(shown).toContain("FAIL src/a.test.ts > adds");
  expect(shown.at(-1)).toBe("more 199");
  expect(shown.filter((l) => l !== "...").length).toBeLessThanOrEqual(10);
});

// ---------------------------------------------------------------------------------------------------------------
// #49: the interactive `factory settings`, sections, help, diff, validate, --local, saving through a PR.

const PR_GATE = join(HOOKS, "pr-gate.ts");
const README = join(WIKI, "settings.md"); // the page that holds the generated tables (#242)
const TEMPLATE = join(KIT, ".claude", "factory.json");

function withEnv(d: string, extra: Env = {}): Env {
  const env = personEnv();
  env.FACTORY_CONFIG_DIR = join(d, "machine-config");
  delete env.FACTORY_AGENTS;
  delete env.FACTORY_REMOTE_CONTROL;
  return { ...env, ...extra };
}

/** A scripted `factory settings interactive` session: `script` is what the person types, one line each. */
function session(d: string, script: string, env?: Env): Proc {
  return runBun(SETTINGS, ["interactive"], { cwd: d, input: script, env: env ?? withEnv(d) });
}

interface Row { key: string; value: unknown; default: unknown; overridden: boolean; section: string; description: string; scope: string }

test("list can be limited to a section and gives json", () => {
  const d = project({ maxOpenPRs: 4 });
  const p = settings(d, ["list", "--section", "commands"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("commands.typecheck");
  expect(p.stdout).not.toContain("maxOpenPRs");
  const rows = JSON.parse(settings(d, ["list", "--json"]).stdout) as Row[];
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  const row = by.maxOpenPRs as Row;
  expect(row.value).toBe(4);
  expect(row.default).toBe(3);
  expect(row.overridden).toBe(true);
  expect(row.section).toBeTruthy();
  expect(row.description).toBeTruthy();
  expect(row.scope).toBe("project");
  expect((by["tasks.source"] as Row).overridden).toBe(false);
  expect((by["tasks.source"] as Row).value).toBe("plan");
  const bad = settings(d, ["list", "--section", "nope"]);
  expect(bad.code).not.toBe(0);
  expect(bad.stderr).toContain("commands");
});

test("list says which settings are overridden and what the default is", () => {
  const d = project({ maxOpenPRs: 4 });
  const line = settings(d, ["list"]).stdout.split("\n").find((l) => l.startsWith("maxOpenPRs")) as string;
  expect(line).toContain("4");
  expect(line).toContain("(default 3, overridden)");
});

test("every default and every template key is a known setting", () => {
  function* leaves(node: Record<string, unknown>, prefix = ""): Generator<string> {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("_")) continue;
      const path = prefix + k;
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length && !isFreeForm(path)) {
        yield* leaves(v as Record<string, unknown>, path + ".");
      } else yield path;
    }
  }
  const missing = [...leaves(DEFAULTS as unknown as Record<string, unknown>), ...leaves(readJson(TEMPLATE))]
    .filter((k) => !isKnownPath(k));
  expect(missing).toEqual([]);
  for (const [key, s] of Object.entries(table)) {
    expect(Boolean(s.short && s.section && ["str", "int", "bool", "list", "dict", "enum"].includes(s.kind)), key).toBe(true);
  }
});

test("the help says the owner merges a change under claude never the dev manager", () => {
  // #247 (owner's decision): a change under .claude/ is merged by the owner.
  const d = project({});
  for (const key of ["tasks.source", "protected"]) {
    const out = settings(d, ["help", key]).stdout;
    expect(out, key).toContain("owner merges");
    expect(out, key).not.toContain("dev manager");
  }
});

test("help without a key lists the sections and with a key gives the long help", () => {
  const d = project({});
  let p = settings(d, ["help"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("Paths & docs");
  expect(p.stdout).toContain("Machine");
  p = settings(d, ["help", "testPaths"]);
  expect(p.code).toBe(0);
  for (const part of ["testPaths", "Read by", "Example", "tests-reviewed", "Default"]) expect(p.stdout).toContain(part);
  p = settings(d, ["help", "maxOpenPRs"]);
  expect(p.stdout.includes("pr-gate") || p.stdout.includes("PR gate")).toBe(true);
});

test("the help names the bun scripts not python ones", () => {
  const d = project({});
  for (const key of ["maxOpenPRs", "agents", "usageLog", "remoteControl", "structure.roots", "styles"]) {
    const out = settings(d, ["help", key]).stdout;
    expect(out, key).not.toMatch(/\.py\b|python3/);
  }
});

test("diff shows what differs from the defaults", () => {
  const d = project({ _about: "x", maxOpenPRs: 4, mainBranch: "main", custom: 1 });
  const p = settings(d, ["diff"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("maxOpenPRs");
  expect(p.stdout).toContain("default 3");
  expect(p.stdout).not.toContain("mainBranch"); // same as the default
  expect(p.stdout).toContain("custom");
  expect(settings(project({}), ["diff"]).stdout.toLowerCase()).toContain("no differences");
});

test("validate fails with clear messages", () => {
  const d = project({ testPaths: ["(unclosed"], tasks: { source: "plans" }, agents: ["ada", "ada"], maxOpenPRs: 0 });
  let p = settings(d, ["validate"]);
  expect(p.code).toBe(1);
  const out = p.stderr + p.stdout;
  for (const part of ["testPaths", "regex", "tasks.source", "plan, issues", "agents", "ada", "twice", "maxOpenPRs", "1"]) {
    expect(out).toContain(part);
  }
  const ok = project({ maxOpenPRs: 4, tasks: { source: "issues" }, testPaths: ["^t/"] });
  p = settings(ok, ["validate"]);
  expect(p.code).toBe(0);
  expect(p.stdout.toLowerCase()).toContain("ok");
});

test("validate warns about unknown keys and missing paths and port collisions", () => {
  let d = project({ maxOpenPR: 3, tasks: { sourse: "plan" }, prd: "docs/NOPE.md" });
  let p = settings(d, ["validate"]);
  expect(p.code).toBe(1);
  expect(p.out).toContain("docs/NOPE.md");
  expect(p.out).toContain("maxOpenPR");
  expect(p.out).toContain("tasks.sourse");
  d = project({ agents: ["ada", "grace"], portStep: 5, agentEnv: { API: "{port:4100}", WEB: "{port:4105}" } });
  p = settings(d, ["validate"]);
  expect(p.code).toBe(1);
  expect(p.out).toContain("4105");
  d = project({ agents: ["ada", "grace"], portStep: 10, agentEnv: { API: "{port:4100}", WEB: "{port:4105}" } });
  expect(settings(d, ["validate"]).code).toBe(0);
  // an unknown key alone is only a warning
  d = project({ typo: 1 });
  p = settings(d, ["validate"]);
  expect(p.code).toBe(0);
  expect(p.out).toContain("typo");
});

test("validate reports a broken file", () => {
  const d = project();
  write(join(d, ".claude", "factory.json"), "{nope");
  const p = settings(d, ["validate"]);
  expect(p.code).toBe(1);
  expect(p.out).toContain("valid JSON");
});

test("set checks minimums and regexes", () => {
  const d = project({ maxOpenPRs: 4 });
  for (const [key, bad] of [["maxOpenPRs", "0"], ["portStep", "0"], ["reReviewPercent", "101"], ["testPaths", '["(x"]'],
    ["protected", "[1]"], ["agents", '["ada","ada"]'], ["agentEnv", '{"A": 1}']] as const) {
    expect(settings(d, ["set", key, bad]).code, `${key} ${bad}`).not.toBe(0);
  }
  expect(settings(d, ["set", "waitMinutes", "0"]).code).toBe(0); // 0 means exit, so it is allowed
  expect(saved(d)).toEqual({ maxOpenPRs: 4, waitMinutes: 0 });
});

test("a save keeps about key order indent and a trailing newline", () => {
  const d = project();
  const path = join(d, ".claude", "factory.json");
  write(path, '{\n    "_about": "keep",\n    "zeta": 1,\n    "maxOpenPRs": 4,\n    "tasks": {\n        "source": "issues"\n    }\n}\n');
  expect(settings(d, ["set", "prSizeWarn", "700"]).code).toBe(0);
  const text = read(path);
  expect(text.endsWith("}\n") && !text.endsWith("\n\n")).toBe(true);
  expect(text).toContain('\n    "_about": "keep"'); // the file's own 4-space indent
  expect(Object.keys(JSON.parse(text))).toEqual(["_about", "zeta", "maxOpenPRs", "tasks", "prSizeWarn"]);
  expect(settings(d, ["unset", "tasks.source"]).code).toBe(0);
  expect("tasks" in saved(d)).toBe(false); // an emptied group goes
  expect(readdirSync(join(d, ".claude")).filter((f) => f !== "factory.json")).toEqual([]); // no temp file left
});

function machineFiles(env: Env): string[] {
  const dir = env.FACTORY_CONFIG_DIR as string;
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
}

test("the machine scope has its own file outside the project", () => {
  const d = project({ agents: ["ada", "grace", "haile"] });
  const env = withEnv(d);
  expect(settings(d, ["--local", "set", "agents", "grace,haile"], env).code).toBe(0);
  expect(settings(d, ["--local", "set", "remoteControl", "off"], env).code).toBe(0);
  expect(settings(d, ["--local", "set", "autostart", "true"], env).code).toBe(0);
  const machine = machineFiles(env);
  expect(machine.length).toBe(1);
  expect(readJson<Record<string, unknown>>(machine[0] as string)).toEqual({ agents: ["grace", "haile"], remoteControl: false, autostart: true });
  expect(saved(d)).toEqual({ agents: ["ada", "grace", "haile"] }); // the project file is untouched
  expect(settings(d, ["--local", "get", "agents"], env).stdout.trim()).toBe('["grace", "haile"]');
  const rows = Object.fromEntries((JSON.parse(settings(d, ["--local", "list", "--json"], env).stdout) as Row[]).map((r) => [r.key, r]));
  expect((rows.remoteControl as Row).value).toBe(false);
  expect((rows.remoteControl as Row).scope).toBe("machine");
  expect((rows.remoteControl as Row).overridden).toBe(true);
  expect((rows.autostartReport as Row).overridden).toBe(false);
  expect("maxOpenPRs" in rows).toBe(false);
  for (const [key, bad] of [["agents", "nobody"], ["agents", "../x"], ["remoteControl", "maybe"]] as const) {
    expect(settings(d, ["--local", "set", key, bad], env).code, `${key} ${bad}`).not.toBe(0);
  }
  expect(settings(d, ["--local", "unset", "remoteControl"], env).code).toBe(0);
  expect("remoteControl" in readJson(machine[0] as string)).toBe(false);
  // a project-only key isn't a machine setting, and the other way round
  expect(settings(d, ["--local", "set", "maxOpenPRs", "5"], env).code).not.toBe(0);
  expect(settings(d, ["set", "autostart", "true"], env).code).not.toBe(0);
  // the shell side reads the default from here
  let p = runHook("factory_machine", ["remote"], { cwd: d, env });
  expect(p.stdout.trim()).toBe("1");
  settings(d, ["--local", "set", "remoteControl", "off"], env);
  p = runHook("factory_machine", ["remote"], { cwd: d, env });
  expect(p.stdout.trim()).toBe("0");
  p = runHook("factory_machine", ["remote"], { cwd: d, env: { ...env, FACTORY_REMOTE_CONTROL: "1" } });
  expect(p.stdout.trim()).toBe("1"); // the environment variable still wins
});

test("an agent session cannot change the machine scope or save or open a pr", () => {
  const d = project({ agents: ["ada"] });
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    const env = withEnv(d, { [name]: "1" });
    expect(settings(d, ["--local", "set", "agents", "ada"], env).code).not.toBe(0);
    expect(settings(d, ["pr"], env).code).not.toBe(0);
    const p = session(d, "/maxOpenPRs\n1\nc\n9\ns\nw\nq\n", env);
    expect(saved(d), `${name} ${p.stdout}`).toEqual({ agents: ["ada"] });
    expect(p.out).toContain("only a person");
  }
});

test("the pr gate blocks settings changes but not reading", () => {
  const gate = (command: string): Proc =>
    runBun(PR_GATE, [], { input: JSON.stringify({ tool_input: { command } }), env: personEnv() });
  for (const command of ["factory settings set maxOpenPRs 9", "./factory settings unset maxOpenPRs",
    "factory settings --local set agents ada", "factory settings pr", "factory settings interactive",
    "factory settings -i", "cd x && factory settings set a b", "bash -c 'factory settings set a b'",
    "python3 software-factory/hooks/factory_settings.py set a b",
    "bun --no-env-file .claude/hooks/factory_settings.ts set a b",
    "FOO=1 factory settings docs --write", "factory settings --local unset autostart"]) {
    const p = gate(command);
    expect(p.code, command).toBe(2);
    expect(p.stderr, command).toContain("settings");
  }
  for (const command of ["factory settings", "factory settings list --json", "factory settings get maxOpenPRs",
    "./factory settings help tasks.source", "factory settings diff", "factory settings validate",
    "factory settings --local list", "factory settings docs --check", "echo factory settings is fine"]) {
    expect(gate(command).code, command).toBe(0);
  }
});

test("the deny rules cover every way of changing settings", () => {
  const rules = readJson<{ permissions: { deny: string[] } }>(join(KIT, ".claude", "settings.json")).permissions.deny;
  for (const rule of ["Bash(factory settings pr*)", "Bash(factory settings interactive*)", "Bash(factory settings --local*)",
    "Bash(./factory settings pr*)", "Bash(./factory settings --local*)", "Bash(factory settings -i*)",
    "Bash(./factory settings interactive*)", "Bash(./factory settings -i*)"]) {
    expect(rules).toContain(rule);
  }
});

test("a scripted session changes a setting and saves only after the diff and a yes", () => {
  const d = project({ _about: "keep", maxOpenPRs: 4, custom: 1 });
  const p = session(d, "/maxOpenPRs\n1\nc\n6\ns\nw\nq\n");
  expect(p.code).toBe(0);
  for (const part of ["Paths & docs", "Commands", "Machine"]) expect(p.stdout).toContain(part); // the menu
  expect(p.stdout).toContain('-  "maxOpenPRs": 4'); // the unified diff
  expect(p.stdout).toContain('+  "maxOpenPRs": 6');
  expect(saved(d)).toEqual({ _about: "keep", maxOpenPRs: 6, custom: 1 });
  expect(Object.keys(saved(d))).toEqual(["_about", "maxOpenPRs", "custom"]);
});

test("a session that quits or declines writes nothing", () => {
  const d = project({ maxOpenPRs: 4 });
  session(d, "/maxOpenPRs\n1\nc\n6\nq\nq\n"); // quit with unsaved changes: asked, answered with q again -> leaves
  expect(saved(d)).toEqual({ maxOpenPRs: 4 });
  session(d, "/maxOpenPRs\n1\nc\n6\ns\nc\nq\ny\n"); // cancel at the save question
  expect(saved(d)).toEqual({ maxOpenPRs: 4 });
  session(d, "/maxOpenPRs\n1\nc\n6\n"); // the input just ends
  expect(saved(d)).toEqual({ maxOpenPRs: 4 });
  const p = session(d, "q\n");
  expect(p.code).toBe(0);
  expect(saved(d)).toEqual({ maxOpenPRs: 4 });
});

test("a session validates resets helps and searches", () => {
  const d = project({ maxOpenPRs: 4, tasks: { source: "issues" } });
  let p = session(d, "/maxOpenPRs\n1\nc\nfour\n0\n\nr\ns\nw\nq\n"); // bad, bad, blank cancels; then reset
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("whole number");
  expect(p.stdout).toContain("at least 1");
  expect(saved(d)).toEqual({ tasks: { source: "issues" } }); // reset removed the key
  p = session(d, "/maxOpenPRs\n1\n?\nb\nq\n");
  expect(p.stdout).toContain("Read by");
  expect(p.stdout).toContain("Example");
  p = session(d, "/ready PRs\nq\n"); // search finds it by description
  expect(p.stdout).toContain("maxOpenPRs");
  p = session(d, "/zzzzqqq\nq\n");
  expect(p.stdout).toContain("No setting matches");
  p = session(d, "99\nx\nq\n"); // nonsense is answered, never a crash
  expect(p.code).toBe(0);
  expect(p.stderr).toBe(""); // no stack trace
});

test("a session edits lists item by item and tests regexes", () => {
  const d = project({ testPaths: ["^t/", "\\.spec\\."] });
  const script = [
    "/testPaths", "1", "c", // change opens the list editor
    "a", "(bad", // add an invalid regex: refused
    "a", "^spec/", // add a good one
    "e", "1", "^tests/", // edit item 1
    "r", "2", // remove item 2
    "t", "tests/a.py spec/b.py src/c.py", "", // test paths against the patterns
    "b", // back to the setting
    "s", "w", "q"].join("\n");
  const p = session(d, script + "\n");
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("isn't a valid regex");
  for (const part of ["tests/a.py", "matches", "src/c.py", "no match"]) expect(p.stdout).toContain(part);
  expect(saved(d).testPaths).toEqual(["^tests/", "^spec/"]);
});

test("a session edits dicts and the machine section", () => {
  const d = project({ agents: ["ada", "grace"], agentEnv: { A: "{port:4100}" } });
  const env = withEnv(d);
  let p = session(d, "/agentEnv\n1\nc\na\nB\n{port:4101}\nr\nA\nb\ns\nw\nq\n", env);
  expect(saved(d).agentEnv, p.stdout).toEqual({ B: "{port:4101}" });
  p = session(d, '10\n1\nc\nw\n["ada"]\nb\nq\nq\n', env); // the machine section, then leave it unsaved
  expect(p.stdout).toContain("Machine (local)");
  session(d, '10\n1\nc\nw\n["ada"]\nb\ns\nw\nq\n', env);
  expect(readJson(machineFiles(env)[0] as string).agents).toEqual(["ada"]);
  expect(saved(d).agents).toEqual(["ada", "grace"]);
});

const FAKE_GH_PR = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.GH_LOG as string, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "pr" && process.argv[3] === "create") console.log("https://github.com/o/r/pull/7");
`;

function gitProject(cfg: unknown, files: Record<string, string> = {}): [string, string, Env] {
  const d = project(cfg);
  for (const [rel, text] of Object.entries(files)) write(join(d, rel), text);
  const run = (...a: string[]): void => {
    const p = sh(a, { cwd: d });
    if (p.code !== 0) throw new Error(`${a.join(" ")}: ${p.out}`);
  };
  run("git", "checkout", "-q", "-b", "main");
  run("git", "add", "-A");
  run("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const remote = tmp();
  sh(["git", "init", "-q", "--bare", remote]);
  run("git", "remote", "add", "origin", remote);
  run("git", "push", "-q", "origin", "main");
  const bindir = join(dirname(d), "bin-" + basename(d));
  writeExe(join(bindir, "gh"), FAKE_GH_PR);
  const env = withEnv(d, { GH_LOG: join(dirname(d), "gh-" + basename(d) + ".log"), PATH: `${bindir}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  return [d, remote, env];
}

function remoteBranches(d: string): string[] {
  return sh(["git", "branch", "-r", "--list", "origin/settings/*"], { cwd: d }).stdout.split(/\s+/).filter(Boolean);
}

function shown(remote: string, ref: string, path: string): string {
  return sh(["git", "--git-dir", remote, "show", `${ref}:${path}`]).stdout;
}

test("saving can open a pull request with the changes and the reviews they need", () => {
  const [d, remote, env] = gitProject({ maxOpenPRs: 4, testPaths: ["^t/"] });
  const p = session(d, '/maxOpenPRs\n1\nc\n5\n/testPaths\n1\nc\nw\n["^t/", "^e2e/"]\nb\ns\nb\nd\nq\n', env);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("https://github.com/o/r/pull/7");
  const branches = remoteBranches(d);
  expect(branches.length).toBe(1);
  expect((branches[0] as string).startsWith("origin/settings/")).toBe(true);
  const pushed = shown(remote, (branches[0] as string).split("origin/")[1] as string, ".claude/factory.json");
  expect(JSON.parse(pushed)).toEqual({ maxOpenPRs: 5, testPaths: ["^t/", "^e2e/"] });
  expect(JSON.parse(shown(remote, "main", ".claude/factory.json"))).toEqual({ maxOpenPRs: 4, testPaths: ["^t/"] }); // main is untouched
  const log = read(env.GH_LOG as string);
  for (const part of ["pr create", "--draft", "--base main"]) expect(log).toContain(part);
  expect(log).toContain("maxOpenPRs"); // the body lists each change and the review it needs
  expect(log).toContain("tests-reviewed");
  // the person's own branch carries the change; the tree is clean after the commit
  expect(sh(["git", "status", "--porcelain"], { cwd: d }).stdout.trim()).toBe("");
});

test("the pr command proposes an edited file and refuses off the main branch", () => {
  const [d, , env] = gitProject({ maxOpenPRs: 4 });
  expect(settings(d, ["set", "maxOpenPRs", "5"], env).code).toBe(0);
  sh(["git", "checkout", "-q", "-b", "other"], { cwd: d });
  let p = settings(d, ["pr"], env);
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("main");
  sh(["git", "checkout", "-q", "main"], { cwd: d });
  p = settings(d, ["pr", "--ready"], env);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("pull/7");
  expect(read(env.GH_LOG as string)).not.toContain("--draft");
  p = settings(d, ["pr"], env); // nothing left to propose
  expect(p.code).not.toBe(0);
  expect(p.out.toLowerCase()).toContain("nothing");
});

test("the pr body and output say the owner merges it", () => {
  // #247: a change under .claude/ is the owner's merge, never the dev manager's.
  const [d, , env] = gitProject({ maxOpenPRs: 4 });
  settings(d, ["set", "maxOpenPRs", "5"], env);
  const p = settings(d, ["pr"], env);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("The owner merges it");
  const log = read(env.GH_LOG as string);
  expect(log).toContain("merged by the owner, never by an agent");
  expect(log).toContain("a pull request that the owner merges");
  expect(log).not.toContain("dev manager or the owner");
  expect(log).not.toContain("dev manager (or the owner)");
});

// #251: one owner merge is enough for a new allow rule.

const RELEASE_SETTINGS = JSON.stringify({ hooks: {}, permissions: { allow: ["Bash(git add*)", "Bash(git commit*)"], deny: ["Bash(rm -rf*)"] } }, null, 2) + "\n";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("set permissions allow says the rule applies once the settings pr is merged", () => {
  const d = project({});
  const p = settings(d, ["set", "permissions.allow", '["Bash(make test*)"]']);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain(".claude/settings.json");
  expect(p.stdout).toContain("factory settings pr");
  expect(p.stdout).toContain("once the owner merges it");
  const help = settings(d, ["help", "permissions.allow"]).stdout;
  expect(help).toContain("applies once");
  expect(help).toContain("merged");
  expect(help).toContain("factory settings pr");
});

test("a settings pr for permissions allow also writes the merged rules into settings json in the same commit", () => {
  const pin = { schema: "factory-pin/1", tag: "v0.1.0", files: { ".claude/settings.json": sha256(RELEASE_SETTINGS) } };
  const [d, remote, env] = gitProject({ maxOpenPRs: 4 }, {
    ".claude/settings.json": RELEASE_SETTINGS,
    ".claude/factory/release.json": JSON.stringify(pin, null, 2) + "\n",
  });
  expect(settings(d, ["set", "permissions.allow", '["Bash(make test*)", "Bash(git add*)", "Bash(make test*)"]'], env).code).toBe(0);
  const p = settings(d, ["pr"], env);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("settings.json");
  const branch = (remoteBranches(d)[0] as string).split("origin/")[1] as string;
  const merged = JSON.parse(shown(remote, branch, ".claude/settings.json")) as { permissions: { allow: string[]; deny: string[] } };
  // the release's own rules first, then the project's, each once, in order
  expect(merged.permissions.allow).toEqual(["Bash(git add*)", "Bash(git commit*)", "Bash(make test*)"]);
  expect(merged.permissions.deny).toEqual(["Bash(rm -rf*)"]);
  expect(JSON.parse(shown(remote, branch, ".claude/factory.json")).permissions).toEqual({ allow: ["Bash(make test*)", "Bash(git add*)", "Bash(make test*)"] });
  // one commit carries both files, and the pin's hash follows the merged settings.json, so it is not drift
  const files = sh(["git", "--git-dir", remote, "show", "--name-only", "--format=", branch]).stdout.split("\n").filter(Boolean).sort();
  expect(files).toEqual([".claude/factory.json", ".claude/factory/release.json", ".claude/settings.json"]);
  const newPin = JSON.parse(shown(remote, branch, ".claude/factory/release.json")) as { files: Record<string, string> };
  expect(newPin.files[".claude/settings.json"]).toBe(sha256(shown(remote, branch, ".claude/settings.json")));
  expect(read(env.GH_LOG as string)).toContain("apply once this pull request is merged");
  // main is untouched, and the person is back on it with a clean tree
  expect(shown(remote, "main", ".claude/settings.json")).toBe(RELEASE_SETTINGS);
  expect(sh(["git", "status", "--porcelain"], { cwd: d }).stdout.trim()).toBe("");
  expect(read(join(d, ".claude", "settings.json"))).toBe(RELEASE_SETTINGS);
});

test("a settings pr that does not touch permissions leaves settings json alone", () => {
  const [d, remote, env] = gitProject({ maxOpenPRs: 4, permissions: { allow: ["Bash(make test*)"] } },
    { ".claude/settings.json": RELEASE_SETTINGS });
  settings(d, ["set", "maxOpenPRs", "5"], env);
  expect(settings(d, ["pr"], env).code).toBe(0);
  const branch = (remoteBranches(d)[0] as string).split("origin/")[1] as string;
  const files = sh(["git", "--git-dir", remote, "show", "--name-only", "--format=", branch]).stdout.split("\n").filter(Boolean);
  expect(files).toEqual([".claude/factory.json"]);
});

test("the readme settings table is generated from the metadata", () => {
  let p = runBun(SETTINGS, ["docs", "--check", "--file", README], { env: personEnv() });
  expect(p.code, p.out).toBe(0);
  const text = read(README);
  expect(text).toContain("<!-- settings:begin -->");
  expect(text).toContain("<!-- settings:end -->");
  const stale = text.replace("Ready PRs the account may have open at once", "x");
  const file = join(tmp(), "README.md");
  write(file, stale);
  p = runBun(SETTINGS, ["docs", "--check", "--file", file], { env: personEnv() });
  expect(p.code).toBe(1);
  expect(p.out).toContain("docs --write");
  p = runBun(SETTINGS, ["docs", "--write", "--file", file], { env: personEnv() });
  expect(p.code).toBe(0);
  expect(read(file)).toContain("Ready PRs");
});

test("factory help lists the settings commands", () => {
  const text = readFileSync(join(SF, "factory"), "utf8");
  for (const part of ["settings help", "settings validate", "settings diff", "settings --local", "settings interactive"]) {
    expect(text).toContain(part);
  }
  expect(existsSync(join(HOOKS, "factory_settings.py"))).toBe(false);
});

test("the docs agree the owner merges a change under claude", () => {
  // #247: the settings help, the manage-pass skill, DEV-MANAGER.md and CODEOWNERS say the same.
  const skill = read(join(KIT, ".claude", "skills", "manage-pass", "SKILL.md"));
  expect(skill).toContain("Never merge a pull request that changes the project's `.claude/`");
  expect(read(join(SF, "DEV-MANAGER.md"))).toContain("which only the owner merges (#247)");
  expect(read(join(SF, "kit", ".github", "CODEOWNERS"))).toMatch(/^\/\.claude\/\s+@<owner>$/m);
  const docs = read(join(SF, "README.md")) + read(join(WIKI, "settings.md")) + read(join(WIKI, "updating.md")) + read(join(WIKI, "submodule.md"));
  expect(docs).not.toMatch(/dev manager (or the owner|or owner|or the owner) merges/);
  expect(read(join(WIKI, "updating.md"))).toContain("factory settings pr");
});
