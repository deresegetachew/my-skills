// The task board's rules that aren't drawing (#439): its columns, and its lanes by agent or by epic, from
// web/board_model.ts, which has no React in it.
import { expect, test } from "bun:test";
import { blockersText, boardOf, cardTag, COLUMNS, columnsOf, epicColour, taskAsk } from "../web/board_model.ts";
import { filterRows, type TaskRow } from "../web/views_model.ts";

const task = (id: string, state: string, holders: string[] = [], group = "", title = `Task ${id}`): TaskRow => ({ id, title, state,
  stateText: state, holders, group, todos: { done: 0, all: 0 }, dependsOn: [], url: null, pr: null, next: false, actions: [], epic: null,
  find:`#${id} ${title} ${state} ${holders.join(" ")} ${group}` });

test("the columns are ready, in progress, in review, blocked and done", () => {
  expect(COLUMNS).toEqual([{ state: "ready", title: "Ready" }, { state: "in-progress", title: "In progress" },
    { state: "in-review", title: "In review" }, { state: "blocked", title: "Blocked" }, { state: "done", title: "Done" }]);
});

test("a Not ready column comes first only when some task is new", () => {
  expect(columnsOf([task("1", "ready")])).toEqual(COLUMNS);
  expect(columnsOf([])).toEqual(COLUMNS);
  expect(columnsOf([task("1", "ready"), task("2", "new")])).toEqual([{ state: "new", title: "Not ready" }, ...COLUMNS]);
});

test("by agent: one lane per first holder sorted by name, with unheld tasks in a last Nobody lane", () => {
  const tasks = [task("1", "ready"), task("2", "in-progress", ["taytu"]), task("3", "in-progress", ["menelik"]),
    task("4", "done", ["taytu"]), task("5", "blocked"), task("6", "in-progress", ["taytu"])];
  const lanes = boardOf(tasks, "agent");
  expect(lanes.map((l) => [l.key, l.title, l.count])).toEqual([["menelik", "menelik", 1], ["taytu", "taytu", 3], ["", "Nobody", 2]]);
  const taytu = lanes[1]!;
  expect(taytu.cells["in-progress"]!.map((t) => t.id)).toEqual(["2", "6"]);
  expect(taytu.cells.done!.map((t) => t.id)).toEqual(["4"]);
  for (const c of COLUMNS) expect(Array.isArray(taytu.cells[c.state]), c.state).toBe(true);
  expect(taytu.cells.ready).toEqual([]);
  expect(lanes[2]!.cells.ready!.map((t) => t.id)).toEqual(["1"]);
  expect(lanes[2]!.cells.blocked!.map((t) => t.id)).toEqual(["5"]);
});

test("by agent: a task with two holders is in its first holder's lane only", () => {
  const lanes = boardOf([task("1", "in-progress", ["taytu", "menelik"])], "agent");
  expect(lanes.map((l) => l.key)).toEqual(["taytu"]);
  expect(lanes[0]!.count).toBe(1);
});

test("by epic: one lane per group in the order they first appear, with no-epic tasks in a last lane", () => {
  const tasks = [task("1", "ready", [], "Phase 2"), task("2", "ready", [], ""), task("3", "done", [], "Phase 1"),
    task("4", "ready", [], "Phase 2"), task("5", "blocked", [], "")];
  const lanes = boardOf(tasks, "epic");
  expect(lanes.map((l) => [l.key, l.title, l.count])).toEqual([["Phase 2", "Phase 2", 2], ["Phase 1", "Phase 1", 1], ["", "No epic", 2]]);
  expect(lanes[0]!.cells.ready!.map((t) => t.id)).toEqual(["1", "4"]);
  expect(lanes[2]!.cells.blocked!.map((t) => t.id)).toEqual(["5"]);
});

test("a lane with no tasks isn't returned: no tasks, no lanes; no unheld task, no Nobody lane", () => {
  expect(boardOf([], "agent")).toEqual([]);
  expect(boardOf([], "epic")).toEqual([]);
  expect(boardOf([task("1", "ready", ["taytu"], "P")], "agent").map((l) => l.key)).toEqual(["taytu"]);
  expect(boardOf([task("1", "ready", ["taytu"], "P")], "epic").map((l) => l.key)).toEqual(["P"]);
});

test("filtering before the board keeps only the lanes of the cards that match", () => {
  const tasks = [task("1", "in-progress", ["menelik"], "", "Add the login page"), task("2", "in-progress", ["taytu"], "", "Export to CSV")];
  const lanes = boardOf(filterRows(tasks, "login"), "agent");
  expect(lanes.map((l) => l.key)).toEqual(["menelik"]);
  expect(lanes[0]!.cells["in-progress"]!.map((t) => t.id)).toEqual(["1"]);
});

test("by epic: a task an epic lists (#440) is in that epic's lane, in the epics' order, before the milestone lanes and No epic", () => {
  const epics = [{ id: "420", title: "Web UI" }, { id: "440", title: "Epics above tasks" }];
  const inEpic = (id: string, epic: string | null, group = ""): TaskRow => ({ ...task(id, "ready", [], group), epic });
  const tasks = [inEpic("1", null, "Phase 1"), inEpic("2", "440"), inEpic("3", "420", "Phase 1"), inEpic("4", null), inEpic("5", "420"),
    inEpic("6", "999", "Phase 2")];
  const lanes = boardOf(tasks, "epic", epics);
  expect(lanes.map((l) => [l.key, l.title, l.count])).toEqual([["#420", "#420 Web UI", 2], ["#440", "#440 Epics above tasks", 1],
    ["Phase 1", "Phase 1", 1], ["Phase 2", "Phase 2", 1], ["", "No epic", 1]]);
  expect(lanes[0]!.cells.ready!.map((t) => t.id)).toEqual(["3", "5"]);
  // an epic the epics list doesn't know (#6 names #999) falls back to the task's milestone
  expect(lanes[3]!.cells.ready!.map((t) => t.id)).toEqual(["6"]);
});

test("a card's tag: Needs you when its PR waits for the owner, Checks failing when its PR is red, else its state", () => {
  const withPr = (state: string): TaskRow => ({ ...task("7", "in-review"), stateText: "in review",
    pr: { number: 21, url: null, checks: { state, failing: [] } } });
  expect(cardTag(withPr("green"), { next: { action: "owner-merges" } })).toEqual({ text: "Needs you", needsYou: true });
  expect(cardTag(withPr("red"), { next: { action: "waiting-for-agent" } })).toEqual({ text: "Checks failing", needsYou: false });
  expect(cardTag(withPr("green"), { next: { action: "dev-manager-reviews" } })).toEqual({ text: "in review", needsYou: false });
  expect(cardTag({ ...task("8", "ready"), stateText: "ready" })).toEqual({ text: "ready", needsYou: false });
});

test("each epic's chip takes a category colour in the epics' order, violet, pink, green, blue, then round again", () => {
  expect([0, 1, 2, 3, 4, 5].map(epicColour)).toEqual(["violet", "pink", "green", "blue", "yellow", "violet"]);
});

test("an action's confirm says what happens and what doesn't, and that a working session isn't stopped", () => {
  const held = { id: "7", holders: ["haile"] };
  const free = { id: "8", holders: [] };
  expect(taskAsk("release", held)).toEqual({ happens: "#7 goes back to Ready and the next free agent takes it. haile's claim comes off.",
    doesNot: "A session already working on it isn't stopped. Its branch and pull request stay." });
  expect(taskAsk("release", free)).toEqual({ happens: "#8 goes back to Ready and the next free agent takes it.", doesNot: "Its branch and pull request stay." });
  expect(taskAsk("block", free)).toEqual({ happens: "#8 moves to Blocked with your reason.", doesNot: "Nothing is deleted: Release puts it back to Ready." });
  expect(taskAsk("reassign", held, "taytu")).toEqual({ happens: "#7 goes back to Ready, then taytu is told to take it. haile's claim comes off.",
    doesNot: "A session already working on it isn't stopped. haile's branch stays." });
  expect(taskAsk("reassign", free).happens).toBe("#8 goes back to Ready, then the agent you pick is told to take it.");
});

test("a card's blockers are listed in words, and a card with none says nothing (#498)", () => {
  expect(blockersText({ blockedBy: ["11", "12"] })).toBe("Blocked by #11, #12");
  expect(blockersText({ blockedBy: [] })).toBe("");
  expect(blockersText({})).toBe("");
});
