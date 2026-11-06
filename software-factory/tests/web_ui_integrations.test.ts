// The web UI's integrations page (#441): GET /api/projects/:p/integrations gives the six rows (GitHub, messaging hub, CI
// runners, build cache, plugins, MCP connectors) with a state, a fix and a test command, and POST .../:id/test runs that
// command through the project's fake `factory` or the fake `gh`, which log what they were asked.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { git, write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const NATS = { messaging: { transport: "nats", url: "nats://100.99.7.67:4222", kinds: ["wake", "claim"] } };

async function started(cfg: Row = {}, setup: (p: Project) => void = () => {}): Promise<{ ui: Running; p: Project }> {
  const p = project({ ...CONFIG, ...cfg });
  roots.push(p.root);
  setup(p);
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  return { ui, p };
}

function ciCache(p: Project, runners: Row[]): void {
  write(join(p.state, "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [] }, pulls: [],
    ci: { mode: "local", repo: "o/work", label: "work-local", runsOn: "[\"self-hosted\",\"work-local\"]", runners, runs: [],
      queuedLong: { count: 0, longestMinutes: 0, thresholdMinutes: 15, noRunnerOnline: false }, errors: [] } }));
}

function origin(p: Project): void {
  git(p.d, "remote", "add", "origin", "https://github.com/o/work.git");
}

async function rows(ui: Running): Promise<Record<string, Row>> {
  const r = await api(ui, "/api/projects/work/integrations");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return Object.fromEntries((r.json.integrations as Row[]).map((x) => [String(x.id), x]));
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

test("integrations: no token is 401", async () => {
  const { ui } = await started();
  expect((await api(ui, "/api/projects/work/integrations", { token: null })).status).toBe(401);
}, T);

test("integrations: always the six rows, the ones needing a fix first, then github, hub, ci, cache, plugins, mcp", async () => {
  const { ui } = await started({ messaging: { transport: "nats" } });
  const r = await api(ui, "/api/projects/work/integrations");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.project).toBe("work");
  const list = r.json.integrations as Row[];
  expect(list.map((x) => x.id)).toEqual(["hub", "github", "ci", "cache", "plugins", "mcp"]);
  expect(list.map((x) => x.name)).toEqual(["Messaging hub", "GitHub", "CI runners", "Build cache", "Plugins", "MCP connectors"]);
  expect(Array.isArray(r.json.problems)).toBe(true);
}, T);

test("integrations: counts are all six, how many need a fix and how many are not set up", async () => {
  const { ui } = await started({ messaging: { transport: "nats" } });
  const r = await api(ui, "/api/projects/work/integrations");
  const list = r.json.integrations as Row[];
  expect(r.json.counts).toEqual({ all: 6, needsFix: list.filter((x) => x.state === "needs-fix").length,
    notSetUp: list.filter((x) => x.state === "not-set-up").length });
  expect((r.json.counts as Row).needsFix).toBeGreaterThanOrEqual(1);
}, T);

test("github: a github.com origin is connected, with the repo, where tasks come from, and gh auth status as its test", async () => {
  const { ui } = await started({}, origin);
  const g = (await rows(ui)).github as Row;
  expect(g).toMatchObject({ name: "GitHub", state: "connected", stateText: "Connected", fix: null, test: "gh auth status" });
  expect(String(g.sub)).toContain("o/work");
  expect(String(g.sub)).toContain("tasks from GitHub issues");
}, T);

test("github: with the build plan, the sub says tasks come from the plan", async () => {
  const { ui } = await started({ tasks: { source: "plan" } }, origin);
  expect(String(((await rows(ui)).github as Row).sub)).toContain("tasks from the build plan");
}, T);

test("github: no GitHub origin is not set up, with a fix", async () => {
  const { ui } = await started();
  const g = (await rows(ui)).github as Row;
  expect(g).toMatchObject({ state: "not-set-up", stateText: "Not set up" });
  expect(String(g.fix).length).toBeGreaterThan(0);
}, T);

test("hub: no transport, or github, is not set up and has no test", async () => {
  for (const cfg of [{}, { messaging: { transport: "github" } }]) {
    const { ui } = await started(cfg);
    expect((await rows(ui)).hub).toMatchObject({ state: "not-set-up", sub: "Agents send messages through GitHub", test: null });
  }
}, T);

test("hub: nats with a url is connected, shows the address and tests with factory nats status", async () => {
  const { ui } = await started(NATS);
  const h = (await rows(ui)).hub as Row;
  expect(h).toMatchObject({ state: "connected", fix: null, test: "factory nats status" });
  expect(String(h.sub)).toContain("100.99.7.67:4222");
}, T);

test("hub: nats with no url needs a fix", async () => {
  const { ui } = await started({ messaging: { transport: "nats" } });
  const h = (await rows(ui)).hub as Row;
  expect(h).toMatchObject({ state: "needs-fix", stateText: "Needs a fix" });
  expect(String(h.fix).length).toBeGreaterThan(0);
}, T);

test("ci: with no cockpit cache it is unknown, Not read yet, and has no fix", async () => {
  const { ui } = await started();
  expect((await rows(ui)).ci).toMatchObject({ state: "unknown", stateText: "Not read yet", fix: null, test: "factory ci status" });
}, T);

test("ci: every heavy runner offline needs a fix and says CI is stuck", async () => {
  const { ui } = await started({}, (p) => ciCache(p, [{ name: "work-ci-m-here-1", status: "offline", busy: false }]));
  const c = (await rows(ui)).ci as Row;
  expect(c).toMatchObject({ state: "needs-fix", test: "factory ci status" });
  expect(String(c.sub).startsWith("CI is stuck")).toBe(true);
  expect(String(c.fix).length).toBeGreaterThan(0);
}, T);

test("ci: a runner online and idle is connected and says CI is fine", async () => {
  const { ui } = await started({}, (p) => ciCache(p, [{ name: "work-ci-m-here-1", status: "online", busy: false }]));
  const c = (await rows(ui)).ci as Row;
  expect(c).toMatchObject({ state: "connected", fix: null });
  expect(String(c.sub).startsWith("CI is fine")).toBe(true);
}, T);

test("cache: no turbo.api is not set up, with no test", async () => {
  const { ui } = await started();
  expect((await rows(ui)).cache).toMatchObject({ state: "not-set-up", sub: "Agents and CI build without a shared cache", test: null });
}, T);

test("cache: turbo.api is connected, shows the address and tests with factory turbo status", async () => {
  const { ui } = await started({ turbo: { api: "http://100.99.7.67:3335" } });
  const c = (await rows(ui)).cache as Row;
  expect(c).toMatchObject({ state: "connected", test: "factory turbo status" });
  expect(String(c.sub)).toContain("http://100.99.7.67:3335");
}, T);

test("plugins: none needed is not set up, 'None turned on'; nats turns one on", async () => {
  const none = await started();
  expect((await rows(none.ui)).plugins).toMatchObject({ state: "not-set-up", sub: "None turned on", test: null });
  const nats = await started(NATS);
  const p = (await rows(nats.ui)).plugins as Row;
  expect(p.state).toBe("connected");
  expect(String(p.sub)).toContain("nats");
}, T);

test("mcp: the servers in .mcp.json at the project root are listed; none is not set up", async () => {
  const none = await started();
  expect((await rows(none.ui)).mcp).toMatchObject({ state: "not-set-up", test: null });
  const { ui } = await started({}, (p) => write(join(p.d, ".mcp.json"),
    JSON.stringify({ mcpServers: { playwright: { command: "npx" }, github: { command: "gh" } } })));
  const m = (await rows(ui)).mcp as Row;
  expect(m.state).toBe("connected");
  expect(String(m.sub)).toContain("playwright");
  expect(String(m.sub)).toContain("github");
}, T);

test("test: an unknown id is 404 ui_integration_unknown with a message and a fix", async () => {
  const { ui, p } = await started();
  const r = await api(ui, "/api/projects/work/integrations/fax/test", { method: "POST", body: {} });
  expect(r.status).toBe(404);
  expect(r.json.code).toBe("ui_integration_unknown");
  expect(String(r.json.message).length).toBeGreaterThan(0);
  expect(String(r.json.fix).length).toBeGreaterThan(0);
  expect(lines(p.factoryLog)).toEqual([]);
}, T);

test("test: a row without a test command is 400 ui_integration_no_test and nothing runs", async () => {
  const { ui, p } = await started();
  const r = await api(ui, "/api/projects/work/integrations/cache/test", { method: "POST", body: {} });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("ui_integration_no_test");
  expect(String(r.json.fix).length).toBeGreaterThan(0);
  expect(lines(p.factoryLog)).toEqual([]);
}, T);

test("test: a GET is 405, and no token is 401", async () => {
  const { ui, p } = await started(NATS);
  expect((await api(ui, "/api/projects/work/integrations/hub/test")).status).toBe(405);
  expect((await api(ui, "/api/projects/work/integrations/hub/test", { method: "POST", body: {}, token: null })).status).toBe(401);
  expect(lines(p.factoryLog)).toEqual([]);
}, T);

test("test: the hub runs factory nats status, with no confirm, and answers its output", async () => {
  const { ui, p } = await started(NATS);
  const r = await api(ui, "/api/projects/work/integrations/hub/test", { method: "POST", body: {} });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toMatchObject({ ok: true, command: "factory nats status" });
  expect(String(r.json.output)).toContain("nats status");
  expect(lines(p.factoryLog)).toContain("nats status");
}, T);

test("test: ci runs factory ci status", async () => {
  const { ui, p } = await started();
  const r = await api(ui, "/api/projects/work/integrations/ci/test", { method: "POST", body: {} });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.command).toBe("factory ci status");
  expect(lines(p.factoryLog)).toContain("ci status");
}, T);

test("test: github runs gh auth status; when gh fails it is 500 with ok false and the error", async () => {
  const { ui, p } = await started({}, origin);
  const r = await api(ui, "/api/projects/work/integrations/github/test", { method: "POST", body: {} });
  expect(r.status).toBe(500);
  expect(r.json).toMatchObject({ ok: false, command: "gh auth status" });
  expect(typeof r.json.code).toBe("string");
  expect(String(r.json.message).length).toBeGreaterThan(0);
  expect(String(r.json.fix).length).toBeGreaterThan(0);
  expect(readFileSync(p.ghLog, "utf8")).toContain("gh auth status");
}, T);
