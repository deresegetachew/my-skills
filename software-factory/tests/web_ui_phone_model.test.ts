// The web app on a phone (#458), from docs/design/web-ui/PhoneHome.dc.html and PhoneInbox.dc.html: the bottom tab bar,
// the Inbox count, the merge cards and Home's "need you" card. Reads web/phone_model.ts as it is (no React).
import { expect, test } from "bun:test";
import type { QueueView, AskView } from "../web/chat_model.ts";
import type { NeedRow } from "../web/ops_model.ts";
import type { PullRow } from "../web/views_model.ts";
import { inboxCount, inInbox, type MergeCard, needsCard, ownerMerges, phoneTabs } from "../web/phone_model.ts";

function pull(n: number, o: Partial<PullRow> = {}): PullRow {
  return {
    number: n, title: `Task ${n}`, url: null, branch: `task/${n}`, draft: false, agent: null, task: null,
    checks: { state: "green", failing: [] },
    review: { state: "approved", text: "approved", claim: null },
    protected: false,
    next: { action: "owner-merges", text: "you merge it" },
    rework: null, find: `pr:${n}`, ...o,
  };
}
function ask(id: string, state: "open" | "answered"): AskView {
  return { id, issue: 1, text: "Which?", options: ["a", "b"], state, forProduct: false, url: null, created: null, answer: null };
}
function queue(asks: AskView[], problem: QueueView["problem"] = null): QueueView {
  return { issue: 1, url: null, asks, problem };
}
function need(kind: string, title: string): NeedRow {
  return { kind, title, sub: "", link: "", find: "", action: "" };
}

test("the tab bar: Home, Inbox, Board, Team, with the sidebar's addresses", () => {
  const t = phoneTabs({ page: "home" });
  expect(t.map((x) => x.id)).toEqual(["home", "inbox", "board", "team"]);
  expect(t.map((x) => x.label)).toEqual(["Home", "Inbox", "Board", "Team"]);
  expect(t.map((x) => x.channel)).toEqual(["page:home", "view:owner-queue", "view:tasks", "page:team"]);
});

test("exactly the page shown is on; an agent's page turns Team on; any other page turns none on", () => {
  const on = (page: string) => phoneTabs({ page, team: ["haile", "fasil"] }).filter((x) => x.on).map((x) => x.id);
  expect(on("home")).toEqual(["home"]);
  expect(on("inbox")).toEqual(["inbox"]);
  expect(on("board")).toEqual(["board"]);
  expect(on("team")).toEqual(["team"]);
  expect(on("haile")).toEqual(["team"]);
  expect(on("prs")).toEqual([]);
  expect(on("settings")).toEqual([]);
});

test("a name that is not on the team does not turn Team on; with no team given nothing breaks", () => {
  expect(phoneTabs({ page: "stranger", team: ["haile"] }).some((x) => x.on)).toBe(false);
  expect(phoneTabs({ page: "haile" }).some((x) => x.on)).toBe(false);
});

test("only the Inbox carries a count badge, and not when it is zero or missing", () => {
  expect(phoneTabs({ page: "home", inbox: 2 }).map((x) => x.badge)).toEqual([null, 2, null, null]);
  expect(phoneTabs({ page: "home", inbox: 0 }).map((x) => x.badge)).toEqual([null, null, null, null]);
  expect(phoneTabs({ page: "home" }).map((x) => x.badge)).toEqual([null, null, null, null]);
});

test("merge cards: only pulls the owner merges, in the given order, each opening its PR's Merge confirm", () => {
  const cards = ownerMerges([pull(5), pull(6, { next: { action: "dev-manager-reviews", text: "" } }), pull(4)]);
  expect(cards.map((c) => c.number)).toEqual([5, 4]);
  expect(cards[0]?.title).toBe("Merge PR #5");
  expect(cards[0]?.channel).toBe("pr:5");
  expect(cards[0]?.find).toBe("merge");
  expect(ownerMerges([])).toEqual([]);
  expect(ownerMerges([pull(6, { next: { action: "wait", text: "" } })])).toEqual([]);
});

test("merge card sub: checks and review in plain words", () => {
  const sub = (o: Partial<PullRow>) => ownerMerges([pull(1, o)])[0]?.sub;
  expect(sub({})).toBe("Checks passed · approved");
  expect(sub({ checks: { state: "red", failing: ["t"] } })).toBe("Checks failing · approved");
  expect(sub({ checks: { state: "running", failing: [] } })).toBe("Checks running · approved");
  expect(sub({ checks: { state: "pending", failing: [] } })).toBe("Checks running · approved");
  expect(sub({ checks: { state: "none", failing: [] } })).toBe("No checks yet · approved");
  expect(sub({ review: { state: "watching", text: "being watched", claim: null } })).toBe("Checks passed · being watched");
});

test("merge card why: protected, not protected, and not known", () => {
  const tail = "It merges only while its head is still the one you saw.";
  const why = (p: boolean | null) => ownerMerges([pull(7, { title: "Add x", protected: p })])[0]?.why;
  expect(why(true)).toBe(`Add x. It changes protected files, so only you can merge it. ${tail}`);
  expect(why(false)).toBe(`Add x. Only you can merge it. ${tail}`);
  expect(why(null)).toBe(`Add x. Only you can merge it. ${tail}`);
});

test("no command names in anything a merge card says", () => {
  for (const p of [true, false, null]) {
    const c = ownerMerges([pull(7, { protected: p })])[0] as MergeCard;
    for (const s of [c.title, c.sub, c.why]) {
      expect(s).not.toContain("factory ");
      expect(s).not.toContain("gh ");
    }
  }
});

test("Inbox count: open asks plus owner merges; answered asks, a problem and no queue count nothing", () => {
  const pulls = [pull(1), pull(2, { next: { action: "wait", text: "" } }), pull(3)];
  expect(inboxCount(queue([ask("a", "open"), ask("b", "answered"), ask("c", "open")]), pulls)).toBe(4);
  expect(inboxCount(null, pulls)).toBe(2);
  expect(inboxCount(queue([ask("a", "open")], { code: "x", message: "m", fix: "f" } as never), pulls)).toBe(2);
  expect(inboxCount(queue([]), [])).toBe(0);
  expect(inboxCount(null, [])).toBe(0);
});

test("Home's card: merges then asks, singular and plural, nothing when none", () => {
  expect(needsCard([])).toBeNull();
  expect(needsCard([need("blocked", "x"), need("ci", "y"), need("health", "z")])).toBeNull();
  expect(needsCard([need("merge", "Merge PR #402? Add x"), need("ask", "Which db?")])).toEqual({
    title: "2 need you", line: "Merge PR #402 · answer 1 ask",
  });
  expect(needsCard([need("ask", "One"), need("ask", "Two")])).toEqual({ title: "2 need you", line: "answer 2 asks" });
  expect(needsCard([need("merge", "Merge PR #9? Fix")])).toEqual({ title: "1 needs you", line: "Merge PR #9" });
  const many = [need("ask", "a"), need("blocked", "b"), need("merge", "Merge PR #3? t"), need("merge", "Merge PR #4? u"), need("ask", "c"), need("ask", "d")];
  expect(needsCard(many)).toEqual({ title: "5 need you", line: "Merge PR #3 · Merge PR #4 · answer 3 asks" });
});

test("which kinds are the Inbox's", () => {
  expect(inInbox("ask")).toBe(true);
  expect(inInbox("merge")).toBe(true);
  for (const k of ["blocked", "ci", "health"]) expect(inInbox(k)).toBe(false);
});
