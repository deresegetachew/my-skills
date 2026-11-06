// The integrations page's tabs, rows, summary line and state colours (#441), from web/integrations_model.ts, which has no
// React in it.
import { expect, test } from "bun:test";
import { rowsFor, stateTone, summary, tabsOf, type IntegrationRow } from "../web/integrations_model.ts";

const TEXT = { connected: "Connected", "needs-fix": "Needs a fix", "not-set-up": "Not set up", unknown: "Not read yet" };

const row = (id: string, name: string, state: IntegrationRow["state"]): IntegrationRow => ({ id, name, state, stateText: TEXT[state],
  sub: "", fix: state === "needs-fix" || state === "not-set-up" ? "Do it." : null, test: null });

const SIX: IntegrationRow[] = [
  row("hub", "Messaging hub", "needs-fix"), row("github", "GitHub", "connected"), row("ci", "CI runners", "unknown"),
  row("cache", "Build cache", "not-set-up"), row("plugins", "Plugins", "not-set-up"), row("mcp", "MCP connectors", "connected"),
];

test("tabs: All, Needs a fix and Not set up, each with its count", () => {
  expect(tabsOf(SIX)).toEqual([{ id: "all", label: "All", count: 6 }, { id: "needs-fix", label: "Needs a fix", count: 1 },
    { id: "not-set-up", label: "Not set up", count: 2 }]);
});

test("rows: All keeps every row, a tab keeps the rows in that state in the given order", () => {
  expect(rowsFor(SIX, "all").map((r) => r.id)).toEqual(["hub", "github", "ci", "cache", "plugins", "mcp"]);
  expect(rowsFor(SIX, "needs-fix").map((r) => r.id)).toEqual(["hub"]);
  expect(rowsFor(SIX, "not-set-up").map((r) => r.id)).toEqual(["cache", "plugins"]);
});

test("summary: nothing needs you, one needs a fix (named), several need a fix, and one connection is singular", () => {
  const ok = SIX.map((r) => (r.state === "needs-fix" ? { ...r, state: "connected" as const } : r));
  expect(summary(ok)).toBe("6 connections. Nothing needs you.");
  expect(summary(SIX)).toBe("6 connections. One needs a fix: Messaging hub.");
  const two = SIX.map((r) => (r.id === "ci" ? { ...r, state: "needs-fix" as const } : r));
  expect(summary(two)).toBe("6 connections. 2 need a fix.");
  expect(summary([row("github", "GitHub", "connected")])).toBe("1 connection.");
});

test("state tone: good for connected, bad for needs a fix, quiet for not set up and not read yet", () => {
  expect(stateTone("connected")).toBe("good");
  expect(stateTone("needs-fix")).toBe("bad");
  expect(stateTone("not-set-up")).toBe("quiet");
  expect(stateTone("unknown")).toBe("quiet");
});
