// The plugin mechanism (#405, decision 0004 point 5): the loader in hooks/factory_plugins.ts (bundle, source, version
// check, fallback), and `factory doctor` saying whether each plugin that is needed loads.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUN, CI, copyHookFolders, envWith, gitRepo, HOOKS, SF, sh, tmp, write, type Proc } from "./support.ts";

const PLUGINS_TS = join(HOOKS, "factory_plugins.ts");
const T = 120_000;

type Mod = typeof import("../hooks/factory_plugins.ts");
type Err = { code: string; message: string; fix: string };
const mod = (): Promise<Mod> => import(PLUGINS_TS) as Promise<Mod>;

const header = (name: string, version: string): string => `// factory-plugin {"name":"${name}","factory":"${version}"}\n`;

/** A project-shaped folder: <root>/.claude/hooks (the hooks folder), and a pin of `version` when given. */
function project(version: string | null): { root: string; hooks: string } {
  const root = tmp();
  const hooks = join(root, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  if (version !== null) write(join(root, ".claude", "factory", "release.json"), JSON.stringify({ version }));
  return { root, hooks };
}

/** A my-skills-shaped folder: <root>/software-factory/{hooks,VERSION,plugins}. */
function checkout(version = "1.2.3"): { sf: string; hooks: string } {
  const sf = join(tmp(), "software-factory");
  mkdirSync(join(sf, "hooks"), { recursive: true });
  writeFileSync(join(sf, "VERSION"), version + "\n");
  return { sf, hooks: join(sf, "hooks") };
}

function thrown(fn: () => unknown): Err {
  try {
    fn();
  } catch (e) {
    const x = e as { code?: string; message: string; fix?: string };
    expect(typeof x.code, String(e)).toBe("string");
    return { code: x.code as string, message: x.message, fix: x.fix ?? "" };
  }
  throw new Error("expected an error, got none");
}

test("a bundle with the right header, beside a pin of the same version, loads and works", async () => {
  const { loadPlugin } = await mod();
  const p = project("1.2.3");
  write(join(p.hooks, "plugins", "tiny.js"), header("tiny", "1.2.3") + 'export const hello = () => "hi";\n');
  const m = loadPlugin("tiny", { hooks: p.hooks }) as { hello: () => string };
  expect(m.hello()).toBe("hi");
});

test("pluginHeader is the exact first line of a bundle", async () => {
  const { pluginHeader } = await mod();
  expect(pluginHeader("nats", "1.2.3")).toBe('// factory-plugin {"name":"nats","factory":"1.2.3"}\n');
});

test("a bundle checks its version against VERSION when there is no pin (a my-skills checkout)", async () => {
  const { loadPlugin } = await mod();
  const c = checkout("2.0.0");
  write(join(c.hooks, "plugins", "tiny.js"), header("tiny", "2.0.0") + "export const n = 1;\n");
  expect((loadPlugin("tiny", { hooks: c.hooks }) as { n: number }).n).toBe(1);
  write(join(c.hooks, "plugins", "old.js"), header("old", "1.9.0") + "export const n = 1;\n");
  expect(thrown(() => loadPlugin("old", { hooks: c.hooks })).code).toBe("plugin-version");
});

test("a source plugin loads, with a package from its own node_modules, and needs no version check", async () => {
  const { loadPlugin } = await mod();
  const c = checkout();
  const plug = join(c.sf, "plugins", "tiny");
  write(join(plug, "index.ts"), 'import { dep } from "tiny-dep-405";\nexport const hello = (): string => `hi ${dep()}`;\n');
  write(join(plug, "node_modules", "tiny-dep-405", "package.json"), JSON.stringify({ name: "tiny-dep-405", version: "1.0.0", main: "index.js" }));
  write(join(plug, "node_modules", "tiny-dep-405", "index.js"), 'exports.dep = () => "from dep";\n');
  const m = loadPlugin("tiny", { hooks: c.hooks }) as { hello: () => string };
  expect(m.hello()).toBe("hi from dep");
});

test("a plugin that is not there is plugin-missing, with the fix", async () => {
  const { loadPlugin } = await mod();
  const e = thrown(() => loadPlugin("nope", { hooks: project("1.2.3").hooks }));
  expect(e.code).toBe("plugin-missing");
  expect(e.message).toContain("nope");
  expect(e.fix).toContain("factory update");
});

test("a bundle from another factory version is plugin-version, naming both versions", async () => {
  const { loadPlugin } = await mod();
  const p = project("2.0.0");
  write(join(p.hooks, "plugins", "tiny.js"), header("tiny", "1.2.3") + "export const n = 1;\n");
  const e = thrown(() => loadPlugin("tiny", { hooks: p.hooks }));
  expect(e.code).toBe("plugin-version");
  expect(e.message).toContain("1.2.3");
  expect(e.message).toContain("2.0.0");
  expect(e.fix).toContain("factory update");
});

test("a bundle is refused as plugin-version when there is neither a pin nor a VERSION", async () => {
  const { loadPlugin } = await mod();
  const p = project(null);
  write(join(p.hooks, "plugins", "tiny.js"), header("tiny", "1.2.3") + "export const n = 1;\n");
  expect(thrown(() => loadPlugin("tiny", { hooks: p.hooks })).code).toBe("plugin-version");
});

test("a bundle with no header, or the header of another plugin, is plugin-load", async () => {
  const { loadPlugin } = await mod();
  const p = project("1.2.3");
  write(join(p.hooks, "plugins", "plain.js"), "export const n = 1;\n");
  write(join(p.hooks, "plugins", "other.js"), header("someone-else", "1.2.3") + "export const n = 1;\n");
  for (const name of ["plain", "other"]) {
    const e = thrown(() => loadPlugin(name, { hooks: p.hooks }));
    expect(e.code).toBe("plugin-load");
    expect(e.fix).toContain("factory update");
  }
});

test("a bundle that throws when it loads is plugin-load", async () => {
  const { loadPlugin } = await mod();
  const p = project("1.2.3");
  write(join(p.hooks, "plugins", "boom.js"), header("boom", "1.2.3") + 'throw new Error("broken bundle");\n');
  const e = thrown(() => loadPlugin("boom", { hooks: p.hooks }));
  expect(e.code).toBe("plugin-load");
  expect(e.fix).toContain("factory update");
});

test("the bundle wins over the source when both exist", async () => {
  const { loadPlugin } = await mod();
  const c = checkout("1.2.3");
  write(join(c.hooks, "plugins", "tiny.js"), header("tiny", "1.2.3") + 'export const which = "bundle";\n');
  write(join(c.sf, "plugins", "tiny", "index.ts"), 'export const which = "source";\n');
  expect((loadPlugin("tiny", { hooks: c.hooks }) as { which: string }).which).toBe("bundle");
});

test("pluginPort returns what pick takes from the plugin, and a plugin that lacks it is plugin-load", async () => {
  const { pluginPort } = await mod();
  const p = project("1.2.3");
  write(join(p.hooks, "plugins", "tiny.js"), header("tiny", "1.2.3") + 'export const make = () => "port";\n');
  expect(pluginPort("tiny", (m) => (typeof m.make === "function" ? (m.make as () => string)() : null), { hooks: p.hooks })).toBe("port");
  const e = thrown(() => pluginPort("tiny", (m) => (m.nothing as string | undefined) ?? null, { hooks: p.hooks }));
  expect(e.code).toBe("plugin-load");
  expect(e.message).toContain("does not provide");
});

test("without a fallback pluginPort throws the error; with one it goes on with it", async () => {
  const { pluginPort } = await mod();
  const hooks = project("1.2.3").hooks;
  expect(thrown(() => pluginPort("nope", () => "x", { hooks })).code).toBe("plugin-missing");
  expect(pluginPort("nope", () => "x", { hooks, fallback: { label: "GitHub", make: () => "fb" } })).toBe("fb");
});

test("the fallback is announced once per process, as {code, message, fix} on stderr, and works each time", () => {
  const p = project("1.2.3");
  write(join(p.hooks, "plugins", "wrong.js"), header("wrong", "9.9.9") + "export const n = 1;\n");
  write(join(p.hooks, "plugins", "boom.js"), header("boom", "1.2.3") + 'throw new Error("x");\n');
  const script = write(join(tmp(), "run.ts"), `import { pluginPort } from ${JSON.stringify(PLUGINS_TS)};
const hooks = ${JSON.stringify(p.hooks)};
for (const name of ["nope", "wrong", "boom"]) {
  for (let i = 0; i < 2; i++) {
    console.log(name + " " + pluginPort(name, () => "x", { hooks, fallback: { label: "GitHub", make: () => "fallback" } }));
  }
}
`);
  const r = sh([...BUN, script]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.trim().split("\n")).toEqual(["nope fallback", "nope fallback", "wrong fallback", "wrong fallback", "boom fallback", "boom fallback"]);
  const lines = r.stderr.trim().split("\n").filter((l) => l.includes("{"));
  const errs = lines.map((l) => JSON.parse(l.slice(l.indexOf("{"))) as Err);
  expect(errs.map((e) => e.code)).toEqual(["plugin-missing", "plugin-version", "plugin-load"]);
  for (const e of errs) {
    expect(e.message.toLowerCase()).toContain("going on with github");
    expect(e.fix).toContain("factory update");
  }
});

test("neededPlugins is nats for messaging.transport nats, and nothing for anything else", async () => {
  const { neededPlugins } = await mod();
  expect(neededPlugins({ messaging: { transport: "nats" } })).toEqual(["nats"]);
  for (const c of [{}, null, "x", 3, { messaging: {} }, { messaging: { transport: "github" } }, { messaging: "nats" }, { messaging: { transport: 5 } }]) {
    expect(neededPlugins(c)).toEqual([]);
  }
});

// ---- factory doctor ----

const FAKE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log(a.includes("nameWithOwner") ? "o/r" : "main"); process.exit(0); }
if (a[0] === "api") { console.log("[]"); process.exit(0); }
console.log("ok");
`;

interface Proj { d: string; env: Record<string, string | undefined>; hooks: string }

/** A project with a copy of every hook, a pin of 9.9.9, and `.claude/factory.json` holding `config`. */
function doctorProject(config: unknown): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  const hooks = join(d, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(hooks, f));
  copyHookFolders(hooks);
  mkdirSync(join(d, ".claude", "ci"), { recursive: true });
  for (const f of readdirSync(CI)) copyFileSync(join(CI, f), join(d, ".claude", "ci", f));
  write(join(d, ".claude", "factory.json"), JSON.stringify(config));
  write(join(d, ".claude", "factory", "release.json"), JSON.stringify({ version: "9.9.9" }));
  write(join(root, "bin", "gh"), FAKE_GH, 0o755);
  mkdirSync(join(root, "home"));
  const env = envWith(join(root, "bin"), { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), FACTORY_CONFIG_DIR: undefined, FACTORY_AGENT: undefined, FACTORY_LOOP: undefined,
    CLAUDE_PROJECT_DIR: undefined, TMUX: undefined });
  return { d, env, hooks };
}

const doctor = (p: Proj): Proc => sh(["bash", join(SF, "factory"), "doctor"], { cwd: p.d, env: p.env, timeoutMs: T });

test("factory doctor says an installed plugin bundle loads", () => {
  const p = doctorProject({ tasks: { source: "issues" } });
  write(join(p.hooks, "plugins", "tiny.js"), header("tiny", "9.9.9") + "export const n = 1;\n");
  const r = doctor(p);
  expect(r.stdout, r.out).toMatch(/^ok\s+plugin tiny: .*loads/m);
}, T);

test("factory doctor fails a plugin bundle from another version, with factory update", () => {
  const p = doctorProject({ tasks: { source: "issues" } });
  write(join(p.hooks, "plugins", "tiny.js"), header("tiny", "1.0.0") + "export const n = 1;\n");
  const r = doctor(p);
  expect(r.stdout, r.out).toMatch(/^fix\s+plugin tiny: .*factory update/m);
  expect(r.code).toBe(1);
}, T);

test("factory doctor fails when messaging.transport is nats and the nats plugin is nowhere", () => {
  const p = doctorProject({ tasks: { source: "issues" }, messaging: { transport: "nats" } });
  const r = doctor(p);
  expect(r.stdout, r.out).toMatch(/^fix\s+plugin nats: .*/m);
  expect(r.code).toBe(1);
}, T);
