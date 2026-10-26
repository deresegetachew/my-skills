// factory manage-tick: an idle dev manager tick makes no model call (#71).
import { expect, test } from "bun:test";
import { closeSync, openSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { flock } from "../hooks/factory_lib.ts";
import { BUN, HOOKS, sh, write, writeExe } from "./support.ts";
import { type Env, pr, Q, type Row, SF, world } from "./wait_support.ts";

const TICK = join(HOOKS, "factory_tick.ts");
const FACTORY = join(SF, "factory");
const FAKE_CLAUDE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CLAUDE_LOG as string, JSON.stringify(process.argv.slice(2)) + "\\n");
`;

function project(o: { models?: Row; profile?: boolean } & Row = {}): [string, Env] {
  const { models, profile, ...db } = o;
  const [d, env] = world(db);
  write(join(d, ".claude", "factory.json"), JSON.stringify(models ? { models } : {}));
  if (profile !== false) write(join(d, ".claude", "manager", "settings.json"), "{}");
  writeExe(join(d, "bin", "claude"), FAKE_CLAUDE);
  env.CLAUDE_LOG = join(d, "claude.log");
  sh(["git", "init", "-q", d]);
  return [d, env];
}

function tick(d: string, env: Env, ...args: string[]): [number, string, string] {
  const p = sh([...BUN, TICK, ...args], { cwd: d, env, timeoutMs: 60_000 });
  return [p.code, p.stdout.trim(), p.stderr.trim()];
}

function calls(d: string): string[][] {
  try {
    return readFileSync(join(d, "claude.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
}

test("an idle tick makes no model call", () => {
  const [d, env] = project({ pulls: { "7": pr(7) }, comments: { "7": ["<!-- factory-approved sha=abc1234 -->", Q, "<!-- factory-answer -->\nok"] } });
  expect(tick(d, env).slice(0, 2)).toEqual([0, "nothing to do"]);
  expect(calls(d)).toEqual([]);
});

test("a tick with work starts one manage pass on the manager profile", () => {
  const [d, env] = project({ models: { manager: { model: "sonnet", effort: "low" } }, pulls: { "7": pr(7, { sha: "bbb2222" }) } });
  const [rc, out, err] = tick(d, env);
  expect(rc, `${out}\n${err}`).toBe(0);
  expect(out).toContain("PR #7: commit bbb2222 not reviewed");
  const all = calls(d);
  expect(all.length).toBe(1);
  const argv = all[0] as string[];
  expect(argv.slice(-2)).toEqual(["-p", "/manage-pass"]);
  expect(argv[argv.indexOf("--settings") + 1]).toBe(".claude/manager/settings.json");
  expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
  expect(argv).toContain("--strict-mcp-config");
});

test("no models setting adds no model flags", () => {
  const [d, env] = project({ pulls: { "7": pr(7, { sha: "bbb2222" }) } });
  tick(d, env);
  const all = calls(d);
  expect(all.length).toBe(1);
  expect(all[0]).not.toContain("--model");
  expect(all[0]).not.toContain("--effort");
});

test("dry run prints the command and starts nothing", () => {
  const [d, env] = project({ pulls: { "7": pr(7, { sha: "bbb2222" }) } });
  const [rc, out] = tick(d, env, "--dry-run");
  expect(rc, out).toBe(0);
  expect(out).toContain("would run: claude");
  expect(out).toContain("/manage-pass");
  expect(calls(d)).toEqual([]);
});

test("a missing manager profile stops with the fix and no model call", () => {
  const [d, env] = project({ profile: false, pulls: { "7": pr(7, { sha: "bbb2222" }) } });
  const [rc, , err] = tick(d, env);
  expect(rc, err).toBe(1);
  expect(err).toContain("Fix:");
  expect(calls(d)).toEqual([]);
});

test("a bad models setting stops with the reason", () => {
  const [d, env] = project({ models: { nobody: { model: "x" } }, pulls: { "7": pr(7, { sha: "bbb2222" }) } });
  const [rc, , err] = tick(d, env);
  expect(rc, err).toBe(1);
  expect(err).toContain("not a role");
  expect(calls(d)).toEqual([]);
});

test("factory command routes manage tick", () => {
  const [d, env] = project({ pulls: { "7": pr(7) }, comments: { "7": ["<!-- factory-approved sha=abc1234 -->"] } });
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  const p = sh(["bash", FACTORY, "manage-tick"], { cwd: d, env });
  expect([p.code, p.stdout.trim()], p.out).toEqual([0, "nothing to do"]);
});

test("a tick does not start a second pass while one runs", () => {
  const [d, env] = project({ pulls: { "7": pr(7, { sha: "bbb2222" }) } });
  const held = openSync(join(d, ".git", "factory-manage-tick.lock"), "w");
  expect(flock(held)).toBe(true);
  const [rc, out] = tick(d, env);
  expect(rc, out).toBe(0);
  expect(out).toContain("already running");
  expect(calls(d)).toEqual([]);
  closeSync(held);
  expect(tick(d, env)[0]).toBe(0);
  expect(calls(d).length).toBe(1);
});
