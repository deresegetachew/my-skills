// The web UI's designs and artifacts endpoints (#454): the manifest's rows with their state (read through
// `factory artifacts status --json`, with a fake version lookup), the open review pull request of each from the cockpit's
// cache, and the pull action, which runs `factory artifacts pull ... --pr` through the fake `factory` script.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write, writeExe } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// aaa111 is current, bbb222 has a newer version, ccc333 has no folder.
const INFO = '#!/bin/sh\ncase "$1" in\n  *bbb222*) echo \'{"updated": "2026-11-01T00:00:00Z"}\' ;;\n  *) echo \'{"updated": "2026-10-01T00:00:00Z"}\' ;;\nesac\n';

function entry(id: string, dest: string, title: string): Row {
  return { id, url: `https://claude.ai/artifact/${id}`, dest, title, updated: "2026-10-20T10:00:00Z", version: "1",
    pulledBy: "mentewab", pulledAt: "2026-11-01T09:00:00Z", files: { "index.html": sha(`<p>${id}</p>`) } };
}

function seed(p: Project, fetch: boolean): void {
  const info = join(p.root, "info.sh");
  writeExe(info, INFO);
  const art: Row = { info: `sh ${info} {url}` };
  if (fetch) art.fetch = "sh -c true";
  write(join(p.d, ".claude", "factory.json"), JSON.stringify({ ...CONFIG, artifacts: art }));
  write(join(p.d, "docs", "design", "a", "index.html"), "<p>aaa111</p>");
  write(join(p.d, "docs", "design", "b", "index.html"), "<p>bbb222</p>");
  write(join(p.d, "docs", "artifacts.json"), JSON.stringify({ artifacts: [
    entry("aaa111", "docs/design/a", "Home page"), entry("bbb222", "docs/design/b", "Login page"),
    entry("ccc333", "docs/design/c", "Settings") ] }));
}

async function started(o: { manifest?: boolean; fetch?: boolean; pulls?: Row[] } = {}): Promise<{ ui: Running; p: Project }> {
  const p = project();
  roots.push(p.root);
  if (o.manifest ?? true) seed(p, o.fetch ?? true);
  write(join(p.state, "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [] }, pulls: o.pulls ?? [], ci: null }));
  const ui = await startUi(p);
  running.push(ui);
  return { ui, p };
}

function factoryCalls(p: Project): string[] {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter(Boolean);
}

const BASE = "/api/projects/work/artifacts";

const REVIEW: Row = { number: 31, title: "New copy of Login page", url: "https://github.com/o/work/pull/31", branch: "artifacts/bbb222/20261105-1000",
  draft: false, ci: "green", next: "owner-merges", nextText: "owner merges", agent: null, review: null, gate: null, notGreen: [],
  protected: null, claim: null };

test("the list: each copy with its title, where it is, who pulled it and how it stands", async () => {
  const { ui } = await started();
  const r = await api(ui, BASE);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.project).toBe("work");
  expect(r.json.fetch).toBe(true);
  expect(r.json.problems).toEqual([]);
  const rows = r.json.artifacts as Row[];
  expect(rows.map((x) => x.id)).toEqual(["aaa111", "bbb222", "ccc333"]);
  expect(rows[0]).toMatchObject({ id: "aaa111", url: "https://claude.ai/artifact/aaa111", title: "Home page", dest: "docs/design/a",
    pulledAt: "2026-11-01T09:00:00Z", pulledBy: "mentewab", state: "current", review: null });
  expect(typeof rows[0]?.detail).toBe("string");
  expect(rows[1]).toMatchObject({ state: "older", review: null });
  expect(rows[2]).toMatchObject({ state: "missing", review: null });
}, T);

test("fetch says whether this machine can fetch an artifact", async () => {
  const { ui } = await started({ fetch: false });
  const r = await api(ui, BASE);
  expect(r.status).toBe(200);
  expect(r.json.fetch).toBe(false);
}, T);

test("a copy with an open review pull request carries its number and link", async () => {
  const { ui } = await started({ pulls: [REVIEW, { ...REVIEW, number: 40, branch: "task/9-other", url: "https://github.com/o/work/pull/40" }] });
  const r = await api(ui, BASE);
  const rows = r.json.artifacts as Row[];
  expect(rows[1]?.review).toEqual({ number: 31, url: "https://github.com/o/work/pull/31" });
  expect(rows[0]?.review).toBeNull();
  expect(rows[2]?.review).toBeNull();
}, T);

test("no manifest is an empty list", async () => {
  const { ui } = await started({ manifest: false });
  const r = await api(ui, BASE);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.artifacts).toEqual([]);
}, T);

test("pull: asks for a pull request with the artifact, and a folder when given", async () => {
  const { ui, p } = await started();
  const a = await api(ui, `${BASE}/pull`, { method: "POST", body: { artifact: "https://claude.ai/artifact/abc123", confirm: true } });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  expect(a.json.ok).toBe(true);
  const b = await api(ui, `${BASE}/pull`, { method: "POST",
    body: { artifact: "https://claude.ai/artifact/abc123", dest: "docs/design/x", confirm: true } });
  expect(b.status).toBe(200);
  expect(factoryCalls(p)).toEqual(["artifacts pull https://claude.ai/artifact/abc123 --pr",
    "artifacts pull https://claude.ai/artifact/abc123 docs/design/x --pr"]);
}, T);

test("pull: without confirm true it asks again and runs nothing", async () => {
  const { ui, p } = await started();
  for (const body of [{ artifact: "https://claude.ai/artifact/abc123" }, { artifact: "https://claude.ai/artifact/abc123", confirm: false }]) {
    const r = await api(ui, `${BASE}/pull`, { method: "POST", body });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("confirm_needed");
  }
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("pull: an empty artifact or an odd folder is refused and runs nothing", async () => {
  const { ui, p } = await started();
  const bad: Row[] = [{ artifact: "" }, { artifact: "   " }, {}, { artifact: "abc123", dest: "-rf" }, { artifact: "abc123", dest: "/etc" },
    { artifact: "abc123", dest: "../out" }, { artifact: "abc123", dest: "docs/../../x" }, { artifact: "-x" }];
  for (const b of bad) {
    const r = await api(ui, `${BASE}/pull`, { method: "POST", body: { ...b, confirm: true } });
    expect(r.status, JSON.stringify(b)).toBe(400);
    expect(r.json.code, JSON.stringify(b)).toBe("artifacts_bad_input");
  }
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("without the token both endpoints say 401", async () => {
  const { ui, p } = await started();
  expect((await api(ui, BASE, { token: null })).status).toBe(401);
  expect((await api(ui, `${BASE}/pull`, { method: "POST", token: null, body: { artifact: "abc123", confirm: true } })).status).toBe(401);
  expect(factoryCalls(p)).toEqual([]);
}, T);
