// The web app's sidebar (#450), from the owner's design (docs/design/web-ui/Sidebar.dc.html): the pages in their order,
// Your team with each agent's role in words and a dot for its state, Run the factory, and Factory settings with its tabs;
// which one is selected for an address, and the address each opens. Reads web/nav_model.ts as it is (no React).
import { expect, test } from "bun:test";
import { addressOf, channelOf, pageHead, pageOf, SETTINGS_TABS, sidebar, type TeamInput } from "../web/nav_model.ts";

const TEAM: TeamInput[] = [
  { name: "fasil", role: "dev-manager", state: "working", detail: "reviewing #402" },
  { name: "haile", role: "coding-agent", state: "working", detail: "working on #437" },
  { name: "mentewab", role: "product-owner", state: "idle", detail: "idle" },
  { name: "menelik", role: "coding-agent", state: "waiting", detail: "waiting for CI" },
  { name: "taytu", role: "coding-agent", state: "down", detail: "down" },
  { name: "ezana", role: "coding-agent" }, // named in the settings, not reported yet
];

test("the pages in the design's order, then Run the factory", () => {
  const s = sidebar({ page: "home", team: [] });
  expect(s.main.map((n) => n.label)).toEqual(["Home", "Inbox", "Board", "Epics", "Pull requests", "PRD and decisions", "Sign-off and testing", "Activity"]);
  expect(s.ops.map((n) => n.label)).toEqual(["CI and runners", "Machines", "Health", "Usage and cost", "Factory settings"]);
});

test("exactly the page shown is selected; a settings tab selects Factory settings", () => {
  const on = (page: string) => {
    const s = sidebar({ page, team: TEAM });
    return [...s.main, ...s.ops, ...s.team].filter((n) => n.on).map((n) => ("label" in n ? n.label : n.name));
  };
  expect(on("home")).toEqual(["Home"]);
  expect(on("board")).toEqual(["Board"]);
  expect(on("prs")).toEqual(["Pull requests"]);
  expect(on("usage")).toEqual(["Usage and cost"]);
  for (const tab of ["settings", "integrations", "releases", "maintenance"]) expect(on(tab)).toEqual(["Factory settings"]);
  expect(on("haile")).toEqual(["haile"]);
});

test("counts: the Inbox's in red (it needs you), pull requests in blue, none when zero or not known", () => {
  const s = sidebar({ page: "home", team: [], counts: { inbox: 2, prs: 3 } });
  const by = (label: string) => s.main.find((n) => n.label === label);
  expect(by("Inbox")?.badge).toEqual({ count: 2, tone: "red" });
  expect(by("Pull requests")?.badge).toEqual({ count: 3, tone: "blue" });
  expect(by("Board")?.badge).toBeNull();
  const none = sidebar({ page: "home", team: [], counts: { inbox: 0 } });
  expect(none.main.find((n) => n.label === "Inbox")?.badge).toBeNull();
  expect(none.main.find((n) => n.label === "Pull requests")?.badge).toBeNull();
});

test("Your team: the product owner, the dev manager, then the builders by name; the role in words and a dot for the state", () => {
  const s = sidebar({ page: "home", team: TEAM });
  expect(s.team.map((t) => [t.name, t.role, t.dot])).toEqual([
    ["mentewab", "Product", "idle"],
    ["fasil", "Manager", "working"],
    ["ezana", "Builder", "idle"],
    ["haile", "Builder", "working"],
    ["menelik", "Builder", "waiting"],
    ["taytu", "Builder", "down"],
  ]);
  expect(s.team.find((t) => t.name === "haile")?.channel).toBe("agent:haile");
  expect(s.team.find((t) => t.name === "ezana")?.title).toBe("ezana: not reported");
  expect(s.team.find((t) => t.name === "menelik")?.title).toBe("menelik: waiting for CI");
});

test("while GitHub's limit is used up, an agent at work shows as waiting", () => {
  const s = sidebar({ page: "home", team: TEAM, limit: { reset: 1_800_000_000, message: "GitHub's limit is used up." } });
  expect(s.team.find((t) => t.name === "haile")?.dot).toBe("waiting");
  expect(s.team.find((t) => t.name === "taytu")?.dot).toBe("down");
});

test("each item opens its page: the views that exist keep their addresses, the rest are pages of their own", () => {
  expect(channelOf("home")).toBe("page:home");
  expect(channelOf("inbox")).toBe("view:owner-queue");
  expect(channelOf("board")).toBe("view:tasks");
  expect(channelOf("epics")).toBe("view:epics");
  expect(channelOf("prs")).toBe("view:pull-requests");
  expect(channelOf("docs")).toBe("page:docs");
  expect(channelOf("ci")).toBe("view:ci");
  expect(channelOf("machines")).toBe("view:machines");
  expect(channelOf("signoff")).toBe("page:signoff");
  expect(channelOf("settings")).toBe("page:settings");
  const s = sidebar({ page: "home", team: [] });
  for (const n of [...s.main, ...s.ops]) expect(pageOf(n.channel)).toBe(n.page);
});

test("an address names its page: a doc page is PRD and decisions, an agent is its team row, anything else is Home", () => {
  expect(pageOf("view:tasks")).toBe("board");
  expect(pageOf("view:owner-queue")).toBe("inbox");
  expect(pageOf("doc:decision-0004")).toBe("docs");
  expect(pageOf("agent:haile")).toBe("haile");
  expect(pageOf("page:integrations")).toBe("integrations");
  expect(pageOf("page:nothing-like-this")).toBe("home");
  expect(pageOf("")).toBe("home");
});

test("Factory settings has Integrations, Releases and updates, and Maintenance as its tabs", () => {
  expect(SETTINGS_TABS.map((t) => t.label)).toEqual(["Settings", "Integrations", "Releases and updates", "Maintenance"]);
  expect(SETTINGS_TABS.map((t) => channelOf(t.page))).toEqual(["page:settings", "page:integrations", "page:releases", "page:maintenance"]);
});

test("every page has a title and a one-line purpose in plain words, with no command, flag or setting key", () => {
  const s = sidebar({ page: "home", team: [] });
  for (const n of [...s.main, ...s.ops, ...SETTINGS_TABS]) {
    const head = pageHead(n.page);
    expect(head.title.length).toBeGreaterThan(0);
    expect(head.purpose.length).toBeGreaterThan(10);
    expect(`${head.title} ${head.purpose}`).not.toMatch(/factory [a-z]|--[a-z]|\b[a-z]+\.[a-z][A-Za-z]+\b/);
  }
  expect(pageHead("settings").title).toBe("Factory settings");
  expect(pageHead("integrations").title).toBe("Factory settings");
});

test("a page's own name reaches it: page:board opens the board, page:inbox the inbox, and other addresses stay", () => {
  expect(addressOf("page:board")).toBe("view:tasks");
  expect(addressOf("page:inbox")).toBe("view:owner-queue");
  expect(addressOf("page:prs")).toBe("view:pull-requests");
  expect(addressOf("page:home")).toBe("page:home");
  expect(addressOf("page:integrations")).toBe("page:integrations");
  expect(addressOf("page:nothing-like-this")).toBe("page:nothing-like-this");
  expect(addressOf("view:tasks")).toBe("view:tasks");
  expect(addressOf("agent:haile")).toBe("agent:haile");
  expect(pageOf(addressOf("page:board"))).toBe("board");
});
