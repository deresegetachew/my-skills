// The owner's own avatar for an agent (#437): an image file in the project, .claude/factory/avatars/<name>.<png|jpg|jpeg|
// webp|gif|svg>, comes with that agent's channel as a data address the page shows in place of the drawn one. Run against
// the real server on a free port.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, heartbeat, hbRow, project, startUi, type Running } from "./web_ui_support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="red"/></svg>`;

function avatars(p: ReturnType<typeof project>): string {
  const dir = join(p.d, ".claude", "factory", "avatars");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function channelsOf(p: ReturnType<typeof project>, first = ""): Promise<Record<string, Record<string, unknown>>> {
  roots.push(p.root);
  const ui = await startUi(p);
  running.push(ui);
  if (first) await api(ui, first);
  const r = await api(ui, "/api/projects/work/channels");
  expect(r.status).toBe(200);
  return Object.fromEntries((r.json.channels as Record<string, unknown>[]).map((c) => [String(c.name), c]));
}

test("an agent with an image in .claude/factory/avatars gets it as a data address; the others get none", async () => {
  const p = project();
  const dir = avatars(p);
  writeFileSync(join(dir, "menelik.png"), PNG);
  writeFileSync(join(dir, "fasil.svg"), SVG);
  writeFileSync(join(dir, "mentewab.JPG"), PNG);
  const c = await channelsOf(p);
  expect(c.menelik?.avatar).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  expect(c.fasil?.avatar).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
  expect(c.mentewab?.avatar).toBe(`data:image/jpeg;base64,${PNG.toString("base64")}`);
  expect(c.taytu?.avatar ?? null).toBeNull();
  for (const v of ["tasks", "pull-requests", "ci", "owner-queue", "machines"]) expect(c[v]?.avatar ?? null).toBeNull();
}, T);

test("a file that isn't an image, or is over 256 KB, is not taken: the agent keeps its drawn avatar", async () => {
  const p = project();
  const dir = avatars(p);
  writeFileSync(join(dir, "menelik.txt"), "not an image");
  writeFileSync(join(dir, "taytu.png"), Buffer.alloc(256 * 1024 + 1, 1));
  const c = await channelsOf(p);
  expect(c.menelik?.avatar ?? null).toBeNull();
  expect(c.taytu?.avatar ?? null).toBeNull();
}, T);

test("an agent name a heartbeat reports is never read as a path out of the avatars folder", async () => {
  const p = project();
  avatars(p);
  writeFileSync(join(p.d, ".claude", "factory", "secret.png"), PNG);
  heartbeat(p, [hbRow("../secret")]);
  const c = await channelsOf(p, "/api/projects/work/agents");
  expect(c["../secret"]).toBeDefined();
  expect(c["../secret"]?.avatar ?? null).toBeNull();
}, T);
