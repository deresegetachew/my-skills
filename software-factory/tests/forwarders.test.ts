// The factory's code lives in software-factory/ (#112). The old kit paths that projects link are symlinks to it
// (forwarders), so a project that links the old paths keeps working until it switches. A Bun script (#252) gets no
// forwarder: projects link hooks/ and ci/ directly (`install.sh --layout new`).
// (The `install.sh --link` case is in install_layout.test.ts.)
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { KIT, SF } from "./support.ts";

const MOVED: [string, string][] = [[".claude/hooks", "hooks"], [".claude/ci", "ci"]];

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

test("every moved file has a forwarder at its old kit path, and a bun script has none", () => {
  for (const [old, now] of MOVED) {
    for (const name of readdirSync(join(SF, now))) {
      if (name === "__pycache__") continue;
      const link = join(KIT, old, name);
      if (name.endsWith(".ts")) {
        expect(existsSync(link) || isLink(link), link).toBe(false);
        continue;
      }
      expect(isLink(link), link).toBe(true);
      expect(realpathSync(link), link).toBe(realpathSync(join(SF, now, name)));
    }
  }
  for (const name of ["factory", "factory-loop.sh"]) {
    const link = join(KIT, name);
    expect(isLink(link), link).toBe(true);
    expect(realpathSync(link)).toBe(join(SF, name));
  }
});

test("no forwarder is broken and none is left without a target file", () => {
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else expect(existsSync(p), p).toBe(true); // a dangling symlink
    }
  };
  walk(KIT);
});
