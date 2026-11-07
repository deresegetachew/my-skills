// A release finishes its own install, whichever client unpacked it (#520). On the fresh-install test an old client
// (v0.1.0-alpha.3, the Python factory) installed v0.2.6 by its own rules: 23 files the release ships were left out, the
// pin listed only what that client wrote, and it said "verified". The release now carries the list of its factory files
// (.claude/hooks/factory_release_files.json, written by the builder; every client installs hooks/), so the new factory
// can tell, offline, that its install is incomplete: `factory` warns on start, doctor names it, and one
// `factory update` finishes it.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { tarEntries } from "../hooks/factory_tar.ts";
import { buildRelease, commit, type Env, fac, git, PIN, pin, sha256, snapshot, spawn, world } from "./release_support.ts";
import { HOOKS, SF } from "./support.ts";

const PLAN = ".claude/hooks/factory_release_files.json";
const BOARD = ".claude/message-board/bin.ts";
const SETTINGS = ".claude/factory/settings.json";
const STALE = ".claude/hooks/factory_x.ts";
const NEW_FILES = { "message-board/bin.ts": "export const BOARD = 1;\n", "hooks/factory_old.ts": null };
const read = (p: string): string => readFileSync(p, "utf8");

test("the release builder ships the list of the release's factory files, installed with the hooks", () => {
  const dist = buildRelease("1.0.0", NEW_FILES);
  const data = readFileSync(join(dist, "software-factory-1.0.0.tar.gz"));
  const members = [...tarEntries(new Uint8Array(gunzipSync(data)))];
  const plan = members.find((m) => m.name === "software-factory-1.0.0/hooks/factory_release_files.json");
  expect(plan, "the archive carries it").toBeDefined();
  const doc = JSON.parse(new TextDecoder().decode(plan?.data)) as { version: string; files: Record<string, string>; executable: string[] };
  expect(doc.version).toBe("1.0.0");
  expect(Object.keys(doc.files)).toContain(BOARD);
  expect(Object.keys(doc.files)).toContain(SETTINGS);
  expect(Object.keys(doc.files)).toContain("factory");
  expect(Object.keys(doc.files), "templates are the project's, not listed").not.toContain("docs/blocked.md");
  expect(Object.keys(doc.files), "it cannot hold its own hash").not.toContain(PLAN);
  const bin = members.find((m) => m.name.endsWith("/message-board/bin.ts"));
  expect(doc.files[BOARD]).toBe(sha256(bin?.data ?? new Uint8Array()));
  expect(doc.executable).toContain("factory");
  const manifest = members.find((m) => m.name.endsWith("/MANIFEST.json"));
  const files = (JSON.parse(new TextDecoder().decode(manifest?.data)) as { files: { path: string; install: unknown }[] }).files;
  expect(files.find((f) => f.path === "hooks/factory_release_files.json")?.install, "listed in the manifest, installed as an engine file")
    .toEqual({ kind: "engine", to: PLAN });
});

/** A project that was on v0.9.0 and where an old client then put v1.0.0 in place by its own rules: it left out the
 * message board and the agents' rules, wrote an older copy of one hook, and pinned only what it wrote. Nothing is
 * committed after it, as the old client leaves it. Returns [project, env, archive, sums]. */
async function oldClientInstall(): Promise<[string, Env, string, string]> {
  const [gh, d, env] = await world("0.9.0");
  expect((await fac(d, env, "update", "v0.9.0"))[0]).toBe(0);
  commit(d, "factory 0.9.0");
  const dist = gh.add("1.0.0", { date: "2026-11-01T10:00:00Z", files: NEW_FILES });
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc, out).toBe(0);
  const p = JSON.parse(read(join(d, PIN))) as { files: Record<string, string> };
  for (const rel of [BOARD, SETTINGS]) {
    delete p.files[rel];
    unlinkSync(join(d, rel));
  }
  writeFileSync(join(d, STALE), "export const VERSION = \"0.9.0\";\n");
  p.files[STALE] = sha256("export const VERSION = \"0.9.0\";\n");
  writeFileSync(join(d, PIN), JSON.stringify(p, null, 2) + "\n");
  return [d, env, join(dist, "software-factory-1.0.0.tar.gz"), join(dist, "SHA256SUMS")];
}

const OFFLINE = (env: Env): Env => ({ ...env, FACTORY_RELEASE_API: "http://127.0.0.1:9" });

test("check-install names an install an old client left incomplete, and the fix", async () => {
  const [d, env] = await oldClientInstall();
  const before = snapshot(d);
  const [rc, out] = await fac(d, OFFLINE(env), "check-install");
  expect(rc, "it only warns: the command the person ran goes on").toBe(0);
  expect(out).toContain("[incomplete_install]");
  expect(out).toContain(`${BOARD} is missing (v1.0.0 ships it)`);
  expect(out).toContain(`${SETTINGS} is missing (v1.0.0 ships it)`);
  expect(out).toContain(`${STALE} is not v1.0.0's copy`);
  expect(out).toMatch(/Fix: run `factory update`/);
  expect(out).toContain("--archive");
  expect(snapshot(d), "a check changes nothing").toEqual(before);
});

test("one factory update finishes the install from a local archive, and a second changes nothing", async () => {
  const [d, env, archive, sums] = await oldClientInstall();
  let [rc, out] = await fac(d, OFFLINE(env), "update", "--archive", archive, "--sums", sums);
  expect(rc, out).toBe(0);
  expect(out).toContain("repaired");
  expect(out).toContain("(verified)");
  expect(read(join(d, BOARD))).toBe("export const BOARD = 1;\n");
  expect(existsSync(join(d, SETTINGS))).toBe(true);
  expect(read(join(d, STALE))).toContain("1.0.0");
  expect(Object.keys(pin(d).files)).toEqual(expect.arrayContaining([BOARD, SETTINGS, STALE, PLAN]));
  [rc, out] = await fac(d, OFFLINE(env), "check-install");
  expect(rc === 0 && !out.includes("incomplete"), out).toBe(true);
  const after = snapshot(d);
  [rc, out] = await fac(d, OFFLINE(env), "update", "--archive", archive, "--sums", sums);
  expect(rc === 0 && out.includes("already on v1.0.0"), out).toBe(true);
  expect(snapshot(d), "the second run changes nothing").toEqual(after);
});

test("the plain factory update finishes it too, from the download cache", async () => {
  const [d, env] = await oldClientInstall();
  const [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(read(join(d, BOARD))).toBe("export const BOARD = 1;\n");
});

test("an incomplete install that cannot fetch the release is refused with the fix, and nothing changes", async () => {
  const [d, env] = await oldClientInstall();
  const off = { ...OFFLINE(env), FACTORY_CACHE_DIR: join(env.FACTORY_CACHE_DIR as string, "empty") };
  const before = snapshot(d);
  const [rc, out] = await fac(d, off, "update");
  expect(rc, out).toBe(1);
  expect(out).toContain("[incomplete_install]");
  expect(out).toContain(BOARD);
  expect(out).toContain("Fix:");
  expect(out).toContain("--archive");
  expect(snapshot(d)).toEqual(before);
});

test("a change of the project's own in a factory file still refuses the repair while it is uncommitted", async () => {
  const [d, env, archive, sums] = await oldClientInstall();
  writeFileSync(join(d, ".claude/agents/a.md"), "my own edit\n");
  const before = snapshot(d);
  const [rc, out] = await fac(d, OFFLINE(env), "update", "--archive", archive, "--sums", sums);
  expect(rc === 1 && out.includes("[dirty_tree]"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
});

test("the factory command warns on start while the install is incomplete, and is quiet once it is finished", async () => {
  const [d, env, archive, sums] = await oldClientInstall();
  // the project's own copy of the client is this one (the release's fake hooks stand in for the rest)
  symlinkSync(join(HOOKS, "factory_release.ts"), join(d, ".claude/hooks/factory_release.ts"));
  writeFileSync(join(d, ".claude/hooks/factory_status.ts"), "console.log('status ran');\n");
  const factory = (e: Env): Promise<[number, string]> => spawn(["bash", join(SF, "factory"), "status"], d, e);
  let [rc, out] = await factory(OFFLINE(env));
  expect(rc, out).toBe(0);
  expect(out).toContain("status ran");
  expect(out).toContain("[incomplete_install]");
  expect((await fac(d, OFFLINE(env), "update", "--archive", archive, "--sums", sums))[0]).toBe(0);
  [rc, out] = await factory(OFFLINE(env));
  expect(rc, out).toBe(0);
  expect(out).toContain("status ran");
  expect(out).not.toContain("incomplete");
  git(d, "status", "--porcelain"); // still a working repo
});

test("factory version and doctor name the incomplete install with the fix", async () => {
  const [d, env] = await oldClientInstall();
  const [, version] = await fac(d, OFFLINE(env), "version");
  expect(version).toContain(`${BOARD} is missing (v1.0.0 ships it)`);
  const code = "import { release, Report } from " + JSON.stringify(join(HOOKS, "factory_doctor.ts")) + ";\n" +
    "process.chdir(" + JSON.stringify(d) + "); release(new Report());\n";
  const [, out] = await spawn([process.execPath, "--no-env-file", "-e", code], d, OFFLINE(env));
  expect(out).toMatch(/fix {3}factory v1\.0\.0: the install is incomplete/);
  expect(out).toContain(BOARD);
  expect(out).toContain("run `factory update`");
});
