// The pull request page's words and asks (#453), from web/pr_model.ts as it is (no React): the line under the title, the
// status, each check's and file's words, the diff's lines, and what Merge, Mark ready, Ask for changes, Comment and Close
// ask first. The address `pr:<n>` belongs to the Pull requests page in the sidebar (web/nav_model.ts).
import { expect, test } from "bun:test";
import { pageOf } from "../web/nav_model.ts";
import { confirmState } from "../web/parts_model.ts";
import { askOf, authorLine, checkDot, checkWord, diffLines, factsLine, fileWord, mainAction, mergeAsk, type PrPageData, statusOf } from "../web/pr_model.ts";

function pr(over: Partial<PrPageData> = {}): PrPageData {
  return { number: 42, title: "The product's PRD", url: null, state: "open", merged: false, draft: true, branch: "po/shelf-prd", base: "main",
    head: "a1b2c3d4e5f6", body: "", author: { name: "mentewab", role: "product-owner", text: "mentewab" }, tasks: ["3"],
    checks: { state: "green", failing: [], list: [] }, review: { state: "none", text: "not reviewed yet", markers: [], github: [] },
    protected: { files: ["docs/PRD.md"], personOnly: true, why: "It changes protected files, so the agent that wrote it may not merge it." },
    mergeable: true, files: [], filesMore: false, comments: [], next: { action: "owner-review", text: "waiting for you" }, needsYou: true, ...over };
}

test("a pull request's address is part of the Pull requests page", () => {
  expect(pageOf("pr:42")).toBe("prs");
});

test("the line under the title: who opened it with their role, protected files, the review", () => {
  expect(factsLine(pr())).toBe("mentewab, product owner · changes protected files");
  expect(factsLine(pr({ review: { state: "approved", text: "fasil approved it", markers: [], github: [] } }))).toBe(
    "mentewab, product owner · changes protected files · fasil approved it");
  expect(authorLine({ name: null, role: "person", text: "a person" })).toBe("a person");
  expect(authorLine({ name: null, role: "product-owner", text: "the product owner" })).toBe("the product owner");
  expect(authorLine({ name: "taytu", role: "coding-agent", text: "taytu" })).toBe("taytu, builder");
});

test("the status says what it is and what comes next, and whether it needs you", () => {
  expect(statusOf(pr())).toEqual({ text: "Draft, waiting for you", needsYou: true });
  expect(statusOf(pr({ draft: false, review: { state: "approved", text: "", markers: [], github: [] } }))).toEqual({ text: "Approved, waiting for you", needsYou: true });
  expect(statusOf(pr({ draft: false, checks: { state: "red", failing: ["check"], list: [] }, next: { action: "waiting-for-agent", text: "waiting for agent" },
    needsYou: false }))).toEqual({ text: "Checks failing, waiting for agent", needsYou: false });
  expect(statusOf(pr({ merged: true, state: "merged" })).text).toBe("Merged");
});

test("checks and files in plain words", () => {
  expect([checkWord("passed"), checkWord("failed"), checkWord("queued")]).toEqual(["Passed", "Failed", "Waiting to run"]);
  expect([checkDot("passed"), checkDot("failed"), checkDot("running"), checkDot("skipped")]).toEqual(["working", "ink", "waiting", "idle"]);
  expect(fileWord({ path: "docs/PRD.md", previous: null, status: "added", additions: 5, deletions: 0, patch: null, markdown: null })).toBe("new · +5 −0");
});

test("a diff splits into hunks, added, removed and unchanged lines", () => {
  expect(diffLines("@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file")).toEqual([
    { kind: "hunk", text: "@@ -1,2 +1,2 @@" }, { kind: "ctx", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "c" },
    { kind: "note", text: "No newline at end of file" }]);
});

test("a draft offers Mark ready first; merge stays off until it is ready, with the fix on that line", () => {
  expect(mainAction(pr())).toBe("ready");
  expect(mainAction(pr({ draft: false }))).toBe("merge");
  expect(mainAction(pr({ state: "closed" }))).toBe(null);
  const ask = mergeAsk(pr());
  const st = confirmState(ask, "");
  expect(st.ready).toBe(false);
  expect(st.unmet.map((c) => [c.title, c.fix])).toEqual([["It is ready for review", "Mark ready"]]);
});

test("merge: on, once ready and green; it says it squashes at the commit shown, and that a new commit stops it", () => {
  const ask = mergeAsk(pr({ draft: false }));
  expect(confirmState(ask, "").ready).toBe(true);
  expect(ask.happens).toContain("squashed into main");
  expect(ask.happens).toContain("a1b2c3d");
  expect(ask.doesNot).toContain("If a new commit lands first, nothing is merged");
  expect(ask.doesNot).toContain("mentewab can't merge it");
  const red = mergeAsk(pr({ draft: false, checks: { state: "red", failing: ["check"], list: [] } }));
  expect(confirmState(red, "").unmet.map((c) => c.sub)).toEqual(["Failing: check."]);
});

test("each action asks first, saying what happens and what doesn't; close asks for its number typed", () => {
  for (const a of ["merge", "ready", "comment", "request-changes", "close"] as const) {
    const ask = askOf(a, pr({ draft: false }));
    expect(ask.happens.length).toBeGreaterThan(10);
    expect(ask.doesNot.length).toBeGreaterThan(10);
    expect(ask.happens).not.toMatch(/factory |gh /); // no command on screen
  }
  const close = askOf("close", pr());
  expect(close.tone).toBe("danger");
  expect(confirmState(close, "").ready).toBe(false);
  expect(confirmState(close, "#42").ready).toBe(true);
  expect(askOf("request-changes", pr()).happens).toContain("mentewab is told");
});
