// A project's bunfig.toml must not change how the factory's own scripts run (#259). Bun reads ./bunfig.toml from the
// folder it starts in, and its `preload` scripts run before the script itself: an agent that writes one could make the
// PR gate (or the CI guard) exit 0 before it looks at anything. Every place the factory starts Bun passes
// `--config=/dev/null`, so the project's bunfig.toml is not read.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { doctor, lines, machine, project } from "./doctor_support.ts";
import { git, gitRepo, HOOKS, KIT, read, ROOT, SF, sh, tmp, write, writeExe } from "./support.ts";

/** A bunfig.toml whose preload ends the process with 0 before the script runs, and leaves a mark that it ran. */
function hostile(d: string): string {
  const mark = join(d, "PRELOADED");
  write(join(d, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  write(join(d, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran"); process.exit(0);\n`);
  return mark;
}

/** A git project with the factory's hooks linked into .claude/hooks. */
function linkedProject(): string {
  const d = gitRepo();
  const hooks = join(d, ".claude", "hooks");
  write(join(hooks, ".keep"), "");
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(hooks, f));
  return d;
}

type Settings = { hooks?: Record<string, { hooks: { command: string }[] }[]> };

function hookCommands(path: string): string[] {
  const s = JSON.parse(read(path)) as Settings;
  return Object.values(s.hooks ?? {}).flat().flatMap((m) => m.hooks.map((h) => h.command));
}

const SETTINGS = [join(KIT, ".claude", "factory", "settings.json"), join(KIT, ".claude", "manager", "settings.json")];

test("the PR gate, started as the agents' settings start it, still refuses with a hostile bunfig.toml in the project", () => {
  const d = linkedProject();
  const mark = hostile(d);
  const gate = hookCommands(SETTINGS[0] as string).find((c) => c.includes("pr-gate.ts")) as string;
  expect(gate).toBeDefined();
  const p = sh(["bash", "-c", gate], {
    cwd: d, env: { ...process.env, CLAUDE_PROJECT_DIR: d },
    input: JSON.stringify({ tool_input: { command: "gh pr merge 12 --admin" } }),
  });
  expect(p.code, p.out).toBe(2);
  expect(existsSync(mark), "the project's preload never ran").toBe(false);
});

test("every hook in the agents' and the manager's settings starts Bun without the project's bunfig.toml", () => {
  for (const path of SETTINGS) {
    const commands = hookCommands(path).filter((c) => c.includes(".claude/hooks/"));
    expect(commands.length, path).toBeGreaterThan(0);
    for (const c of commands) expect(c, path).toMatch(/^env -u BUN_OPTIONS bun --no-env-file --config=\/dev\/null /);
  }
});

/** Every line in the factory's shipped scripts, settings, templates and docs that starts Bun with `--no-env-file`. */
function bunStarts(): [string, string][] {
  const files = git(ROOT, "ls-files", "software-factory", "tools").split("\n")
    .filter((f) => f && !f.startsWith("software-factory/tests/") && !f.endsWith(".lock") && existsSync(join(ROOT, f)));
  const out: [string, string][] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) if (/bun"?,? "?--no-env-file/.test(line) || /\bbun --no-env-file\b/.test(line)) out.push([f, line]);
  }
  return out;
}

test("every place the factory starts Bun turns off the project's bunfig.toml", () => {
  const starts = bunStarts();
  expect(starts.length).toBeGreaterThan(20);
  // a regex literal spells the flag with escaped slashes
  const bad = starts.filter(([, line]) => !line.replaceAll("\\/", "/").includes("--config=/dev/null")).map(([f, line]) => `${f}: ${line.trim()}`);
  expect(bad).toEqual([]);
  const spawned = git(ROOT, "grep", "-n", "process.execPath, \"--no-env-file\"", "--", "software-factory/hooks", "tools")
    .split("\n").filter((l) => l && !l.includes("--config=/dev/null"));
  expect(spawned).toEqual([]);
});

test("factory runs its scripts without the project's bunfig.toml", () => {
  const d = linkedProject();
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik"] }));
  const mark = hostile(d);
  const p = sh(["bash", join(SF, "factory"), "settings"], { cwd: d, timeoutMs: 60_000 });
  expect(existsSync(mark), p.out).toBe(false);
  expect(p.code, p.out).toBe(0);
});

/** The `run:` block of the guard step in a CI template. */
function guardStep(template: string): string {
  const text = read(template);
  const at = text.indexOf("factory_guard.ts");
  expect(at, template).toBeGreaterThan(0);
  const start = text.lastIndexOf("run:", at);
  const block = text.slice(start + 4).split("\n");
  const first = (block[0] as string).trim();
  if (first && first !== "|") return first;
  const body: string[] = [];
  let indent = -1;
  for (const line of block.slice(1)) {
    if (!line.trim()) continue;
    const ind = line.length - line.trimStart().length;
    if (indent < 0) indent = ind;
    if (ind < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const TEMPLATES = [join(KIT, ".github", "workflows", "ci.yml"), join(KIT, ".github", "workflows", "ci-python.yml.template")];

for (const template of TEMPLATES) {
  test(`the CI guard in ${template.split("/").pop()} runs the base branch's guard, without the PR's bunfig.toml`, () => {
    // main has the factory's guard; the pull request deletes a test, adds a hostile bunfig.toml and swaps the guard
    // for one that passes everything. The guard that runs must be main's, and it must fail the PR.
    const d = gitRepo();
    const hooks = join(d, ".claude", "hooks");
    write(join(hooks, ".keep"), "");
    for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(hooks, f));
    write(join(d, ".claude", "factory.json"), "{}\n");
    write(join(d, "tests", "a.test.ts"), 'import { expect, test } from "bun:test";\ntest("a", () => { expect(1).toBe(1); });\n');
    git(d, "add", "-A");
    git(d, "commit", "-qm", "base");
    git(d, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(d, "switch", "-qc", "task/1-x");
    git(d, "rm", "-q", "tests/a.test.ts");
    const mark = hostile(d);
    sh(["rm", join(hooks, "factory_guard.ts")]);
    writeExe(join(hooks, "factory_guard.ts"), "process.exit(0);\n");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "the PR");
    const runner = tmp("runner-");
    const p = sh(["bash", "-e", "-c", guardStep(template)], {
      cwd: d, env: { ...process.env, BASE: "main", BRANCH: "task/1-x", LABELS: "[]", RUNNER_TEMP: runner }, timeoutMs: 60_000,
    });
    expect(existsSync(mark), "the PR's preload never ran: " + p.out).toBe(false);
    expect(p.code, p.out).not.toBe(0);
    expect(p.out).toContain("a.test.ts");
  });
}

test("bunfig.toml is in the default and the kit's protected lists", () => {
  const kit = JSON.parse(read(join(KIT, ".claude", "factory.json"))) as { protected: string[] };
  const defaults = sh([process.execPath, "--no-env-file", "--config=/dev/null", "-e",
    `import { DEFAULTS } from ${JSON.stringify(join(HOOKS, "factory_config.ts"))}; console.log(JSON.stringify(DEFAULTS.protected));`]);
  expect(defaults.code, defaults.out).toBe(0);
  for (const list of [JSON.parse(defaults.stdout) as string[], kit.protected]) {
    for (const path of ["bunfig.toml", "apps/web/bunfig.toml", ".bunfig.toml"]) {
      expect(list.some((re) => new RegExp(re).test(path)), `${path} in ${list.join(" ")}`).toBe(true);
    }
    expect(list.some((re) => new RegExp(re).test("docs/bunfig.md")), "only the file itself").toBe(false);
  }
});

test("factory doctor names a bunfig.toml with a preload and is quiet without one", () => {
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  let d = project({ "bunfig.toml": '[install]\nexact = true\n' });
  let p = doctor(d, env);
  expect(p.stdout.toLowerCase(), p.stdout).not.toContain("bunfig");
  d = project({ "bunfig.toml": 'preload = ["./setup.ts"]\n' });
  p = doctor(d, env);
  const said = [...lines(p, "fix"), ...lines(p, "note")].filter((l) => l.includes("bunfig.toml"));
  expect(said.length, p.stdout).toBe(1);
  expect(said[0]).toContain("preload");
});

test("doctor says to update when a hook line reads the project's bunfig.toml", () => {
  const d = project();
  write(join(d, ".claude", "factory", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bun --no-env-file "$CLAUDE_PROJECT_DIR"/.claude/hooks/pr-gate.ts' }] }] },
  }));
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "fix").some((l) => l.includes("--config=/dev/null") && l.includes("factory update")), p.stdout).toBe(true);
});
