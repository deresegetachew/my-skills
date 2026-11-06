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

test("the web app's folder may import React and react-dom, not Ink; nothing else may import react-dom (decision 0005)", () => {
  const d = repo(false);
  mkdirSync(join(d, "software-factory", "web"), { recursive: true });
  mkdirSync(join(d, "software-factory", "hooks"), { recursive: true });
  writeFileSync(join(d, "software-factory", "SKILL.md"), "---\nname: software-factory\ndescription: The factory.\n---\n");
  writeFileSync(join(d, "software-factory", "web", "app.tsx"),
    'import { useState } from "react";\nimport { createRoot } from "react-dom/client";\n' +
    "export const App = () => <p>{String(useState(1)[0])}</p>;\nexport { createRoot };\n");
  let r = run(d);
  expect(r.code, r.out).toBe(0);
  writeFileSync(join(d, "software-factory", "web", "term.tsx"), 'import { Text } from "ink";\nexport { Text };\n');
  writeFileSync(join(d, "software-factory", "hooks", "page.ts"), 'import { renderToString } from "react-dom/server";\nexport { renderToString };\n');
  r = run(d);
  expect(r.code, r.out).toBe(1);
  expect(r.stdout).toContain("software-factory/web/term.tsx: imports ink; the web app (software-factory/web/) may import only React and react-dom");
  expect(r.stdout).toContain("software-factory/hooks/page.ts: imports react-dom/server; only the cockpit's UI (software-factory/cockpit/) may import Ink or React");
  expect(r.stdout).not.toContain("web/app.tsx");
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

/** A repo with the factory's core laid out as decision 0003 says (domain, ports, adapters, compose.ts), all fine. */
function core(): string {
  const d = repo(false);
  const at = (...p: string[]): string => join(d, "software-factory", ...p);
  for (const dir of [["hooks", "core", "domain"], ["hooks", "core", "ports"], ["hooks", "core", "adapters", "memory"], ["tests"]]) {
    mkdirSync(at(...dir), { recursive: true });
  }
  writeFileSync(at("SKILL.md"), "---\nname: software-factory\ndescription: The factory.\n---\n");
  writeFileSync(at("hooks", "core", "domain", "message.ts"), "export class Message { id = \"\"; }\n");
  writeFileSync(at("hooks", "core", "domain", "error.ts"), 'import { Message } from "./message.ts";\nexport type E = Message;\n');
  writeFileSync(at("hooks", "core", "ports", "messaging.ts"),
    'import type { Message } from "../domain/message.ts";\nexport interface Messaging { send(m: Message): Message }\n');
  writeFileSync(at("hooks", "core", "ports", "other.ts"), 'import type { Messaging } from "./messaging.ts";\nexport type O = Messaging;\n');
  writeFileSync(at("hooks", "core", "adapters", "memory", "messaging.ts"),
    'import type { Messaging } from "../../ports/messaging.ts";\nimport { Message } from "../../domain/message.ts";\n' +
    "export class Memory implements Messaging { send(m: Message): Message { return m; } }\n");
  writeFileSync(at("hooks", "core", "compose.ts"), 'import { Memory } from "./adapters/memory/messaging.ts";\nexport const compose = () => new Memory();\n');
  writeFileSync(at("hooks", "factory_messages.ts"), 'import { compose } from "./core/compose.ts";\nimport { Message } from "./core/domain/message.ts";\n' +
    "export const port = compose();\nexport { Message };\n");
  writeFileSync(at("tests", "memory.test.ts"), 'import { Memory } from "../hooks/core/adapters/memory/messaging.ts";\nexport { Memory };\n');
  return d;
}

test("the core's layers pass when each imports only what decision 0003 allows", () => {
  const r = run(core());
  expect(r.code, r.out).toBe(0);
});

test("a domain file that imports an adapter, a port or anything outside the domain fails", () => {
  const d = core();
  const domain = join(d, "software-factory", "hooks", "core", "domain");
  writeFileSync(join(domain, "a.ts"), 'import { Memory } from "../adapters/memory/messaging.ts";\nexport { Memory };\n');
  writeFileSync(join(domain, "b.ts"), 'import type { Messaging } from "../ports/messaging.ts";\nexport type B = Messaging;\n');
  writeFileSync(join(domain, "c.ts"), 'import { gh } from "../../factory_issues.ts";\nexport { gh };\n');
  writeFileSync(join(domain, "d.ts"), 'import { readFileSync } from "node:fs";\nexport { readFileSync };\n');
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  for (const [f, what] of [["a", "../adapters/memory/messaging.ts"], ["b", "../ports/messaging.ts"], ["c", "../../factory_issues.ts"], ["d", "node:fs"]]) {
    expect(r.stdout).toContain(`software-factory/hooks/core/domain/${f}.ts: imports ${what}; the domain imports only the domain`);
  }
  expect(r.stdout).not.toContain("domain/message.ts");
  expect(r.stdout).not.toContain("domain/error.ts");
});

test("a port that imports an adapter or anything but the domain and the ports fails", () => {
  const d = core();
  const ports = join(d, "software-factory", "hooks", "core", "ports");
  writeFileSync(join(ports, "x.ts"), 'import { Memory } from "../adapters/memory/messaging.ts";\nexport { Memory };\n');
  writeFileSync(join(ports, "y.ts"), 'import { load } from "../../factory_config.ts";\nexport { load };\n');
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  expect(r.stdout).toContain("software-factory/hooks/core/ports/x.ts: imports ../adapters/memory/messaging.ts; a port imports only the domain and the ports");
  expect(r.stdout).toContain("software-factory/hooks/core/ports/y.ts: imports ../../factory_config.ts; a port imports only the domain and the ports");
});

test("a command that imports an adapter directly fails; compose.ts, other adapters and tests may", () => {
  const d = core();
  const hooks = join(d, "software-factory", "hooks");
  writeFileSync(join(hooks, "factory_x.ts"), 'import { Memory } from "./core/adapters/memory/messaging.ts";\nexport const port = new Memory();\n');
  writeFileSync(join(hooks, "core", "y.ts"), 'export const load = () => import("./adapters/memory/messaging.ts");\n');
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  expect(r.stdout).toContain("software-factory/hooks/factory_x.ts: imports ./core/adapters/memory/messaging.ts; only core/compose.ts builds the adapters");
  expect(r.stdout).toContain("software-factory/hooks/core/y.ts: imports ./adapters/memory/messaging.ts; only core/compose.ts builds the adapters");
  expect(r.stdout).not.toContain("compose.ts: imports");
  expect(r.stdout).not.toContain("tests/memory.test.ts");
});

// ---- a plugin's packages are imported only inside its folder (#405, decision 0004) ----

/** A repo with software-factory/plugins/nats (package.json naming several packages), all fine. */
function withPlugin(): string {
  const d = repo(false);
  const at = (...p: string[]): string => join(d, "software-factory", ...p);
  mkdirSync(at("plugins", "nats", "tests"), { recursive: true });
  mkdirSync(at("hooks"), { recursive: true });
  mkdirSync(at("tests"), { recursive: true });
  writeFileSync(at("SKILL.md"), "---\nname: software-factory\ndescription: The factory.\n---\n");
  writeFileSync(at("plugins", "nats", "package.json"), JSON.stringify({ name: "nats-plugin", dependencies: { nats: "2.0.0" },
    devDependencies: { "@nats-io/x": "1.0.0" }, peerDependencies: { peerp: "1.0.0" }, optionalDependencies: { optp: "1.0.0" } }));
  writeFileSync(at("plugins", "nats", "index.ts"), 'import { connect } from "nats";\nimport { y } from "@nats-io/x/sub";\nexport { connect, y };\n');
  writeFileSync(at("plugins", "nats", "tests", "a.test.ts"), 'import { connect } from "nats";\nexport { connect };\n');
  writeFileSync(at("hooks", "ok.ts"), 'import type { Thing } from "../plugins/nats/index.ts";\nimport { z } from "natsy";\nimport { readFileSync } from "node:fs";\n' +
    "export { readFileSync, z };\nexport type T = Thing;\n");
  return d;
}

test("a plugin's own files may import its packages; a relative type import and an unlisted package pass", () => {
  const r = run(withPlugin());
  expect(r.code, r.out).toBe(0);
});

test("a file outside the plugin that imports one of its packages fails, whatever the import form", () => {
  const d = withPlugin();
  const outside: [string, string, string][] = [
    [join("software-factory", "hooks", "a.ts"), 'import { connect } from "nats";\nexport { connect };\n', "nats"],
    [join("software-factory", "hooks", "b.ts"), 'import type { X } from "@nats-io/x";\nexport type B = X;\n', "@nats-io/x"],
    [join("software-factory", "tests", "c.test.ts"), 'export const load = () => import("nats/lib/thing");\n', "nats/lib/thing"],
    [join("tools", "d.ts"), 'const n = require("peerp");\nexport { n };\n', "peerp"],
    [join("demo", "e.ts"), 'import o from "optp/sub";\nexport { o };\n', "optp/sub"],
  ];
  for (const [path, body] of outside) writeFileSync(join(d, path), body);
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  for (const [path, , spec] of outside) {
    expect(r.stdout).toContain(`${path}: imports ${spec}; only software-factory/plugins/nats/ may import its packages (decision 0004)`);
  }
  expect(r.stdout).not.toContain("hooks/ok.ts");
  expect(r.stdout).not.toContain("plugins/nats/index.ts");
  expect(r.stdout).not.toContain("plugins/nats/tests");
});

// ---- the message board imports nothing from the factory, and the factory only its public entry (#489, decision 0007) ----

/** A repo with software-factory/message-board/ whose files import only built-ins and each other, and a factory file
 * that imports only message-board/src/index.ts. */
function withBoard(): string {
  const d = repo(false);
  const at = (...p: string[]): string => join(d, "software-factory", ...p);
  for (const dir of [["message-board", "src"], ["message-board", "tests"], ["hooks"], ["tests"]]) mkdirSync(at(...dir), { recursive: true });
  writeFileSync(at("SKILL.md"), "---\nname: software-factory\ndescription: The factory.\n---\n");
  writeFileSync(at("message-board", "src", "rows.ts"), "export const x = 1;\n");
  writeFileSync(at("message-board", "src", "index.ts"),
    'import { SQL } from "bun";\nimport { readFileSync } from "node:fs";\nimport { join } from "path";\nimport { x } from "./rows.ts";\n' +
    "export { SQL, readFileSync, join, x };\n");
  writeFileSync(at("message-board", "bin.ts"), 'import { x } from "./src/index.ts";\nexport { x };\n');
  writeFileSync(at("message-board", "tests", "a.test.ts"), 'import { expect } from "bun:test";\nimport { x } from "../src/rows.ts";\nexport { expect, x };\n');
  writeFileSync(at("hooks", "ok.ts"), 'import { x } from "../message-board/src/index.ts";\nimport type { X } from "../message-board/src/index.ts";\n' +
    "export { x };\nexport type Y = X;\n");
  writeFileSync(at("tests", "ok.test.ts"), 'import { x } from "../message-board/src/index.ts";\nexport { x };\n');
  return d;
}

test("the message board importing built-ins and its own files, and the factory its public entry, pass", () => {
  const r = run(withBoard());
  expect(r.code, r.out).toBe(0);
});

test("a message board file that imports from outside its folder, or a package, fails", () => {
  const d = withBoard();
  const at = (...p: string[]): string => join("software-factory", "message-board", ...p);
  const bad: [string, string, string][] = [
    [at("src", "a.ts"), 'import { load } from "../../hooks/factory_config.ts";\nexport { load };\n', "../../hooks/factory_config.ts"],
    [at("src", "b.ts"), 'import type { T } from "../../hooks/core/domain/task.ts";\nexport type B = T;\n', "../../hooks/core/domain/task.ts"],
    [at("tests", "c.test.ts"), 'export const load = () => import("../../tests/support.ts");\n', "../../tests/support.ts"],
    [at("bin.ts"), 'import pg from "pg";\nexport { pg };\n', "pg"],
    [at("src", "d.ts"), 'const r = require("/etc/thing.js");\nexport { r };\n', "/etc/thing.js"],
  ];
  for (const [path, body] of bad) writeFileSync(join(d, path), body);
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  for (const [path, , spec] of bad) {
    expect(r.stdout).toContain(`${path}: imports ${spec}; the message board imports only built-ins and its own files (decision 0007)`);
  }
  expect(r.stdout).not.toContain("message-board/src/index.ts:");
  expect(r.stdout).not.toContain("message-board/tests/a.test.ts");
});

test("a factory file that imports anything in the message board but src/index.ts fails", () => {
  const d = withBoard();
  const bad: [string, string, string][] = [
    [join("software-factory", "hooks", "a.ts"), 'import { x } from "../message-board/src/rows.ts";\nexport { x };\n', "../message-board/src/rows.ts"],
    [join("software-factory", "hooks", "b.ts"), 'import type { X } from "../message-board/bin.ts";\nexport type B = X;\n', "../message-board/bin.ts"],
    [join("software-factory", "tests", "c.test.ts"), 'export const load = () => import("../message-board/tests/pg.ts");\n', "../message-board/tests/pg.ts"],
    [join("tools", "d.ts"), 'export { x } from "../software-factory/message-board/src/rows.ts";\n', "../software-factory/message-board/src/rows.ts"],
  ];
  for (const [path, body] of bad) writeFileSync(join(d, path), body);
  const r = run(d);
  expect(r.code, r.out).toBe(1);
  for (const [path, , spec] of bad) {
    expect(r.stdout).toContain(`${path}: imports ${spec}; the factory imports only message-board/src/index.ts (decision 0007)`);
  }
  expect(r.stdout).not.toContain("hooks/ok.ts");
  expect(r.stdout).not.toContain("tests/ok.test.ts");
});
