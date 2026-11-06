// The web UI's Add machine (#445): POST /api/projects/:p/machines/add runs `factory machine add <name> --json` after a
// confirm and returns the join code with the one command to run on the new machine. `factory` is a fake that logs what
// it was asked and prints the JSON the real one prints.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { api, project, startUi, type Running } from "./web_ui_support.ts";
import { writeExe } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const FAKE = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
case "$*" in
  "machine add nope"*) echo '{"code":"no-hub","message":"This machine is not the hub.","fix":"factory nats up --hub"}' >&2; exit 1 ;;
  "machine add "*) echo '{"machine":"office-pc","code":"FJ1-abc","expires":1,"minutes":15,"agents":[],"command":"factory machine join FJ1-abc"}' ;;
esac
`;

async function started() {
  const p = project();
  roots.push(p.root);
  writeExe(`${p.d}/factory`, FAKE);
  const ui = await startUi(p);
  running.push(ui);
  return { p, ui };
}

test("Add machine needs a confirm, and runs nothing without it", async () => {
  const { p, ui } = await started();
  const r = await api(ui, "/api/projects/work/machines/add", { method: "POST", body: { name: "office-pc" } });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("confirm_needed");
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
}, T);

test("Add machine returns the join code and the command, from factory machine add --json", async () => {
  const { p, ui } = await started();
  const r = await api(ui, "/api/projects/work/machines/add", { method: "POST", body: { name: "office-pc", agents: ["haile", "tewodros:manager"], confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.join).toMatchObject({ code: "FJ1-abc", command: "factory machine join FJ1-abc" });
  expect(readFileSync(p.factoryLog, "utf8").trim()).toBe("machine add office-pc --agents haile,tewodros:manager --json");
}, T);

test("a bad machine name is 400 and runs nothing; a refusal from the command comes back with its fix", async () => {
  const { p, ui } = await started();
  const bad = await api(ui, "/api/projects/work/machines/add", { method: "POST", body: { name: "../x", confirm: true } });
  expect(bad.status).toBe(400);
  expect(bad.json.code).toBe("ui_machine_name");
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
  const no = await api(ui, "/api/projects/work/machines/add", { method: "POST", body: { name: "nope", confirm: true } });
  expect(no.status).toBe(500);
  expect(no.json).toMatchObject({ code: "no-hub", fix: "factory nats up --hub" });
  expect((await api(ui, "/api/projects/work/machines/add", { method: "GET" })).status).toBe(405);
}, T);
