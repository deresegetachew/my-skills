// The chat's and the owner queue's rules in the page (#423), web/chat_model.ts, with no React in it: a chat's items
// merged as they arrive (once each, in time order), the owner queue's asks in the order the owner works them, and the
// words each chat item is shown with.
import { expect, test } from "bun:test";
import { askedBy, type AskView, type ChatItemView, emptyQueueText, itemLabel, mergeItems, orderAsks } from "../web/chat_model.ts";

const it = (id: string, at: string, more: Partial<ChatItemView> = {}): ChatItemView =>
  ({ id, at, from: "menelik", to: "dev-manager", kind: "question", text: id, ...more });

test("items arrive once each, in time order", () => {
  const first = [it("b", "2026-11-05T10:02:00Z"), it("a", "2026-11-05T10:01:00Z")];
  const merged = mergeItems(first, [it("c", "2026-11-05T10:03:00Z"), it("a", "2026-11-05T10:01:00Z", { text: "again" })]);
  expect(merged.map((x) => x.id)).toEqual(["a", "b", "c"]);
  expect(merged[0]?.text).toBe("again"); // the newer copy wins
  expect(mergeItems([], [])).toEqual([]);
});

test("the open asks come first, oldest first; the answered ones after, newest first", () => {
  const ask = (id: string, state: "open" | "answered", created: string): AskView =>
    ({ id, issue: 50, text: id, options: [], state, forProduct: false, url: null, created, answer: null });
  const asks = [ask("a1", "answered", "2026-11-01T00:00:00Z"), ask("o2", "open", "2026-11-04T00:00:00Z"),
    ask("a2", "answered", "2026-11-03T00:00:00Z"), ask("o1", "open", "2026-11-02T00:00:00Z")];
  expect(orderAsks(asks).map((a) => a.id)).toEqual(["o1", "o2", "a2", "a1"]);
});

test("an ask's card says who asked and about which task; the empty Inbox on the board says where questions come from (#549)", () => {
  const ask: AskView = { id: "m2", issue: 0, text: "Which shelf?", options: [], state: "open", forProduct: false, url: null, created: null, answer: null };
  expect(askedBy({ ...ask, from: "mentewab", task: "#101" })).toBe("mentewab asked about #101");
  expect(askedBy({ ...ask, from: "mentewab", task: null })).toBe("mentewab asked");
  expect(askedBy(ask)).toBe("");
  const board = emptyQueueText({ issue: null, url: null, asks: [], problem: null, source: "board" });
  expect(board).toBe("Nothing waiting for you. Questions the agents ask you appear here.");
  expect(board).not.toContain("issue");
  expect(emptyQueueText({ issue: null, url: null, asks: [], problem: null, source: "github" })).toContain("Dev manager: needs the owner");
});

test("each item says who said it and what it is", () => {
  expect(itemLabel(it("x", "", { from: "owner", to: "menelik", kind: "owner" }), "menelik")).toEqual({ who: "You", what: "", mine: true });
  expect(itemLabel(it("x", "", { kind: "question", ref: "pr#12" }), "menelik")).toEqual({ who: "menelik", what: "question to dev-manager on pr#12", mine: false });
  expect(itemLabel(it("x", "", { from: "fasil", to: "menelik", kind: "answer", ref: "" }), "menelik")).toEqual({ who: "fasil", what: "answer to menelik", mine: false });
  expect(itemLabel(it("x", "", { from: "fasil", to: "owner", kind: "reply" }), "fasil")).toEqual({ who: "fasil", what: "", mine: false });
  expect(itemLabel(it("x", "", { from: "fasil", to: "owner", kind: "error" }), "fasil")).toEqual({ who: "fasil", what: "didn't answer", mine: false });
});
