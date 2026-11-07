// The Factory settings pages' words and rules (#456), from web/settings_model.ts as it is (no React): where a value
// comes from, a value in words, an agent's name checked, and the confirms for adding and removing an agent, proposing
// the staged changes, updating the factory and each clean-up, each with its preconditions and what will and won't
// happen. No command is shown on screen (the owner's rule), so none of these words may carry one.
import { expect, test } from "bun:test";
import type * as Model from "../web/settings_model.ts";
import { confirmState } from "../web/parts_model.ts";

const mod = (): Promise<typeof Model> => import("../web/settings_model.ts");

const COMMAND = /`|\bfactory (settings|update|clean|ci|reset-run|owner|version|machine)\b|--[a-z]/;

function words(x: unknown): string {
  return JSON.stringify(x);
}

test("where a value comes from, in plain words", async () => {
  const { fromText } = await mod();
  expect(fromText({ from: "main", staged: null, value: "x" })).toBe("From main");
  expect(fromText({ from: "default", staged: null, value: "x" })).toBe("Default");
  expect(fromText({ from: "machine", staged: null, value: "x" })).toBe("This machine only");
  expect(fromText({ from: "staged", staged: { value: 12 }, value: 24 })).toBe("Staged, was 24");
  expect(fromText({ from: "staged", staged: { unset: true }, value: 24 })).toBe("Staged: back to the default");
});

test("a value in words: on and off, lists, empty text", async () => {
  const { valueText } = await mod();
  expect(valueText(true)).toBe("On");
  expect(valueText(false)).toBe("Off");
  expect(valueText(["a", "b"])).toBe("a, b");
  expect(valueText([])).toBe("None");
  expect(valueText("")).toBe("Empty");
  expect(valueText(12)).toBe("12");
  expect(valueText({ A: "1" })).toBe('{"A":"1"}');
});

test("what a person types becomes the text the setting takes", async () => {
  const { rawOf } = await mod();
  expect(rawOf("bool", true)).toBe("true");
  expect(rawOf("int", "12")).toBe("12");
  expect(rawOf("list", '["a"]')).toBe('["a"]');
  expect(rawOf("str", "bun test")).toBe("bun test");
});

test("an agent's name: lowercase letters, digits and dashes, and not taken", async () => {
  const { nameProblem } = await mod();
  expect(nameProblem("haile", ["menelik"])).toBeNull();
  expect(nameProblem("agent-7", [])).toBeNull();
  for (const bad of ["Haile", "ha ile", "-x", "", "a".repeat(41), "ha_ile"]) expect(nameProblem(bad, []), bad).not.toBeNull();
  expect(nameProblem("menelik", ["menelik"])).toContain("already");
});

test("the free names are the legends no agent uses yet, in their order", async () => {
  const { freeNames } = await mod();
  expect(freeNames(["menelik", "taytu", "haile", "tewodros"], ["taytu", "fasil"])).toEqual(["menelik", "haile", "tewodros"]);
});

test("adding an agent says it is staged and starts nothing", async () => {
  const { addAgentAsk } = await mod();
  const s = addAgentAsk("haile");
  expect(s.checks).toEqual([]);
  expect(s.action).toBe("Stage haile");
  expect(s.happens).toContain("pull request");
  expect(s.doesNot).toContain("Nothing starts");
  expect(confirmState(s, "").ready).toBe(true);
  expect(words(s)).not.toMatch(COMMAND);
});

test("removing an agent: it must be stopped and hold no task, each with its own fix", async () => {
  const { removeAgentAsk } = await mod();
  const busy = removeAgentAsk({ name: "menelik", role: "coding-agent", running: true, here: true, machineName: null, task: "12" });
  expect(busy.checks.map((c) => [c.met, c.fix ?? null])).toEqual([[false, "Stop menelik"], [false, "Release #12"]]);
  expect(confirmState(busy, "").ready).toBe(false);
  const away = removeAgentAsk({ name: "menelik", role: "coding-agent", running: true, here: false, machineName: "dev-pc", task: null });
  expect(away.checks[0]).toMatchObject({ met: false, sub: expect.stringContaining("dev-pc") });
  expect(away.checks[0]?.fix).toBeUndefined();
  const free = removeAgentAsk({ name: "taytu", role: "coding-agent", running: false, here: true, machineName: null, task: null });
  expect(free.checks.every((c) => c.met)).toBe(true);
  expect(free.typeName).toBe("taytu");
  expect(confirmState(free, "taytu").ready).toBe(true);
  expect(free.happens).toContain("staged");
  expect(free.doesNot).toContain("branches");
  for (const s of [busy, away, free]) expect(words(s)).not.toMatch(COMMAND);
});

test("proposing the staged changes: one pull request that the owner merges", async () => {
  const { proposeAsk } = await mod();
  const s = proposeAsk(3);
  expect(s.title).toBe("Propose 3 changes?");
  expect(s.happens).toContain("one pull request");
  expect(proposeAsk(1).title).toBe("Propose 1 change?");
  expect(words(s)).not.toMatch(COMMAND);
});

test("updating: on releases, a newer one, no uncommitted changes and no agent working here", async () => {
  const { updateAsk } = await mod();
  const ok = updateAsk({ installed: "v1.2.0", newest: "v1.3.0", newer: true, pinned: "v1.2.0", dirty: false, working: [] });
  expect(ok.checks.every((c) => c.met)).toBe(true);
  expect(ok.action).toBe("Update to v1.3.0");
  const not = updateAsk({ installed: null, newest: "v1.3.0", newer: false, pinned: null, dirty: true, working: ["menelik"] });
  expect(not.checks.filter((c) => !c.met).length).toBe(4);
  expect(not.checks.find((c) => c.title.includes("menelik"))).toBeUndefined(); // the names are under the title
  expect(words(not)).toContain("menelik");
  expect(ok.doesNot).toContain("publish");
  for (const s of [ok, not]) expect(words(s)).not.toMatch(COMMAND);
});

test("each clean-up says what it will and won't touch, and asks first", async () => {
  const { MAINTENANCE, maintenanceAsk } = await mod();
  expect(MAINTENANCE.map((m) => m.id)).toEqual(["clean", "ci-clean", "reset-run"]);
  for (const m of MAINTENANCE) {
    expect(m.will).not.toBe("");
    expect(m.wont).not.toBe("");
    const s = maintenanceAsk(m);
    expect(s.happens).toBe(m.will);
    expect(s.doesNot).toBe(m.wont);
    expect(words(m)).not.toMatch(COMMAND);
  }
  expect(MAINTENANCE.find((m) => m.id === "clean")?.preview).toBe(false);
  expect(MAINTENANCE.find((m) => m.id === "ci-clean")?.preview).toBe(true);
});

test("search finds a setting by its name, its help or its key", async () => {
  const { searchSettings } = await mod();
  const rows = [{ key: "commands.test", name: "Test command", help: "The full test command." },
    { key: "mainBranch", name: "Main branch", help: "The main branch." }];
  expect(searchSettings(rows, "test").map((r) => r.key)).toEqual(["commands.test"]);
  expect(searchSettings(rows, "MAINBRANCH").map((r) => r.key)).toEqual(["mainBranch"]);
  expect(searchSettings(rows, "").length).toBe(2);
});

test("where this machine's agents come from", async () => {
  const { machineAgentsText } = await mod();
  expect(machineAgentsText({ agents: ["menelik"], from: "machine" })).toBe("menelik, saved for this machine");
  expect(machineAgentsText({ agents: ["taytu"], from: "env" })).toContain("this terminal");
  expect(machineAgentsText({ agents: [], from: "project" })).toBe("Every agent of the project (none chosen for this machine)");
});
