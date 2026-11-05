// Plugins (decision 0004 point 5, #405): an adapter that needs npm packages lives in software-factory/plugins/<name>/
// with its own package.json, and the release bundles it into one file, hooks/plugins/<name>.js (tools/build_plugins.ts),
// so a project installs nothing. The core imports only types from a plugin; it loads one here, by name, at run time.
//
// A bundle's first line says which plugin it is and the factory version it was built with (pluginHeader). A bundle from
// another version is refused: the fix is `factory update`. With no bundle, a checkout of my-skills loads the plugin's
// source (plugins/<name>/index.ts beside hooks/), which needs `bun install` in that folder.
//
// The setting that needs a plugin turns it on (`messaging.transport: "nats"` needs `nats`; neededPlugins). A port that
// may fall back (messaging, to GitHub) says so once per process on stderr and goes on; any other stops with the error.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryError, pyDumps } from "./factory_lib.ts";

const HOOKS = import.meta.dir;
const HEADER = "// factory-plugin ";
/** A plugin's name: its folder under plugins/ and its bundle's name. */
export const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;
const UPDATE = "Run `factory update` to a release that carries it (`factory releases` lists them).";

/** The first line of a plugin's bundle: its name and the factory version it was built with. */
export function pluginHeader(name: string, version: string): string {
  return HEADER + JSON.stringify({ name, factory: version }) + "\n";
}

function readHeader(path: string): { name: string; factory: string } | null {
  const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  if (!first.startsWith(HEADER)) return null;
  try {
    const h = JSON.parse(first.slice(HEADER.length)) as { name?: unknown; factory?: unknown };
    return typeof h.name === "string" && typeof h.factory === "string" ? { name: h.name, factory: h.factory } : null;
  } catch {
    return null;
  }
}

/** The version of the factory whose hooks are in `hooks`: the project's release pin, else my-skills' VERSION. */
export function factoryVersion(hooks: string = HOOKS): string | null {
  try {
    const pin = JSON.parse(readFileSync(join(hooks, "..", "..", ".claude", "factory", "release.json"), "utf8")) as { version?: unknown };
    if (typeof pin.version === "string" && pin.version) return pin.version;
  } catch {
    // no pin: not a project that takes releases
  }
  try {
    return readFileSync(join(hooks, "..", "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Where plugin `name` is: the release's bundle, else the source in a my-skills checkout, else null. */
export function pluginPath(name: string, hooks: string = HOOKS): { path: string; bundle: boolean } | null {
  const bundle = join(hooks, "plugins", `${name}.js`);
  if (existsSync(bundle)) return { path: bundle, bundle: true };
  const source = join(hooks, "..", "plugins", name, "index.ts");
  return existsSync(source) ? { path: source, bundle: false } : null;
}

function loadError(name: string, why: string, fix = UPDATE): FactoryError {
  return new FactoryError("plugin-load", `The ${name} plugin doesn't load: ${why.slice(0, 300)}`, fix);
}

/** The exports of plugin `name`. Throws {code: plugin-missing | plugin-version | plugin-load}. */
export function loadPlugin(name: string, opts: { hooks?: string } = {}): Record<string, unknown> {
  const hooks = opts.hooks ?? HOOKS;
  const at = pluginPath(name, hooks);
  if (!at) {
    throw new FactoryError("plugin-missing", `The ${name} plugin isn't installed: there is no plugins/${name}.js in ${hooks}.`, UPDATE);
  }
  if (at.bundle) {
    const h = readHeader(at.path);
    if (!h || h.name !== name) throw loadError(name, `${at.path} has no factory-plugin header for ${name}`);
    const mine = factoryVersion(hooks);
    if (h.factory !== mine) {
      throw new FactoryError("plugin-version", `The ${name} plugin was built for factory ${h.factory}, but this factory is ` +
        `${mine ?? "of no known version (no release pin)"}.`, "Run `factory update`: it installs the factory and its plugins of one version.");
    }
  }
  let mod: unknown;
  try {
    mod = require(at.path);
  } catch (e) {
    const why = e instanceof Error ? e.message.split("\n")[0] ?? "" : String(e);
    throw loadError(name, why, at.bundle ? UPDATE :
      `Run \`bun install --frozen-lockfile\` in ${join(hooks, "..", "plugins", name)}, or \`factory update\` in a project.`);
  }
  if (typeof mod !== "object" || mod === null) throw loadError(name, `${at.path} has no exports`);
  return mod as Record<string, unknown>;
}

const announced = new Set<string>();

/** What `pick` takes from plugin `name` (an adapter, for a port). With `fallback` a plugin that is missing or fails goes on
 * with the fallback, said once per process on stderr as {code, message, fix}; without one the error is thrown. */
export function pluginPort<T>(name: string, pick: (mod: Record<string, unknown>) => T | null,
  opts: { hooks?: string; fallback?: { label: string; make: () => T } | null } = {}): T {
  try {
    const got = pick(loadPlugin(name, opts));
    if (got === null) throw loadError(name, "it does not provide what the factory asks of it");
    return got;
  } catch (e) {
    if (!(e instanceof FactoryError) || !opts.fallback) throw e;
    if (!announced.has(name)) {
      announced.add(name);
      process.stderr.write(pyDumps({ code: e.code, message: `${e.message} Going on with ${opts.fallback.label}.`, fix: e.fix }) + "\n");
    }
    return opts.fallback.make();
  }
}

/** The plugins the settings `config` turn on: `messaging.transport: "nats"` needs `nats`. */
export function neededPlugins(config: unknown): string[] {
  const messaging = typeof config === "object" && config !== null ? (config as { messaging?: unknown }).messaging : undefined;
  const transport = typeof messaging === "object" && messaging !== null ? (messaging as { transport?: unknown }).transport : undefined;
  return transport === "nats" ? ["nats"] : [];
}
