// The artifacts page's words and shapes (#454), from web/artifacts_model.ts as it is (no React): a row per copy with its
// status and action, the head line, and the confirm for pulling a new copy. No command is shown on screen (the owner's
// rule), so none of these words may carry one. The module is imported inside each test.
import { expect, test } from "bun:test";
import type * as Model from "../web/artifacts_model.ts";
// (the module's row type is not named here: pullAsk takes the row as the API sends it, which `row()` builds)
import { confirmState } from "../web/parts_model.ts";

type Mod = typeof Model;
const mod = (): Promise<Mod> => import("../web/artifacts_model.ts");

interface Row {
  id: string; url: string; title: string; dest: string; pulledAt: string; pulledBy: string; state: string; detail: string;
  review: { number: number; url: string } | null;
}

function row(id: string, more: Partial<Row> = {}): Row {
  return { id, url: `https://claude.ai/artifact/${id}`, title: `Title ${id}`, dest: `docs/design/${id}`, pulledAt: "2026-11-01T09:00:00Z",
    pulledBy: "mentewab", state: "current", detail: "", review: null, ...more };
}

test("a row per copy: its name, where it is, and what its state says", async () => {
  const { rowsOf } = await mod();
  const rows = rowsOf([row("a", { state: "older" }), row("b"), row("c", { state: "unknown" }), row("d", { state: "edited" }),
    row("e", { state: "missing" }), row("f", { state: "older", review: { number: 9, url: "https://github.com/o/r/pull/9" } })]);
  expect(rows.map((r) => [r.id, r.status, r.action])).toEqual([
    ["a", { text: "Newer version", dot: "waiting" }, "Pull new copy"],
    ["b", { text: "Up to date", dot: "working" }, "Open"],
    ["c", { text: "Can't tell", dot: "idle" }, "Open"],
    ["d", { text: "Edited here", dot: "waiting" }, "Open"],
    ["e", { text: "Missing", dot: "down" }, "Pull again"],
    ["f", { text: "New copy in review", dot: "idle" }, "Open the PR"],
  ]);
  expect(rows[0]?.name).toBe("Title a");
  expect(rows[0]?.sub).toBe("docs/design/a · copied 1 Nov");
});

test("a copy without a title is named by its id, and a review wins over any state", async () => {
  const { rowsOf } = await mod();
  const rows = rowsOf([row("abc", { title: "", state: "missing", review: { number: 2, url: "u" } })]);
  expect(rows[0]?.name).toBe("abc");
  expect(rows[0]?.status).toEqual({ text: "New copy in review", dot: "idle" });
});

test("only the first copy that can be pulled again is the primary one", async () => {
  const { rowsOf } = await mod();
  const rows = rowsOf([row("a"), row("b", { state: "older" }), row("c", { state: "older" })]);
  expect(rows.map((r) => r.primary)).toEqual([false, true, false]);
  expect(rowsOf([row("a")]).map((r) => r.primary)).toEqual([false]);
});

test("the head line counts the copies with a newer version and no review", async () => {
  const { headLine } = await mod();
  const base = "The designs builders work from, kept as reviewed copies in the repo.";
  expect(headLine([row("a")])).toBe(base);
  expect(headLine([])).toBe(base);
  expect(headLine([row("a", { state: "older" })])).toBe(`${base} 1 has a newer version.`);
  expect(headLine([row("a", { state: "older" }), row("b", { state: "older" }), row("c")])).toBe(`${base} 2 have a newer version.`);
  expect(headLine([row("a", { state: "older", review: { number: 1, url: "u" } }), row("b", { state: "older" })])).toBe(`${base} 1 has a newer version.`);
});

test("the pull asks: fetch set up, no review open, copy not edited; the button turns on only when all are met", async () => {
  const { pullAsk } = await mod();
  const one = row("a", { state: "older" });
  const ok = pullAsk(one, true);
  expect(ok.title).toBe("Pull the new copy of Title a?");
  expect(ok.action).toBe("Pull the new copy");
  expect(ok.tone).toBe("primary");
  expect(ok.happens.toLowerCase()).toContain("pull request");
  expect(ok.doesNot.toLowerCase()).toContain("merge");
  expect(ok.checks.map((c) => [c.title, c.met])).toEqual(expect.arrayContaining([
    ["This machine can fetch the artifact", true], ["No new copy is in review", true], ["The copy here wasn't edited", true]]));
  expect(confirmState(ok, "").ready).toBe(true);

  const noFetch = pullAsk(one, false);
  const fetchCheck = noFetch.checks.find((c) => c.title === "This machine can fetch the artifact");
  expect(fetchCheck?.met).toBe(false);
  expect(fetchCheck?.sub ?? "").not.toBe("");
  expect(confirmState(noFetch, "").ready).toBe(false);
});

test("the pull ask is blocked by a review in progress and by a copy edited here", async () => {
  const { pullAsk } = await mod();
  const reviewed = row("a", { state: "older", review: { number: 3, url: "u" } });
  const a = pullAsk(reviewed, true);
  expect(a.checks.find((c) => c.title === "No new copy is in review")?.met).toBe(false);
  expect(confirmState(a, "").ready).toBe(false);
  const edited = row("b", { state: "edited" });
  const b = pullAsk(edited, true);
  expect(b.checks.find((c) => c.title === "The copy here wasn't edited")?.met).toBe(false);
  expect(confirmState(b, "").ready).toBe(false);
});

test("nothing on screen is a command, a flag or a setting key", async () => {
  const { headLine, pullAsk, rowsOf } = await mod();
  const rows = rowsOf([row("a", { state: "older" }), row("b", { state: "missing" }), row("c", { state: "edited" }),
    row("d", { review: { number: 1, url: "u" } })]);
  const text = JSON.stringify([rows, headLine([row("a", { state: "older" })]), pullAsk(row("a", { state: "older" }), false),
    pullAsk(row("a", { state: "older" }), true)]);
  expect(text).not.toMatch(/factory [a-z]/);
  expect(text).not.toContain("--");
  expect(text).not.toContain("artifacts.fetch");
  expect(text).not.toMatch(/artifacts\.[a-z]+/);
});
