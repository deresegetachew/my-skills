// `factory board <verb>` (#489, decision 0007 point 10): `factory help` lists it, the wiki's commands page has its rows,
// and the factory script runs message-board/bin.ts through the project's hooks folder. The verbs themselves are tested
// against a real Postgres in message-board/tests/.
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { gitRepo, HOOKS, read, SF, sh, WIKI } from "./support.ts";

const VERBS = ["up", "down", "status", "migrate", "backup", "sweep", "tasks", "ready", "show", "prime"];

test("factory help lists every board verb", () => {
  const p = sh(["bash", join(SF, "factory"), "help"], { cwd: SF });
  expect(p.code).toBe(0);
  const lines = p.stdout.split("\n").filter((l) => /^ {2}board /.test(l));
  const listed = lines.join(" ");
  for (const verb of VERBS) expect(listed).toMatch(new RegExp(`\\b${verb}\\b`));
  expect(p.stdout).toMatch(/^ {2}board up \[--port N\]/m);
  expect(p.stdout).toMatch(/^ {2}board prime <actor>/m);
});

test("the wiki's commands page has a row for each board verb", () => {
  const wiki = read(join(WIKI, "commands.md"));
  for (const verb of VERBS) expect(wiki).toContain(`| \`factory board ${verb}`);
});

test("factory board runs the message board's command from the factory's folder", () => {
  const d = gitRepo();
  mkdirSync(join(d, ".claude"));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  const p = sh(["bash", join(SF, "factory"), "board", "help"], { cwd: d });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("factory board prime <actor>");
  const bad = sh(["bash", join(SF, "factory"), "board", "fly"], { cwd: d });
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain('"code": "unknown-verb"');
});

test("a project without the message board gets the fix, not a stack trace", () => {
  const d = gitRepo();
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  const p = sh(["bash", join(SF, "factory"), "board", "status"], { cwd: d });
  expect(p.code).toBe(1);
  expect(p.stderr).toContain('"code": "board_missing"');
  expect(p.stderr).toContain("factory update");
});
