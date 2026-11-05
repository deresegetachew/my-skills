// `factory ui` (#421, decision 0005): a Bun server on this machine serving the web app and a JSON API, bound to
// localhost (and with --host the Tailscale address), with a token printed on start and kept in .git/factory/ui-token
// (mode 600), required on every API call and the WebSocket. The app shell's data: the projects (this one plus
// `ui.projects`) and each project's channels (one per agent, one per view). Run against the real server on a free port.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, project, startUi, type Running } from "./web_ui_support.ts";
import { BUN, CI, copyHookFolders, HOOKS, readmeAndWiki, SF, sh, write, writeExe } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

async function started(p = project(), args?: string[]): Promise<{ ui: Running; p: ReturnType<typeof project> }> {
  roots.push(p.root);
  const ui = await startUi(p, args);
  running.push(ui);
  return { ui, p };
}

function ui(p: ReturnType<typeof project>, args: string[], env: Record<string, string | undefined> = {}) {
  return sh([...BUN, join(HOOKS, "factory_ui.ts"), ...args], { cwd: p.d, env: { ...p.env, ...env }, timeoutMs: 30_000 });
}

// --- the command ------------------------------------------------------------------------------------------------------

test("factory help lists factory ui, and the commands and settings pages describe it", () => {
  const p = project();
  roots.push(p.root);
  const help = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(help.code, help.out).toBe(0);
  expect(help.stdout).toContain("ui [--port N] [--host]");
  const commands = readmeAndWiki("commands.md");
  expect(commands).toContain("| `factory ui [--port N] [--host]` |");
  const settings = readmeAndWiki("settings.md");
  expect(settings).toContain("**Web UI**");
  for (const key of ["ui.projects", "ui.port", "ui.pollSeconds"]) expect(settings).toContain(`\`${key}\``);
});

test("factory ui prints the local address with its token and keeps the token in .git/factory/ui-token, mode 600", async () => {
  const { ui: u, p } = await started();
  expect(u.out).toContain("factory ui: serving work");
  expect(u.out).toMatch(/open: http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
  expect(u.out).toContain("Ctrl-C stops it.");
  expect(u.out).not.toContain("tailscale");
  const file = join(p.d, ".git", "factory", "ui-token");
  expect(readFileSync(file, "utf8").trim()).toBe(u.token);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(u.token.length).toBeGreaterThanOrEqual(32);
}, T);

test("a second start keeps the same token, so an open page keeps working", async () => {
  const p = project();
  const first = await started(p);
  await first.ui.stop();
  const second = await started(p);
  expect(second.ui.token).toBe(first.ui.token);
}, T);

test("factory ui through the factory script serves the app built from the source beside it", async () => {
  const p = project();
  roots.push(p.root);
  const hooks = join(p.d, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(hooks, f));
  copyHookFolders(hooks);
  cpSync(CI, join(p.d, ".claude", "ci"), { recursive: true });
  const u = await startUi(p, ["ui", "--port", "0"], ["bash", join(SF, "factory")]);
  running.push(u);
  const page = await fetch(u.url + "/");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain('<div id="root">');
  expect(html).toContain('src="/app.js"');
  const js = await fetch(u.url + "/app.js");
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("javascript");
  expect((await js.text()).length).toBeGreaterThan(10_000);
}, T);

test("--host without tailscale is refused with what to do, and nothing is served", () => {
  const p = project();
  roots.push(p.root);
  const r = ui(p, ["--port", "0", "--host"], { PATH: `${join(p.root, "bin")}:/usr/bin:/bin` });
  expect(r.code).toBe(1);
  const err = JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as Record<string, string>;
  expect(err.code).toBe("tailscale_missing");
  expect(err.fix).toContain("tailscale");
});

test("--host adds the Tailscale address `tailscale ip -4` gives", async () => {
  const p = project();
  writeExe(join(p.root, "bin", "tailscale"), '#!/bin/sh\n[ "$1 $2" = "ip -4" ] && echo 127.0.0.1\n');
  const { ui: u } = await started(p, ["--port", "0", "--host"]);
  expect(u.out).toMatch(/tailscale: http:\/\/127\.0\.0\.1:\d+\/\?token=/);
}, T);

test("an agent session can't start the web UI, and no token is written", () => {
  const p = project();
  roots.push(p.root);
  const r = ui(p, ["--port", "0"], { FACTORY_AGENT: "menelik", FACTORY_LOOP: "1" });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('"code": "owner_only"');
  expect(existsSync(join(p.d, ".git", "factory", "ui-token"))).toBe(false);
});

test("an unknown option prints the usage and exits 2", () => {
  const p = project();
  roots.push(p.root);
  const r = ui(p, ["--bogus"]);
  expect(r.code).toBe(2);
  expect(r.out).toContain("usage: factory ui [--port N] [--host]");
  expect(ui(p, ["--help"]).stdout).toContain("usage: factory ui [--port N] [--host]");
});

// --- the token ---------------------------------------------------------------------------------------------------------

test("every API call and the WebSocket need the token: none is 401 ui_token_missing, a wrong one ui_token_wrong", async () => {
  const { ui: u } = await started();
  const none = await api(u, "/api/projects", { token: null });
  expect(none.status).toBe(401);
  expect(none.type).toContain("application/json");
  expect(none.json.code).toBe("ui_token_missing");
  expect(String(none.json.fix)).toContain("ui-token");
  const wrong = await api(u, "/api/projects", { token: "x".repeat(43) });
  expect(wrong.status).toBe(401);
  expect(wrong.json.code).toBe("ui_token_wrong");
  expect((await api(u, "/api/projects/work/channels", { token: null })).status).toBe(401);
  const ws = await fetch(u.url + "/api/ws", { headers: { upgrade: "websocket", connection: "Upgrade" } });
  expect(ws.status).toBe(401);
  const bad = await fetch(u.url + "/api/ws?token=nope", { headers: { upgrade: "websocket", connection: "Upgrade" } });
  expect(bad.status).toBe(401);
  // the page itself carries no data and opens without it
  expect((await fetch(u.url + "/")).status).toBe(200);
}, T);

test("an unknown API path is 404 with {code, message, fix}", async () => {
  const { ui: u } = await started();
  const r = await api(u, "/api/nothing");
  expect(r.status).toBe(404);
  expect(r.json.code).toBe("not_found");
  expect(typeof r.json.message).toBe("string");
  expect(typeof r.json.fix).toBe("string");
}, T);

// --- projects and channels -------------------------------------------------------------------------------------------

test("/api/projects lists this project first, then each of ui.projects; a path that isn't a project says so", async () => {
  const other = project({ agents: ["haile"] }, "shop");
  roots.push(other.root);
  const p = project({ ...CONFIG, ui: { pollSeconds: 1, projects: [other.d, join(other.root, "gone")] } });
  const { ui: u } = await started(p);
  const r = await api(u, "/api/projects");
  expect(r.status).toBe(200);
  const projects = r.json.projects as Record<string, unknown>[];
  expect(projects.map((x) => x.id)).toEqual(["work", "shop", "gone"]);
  expect(projects[0]).toMatchObject({ name: "work", current: true });
  expect(projects[1]).toMatchObject({ name: "shop", current: false, problem: null });
  expect((projects[2]?.problem as Record<string, string>).code).toBe("ui_project_missing");
}, T);

test("a project's channels: one per agent (coding agents, the dev manager, the product owner) and one per view", async () => {
  const { ui: u } = await started();
  const r = await api(u, "/api/projects/work/channels");
  expect(r.status).toBe(200);
  const channels = r.json.channels as Record<string, unknown>[];
  const agents = channels.filter((c) => c.kind === "agent");
  expect(agents.map((c) => [c.name, c.role])).toEqual([["fasil", "dev-manager"], ["mentewab", "product-owner"],
    ["menelik", "coding-agent"], ["taytu", "coding-agent"]]);
  const views = channels.filter((c) => c.kind === "view").map((c) => c.name);
  expect(views).toEqual(["tasks", "pull-requests", "ci", "owner-queue", "machines"]);
  for (const c of channels) expect(c.id).toBe(`${c.kind}:${c.name}`);
}, T);

test("the channels of a project from ui.projects come from its own factory.json", async () => {
  const other = project({ agents: ["haile"] }, "shop");
  roots.push(other.root);
  const p = project({ ...CONFIG, ui: { projects: [other.d] } });
  const { ui: u } = await started(p);
  const r = await api(u, "/api/projects/shop/channels");
  expect(r.status).toBe(200);
  const names = (r.json.channels as Record<string, unknown>[]).filter((c) => c.kind === "agent" && c.role === "coding-agent").map((c) => c.name);
  expect(names).toEqual(["haile"]);
}, T);

test("an unknown project is 404 ui_project_unknown", async () => {
  const { ui: u } = await started();
  const r = await api(u, "/api/projects/nope/channels");
  expect(r.status).toBe(404);
  expect(r.json.code).toBe("ui_project_unknown");
}, T);

test("the ui settings are checked: a port that isn't a number fails validate", () => {
  const p = project({ ui: { port: "high" } });
  roots.push(p.root);
  write(join(p.d, ".claude", "factory.json"), JSON.stringify({ ui: { port: "high" } }));
  const r = sh([...BUN, join(HOOKS, "factory_settings.ts"), "validate"], { cwd: p.d, env: p.env });
  expect(r.code).toBe(1);
  expect(r.out).toContain("ui.port");
});
