// The web UI's Team page (#581): add, remove and rename an agent, choose where a new one runs, and how many coding
// agents run at once on this machine, each through the settings API (factory_ui_settings.ts). A project change is
// staged through the fake `factory` script, which logs what it was asked (`factory settings set --stage`), and is
// proposed with the other staged changes as one settings pull request. What this machine runs is its own file: a
// choice made before the change is merged is kept there as pending and applied once the checkout has the change.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, heartbeat, hbRow, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// a stage that fails: `factory settings set --stage` of a key named in $FAKE_FAIL_KEY
const FAKE = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
if [ "$1 $2 $3" = "settings set --stage" ] && [ -n "$FAKE_FAIL_KEY" ] && [ "$4" = "$FAKE_FAIL_KEY" ]; then
  echo '{"code": "settings_bad_value", "message": "That value is refused.", "fix": "Change it."}' >&2
  exit 1
fi
echo "fake factory: $*"
`;

async function started(opts: { cfg?: Row; env?: Record<string, string>; before?: (p: Project) => void } = {}) {
  const p = project(opts.cfg ?? CONFIG);
  roots.push(p.root);
  write(join(p.d, "factory"), FAKE, 0o755);
  opts.before?.(p);
  const ui = await startUi(p, ["--port", "0"], null, opts.env ?? {});
  running.push(ui);
  return { p, ui };
}

function calls(p: Project): string[] {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter(Boolean);
}

const BASE = "/api/projects/work/settings";
const MACHINE_FILE = (p: Project): string => join(p.root, "config", "software-factory", "work.json");
const STAGING = (p: Project): string => join(p.d, ".git", "factory", "settings-staged.json");

function machineFile(p: Project): Row {
  return existsSync(MACHINE_FILE(p)) ? (JSON.parse(readFileSync(MACHINE_FILE(p), "utf8")) as Row) : {};
}

/** The project's settings as main has them once a change is merged and this checkout has it. */
function merged(p: Project, cfg: Row): void {
  write(join(p.d, ".claude", "factory.json"), JSON.stringify(cfg));
}

// --- add ---------------------------------------------------------------------------------------------------------------

test("adding an agent to run on this machine stages agents and keeps the choice; once merged it runs here", async () => {
  const { p, ui } = await started({ before: (q) => write(MACHINE_FILE(q), JSON.stringify({ agents: ["menelik"], remoteControl: false })) });
  const r = await api(ui, `${BASE}/team`, { method: "POST", body: { name: "haile", machine: "here" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage agents ["menelik","taytu","haile"]']);
  // not merged yet: the machine's list is unchanged (a name not in the project would stop its loops), the choice waits
  expect(machineFile(p)).toEqual({ agents: ["menelik"], remoteControl: false, teamPending: { join: ["haile"], leave: [] } });
  const before = await api(ui, BASE);
  expect(before.json.machine).toMatchObject({ agents: ["menelik"], pending: { join: ["haile"], leave: [] } });
  // merged and on this checkout: the next read runs it here, and nothing is pending any more
  merged(p, { ...CONFIG, agents: ["menelik", "taytu", "haile"] });
  const after = await api(ui, BASE);
  expect(after.json.machine).toMatchObject({ agents: ["menelik", "haile"], from: "machine", pending: { join: [], leave: [] } });
  expect(machineFile(p)).toEqual({ agents: ["menelik", "haile"], remoteControl: false });
}, T);

test("adding to this machine when it runs every agent writes nothing to the machine: the agent runs here anyway", async () => {
  const { p, ui } = await started();
  const r = await api(ui, `${BASE}/team`, { method: "POST", body: { name: "haile", machine: "here" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage agents ["menelik","taytu","haile"]']);
  expect(existsSync(MACHINE_FILE(p))).toBe(false);
}, T);

test("adding for another machine, or to choose later, stages the name and leaves this machine's list alone", async () => {
  const { p, ui } = await started({ before: (q) => write(MACHINE_FILE(q), JSON.stringify({ agents: ["menelik"] })) });
  expect((await api(ui, `${BASE}/team`, { method: "POST", body: { name: "haile", machine: "office-pc" } })).status).toBe(200);
  expect((await api(ui, `${BASE}/team`, { method: "POST", body: { name: "alula", machine: "later" } })).status).toBe(200);
  expect(machineFile(p)).toEqual({ agents: ["menelik"] });
  expect(calls(p)).toHaveLength(2);
}, T);

test("a bad machine is refused with its fix and nothing runs", async () => {
  const { p, ui } = await started();
  for (const machine of ["--all", "Office PC", 7, "a".repeat(41)]) {
    const r = await api(ui, `${BASE}/team`, { method: "POST", body: { name: "haile", machine } });
    expect(r.status, String(machine)).toBe(400);
    expect(r.json.code).toBe("ui_bad_machine");
    expect(String(r.json.fix)).not.toBe("");
  }
  expect(calls(p)).toEqual([]);
}, T);

test("a stage that fails takes back this machine's pending choice: nothing is left half done", async () => {
  const { p, ui } = await started({ env: { FAKE_FAIL_KEY: "agents" }, before: (q) => write(MACHINE_FILE(q), JSON.stringify({ agents: ["menelik"] })) });
  const r = await api(ui, `${BASE}/team`, { method: "POST", body: { name: "haile", machine: "here" } });
  expect(r.status).toBe(500);
  expect(r.json.code).toBe("settings_bad_value");
  expect(machineFile(p)).toEqual({ agents: ["menelik"] });
}, T);

// --- remove ------------------------------------------------------------------------------------------------------------

test("removing an agent that holds a task is refused with the fix Release its work first", async () => {
  const { p, ui } = await started({ before: (q) => heartbeat(q, [hbRow("taytu", { state: "down", detail: "down", task: "14" })]) });
  const r = await api(ui, `${BASE}/team/taytu/remove`, { method: "POST", body: { confirm: true } });
  expect(r.status).toBe(409);
  expect(r.json.code).toBe("ui_agent_holds_task");
  expect(String(r.json.fix)).toStartWith("Release its work first");
  expect(String(r.json.fix)).toContain("#14");
  expect(calls(p)).toEqual([]);
}, T);

test("removing an agent this machine runs takes it off this machine's list once the change is merged", async () => {
  const { p, ui } = await started({ before: (q) => write(MACHINE_FILE(q), JSON.stringify({ agents: ["menelik", "taytu"], autostartAgents: ["taytu"] })) });
  const r = await api(ui, `${BASE}/team/taytu/remove`, { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage agents ["menelik"]']);
  expect(machineFile(p)).toMatchObject({ agents: ["menelik", "taytu"], teamPending: { join: [], leave: ["taytu"] } });
  merged(p, { ...CONFIG, agents: ["menelik"] });
  const after = await api(ui, BASE);
  expect(after.json.machine).toMatchObject({ agents: ["menelik"], pending: { join: [], leave: [] } });
  expect(machineFile(p)).toEqual({ agents: ["menelik"] }); // an empty autostartAgents is the default: the names this machine runs
}, T);

// --- rename ------------------------------------------------------------------------------------------------------------

test("renaming asks for a confirm, refuses while it runs or holds a task, and refuses a bad or taken name", async () => {
  const { p, ui } = await started({ before: (q) => heartbeat(q, [hbRow("menelik", { state: "working", detail: "on #12", task: "12" }),
    hbRow("taytu", { state: "down", detail: "down", task: "14" })]) });
  const no = await api(ui, `${BASE}/team/taytu/rename`, { method: "POST", body: { to: "haile" } });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("confirm_needed");
  const busy = await api(ui, `${BASE}/team/menelik/rename`, { method: "POST", body: { to: "haile", confirm: true } });
  expect(busy.status).toBe(409);
  expect(busy.json.code).toBe("ui_agent_running");
  const holds = await api(ui, `${BASE}/team/taytu/rename`, { method: "POST", body: { to: "haile", confirm: true } });
  expect(holds.status).toBe(409);
  expect(holds.json.code).toBe("ui_agent_holds_task");
  expect(String(holds.json.fix)).toStartWith("Release its work first");
  for (const to of ["Haile", "", "-x", "menelik", "fasil", "taytu"]) {
    const r = await api(ui, `${BASE}/team/taytu/rename`, { method: "POST", body: { to, confirm: true } });
    expect(r.status, to).toBe(400);
    expect(["ui_bad_agent_name", "ui_agent_taken"], to).toContain(String(r.json.code));
  }
  const unknown = await api(ui, `${BASE}/team/haile/rename`, { method: "POST", body: { to: "alula", confirm: true } });
  expect(unknown.status).toBe(404);
  expect(calls(p)).toEqual([]);
}, T);

test("renaming a coding agent stages its new name in its place and its old name in formerNames", async () => {
  const { p, ui } = await started({ before: (q) => write(MACHINE_FILE(q), JSON.stringify({ agents: ["taytu"] })) });
  const r = await api(ui, `${BASE}/team/menelik/rename`, { method: "POST", body: { to: "haile", confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage agents ["haile","taytu"]', 'settings set --stage formerNames {"haile":["menelik"]}']);
  // menelik doesn't run here, so this machine's list is left alone
  expect(machineFile(p)).toEqual({ agents: ["taytu"] });
}, T);

test("renaming one this machine runs moves it on this machine too, once merged; earlier names are kept", async () => {
  const cfg = { ...CONFIG, formerNames: { taytu: ["zewditu"] } };
  const { p, ui } = await started({ cfg, before: (q) => write(MACHINE_FILE(q), JSON.stringify({ agents: ["taytu"] })) });
  const r = await api(ui, `${BASE}/team/taytu/rename`, { method: "POST", body: { to: "alula", confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage agents ["menelik","alula"]',
    'settings set --stage formerNames {"alula":["zewditu","taytu"]}']);
  expect(machineFile(p)).toEqual({ agents: ["taytu"], teamPending: { join: ["alula"], leave: ["taytu"] } });
  merged(p, { ...CONFIG, agents: ["menelik", "alula"], formerNames: { alula: ["zewditu", "taytu"] } });
  const after = await api(ui, BASE);
  expect(after.json.machine).toMatchObject({ agents: ["alula"], pending: { join: [], leave: [] } });
  expect((after.json.team as Row).former).toEqual({ alula: ["zewditu", "taytu"] });
}, T);

test("renaming a dev manager stages that role's names", async () => {
  const { p, ui } = await started();
  const r = await api(ui, `${BASE}/team/fasil/rename`, { method: "POST", body: { to: "lalibela", confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage roles.dev-manager.names ["lalibela"]', 'settings set --stage formerNames {"lalibela":["fasil"]}']);
}, T);

test("a rename whose second stage fails takes back the first: nothing is left half done", async () => {
  const { p, ui } = await started({ env: { FAKE_FAIL_KEY: "formerNames" } });
  const r = await api(ui, `${BASE}/team/menelik/rename`, { method: "POST", body: { to: "haile", confirm: true } });
  expect(r.status).toBe(500);
  expect(calls(p)).toEqual(['settings set --stage agents ["haile","taytu"]', 'settings set --stage formerNames {"haile":["menelik"]}',
    "settings unstage agents"]);
}, T);

test("a rename on top of a staged team change puts the staged list back when it fails", async () => {
  const { p, ui } = await started({ env: { FAKE_FAIL_KEY: "formerNames" },
    before: (q) => write(STAGING(q), JSON.stringify({ changes: { agents: { value: ["menelik", "taytu", "ezana"] } } })) });
  const r = await api(ui, `${BASE}/team/ezana/rename`, { method: "POST", body: { to: "haile", confirm: true } });
  expect(r.status).toBe(500);
  expect(calls(p)).toEqual(['settings set --stage agents ["menelik","taytu","haile"]', 'settings set --stage formerNames {"haile":["ezana"]}',
    'settings set --stage agents ["menelik","taytu","ezana"]']);
}, T);

// --- how many at once ----------------------------------------------------------------------------------------------------

test("how many coding agents run at once is this machine's setting, saved at once; a bad number is refused", async () => {
  const { p, ui } = await started();
  const read = await api(ui, BASE);
  const row = ((read.json.machine as Row).rows as Row[]).find((x) => x.key === "maxCodingAgents");
  expect(row).toMatchObject({ value: null, from: "default", kind: "int" });
  const ok = await api(ui, `${BASE}/machine`, { method: "POST", body: { key: "maxCodingAgents", value: "2" } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  const off = await api(ui, `${BASE}/machine`, { method: "POST", body: { key: "maxCodingAgents", unset: true } });
  expect(off.status).toBe(200);
  for (const value of ["0", "two", "99"]) {
    const bad = await api(ui, `${BASE}/machine`, { method: "POST", body: { key: "maxCodingAgents", value } });
    expect(bad.status, value).toBe(400);
    expect(bad.json.code).toBe("settings_bad_value");
  }
  expect(calls(p)).toEqual(["settings --local set maxCodingAgents 2", "settings --local unset maxCodingAgents"]);
}, T);

test("without the token rename says 401 and nothing runs", async () => {
  const { p, ui } = await started();
  const r = await api(ui, `${BASE}/team/taytu/rename`, { method: "POST", token: null, body: { to: "haile", confirm: true } });
  expect(r.status).toBe(401);
  expect(calls(p)).toEqual([]);
}, T);
