// tools/check_skills.ts fails when a compiled .pyc file is tracked by git (#158), and passes when it is not; and it
// fails on a .ts file that does not parse.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUN, git, sh, tmp, TOOLS } from "./support.ts";

/** A repo with one valid skill, and optionally a committed .pyc under it. */
function repo(trackedPyc: boolean): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  mkdirSync(join(d, "tools"));
  copyFileSync(join(TOOLS, "check_skills.ts"), join(d, "tools", "check_skills.ts"));
  mkdirSync(join(d, "demo", "__pycache__"), { recursive: true });
  writeFileSync(join(d, "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo.\n---\n");
  if (trackedPyc) writeFileSync(join(d, "demo", "__pycache__", "x.cpython-313.pyc"), "\0");
  git(d, "add", "-f", "-A");
  git(d, "commit", "-qm", "start");
  return d;
}

const run = (d: string) => sh([...BUN, join(d, "tools", "check_skills.ts")], { cwd: d });

test("tracked pyc fails", () => {
  const r = run(repo(true));
  expect(r.code, r.out).toBe(1);
  expect(r.stdout).toContain("x.cpython-313.pyc");
  expect(r.stdout).toContain("git rm --cached");
});

test("untracked pyc passes", () => {
  const d = repo(false);
  writeFileSync(join(d, "demo", "__pycache__", "y.pyc"), "\0"); // on disk, not tracked
  const r = run(d);
  expect(r.code, r.out).toBe(0);
});

test("a .ts file that does not parse fails, and a good one passes", () => {
  const d = repo(false);
  writeFileSync(join(d, "demo", "good.ts"), "export const x: number = 1;\n");
  expect(run(d).code).toBe(0);
  writeFileSync(join(d, "demo", "bad.ts"), "export const = ;\n");
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  expect(r.stdout).toContain("demo/bad.ts");
});

test("only the cockpit's UI folder may import Ink or React (decision 0002)", () => {
  const d = repo(false);
  mkdirSync(join(d, "software-factory", "cockpit"), { recursive: true });
  mkdirSync(join(d, "software-factory", "hooks"), { recursive: true });
  writeFileSync(join(d, "software-factory", "SKILL.md"), "---\nname: software-factory\ndescription: The factory.\n---\n");
  writeFileSync(join(d, "software-factory", "cockpit", "app.tsx"),
    'import { Text } from "ink";\nimport { useState } from "react";\nimport { render } from "ink-testing-library";\n' +
    "export const App = () => <Text>{String(useState(1)[0])}</Text>;\nexport { render };\n");
  writeFileSync(join(d, "software-factory", "hooks", "fine.ts"), 'const s = "import { render } from \\"ink\\"";\nexport { s };\n');
  expect(run(d).code, run(d).out).toBe(0);
  const outside: [string, string][] = [
    [join("software-factory", "hooks", "a.ts"), 'import { render } from "ink";\nexport { render };\n'],
    [join("software-factory", "tests", "b.test.tsx"), 'import { jsx } from "react/jsx-runtime";\nexport { jsx };\n'],
    [join("tools", "c.ts"), 'export const load = () => import("ink-testing-library");\n'],
    [join("demo", "d.ts"), 'const r = require("react");\nexport { r };\n'],
  ];
  mkdirSync(join(d, "software-factory", "tests"), { recursive: true });
  for (const [path, body] of outside) writeFileSync(join(d, path), body);
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  for (const [path, body] of outside) {
    const pkg = /["'](ink[\w-]*|react[\w/-]*)["']/.exec(body)?.[1] as string;
    expect(r.stdout).toContain(`${path}: imports ${pkg}; only the cockpit's UI (software-factory/cockpit/) may import Ink or React`);
  }
  expect(r.stdout).not.toContain("cockpit/app.tsx");
  expect(r.stdout).not.toContain("hooks/fine.ts");
});

test("a .tsx file that does not parse fails", () => {
  const d = repo(false);
  writeFileSync(join(d, "demo", "bad.tsx"), "export const A = () => <Box>;\n");
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  expect(r.stdout).toContain("demo/bad.tsx: does not parse");
});

test("a Python file in the factory fails, and one in another skill is that skill's own business", () => {
  const d = repo(false);
  mkdirSync(join(d, "software-factory"), { recursive: true });
  writeFileSync(join(d, "software-factory", "SKILL.md"), "---\nname: software-factory\ndescription: The factory.\n---\n");
  expect(run(d).code).toBe(0);
  writeFileSync(join(d, "demo", "helper.py"), "print(1)\n");
  expect(run(d).code, run(d).out).toBe(0);
  writeFileSync(join(d, "software-factory", "x.py"), "print(1)\n");
  const r = run(d);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("software-factory/x.py: a Python file");
  expect(r.stdout).not.toContain("demo/helper.py");
});
