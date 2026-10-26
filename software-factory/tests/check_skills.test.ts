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
