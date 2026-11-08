// The web app's search within the tasks, pull requests and CI channels and across them (#424, matching #392: every
// word typed is in the row's text, in any case), from web/views_model.ts, which has no React in it.
import { expect, test } from "bun:test";
import { ageNow, checksText, filterRows, originText, searchRows, type ViewsData } from "../web/views_model.ts";

const task = (id: string, title: string, find: string) => ({ id, title, state: "ready", stateText: "ready", holders: [], group: "",
  todos: { done: 0, all: 0 }, dependsOn: [], url: null, pr: null, next: false, epic: null, find });

function views(): ViewsData {
  return {
    generatedAt: null, age: null, refreshing: false, problems: [],
    tasks: { source: "issues", next: null, problems: [], tasks: [task("7", "Add the login page", "#7 Add the login page in progress menelik Phase 1"),
      task("10", "Export to CSV", "#10 Export to CSV ready — Phase 1")] },
    epics: { source: "issues", epics: [], problems: [] },
    pulls: { problems: [], pulls: [{ number: 21, title: "Add the login page", url: null, branch: "task/7-login", draft: false, agent: "menelik",
      task: "7", checks: { state: "red", failing: ["test"] }, review: { state: "changes-asked", text: "changes asked", claim: null }, protected: null,
      next: { action: "waiting-for-agent", text: "waiting for agent" }, rework: null, find: "#21 Add the login page task/7-login menelik" }] },
    ci: { verdict: null, mode: "local", repo: "o/work", label: "", waiting: [], host: "m-here", settings: { heavy: null }, actions: [], problems: [],
      runs: [{ id: 9300, ref: "#21", branch: "task/7-login", state: "failure", name: "CI", minutesAgo: 30, failed: true, url: null,
        find: "CI on task/7-login · failure · #21" }],
      runners: [{ name: "work-ci-m-here-1", lane: "heavy", machine: "m-here", here: true, state: "busy", find: "runner work-ci-m-here-1 · online m-here heavy" }] },
  };
}

test("the filter in a view keeps the rows that hold every word, in any case; nothing typed keeps them all", () => {
  const rows = views().tasks.tasks;
  expect(filterRows(rows, "").map((t) => t.id)).toEqual(["7", "10"]);
  expect(filterRows(rows, "LOGIN menelik").map((t) => t.id)).toEqual(["7"]);
  expect(filterRows(rows, "phase csv").map((t) => t.id)).toEqual(["10"]);
  expect(filterRows(rows, "login csv")).toEqual([]);
});

test("the search across views finds tasks, pull requests, runs and runners in every project, each opening its channel on the row", () => {
  const v = { work: views(), shop: views() };
  const projects = [{ id: "work", name: "work" }, { id: "shop", name: "shop" }];
  expect(searchRows(projects, v, "")).toEqual([]);
  const login = searchRows(projects, v, "login");
  expect(login.filter((h) => h.project === "work").map((h) => [h.channel, h.find])).toEqual([
    ["view:tasks", "#7"], ["view:pull-requests", "#21"], ["view:ci", "CI on task/7-login"]]);
  expect(login.filter((h) => h.project === "shop")).toHaveLength(3);
  expect(searchRows(projects, v, "runner m-here").map((h) => h.find)).toEqual(["work-ci-m-here-1", "work-ci-m-here-1"]);
  expect(searchRows(projects, { work: views() }, "login", 2)).toHaveLength(2);
});

test("checks say which jobs fail", () => {
  expect(checksText({ state: "red", failing: ["test", "lint"] })).toBe("failing: test, lint");
  expect(checksText({ state: "none", failing: [] })).toBe("no runs yet");
  expect(checksText({ state: "green", failing: [] })).toBe("green");
});

test("the tasks say where they come from (#498): the message board, live, or GitHub, read every so often, in plain words", () => {
  expect(originText({ from: "board", every: null })).toBe("From the message board, live");
  expect(originText({ from: "github", every: 300 })).toBe("From GitHub, read every 5 min");
  expect(originText({ from: "github", every: 45 })).toBe("From GitHub, read every 45 s");
  expect(originText({ from: "github", every: 7200 })).toBe("From GitHub, read every 2 h");
  expect(originText({})).toBe(""); // an older server says nothing
  expect(originText({ from: "unknown", every: null })).toBe(""); // the board is the record and down: one notice says so (#515)
});

test("the views' age counts on from when the page got them, since the server no longer resends them as they age (#529)", () => {
  const at = 1_000_000;
  expect(ageNow({ age: 30, receivedAt: at }, at)).toBe(30);
  expect(ageNow({ age: 30, receivedAt: at }, at + 90_000)).toBe(120);
  expect(ageNow({ age: 30, receivedAt: at }, at - 5_000), "a clock that went back adds nothing").toBe(30);
  expect(ageNow({ age: 30 }, at), "no stamp: the age as sent").toBe(30);
  expect(ageNow({ age: null, receivedAt: at }, at + 90_000), "no snapshot stays none").toBeNull();
});
