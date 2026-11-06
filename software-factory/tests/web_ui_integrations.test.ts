// The web UI's integrations page (#441): what the factory connects to (GitHub, the messaging hub, the CI runners, the
// plugins, the MCP connectors, the build cache), each one set up or not, its settings in plain words, and a test that
// asks it now. Read from the project's settings, its git remote, .mcp.json and the cockpit's cache (written by hand here);
// the tests go through a fake `gh`, a fake `factory` and small servers this file starts.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { git, tmp, write, writeExe } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const s of servers) s.stop(true);
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const CI: Row = {
  mode: "local", repo: "o/work", label: "work-local",
  runners: [{ name: "work-ci-m-here-1", status: "online", busy: true }, { name: "work-ci-m-here-2", status: "online", busy: false }],
  light: { label: "work-light", runners: [{ name: "work-ci-m-here.light-1", status: "online", busy: false }] },
  runs: [], errors: [],
};

function cache(p: Project, ci: Row = CI): void {
  write(join(p.state, "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), ci }));
}

async function started(cfg: Row = CONFIG, setup: (p: Project) => void = () => {}, env: Record<string, string> = {}): Promise<{ ui: Running; p: Project }> {
  const p = project(cfg);
  roots.push(p.root);
  setup(p);
  const ui = await startUi(p, ["--port", "0"], null, env);
  running.push(ui);
  return { ui, p };
}

function byId(r: { json: Row }): Record<string, Row> {
  return Object.fromEntries((r.json.integrations as Row[]).map((i) => [String(i.id), i]));
}

const NATS = { ...CONFIG, messaging: { transport: "nats", url: "nats://127.0.0.1:4222", kinds: ["wake", "claim"] } };

// --- the list ----------------------------------------------------------------------------------------------------------

test("lists GitHub, the hub, the CI runners, the plugins, the MCP connectors and the build cache, in that order", async () => {
  const { ui } = await started(CONFIG, (p) => {
    git(p.d, "remote", "add", "origin", "https://github.com/o/work.git");
    cache(p);
  });
  const r = await api(ui, "/api/projects/work/integrations");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.project).toBe("work");
  expect((r.json.integrations as Row[]).map((i) => i.id)).toEqual(["github", "messaging", "ci", "plugins", "mcp", "cache"]);
  const i = byId(r);
  expect(i.github).toMatchObject({ name: "GitHub", state: "ok", testable: true, problem: null });
  expect(String(i.github?.sub)).toContain("o/work");
  expect(String(i.github?.sub)).toContain("GitHub issues");
  // the hub, the connectors and the cache aren't set up in this project
  expect(i.messaging).toMatchObject({ name: "Messaging hub", state: "off", stateText: "Not set up" });
  expect(i.mcp).toMatchObject({ name: "MCP connectors", state: "off" });
  expect(i.cache).toMatchObject({ name: "Build cache", state: "off", testable: false });
  // the runners from the cockpit's cache: 2 heavy and the light lane online
  expect(i.ci).toMatchObject({ name: "CI runners", state: "ok" });
  expect(String(i.ci?.sub)).toContain("2 runners online");
  expect(r.json.counts).toEqual({ all: 6, bad: 0, off: expect.any(Number) });
}, T);

test("each one has its settings in plain words, never a setting's key", async () => {
  const { ui } = await started(NATS, (p) => git(p.d, "remote", "add", "origin", "git@github.com:o/work.git"));
  const i = byId(await api(ui, "/api/projects/work/integrations"));
  const settings = i.messaging?.settings as { label: string; value: string }[];
  expect(settings).toContainEqual({ label: "Address", value: "nats://127.0.0.1:4222" });
  expect(settings.find((s) => s.label === "Moved to the hub")?.value).toBe("wake, claim");
  for (const it of Object.values(i)) {
    for (const s of it.settings as { label: string }[]) expect(s.label, `${it.id}: ${s.label}`).not.toMatch(/^[a-z]+\.[a-zA-Z.]+$/);
  }
  expect(String(i.github?.sub)).toContain("o/work"); // an ssh remote is read too
  expect(i.messaging).toMatchObject({ state: "ok", testable: true });
}, T);

test("one that needs a fix says what is wrong and the step that fixes it, and the summary names it", async () => {
  // the hub is turned on without an address; no remote, so GitHub isn't known either
  const { ui } = await started({ ...CONFIG, messaging: { transport: "nats" } }, (p) => cache(p, { ...CI, runners: [], light: { runners: [] } }));
  const r = await api(ui, "/api/projects/work/integrations");
  const i = byId(r);
  expect(i.messaging).toMatchObject({ state: "bad", stateText: "Needs a fix" });
  const problem = i.messaging?.problem as Row;
  expect(problem.message).toMatch(/address/i);
  expect(String(problem.fix).length).toBeGreaterThan(0);
  expect(i.github).toMatchObject({ state: "bad" });
  expect(String((i.github?.problem as Row).message)).toMatch(/GitHub/);
  // local CI with no runner online: jobs wait
  expect(i.ci).toMatchObject({ state: "bad" });
  expect((r.json.counts as Row).bad).toBe(3);
  expect(String(r.json.summary)).toMatch(/^6 connections\. 3 need you/);
}, T);

test("CI on GitHub's runners is set up; with no snapshot yet it says so", async () => {
  const gh = await started(CONFIG, (p) => cache(p, { ...CI, mode: "github", runners: [], light: { runners: [] } }));
  expect(byId(await api(gh.ui, "/api/projects/work/integrations")).ci).toMatchObject({ state: "ok" });
  expect(String(byId(await api(gh.ui, "/api/projects/work/integrations")).ci?.sub)).toMatch(/GitHub's runners/);
  const none = await started();
  expect(byId(await api(none.ui, "/api/projects/work/integrations")).ci).toMatchObject({ state: "unknown", stateText: "Not read yet" });
}, T);

test("the MCP connectors are the servers in .mcp.json; a broken file needs a fix", async () => {
  const ok = await started(CONFIG, (p) => write(join(p.d, ".mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: "npx" }, linear: { url: "https://x" } } })));
  const mcp = byId(await api(ok.ui, "/api/projects/work/integrations")).mcp as Row;
  expect(mcp).toMatchObject({ state: "ok", testable: false });
  expect(String(mcp.sub)).toContain("playwright");
  expect(String(mcp.sub)).toContain("linear");
  const bad = await started(CONFIG, (p) => write(join(p.d, ".mcp.json"), "{ not json"));
  expect(byId(await api(bad.ui, "/api/projects/work/integrations")).mcp).toMatchObject({ state: "bad" });
}, T);

test("the plugins: the hub needs the NATS plugin, and it is there in this checkout", async () => {
  const { ui } = await started(NATS);
  const plugins = byId(await api(ui, "/api/projects/work/integrations")).plugins as Row;
  expect(plugins.state).toBe("ok");
  expect(String(plugins.sub)).toMatch(/NATS/);
  const off = await started();
  expect(byId(await api(off.ui, "/api/projects/work/integrations")).plugins).toMatchObject({ state: "off" });
}, T);

test("the build cache is set up when its address is", async () => {
  const { ui } = await started({ ...CONFIG, turbo: { api: "http://127.0.0.1:3335" } });
  const cacheRow = byId(await api(ui, "/api/projects/work/integrations")).cache as Row;
  expect(cacheRow).toMatchObject({ state: "ok", testable: true });
  expect(String(cacheRow.sub)).toContain("127.0.0.1:3335");
}, T);

test("reading the page asks no one: no gh call, no factory command", async () => {
  const { ui, p } = await started(NATS, (p) => cache(p));
  await api(ui, "/api/projects/work/integrations");
  expect(readFileSync(p.ghLog, "utf8")).not.toContain("api user");
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
}, T);

// --- the tests ---------------------------------------------------------------------------------------------------------

test("testing GitHub asks who is signed in", async () => {
  const { ui } = await started(CONFIG, (p) => git(p.d, "remote", "add", "origin", "https://github.com/o/work.git"));
  const r = await api(ui, "/api/projects/work/integrations/github/test", { method: "POST", body: {} });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toMatchObject({ ok: true, id: "github" });
  expect(String(r.json.message)).toContain("me"); // the fake gh's login
}, T);

test("a GitHub test that fails says what is wrong and how to sign in again", async () => {
  const bin = tmp("factory-ui-gh-");
  roots.push(bin);
  writeExe(join(bin, "gh"), "#!/usr/bin/env bash\necho 'HTTP 401: Bad credentials' >&2\nexit 1\n");
  const { ui } = await started(CONFIG, (p) => git(p.d, "remote", "add", "origin", "https://github.com/o/work.git"),
    { PATH: `${bin}:${process.env.PATH ?? ""}` });
  const r = await api(ui, "/api/projects/work/integrations/github/test", { method: "POST", body: {} });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ ok: false, id: "github" });
  expect(String(r.json.message)).toContain("Bad credentials");
  expect(String(r.json.fix)).toMatch(/sign in/i);
}, T);

test("testing the hub connects to its address; one nobody answers at fails with a fix", async () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  servers.push(listener);
  const up = await started({ ...CONFIG, messaging: { transport: "nats", url: `nats://127.0.0.1:${listener.port}` } });
  const r = await api(up.ui, "/api/projects/work/integrations/messaging/test", { method: "POST", body: {} });
  expect(r.json, JSON.stringify(r.json)).toMatchObject({ ok: true, id: "messaging" });
  const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = closed.port;
  closed.stop(true);
  const down = await started({ ...CONFIG, messaging: { transport: "nats", url: `nats://127.0.0.1:${port}` } });
  const f = await api(down.ui, "/api/projects/work/integrations/messaging/test", { method: "POST", body: {} });
  expect(f.status).toBe(200);
  expect(f.json).toMatchObject({ ok: false, id: "messaging" });
  expect(String(f.json.message)).toContain(`127.0.0.1:${port}`);
  expect(String(f.json.fix).length).toBeGreaterThan(0);
}, T);

test("testing the build cache asks its address", async () => {
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  servers.push(srv);
  const { ui } = await started({ ...CONFIG, turbo: { api: `http://127.0.0.1:${srv.port}` } });
  const r = await api(ui, "/api/projects/work/integrations/cache/test", { method: "POST", body: {} });
  expect(r.json, JSON.stringify(r.json)).toMatchObject({ ok: true, id: "cache" });
}, T);

test("a build cache nobody answers at fails with a fix", async () => {
  const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = gone.port;
  gone.stop(true);
  const { ui } = await started({ ...CONFIG, turbo: { api: `http://127.0.0.1:${port}` } });
  const r = await api(ui, "/api/projects/work/integrations/cache/test", { method: "POST", body: {} });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ ok: false, id: "cache", code: "ui_test_cache" });
  expect(String(r.json.message)).toContain(`127.0.0.1:${port}`);
  expect(String(r.json.fix).length).toBeGreaterThan(0);
}, T);

test("testing CI runs the project's CI status", async () => {
  const { ui, p } = await started(CONFIG, (p) => cache(p));
  const r = await api(ui, "/api/projects/work/integrations/ci/test", { method: "POST", body: {} });
  expect(r.json, JSON.stringify(r.json)).toMatchObject({ ok: true, id: "ci" });
  expect(readFileSync(p.factoryLog, "utf8")).toContain("ci status");
}, T);

test("a test of one not set up, one with no test, or one that isn't there is refused with a fix", async () => {
  const { ui } = await started();
  const off = await api(ui, "/api/projects/work/integrations/cache/test", { method: "POST", body: {} });
  expect(off.status).toBe(409);
  expect(off.json).toMatchObject({ code: "ui_integration_not_set_up" });
  expect(String(off.json.fix).length).toBeGreaterThan(0);
  const none = await api(ui, "/api/projects/work/integrations/mcp/test", { method: "POST", body: {} });
  expect(none.status).toBe(409);
  expect(none.json).toMatchObject({ code: "ui_integration_no_test" });
  const unknown = await api(ui, "/api/projects/work/integrations/slack/test", { method: "POST", body: {} });
  expect(unknown.status).toBe(404);
  expect(unknown.json).toMatchObject({ code: "ui_integration_unknown" });
  const get = await api(ui, "/api/projects/work/integrations/github/test");
  expect(get.status).toBe(405);
}, T);

test("the integrations need the token", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/integrations", { token: null });
  expect(r.status).toBe(401);
  const t = await api(ui, "/api/projects/work/integrations/github/test", { method: "POST", body: {}, token: "wrong" });
  expect(t.status).toBe(401);
}, T);

// --- what each agent may use -------------------------------------------------------------------------------------------

test("what each agent may use: every agent with its role, and each connector that is set up", async () => {
  const cfg = { ...NATS, turbo: { api: "http://127.0.0.1:3335" } };
  const { ui } = await started(cfg, (p) => {
    git(p.d, "remote", "add", "origin", "https://github.com/o/work.git");
    write(join(p.d, ".mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }));
  });
  const r = await api(ui, "/api/projects/work/integrations");
  const uses = r.json.uses as Row;
  expect(uses.perAgent).toBe(false); // no setting chooses them per agent yet: every agent gets the same
  expect(String(uses.note).length).toBeGreaterThan(0);
  const cols = (uses.connectors as Row[]).map((c) => c.id);
  expect(cols).toEqual(["github", "messaging", "cache", "mcp:playwright"]);
  expect((uses.connectors as Row[]).map((c) => c.label)).toEqual(["GitHub", "Hub", "Build cache", "playwright"]);
  const agents = uses.agents as Row[];
  expect(agents.map((a) => [a.name, a.role])).toEqual([["mentewab", "Product owner"], ["fasil", "Dev manager"],
    ["menelik", "Builder"], ["taytu", "Builder"]]);
  for (const a of agents) expect(a.uses).toEqual(cols);
}, T);

test("a connector that isn't set up is no column", async () => {
  const { ui } = await started(CONFIG, (p) => git(p.d, "remote", "add", "origin", "https://github.com/o/work.git"));
  const uses = (await api(ui, "/api/projects/work/integrations")).json.uses as Row;
  expect((uses.connectors as Row[]).map((c) => c.id)).toEqual(["github"]);
}, T);

// --- the build cache: turn it on and off -------------------------------------------------------------------------------

test("the build cache offers to turn it on when it is off, and to turn it off when it is on", async () => {
  const off = byId(await api((await started()).ui, "/api/projects/work/integrations"));
  expect((off.cache?.actions as Row[]).map((a) => a.name)).toEqual(["start"]);
  expect(String((off.cache?.actions as Row[])[0]?.does).length).toBeGreaterThan(0);
  const on = byId(await api((await started({ ...CONFIG, turbo: { api: "http://127.0.0.1:3335" } })).ui, "/api/projects/work/integrations"));
  expect((on.cache?.actions as Row[]).map((a) => a.name)).toEqual(["stop"]);
  for (const id of ["github", "messaging", "ci", "plugins", "mcp"]) expect(on[id]?.actions, id).toEqual([]);
}, T);

test("turning the build cache on asks first, then runs it on this machine", async () => {
  const { ui, p } = await started();
  const path = "/api/projects/work/integrations/cache/actions/start";
  const no = await api(ui, path, { method: "POST", body: {} });
  expect(no.status).toBe(400);
  expect(no.json).toMatchObject({ code: "confirm_needed" });
  expect(readFileSync(p.factoryLog, "utf8")).toBe(""); // nothing ran
  const yes = await api(ui, path, { method: "POST", body: { confirm: true } });
  expect(yes.status, JSON.stringify(yes.json)).toBe(200);
  expect(yes.json).toMatchObject({ ok: true });
  expect(readFileSync(p.factoryLog, "utf8")).toContain("turbo install");
}, T);

test("turning it off runs turbo down; an action it doesn't offer now, or one it has none of, is refused", async () => {
  const { ui, p } = await started({ ...CONFIG, turbo: { api: "http://127.0.0.1:3335" } });
  const base = "/api/projects/work/integrations";
  const stop = await api(ui, `${base}/cache/actions/stop`, { method: "POST", body: { confirm: true } });
  expect(stop.json, JSON.stringify(stop.json)).toMatchObject({ ok: true });
  expect(readFileSync(p.factoryLog, "utf8")).toContain("turbo down");
  const start = await api(ui, `${base}/cache/actions/start`, { method: "POST", body: { confirm: true } });
  expect(start.status).toBe(409);
  expect(start.json).toMatchObject({ code: "ui_action_unavailable" });
  const none = await api(ui, `${base}/github/actions/start`, { method: "POST", body: { confirm: true } });
  expect(none.status).toBe(409);
  const unknown = await api(ui, `${base}/slack/actions/start`, { method: "POST", body: { confirm: true } });
  expect(unknown.status).toBe(404);
  const get = await api(ui, `${base}/cache/actions/stop`);
  expect(get.status).toBe(405);
}, T);
