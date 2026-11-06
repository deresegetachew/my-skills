// The web app's epic rules that aren't drawing (#440), from web/views_model.ts: the width of an epic's bar and the tasks
// grouped under their epics.
import { expect, test } from "bun:test";
import { epicBar, groupByEpic, type EpicRow, type TaskRow } from "../web/views_model.ts";

const task = (id: string, epic: string | null): TaskRow => ({ id, title: `Task ${id}`, state: "ready", stateText: "ready", holders: [], group: "",
  todos: { done: 0, all: 0 }, dependsOn: [], url: null, pr: null, next: false, find: `#${id}`, epic });
const epic = (id: string): EpicRow => ({ id, title: `Epic ${id}`, stage: "building", stageText: "building", done: 0, all: 0, tasks: [], prd: "",
  decisions: [], url: null, find: `#${id}` });

test("the bar is the percent done, rounded; no tasks is empty, all done is full", () => {
  expect(epicBar({ done: 0, all: 0 })).toBe(0);
  expect(epicBar({ done: 1, all: 3 })).toBe(33);
  expect(epicBar({ done: 2, all: 3 })).toBe(67);
  expect(epicBar({ done: 4, all: 4 })).toBe(100);
});

test("tasks are grouped under their epics in the epics' order, then the tasks in none; empty groups are left out", () => {
  const groups = groupByEpic([task("1", "B"), task("2", null), task("3", "A"), task("4", "B")], [epic("A"), epic("B"), epic("C")]);
  expect(groups.map((g) => [g.epic?.id ?? null, g.tasks.map((t) => t.id)])).toEqual([["A", ["3"]], ["B", ["1", "4"]], [null, ["2"]]]);
});

test("with no epic holding a task there is one group with no epic; with no tasks there are none", () => {
  expect(groupByEpic([task("1", null)], []).map((g) => [g.epic, g.tasks.length])).toEqual([[null, 1]]);
  expect(groupByEpic([], [epic("A")])).toEqual([]);
});
