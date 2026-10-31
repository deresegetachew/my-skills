// The product owner plans when the builders run low on work (#378): `work product-owner` adds a planning line when
// fewer `factory:ready` tasks can start now than `roles.product-owner.minReady`.
import { expect, test } from "bun:test";
import { factory, issue, poProject, type Row } from "./roles_support.ts";
import { sh } from "./support.ts";

const ISSUES_MODE = { tasks: { source: "issues" } };

function workOf(issues: Row[], cfg: Row = ISSUES_MODE): { out: string; code: number } {
  const [, work, env] = poProject({ db: { issues }, cfg });
  const p = sh(["bun", "--no-env-file", "--config=/dev/null", ".claude/hooks/factory_roles.ts", "work", "product-owner"],
    { cwd: work, env });
  return { out: p.stdout, code: p.code };
}

const ready = (n: number, body = ""): Row => issue(n, `Task ${n}`, body, ["factory:ready"]);

test("two startable tasks with minReady 4 make a planning line (#378)", () => {
  const r = workOf([ready(21), ready(22), issue(23, "Building", "", ["factory:in-progress", "agent:menelik"])]);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain("planning: 2 tasks can start (#21, #22), below 4");
});

test("ready tasks that depend on an open issue do not count as startable (#378)", () => {
  const r = workOf([ready(21), ready(22), ready(24, "Depends on #23"), ready(25, "Depends on #21, #22"),
    issue(23, "Building", "", ["factory:in-progress", "agent:menelik"])]);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain("planning: 2 tasks can start (#21, #22), below 4");
});

test("a claimed or blocked ready task does not count, and a closed dependency does not hold one back (#378)", () => {
  const r = workOf([ready(21), issue(22, "Claimed", "", ["factory:ready", "agent:taytu"]),
    issue(23, "Blocked", "", ["factory:ready", "factory:blocked"]), ready(24, "Depends on #20"),
    issue(20, "Done", "", [], "closed")]);
  expect(r.out).toContain("planning: 2 tasks can start (#21, #24), below 4");
});

const DONE = issue(20, "Done", "", ["factory:in-review"], "closed"); // a merged task keeps its label

test("no startable task at all still asks for planning once the project has tasks (#378)", () => {
  const r = workOf([DONE]);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain("planning: 0 tasks can start, below 4");
});

test("a project with no task issue yet is in discovery, not planning (#378)", () => {
  const r = workOf([issue(30, "Agent: menelik", "", ["factory:agent"]), issue(31, "Dev manager: needs the owner"),
    issue(32, "Closed idea", "", [], "closed")]);
  expect(r.code, r.out).toBe(3);
  expect(r.out).not.toContain("planning");
});

test("five startable tasks make no planning line (#378)", () => {
  const r = workOf([21, 22, 24, 25, 26].map((n) => ready(n)));
  expect(r.code, r.out).toBe(3);
  expect(r.out).not.toContain("planning");
  expect(r.out).toContain("nothing to do");
});

test("minReady 0 turns planning off (#378)", () => {
  const r = workOf([DONE], { ...ISSUES_MODE, roles: { "product-owner": { names: ["eleni"], busyMinutes: 0, idleMinutes: 0, minReady: 0 } } });
  expect(r.code, r.out).toBe(3);
  expect(r.out).not.toContain("planning");
});

test("minReady is read from the project's settings (#378)", () => {
  const r = workOf([ready(21), ready(22)], { ...ISSUES_MODE,
    roles: { "product-owner": { names: ["eleni"], busyMinutes: 0, idleMinutes: 0, minReady: 2 } } });
  expect(r.out).not.toContain("planning");
  const low = workOf([ready(21)], { ...ISSUES_MODE,
    roles: { "product-owner": { names: ["eleni"], busyMinutes: 0, idleMinutes: 0, minReady: 2 } } });
  expect(low.out).toContain("planning: 1 task can start (#21), below 2");
});

test("plan mode has no ready issues and no planning line (#378)", () => {
  const r = workOf([DONE], {});
  expect(r.out).not.toContain("planning");
});

test("the dry run of the product owner loop shows the planning line (#378)", () => {
  const [, work, env] = poProject({ db: { issues: [ready(21)] }, cfg: ISSUES_MODE });
  const out = factory(work, env, ["product-owner", "loop", "--once", "--dry-run"]).stdout;
  expect(out).toContain("[eleni] work: planning: 1 task can start (#21), below 4");
});

test("the setting is documented and validated (#378)", () => {
  const [, work, env] = poProject({ cfg: ISSUES_MODE });
  const help = factory(work, env, ["settings", "help", "roles.product-owner.minReady"]);
  expect(help.code, help.out).toBe(0);
  expect(help.stdout).toContain("4");
  const bad = factory(work, env, ["settings", "set", "roles.product-owner.minReady", "-1"]);
  expect(bad.code).not.toBe(0);
});
