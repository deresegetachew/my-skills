// The task board's rules that aren't drawing (#439): its columns, and its lanes by agent or by epic, from
// web/board_model.ts, which has no React in it.
import { expect, test } from "bun:test";
import { boardOf, COLUMNS, columnsOf } from "../web/board_model.ts";
import { filterRows, type TaskRow } from "../web/views_model.ts";

const task = (id: string, state: string, holders: string[] = [], group = "", title = `Task ${id}`): TaskRow => ({ id, title, state,
  stateText: state, holders, group, todos: { done: 0, all: 0 }, dependsOn: [], url: null, pr: null, next: false, actions: [],
  find: `#${id} ${title} ${state} ${holders.join(" ")} ${group}` });

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
