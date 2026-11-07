// The web app's few rules that aren't the API's (#421, #422): the search across channels, the words and tone of an
// agent's state, and the address of a channel in the page's hash. web/model.ts holds them, with no React in it.
import { expect, test } from "bun:test";
import { agentState, channelHash, parseHash, pickProject, type ProjectView, searchChannels, splitTask, taskChannel } from "../web/model.ts";

const PROJECTS: ProjectView[] = [
  { id: "work", name: "work", channels: [
    { id: "agent:menelik", kind: "agent", name: "menelik", role: "coding-agent", title: "menelik" },
    { id: "agent:fasil", kind: "agent", name: "fasil", role: "dev-manager", title: "fasil" },
    { id: "view:pull-requests", kind: "view", name: "pull-requests", title: "Pull requests" },
    { id: "view:machines", kind: "view", name: "machines", title: "Machines" },
  ] },
  { id: "shop", name: "shop", channels: [{ id: "agent:haile", kind: "agent", name: "haile", role: "coding-agent", title: "haile" }] },
];

test("search matches every word, in any case, across projects, names, roles and titles", () => {
  expect(searchChannels(PROJECTS, "").length).toBe(0);
  expect(searchChannels(PROJECTS, "MEN").map((h) => `${h.project}/${h.channel.name}`)).toEqual(["work/menelik"]);
  expect(searchChannels(PROJECTS, "coding").map((h) => h.channel.name)).toEqual(["menelik", "haile"]);
  expect(searchChannels(PROJECTS, "shop coding").map((h) => h.channel.name)).toEqual(["haile"]);
  expect(searchChannels(PROJECTS, "dev manager").map((h) => h.channel.name)).toEqual(["fasil"]);
  expect(searchChannels(PROJECTS, "pull").map((h) => h.channel.id)).toEqual(["view:pull-requests"]);
  expect(searchChannels(PROJECTS, "nothing-like-it")).toEqual([]);
});

test("search takes live words too: the state of an agent", () => {
  const live = { work: { menelik: "working on #7", fasil: "idle" } };
  expect(searchChannels(PROJECTS, "#7", live).map((h) => h.channel.name)).toEqual(["menelik"]);
  expect(searchChannels(PROJECTS, "idle", live).map((h) => h.channel.name)).toEqual(["fasil"]);
});

test("an agent's state reads as words with a tone", () => {
  expect(agentState({ state: "working", detail: "working on #7" }, null)).toEqual({ text: "working on #7", tone: "good" });
  expect(agentState({ state: "waiting", detail: "waiting for CI" }, null)).toEqual({ text: "waiting for CI", tone: "warn" });
  expect(agentState({ state: "idle", detail: "idle" }, null)).toEqual({ text: "idle", tone: "quiet" });
  expect(agentState({ state: "down", detail: "down" }, null)).toEqual({ text: "down", tone: "bad" });
  expect(agentState({ state: "unknown", detail: "" }, null)).toEqual({ text: "unknown", tone: "quiet" });
  expect(agentState(undefined, null)).toEqual({ text: "not reported", tone: "quiet" });
  const limit = { reset: Date.UTC(2026, 10, 5, 14, 30) / 1000, message: "GitHub's hourly limit is used up." };
  expect(agentState({ state: "working", detail: "working on #7" }, limit)).toEqual({ text: "waiting on the GitHub limit (back at 14:30 UTC)", tone: "warn" });
  expect(agentState({ state: "down", detail: "down" }, limit)).toEqual({ text: "down", tone: "bad" });
});

test("a channel's address in the hash, and back", () => {
  expect(channelHash("work", "agent:menelik")).toBe("#/work/agent:menelik");
  expect(parseHash("#/work/agent:menelik")).toEqual({ project: "work", channel: "agent:menelik" });
  expect(parseHash("#/my%20proj/view:ci")).toEqual({ project: "my proj", channel: "view:ci" });
  expect(channelHash("my proj", "view:ci")).toBe("#/my%20proj/view:ci");
  expect(parseHash("")).toBeNull();
  expect(parseHash("#/only")).toBeNull();
});

test("a task opened on the board has its own address, so it can be shared and Back closes it (#543)", () => {
  const hash = channelHash("work", taskChannel("view:tasks", "b3"));
  expect(hash).toBe("#/work/view:tasks/task:b3");
  const r = parseHash(hash);
  expect(r).toEqual({ project: "work", channel: "view:tasks/task:b3" });
  expect(splitTask(r?.channel ?? "")).toEqual({ channel: "view:tasks", task: "b3" });
  expect(splitTask("view:tasks/task:12")).toEqual({ channel: "view:tasks", task: "12" });
  expect(splitTask("view:tasks")).toEqual({ channel: "view:tasks", task: null });
  expect(splitTask("view:tasks/task:../x")).toEqual({ channel: "view:tasks/task:../x", task: null }); // not a task id
});

test("with no project in the address the page opens the one last opened here, else the first (#545)", () => {
  const ps = [{ id: "factory-home" }, { id: "factory-sandbox" }, { id: "shop" }];
  expect(pickProject(ps, "shop", "factory-sandbox")?.id).toBe("shop"); // the address wins
  expect(pickProject(ps, null, "factory-sandbox")?.id).toBe("factory-sandbox");
  expect(pickProject(ps, undefined, "gone")?.id).toBe("factory-home"); // a project no longer listed: the first
  expect(pickProject(ps, "gone", null)?.id).toBe("factory-home");
  expect(pickProject([], null, null)).toBeUndefined();
});
