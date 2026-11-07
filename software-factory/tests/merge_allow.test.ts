// mergeAllow (#540): the project's allow rules go into an installed release's agents' settings as `factory update` puts
// them there, the pin's hash follows, and when the pin can't be written the settings file is put back as it was.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FactoryError } from "../hooks/factory_lib.ts";
import { mergeAllow, sha256Bytes } from "../hooks/factory_release.ts";
import { tmp, write } from "./support.ts";

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) {
    try {
      chmodSync(join(d, ".claude", "factory", "release.json"), 0o644);
    } catch {
      // already gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const SETTINGS = JSON.stringify({ hooks: {}, permissions: { allow: ["Bash(git commit*)"] } }, null, 2) + "\n";

/** An installed release: its settings.json, a pin naming that file's hash, and factory.json asking for `allow`. */
function installed(allow: string[]): string {
  const d = tmp("merge-allow-");
  roots.push(d);
  write(join(d, ".claude", "factory", "settings.json"), SETTINGS);
  write(join(d, ".claude", "factory", "release.json"), JSON.stringify({ schema: "factory-pin/1", repo: "o/r", tag: "v1.0.0",
    version: "1.0.0", sha256: "x".repeat(64), files: { ".claude/factory/settings.json": sha256Bytes(SETTINGS) } }));
  write(join(d, ".claude", "factory.json"), JSON.stringify({ permissions: { allow } }));
  return d;
}

test("the allow rules are added after the release's own, and the pin's hash names the new file", () => {
  const d = installed(["Bash(bun test*)", "Bash(git commit*)"]);
  expect(mergeAllow(d)).toEqual(["Bash(bun test*)"]);
  const now = readFileSync(join(d, ".claude", "factory", "settings.json"));
  expect((JSON.parse(now.toString()) as { permissions: { allow: string[] } }).permissions.allow).toEqual(["Bash(git commit*)", "Bash(bun test*)"]);
  const pin = JSON.parse(readFileSync(join(d, ".claude", "factory", "release.json"), "utf8")) as { files: Record<string, string> };
  expect(pin.files[".claude/factory/settings.json"]).toBe(sha256Bytes(new Uint8Array(now)));
  expect(mergeAllow(d), "a second run adds nothing").toEqual([]);
});

test("a pin that can't be written: settings.json is put back as it was, and the error says what to do", () => {
  if (process.getuid?.() === 0) return; // root writes a read-only file anyway
  const d = installed(["Bash(bun test*)"]);
  const pinPath = join(d, ".claude", "factory", "release.json");
  const pinBefore = readFileSync(pinPath, "utf8");
  chmodSync(pinPath, 0o444);
  let err: unknown = null;
  try {
    mergeAllow(d);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(FactoryError);
  expect((err as FactoryError).code).toBe("pin_write_failed");
  expect((err as FactoryError).fix).toContain("factory update");
  expect(readFileSync(join(d, ".claude", "factory", "settings.json"), "utf8")).toBe(SETTINGS);
  expect(readFileSync(pinPath, "utf8")).toBe(pinBefore);
});
