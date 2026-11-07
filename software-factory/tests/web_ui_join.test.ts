// The web UI's Join my factory (#457): POST /api/setup/join/preview reads a join code (what `factory machine add` printed
// on the hub) and says what it connects to, without its password; POST /api/setup/join runs `factory machine join <code>`
// on this machine after a confirm. `factory` is a fake that logs what it was asked; nothing reaches a board.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { encodeCode } from "../hooks/factory_join_code.ts";
import { api, project, startUi, type Running } from "./web_ui_support.ts";
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
if [ "$1 $2" = "machine join" ]; then
  if [ -f "$FAKE_JOIN_FAIL" ]; then
    echo '{"code": "code-expired", "message": "The join code for office-pc has expired.", "fix": "Ask for a new one."}' >&2
    exit 1
  fi
  echo "Joined the board at 100.64.0.1:5432 as office-pc."
fi
`;

const SECRET = "s3cret-pass";

function code(exp = Math.floor(Date.now() / 1000) + 900): string {
  return encodeCode({ v: 2, id: "abc123", name: "office-pc", exp, url: `postgres://office-pc:${SECRET}@100.64.0.1:5432/board`,
    agents: [{ name: "menelik", role: "builder" }, { name: "fasil", role: "manager" }] });
}

async function started() {
  const p = project();
  roots.push(p.root);
  write(join(p.d, "factory"), FAKE, 0o755);
  p.env.FAKE_JOIN_FAIL = join(p.root, "join-fail");
  const ui = await startUi(p);
  running.push(ui);
  return { p, ui };
}

test("the join endpoints need the token, and nothing runs without it", async () => {
  const { p, ui } = await started();
  for (const path of ["/api/setup/join/preview", "/api/setup/join"]) {
    const r = await api(ui, path, { method: "POST", body: { code: code(), confirm: true }, token: null });
    expect(r.status).toBe(401);
  }
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
}, T);

test("preview: a code says what it connects to (hub, machine, agents, expiry), never its password, and runs nothing", async () => {
  const { p, ui } = await started();
  const c = code();
  const r = await api(ui, "/api/setup/join/preview", { method: "POST", body: { code: `  ${c}\n` } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toMatchObject({ machine: "office-pc", hub: "100.64.0.1:5432",
    agents: [{ name: "menelik", role: "builder" }, { name: "fasil", role: "manager" }] });
  expect(typeof r.json.expiresAt).toBe("number");
  const text = JSON.stringify(r.json);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("postgres://");
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
}, T);

test("preview: anything that isn't a join code, or an expired one, is 400 with {code, message, fix}", async () => {
  const { ui } = await started();
  for (const [body, want] of [[{ code: "hello" }, "ui_join_code"], [{}, "ui_join_code"], [{ code: code(1) }, "ui_join_expired"]] as const) {
    const r = await api(ui, "/api/setup/join/preview", { method: "POST", body });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(want);
    expect(typeof r.json.message).toBe("string");
    expect(typeof r.json.fix).toBe("string");
    expect(JSON.stringify(r.json)).not.toContain(SECRET);
  }
}, T);

test("join without a confirm is 400 confirm_needed and runs nothing; with one it runs factory machine join with the code", async () => {
  const { p, ui } = await started();
  const c = code();
  const no = await api(ui, "/api/setup/join", { method: "POST", body: { code: c } });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("confirm_needed");
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
  const r = await api(ui, "/api/setup/join", { method: "POST", body: { code: c, confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(String(r.json.output)).toContain("Joined the board");
  expect(readFileSync(p.factoryLog, "utf8").trim()).toBe(`machine join ${c}`);
  expect(JSON.stringify(r.json)).not.toContain(c); // the code is the secret: not sent back
}, T);

test("join: a bad code never reaches the command; a join that fails answers with its own {code, message, fix}", async () => {
  const { p, ui } = await started();
  const bad = await api(ui, "/api/setup/join", { method: "POST", body: { code: "--no-doctor", confirm: true } });
  expect(bad.status).toBe(400);
  expect(bad.json.code).toBe("ui_join_code");
  expect(readFileSync(p.factoryLog, "utf8")).toBe("");
  write(join(p.root, "join-fail"), "1");
  const c = code();
  const r = await api(ui, "/api/setup/join", { method: "POST", body: { code: c, confirm: true } });
  expect(r.status).toBe(500);
  expect(r.json).toMatchObject({ ok: false, code: "code-expired", fix: "Ask for a new one." });
  expect(JSON.stringify(r.json)).not.toContain(c);
}, T);
