// The web UI and GitHub (#473): with nobody looking it makes no GitHub call; with a tab open its snapshots do not run
// doctor again and again. Here `factory` is the real one and the project's hooks are the real hooks, so the server's
// snapshot and messages reads run for real against the fake gh, whose log says what was asked.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { project, startUi, type Project, type Row } from "./web_ui_support.ts";
import { HOOKS, SF } from "./support.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A project whose `factory` and hooks are the real ones. */
function real(): Project {
  const p = project();
  roots.push(p.root);
  copyFileSync(join(SF, "factory"), join(p.d, "factory"));
  symlinkSync(HOOKS, join(p.d, ".claude", "hooks"));
  return p;
}

/** The calls only doctor makes. */
const DOCTOR = /branches\/main\/protection|rules\/branches\/main|auth status/;

const log = (p: Project): string => (existsSync(p.ghLog) ? readFileSync(p.ghLog, "utf8") : "");
const generatedAt = (p: Project): string => {
  try {
    return String((JSON.parse(readFileSync(join(p.state, "snapshot.json"), "utf8")) as Row).generatedAt ?? "");
  } catch {
    return "";
  }
};

async function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

test("with the UI running and no tab open, GitHub is not called", async () => {
  const p = real();
  const ui = await startUi(p);
  await Bun.sleep(5000);
  const calls = log(p);
  await ui.stop();
  expect(calls).toBe("");
}, 30_000);

test("with a tab open, snapshots after the first make no doctor calls (FACTORY_SNAPSHOT_DOCTOR_SECONDS is passed to them)", async () => {
  const p = real();
  const ui = await startUi(p, ["--port", "0"], null, { FACTORY_SNAPSHOT_CACHE_SECONDS: "2" });
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  try {
    await until("the first snapshot", () => generatedAt(p) !== "", 25_000);
    const first = generatedAt(p);
    const mark = log(p).length;
    expect(log(p).split("\n").filter((c) => DOCTOR.test(c)).length, log(p)).toBeGreaterThan(0); // the first one ran doctor
    await until("a second snapshot", () => generatedAt(p) !== first, 25_000);
    const second = generatedAt(p);
    await until("a third snapshot", () => generatedAt(p) !== second, 25_000);
    const later = log(p).slice(mark).split("\n").filter(Boolean);
    expect(later.length, "snapshots ran").toBeGreaterThan(0);
    expect(later.filter((c) => DOCTOR.test(c)), later.join("\n")).toEqual([]);
  } finally {
    ws.close();
    await ui.stop();
  }
}, 60_000);
