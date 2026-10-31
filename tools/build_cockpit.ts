#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Bundle the cockpit's Ink UI into one JavaScript file (decision 0002, #365).
//
//     bun tools/build_cockpit.ts [--out <file>] [--dir <software-factory folder>]
//
// Bun.build puts software-factory/cockpit/ui.tsx, Ink and React into one file that runs under Bun alone, offline, so a
// project gets no node_modules and installs nothing. tools/build_release.ts calls bundleCockpit() and ships the file as
// hooks/factory_cockpit_ink.js. Ink and React come from <dir>/node_modules, else from the node_modules beside this
// builder (a release built with --root from another checkout); install them with `bun install --frozen-lockfile`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { FactoryError, pyDumps } from "../software-factory/hooks/factory_lib.ts";

/** Where the bundle goes in the release archive, relative to software-factory/. */
export const BUNDLE = "hooks/factory_cockpit_ink.js";
/** The UI's entry point, relative to software-factory/. */
export const ENTRY = "cockpit/ui.tsx";
const OWN = resolve(import.meta.dir, "..", "software-factory");

function failed(dir: string, why: string): FactoryError {
  return new FactoryError("cockpit_build_failed", `bun build of ${ENTRY} failed: ${why.slice(0, 400)}`,
    `run \`bun install --frozen-lockfile\` in ${dir} (Ink and React are build-time dependencies), then build again.`);
}

/** Ink imports react-devtools-core only when DEV=true and the package is installed: the bundle holds an empty one, so
 * it never reaches for a package at run time. */
const noDevtools: BunPlugin = {
  name: "no-devtools",
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "cockpit-stub" }));
    b.onLoad({ filter: /.*/, namespace: "cockpit-stub" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};

/** For a checkout with no node_modules: its packages come from `own` (the folder holding the builder's node_modules). */
function fromOwn(own: string): BunPlugin {
  return {
    name: "builder-modules",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (/^(node|bun):/.test(args.path)) return undefined;
        try {
          return { path: Bun.resolveSync(args.path, own) };
        } catch {
          return undefined; // the bundler says it can't be resolved
        }
      });
    },
  };
}

/** Writes the bundle of the software-factory/ folder `dir` to `out`. */
async function buildTo(dir: string, out: string): Promise<void> {
  const plugins = [noDevtools];
  if (!existsSync(join(dir, "node_modules")) && existsSync(join(OWN, "node_modules"))) plugins.push(fromOwn(OWN));
  let r: Awaited<ReturnType<typeof Bun.build>>;
  try {
    r = await Bun.build({ entrypoints: [join(dir, ENTRY)], target: "bun", plugins, root: dir,
      define: { "process.env.NODE_ENV": '"production"' } });
  } catch (e) {
    const logs = e instanceof AggregateError ? e.errors.map(String) : [e instanceof Error ? e.message : String(e)];
    throw failed(dir, logs.join(" / "));
  }
  const output = r.outputs[0];
  if (!r.success || !output || r.outputs.length !== 1) throw failed(dir, r.logs.map(String).join(" / ") || "no single output file");
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, new Uint8Array(await output.arrayBuffer()));
}

/** The bundled UI of the software-factory/ folder `dir` (synchronous: the build runs in a child Bun). Throws a
 * FactoryError when the build fails. */
export function bundleCockpit(dir: string): Uint8Array {
  const tmp = mkdtempSync(join(tmpdir(), "cockpit-build-"));
  try {
    const file = join(tmp, "factory_cockpit_ink.js");
    // --no-install: the packages are the installed, pinned ones (bun.lock), never fetched while building
    const p = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "--no-install", import.meta.path, "--dir", dir, "--out", file],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    if (p.exitCode !== 0) {
      const last = p.stderr.toString().trim().split("\n").at(-1) ?? "";
      try {
        const e = JSON.parse(last) as { code: string; message: string; fix: string };
        throw new FactoryError(e.code, e.message, e.fix);
      } catch (e) {
        if (e instanceof FactoryError) throw e;
        throw failed(dir, last || `exit ${p.exitCode}`);
      }
    }
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  let out = join("dist", "factory_cockpit_ink.js");
  let dir = OWN;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--out" && value) out = value;
    else if (flag === "--dir" && value) dir = resolve(value);
    else {
      process.stderr.write("usage: build_cockpit.ts [--out <file>] [--dir <software-factory folder>]\n");
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
