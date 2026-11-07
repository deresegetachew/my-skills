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

// #589: after a precondition's own button (Stop, Release #n) ran, the open dialog reads the agent again until the
// condition shows met, so the confirm turns on without closing and opening the dialog.
type Live = { name: string; state: string; task: string | null; here: boolean; machineName: string | null };
const menelik = (state: string, task: string | null = null): Live => ({ name: "menelik", state, task, here: true, machineName: null });

function fakeClock(): { sleep: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = [];
  return { waited, sleep: async (ms) => { waited.push(ms); } };
}

test("after its Stop button ran and the agents API then says down, the remove checklist shows it met without reopening", async () => {
  const { removeAgentAsk, removeFactsOf, recheckAgent, agentOfAnswer } = await mod();
  const live = menelik("working"); // the live push hasn't caught up yet
  const before = removeAgentAsk(removeFactsOf("coding-agent", live, null));
  expect(before.checks[0]).toMatchObject({ met: false, fix: "Stop menelik" });
  // what GET /api/projects/:p/agents/menelik answers, one read after another
  const answers: unknown[] = [{ project: "p", agent: menelik("working") }, { project: "p", agent: menelik("working") }, { project: "p", agent: menelik("down") }];
  let reads = 0;
  const shown: Live[] = [];
  const clock = fakeClock();
  const last = await recheckAgent({ read: async () => agentOfAnswer("menelik", answers[reads++]), done: "stop", seen: (a) => shown.push(a), sleep: clock.sleep });
  expect(reads).toBe(3);
  expect(clock.waited).toEqual([2000, 2000]);
  expect(last?.state).toBe("down");
  const after = removeAgentAsk(removeFactsOf("coding-agent", live, shown.at(-1) ?? null));
  expect(after.checks[0]).toMatchObject({ met: true });
  expect(after.checks[0]?.fix).toBeUndefined();
  expect(confirmState(after, "menelik").ready).toBe(true);
});

test("after its Release button ran, the checklist shows the task released once the agents API says so", async () => {
  const { removeAgentAsk, removeFactsOf, recheckAgent, agentOfAnswer } = await mod();
  const live = menelik("down", "12");
  const answers: unknown[] = [{ agent: menelik("down", "12") }, { agent: menelik("down", null) }];
  let reads = 0;
  let fresh: Live | null = null;
  const clock = fakeClock();
  await recheckAgent({ read: async () => agentOfAnswer("menelik", answers[reads++]), done: "release", seen: (a) => { fresh = a; }, sleep: clock.sleep });
  expect(reads).toBe(2);
  const after = removeAgentAsk(removeFactsOf("coding-agent", live, fresh));
  expect(after.checks.every((c) => c.met)).toBe(true);
  expect(confirmState(after, "menelik").ready).toBe(true);
});

test("the recheck reads every 2 s for at most 30 s, and stops when the dialog closes", async () => {
  const { recheckAgent } = await mod();
  let reads = 0;
  const clock = fakeClock();
  const last = await recheckAgent({ read: async () => { reads++; return menelik("working"); }, done: "stop", seen: () => {}, sleep: clock.sleep });
  expect(last?.state).toBe("working");
  expect(clock.waited.every((ms) => ms === 2000)).toBe(true);
  expect(clock.waited.reduce((a, b) => a + b, 0)).toBe(30_000);
  expect(reads).toBe(16);
  let closed = false;
  reads = 0;
  await recheckAgent({ read: async () => { reads++; closed = true; return menelik("working"); }, done: "stop", seen: () => {}, sleep: clock.sleep,
    gone: () => closed });
  expect(reads).toBe(1);
});

test("an answer the agents API gives: the agent, down when it isn't reported any more, nothing when the read failed", async () => {
  const { agentOfAnswer } = await mod();
  expect(agentOfAnswer("menelik", { agent: menelik("idle", "3") })).toEqual(menelik("idle", "3"));
  expect(agentOfAnswer("menelik", { code: "ui_agent_unknown", message: "menelik isn't reported in p.", fix: "x" }))
    .toMatchObject({ name: "menelik", state: "down", task: null });
  expect(agentOfAnswer("menelik", { code: "unreachable", message: "x", fix: "y" })).toBeNull();
  expect(agentOfAnswer("menelik", null)).toBeNull();
});

test("while the dialog waits to see it stopped, the check says so instead of offering Stop again", async () => {
  const { removeAgentAsk, removeFactsOf } = await mod();
  const s = removeAgentAsk({ ...removeFactsOf("coding-agent", menelik("working", "12"), null), checking: "stop" });
  expect(s.checks[0]).toMatchObject({ met: false, waiting: "Checking…" });
  expect(s.checks[0]?.fix).toBeUndefined();
  expect(s.checks[1]).toMatchObject({ fix: "Release #12" });
  // the live push and the fresh read: whichever shows it met wins
  expect(removeFactsOf("coding-agent", menelik("down"), menelik("working")).running).toBe(false);
  expect(removeFactsOf("coding-agent", undefined, null).running).toBe(false);
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

// --- Bring this machine up to date (#566) -----------------------------------------------------------------------------

const CHECKOUT = { path: "/home/o/code/work", main: "main", branch: "main" as string | null, behind: 2 as number | null, ahead: 0 as number | null,
  changed: [] as string[], onMain: true, clean: true, canUpdate: true, problem: null as { code: string; message: string; fix: string } | null };

test("how far this machine's checkout is from main, in words", async () => {
  const { checkoutText } = await mod();
  expect(checkoutText(CHECKOUT)).toBe("2 commits behind main");
  expect(checkoutText({ ...CHECKOUT, behind: 1 })).toBe("1 commit behind main");
  expect(checkoutText({ ...CHECKOUT, behind: 0, canUpdate: false })).toBe("Up to date with main");
  expect(checkoutText({ ...CHECKOUT, behind: null, canUpdate: false })).toBe("Unknown");
});

test("bringing this machine up to date: on main, clean, nothing of its own, something new; what moves and what doesn't", async () => {
  const { syncAsk } = await mod();
  const ok = syncAsk(CHECKOUT);
  expect(confirmState(ok, "").ready).toBe(true);
  expect(ok.action).toBe("Bring this machine up to date");
  expect(ok.happens).toContain("/home/o/code/work");
  expect(ok.happens).toContain("2 commits");
  expect(ok.doesNot).toContain("worktrees");
  const branch = syncAsk({ ...CHECKOUT, branch: "task/9-login", onMain: false, canUpdate: false,
    problem: { code: "checkout_not_on_main", message: "x", fix: "y" } });
  expect(confirmState(branch, "").ready).toBe(false);
  expect(confirmState(branch, "").unmet.map((c) => c.title)).toEqual(["It is on main"]);
  expect(String(branch.checks.find((c) => !c.met)?.sub)).toContain("task/9-login");
  const dirty = syncAsk({ ...CHECKOUT, clean: false, changed: ["README.md"], canUpdate: false, problem: { code: "checkout_dirty", message: "x", fix: "y" } });
  expect(confirmState(dirty, "").unmet.map((c) => c.title)).toEqual(["It has no uncommitted changes"]);
  expect(String(dirty.checks.find((c) => !c.met)?.sub)).toContain("README.md");
  const current = syncAsk({ ...CHECKOUT, behind: 0, canUpdate: false });
  expect(confirmState(current, "").unmet.map((c) => c.title)).toEqual(["Main on GitHub has something new"]);
  const offline = syncAsk({ ...CHECKOUT, branch: null, behind: null, ahead: null, onMain: false, clean: false, canUpdate: false,
    problem: { code: "checkout_fetch_failed", message: "Main can't be read from GitHub.", fix: "Check the network." } });
  expect(confirmState(offline, "").unmet.map((c) => c.sub)).toEqual(["Main can't be read from GitHub. Check the network."]);
  for (const s of [ok, branch, dirty, current, offline]) expect(words(s)).not.toMatch(/`|\bgit (fetch|merge|pull|stash|switch)\b|--[a-z]/);
});

test("the staged-change words say the merge brings this machine up to date, not that someone must pull", async () => {
  const { addAgentAsk } = await mod();
  const s = addAgentAsk("haile");
  expect(s.happens).not.toContain("pulled");
  expect(s.happens).toContain("up to date");
});
