// The factory's code lives in software-factory/ (#112). Its old kit paths were symlinks to it (forwarders) until every
// project had moved off them; they are gone (#176). kit/ holds only what a project is given, as real files, and a link
// a project still has through kit/ is relinked by `install.sh --link` (install_layout.test.ts).
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KIT } from "./support.ts";

test("kit holds no factory code and no symlink: the forwarders are gone", () => {
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      expect(e.isSymbolicLink(), p).toBe(false);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(KIT);
  for (const rel of [".claude/hooks", ".claude/ci", "factory", "factory-loop.sh"]) {
    expect(existsSync(join(KIT, rel)), rel).toBe(false);
  }
});
