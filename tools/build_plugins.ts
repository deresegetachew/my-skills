#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Bundle one plugin into one JavaScript file (decision 0004 point 5, #405).
//
//     bun tools/build_plugins.ts --dir <plugin folder> --name <name> --version <factory version> --out <file>
//
// Bun.build puts software-factory/plugins/<name>/index.ts and the packages it imports (from that folder's own
// node_modules, pinned by its lockfile) into one file that runs under Bun alone, offline, so a project installs nothing.
// The file starts with pluginHeader(name, version): the core refuses a bundle built for another factory version.
// tools/build_release.ts calls bundlePlugin() for each plugin and ships the file as hooks/plugins/<name>.js.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FactoryError } from "../software-factory/hooks/factory_lib.ts";
import { PLUGIN_NAME, pluginHeader } from "../software-factory/hooks/factory_plugins.ts";

/** Where plugins live, relative to software-factory/, and where their bundles go in the release archive. */
export const PLUGINS = "plugins";
export const BUNDLES = "hooks/plugins";

/** The plugins in a list of software-factory/-relative paths: each folder under plugins/ with an index.ts. Throws
 * {code: plugin_name} for a folder whose name isn't lowercase letters, digits and dashes. */
export function pluginNames(paths: string[]): string[] {
  const names: string[] = [];
  for (const p of paths) {
    const m = /^plugins\/([^/]+)\/index\.ts$/.exec(p);
    if (!m) continue;
    const name = m[1] as string;
    if (!PLUGIN_NAME.test(name)) {
      throw new FactoryError("plugin_name", `software-factory/${PLUGINS}/${name} is not a plugin name.`,
        "name the folder with lowercase letters, digits and dashes, starting with a letter (it is the plugin's name).");
    }
    names.push(name);
  }
  return names.sort();
}

function failed(dir: string, why: string): FactoryError {
  return new FactoryError("plugin_build_failed", `bun build of ${dir}/index.ts failed: ${why.slice(0, 400)}`,
    `run \`bun install --frozen-lockfile\` in ${dir} (a plugin's packages are its own), then build again.`);
}

async function buildTo(dir: string, name: string, version: string, out: string): Promise<void> {
  let r: Awaited<ReturnType<typeof Bun.build>>;
  try {
    r = await Bun.build({ entrypoints: [join(dir, "index.ts")], target: "bun", root: dir,
      define: { "process.env.NODE_ENV": '"production"' } });
  } catch (e) {
    const logs = e instanceof AggregateError ? e.errors.map(String) : [e instanceof Error ? e.message : String(e)];
    throw failed(dir, logs.join(" / "));
  }
  const output = r.outputs[0];
  if (!r.success || !output || r.outputs.length !== 1) throw failed(dir, r.logs.map(String).join(" / ") || "no single output file");
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, pluginHeader(name, version) + await output.text());
}

/** The bundle of plugin `name` in the software-factory/ folder `sf`, for factory `version` (synchronous: the build runs
 * in a child Bun). Throws a FactoryError when the build fails. */
export function bundlePlugin(sf: string, name: string, version: string): Uint8Array {
  const tmp = mkdtempSync(join(tmpdir(), "plugin-build-"));
  const dir = join(sf, PLUGINS, name);
  try {
    const file = join(tmp, `${name}.js`);
    // --no-install: the packages are the plugin's installed, pinned ones, never fetched while building
    const p = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "--no-install", import.meta.path,
      "--dir", dir, "--name", name, "--version", version, "--out", file], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
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

const USAGE = "usage: build_plugins.ts --dir <plugin folder> --name <name> --version <factory version> --out <file>";

async function main(argv: string[]): Promise<number> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i] ?? "", argv[i + 1]];
    if (!["--dir", "--name", "--version", "--out"].includes(flag) || !value) {
      process.stderr.write(USAGE + "\n");
      return 2;
    }
    opts[flag.slice(2)] = value;
  }
  const { dir, name, version, out } = opts;
  if (!dir || !name || !version || !out) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  try {
    await buildTo(resolve(dir), name, version, out);
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
