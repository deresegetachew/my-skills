#!/usr/bin/env -S bun --no-env-file
// The project's stack (#199): what install.sh finds on a first install, and how the Python CI workflow runs a command.
//
//   factory_stack.ts detect <project>         prints JSON: {stack, reason, commands, notes}
//                                             stack is node (package.json), python, or unknown
//   factory_stack.ts lines <project>          prints what the install says about the stack
//   factory_stack.ts apply <project>          writes the Python `commands.*` into <project>/.claude/factory.json, with the
//                                             allow rules an unattended agent needs to run commands.test (#249)
//                                             (does nothing for node or an unknown stack)
//   bun --no-env-file .claude/hooks/factory_stack.ts run <name>
//                                             runs commands.<name> from .claude/factory.json in the current folder;
//                                             empty: says so and exits 0 (CI's Python template uses it)
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pyDumps, run as runCmd, runMain } from "./factory_lib.ts";

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
 * client). With `root`, a project whose .claude/settings.json is a link is told to add the allow rules by hand. */
export function lines(found: Found, root?: string): string[] {
  if (found.stack === "python") {
    const out = ["Stack: Python (no package.json). CI uses the Python workflow, and commands.* in .claude/factory.json were set to match."];
    const rules = allowRules(found);
    if (rules.length) {
      out.push("Allowed for unattended agents (permissions.allow in .claude/factory.json): " +
        rules.map((r) => "`" + r + "`").join(", ") + ".");
      if (root && isLink(join(root, ".claude", "settings.json"))) {
        out.push("Note: .claude/settings.json is a link into the kit, so Claude Code does not read those rules from " +
          "factory.json: add them to the allow list in a .claude/settings.local.json, or the agent cannot run the tests unattended.");
      }
    }
    return out.concat(found.notes.map((n) => "Note: " + n));
  }
  if (found.stack === "unknown") {
    return ["Stack: could not tell (no package.json, no Python files). CI keeps the pnpm template.",
      "Note: edit .github/workflows/ci.yml and the commands in .claude/factory.json to match your project."];
  }
  return [];
}

/** Write a Python stack's commands and allow rules into factory.json; a copied (not linked) .claude/settings.json gets
 * the allow rules too, after its own, so Claude Code lets an unattended agent run the tests (#249). */
export function apply(root: string): Found {
  const found = detect(root);
  const path = join(root, ".claude", "factory.json");
  if (found.stack === "python") {
    writeFileSync(path, commandsText(readFileSync(path, "utf8"), found));
    const settings = join(root, ".claude", "settings.json");
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
