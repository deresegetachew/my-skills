// The Team page's words and rules (#581), from web/team_model.ts as it is (no React): each role in one list with where
// it runs, its state and its task; the machines a new agent can be put on; and the confirms for adding, renaming,
// removing, starting past the limit and setting how many coding agents run at once, each saying what will and won't
// happen. No command is shown on screen (the owner's rule), so none of these words may carry one.
import { expect, test } from "bun:test";
import type * as Model from "../web/team_model.ts";
import { confirmState, startAgentAsk } from "../web/parts_model.ts";
import { addAgentAsk } from "../web/settings_model.ts";

const mod = (): Promise<typeof Model> => import("../web/team_model.ts");
const COMMAND = /`|\bfactory (settings|owner|machine|loop)\b|--[a-z]/;
const words = (x: unknown): string => JSON.stringify(x);

const TEAM = {
  agents: [{ name: "fasil", role: "dev-manager" }, { name: "mentewab", role: "product-owner" }, { name: "menelik", role: "coding-agent" },
    { name: "taytu", role: "coding-agent" }],
  next: { "coding-agent": ["menelik", "haile"], "dev-manager": ["fasil"], "product-owner": ["mentewab"] },
  former: { menelik: ["zewditu"] },
};
const live = (name: string, state: string, more: Partial<Model.TeamLive> = {}): Model.TeamLive =>
  ({ name, state, task: null, here: true, machineName: "dev-pc", ...more });

test("every role in one list: the product owner, the dev manager, then each coding agent, with where it runs, its state and task", async () => {
  const { teamRows } = await mod();
  const rows = teamRows({ team: TEAM, live: [live("menelik", "working", { task: "12" }), live("fasil", "idle", { here: false, machineName: "office-pc" })],
    machine: { agents: ["menelik", "taytu"], from: "machine", pending: { join: ["haile"], leave: [] } }, hereName: "dev-pc" });
  expect(rows.map((r) => [r.name, r.roleTitle])).toEqual([["mentewab", "Product owner"], ["fasil", "Dev manager"], ["menelik", "Coding agent"],
    ["taytu", "Coding agent"], ["haile", "Coding agent"]]);
  const by = (n: string): Model.TeamRowView => rows.find((r) => r.name === n) as Model.TeamRowView;
  expect(by("menelik")).toMatchObject({ machine: "dev-pc", running: true, task: "12", former: ["zewditu"], change: null });
  expect(by("fasil")).toMatchObject({ machine: "office-pc", running: true, here: false });
  expect(by("mentewab")).toMatchObject({ machine: "Not on this machine", running: false, stateText: "Not running" });
  expect(by("taytu")).toMatchObject({ machine: "dev-pc", change: "leaves" });
  expect(by("haile")).toMatchObject({ machine: "dev-pc, once merged", change: "joins", running: false });
});

test("where an agent runs: this machine when it runs every agent, else its list, else another machine", async () => {
  const { whereText } = await mod();
  const every = { agents: [], from: "project", pending: { join: [], leave: [] } };
  expect(whereText("taytu", undefined, every, "dev-pc")).toBe("dev-pc (it runs every agent)");
  expect(whereText("taytu", undefined, every, null)).toBe("This machine (it runs every agent)");
  expect(whereText("taytu", undefined, { ...every, agents: ["menelik"], from: "env" }, "dev-pc")).toBe("Not on this machine");
  expect(whereText("taytu", live("taytu", "down"), { ...every, agents: ["taytu"], from: "machine" }, "dev-pc")).toBe("dev-pc");
});

test("the machines a new agent can go on: this one first, then the others, then choose later", async () => {
  const { machineChoices } = await mod();
  expect(machineChoices([{ name: "office-pc", here: false }, { name: "dev-pc", here: true }])).toEqual([
    { id: "here", label: "This machine (dev-pc)" }, { id: "office-pc", label: "office-pc" }, { id: "later", label: "Choose later" }]);
  expect(machineChoices([])[0]).toEqual({ id: "here", label: "This machine" });
});

test("adding an agent says where it will run, and that nothing starts until it is merged", async () => {
  const here = addAgentAsk("haile", { machine: "here", label: "This machine (dev-pc)", ownList: true });
  expect(here.happens).toContain("dev-pc");
  expect(here.happens).toContain("once");
  const away = addAgentAsk("haile", { machine: "office-pc", label: "office-pc", ownList: true });
  expect(away.happens).toContain("office-pc");
  expect(away.doesNot).toContain("this machine");
  for (const s of [here, away]) {
    expect(s.doesNot).toContain("Nothing starts");
    expect(words(s)).not.toMatch(COMMAND);
  }
});

test("renaming: stopped, holding no task, a free name; history stays under the old name", async () => {
  const { renameAgentAsk } = await mod();
  const busy = renameAgentAsk({ name: "menelik", role: "coding-agent", running: true, here: true, machineName: null, task: "12" }, "haile", ["taytu"]);
  expect(busy.checks.map((c) => [c.met, c.fix ?? null])).toEqual([[false, "Stop menelik"], [false, "Release #12"], [true, null]]);
  expect(busy.checks[1]?.sub).toStartWith("Release its work first");
  expect(confirmState(busy, "").ready).toBe(false);
  const taken = renameAgentAsk({ name: "menelik", role: "coding-agent", running: false, here: true, machineName: null, task: null }, "taytu", ["taytu"]);
  expect(taken.checks[2]).toMatchObject({ met: false });
  const ok = renameAgentAsk({ name: "menelik", role: "coding-agent", running: false, here: true, machineName: null, task: null }, "haile", ["taytu"]);
  expect(confirmState(ok, "").ready).toBe(true);
  expect(ok.title).toBe("Rename menelik to haile?");
  expect(ok.happens).toContain("haile");
  expect(ok.doesNot).toContain("menelik");
  for (const s of [busy, taken, ok]) expect(words(s)).not.toMatch(COMMAND);
});

test("how many at once: the limit in words, and the confirm says what happens to agents already running", async () => {
  const { atOnceText, atOnceAsk } = await mod();
  expect(atOnceText(null, 2)).toBe("No limit · 2 running here now");
  expect(atOnceText(3, 1)).toBe("At most 3 · 1 running here now");
  const lower = atOnceAsk(1, ["menelik", "taytu"]);
  expect(lower.title).toBe("Run at most 1 coding agent at once here?");
  expect(lower.doesNot).toContain("menelik and taytu keep running");
  const none = atOnceAsk(null, []);
  expect(none.title).toBe("Remove the limit on this machine?");
  for (const s of [lower, none]) {
    expect(confirmState(s, "").ready).toBe(true);
    expect(words(s)).not.toMatch(COMMAND);
  }
});

test("Start says when this machine already runs as many coding agents as it may", async () => {
  const full = startAgentAsk({ name: "haile", here: true, state: "down", machineName: null, task: null, atOnce: { max: 2, running: ["menelik", "taytu"] } });
  expect(full.checks.at(-1)).toMatchObject({ met: false, sub: expect.stringContaining("menelik and taytu") });
  expect(confirmState(full, "").ready).toBe(false);
  const room = startAgentAsk({ name: "haile", here: true, state: "down", machineName: null, task: null, atOnce: { max: 3, running: ["menelik"] } });
  expect(confirmState(room, "").ready).toBe(true);
  expect(startAgentAsk({ name: "haile", here: true, state: "down", machineName: null, task: null }).checks).toHaveLength(1);
});

test("the coding agents running on this machine", async () => {
  const { codingHere } = await mod();
  expect(codingHere(TEAM.agents, [live("menelik", "working"), live("taytu", "down"), live("fasil", "idle"), live("haile", "idle", { here: false })]))
    .toEqual(["menelik"]);
});
