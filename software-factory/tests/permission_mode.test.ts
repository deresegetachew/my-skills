// How an unattended run gets its permissions (#179): the `permissionMode` setting.
// (The loop, dry-run, product owner, dev manager and `factory doctor` cases stay in test_permission_mode.py until
// factory_roles and factory_doctor are ported.)
import { expect, test } from "bun:test";
import { join } from "node:path";
import { runHook, sh, tmp, write } from "./support.ts";

test("a bad mode is refused with the options", () => {
  const d = tmp();
  sh(["git", "init", "-q", "-b", "main", d]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu"], permissionMode: "bypassPermissions" }));
  const p = runHook("factory_settings", ["validate"], { cwd: d });
  expect(p.code).not.toBe(0);
  expect(p.out).toContain("acceptEdits");
});
