#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The project's stack (#199): what install.sh finds on a first install, and how the Python CI workflow runs a command.
//
//   factory_stack.ts detect <project>         prints JSON: {stack, reason, commands, notes}
//                                             stack is node (package.json), python, or unknown
//   factory_stack.ts lines <project>          prints what the install says about the stack
//   factory_stack.ts apply <project>          writes the Python `commands.*` into <project>/.claude/factory.json, with the
//                                             allow rules an unattended agent needs to run commands.test (#249)
//                                             (does nothing for node or an unknown stack)
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_stack.ts run <name>
//                                             runs commands.<name> from .claude/factory.json in the current folder;
//                                             empty: says so and exits 0 (CI's Python template uses it)
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { AGENT_SETTINGS, pyDumps, run as runCmd, runMain } from "./factory_lib.ts";

export const PYTHON_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg"];

export interface Found {
  stack: "node" | "python" | "unknown";
  reason: string;
  commands: Record<string, string>;
  notes: string[];
}

type JsonObj = Record<string, unknown>;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** tests/**\/test_*.py under root, sorted (Python's glob: hidden folders are not entered). */
export function pythonTests(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      if (isDir(p)) walk(p);
      else if (/^test_.*\.py$/s.test(n) && isFile(p)) out.push(p);
    }
  };
  walk(join(root, "tests"));
  return out.sort();
}

export function isPython(root: string): boolean {
  if (PYTHON_MARKERS.some((m) => isFile(join(root, m)))) return true;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    names = [];
  }
  if (names.some((n) => /^requirements.*\.txt$/s.test(n))) return true;
  return pythonTests(root).length > 0;
}

const UNITTEST = /unittest\.TestCase|^\s*(import unittest|from unittest)/m;

function usesUnittestFile(path: string): boolean {
  try {
    return UNITTEST.test(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));
  } catch {
    return false;
  }
}

export function usesUnittest(root: string): boolean {
  return pythonTests(root).some(usesUnittestFile);
}

/** The folder to discover from (relative to root). Python 3.11+ skips a folder with no __init__.py when discovering
 * from the top, so the command names it (#244): tests/ when a test sits right in it, else the folder of the first
 * unittest-style test. */
export function unittestDir(root: string): string {
  const found = pythonTests(root).filter(usesUnittestFile);
  const top = join(root, "tests");
  if (found.some((p) => dirname(p) === top)) return "tests";
  return relative(root, dirname(found[0] as string)).split("\\").join("/");
}

export function detect(root: string): Found {
  if (isFile(join(root, "package.json"))) return { stack: "node", reason: "package.json", commands: {}, notes: [] };
  if (!isPython(root)) {
    return { stack: "unknown", reason: "no package.json, and no Python files it knows", commands: {}, notes: [] };
  }
  const cmds: Record<string, string> = { install: "", typecheck: "", lint: "", build: "", test: "" };
  const notes: string[] = [];
  if (existsSync(join(root, "requirements.txt"))) cmds.install = "python3 -m pip install -r requirements.txt";
  if (usesUnittest(root)) cmds.test = "python3 -m unittest discover -s " + unittestDir(root);
  else {
    notes.push("no unittest-style tests found, so commands.test is empty: set it in .claude/factory.json " +
      "(for example `python3 tests/test_x.py` or `python3 -m pytest`).");
  }
  return { stack: "python", reason: "Python files", commands: cmds, notes };
}

/** The allow rules an unattended agent needs to run the test command detection set, alone or through
 * `./factory run-check` (#249). Empty when detection set no test command. */
export function allowRules(found: Found): string[] {
  const test = found.stack === "python" ? (found.commands.test ?? "") : "";
  if (!test) return [];
  const m = /^(\S+ -m \S+)/.exec(test);
  const prefix = m ? (m[1] as string) : (test.split(/\s+/)[0] as string) + " ";
  return [`Bash(${prefix}*)`, "Bash(./factory run-check*)"];
}

/** The allow rules an unattended agent needs to run `command` as it was given, alone (with more arguments after it, such
 * as one test file) and through `./factory run-check` (#540). Empty for an empty command. */
export function commandRules(command: string): string[] {
  const c = command.trim();
  return c ? [`Bash(${c}*)`, "Bash(./factory run-check*)"] : [];
}

/** The commands a workflow made from the kit's runs, in order: each step reads its command from .claude/factory.json. */
const WORKFLOW_COMMANDS = ["install", "typecheck", "lint", "test", "build"] as const;

/** The first line of the kit's pnpm workflow (kit/.github/workflows/ci.yml): only a file that starts with it is changed. */
export const KIT_CI_HEAD = "# Software factory CI: the pull-request gate merges only when these checks are green.";

/** The kit's pnpm CI workflow made to run the project's own commands (#540): every `pnpm <x>` step becomes a step that
 * runs `commands.<x>` from .claude/factory.json (`factory_stack.ts run <x>`, which says so and passes when it is empty),
 * and with no package.json the pnpm and Node setup steps go. Any other workflow, or one already changed, comes back as
 * it was. */
export function commandsWorkflow(text: string, hasPackageJson: boolean): string {
  if (!text.startsWith(KIT_CI_HEAD) || !/^\s*- uses: pnpm\/action-setup@/m.test(text)) return text;
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const indent = /^(\s*)/.exec(line)?.[1] ?? "";
    if (!hasPackageJson && /^\s*- uses: pnpm\/action-setup@/.test(line)) continue;
    if (!hasPackageJson && /^\s*- uses: actions\/setup-node@/.test(line)) {
      while (i + 1 < lines.length && (lines[i + 1] as string).startsWith(indent + "  ")) i++; // its `with:` block
      continue;
    }
    const run = /^\s*- run: pnpm (?:run )?(\w+)\b/.exec(line);
    const name = run ? (run[1] === "i" ? "install" : run[1]) : null;
    if (name && (WORKFLOW_COMMANDS as readonly string[]).includes(name)) {
      out.push(`${indent}- name: ${name[0]?.toUpperCase()}${name.slice(1)} (commands.${name} in .claude/factory.json)`,
        `${indent}  run: bun --no-env-file --config=/dev/null .claude/hooks/factory_stack.ts run ${name}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace("# Adjust the setup and the commands to match .claude/factory.json.",
    "# Each command step runs commands.<name> from .claude/factory.json; an empty one is skipped with a warning.");
}

function addAllow(doc: JsonObj, rules: readonly string[]): boolean {
  if (!rules.length) return false;
  const perms = (doc.permissions && typeof doc.permissions === "object" && !Array.isArray(doc.permissions)
    ? doc.permissions : (doc.permissions = {})) as JsonObj;
  const allow = (Array.isArray(perms.allow) ? perms.allow : (perms.allow = [])) as unknown[];
  const add = [...new Set(rules)].filter((r) => !allow.includes(r));
  allow.push(...add);
  return add.length > 0;
}

/** factory.json's text with a Python stack's `commands.*` written in, and the allow rules its test command needs
 * (`permissions.allow`, #249); unchanged for any other stack. */
export function commandsText(text: string, found: Found): string {
  if (found.stack !== "python") return text;
  const cfg = JSON.parse(text) as JsonObj;
  const commands = (cfg.commands && typeof cfg.commands === "object" && !Array.isArray(cfg.commands)
    ? cfg.commands : (cfg.commands = {})) as JsonObj;
  Object.assign(commands, found.commands);
  addAllow(cfg, allowRules(found));
  return pyDumps(cfg, { indent: 2, ensureAscii: false }) + "\n";
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** What the install tells the person about the stack it found (the same words from install.sh and the release
 * client). The allow rules apply in a linked project too: the factory adds factory.json's `permissions.allow` to the
 * agents' settings each time it starts one (#258). */
export function lines(found: Found, _root?: string): string[] {
  if (found.stack === "python") {
    const out = ["Stack: Python (no package.json). CI uses the Python workflow, and commands.* in .claude/factory.json were set to match."];
    const rules = allowRules(found);
    if (rules.length) {
      out.push("Allowed for unattended agents (permissions.allow in .claude/factory.json): " +
        rules.map((r) => "`" + r + "`").join(", ") + ".");
    }
    return out.concat(found.notes.map((n) => "Note: " + n));
  }
  if (found.stack === "unknown") {
    return ["Stack: could not tell (no package.json, no Python files). CI keeps the pnpm template.",
      "Note: edit .github/workflows/ci.yml and the commands in .claude/factory.json to match your project."];
  }
  return [];
}

/** Write a Python stack's commands and allow rules into factory.json; a copied (not linked) agents' settings file gets
 * the allow rules too, after its own, so Claude Code lets an unattended agent run the tests (#249). */
export function apply(root: string): Found {
  const found = detect(root);
  const path = join(root, ".claude", "factory.json");
  if (found.stack === "python") {
    writeFileSync(path, commandsText(readFileSync(path, "utf8"), found));
    const settings = join(root, AGENT_SETTINGS);
    if (isFile(settings) && !isLink(settings)) {
      try {
        const doc = JSON.parse(readFileSync(settings, "utf8")) as JsonObj;
        if (addAllow(doc, allowRules(found))) writeFileSync(settings, pyDumps(doc, { indent: 2, ensureAscii: false }) + "\n");
      } catch {
        // a settings.json that is not JSON is left as it is; doctor reports it
      }
    }
  }
  return found;
}

export function run(name: string): number {
  const cfg = JSON.parse(readFileSync(join(".claude", "factory.json"), "utf8")) as JsonObj;
  const commands = (cfg.commands && typeof cfg.commands === "object" ? cfg.commands : {}) as JsonObj;
  const command = typeof commands[name] === "string" ? (commands[name] as string) : "";
  if (!command) {
    writeSync(1, `::warning::commands.${name} is empty in .claude/factory.json, so nothing ran.\n`);
    return 0;
  }
  writeSync(1, `+ ${command}\n`);
  return runCmd(["/bin/sh", "-c", command], { inherit: true }).code;
}

export function main(argv: string[]): number {
  if (argv.length === 2 && (argv[0] === "detect" || argv[0] === "apply")) {
    console.log(pyDumps((argv[0] === "detect" ? detect : apply)(argv[1] as string), { indent: 2 }));
    return 0;
  }
  if (argv.length === 2 && argv[0] === "lines") {
    console.log(lines(detect(argv[1] as string), argv[1]).join("\n"));
    return 0;
  }
  if (argv.length === 2 && argv[0] === "run") return run(argv[1] as string);
  process.stderr.write(pyDumps({ code: "usage", message: "unknown command.", fix: "Use: detect <project>, apply <project> or run <name>." }) + "\n");
  return 2;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
