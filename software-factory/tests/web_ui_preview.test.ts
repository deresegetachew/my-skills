// Open preview on a sign-off item (#582): the hub checks out the item's commit (main, or the open pull request's head)
// in a temporary worktree, runs the project's `preview.command` there on a free port with PORT set, waits for
// `preview.health`, and serves it on its own origin (a second port) at /preview/<project>/<item>/, behind that preview's
// own token, set as a cookie through a one-time link. The web UI's token is never accepted there, and the UI's API
// refuses a page from the preview origin. A preview stops when the item gets a result (signed off or sent back), after
// `preview.idleMinutes` with no request, or on Stop; its worktree goes and its whole process group is killed. A tiny fake
// app, committed in the test project, is what the preview runs.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { api, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { git, write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// The fake app: answers /healthz, / (the version file of the commit it runs on), /echo (what it was sent), /env (its
// environment's names), /go (a redirect to /echo) and /ws (a WebSocket echo). It starts a child that sleeps, so stopping
// it must kill the whole group; both pids go to $FAKE_APP_PIDS (which reaches it through agentEnv).
const APP = `import { appendFileSync, readFileSync } from "node:fs";
const child = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });
if (process.env.FAKE_APP_PIDS) appendFileSync(process.env.FAKE_APP_PIDS, process.pid + "\\n" + child.pid + "\\n");
const host = process.env.FAKE_APP_HOST || "127.0.0.1";
Bun.serve({ hostname: host, port: Number(process.env.PORT), websocket: { message(ws, m) { ws.send("echo:" + m); } }, fetch(req, server) {
  const u = new URL(req.url);
  if (u.pathname === "/ws" && server.upgrade(req, { data: undefined })) return undefined;
  if (u.pathname === "/healthz") return new Response("ok");
  if (u.pathname === "/echo") return Response.json({ path: u.pathname, search: u.search, headers: Object.fromEntries(req.headers) });
  if (u.pathname === "/env") return Response.json(process.env);
  if (u.pathname === "/go") return new Response(null, { status: 302, headers: { location: "/echo" } });
  return new Response(readFileSync("version.txt", "utf8"));
} });
console.log("fake app listening on " + process.env.PORT);
`;

const c = (body: string, login: string, at: string): Row => ({ body, created_at: at, user: { login } });

interface Started {
  ui: Running;
  p: Project;
  main: string;
  pids: string;
}

/** A project whose main has the fake app and `preview` settings, a sign-off queue with two items (task 12 and 13), and
 * the web UI running. `branch` adds task/12-x (an open pull request for task 12) with its own version file. */
async function started(preview: Row, opts: { env?: Record<string, string>; branch?: boolean; appHost?: string } = {}): Promise<Started> {
  const p = project({ tasks: { source: "issues" }, agents: ["menelik"], ui: { pollSeconds: 1 }, preview });
  roots.push(p.root);
  const pids = join(p.root, "pids");
  write(pids, "");
  // what the app gets besides PATH, HOME, PORT and HOST: the project's agentEnv, its secrets' names left out
  write(join(p.d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik"], ui: { pollSeconds: 1 }, preview,
    agentEnv: { FAKE_APP_PIDS: pids, FAKE_APP_HOST: opts.appHost ?? "", APP_DB: "shop{suffix}", APP_PORT: "{port:4100}", GH_TOKEN: "from-agentenv",
      MB_URL: "postgres://from-agentenv" } }));
  write(join(p.d, "app.ts"), APP);
  write(join(p.d, "version.txt"), "main-1\n");
  git(p.d, "add", "-A");
  git(p.d, "commit", "-q", "-m", "app");
  const main = git(p.d, "rev-parse", "HEAD").trim();
  if (opts.branch) {
    git(p.d, "checkout", "-q", "-b", "task/12-x");
    write(join(p.d, "version.txt"), "pr-12\n");
    git(p.d, "commit", "-q", "-am", "pr");
    const head = git(p.d, "rev-parse", "HEAD").trim();
    git(p.d, "checkout", "-q", "main");
    write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
      pulls: [{ number: 7, title: "Task 12", branch: "task/12-x", head, draft: false }] }));
  }
  write(join(p.d, "version.txt"), "not committed\n"); // the folder's own copy is never what runs
  write(join(p.root, "db.json"), JSON.stringify({
    issues: [{ number: 50, title: "Sign-off and testing queue", body: "", state: "open", labels: [] }],
    comments: { "50": [
      c("<!-- factory-signoff id=label-check task=12 -->\nTo check: Read the label", "fasil", "2026-11-05T09:00:00Z"),
      c("<!-- factory-signoff id=other-check task=13 -->\nTo check: Read the other", "fasil", "2026-11-05T09:10:00Z"),
    ] },
  }));
  const ui = await startUi(p, ["--port", "0"], null, opts.env ?? {});
  running.push(ui);
  return { ui, p, main, pids };
}

const BASE = "/api/projects/work/signoff";
const APP_CMD = { command: "bun --no-env-file app.ts", health: "/healthz" };

/** The preview's status, asked until `done` says so (or `ms` pass). */
async function waitFor(ui: Running, id: string, done: (s: Row) => boolean, ms = 30_000): Promise<Row> {
  const end = Date.now() + ms;
  let s: Row = {};
  while (Date.now() < end) {
    s = (await api(ui, `${BASE}/${id}/preview`)).json;
    if (done(s)) return s;
    await Bun.sleep(200);
  }
  return s;
}

const isRunning = (s: Row): boolean => s.state === "running";
const ended = (s: Row): boolean => s.state === "failed" || s.state === "stopped" || s.state === "none";

/** Starts the item's preview and waits until it runs. */
async function runningPreview(ui: Running, id: string): Promise<Row> {
  const r = await api(ui, `${BASE}/${id}/preview`, { method: "POST" });
  expect([200, 202]).toContain(r.status);
  const s = await waitFor(ui, id, (x) => isRunning(x) || ended(x));
  expect(s.state, JSON.stringify(s)).toBe("running");
  return s;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidsOf(file: string): number[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

async function allDead(pids: number[], ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pids.some(alive)) return true;
    await Bun.sleep(100);
  }
  return !pids.some(alive);
}

/** The worktrees git lists for the project, besides the project folder itself. */
function worktrees(p: Project): string[] {
  return git(p.d, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9)).filter((d) => !d.endsWith(`/${"work"}`));
}

function previewDirs(p: Project): string[] {
  const d = join(p.state, "previews");
  return existsSync(d) ? readdirSync(d) : [];
}

/** The preview origin: the UI's host on the port the status gives. */
async function originOf(ui: Running): Promise<string> {
  const port = (await api(ui, `${BASE}/label-check/preview`)).json.port as number;
  expect(port).toBeGreaterThan(0);
  expect(ui.url).not.toBe(`http://127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

async function get(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(base + path, { redirect: "manual", ...init });
}

/** Opens the item's one-time link on the preview origin: the cookie it sets ("factory_preview=..."). */
async function cookieFor(ui: Running, id: string): Promise<{ origin: string; cookie: string }> {
  const link = await api(ui, `${BASE}/${id}/preview/link`, { method: "POST" });
  expect(link.status, JSON.stringify(link.json)).toBe(200);
  const path = String(link.json.path);
  expect(path).toStartWith(`/preview/work/${id}/?code=`);
  const origin = `http://127.0.0.1:${link.json.port as number}`;
  const r = await get(origin, path);
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe(`/preview/work/${id}/`);
  const set = r.headers.get("set-cookie") ?? "";
  expect(set).toContain("HttpOnly");
  expect(set).toContain("SameSite=Strict");
  expect(set).toContain(`Path=/preview/work/${id}/`);
  expect(set).not.toContain(ui.token);
  return { origin, cookie: set.split(";")[0] as string };
}

test("Open preview starts the app on main's commit, and its link answers on the preview origin", async () => {
  const { ui, p, main } = await started(APP_CMD);
  const r = await api(ui, `${BASE}/label-check/preview`, { method: "POST" });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect(r.json).toMatchObject({ state: "starting", commit: main, path: "/preview/work/label-check/" });
  const s = await waitFor(ui, "label-check", (x) => isRunning(x) || ended(x));
  expect(s.state, JSON.stringify(s)).toBe("running");
  expect((s.output as string[]).join("\n")).toContain("fake app listening on");
  expect(worktrees(p).length).toBe(1);
  const { origin, cookie } = await cookieFor(ui, "label-check");
  const page = await get(origin, "/preview/work/label-check/", { headers: { cookie } });
  expect(page.status).toBe(200);
  expect(await page.text()).toBe("main-1\n");
  // the UI's own origin serves no preview
  expect((await get(ui.url, "/preview/work/label-check/", { headers: { cookie, authorization: `Bearer ${ui.token}` } })).status).toBe(404);
}, T);

test("the item's open pull request is what runs: its head, not main", async () => {
  const { ui } = await started(APP_CMD, { branch: true });
  const r = await api(ui, `${BASE}/label-check/preview`, { method: "POST" });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect(r.json.pr).toBe(7);
  expect(isRunning(await waitFor(ui, "label-check", (x) => isRunning(x) || ended(x)))).toBe(true);
  const { origin, cookie } = await cookieFor(ui, "label-check");
  expect(await (await get(origin, "/preview/work/label-check/", { headers: { cookie } })).text()).toBe("pr-12\n");
}, T);

test("the preview origin takes only that preview's cookie: not the UI token, not a used link, not another item's", async () => {
  const { ui } = await started(APP_CMD);
  await runningPreview(ui, "label-check");
  await runningPreview(ui, "other-check");
  const origin = await originOf(ui);
  const none = await get(origin, "/preview/work/label-check/echo");
  expect(none.status).toBe(401);
  expect(((await none.json()) as Row).code).toBe("preview_token_wrong");
  // the UI's token, in every form, is refused there
  const tries: Record<string, string>[] = [{ authorization: `Bearer ${ui.token}` }, { cookie: `factory_preview=${ui.token}` }, { cookie: `factory_ui=${ui.token}` }];
  for (const headers of tries) {
    expect((await get(origin, "/preview/work/label-check/echo", { headers })).status).toBe(401);
  }
  expect((await get(origin, `/preview/work/label-check/echo?token=${ui.token}`)).status).toBe(401);
  // a link works once
  const link = await api(ui, `${BASE}/label-check/preview/link`, { method: "POST" });
  expect((await get(origin, String(link.json.path))).status).toBe(303);
  expect((await get(origin, String(link.json.path))).status).toBe(401);
  // one item's cookie doesn't open another item's preview
  const a = await cookieFor(ui, "label-check");
  expect((await get(origin, "/preview/work/label-check/", { headers: { cookie: a.cookie } })).status).toBe(200);
  expect((await get(origin, "/preview/work/other-check/", { headers: { cookie: a.cookie } })).status).toBe(401);
  // the preview origin has no API
  for (const path of ["/api/projects", "/api/ws", "/", "/app.js"]) {
    const r = await get(origin, path, { headers: { cookie: a.cookie, authorization: `Bearer ${ui.token}` } });
    expect(r.status, path).toBe(404);
    expect(JSON.stringify(await r.text())).not.toContain("work");
  }
}, T);

test("the UI's API refuses a request from the preview origin, even with the preview cookie, and allows no other origin", async () => {
  const { ui } = await started(APP_CMD);
  await runningPreview(ui, "label-check");
  const { origin, cookie } = await cookieFor(ui, "label-check");
  const r = await get(ui.url, "/api/projects", { headers: { origin, cookie } });
  expect(r.status).toBe(403);
  expect(((await r.json()) as Row).code).toBe("ui_cross_origin");
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
  // even with the UI's token (a page that stole it): another origin is refused
  const stolen = await get(ui.url, `${BASE}/label-check/preview`, { method: "DELETE", headers: { origin, cookie, authorization: `Bearer ${ui.token}` } });
  expect(stolen.status).toBe(403);
  expect(isRunning((await api(ui, `${BASE}/label-check/preview`)).json)).toBe(true);
  const pre = await get(ui.url, "/api/projects", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
  expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  // the UI's own page: not to be framed, nor loaded from another origin
  const page = await get(ui.url, "/");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect((await get(ui.url, "/app.js")).headers.get("cross-origin-resource-policy")).toBe("same-origin");
}, T);

test("what the app gets: no preview cookie, no UI token, a small environment with the project's agentEnv", async () => {
  const { ui } = await started(APP_CMD, { env: { GH_TOKEN: "gh-secret", GITHUB_TOKEN: "github-secret", ANTHROPIC_API_KEY: "anthropic-secret",
    FACTORY_UI_TOKEN: "ui-secret" } });
  await runningPreview(ui, "label-check");
  const { origin, cookie } = await cookieFor(ui, "label-check");
  const viaCookie = await get(origin, "/preview/work/label-check/echo?a=1", { headers: { cookie: `theirs=1; ${cookie}` } });
  expect(viaCookie.status).toBe(200);
  const seen = (await viaCookie.json()) as Row;
  expect(seen.search).toBe("?a=1");
  expect((seen.headers as Row).cookie).toBe("theirs=1");
  expect(JSON.stringify(seen)).not.toContain(cookie.split("=")[1] as string);
  expect(JSON.stringify(seen)).not.toContain(ui.token);
  // a redirect the app gives stays under the preview's address
  const go = await get(origin, "/preview/work/label-check/go", { headers: { cookie } });
  expect(go.status).toBe(302);
  expect(go.headers.get("location")).toBe("/preview/work/label-check/echo");
  const env = (await (await get(origin, "/preview/work/label-check/env", { headers: { cookie } })).json()) as Record<string, string>;
  expect(env.PORT).toMatch(/^\d+$/);
  expect(env.HOST).toBe("127.0.0.1");
  expect(env.PATH).toBeTruthy();
  expect(env.APP_DB).toBe("shop");
  expect(env.APP_PORT).toBe("4100");
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "FACTORY_UI_TOKEN", "MB_URL", "FAKE_DB", "XDG_STATE_HOME", "CLAUDE_PROJECT_DIR"]) {
    expect(env[k], k).toBeUndefined();
  }
  expect(JSON.stringify(env)).not.toContain("secret");
  expect(JSON.stringify(env)).not.toContain(ui.token);
}, T);

/** Opens a WebSocket to the preview, sends `text` and gives the first answer, or "refused" when it never opens. */
function wsTry(origin: string, headers: Record<string, string>, text: string): Promise<string> {
  return new Promise((resolve) => {
    // Bun's WebSocket takes headers (a browser sends the cookie by itself)
    const BunSocket = WebSocket as unknown as new (url: string, o: { headers: Record<string, string> }) => WebSocket;
    const ws = new BunSocket(`${origin.replace("http", "ws")}/preview/work/label-check/ws`, { headers });
    const timer = setTimeout(() => { ws.close(); resolve("timeout"); }, 5000);
    ws.onopen = () => ws.send(text);
    ws.onmessage = (e) => { clearTimeout(timer); ws.close(); resolve(String(e.data)); };
    ws.onerror = () => { clearTimeout(timer); resolve("refused"); };
  });
}

test("a WebSocket goes through to the app with the preview's cookie, and is refused with the UI token", async () => {
  const { ui } = await started(APP_CMD);
  await runningPreview(ui, "label-check");
  const { origin, cookie } = await cookieFor(ui, "label-check");
  expect(await wsTry(origin, { cookie }, "hi")).toBe("echo:hi");
  expect(await wsTry(origin, { authorization: `Bearer ${ui.token}` }, "hi")).toBe("refused");
  expect(await wsTry(origin, {}, "hi")).toBe("refused");
}, T);

test("a result on the item (signed off) stops the preview, kills its processes, removes its worktree, and its cookie is dead", async () => {
  const { ui, p, pids } = await started(APP_CMD);
  await runningPreview(ui, "label-check");
  const { origin, cookie } = await cookieFor(ui, "label-check");
  const procs = pidsOf(pids);
  expect(procs.length).toBe(2);
  const r = await api(ui, `${BASE}/label-check/result`, { method: "POST", body: { outcome: "pass" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const s = await waitFor(ui, "label-check", ended);
  expect(s.state).toBe("stopped");
  expect(String(s.reason)).toContain("signed off");
  expect(await allDead(procs)).toBe(true);
  expect(worktrees(p)).toEqual([]);
  expect(previewDirs(p)).toEqual([]);
  const after = await get(origin, "/preview/work/label-check/", { headers: { cookie } });
  expect(after.status).toBe(404);
  expect(((await after.json()) as Row).code).toBe("preview_not_running");
  // a new preview of the same item has a new token: the old cookie stays dead
  await runningPreview(ui, "label-check");
  expect((await get(origin, "/preview/work/label-check/", { headers: { cookie } })).status).toBe(401);
  expect((await api(ui, `${BASE}/other-check/preview/link`, { method: "POST" })).json.code).toBe("preview_not_running");
}, T);

test("sent back (a fail) stops it too, and Stop preview does", async () => {
  const { ui, p } = await started(APP_CMD);
  await runningPreview(ui, "label-check");
  await api(ui, `${BASE}/label-check/result`, { method: "POST", body: { outcome: "fail", note: "The label is cut off" } });
  expect(String((await waitFor(ui, "label-check", ended)).reason)).toContain("sent back");
  await runningPreview(ui, "other-check");
  const stop = await api(ui, `${BASE}/other-check/preview`, { method: "DELETE" });
  expect(stop.status, JSON.stringify(stop.json)).toBe(200);
  expect((await waitFor(ui, "other-check", ended)).state).toBe("stopped");
  expect(worktrees(p)).toEqual([]);
}, T);

test("it stops after the idle time with no request", async () => {
  const { ui, p, pids } = await started(APP_CMD, { env: { FACTORY_PREVIEW_IDLE_MS: "1500" } });
  await runningPreview(ui, "label-check");
  const s = await waitFor(ui, "label-check", ended, 15_000);
  expect(s.state).toBe("stopped");
  expect(String(s.reason)).toContain("idle");
  expect(await allDead(pidsOf(pids))).toBe(true);
  expect(worktrees(p)).toEqual([]);
}, T);

test("a start that fails shows the app's output and a fix, and leaves no worktree or process behind", async () => {
  const { ui, p } = await started({ command: "echo 'cannot find module ./server' >&2; exit 3", health: "/healthz" });
  const r = await api(ui, `${BASE}/label-check/preview`, { method: "POST" });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  const s = await waitFor(ui, "label-check", ended);
  expect(s.state).toBe("failed");
  expect((s.output as string[]).join("\n")).toContain("cannot find module ./server");
  const error = s.error as Row;
  expect(error.code).toBe("preview_start_failed");
  expect(String(error.message)).toContain("exit 3");
  expect(String(error.fix)).not.toBe("");
  expect(worktrees(p)).toEqual([]);
  expect(previewDirs(p)).toEqual([]);
  // safe to run again: a second Open preview tries once more
  expect((await api(ui, `${BASE}/label-check/preview`, { method: "POST" })).status).toBe(202);
  expect((await waitFor(ui, "label-check", ended)).state).toBe("failed");
}, T);

test("a health check that never answers times out with the output and a fix", async () => {
  const { ui, p } = await started({ command: "echo waiting; sleep 300", health: "/healthz", startSeconds: 1 });
  await api(ui, `${BASE}/label-check/preview`, { method: "POST" });
  const s = await waitFor(ui, "label-check", ended);
  expect(s.state).toBe("failed");
  expect((s.error as Row).code).toBe("preview_health_timeout");
  expect(String((s.error as Row).fix)).toContain("preview.health");
  expect((s.output as string[]).join("\n")).toContain("waiting");
  expect(worktrees(p)).toEqual([]);
}, T);

test("no preview command set: refused with a fix, nothing made", async () => {
  const { ui, p } = await started({});
  const r = await api(ui, `${BASE}/label-check/preview`, { method: "POST" });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("preview_not_set");
  expect(String(r.json.fix)).toContain("preview.command");
  expect(worktrees(p)).toEqual([]);
  const none = await api(ui, `${BASE}/label-check/preview`);
  expect(none.json).toMatchObject({ state: "none", configured: false });
}, T);

test("one preview per item, and at most preview.max at once", async () => {
  const { ui, p } = await started({ ...APP_CMD, max: 1 });
  const a = await api(ui, `${BASE}/label-check/preview`, { method: "POST" });
  expect(a.status).toBe(202);
  const again = await api(ui, `${BASE}/label-check/preview`, { method: "POST" });
  expect(again.status).toBe(200); // the same one, not a second
  expect(again.json.commit).toBe(a.json.commit);
  const b = await api(ui, `${BASE}/other-check/preview`, { method: "POST" });
  expect(b.status).toBe(429);
  expect(b.json.code).toBe("preview_limit");
  expect(String(b.json.fix)).not.toBe("");
  expect(worktrees(p).length).toBe(1);
  expect((await api(ui, `${BASE}/no-such-item/preview`, { method: "POST" })).json.code).toBe("preview_no_item");
}, T);

test("an app that listens beyond 127.0.0.1 is stopped", async () => {
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lan) return; // this machine has only loopback: nothing else could reach it anyway
  const { ui, p } = await started(APP_CMD, { appHost: "0.0.0.0" });
  await api(ui, `${BASE}/label-check/preview`, { method: "POST" });
  const s = await waitFor(ui, "label-check", (x) => isRunning(x) || ended(x));
  expect(s.state).toBe("failed");
  expect((s.error as Row).code).toBe("preview_exposed");
  expect(worktrees(p)).toEqual([]);
}, T);

test("stopping the web UI stops its previews and the preview origin", async () => {
  const { ui, p, pids } = await started(APP_CMD);
  await runningPreview(ui, "label-check");
  const origin = await originOf(ui);
  await ui.stop();
  expect(await allDead(pidsOf(pids))).toBe(true);
  expect(worktrees(p)).toEqual([]);
  expect(await fetch(`${origin}/preview/work/label-check/`).then(() => "answered", () => "gone")).toBe("gone");
}, T);
