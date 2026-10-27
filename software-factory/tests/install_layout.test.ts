// install.sh and `factory update` know the new layout (#112 step 2): a project's links can point straight at the
// factory's own folders (hooks/, ci/, factory, factory-loop.sh) instead of the forwarders under kit/. A project that
// links through kit/ stays there until it asks for the switch (--layout new), so nothing flips on a plain re-run.
//
// #252: a Bun script (.ts) has no forwarder in kit/, so in the old layout it is linked straight to hooks/ (as #174 does
// for any file without a forwarder); the files that still have forwarders (the .sh scripts, ci/, the entry points) keep
// going through kit/.
import { expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type Proc, ROOT, SF, sh as run, tmp } from "./support.ts";

const VENDOR = "vendor/my-skills/software-factory";
const GIT_ENV = { ...process.env, GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always",
  GIT_CONFIG_KEY_1: "user.name", GIT_CONFIG_VALUE_1: "t", GIT_CONFIG_KEY_2: "user.email", GIT_CONFIG_VALUE_2: "t@example.com" };
const FORWARDED = [".claude/hooks/wait_for_merge.sh", ".claude/ci/ci.sh", ".claude/ci/entrypoint.sh", "factory", "factory-loop.sh"];
const BUN_HOOK = ".claude/hooks/factory_guard.ts";
const ENGINE = [BUN_HOOK, ...FORWARDED];
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

test("a project linked through kit keeps its links on a plain rerun", () => {
  const d = project();
  install(d, "--link", "--layout", "old"); // what every project got before the move
  const before = links(d);
  for (const rel of FORWARDED) {
    expect(before[rel], rel).toContain("/kit/");
    expect(isFile(join(d, rel)), rel).toBe(true);
  }
  expect(before[BUN_HOOK], "a Bun script has no forwarder: it is linked straight to hooks/").toBe("../../" + VENDOR + "/hooks/factory_guard.ts");
  const out = install(d, "--link").stdout; // auto: stays on kit/
  expect(links(d)).toEqual(before);
  expect(out.includes("relinked") || out.includes("was a copy"), out).toBe(false);
  expect(links(d), "a second run changes nothing either").toEqual(before);
});

test("layout new switches a kit linked project and a rerun changes nothing", () => {
  const d = project();
  install(d, "--link", "--layout", "old");
  let out = install(d, "--link", "--layout", "new").stdout;
  for (const rel of FORWARDED) expect(out, rel).toContain(`relinked ${rel} (from kit/ to the new folder)`);
  for (const rel of ENGINE) {
    expect(readlinkSync(join(d, rel)), rel).not.toContain("/kit/");
    expect(isFile(join(d, rel)), rel).toBe(true);
  }
  const after = links(d);
  out = install(d, "--link").stdout; // auto now finds no kit/ link, so it is new and idempotent
  expect(links(d)).toEqual(after);
  expect(out).not.toContain("relinked");
  expect(sh(d, "bash", join(d, "factory"), "help").stdout).toContain("factory <command>");
});

test("a copy that differs is kept and a plain copy becomes a link in either layout", () => {
  for (const layout of ["new", "old"]) {
    const d = project();
    mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
    copyFileSync(join(SF, "hooks", "check.ts"), join(d, ".claude", "hooks", "check.ts"));
    writeFileSync(join(d, ".claude", "hooks", "factory_env.ts"), "// my own edit\n");
    const out = install(d, "--link", "--layout", layout).stdout;
    expect(isLink(join(d, ".claude", "hooks", "check.ts")), layout).toBe(true);
    expect(out).toContain("linked   .claude/hooks/check.ts (was a copy)");
    expect(isLink(join(d, ".claude", "hooks", "factory_env.ts"))).toBe(false);
    expect(out).toContain("kept     .claude/hooks/factory_env.ts (differs");
  }
});

test("a bad option is refused with a message", () => {
  const d = project();
  let p = run(["bash", join(d, VENDOR, "install.sh"), ".", "--layout", "sideways", "--link"], { cwd: d, env: GIT_ENV });
  expect(p.code === 1 && p.stderr.includes("--layout takes new, old or auto"), p.out).toBe(true);
  p = run(["bash", join(d, VENDOR, "install.sh"), ".", "--lnk"], { cwd: d, env: GIT_ENV });
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

test("factory update leaves a kit linked project on kit until asked", () => {
  const up = upstream();
  const d = submoduleProject(up, "--layout", "old");
  // upstream keeps a forwarder for a new shell hook (a .ts never gets one, #252)
  addUpstreamHook(up, "zz.sh", "#!/usr/bin/env bash\necho zz\n");
  symlinkSync("../../../hooks/zz.sh", join(up, "software-factory/kit/.claude/hooks/zz.sh"));
  sh(up, "git", "add", "-A");
  sh(up, "git", "commit", "-q", "-m", "forwarder");
  const before = links(d);
  let out = sh(d, "bash", "factory", "update").stdout;
  expect(links(d)).toEqual(before);
  expect(out).not.toContain("relinked");
  expect(readlinkSync(join(d, ".claude/hooks/zz.sh")), "new files follow the project's layout").toContain("/kit/");
  expect(sh(d, "bash", ".claude/hooks/zz.sh").stdout).toBe("zz\n");
  out = sh(d, "bash", "factory", "update", "--layout", "new").stdout; // same commit, but the switch was asked for
  expect(out.includes("relinked .claude/hooks/zz.sh") && out.includes("relinked factory "), out).toBe(true);
  expect(readlinkSync(join(d, ".claude/hooks/zz.sh"))).not.toContain("/kit/");
  expect(sh(d, "bash", ".claude/hooks/zz.sh").stdout).toBe("zz\n");
  expect(sh(d, "bash", "factory", "update").stdout).toContain("already at");
});

test("factory update on a kit linked project links a new file that has no forwarder", () => {
  // #174: at the old pin an update moved the submodule but linked nothing for a hook that exists only in hooks/, so
  // every later ./factory command failed with "can't open file .claude/hooks/...".
  const up = upstream();
  const d = submoduleProject(up, "--layout", "old");
  addUpstreamHook(up); // no forwarder in kit/
  const before = links(d);
  const out = sh(d, "bash", "factory", "update").stdout;
  const link = join(d, ".claude/hooks/factory_zz.ts");
  expect(isLink(link) && isFile(link), out).toBe(true);
  expect(readlinkSync(link)).toBe("../../vendor/my-skills/software-factory/hooks/factory_zz.ts");
  expect(bunRun(d, ".claude/hooks/factory_zz.ts").stdout).toBe("zz\n");
  expect(links(d), "the rest stays on kit/ until --layout new is asked for").toEqual(before);
  expect(sh(d, "bash", "factory", "help").code).toBe(0);
  expect(sh(d, "bash", "factory", "update").code).toBe(0); // and a second update still starts
});

test("factory update refuses an unknown layout", () => {
  const up = upstream();
  const d = submoduleProject(up);
  const p = run(["bash", "factory", "update", "--layout", "sideways"], { cwd: d, env: GIT_ENV });
  expect(p.code === 1 && p.stderr.includes("--layout takes new, old or auto"), p.out).toBe(true);
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

test("a setup project gets no empty docs folder in either mode and layout", () => {
  for (const args of [["--link", "--layout", "new"], ["--link", "--layout", "old"], []]) {
    const d = project();
    install(d, ...args); // first run: the templates are copied, docs/ holds files
    expect(isFile(join(d, "docs", "build-plan.md")), args.join(" ")).toBe(true);
    rmSync(join(d, "docs"), { recursive: true }); // the project chose not to keep them
    install(d, ...args);
    expect(existsSync(join(d, "docs")), args.join(" ")).toBe(false);
    expect(emptyDirs(d), args.join(" ")).toEqual([]);
  }
});

// From test_forwarders.py: the install case that waited for factory_stack (run by install.sh) to be ported.
test("link install in a project resolves through the forwarders", () => {
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
