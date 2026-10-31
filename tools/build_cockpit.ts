#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Bundle the cockpit's Ink UI into one JavaScript file (decision 0002, #365).
//
//     bun tools/build_cockpit.ts [--out <file>]     default: dist/factory_cockpit_ink.js
//
// `bun build` puts software-factory/cockpit/ui.tsx, Ink and React into one file that runs under Bun alone, so a project
// gets no node_modules and installs nothing. tools/build_release.ts calls bundleCockpit() and ships the file as
// hooks/factory_cockpit_ink.js. Needs Ink and React installed in software-factory/ (`bun install --frozen-lockfile`).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FactoryError, pyDumps } from "../software-factory/hooks/factory_lib.ts";

/** Where the bundle goes in the release archive, relative to software-factory/. */
export const BUNDLE = "hooks/factory_cockpit_ink.js";
/** The UI's entry point, relative to software-factory/. */
export const ENTRY = "cockpit/ui.tsx";

/** The bundled UI of the software-factory/ folder `dir`. Throws a FactoryError when `bun build` fails. */
export function bundleCockpit(dir: string): Uint8Array {
  const out = mkdtempSync(join(tmpdir(), "cockpit-build-"));
  try {
    const file = join(out, "factory_cockpit_ink.js");
    // NODE_ENV production: React's production build. react-devtools-core is only loaded by Ink when DEV=true, and is
    // not installed, so it stays outside the bundle.
    const p = Bun.spawnSync([process.execPath, "build", ENTRY, "--target=bun", "--outfile", file,
      "--define", 'process.env.NODE_ENV="production"', "--external", "react-devtools-core"],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    if (p.exitCode !== 0) {
      const why = (p.stderr.toString() + p.stdout.toString()).trim().split("\n").filter(Boolean).slice(0, 3).join(" / ");
      throw new FactoryError("cockpit_build_failed", `bun build of ${ENTRY} failed: ${why.slice(0, 400)}`,
        `run \`bun install --frozen-lockfile\` in ${dir} (Ink and React are build-time dependencies), then build again.`);
    }
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  let out = join("dist", "factory_cockpit_ink.js");
  if (argv[0] === "--out" && argv.length === 2) out = argv[1] as string;
  else if (argv.length) {
    process.stderr.write("usage: build_cockpit.ts [--out <file>]\n");
    return 2;
  }
  let data: Uint8Array;
  try {
    data = bundleCockpit(resolve(import.meta.dir, "..", "software-factory"));
  } catch (e) {
    if (e instanceof FactoryError) {
      process.stderr.write(pyDumps(e.toJSON()) + "\n");
      return 1;
    }
    throw e;
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, data);
  console.log(`built ${out} (${data.length} bytes)`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
