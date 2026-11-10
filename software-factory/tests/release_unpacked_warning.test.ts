// #541: `update <version>` run from an unpacked release downloads the published release, which may not be the archive
// the person checked and unpacked. The client says so, and gives the command that installs the unpacked archive.
//
// The expected warning is a line starting with two spaces and "warning:" that contains "not the release you unpacked",
// the folder name "software-factory-<version>", the first 7 characters of the unpacked MANIFEST's source_commit and of
// the installed one's, and the text "update --archive <archive> --sums <folder>/SHA256SUMS" (both files with their path:
// the command runs in the project, and they sit beside the unpacked folder, outside it).
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { tarEntries } from "../hooks/factory_tar.ts";
import { buildRelease, commit, type Env, spawn, world } from "./release_support.ts";
import { HOOKS, tmp } from "./support.ts";

const read = (p: string): string => readFileSync(p, "utf8");
const PHRASE = "not the release you unpacked";

/** The source_commit in the MANIFEST.json of an archive's bytes. */
function archiveCommit(bytes: Uint8Array): string {
  const m = tarEntries(new Uint8Array(gunzipSync(bytes))).find((e) => e.name.endsWith("/MANIFEST.json"));
  expect(m, "the archive has a MANIFEST.json").toBeTruthy();
  const data = (m as { data: Uint8Array }).data;
  return (JSON.parse(new TextDecoder().decode(data)) as { source_commit: string }).source_commit;
}

/** Unpack a built archive as a person would, then put the real client in its hooks/ (the fake release ships no client). */
function unpack(dist: string, version: string): string {
  const root = tmp();
  const archive = join(dist, `software-factory-${version}.tar.gz`);
  for (const e of tarEntries(new Uint8Array(gunzipSync(readFileSync(archive))))) {
    if (e.kind !== "file") continue;
    const p = join(root, e.name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, e.data, { mode: e.mode });
  }
  const folder = join(root, `software-factory-${version}`);
  cpSync(HOOKS, join(folder, "hooks"), { recursive: true });
  return folder;
}

const client = (script: string, d: string, env: Env, ...args: string[]): Promise<[number, string]> =>
  spawn([process.execPath, "--no-env-file", "--config=/dev/null", script, ...args], d, env);

test("update <version> from an unpacked release that differs from the download warns and still installs", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0", { files: { "hooks/factory_x.ts": 'export const VERSION = "1.0.0"; // published\n' } });
  const folder = unpack(buildRelease("1.0.0"), "1.0.0");
  const [rc, out] = await client(join(folder, "hooks", "factory_release.ts"), d, env, "update", "1.0.0");
  expect(rc, out).toBe(0);
  expect(read(join(d, ".claude/hooks/factory_x.ts")), "it still installs the download").toContain("// published");
  expect(out.split("\n").some((l) => l.startsWith("  warning:") && l.includes(PHRASE)), out).toBe(true);
  expect(out, "names the unpacked release").toContain("software-factory-1.0.0");
  const mine = (JSON.parse(read(join(folder, "MANIFEST.json"))) as { source_commit: string }).source_commit;
  const served = archiveCommit((gh.assets["v1.0.0"] as Record<string, Uint8Array>)["software-factory-1.0.0.tar.gz"] as Uint8Array);
  expect(mine).not.toBe(served);
  expect(out, "the unpacked commit").toContain(mine.slice(0, 7));
  expect(out, "what was installed instead").toContain(served.slice(0, 7));
  // the fix names both files by their path beside the unpacked folder: the command runs in the project, outside it
  const beside = dirname(folder);
  expect(out, "the fix").toContain(`update --archive ${join(beside, "software-factory-1.0.0.tar.gz")} --sums ${join(beside, "SHA256SUMS")}`);
});

test("no warning when the downloaded release has the same manifest as the unpacked one", async () => {
  const [gh, d, env] = await world();
  const dist = buildRelease("1.0.0");
  const folder = unpack(dist, "1.0.0");
  const assets: Record<string, Uint8Array> = {};
  for (const n of ["software-factory-1.0.0.tar.gz", "SHA256SUMS"]) assets[n] = new Uint8Array(readFileSync(join(dist, n)));
  gh.add("1.0.0", { assets });
  const [rc, out] = await client(join(folder, "hooks", "factory_release.ts"), d, env, "update", "1.0.0");
  expect(rc, out).toBe(0);
  expect(out).not.toContain(PHRASE);
  expect(out).not.toContain("warning:");
});

test("no warning when the client runs from an installed project", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0");
  mkdirSync(join(d, ".claude"), { recursive: true });
  cpSync(HOOKS, join(d, ".claude", "hooks"), { recursive: true });
  commit(d);
  const [rc, out] = await client(join(d, ".claude", "hooks", "factory_release.ts"), d, env, "update", "1.0.0");
  expect(rc, out).toBe(0);
  expect(out).not.toContain(PHRASE);
});
