// The epic rules (#440): a stage from a label, the tasks named by the checkbox lines of the body, the PRD and decision
// lines, and progress. A pure module (hooks/core/domain/epic.ts), so the tests give it text and read what comes back.
import { expect, test } from "bun:test";
import { EPIC_STAGES, type Epic, parseEpic, progress } from "../hooks/core/domain/epic.ts";

function parse(more: Partial<{ number: number; title: string; body: string; labels: string[]; closed: boolean; open: string[] }> = {}): Epic {
  return parseEpic({ number: more.number ?? 40, title: more.title ?? "Search", body: more.body ?? "", labels: more.labels ?? ["epic"],
    closed: more.closed ?? false, openIds: new Set(more.open ?? []) });
}

test("the stages, in the order an epic moves through them", () => {
  expect(EPIC_STAGES).toEqual(["investigating", "prd", "decision", "planned", "building", "done", "parked"]);
});

test("the id is the issue number and the title is kept; the url is left for the adapter", () => {
  const e = parse({ number: 41, title: "Billing" });
  expect(e).toMatchObject({ id: "41", title: "Billing", url: null });
});

test("the stage comes from the epic:<stage> label; every stage is read", () => {
  for (const s of EPIC_STAGES.filter((x) => x !== "done")) expect(parse({ labels: ["epic", `epic:${s}`] }).stage).toBe(s);
  expect(parse({ labels: ["epic", "epic:building"] }).stage).toBe("building");
});

test("no stage label, or one that is not a stage, is investigating", () => {
  expect(parse({ labels: ["epic"] }).stage).toBe("investigating");
  expect(parse({ labels: ["epic", "epic:dreaming"] }).stage).toBe("investigating");
});

test("a closed epic is done whatever its label says", () => {
  expect(parse({ labels: ["epic", "epic:building"], closed: true }).stage).toBe("done");
  expect(parse({ labels: ["epic"], closed: true }).stage).toBe("done");
});

test("tasks are the checkbox lines that name an issue; ticked, or no longer open, is done", () => {
  const body = ["Why we want it.", "- [ ] #12 Index the catalogue", "- [x] #13", "- [ ] #14 Search box", "- [X] #15 Facets"].join("\n");
  const e = parse({ body, open: ["12", "14"] });
  expect(e.tasks).toEqual([{ id: "12", done: false }, { id: "13", done: true }, { id: "14", done: false }, { id: "15", done: true }]);
});

test("an unticked task whose issue is closed or gone is done", () => {
  const e = parse({ body: "- [ ] #20 Built and merged\n- [ ] #21 Still open", open: ["21"] });
  expect(e.tasks).toEqual([{ id: "20", done: true }, { id: "21", done: false }]);
});

test("a ticked task whose issue is still open is done: the box wins", () => {
  expect(parse({ body: "- [x] #30 ticked by hand", open: ["30"] }).tasks).toEqual([{ id: "30", done: true }]);
});

test("lines without an issue number, and ordinary lists, are not tasks", () => {
  const e = parse({ body: "- [ ] write the docs\n- #12 not a checkbox\nsee #13 in text\n- [ ] #14 real", open: ["14"] });
  expect(e.tasks).toEqual([{ id: "14", done: false }]);
});

test("an issue named twice is one task", () => {
  const e = parse({ body: "- [ ] #12 once\n- [x] #12 again", open: ["12"] });
  expect(e.tasks).toHaveLength(1);
  expect(e.tasks[0]?.id).toBe("12");
});

test("a PRD: line gives the prd, trimmed; none gives an empty text", () => {
  expect(parse({ body: "PRD:   docs/prd/search.md  \n- [ ] #1" }).prd).toBe("docs/prd/search.md");
  expect(parse({ body: "nothing here" }).prd).toBe("");
});

test("a Decisions: line gives the decisions, split on commas and trimmed", () => {
  expect(parse({ body: "Decisions: 0003, 0004" }).decisions).toEqual(["0003", "0004"]);
  expect(parse({ body: "Decisions: #12" }).decisions).toEqual(["#12"]);
  expect(parse({ body: "Decisions: 0003,, 0004 ," }).decisions).toEqual(["0003", "0004"]);
  expect(parse({ body: "no decisions line" }).decisions).toEqual([]);
});

test("progress counts the tasks done and all of them; an epic with none is 0 of 0", () => {
  const e = parse({ body: "- [x] #1\n- [ ] #2\n- [ ] #3", open: ["2", "3"] });
  expect(progress(e)).toEqual({ done: 1, all: 3 });
  expect(progress(parse({ body: "" }))).toEqual({ done: 0, all: 0 });
});
