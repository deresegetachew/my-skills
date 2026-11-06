// The integrations page's rules that aren't drawing (#441): its tabs with their counts, which rows each tab shows, and the
// tone of each state's dot.
import { expect, test } from "bun:test";
import { integrationTabs, integrationTone, showRows, usesGrid } from "../web/integrations_model.ts";

const ROWS = [
  { id: "github", state: "ok" },
  { id: "messaging", state: "bad" },
  { id: "ci", state: "unknown" },
  { id: "cache", state: "off" },
  { id: "mcp", state: "off" },
] as const;

test("the tabs: all, needs a fix, not set up, each with its count", () => {
  expect(integrationTabs([...ROWS])).toEqual([
    { id: "all", label: "All", count: 5 },
    { id: "bad", label: "Needs a fix", count: 1 },
    { id: "off", label: "Not set up", count: 2 },
  ]);
});

test("each tab shows its rows, in the server's order", () => {
  expect(showRows([...ROWS], "all").map((r) => r.id)).toEqual(["github", "messaging", "ci", "cache", "mcp"]);
  expect(showRows([...ROWS], "bad").map((r) => r.id)).toEqual(["messaging"]);
  expect(showRows([...ROWS], "off").map((r) => r.id)).toEqual(["cache", "mcp"]);
});

test("a dot's tone: set up is good, a fix is bad, the rest quiet", () => {
  expect(integrationTone("ok")).toBe("good");
  expect(integrationTone("bad")).toBe("bad");
  expect(integrationTone("off")).toBe("quiet");
  expect(integrationTone("unknown")).toBe("quiet");
});

test("the grid of what each agent may use: one cell per connector, ticked when the agent uses it, labelled for a reader", () => {
  const uses = {
    perAgent: false, note: "",
    connectors: [{ id: "github", label: "GitHub" }, { id: "cache", label: "Build cache" }],
    agents: [{ name: "taytu", role: "Builder", uses: ["github"] }],
  };
  expect(usesGrid(uses)).toEqual([{ name: "taytu", role: "Builder", cells: [
    { id: "github", on: true, label: "taytu may use GitHub" },
    { id: "cache", on: false, label: "taytu may not use Build cache" },
  ] }]);
  expect(usesGrid({ ...uses, agents: [] })).toEqual([]);
});
