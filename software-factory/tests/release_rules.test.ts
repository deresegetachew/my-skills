// Which file goes where follows the release being installed (#278). On remanual, `factory update` ran the project's
// own (older) release client, whose rules did not know the new release's `.claude/factory/settings.json`, so the file
// was never installed and a second update on the same tag did not notice. A release's MANIFEST.json now says where each
// file goes, and an update on the same tag repairs an engine file the release ships that the project lacks.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { tarEntries } from "../hooks/factory_tar.ts";
import { buildRelease, commit, fac, git, PIN, pin, setInstall, snapshot, world } from "./release_support.ts";

const read = (p: string): string => readFileSync(p, "utf8");
const NEW_FILE = "kit/.claude/rules/agents.json"; // a place this client's own rules call a template
const NEW_TARGET = ".claude/rules/agents.json";

test("an update installs a file in a new engine place the release's manifest names", async () => {
  const [gh, d, env] = await world("1.0.0");
  expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
  commit(d);
  gh.add("1.1.0", { date: "2026-11-01T10:00:00Z", files: { [NEW_FILE]: '{"rules": "1.1.0"}\n' },
    install: { [NEW_FILE]: ["engine", NEW_TARGET] } });
  let [rc, out] = await fac(d, env, "update", "v1.1.0");
  expect(rc, out).toBe(0);
  expect(read(join(d, NEW_TARGET)), "installed where the new release says, though this client's rules call it a template").toBe('{"rules": "1.1.0"}\n');
  expect(Object.keys(pin(d).files), "and recorded, so verification and the next update know it").toContain(NEW_TARGET);
  commit(d);
  gh.add("1.2.0", { date: "2026-12-01T10:00:00Z" });
  [rc, out] = await fac(d, env, "update", "v1.2.0");
  expect(rc, out).toBe(0);
  expect(existsSync(join(d, NEW_TARGET)), "an engine file the next release drops is removed").toBe(false);
});

test("a local archive follows its manifest too", async () => {
  const [, d, env] = await world();
  const dist = buildRelease("1.0.0", { [NEW_FILE]: "{}\n" });
  setInstall(dist, "1.0.0", { [NEW_FILE]: ["engine", NEW_TARGET], "kit/docs/blocked.md": null });
  const [rc, out] = await fac(d, { ...env, FACTORY_RELEASE_API: "http://127.0.0.1:9" }, "update", "--archive",
    join(dist, "software-factory-1.0.0.tar.gz"), "--sums", join(dist, "SHA256SUMS"));
  expect(rc, out).toBe(0);
  expect(Object.keys(pin(d).files)).toContain(NEW_TARGET);
  expect(existsSync(join(d, "docs/blocked.md")), "a file the manifest says is not installed is not").toBe(false);
});

test("a release built before the manifest carried the rules installs by this client's rules", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0", { install: "none" });
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc, out).toBe(0);
  expect(read(join(d, ".claude/hooks/factory_x.ts"))).toContain("1.0.0");
  expect(Object.keys(pin(d).files)).toContain(".claude/factory/settings.json");
});

test("the release builder writes where each file goes into the manifest", async () => {
  const dist = buildRelease("1.0.0");
  const data = readFileSync(join(dist, "software-factory-1.0.0.tar.gz"));
  const entry = [...tarEntries(new Uint8Array(gunzipSync(data)))].find((m) => m.name.endsWith("/MANIFEST.json"));
  const files = (JSON.parse(new TextDecoder().decode(entry?.data)) as { files: { path: string; install?: unknown }[] }).files;
  const rule = (p: string): unknown => files.find((f) => f.path === p)?.install;
  expect(rule("hooks/factory_x.ts")).toEqual({ kind: "engine", to: ".claude/hooks/factory_x.ts" });
  expect(rule("kit/.claude/factory/settings.json")).toEqual({ kind: "engine", to: ".claude/factory/settings.json" });
  expect(rule("kit/docs/blocked.md")).toEqual({ kind: "template", to: "docs/blocked.md" });
  expect(rule("README.md")).toBeNull();
  expect(files.every((f) => "install" in f), "every file has a rule").toBe(true);
});

test("a manifest that would write outside the factory's places is refused and nothing changes", async () => {
  for (const [kind, to] of [["engine", "src/app.ts"], ["template", "../outside.txt"], ["engine", PIN], ["template", ".git/hooks/pre-commit"],
    ["engine", ".claude/factory.json"], ["other", ".claude/x"]] as [string, string][]) {
    const [gh, d, env] = await world("1.0.0");
    expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
    commit(d);
    gh.add("1.1.0", { date: "2026-11-01T10:00:00Z", install: { "kit/docs/blocked.md": [kind, to] } });
    const before = snapshot(d);
    const [rc, out] = await fac(d, env, "update", "v1.1.0");
    expect(rc === 1 && out.includes("[unsafe_archive]") && out.includes("Fix:"), `${kind} ${to}\n${out}`).toBe(true);
    expect(snapshot(d), `${kind} ${to}`).toEqual(before);
  }
});

test("two files the manifest sends to one place are refused", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0", { install: { "kit/docs/blocked.md": ["engine", ".claude/agents/a.md"] } });
  const before = snapshot(d);
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc === 1 && out.includes("[unsafe_archive]") && out.includes(".claude/agents/a.md"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
});

/** A project on v1.0.0 that lacks an engine file the release ships, and whose pin does not list it (what an older
 * client's rules left on remanual). */
async function missingSettings(): Promise<[string, Record<string, string | undefined>]> {
  const [, d, env] = await world("1.0.0");
  expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
  const p = JSON.parse(read(join(d, PIN))) as { files: Record<string, string> };
  delete p.files[".claude/factory/settings.json"];
  writeFileSync(join(d, PIN), JSON.stringify(p, null, 2) + "\n");
  unlinkSync(join(d, ".claude/factory/settings.json"));
  commit(d);
  return [d, env];
}

test("an update on the same release repairs an engine file the release ships that the project lacks", async () => {
  const [d, env] = await missingSettings();
  let [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc, out).toBe(0);
  expect(out).toContain(".claude/factory/settings.json");
  expect(out).toContain("repaired");
  expect(existsSync(join(d, ".claude/factory/settings.json")), out).toBe(true);
  expect(Object.keys(pin(d).files)).toContain(".claude/factory/settings.json");
  commit(d);
  [rc, out] = await fac(d, env, "update"); // safe to run twice
  expect(rc === 0 && out.includes("already on v1.0.0"), out).toBe(true);
  expect(git(d, "status", "--porcelain"), "the second run changes nothing").toBe("");
});

test("the same release with no network and nothing cached is still already installed", async () => {
  const [d, env] = await missingSettings();
  rmSync(env.FACTORY_CACHE_DIR as string, { recursive: true, force: true });
  const [rc, out] = await fac(d, { ...env, FACTORY_RELEASE_API: "http://127.0.0.1:9" }, "update", "v1.0.0");
  expect(rc === 0 && out.includes("already on v1.0.0"), out).toBe(true);
  expect(out, "it says what it could not check").toContain("could not check");
});
