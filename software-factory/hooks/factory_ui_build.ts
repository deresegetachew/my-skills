// The web app `factory ui` serves (#421, decision 0005): the release's bundle beside this file (factory_ui_app.js, built
// by tools/build_web.ts), else built now from the source, web/app.tsx, in a my-skills checkout. React and react-dom are
// build-time dependencies: the bundle holds them, so a project installs nothing.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";
import { FactoryError } from "./factory_lib.ts";

const HOOKS = import.meta.dir;
/** Where the bundle is in a release, relative to software-factory/ (and so in a project's .claude/). */
export const WEB_BUNDLE = "hooks/factory_ui_app.js";
/** The app's entry point, relative to software-factory/. */
export const WEB_ENTRY = "web/app.tsx";

export type App = { kind: "bundle"; path: string } | { kind: "source"; path: string };

/** The app to serve: the bundle beside this file, else the source above it, else the source beside the `factory` script
 * that started us (FACTORY_SELF: my-skills' own script in a project whose hooks are copies). Null when there is none. */
export function findApp(): App | null {
  const bundle = join(HOOKS, "factory_ui_app.js");
  if (existsSync(bundle)) return { kind: "bundle", path: bundle };
  const source = join(HOOKS, "..", WEB_ENTRY);
  if (existsSync(source)) return { kind: "source", path: source };
  const self = process.env.FACTORY_SELF;
  if (self && existsSync(self)) {
    const beside = join(dirname(realpathSync(self)), WEB_ENTRY);
    if (existsSync(beside)) return { kind: "source", path: beside };
  }
  return null;
}

export function appMissing(): FactoryError {
  return new FactoryError("ui_app_missing", `The web app isn't installed: there is no factory_ui_app.js in ${HOOKS}.`,
    "Run `factory update` to a release that carries it (`factory releases` lists them).");
}

function buildFailed(entry: string, why: string): FactoryError {
  const folder = dirname(dirname(entry));
  return new FactoryError("ui_app_build_failed", `The web app (${entry}) could not be built: ${why.slice(0, 400)}`,
    `Run \`cd ${folder} && bun install --frozen-lockfile\` (React and react-dom are build-time dependencies), then start it again.`);
}

/** The browser bundle of the app at `entry`: one minified ES module holding React and react-dom. */
export async function buildApp(entry: string, plugins: BunPlugin[] = []): Promise<Uint8Array> {
  let r: Awaited<ReturnType<typeof Bun.build>>;
  try {
    r = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true, plugins,
      define: { "process.env.NODE_ENV": '"production"' } });
  } catch (e) {
    const logs = e instanceof AggregateError ? e.errors.map(String) : [e instanceof Error ? e.message : String(e)];
    throw buildFailed(entry, logs.join(" / "));
  }
  const out = r.outputs[0];
  if (!r.success || !out || r.outputs.length !== 1) throw buildFailed(entry, r.logs.map(String).join(" / ") || "no single output file");
  return new Uint8Array(await out.arrayBuffer());
}

/** The app's JavaScript: the bundle's bytes, or the source built now. */
export async function appScript(app: App): Promise<Uint8Array> {
  return app.kind === "bundle" ? new Uint8Array(readFileSync(app.path)) : buildApp(app.path);
}
