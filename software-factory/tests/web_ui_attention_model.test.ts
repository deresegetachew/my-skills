// Needs attention on the page (#579), from web/attention_model.ts, web/nav_model.ts and web/board_model.ts as they are (no
// React): the "stuck" marks a card, an epic and an agent show, the dot and line of Home's list, what each action opens,
// the red count beside Home in the sidebar, an agent's stuck mark there, and what Close says in its confirm.
import { expect, test } from "bun:test";
import { type AttentionItem, actionOf, attentionDot, attentionLine, sayAsk, stuckMarks } from "../web/attention_model.ts";
import { taskAsk } from "../web/board_model.ts";
import { sidebar } from "../web/nav_model.ts";

const item = (kind: string, more: Partial<AttentionItem>): AttentionItem => ({ id: `${kind}:x`, kind, title: "t", reason: `${kind} reason`, task: null, agent: null,
  pr: null, epic: null, action: { kind: "open", label: "Open", link: "page:home" }, ...more });

const ITEMS: AttentionItem[] = [
  item("agent-down", { agent: "menelik", task: "7", reason: "menelik is down but holds #7.", action: { kind: "start", label: "Start menelik", agent: "menelik" } }),
  item("task-quiet", { task: "7", agent: "menelik", reason: "Held by menelik, which is down.", action: { kind: "release", label: "Release", task: "7" } }),
  item("task-pr-gone", { task: "8", pr: 21, reason: "PR #21 is no longer open.", action: { kind: "close", label: "Close", task: "8" } }),
  item("session-long", { agent: "fasil", reason: "Working for 82 minutes.", action: { kind: "open", label: "Open its output", link: "agent:fasil" } }),
  item("epic-done", { epic: "1", reason: "All 2 tasks are done.", action: { kind: "close", label: "Close the epic", task: "1" } }),
  item("pr-waiting", { pr: 22, task: "9", reason: "Nobody has reviewed it.", action: { kind: "open", label: "Open the PR", link: "pr:22" } }),
];

test("the marks: a task, an epic and an agent each carry their reason; a PR's wait marks no card", () => {
  expect(stuckMarks(ITEMS)).toEqual({
    tasks: { "7": "Held by menelik, which is down.", "8": "PR #21 is no longer open.", "1": "All 2 tasks are done." },
    agents: { menelik: "menelik is down but holds #7.", fasil: "Working for 82 minutes." },
  });
  expect(stuckMarks([])).toEqual({ tasks: {}, agents: {} });
});

test("Home's list: red for what is down, yellow for what is slow; a line that counts them", () => {
  expect(ITEMS.map(attentionDot)).toEqual(["red", "waiting", "red", "waiting", "waiting", "waiting"]);
  expect(attentionLine(ITEMS)).toBe("6 things are stuck or waiting too long.");
  expect(attentionLine(ITEMS.slice(0, 1))).toBe("1 thing is stuck or waiting too long.");
  expect(attentionLine([])).toBe("Nothing is stuck.");
});

test("each action: Release and Close open a task's confirm, Start an agent's, the rest open their page", () => {
  expect(ITEMS.map(actionOf)).toEqual([
    { do: "start", agent: "menelik" },
    { do: "task", action: "release", task: "7" },
    { do: "task", action: "close", task: "8" },
    { do: "open", link: "agent:fasil" },
    { do: "task", action: "close", task: "1" },
    { do: "open", link: "pr:22" },
  ]);
});

test("the sidebar: Home's count is red (it needs you), and a stuck agent's row says why", () => {
  const s = sidebar({ page: "board", team: [{ name: "menelik", role: "coding-agent", state: "down", detail: "down", stuck: "menelik is down but holds #7." },
    { name: "taytu", role: "coding-agent", state: "idle", detail: "idle" }], counts: { home: 3 } });
  expect(s.main.find((n) => n.page === "home")?.badge).toEqual({ count: 3, tone: "red" });
  expect(sidebar({ page: "home", team: [], counts: { home: 0 } }).main.find((n) => n.page === "home")?.badge).toBeNull();
  const menelik = s.team.find((t) => t.name === "menelik");
  expect(menelik?.stuck).toBe("menelik is down but holds #7.");
  expect(menelik?.title).toBe("menelik: down. Stuck: menelik is down but holds #7.");
  expect(s.team.find((t) => t.name === "taytu")?.stuck).toBeNull();
});

test("Close's confirm says the task is closed as done and what stays", () => {
  expect(taskAsk("close", { id: "7", holders: ["menelik"] })).toEqual({ happens: "#7 is closed as done. menelik's claim comes off.",
    doesNot: "A session already working on it isn't stopped. Its branch and pull request stay, and nothing is deleted." });
  expect(taskAsk("close", { id: "b3", holders: [] })).toEqual({ happens: "b3 is closed as done.", doesNot: "Its branch and pull request stay, and nothing is deleted." });
});

test("idle while a task is ready (#591): Start work opens the say confirm with /next-task; the agent carries the mark, yellow", () => {
  const idle = item("idle-ready", { agent: "taytu", task: "b32", reason: "taytu has been idle for 40 minutes while b32 Shelf is ready.",
    action: { kind: "say", label: "Start work", agent: "taytu", text: "/next-task" } });
  expect(actionOf(idle)).toEqual({ do: "say", agent: "taytu", text: "/next-task" });
  expect(attentionDot(idle)).toBe("waiting");
  expect(stuckMarks([idle])).toEqual({ tasks: {}, agents: { taytu: "taytu has been idle for 40 minutes while b32 Shelf is ready." } });
  expect(sayAsk("taytu", "/next-task")).toEqual({ happens: "/next-task is sent to taytu's session, as if typed there, and it looks for the next ready task.",
    doesNot: "Nothing is claimed for it here. If the same text is already typed in its prompt box, it is sent, not typed again." });
});
