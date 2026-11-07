// The web UI's Factory settings (#456): GET /api/projects/:p/settings reads the team, every project setting (driven by
// factory_settings_schema.ts), this machine's settings, what is staged, the open settings pull request and the pinned
// release, and every change runs a factory command through the fake `factory` script, which logs what it was asked:
// a project change is staged (`factory settings set --stage`) and proposed (`factory settings pr`), a machine setting is
// saved at once (`factory settings --local set`), adding or removing an agent stages `agents`, update runs
// `factory update`, and the clean-ups run their own commands. Bad input is refused before anything runs.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "../hooks/factory_settings_schema.ts";
import { api, CONFIG, heartbeat, hbRow, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const FAKE = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
case "$1 $2" in
  "version --json") echo '{"installed": {"tag": "v1.2.0", "ok": true, "differs": []}, "pinned": {"tag": "v1.2.0"}, "newest": {"tag": "v1.3.0", "date": "2026-11-01"}, "prerelease": null, "submodule": null}' ;;
  "settings pr") echo "https://github.com/o/r/pull/77" ;;
  *) echo "fake factory: $*" ;;
esac
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
const STAGING = (p: Project): string => join(p.d, ".git", "factory", "settings-staged.json");
const MACHINE_FILE = (p: Project): string => join(p.root, "config", "software-factory", "work.json");

function rowsOf(json: Row): Row[] {
  return (json.sections as Row[]).flatMap((s) => s.rows as Row[]);
}

test("the settings: the team, every project setting from the schema, this machine, what is staged, the release", async () => {
  const { ui } = await started({
    cfg: { ...CONFIG, commands: { test: "bun test" } },
    before: (p) => {
      write(STAGING(p), JSON.stringify({ schema: "factory-settings-staged/1", changes: { "tasks.staleHours": { value: 12 } } }));
      write(MACHINE_FILE(p), JSON.stringify({ agents: ["menelik"], remoteControl: false }));
      write(join(p.d, ".claude", "factory", "release.json"), JSON.stringify({ tag: "v1.2.0" }));
      write(join(p.root, "db.json"), JSON.stringify({ issues: [], pulls: [
        { number: 70, title: "Fix a bug", html_url: "https://github.com/o/r/pull/70", head: { ref: "task/1-bug" } },
        { number: 71, title: "Factory settings: mainBranch", html_url: "https://github.com/o/r/pull/71", head: { ref: "settings/mainbranch" } },
      ] }));
    },
  });
  const r = await api(ui, BASE);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.project).toBe("work");
  const team = r.json.team as Row;
  expect(team.agents).toEqual([
    { name: "fasil", role: "dev-manager" }, { name: "mentewab", role: "product-owner" },
    { name: "menelik", role: "coding-agent" }, { name: "taytu", role: "coding-agent" },
  ]);
  expect(team.free).not.toContain("menelik");
  expect(team.free).not.toContain("fasil");
  expect(team.free).toContain("haile");
  // every project setting is a row, with a plain name, its help and where its value comes from
  const rows = rowsOf(r.json);
  expect(rows.map((x) => x.key).sort()).toEqual(Object.keys(SETTINGS).sort());
  const by = (k: string): Row => rows.find((x) => x.key === k) as Row;
  expect(by("mainBranch")).toMatchObject({ name: "Main branch", kind: "str", value: "main", from: "default", main: true });
  expect(by("commands.test")).toMatchObject({ name: "Test command", value: "bun test", from: "main", main: true });
  expect(by("tasks.source")).toMatchObject({ value: "issues", from: "main", options: ["plan", "issues", "board"] });
  expect(by("tasks.staleHours")).toMatchObject({ from: "staged", staged: { value: 12 }, main: true });
  expect(by("manager.claimMinutes").main).toBe(true);
  expect(by("protected").main).toBe(true);
  expect(String(by("mainBranch").help)).not.toBe("");
  expect(by("prd").main).toBe(false);
  expect((r.json.staged as Row).changes).toEqual([{ key: "tasks.staleHours", name: by("tasks.staleHours").name, value: 12 }]);
  // this machine: which agents run here and where that comes from, and its own settings
  const machine = r.json.machine as Row;
  expect(machine).toMatchObject({ agents: ["menelik"], from: "machine", board: false });
  expect((machine.rows as Row[]).find((x) => x.key === "remoteControl")).toMatchObject({ value: false, from: "machine" });
  expect((machine.rows as Row[]).find((x) => x.key === "autostart")).toMatchObject({ value: false, from: "default" });
  expect(r.json.release).toMatchObject({ pinned: "v1.2.0" });
  expect(r.json.pr).toEqual({ number: 71, url: "https://github.com/o/r/pull/71", title: "Factory settings: mainBranch" });
}, T);

test("the board is only said to be set: its address and password never reach the page", async () => {
  const url = "postgres://factory:s3cret-pass@127.0.0.1:1/board";
  const { ui } = await started({ env: { MB_URL: url } });
  const r = await api(ui, BASE);
  expect(r.status).toBe(200);
  expect((r.json.machine as Row).board).toBe(true);
  const text = JSON.stringify(r.json);
  expect(text).not.toContain("s3cret-pass");
  expect(text).not.toContain("127.0.0.1:1/");
}, T);

test("FACTORY_AGENTS wins over this machine's file, and the page is told so", async () => {
  const { ui } = await started({ env: { FACTORY_AGENTS: "taytu" }, before: (p) => write(MACHINE_FILE(p), JSON.stringify({ agents: ["menelik"] })) });
  const r = await api(ui, BASE);
  expect(r.json.machine).toMatchObject({ agents: ["taytu"], from: "env" });
}, T);

test("staging a project change runs factory settings set --stage; going back to the default runs unset --stage", async () => {
  const { p, ui } = await started();
  const a = await api(ui, `${BASE}/stage`, { method: "POST", body: { key: "commands.test", value: "bun test --bail" } });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  expect(a.json.ok).toBe(true);
  const b = await api(ui, `${BASE}/stage`, { method: "POST", body: { key: "tasks.staleHours", unset: true } });
  expect(b.status).toBe(200);
  expect(calls(p)).toEqual(["settings set --stage commands.test bun test --bail", "settings unset --stage tasks.staleHours"]);
}, T);

test("a bad key or value is refused with its fix, and nothing runs", async () => {
  const { p, ui } = await started();
  const cases: [Row, string][] = [
    [{ key: "nope", value: "x" }, "settings_unknown_key"],
    [{ key: "remoteControl", value: "off" }, "settings_unknown_key"], // a machine setting is never staged
    [{ key: "tasks.staleHours", value: "soon" }, "settings_bad_value"],
    [{ key: "tasks.source", value: "jira" }, "settings_bad_value"],
    [{ key: "protected", value: "not a list" }, "settings_bad_value"],
    [{ key: "commands.test" }, "settings_bad_value"],
    [{ key: "commands.test", value: "--json" }, "settings_bad_value"],
  ];
  for (const [body, code] of cases) {
    const r = await api(ui, `${BASE}/stage`, { method: "POST", body });
    expect(r.status, JSON.stringify(body)).toBe(400);
    expect(r.json.code, JSON.stringify(body)).toBe(code);
    expect(String(r.json.fix)).not.toBe("");
  }
  expect(calls(p)).toEqual([]);
}, T);

test("dropping staged changes runs factory settings unstage, one or all", async () => {
  const { p, ui } = await started();
  expect((await api(ui, `${BASE}/unstage`, { method: "POST", body: { key: "commands.test" } })).status).toBe(200);
  expect((await api(ui, `${BASE}/unstage`, { method: "POST", body: {} })).status).toBe(200);
  expect((await api(ui, `${BASE}/unstage`, { method: "POST", body: { key: "--all" } })).status).toBe(400);
  expect(calls(p)).toEqual(["settings unstage commands.test", "settings unstage"]);
}, T);

test("proposing the staged changes asks for a confirm, then runs factory settings pr --ready", async () => {
  const { p, ui } = await started();
  const no = await api(ui, `${BASE}/pr`, { method: "POST", body: {} });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("confirm_needed");
  const r = await api(ui, `${BASE}/pr`, { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(String(r.json.output)).toContain("https://github.com/o/r/pull/77");
  expect(calls(p)).toEqual(["settings pr --ready"]);
}, T);

test("a machine setting is saved at once with factory settings --local set; a project key is refused", async () => {
  const { p, ui } = await started();
  const a = await api(ui, `${BASE}/machine`, { method: "POST", body: { key: "remoteControl", value: "off" } });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  const b = await api(ui, `${BASE}/machine`, { method: "POST", body: { key: "agents", value: '["menelik"]' } });
  expect(b.status, JSON.stringify(b.json)).toBe(200);
  const c = await api(ui, `${BASE}/machine`, { method: "POST", body: { key: "autostart", unset: true } });
  expect(c.status).toBe(200);
  const bad = await api(ui, `${BASE}/machine`, { method: "POST", body: { key: "mainBranch", value: "trunk" } });
  expect(bad.status).toBe(400);
  expect(bad.json.code).toBe("settings_unknown_key");
  const notOurs = await api(ui, `${BASE}/machine`, { method: "POST", body: { key: "agents", value: '["haile"]' } });
  expect(notOurs.status).toBe(400);
  expect(notOurs.json.code).toBe("settings_bad_value");
  expect(calls(p)).toEqual(["settings --local set remoteControl off", 'settings --local set agents ["menelik"]', "settings --local unset autostart"]);
}, T);

test("adding a coding agent stages agents with the new name at the end", async () => {
  const { p, ui } = await started();
  const r = await api(ui, `${BASE}/team`, { method: "POST", body: { name: "haile" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage agents ["menelik","taytu","haile"]']);
}, T);

test("adding builds on agents already staged", async () => {
  const { p, ui } = await started({ before: (q) => write(STAGING(q), JSON.stringify({ changes: { agents: { value: ["menelik"] } } })) });
  const r = await api(ui, `${BASE}/team`, { method: "POST", body: { name: "tewodros" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage agents ["menelik","tewodros"]']);
}, T);

test("a bad or taken name is refused with its fix, and nothing runs", async () => {
  const { p, ui } = await started();
  for (const name of ["Haile", "ha ile", "-x", "", "a".repeat(41), "taytu", "fasil", "mentewab"]) {
    const r = await api(ui, `${BASE}/team`, { method: "POST", body: { name } });
    expect(r.status, name).toBe(400);
    expect(["ui_bad_agent_name", "ui_agent_taken"], name).toContain(String(r.json.code));
    expect(String(r.json.fix)).not.toBe("");
  }
  expect(calls(p)).toEqual([]);
}, T);

test("removing an agent: refused while it runs or holds a task, else it stages agents without it", async () => {
  const { p, ui } = await started({ before: (q) => heartbeat(q, [hbRow("menelik", { state: "working", detail: "on #12", task: "12" }),
    hbRow("taytu", { state: "down", detail: "down", task: "14" })]) });
  const no = await api(ui, `${BASE}/team/taytu/remove`, { method: "POST", body: {} });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("confirm_needed");
  const busy = await api(ui, `${BASE}/team/menelik/remove`, { method: "POST", body: { confirm: true } });
  expect(busy.status).toBe(409);
  expect(busy.json.code).toBe("ui_agent_running");
  const holds = await api(ui, `${BASE}/team/taytu/remove`, { method: "POST", body: { confirm: true } });
  expect(holds.status).toBe(409);
  expect(holds.json.code).toBe("ui_agent_holds_task");
  expect(String(holds.json.message)).toContain("#14");
  expect(calls(p)).toEqual([]);
  heartbeat(p, [hbRow("menelik", { state: "working", task: "12" }), hbRow("taytu", { state: "down", task: null })]);
  const ok = await api(ui, `${BASE}/team/taytu/remove`, { method: "POST", body: { confirm: true } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage agents ["menelik"]']);
}, T);

test("removing the only dev manager is refused; an unknown agent is a 404", async () => {
  const { p, ui } = await started();
  const last = await api(ui, `${BASE}/team/fasil/remove`, { method: "POST", body: { confirm: true } });
  expect(last.status).toBe(400);
  expect(last.json.code).toBe("ui_last_of_role");
  const unknown = await api(ui, `${BASE}/team/haile/remove`, { method: "POST", body: { confirm: true } });
  expect(unknown.status).toBe(404);
  expect(calls(p)).toEqual([]);
}, T);

test("a second name of a role is removed from that role's names", async () => {
  const { p, ui } = await started({ cfg: { ...CONFIG, roles: { "dev-manager": { names: ["fasil", "alula"] }, "product-owner": { names: ["mentewab"] } } } });
  const r = await api(ui, `${BASE}/team/alula/remove`, { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(['settings set --stage roles.dev-manager.names ["fasil"]']);
}, T);

test("after the change is on this checkout the new agent is in the team without a restart", async () => {
  const { p, ui } = await started();
  write(join(p.d, ".claude", "factory.json"), JSON.stringify({ ...CONFIG, agents: ["menelik", "taytu", "haile"] }));
  const ch = await api(ui, "/api/projects/work/channels");
  expect((ch.json.channels as Row[]).map((c) => c.name)).toContain("haile");
  const start = await api(ui, "/api/projects/work/agents/haile/start", { method: "POST", body: { confirm: true } });
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  expect(calls(p)).toEqual(["owner start coding-agent haile"]);
}, T);

test("the release: factory version --json says what runs here and whether a newer one exists", async () => {
  const { p, ui } = await started();
  const r = await api(ui, `${BASE}/release`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toMatchObject({ installed: "v1.2.0", pinned: "v1.2.0", newest: "v1.3.0", newer: true, update: null });
  expect(calls(p)).toEqual(["version --json"]);
}, T);

test("update asks for a confirm, then starts factory update and answers at once", async () => {
  const { p, ui } = await started();
  const no = await api(ui, `${BASE}/update`, { method: "POST", body: {} });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("confirm_needed");
  const r = await api(ui, `${BASE}/update`, { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect(r.json.ok).toBe(true);
  let update: Row | null = null;
  for (let i = 0; i < 50 && update?.state !== "done"; i++) {
    await Bun.sleep(100);
    update = (await api(ui, `${BASE}/release`)).json.update as Row;
  }
  expect(update).toMatchObject({ state: "done" });
  expect(calls(p)).toContain("update");
}, T);

test("the clean-ups run their commands after a confirm; a preview lists without changing", async () => {
  const { p, ui } = await started();
  const no = await api(ui, `${BASE}/maintenance/clean`, { method: "POST", body: {} });
  expect(no.status).toBe(400);
  for (const id of ["clean", "ci-clean", "reset-run"]) {
    const r = await api(ui, `${BASE}/maintenance/${id}`, { method: "POST", body: { confirm: true } });
    expect(r.status, id).toBe(200);
  }
  for (const id of ["ci-clean", "reset-run"]) expect((await api(ui, `${BASE}/maintenance/${id}/preview`, { method: "POST", body: {} })).status).toBe(200);
  expect((await api(ui, `${BASE}/maintenance/clean/preview`, { method: "POST", body: {} })).status).toBe(404);
  expect((await api(ui, `${BASE}/maintenance/rm-rf`, { method: "POST", body: { confirm: true } })).status).toBe(404);
  expect(calls(p)).toEqual(["clean", "ci clean --apply", "reset-run --apply", "ci clean", "reset-run"]);
}, T);

test("without the token every settings endpoint says 401 and nothing runs", async () => {
  const { p, ui } = await started();
  expect((await api(ui, BASE, { token: null })).status).toBe(401);
  for (const path of ["stage", "unstage", "pr", "machine", "team", "team/taytu/remove", "update", "maintenance/clean"]) {
    expect((await api(ui, `${BASE}/${path}`, { method: "POST", token: null, body: { confirm: true, key: "commands.test", value: "x", name: "haile" } })).status).toBe(401);
  }
  expect(calls(p)).toEqual([]);
}, T);
