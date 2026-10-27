// factory_config.ts (the settings loader), factory_clock.ts and factory_env.ts (#252: the base every script imports).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { runCode, runHook, tmp, write, HOOKS } from "./support.ts";

const CFG = JSON.stringify(join(HOOKS, "factory_config.ts"));

function project(settings: unknown): string {
  const d = tmp();
  write(join(d, ".claude", "factory.json"), JSON.stringify(settings));
  return d;
}

function evalIn(d: string, body: string): { code: number; out: string; stdout: string } {
  const code = `import * as C from ${CFG};\n${body}`;
  return runCode(code, { cwd: d, env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
}

test("load merges the project's settings over the defaults, one field of a nested section at a time", () => {
  const d = project({ agents: ["abebe"], commands: { test: "make test" }, manager: { idleMinutes: 9 },
    roles: { "product-owner": { busyMinutes: 3 } }, _comment: "ignored" });
  const p = evalIn(d, `const c = C.load(); console.log(JSON.stringify([c.agents, c.commands.test, c.commands.lint,
    c.manager.idleMinutes, c.manager.busyMinutes, C.roleSetting(c, "product-owner", "busyMinutes"),
    C.roleSetting(c, "product-owner", "idleMinutes"), "_comment" in c, process.cwd() === ${JSON.stringify(d)}]));`);
  expect(p.code, p.out).toBe(0);
  expect(JSON.parse(p.stdout)).toEqual([["abebe"], "make test", "", 9, 2, 3, 60, false, true]);
});

test("load without a factory.json gives the defaults", () => {
  const d = tmp();
  const p = evalIn(d, `const c = C.load(); console.log(c.mainBranch, C.taskSource(c), C.taskLabels(c).ready, C.rolesDir(c));`);
  expect(p.stdout.trim()).toBe("main plan factory:ready .claude/factory/roles");
});

test("plan tasks, blocked ids and branch task ids are read as before", () => {
  const d = tmp();
  const p = evalIn(d, `
    const plan = "- [x] **1.1 Set up.**\\n- [ ] **1.2 Add users**\\n  - [ ] **2 Ship** later\\n";
    console.log(JSON.stringify(C.tasks(plan)));
    console.log(JSON.stringify([...C.blockedIds("- 1.2: waits for keys\\n- 3: no\\n")]));
    console.log(JSON.stringify([C.branchTask("task/1-3-validators"), C.branchTask("task/1.3-validators"),
      C.branchTask("task/7"), C.branchTask("feature/x")]));`);
  const lines = p.stdout.trim().split("\n");
  expect(JSON.parse(lines[0] as string)).toEqual([["1.1", true, "Set up"], ["1.2", false, "Add users"], ["2", false, "Ship"]]);
  expect(JSON.parse(lines[1] as string)).toEqual(["1.2", "3"]);
  expect(JSON.parse(lines[2] as string)).toEqual(["1.3", "1.3", "7", null]);
});

test("a bad agent name stops with the same message", () => {
  const d = project({ agents: ["menelik", "../x"] });
  const p = evalIn(d, `import { runMain } from ${JSON.stringify(join(HOOKS, "factory_lib.ts"))};
    await runMain(() => { const c = C.load(); console.log(C.agentName(c, 1)); C.agentName(c, 2); });`);
  expect(p.code).toBe(1);
  expect(p.stdout.trim()).toBe("menelik");
  expect(p.out).toContain("'../x' isn't a valid agent name: use lowercase letters, digits and dashes");
});

test("slots, role names and waits", () => {
  const d = project({ agents: ["a", "b"], roles: { "dev-manager": { names: ["m1"] } }, manager: { busyMinutes: "x" } });
  const p = evalIn(d, `const c = C.load(); console.log(JSON.stringify([C.agentSlot(c, "b"), C.agentSlot(c, "agent-4"),
    C.agentSlot(c, "zz"), C.agentName(c, 3), C.roleNames(c, "dev-manager"), C.roleNames(c, "coding-agent"),
    C.roleWait(c, "dev-manager", "busy"), C.roleWait(c, "dev-manager", "idle"), C.roleWait(c, "product-owner", "idle"),
    C.matches("src/a.ts", ["^src/"]), C.styled(["apps/api/x.ts"], { ...c, styles: [{ paths: ["apps/api/**"], skills: ["s"] }] }).length]));`);
  expect(JSON.parse(p.stdout)).toEqual([2, 4, null, "agent-3", ["m1"], ["a", "b"], 2, 5, 60, true, 1]);
});

test("FACTORY_NOW sets the clock", () => {
  const code = `import { now } from ${JSON.stringify(join(HOOKS, "factory_clock.ts"))}; console.log(now());`;
  expect(runCode(code, { env: { ...process.env, FACTORY_NOW: "1700000000.5" } }).stdout.trim()).toBe("1700000000.5");
  const real = Number(runCode(code, { env: { ...process.env, FACTORY_NOW: "soon" } }).stdout);
  expect(Math.abs(real - Date.now() / 1000)).toBeLessThan(60);
});

test("factory_env gives each slot its own ports and suffix", () => {
  const d = project({ agents: ["menelik", "taytu"], portStep: 10,
    agentEnv: { API_PORT: "{port:4100}", DB: "app{suffix}", SLOT: "{slot}", _note: "x" } });
  let p = runHook("factory_env", [], { cwd: d, env: { ...process.env, CLAUDE_PROJECT_DIR: d, FACTORY_AGENT: "" } });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toBe("export FACTORY_SLOT=1\nexport API_PORT=4100\nexport DB=app\nexport SLOT=1\n");
  p = runHook("factory_env", ["--agent", "taytu", "--dotenv"], { cwd: d, env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  expect(p.stdout).toBe("FACTORY_SLOT=2\nAPI_PORT=4110\nDB=app_2\nSLOT=2\n");
});

test("factory_env refuses a bad variable name and an unknown placeholder", () => {
  let d = project({ agentEnv: { "A-B": "x" } });
  let p = runHook("factory_env", [], { cwd: d, env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  expect(p.code).toBe(1);
  expect(p.stderr).toContain("agentEnv: 'A-B' isn't a valid variable name (letters, digits and _ only)");
  d = project({ agentEnv: { A: "{nope}" } });
  p = runHook("factory_env", [], { cwd: d, env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  expect(p.code).toBe(1);
  expect(p.stderr).toContain("agentEnv: unknown placeholder {nope} in '{nope}'");
});
