// The web UI's agents and machines channels, live (#422): each agent with its role, machine, state (working on #n, idle,
// down), its task and its last lines of output; each machine with its agents and the CI runners; GitHub's limit when it
// is used up; start and stop through `factory owner start|stop` after a confirm; and a WebSocket that gets the new
// state after a change, from the server's poll loop. The heartbeat file and the cockpit's cache are written by hand, gh
// is a fake, and `factory` is a fake that logs what it was asked.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, hbRow, heartbeat, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function live(): Project {
  const p = project();
  roots.push(p.root);
  const log = write(join(p.root, "menelik.log"), ["one", "two", "\u001b[32mthree\u001b[0m", "Running the tests for #7"].join("\n") + "\n");
  heartbeat(p, [
    hbRow("menelik", { state: "working", detail: "working on #7", task: "7", runs: "nohup", session: null, log }),
    hbRow("taytu", { state: "down", detail: "down", runs: "", session: null, pid: null }),
    hbRow("fasil", { kind: "dev-manager", state: "idle", detail: "idle" }),
  ]);
  write(join(p.state, "cockpit.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    tasks: { source: "issues", tasks: [{ id: "7", title: "Add the login page", state: "in-progress", holders: ["menelik"] }] },
    ci: { runners: [{ name: "work-m-here-1", status: "online", busy: true }, { name: "work-m-here-2", status: "offline", busy: false }] },
  }));
  return p;
}

async function startedOn(p: Project): Promise<Running> {
  const ui = await startUi(p);
  running.push(ui);
  return ui;
}

function agentsOf(json: Row): Row[] {
  return json.agents as Row[];
}

test("the agents of a project: role, machine, state, task with its title, and the last lines of output", async () => {
  const ui = await startedOn(live());
  const r = await api(ui, "/api/projects/work/agents");
  expect(r.status).toBe(200);
  const rows = agentsOf(r.json);
  const menelik = rows.find((a) => a.name === "menelik") as Row;
  expect(menelik).toMatchObject({ role: "coding-agent", state: "working", detail: "working on #7", task: "7",
    taskTitle: "Add the login page", runs: "nohup", here: true });
  expect(menelik.log).toEqual(["one", "two", "three", "Running the tests for #7"]);
  expect((rows.find((a) => a.name === "taytu") as Row).state).toBe("down");
  expect((rows.find((a) => a.name === "fasil") as Row).role).toBe("dev-manager");
  expect(r.json.limit).toBeNull();
}, T);

test("one agent by name, and an unknown one is 404 ui_agent_unknown", async () => {
  const ui = await startedOn(live());
  const r = await api(ui, "/api/projects/work/agents/menelik");
  expect(r.status).toBe(200);
  expect((r.json.agent as Row).name).toBe("menelik");
  const none = await api(ui, "/api/projects/work/agents/nobody");
  expect(none.status).toBe(404);
  expect(none.json.code).toBe("ui_agent_unknown");
}, T);

test("the machines: each with its agents, this one marked, and the CI runners", async () => {
  const ui = await startedOn(live());
  const r = await api(ui, "/api/projects/work/machines");
  expect(r.status).toBe(200);
  const machines = r.json.machines as Row[];
  expect(machines.length).toBe(1);
  expect(machines[0]).toMatchObject({ here: true });
  expect((machines[0]?.agents as Row[]).map((a) => a.name).sort()).toEqual(["fasil", "menelik", "taytu"]);
  expect(r.json.runners).toEqual([{ name: "work-m-here-1", state: "busy" }, { name: "work-m-here-2", state: "offline" }]);
}, T);

test("GitHub's limit, when used up, is on the agents' data with when it is back", async () => {
  const p = live();
  const reset = Math.floor(Date.now() / 1000) + 1800;
  write(join(p.state, "github-rate.json"), JSON.stringify({ at: Date.now() / 1000, core: { limit: 5000, remaining: 0, reset } }));
  const ui = await startedOn(p);
  const r = await api(ui, "/api/projects/work/agents");
  expect((r.json.limit as Row).reset).toBe(reset);
  expect(String((r.json.limit as Row).message)).toContain("GitHub's hourly limit is used up");
}, T);

// --- start and stop ----------------------------------------------------------------------------------------------------

test("stop needs a confirm: without it 400 confirm_needed and nothing runs", async () => {
  const p = live();
  const ui = await startedOn(p);
  const r = await api(ui, "/api/projects/work/agents/menelik/stop", { method: "POST", body: {} });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("confirm_needed");
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
}, T);

test("stop and start run the same commands factory runs: owner stop <name>, owner start <role> <name>", async () => {
  const p = live();
  const ui = await startedOn(p);
  const stop = await api(ui, "/api/projects/work/agents/menelik/stop", { method: "POST", body: { confirm: true } });
  expect(stop.status, JSON.stringify(stop.json)).toBe(200);
  expect(stop.json).toMatchObject({ ok: true, command: "factory owner stop menelik" });
  expect(String(stop.json.output)).toContain("Stopped menelik.");
  const start = await api(ui, "/api/projects/work/agents/fasil/start", { method: "POST", body: { confirm: true } });
  expect(start.status).toBe(200);
  expect(start.json.command).toBe("factory owner start dev-manager fasil");
  expect(readFileSync(p.factoryLog, "utf8").trim().split("\n")).toEqual(["owner stop menelik", "owner start dev-manager fasil"]);
}, T);

test("start or stop of a name that isn't the project's agent is 404, and nothing runs", async () => {
  const p = live();
  const ui = await startedOn(p);
  const r = await api(ui, "/api/projects/work/agents/mallory/start", { method: "POST", body: { confirm: true } });
  expect(r.status).toBe(404);
  expect(r.json.code).toBe("ui_agent_unknown");
  expect((await api(ui, "/api/projects/work/agents/menelik/reboot", { method: "POST", body: { confirm: true } })).status).toBe(404);
  expect((await api(ui, "/api/projects/work/agents/menelik/stop", { method: "GET" })).status).toBe(405);
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
}, T);

test("a failing command is 500 with its output and a fix", async () => {
  const p = live();
  write(join(p.d, "factory"), '#!/usr/bin/env bash\necho \'{"code": "tmux_missing", "message": "No tmux.", "fix": "Install tmux."}\' >&2\nexit 1\n', 0o755);
  const ui = await startedOn(p);
  const r = await api(ui, "/api/projects/work/agents/taytu/start", { method: "POST", body: { confirm: true } });
  expect(r.status).toBe(500);
  expect(r.json).toMatchObject({ code: "tmux_missing", message: "No tmux.", fix: "Install tmux." });
}, T);

// --- live ----------------------------------------------------------------------------------------------------------------

/** The next WebSocket message for `project` that `want` accepts, or null after `ms`. */
function nextState(ws: WebSocket, want: (m: Row) => boolean, ms: number): Promise<Row | null> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(null), ms);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as Row;
      if (want(m)) {
        clearTimeout(timer);
        done(m);
      }
    });
  });
}

function menelikOf(m: Row): Row | undefined {
  return ((m.agents as Row[] | undefined) ?? []).find((a) => a.name === "menelik");
}

test("the WebSocket sends the state on connect, then the new state after an agent changes", async () => {
  const p = live();
  const ui = await startedOn(p);
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const first = await nextState(ws, (m) => m.type === "state" && m.project === "work", 15_000);
  expect(first).not.toBeNull();
  expect(menelikOf(first as Row)?.detail).toBe("working on #7");
  expect(Array.isArray((first as Row).machines)).toBe(true);
  heartbeat(p, [
    hbRow("menelik", { state: "idle", detail: "idle", task: null, runs: "nohup", session: null }),
    hbRow("taytu", { state: "working", detail: "working on #9", task: "9" }),
    hbRow("fasil", { kind: "dev-manager", state: "idle", detail: "idle" }),
  ]);
  const next = await nextState(ws, (m) => m.type === "state" && menelikOf(m)?.state === "idle", 15_000);
  ws.close();
  expect(next).not.toBeNull();
  expect(((next as Row).agents as Row[]).find((a) => a.name === "taytu")?.detail).toBe("working on #9");
}, T);

test("ui.pollSeconds is how often the server reads again", async () => {
  // CONFIG sets 1 s: the update above arrives within a few seconds; this checks the setting reaches the hello message
  const p = project({ ...CONFIG, ui: { pollSeconds: 3 } });
  roots.push(p.root);
  heartbeat(p, [hbRow("menelik")]);
  const ui = await startedOn(p);
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const hello = await nextState(ws, (m) => m.type === "hello", 10_000);
  ws.close();
  expect(hello).toMatchObject({ type: "hello", pollSeconds: 3 });
}, T);
