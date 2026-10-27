// install.sh and `factory update` link a project's code straight at the factory's own folders (hooks/, ci/, factory,
// factory-loop.sh) (#112 step 2). The forwarders under kit/ are gone (#176), and with them `--layout old`: a link a
// project made through kit/ before that is relinked to the new folder, and `--layout new` is still accepted.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type Proc, ROOT, SF, sh as run, tmp } from "./support.ts";

const VENDOR = "vendor/my-skills/software-factory";
const GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always",
  GIT_CONFIG_KEY_1: "user.name", GIT_CONFIG_VALUE_1: "t", GIT_CONFIG_KEY_2: "user.email", GIT_CONFIG_VALUE_2: "t@example.com" };
const KIT_LINKED = [".claude/hooks/wait_for_merge.sh", ".claude/ci/ci.sh", ".claude/ci/entrypoint.sh", "factory", "factory-loop.sh"];
const BUN_HOOK = ".claude/hooks/factory_guard.ts";
const ENGINE = [BUN_HOOK, ...KIT_LINKED];
const KIT_ONLY = [".claude/agents/reviewer.md", ".claude/factory/settings.json"];

function sh(cwd: string, ...cmd: string[]): Proc {
  const p = run(cmd, { cwd, env: GIT_ENV });
  expect(p.code, `${cmd.join(" ")}\n${p.out}`).toBe(0);
  return p;
}

const skip = (src: string): boolean => !/(^|\/)(__pycache__|node_modules)(\/|$)/.test(src) && !src.startsWith(join(SF, "tests"));

function copyFactory(dest: string): void {
  cpSync(SF, dest, { recursive: true, verbatimSymlinks: true, filter: skip });
}

/** A git project with a copy of the factory under vendor/my-skills (not a submodule: install.sh only needs it inside). */
function project(): string {
  const d = tmp();
  sh(d, "git", "init", "-q");
  copyFactory(join(d, VENDOR));
  return d;
}

function install(d: string, ...args: string[]): Proc {
  return sh(d, "bash", join(d, VENDOR, "install.sh"), ".", ...args);
}

function links(d: string, rels = [...ENGINE, ...KIT_ONLY]): Record<string, string> {
  return Object.fromEntries(rels.map((r) => [r, readlinkSync(join(d, r))]));
}

const isFile = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
const isLink = (p: string): boolean => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const bunRun = (d: string, rel: string): Proc => sh(d, process.execPath, "--no-env-file", rel);

/** Point the code links the way every project had them before the move: through kit/, where nothing is left (#176). */
function linkThroughKit(d: string): void {
  for (const rel of KIT_LINKED) {
    rmSync(join(d, rel), { force: true });
    symlinkSync(relative(dirname(join(d, rel)), join(d, VENDOR, "kit", rel)), join(d, rel));
  }
}

test("a fresh link install points the code straight at the factorys folders", () => {
  const d = project();
  install(d, "--link");
  const got = links(d);
  for (const rel of ENGINE) {
    expect(got[rel], rel).not.toContain("/kit/");
    expect(isFile(join(d, rel)), rel).toBe(true);
  }
  expect(got.factory).toBe(VENDOR + "/factory");
  expect(got[BUN_HOOK]).toBe("../../" + VENDOR + "/hooks/factory_guard.ts");
  expect(got[".claude/ci/entrypoint.sh"]).toBe("../../" + VENDOR + "/ci/entrypoint.sh");
  for (const rel of KIT_ONLY) { // agents, skills and settings.json still come from kit/.claude, where they live
    expect(got[rel]).toBe(relative(dirname(rel), VENDOR + "/kit/" + rel));
  }
  expect(sh(d, "bash", join(d, "factory"), "help").stdout).toContain("factory <command>");
});

test("a file added to hooks reaches a project without a forwarder", () => {
  const d = project();
  writeFileSync(join(d, VENDOR, "hooks", "factory_zz.ts"), 'console.log("zz");\n');
  const out = install(d, "--link").stdout;
  expect(out).toContain("linked   .claude/hooks/factory_zz.ts");
  expect(bunRun(d, ".claude/hooks/factory_zz.ts").stdout).toBe("zz\n");
});

test("a project linked through kit is relinked to the new folders and a rerun changes nothing", () => {
  const d = project();
  install(d, "--link");
  linkThroughKit(d); // links made before #176: their kit/ targets no longer exist
  for (const rel of KIT_LINKED) expect(isFile(join(d, rel)), rel).toBe(false);
  let out = install(d, "--link").stdout;
  for (const rel of KIT_LINKED) expect(out, rel).toContain(`relinked ${rel} (from kit/ to the new folder)`);
  for (const rel of ENGINE) {
    expect(readlinkSync(join(d, rel)), rel).not.toContain("/kit/");
    expect(isFile(join(d, rel)), rel).toBe(true);
  }
  const after = links(d);
  for (const layout of ["new", "auto"]) { // still accepted (an older `factory update` passes auto), and change nothing
    out = install(d, "--link", "--layout", layout).stdout;
    expect(links(d), layout).toEqual(after);
    expect(out, layout).not.toContain("relinked");
  }
  expect(sh(d, "bash", join(d, "factory"), "help").stdout).toContain("factory <command>");
});

test("a copy that differs is kept and a plain copy becomes a link", () => {
  const d = project();
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  copyFileSync(join(SF, "hooks", "check.ts"), join(d, ".claude", "hooks", "check.ts"));
  writeFileSync(join(d, ".claude", "hooks", "factory_env.ts"), "// my own edit\n");
  const out = install(d, "--link").stdout;
  expect(isLink(join(d, ".claude", "hooks", "check.ts"))).toBe(true);
  expect(out).toContain("linked   .claude/hooks/check.ts (was a copy)");
  expect(isLink(join(d, ".claude", "hooks", "factory_env.ts"))).toBe(false);
  expect(out).toContain("kept     .claude/hooks/factory_env.ts (differs");
});

test("a bad option is refused with a message, and --layout old is refused before anything changes", () => {
  for (const layout of ["old", "sideways"]) {
    const d = project();
    const p = run(["bash", join(d, VENDOR, "install.sh"), ".", "--layout", layout, "--link"], { cwd: d, env: GIT_ENV });
    expect(p.code === 1 && p.stderr.includes('"code": "layout_removed"') && p.stderr.includes('"fix"'), p.out).toBe(true);
    expect(existsSync(join(d, ".claude")), layout + ": nothing was installed").toBe(false);
  }
  const d = project();
  const p = run(["bash", join(d, VENDOR, "install.sh"), ".", "--lnk"], { cwd: d, env: GIT_ENV });
  expect(p.code === 1 && p.stderr.includes("Unknown option"), p.out).toBe(true);
});

test("a copy install holds real files from the new folders with the same modes", () => {
  const d = tmp();
  sh(d, "bash", join(SF, "install.sh"), d);
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      expect(e.isSymbolicLink(), p).toBe(false);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(d);
  for (const rel of [...ENGINE, ...KIT_ONLY]) expect(isFile(join(d, rel)), rel).toBe(true);
  for (const [src, rel] of [["hooks/factory_guard.ts", BUN_HOOK], ["ci/entrypoint.sh", ".claude/ci/entrypoint.sh"], ["factory", "factory"]] as const) {
    expect(readFileSync(join(SF, src)).equals(readFileSync(join(d, rel))), rel).toBe(true);
  }
  for (const rel of ["factory", "factory-loop.sh", ".claude/ci/ci.sh", BUN_HOOK]) expect(statSync(join(d, rel)).mode & 0o100, rel).toBeTruthy();
});

// --- factory update, with the factory as a real submodule of the project ---

function upstream(): string {
  const u = tmp();
  copyFactory(join(u, "software-factory"));
  sh(u, "git", "init", "-q", "-b", "main");
  sh(u, "git", "add", "-A");
  sh(u, "git", "commit", "-q", "-m", "release 1");
  return u;
}

function submoduleProject(up: string, ...installArgs: string[]): string {
  const d = tmp();
  sh(d, "git", "init", "-q", "-b", "main");
  sh(d, "git", "submodule", "add", "-q", up, "vendor/my-skills");
  install(d, "--link", ...installArgs);
  sh(d, "git", "add", "-A");
  sh(d, "git", "commit", "-q", "-m", "set up");
  return d;
}

function addUpstreamHook(up: string, name = "factory_zz.ts", body = 'console.log("zz");\n'): void {
  writeFileSync(join(up, "software-factory", "hooks", name), body);
  sh(up, "git", "add", "-A");
  sh(up, "git", "commit", "-q", "-m", "add " + name);
}

test("factory update links a new file straight to the new folder in a new layout project", () => {
  const up = upstream();
  const d = submoduleProject(up);
  addUpstreamHook(up);
  const out = sh(d, "bash", "factory", "update").stdout;
  expect(out).toContain("add factory_zz");
  expect(readlinkSync(join(d, ".claude/hooks/factory_zz.ts"))).toBe("../../vendor/my-skills/software-factory/hooks/factory_zz.ts");
  expect(bunRun(d, ".claude/hooks/factory_zz.ts").stdout).toBe("zz\n");
  expect(readlinkSync(join(d, "factory"))).not.toContain("/kit/");
});

test("factory update relinks a project linked through kit, and links a new file (#174, #176)", () => {
  // #174: an update must link a hook that exists only in hooks/, or every later ./factory command fails.
  // The project pins a my-skills that still has the forwarders and links through them; the update takes it to one
  // without them (and with a new hook), and its own ./factory, the old one, relinks every link.
  const up = upstream();
  const kit = join(up, "software-factory", "kit");
  for (const rel of KIT_LINKED) {
    const real = join(up, "software-factory", rel.replace(/^\.claude\//, ""));
    mkdirSync(dirname(join(kit, rel)), { recursive: true });
    symlinkSync(relative(dirname(join(kit, rel)), real), join(kit, rel));
  }
  sh(up, "git", "add", "-A");
  sh(up, "git", "commit", "-q", "-m", "the forwarders, as before #176");
  const d = submoduleProject(up);
  linkThroughKit(d);
  for (const rel of KIT_LINKED) expect(isFile(join(d, rel)), rel).toBe(true);
  sh(d, "git", "add", "-A");
  sh(d, "git", "commit", "-q", "-m", "linked through kit");
  for (const rel of KIT_LINKED) rmSync(join(kit, rel));
  addUpstreamHook(up); // commits the removal too
  let out = sh(d, "bash", "factory", "update").stdout;
  for (const rel of KIT_LINKED) expect(out, rel).toContain(`relinked ${rel}`);
  for (const rel of ENGINE) expect(readlinkSync(join(d, rel)), rel).not.toContain("/kit/");
  const link = join(d, ".claude/hooks/factory_zz.ts");
  expect(isLink(link) && isFile(link), out).toBe(true);
  expect(bunRun(d, ".claude/hooks/factory_zz.ts").stdout).toBe("zz\n");
  expect(sh(d, "bash", "factory", "help").code).toBe(0);
  out = sh(d, "bash", "factory", "update").stdout; // a second update starts and changes nothing
  expect(out).toContain("already at");
  expect(out).not.toContain("relinked");
});

test("factory update refuses a removed or unknown layout and changes nothing", () => {
  const up = upstream();
  const d = submoduleProject(up);
  addUpstreamHook(up);
  for (const layout of ["old", "sideways"]) {
    const p = run(["bash", "factory", "update", "--layout", layout], { cwd: d, env: GIT_ENV });
    expect(p.code === 1 && p.stderr.includes('"code": "layout_removed"'), p.out).toBe(true);
  }
  expect(existsSync(join(d, ".claude/hooks/factory_zz.ts")), "the submodule was not moved").toBe(false);
  expect(sh(d, "bash", "factory", "update", "--layout", "new").stdout).toContain("add factory_zz");
});

function emptyDirs(d: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (!entries.length) out.push(relative(d, dir));
    for (const e of entries) if (e.isDirectory() && e.name !== ".git") walk(join(dir, e.name));
  };
  walk(d);
  return out.sort();
}

function cleanCopyOfThisRepo(): string {
  const d = join(tmp(), "repo");
  cpSync(ROOT, d, { recursive: true, verbatimSymlinks: true,
    filter: (src) => !/(^|\/)(\.git|__pycache__|docs|node_modules)$/.test(src) || src === ROOT });
  return d;
}

/** check_skills.ts lines other than the one rule this branch still breaks on purpose: until the last family is ported,
 * unported .py files are left on the branch (#252), and check_skills says so for each. */
function checkSkillsProblems(p: Proc): string[] {
  return p.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("ok:") && !l.includes("a Python file; the factory is TypeScript on Bun (#252)"));
}

test("relinking this repo leaves no empty folder and check skills passes", () => {
  // #152: the project already has .claude/factory.json, so the docs templates are left out; the folders they would
  // have sat in must not be made either (check_skills.ts fails on a top-level folder that is not a skill).
  const d = cleanCopyOfThisRepo();
  expect(existsSync(join(d, "docs")), "the clean copy starts without docs/").toBe(false);
  for (let i = 0; i < 2; i++) { // twice: the second run changes nothing
    sh(d, "bash", "software-factory/install.sh", ".", "--link", "--layout", "new");
    expect(emptyDirs(d)).toEqual([]);
    expect(existsSync(join(d, "docs"))).toBe(false);
    const p = run([process.execPath, "--no-env-file", "tools/check_skills.ts"], { cwd: d });
    expect(checkSkillsProblems(p), p.out).toEqual([]);
    const py = run(["git", "-C", ROOT, "ls-files", "*.py"]).stdout.trim();
    if (!py) expect(p.code, p.out).toBe(0); // once no .py is left, the whole check passes
  }
});

test("a setup project gets no empty docs folder in either mode", () => {
  for (const args of [["--link", "--layout", "new"], ["--link"], []]) {
    const d = project();
    install(d, ...args); // first run: the templates are copied, docs/ holds files
    expect(isFile(join(d, "docs", "build-plan.md")), args.join(" ")).toBe(true);
    rmSync(join(d, "docs"), { recursive: true }); // the project chose not to keep them
    install(d, ...args);
    expect(existsSync(join(d, "docs")), args.join(" ")).toBe(false);
    expect(emptyDirs(d), args.join(" ")).toEqual([]);
  }
});

// From test_forwarders.py: a link install from a copy of this whole repo resolves to the factory's folders.
test("link install in a project resolves to the factorys folders", () => {
  const d = tmp();
  mkdirSync(join(d, "vendor"));
  sh(d, "cp", "-a", ROOT, join(d, "vendor", "my-skills")); // install.sh --link needs the kit inside the project
  sh(d, "git", "init", "-q");
  sh(d, "bash", join(d, "vendor", "my-skills", "software-factory", "install.sh"), ".", "--link");
  for (const rel of [BUN_HOOK, ".claude/ci/ci.sh", "factory", "factory-loop.sh"]) {
    expect(isLink(join(d, rel)) && isFile(join(d, rel)), rel).toBe(true);
  }
  const help = run(["bash", join(d, "factory"), "help"], { cwd: d });
  expect(help.code === 0 && help.stdout.includes("factory <command>"), help.out).toBe(true);
  const guard = run([process.execPath, "--no-env-file", join(d, BUN_HOOK), "--help"], { cwd: d });
  expect(guard.code === 0 && !guard.stderr.includes("Cannot find module"), guard.out).toBe(true);
});
