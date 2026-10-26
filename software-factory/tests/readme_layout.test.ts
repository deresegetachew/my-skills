// The README's "Where things live" section matches the folders (#112), so it cannot drift from the move.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KIT, readmeAndWiki, ROOT, SF, sh } from "./support.ts";

const README = readFileSync(join(SF, "README.md"), "utf8");
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function section(): string {
  const m = /^## Where things live\n([\s\S]*?)(?:^## |(?![\s\S]))/m.exec(README);
  expect(m, "the README has no 'Where things live' section").toBeTruthy();
  return (m as RegExpExecArray)[1] as string;
}

test("the section names every top level part of software factory that exists", () => {
  const text = section();
  for (const name of ["factory", "factory-loop.sh", "install.sh", "VERSION", "hooks", "ci", "tests", "docs", "kit"]) {
    expect(existsSync(join(SF, name)), name).toBe(true);
    expect(new RegExp("^  " + esc(name) + "\\b", "m").test(text), `${name} is missing from the tree`).toBe(true);
  }
  // node_modules: the dev-only typescript install for `tsc --noEmit` (#252), never part of the factory or a release
  const top = readdirSync(SF).filter((n) => !n.startsWith(".") && n !== "__pycache__" && n !== "node_modules" && statSync(join(SF, n)).isDirectory());
  for (const folder of top) expect(new RegExp("^  " + esc(folder) + "/", "m").test(text), `the folder ${folder}/ is not described`).toBe(true);
});

test("the section says how a project switches and what is left", () => {
  const text = section();
  expect(text).toContain("factory update --layout new");
  expect(text.includes("ls -l .claude/hooks") && text.includes("factory doctor")).toBe(true);
  for (const left of ["first release", "Remanual", "forwarders"]) expect(text).toContain(left);
});

test("the switch command the section gives is one the factory command and installer accept", () => {
  const help = sh(["bash", join(SF, "factory"), "help"]).stdout;
  expect(help).toContain("update [--layout new]");
  expect(readFileSync(join(SF, "install.sh"), "utf8")).toContain("--layout new|old|auto");
});

test("the files in the kit tree lists the hooks and ci folders beside kit not inside it", () => {
  const m = /software-factory\/\n {2}README\.md [\s\S]*?\n```/.exec(readmeAndWiki());
  expect(m).toBeTruthy();
  const tree = (m as RegExpExecArray)[0];
  expect(/^ {2}hooks\/$/m.test(tree) && /^ {2}ci\/ /m.test(tree), tree.slice(0, 400)).toBe(true);
  expect(/^ {4}\.claude\/hooks\/$/m.test(tree) || /^ {4}\.claude\/ci\/ /m.test(tree)).toBe(false);
  for (const hook of readdirSync(join(SF, "hooks")).sort()) {
    if (hook.startsWith("factory_release") || hook === "pr-gate.py" || hook === "pr-gate.ts") expect(tree).toContain(hook);
  }
});

test("the readme points at the prd near the top and the file exists", () => {
  expect(existsSync(join(SF, "docs", "PRD.md"))).toBe(true);
  const top = README.slice(0, README.indexOf("## Wiki"));
  expect(top, "the README intro must link the PRD").toContain("software-factory/docs/PRD.md");
  expect(top).toContain("source of truth");
});

test("the dev manager playbook reads the prd before scope questions and sends them to the owner", () => {
  const text = readFileSync(join(SF, "DEV-MANAGER.md"), "utf8");
  expect(text, "DEV-MANAGER.md must link the PRD").toContain("software-factory/docs/PRD.md");
  const para = (/[^\n]*docs\/PRD\.md[^\n]*(?:\n[^\n]+)*/.exec(text) as RegExpExecArray)[0];
  expect(para.includes("before") && para.includes("scope") && para.includes("owner"), para).toBe(true);
});

test("the readme says a migrated project keeps the submodule for the nestjs skills and the release has none", () => {
  const text = section();
  const m = /^\*\*The nestjs skills are not in the release\.\*\*([\s\S]*?)(?=^\*\*|^## )/m.exec(text);
  expect(m, "the section needs a 'The nestjs skills are not in the release.' paragraph").toBeTruthy();
  const para = (m as RegExpExecArray)[1] as string;
  for (const need of ["submodule", ".claude/skills/nestjs-", "check_structure.py", "submodules: true", "vendor/my-skills"]) expect(para).toContain(need);
  // the claim is true: the nestjs skills are top-level folders, outside software-factory/, which is all a release ships
  for (const name of ["nestjs-best-practices", "nestjs-clean-code-ddd-hexagonal"]) {
    expect(statSync(join(ROOT, name)).isDirectory() && !existsSync(join(SF, name)), name).toBe(true);
  }
  expect(readFileSync(join(ROOT, "tools", "build_release.ts"), "utf8")).toContain('SRC = "software-factory"');
  expect(readdirSync(join(KIT, ".claude", "skills")).filter((n) => n.startsWith("nestjs"))).toEqual([]);
});
