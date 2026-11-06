// The web UI's sign-off and testing endpoints (#454): the queue read through `factory signoff ls --all --json` (the server
// runs the hook itself, through the fake `gh`), and the three actions (add, confirm, result) that run `factory signoff ...`
// through the fake `factory` script, which logs what it was asked. Bad input is refused before anything runs.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write, writeExe } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const c = (body: string, login: string, at: string): Row => ({ body, created_at: at, user: { login } });

function seed(p: Project): void {
  write(join(p.root, "db.json"), JSON.stringify({
    issues: [{ number: 50, title: "Sign-off and testing queue", body: "", state: "open", labels: [] }],
    comments: { "50": [
      c("<!-- factory-signoff id=arabic-label task=12 -->\nTo check: Read the warning", "fasil", "2026-11-05T09:00:00Z"),
      c("<!-- factory-testplan id=proposed-plan task=13 -->\n1. Open the link.", "mentewab", "2026-11-05T10:05:00Z"),
      c("<!-- factory-testplan id=confirmed-plan task=14 -->\n1. Tap Start.", "mentewab", "2026-11-05T10:10:00Z"),
      c("<!-- factory-testplan-confirm id=confirmed-plan by=boss -->", "boss", "2026-11-05T10:40:00Z"),
      c("<!-- factory-testplan id=passed-plan task=15 -->\n1. Log in.", "mentewab", "2026-11-05T10:15:00Z"),
      c("<!-- factory-testplan-confirm id=passed-plan by=boss -->", "boss", "2026-11-05T10:45:00Z"),
      c("<!-- factory-testresult id=passed-plan result=pass by=boss -->\nAll good", "boss", "2026-11-05T11:20:00Z"),
    ] },
  }));
}

async function started(opts: { seeded?: boolean; brokenGh?: boolean } = {}): Promise<{ ui: Running; p: Project }> {
  const p = project();
  roots.push(p.root);
  if (opts.seeded ?? true) seed(p);
  if (opts.brokenGh) writeExe(join(p.root, "bin", "gh"), "#!/bin/sh\necho boom >&2\nexit 1\n");
  const ui = await startUi(p);
  running.push(ui);
  return { ui, p };
}

function factoryCalls(p: Project): string[] {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter(Boolean);
}

const BASE = "/api/projects/work/signoff";

test("the queue: every item with its kind, state, who and when, and its history", async () => {
  const { ui } = await started();
  const r = await api(ui, BASE);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.project).toBe("work");
  expect(r.json.queue).toBe(50);
  expect(r.json.problems).toEqual([]);
  const items = r.json.items as Row[];
  const by = (id: string): Row => items.find((i) => i.id === id) as Row;
  expect(items.map((i) => i.id).sort()).toEqual(["arabic-label", "confirmed-plan", "passed-plan", "proposed-plan"]);
  expect(by("arabic-label")).toMatchObject({ kind: "signoff", task: "12", by: "fasil", at: "2026-11-05T09:00:00Z" });
  expect(by("proposed-plan")).toMatchObject({ kind: "testplan", confirmed: false, by: "mentewab" });
  expect(by("confirmed-plan")).toMatchObject({ kind: "testplan", confirmed: true });
  expect(by("passed-plan")).toMatchObject({ kind: "testplan", state: "passed" });
  expect((by("passed-plan").history as Row[]).map((h) => h.what)).toEqual(["proposed", "confirmed", "result"]);
  expect((by("arabic-label").history as Row[])[0]).toMatchObject({ what: "added", by: "fasil" });
}, T);

test("no queue yet is an empty list, not a problem", async () => {
  const { ui } = await started({ seeded: false });
  const r = await api(ui, BASE);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ project: "work", queue: null, items: [], problems: [] });
}, T);

test("a queue that cannot be read comes back empty with a problem that says what to do", async () => {
  const { ui } = await started({ brokenGh: true });
  const r = await api(ui, BASE);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.items).toEqual([]);
  const problems = r.json.problems as Row[];
  expect(problems.length).toBe(1);
  expect(problems[0]?.code).toBe("ui_signoff_unreadable");
  expect(String(problems[0]?.message)).not.toBe("");
  expect(String(problems[0]?.fix)).not.toBe("");
}, T);

test("without the token every sign-off endpoint says 401", async () => {
  const { ui, p } = await started();
  expect((await api(ui, BASE, { token: null })).status).toBe(401);
  expect((await api(ui, BASE, { method: "POST", token: null, body: { id: "x1", task: 1, check: "look" } })).status).toBe(401);
  expect((await api(ui, `${BASE}/login-flow/confirm`, { method: "POST", token: null })).status).toBe(401);
  expect((await api(ui, `${BASE}/login-flow/result`, { method: "POST", token: null, body: { outcome: "pass" } })).status).toBe(401);
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("add: runs factory signoff add and shows the plain command", async () => {
  const { ui, p } = await started();
  const r = await api(ui, BASE, { method: "POST", body: { id: "login-page", task: 12, check: "Open it on a phone" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.command).toBe("factory signoff add login-page --task 12 --check Open it on a phone");
  expect(typeof r.json.output).toBe("string");
  expect(factoryCalls(p)).toEqual(["signoff add login-page --task 12 --check Open it on a phone"]);
}, T);

test("add: bad input is refused with signoff_bad_input and nothing runs", async () => {
  const { ui, p } = await started();
  const bad: Row[] = [
    { id: "../x", task: 1, check: "look" }, { id: "", task: 1, check: "look" }, { task: 1, check: "look" },
    { id: "ok", check: "look" }, { id: "ok", task: 0, check: "look" }, { id: "ok", task: "abc", check: "look" },
    { id: "ok", task: 1, check: "" }, { id: "ok", task: 1, check: "   " }, { id: "ok", task: 1 },
  ];
  for (const body of bad) {
    const r = await api(ui, BASE, { method: "POST", body });
    expect(r.status, JSON.stringify(body)).toBe(400);
    expect(r.json.code, JSON.stringify(body)).toBe("signoff_bad_input");
  }
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("confirm: runs factory signoff confirm", async () => {
  const { ui, p } = await started();
  const r = await api(ui, `${BASE}/login-flow/confirm`, { method: "POST" });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.command).toBe("factory signoff confirm login-flow");
  expect(factoryCalls(p)).toEqual(["signoff confirm login-flow"]);
}, T);

test("result: a fail with its note, a pass without one", async () => {
  const { ui, p } = await started();
  const f = await api(ui, `${BASE}/login-flow/result`, { method: "POST", body: { outcome: "fail", note: "Step 2 failed: no inbox" } });
  expect(f.status, JSON.stringify(f.json)).toBe(200);
  const ok = await api(ui, `${BASE}/login-flow/result`, { method: "POST", body: { outcome: "pass" } });
  expect(ok.status).toBe(200);
  expect(factoryCalls(p)).toEqual(["signoff result login-flow fail --note Step 2 failed: no inbox", "signoff result login-flow pass"]);
}, T);

test("result: an outcome that is not one, or an id that is not an id, runs nothing", async () => {
  const { ui, p } = await started();
  const maybe = await api(ui, `${BASE}/login-flow/result`, { method: "POST", body: { outcome: "maybe" } });
  expect(maybe.status).toBe(400);
  expect(maybe.json.code).toBe("signoff_bad_input");
  const none = await api(ui, `${BASE}/login-flow/result`, { method: "POST", body: {} });
  expect(none.status).toBe(400);
  const id = await api(ui, `${BASE}/${encodeURIComponent("a b")}/result`, { method: "POST", body: { outcome: "pass" } });
  expect(id.status).toBe(400);
  const id2 = await api(ui, `${BASE}/${encodeURIComponent("a b")}/confirm`, { method: "POST" });
  expect(id2.status).toBe(400);
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("a GET on an action path says 405", async () => {
  const { ui, p } = await started();
  expect((await api(ui, `${BASE}/login-flow/confirm`)).status).toBe(405);
  expect((await api(ui, `${BASE}/login-flow/result`)).status).toBe(405);
  expect(factoryCalls(p)).toEqual([]);
}, T);
