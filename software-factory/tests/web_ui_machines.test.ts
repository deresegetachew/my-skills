// The web UI's Add machine (#445): POST /api/projects/:p/machines runs `factory machine add <name> --json --agent ...`
// after a confirm and hands the join code back; /machines/:name/remove runs `factory machine remove`. `factory` is a
// fake that logs what it was asked.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, project, startUi, type Running } from "./web_ui_support.ts";
import { write } from "./support.ts";
import { addMachineAsk, agentArgs, plainProblem } from "../web/machines_model.ts";
import { confirmState } from "../web/parts_model.ts";

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
  "machine add") echo '{"name":"office-pc","code":"FM1-abc","expiresAt":1800000000,"agents":[{"name":"haile","role":"builder"}],"command":"factory machine join FM1-abc"}' ;;
  "machine remove") echo "Removed $3." ;;
  *) echo "fake factory: $*" ;;
esac
`;

async function started() {
  const p = project();
  roots.push(p.root);
  write(join(p.d, "factory"), FAKE, 0o755);
  const ui = await startUi(p);
  running.push(ui);
  return { p, ui };
}

test("adding a machine asks for a confirm, runs factory machine add and returns the join code", async () => {
  const { p, ui } = await started();
  const no = await api(ui, "/api/projects/work/machines", { method: "POST", body: { name: "office-pc", agents: ["haile"] } });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("confirm_needed");
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
  const r = await api(ui, "/api/projects/work/machines", { method: "POST", body: { confirm: true, name: "office-pc", agents: ["haile", "taytu:manager"] } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.join).toMatchObject({ code: "FM1-abc", command: "factory machine join FM1-abc" });
  expect(readFileSync(p.factoryLog, "utf8").trim()).toBe("machine add office-pc --json --agent haile --agent taytu:manager");
}, T);

test("a name or agent that looks like an option never reaches the command", async () => {
  const { p, ui } = await started();
  for (const body of [{ name: "--json", agents: ["haile"] }, { name: "office-pc", agents: ["--ttl"] }]) {
    const r = await api(ui, "/api/projects/work/machines", { method: "POST", body: { confirm: true, ...body } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("ui_bad_machine");
  }
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
}, T);

test("removing a machine runs factory machine remove after a confirm", async () => {
  const { p, ui } = await started();
  expect((await api(ui, "/api/projects/work/machines/office-pc/remove", { method: "POST", body: {} })).status).toBe(400);
  const r = await api(ui, "/api/projects/work/machines/office-pc/remove", { method: "POST", body: { confirm: true } });
  expect(r.status).toBe(200);
  expect(r.json.command).toBe("factory machine remove office-pc");
  expect(readFileSync(p.factoryLog, "utf8").trim()).toBe("machine remove office-pc");
  expect((await api(ui, "/api/projects/work/machines/office-pc/reboot", { method: "POST", body: { confirm: true } })).status).toBe(404);
}, T);

// The card's rules (web/machines_model.ts, no React): the confirm's checks and words, and what it sends.
test("the Add machine confirm turns on only for a good, unused name with at least one agent, and names no command", () => {
  const haile = { name: "haile", role: "coding-agent" };
  const taytu = { name: "taytu", role: "dev-manager" };
  expect(confirmState(addMachineAsk("office-pc", [haile], ["mac"]), "").ready).toBe(true);
  expect(confirmState(addMachineAsk("Office PC", [haile], []), "").unmet.map((c) => c.title)).toEqual(["The name uses lowercase letters, digits and dashes"]);
  expect(confirmState(addMachineAsk("mac", [haile], ["mac"]), "").unmet.map((c) => c.title)).toEqual(["No machine has that name yet"]);
  expect(confirmState(addMachineAsk("office-pc", [], []), "").unmet.map((c) => c.title)).toEqual(["At least one agent is picked"]);
  const s = addMachineAsk("office-pc", [haile, taytu], []);
  expect(s.happens).toContain("haile and taytu");
  const words = [s.title, s.happens, s.doesNot, s.action, ...s.checks.flatMap((c) => [c.title, c.sub ?? ""])].join(" ");
  expect(words).not.toMatch(/factory [a-z]|--[a-z]/);
  expect(agentArgs([haile, taytu])).toEqual(["haile:coding-agent", "taytu:dev-manager"]);
});

test("a refusal that names a command is shown in plain words instead", () => {
  expect(plainProblem("The name office-pc is taken.", "Pick another name.")).toEqual({ message: "The name office-pc is taken.", fix: "Pick another name." });
  const p = plainProblem("`factory machine add x` failed (exit 1).", "Run `factory machine add x` in /p to see the whole error.");
  expect(`${p.message} ${p.fix}`).not.toMatch(/factory [a-z]|--[a-z]|`/);
});
