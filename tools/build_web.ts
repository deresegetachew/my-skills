#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Bundle the web app (`factory ui`, decision 0005, #421) into one JavaScript file for the browser.
//
//     bun tools/build_web.ts [--out <file>] [--dir <software-factory folder>]
//
// Bun.build puts software-factory/web/app.tsx, React and react-dom into one minified ES module, so a project gets no
// node_modules and installs nothing. tools/build_release.ts calls bundleWeb() and ships the file as
// hooks/factory_ui_app.js, which `factory ui` serves. React and react-dom come from <dir>/node_modules, else from the
// node_modules beside this builder (a release built with --root from another checkout); install them with
// `bun install --frozen-lockfile`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { FactoryError } from "../software-factory/hooks/factory_lib.ts";
import { buildApp, WEB_BUNDLE, WEB_ENTRY } from "../software-factory/hooks/factory_ui_build.ts";

export { WEB_BUNDLE, WEB_ENTRY };
const OWN = resolve(import.meta.dir, "..", "software-factory");

/** For a checkout with no node_modules: its packages come from `own` (the folder holding the builder's node_modules). */
function fromOwn(own: string): BunPlugin {
  return {
    name: "builder-modules",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        try {
          return { path: Bun.resolveSync(args.path, own) };
        } catch {
          return undefined; // the bundler says it can't be resolved
        }
      });
    },
  };
}

async function buildTo(dir: string, out: string): Promise<void> {
  const plugins = !existsSync(join(dir, "node_modules")) && existsSync(join(OWN, "node_modules")) ? [fromOwn(OWN)] : [];
  const bytes = await buildApp(join(dir, WEB_ENTRY), plugins);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, bytes);
}

/** The web app of the software-factory/ folder `dir`, bundled (synchronous: the build runs in a child Bun). Throws a
 * FactoryError when the build fails. */
export function bundleWeb(dir: string): Uint8Array {
  const tmp = mkdtempSync(join(tmpdir(), "web-build-"));
  try {
    const file = join(tmp, "factory_ui_app.js");
    // --no-install: the packages are the installed, pinned ones (bun.lock), never fetched while building
    const p = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "--no-install", import.meta.path, "--dir", dir, "--out", file],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    if (p.exitCode !== 0) {
      const last = p.stderr.toString().trim().split("\n").at(-1) ?? "";
      let e: { code?: string; message?: string; fix?: string } = {};
      try {
        e = JSON.parse(last) as typeof e;
      } catch {
        // not one of ours
      }
      if (e.code && e.message && e.fix) throw new FactoryError(e.code, e.message, e.fix);
      throw new FactoryError("ui_app_build_failed", `bun build of ${WEB_ENTRY} failed: ${(last || `exit ${p.exitCode}`).slice(0, 400)}`,
        `run \`bun install --frozen-lockfile\` in ${dir} (React and react-dom are build-time dependencies), then build again.`);
    }
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  let out = join("dist", "factory_ui_app.js");
  let dir = OWN;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--out" && value) out = value;
    else if (flag === "--dir" && value) dir = resolve(value);
    else {
      process.stderr.write("usage: build_web.ts [--out <file>] [--dir <software-factory folder>]\n");
      return 2;
    }
  }
  try {
    await buildTo(dir, out);
  } catch (e) {
    if (e instanceof FactoryError) {
      process.stderr.write(JSON.stringify(e.toJSON()) + "\n");
      return 1;
    }
    throw e;
  }
  console.log(`built ${out}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
