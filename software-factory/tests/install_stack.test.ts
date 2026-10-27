// install.sh finds the project's stack on a first install (#199, install side): a project with no package.json and
// Python files gets a Python CI workflow and matching `commands.*`; Node keeps the pnpm template; an unknown stack keeps
// it too and the output names the file to edit. An existing workflow is never overwritten, and a re-run changes nothing.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classify } from "../hooks/factory_release.ts";
import { runHook, SF, sh, tmp } from "./support.ts";

const WORKFLOW = join(".github", "workflows", "ci.yml");

function project(files: Record<string, string>): string {
  const d = tmp();
  sh(["git", "init", "-q"], { cwd: d });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  return d;
}

function install(d: string): string {
  const p = sh(["bash", join(SF, "install.sh"), d], { cwd: d });
  expect(p.code, p.out).toBe(0);
  return p.stdout + p.stderr;
}

const read = (d: string, rel: string): string => readFileSync(join(d, rel), "utf8");
const factoryJson = (d: string): Record<string, unknown> => JSON.parse(read(d, ".claude/factory.json")) as Record<string, unknown>;
const commands = (d: string): Record<string, string> => factoryJson(d).commands as Record<string, string>;

const UNITTEST = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n";
const PLAIN = "def test_a():\n    assert True\n";

test("a python project with unittest tests gets the python workflow and a test command", () => {
  const d = project({ "src/textkit.py": "x = 1\n", "tests/test_textkit.py": UNITTEST });
  const out = install(d);
  const wf = read(d, WORKFLOW);
  expect(!wf.includes("pnpm") && wf.includes("setup-python") && wf.includes("commands") && wf.includes("Factory guard"), wf).toBe(true);
  const c = commands(d);
  expect(c.test).toBe("python3 -m unittest discover -s tests");
  expect(Boolean(c.install || c.typecheck || c.lint || c.build), JSON.stringify(c)).toBe(false);
  expect(out.includes("Python") && out.includes("ci.yml"), out).toBe(true);
  expect(existsSync(join(d, ".github/workflows/ci-python.yml.template")), "the template itself is not installed").toBe(false);
});

test("the test command runs at least one test when tests has no init file", () => {
  // Python 3.11+: `unittest discover` from the top does not enter a folder without __init__.py (#244)
  for (const files of [{ "tests/test_textkit.py": UNITTEST }, { "tests/unit/test_textkit.py": UNITTEST } as Record<string, string>,
    { "tests/test_a.py": UNITTEST, "tests/sub/test_b.py": UNITTEST }]) {
    const d = project({ "src/textkit.py": "x = 1\n", ...files });
    install(d);
    const p = sh(["/bin/sh", "-c", commands(d).test as string], { cwd: d });
    expect(p.code === 0 && !p.stderr.includes("NO TESTS RAN") && !p.stderr.includes("Ran 0 tests"), JSON.stringify(files) + p.out).toBe(true);
  }
});

test("the test command names the folder the tests are in", () => {
  let d = project({ "tests/unit/test_textkit.py": UNITTEST });
  install(d);
  expect(commands(d).test).toBe("python3 -m unittest discover -s tests/unit");
  d = project({ "tests/test_a.py": UNITTEST, "tests/sub/test_b.py": UNITTEST });
  install(d);
  expect(commands(d).test).toBe("python3 -m unittest discover -s tests");
});

// #249: the install sets commands.test, so it also lets an unattended agent run it (directly, or through
// ./factory run-check) without a prompt: the rules go to permissions.allow in factory.json, and into a copied
// .claude/factory/settings.json, the agents' rules.
test("the install allows the detected test command and run check for unattended agents", () => {
  const d = project({ "src/textkit.py": "x = 1\n", "tests/test_textkit.py": UNITTEST });
  const out = install(d);
  const want = ["Bash(python3 -m unittest*)", "Bash(./factory run-check*)"];
  expect((factoryJson(d).permissions as Record<string, unknown>).allow).toEqual(want);
  const allow = ((JSON.parse(read(d, ".claude/factory/settings.json")) as Record<string, Record<string, unknown>>).permissions as Record<string, unknown>).allow as string[];
  for (const rule of want) expect(allow).toContain(rule);
  expect(allow.length).toBe(new Set(allow).size);
  expect(out).toContain("Bash(python3 -m unittest*)");
  // the rule matches the command the agent runs, alone and with arguments
  const matches = (cmd: string): boolean => allow.some((r) => {
    const m = /^Bash\((.*)\)$/.exec(r);
    return Boolean(m) && new RegExp("^" + (m?.[1] as string).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(cmd);
  });
  expect(matches(commands(d).test as string)).toBe(true);
  expect(matches(`./factory run-check ${commands(d).test}`)).toBe(true);
});

test("no test command means no allow rule is added", () => {
  const cases: Record<string, string>[] = [{ "tests/test_textkit.py": PLAIN, "pyproject.toml": "[project]\nname='x'\n" },
    { "package.json": "{}\n" }, { "main.c": "int main(){return 0;}\n" }];
  for (const files of cases) {
    const d = project(files);
    install(d);
    expect(factoryJson(d).permissions, JSON.stringify(files)).toBeUndefined();
  }
});

test("python tests that are not unittest leave the test command empty and say so", () => {
  const d = project({ "tests/test_textkit.py": PLAIN, "pyproject.toml": "[project]\nname='x'\n" });
  const out = install(d);
  expect(commands(d).test).toBe("");
  expect(out.includes("commands.test") && out.includes("unittest"), out).toBe(true);
});

test("a requirements file gives an install command", () => {
  const d = project({ "requirements.txt": "requests\n", "tests/test_a.py": UNITTEST });
  install(d);
  expect(commands(d).install).toBe("python3 -m pip install -r requirements.txt");
});

test("a node project keeps the pnpm template and commands", () => {
  const d = project({ "package.json": "{}\n" });
  const out = install(d);
  expect(read(d, WORKFLOW)).toContain("pnpm/action-setup");
  expect(commands(d).test).toBe("pnpm -s test");
  expect(out).not.toContain("Python");
});

test("an unknown stack keeps the pnpm template and names the file to edit", () => {
  const d = project({ "main.c": "int main(){return 0;}\n" });
  const out = install(d);
  expect(read(d, WORKFLOW)).toContain("pnpm/action-setup");
  expect(out.includes("could not tell") && out.includes(WORKFLOW) && out.includes(".claude/factory.json"), out).toBe(true);
});

test("an existing workflow is never overwritten", () => {
  const d = project({ "tests/test_a.py": UNITTEST, [WORKFLOW]: "name: mine\n" });
  const out = install(d);
  expect(read(d, WORKFLOW)).toBe("name: mine\n");
  expect(out.includes("kept") && out.includes("ci.yml"), out).toBe(true);
});

test("a second run changes nothing", () => {
  const d = project({ "tests/test_a.py": UNITTEST });
  install(d);
  const before = [read(d, WORKFLOW), read(d, ".claude/factory.json"), read(d, ".claude/factory/settings.json")];
  install(d);
  expect([read(d, WORKFLOW), read(d, ".claude/factory.json"), read(d, ".claude/factory/settings.json")]).toEqual(before);
});

function runCmd(d: string, name: string): ReturnType<typeof sh> {
  return runHook("factory_stack", ["run", name], { cwd: d });
}

test("the workflow runs a command from factory json and an empty one is a warning not a failure", () => {
  const d = project({ ".claude/factory.json": JSON.stringify({ commands: { test: "exit 3", install: "" } }) });
  expect(runCmd(d, "test").code).toBe(3);
  const p = runCmd(d, "install");
  expect(p.code === 0 && p.stdout.includes("commands.install is empty"), p.out).toBe(true);
});

test("the python template is not a workflow a release install would add", () => {
  expect(classify("kit/.github/workflows/ci-python.yml.template")).toBeNull();
  expect(classify("kit/.github/workflows/ci.yml")).toEqual(["template", ".github/workflows/ci.yml"]);
});

test("the python template runs the stack commands with bun", () => {
  const wf = readFileSync(join(SF, "kit", ".github", "workflows", "ci-python.yml.template"), "utf8");
  expect(wf).toContain("bun --no-env-file .claude/hooks/factory_stack.ts run install");
  expect(wf).toContain("bun --no-env-file .claude/hooks/factory_stack.ts run test");
  expect(wf.indexOf("oven-sh/setup-bun", wf.indexOf("check:"))).toBeLessThan(wf.indexOf("factory_stack.ts run install"));
  expect(wf).not.toContain("factory_stack.py");
});
