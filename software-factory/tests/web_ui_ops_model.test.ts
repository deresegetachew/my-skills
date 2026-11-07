// The words of Health, Usage and cost, Activity and Home (#455, #451), from web/ops_model.ts as it is (no React): the
// head lines, what needs attention, the usage bars against the budget, an event's grey line, and a team member's row.
import { expect, test } from "bun:test";
import { type ActivityItem, activityDot, activitySub, attention, costText, type HealthData, healthLine, type HomeData, homeLine, passed, percentOf,
  rangeText, teamRow, mergePushed, tokensText, type UsageData, type UsageRow, usageBar, usageTiles } from "../web/ops_model.ts";

const NOW = Date.parse("2026-11-07T10:00:00Z");

function health(more: Partial<HealthData> = {}): HealthData {
  return { ranAt: "2026-11-07T09:57:00Z", ok: false, running: false, counts: { ok: 6, warning: 1, failed: 1 }, problems: [],
    groups: [
      { id: "machine", title: "This machine", checks: [{ level: "ok", what: "git", fix: "" }, { level: "failed", what: "tmux", fix: "update it" },
        { level: "ok", what: "bun 1.3", fix: "" }, { level: "ok", what: "Claude Code", fix: "" }, { level: "ok", what: "docker", fix: "" },
        { level: "ok", what: "node", fix: "" }] },
      { id: "project", title: "The project", checks: [{ level: "warning", what: "trustedReviewers", fix: "it is empty" }] },
      { id: "github", title: "GitHub", checks: [{ level: "ok", what: "gh is signed in", fix: "" }] },
    ], ...more };
}

test("health: the head line counts the checks, what to fix and when they ran", () => {
  expect(healthLine(health(), NOW)).toBe("8 checks. 1 to fix, 1 warning. Ran 3 min ago.");
  expect(healthLine(health({ counts: { ok: 3, warning: 0, failed: 0 } }), NOW)).toBe("3 checks. All pass. Ran 3 min ago.");
  expect(healthLine(health({ running: true }), NOW)).toBe("8 checks. 1 to fix, 1 warning. Checking again…");
  expect(healthLine(null)).toBe("Checking this machine and the project…");
  expect(healthLine(health({ ranAt: null, running: false }))).toBe("Not checked yet.");
});

test("health: what needs attention comes first (failed, then warnings), and the passed checks by part", () => {
  expect(attention(health()).map((r) => [r.what, r.where, r.fix, r.status.text, r.status.dot])).toEqual([
    ["tmux", "This machine", "update it", "To fix", "red"],
    ["trustedReviewers", "The project", "it is empty", "Warning", "waiting"],
  ]);
  expect(passed(health())).toEqual([
    { id: "machine", title: "This machine", sub: "git, bun 1.3, Claude Code, docker and 1 more", count: "5 ok" },
    { id: "github", title: "GitHub", sub: "gh is signed in", count: "1 ok" },
  ]);
});

function row(used: number, budget: number | null, tone: UsageRow["tone"]): UsageRow {
  return { key: "7", title: "Login", used, replies: 3, budget, percent: budget ? Math.round((used / budget) * 100) : null, tone };
}

test("usage: a bar's length is the tokens used; its dot turns yellow near the budget and red over it", () => {
  expect(usageBar(row(2_400_000, 2_000_000, "over"), 2_400_000)).toEqual({ width: "100%", dot: "red", text: "2.4M of 2M" });
  expect(usageBar(row(1_700_000, 2_000_000, "warn"), 2_400_000)).toEqual({ width: "71%", dot: "waiting", text: "1.7M of 2M" });
  expect(usageBar(row(300_000, null, "none"), 2_400_000)).toEqual({ width: "13%", dot: "idle", text: "300k" });
  expect(tokensText(950)).toBe("950");
  expect(rangeText("2026-10-30T00:00:00+00:00", "2026-11-07T00:00:00+00:00")).toBe("30 Oct to 6 Nov");
});

test("usage: a bar with a known cost shows it beside the tokens; the cost tile says what it covers (#571)", () => {
  expect(usageBar({ ...row(300_000, null, "none"), cost: 29.2 }, 300_000).text).toBe("300k · $29.20");
  expect(usageBar({ ...row(300_000, null, "none"), cost: null }, 300_000).text).toBe("300k");
  expect(costText(0.001)).toBe("<$0.01");
  expect(costText(null)).toBe("-");
  const data: UsageData = { since: null, until: null, measured: true, total: { used: 1, replies: 3, tasks: 1, cost: 1.5, unpriced: 2 },
    budget: { tokens: null, source: null, warnPercent: 80 }, tasks: [], agents: [], days: [], pricesAsOf: "2026-10-06", github: null,
    notMeasured: [], problems: [] };
  expect(usageTiles(data).find((t) => t.label === "Cost")).toEqual({ label: "Cost", value: "$1.50", line: "2 replies without a known price" });
  expect(usageTiles({ ...data, total: { ...data.total, unpriced: 0 } }).find((t) => t.label === "Cost")?.line).toBe("API prices of 2026-10-06");
});

test("activity: an event's grey line is its kind, its task or PR, and when", () => {
  const item = { id: "board-1", at: "2026-11-07T09:50:00Z", agent: "menelik", kind: "claim", text: "claimed #7", task: "7", pr: null, link: "view:tasks", find: "#7" };
  expect(activitySub(item, NOW)).toBe("Claim · #7 · 10 min ago");
  expect(activitySub({ ...item, kind: "pr", pr: 21, task: "7" }, NOW)).toBe("Pull request · PR #21 · 10 min ago");
  expect(activitySub({ ...item, kind: "new", task: "b12", at: null }, NOW)).toBe("New task · b12");
  expect(activityDot({ ...item, kind: "ask" })).toBe("red");
  expect(activityDot({ ...item, kind: "move" })).toBe("waiting");
});

test("activity: an entry pushed over the WebSocket goes on top when it matches the filters, once", () => {
  const at = (m: number): string => new Date(NOW - m * 60_000).toISOString();
  const item = (id: string, m: number, more: Partial<ActivityItem> = {}): ActivityItem => ({ id, at: at(m), agent: "menelik", kind: "claim", text: id,
    task: "7", pr: null, epic: "1", link: "view:tasks", find: "#7", ...more });
  const shown = [item("b", 5), item("a", 10)];
  const none = { agent: "", task: "", epic: "", kind: "" };
  expect(mergePushed(shown, [item("c", 1), item("b", 5)], none).map((x) => x.id)).toEqual(["c", "b", "a"]);
  expect(mergePushed(shown, [item("c", 1, { agent: "taytu" })], { ...none, agent: "menelik" }).map((x) => x.id)).toEqual(["b", "a"]);
  expect(mergePushed(shown, [item("c", 1, { kind: "agent" })], { ...none, kind: "claim" }).map((x) => x.id)).toEqual(["b", "a"]);
  expect(mergePushed(shown, [item("c", 1, { epic: null })], { ...none, epic: "1" }).map((x) => x.id)).toEqual(["b", "a"]);
  expect(mergePushed(shown, [item("c", 1, { task: null, pr: 21 })], { ...none, task: "#21" }).map((x) => x.id)).toEqual(["c", "b", "a"]);
  expect(mergePushed(shown, [item("c", 1, { task: "8", pr: 22 })], { ...none, task: "#21" }).map((x) => x.id)).toEqual(["b", "a"]);
  expect(mergePushed(shown, [item("c", 1)], none, 2).map((x) => x.id)).toEqual(["c", "b"]);
  expect(activitySub(item("x", 10, { kind: "agent", task: null }), NOW)).toBe("Agent · 10 min ago");
  expect(activityDot(item("x", 1, { kind: "ci", text: "CI passed on PR #21" }))).toBe("working");
  expect(activityDot(item("x", 1, { kind: "ci", text: "CI failed on PR #21" }))).toBe("red");
  expect(activityDot(item("x", 1, { kind: "agent", text: "went down" }))).toBe("down");
});

test("home: the head line and a team member's row", () => {
  const h: HomeData = { needs: [{ kind: "merge", title: "Merge PR #22?", sub: "", link: "view:pull-requests", find: "#22", action: "Review and merge" }],
    team: [{ name: "menelik", role: "coding-agent", state: "working", detail: "working on #7", task: "7", taskTitle: "Login", machine: "dev-pc", link: "agent:menelik" },
      { name: "fasil", role: "dev-manager", state: "idle", detail: "idle", task: null, taskTitle: null, machine: null, link: "agent:fasil" }],
    progress: { done: 1, all: 4, epics: [], noEpic: { done: 0, all: 0 } }, recent: [], activityFrom: "board", limit: null, problems: [] };
  expect(homeLine(h)).toBe("1 agent working of 2, 1 thing needs you.");
  expect(homeLine({ ...h, needs: [] })).toBe("1 agent working of 2, nothing needs you.");
  expect(teamRow(h.team[0] as HomeData["team"][number], null)).toEqual({ sub: "Builder on dev-pc · #7 Login", state: "working on #7", dot: "working" });
  expect(teamRow(h.team[1] as HomeData["team"][number], null)).toEqual({ sub: "Dev manager", state: "idle", dot: "idle" });
  expect(percentOf(1, 3)).toBe(33);
  expect(percentOf(0, 0)).toBe(0);
});
