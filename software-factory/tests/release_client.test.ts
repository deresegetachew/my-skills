// The release client (#113): factory version | releases | update [version] | rollback.
//
// A fake GitHub on 127.0.0.1 serves real archives built by tools/build_release.ts (from tiny fake repos, and once from
// this repo's own tree), so the producer and the client are tested against each other and nothing leaves the machine.
// `fake ci.sh` stands in for the runner services: it records what the client asks of it.
import { expect, test } from "bun:test";
import {
  accessSync, appendFileSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { build } from "../../tools/build_release.ts";
import * as m from "../hooks/factory_release.ts";
import { tarEntries } from "../hooks/factory_tar.ts";
import {
  buildRelease, cached, ciLog, commit, type Env, evilRelease, fac, type FakeGitHub, git, PIN, pin, rawTar, sha256, snapshot, spawn,
  stackWorld, UNITTEST_TESTS, world,
} from "./release_support.ts";
import { HOOKS, KIT, ROOT, SF, tmp, writeExe } from "./support.ts";

const read = (p: string): string => readFileSync(p, "utf8");
const json = (p: string): Record<string, unknown> => JSON.parse(read(p)) as Record<string, unknown>;
const executable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const VERSION_TS = (v: string): string => `export const VERSION = "${v}";\n`;

// --- first install, update, a named release ---------------------------------------------------------------------

test("first install takes the newest full release and records it in the pin", async () => {
  const [gh, d, env] = await world("1.0.0", "1.1.0");
  gh.add("1.2.0-rc.1", { pre: true }); // a pre-release is never "newest" unless asked for by name
  const [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(out.includes("v1.1.0") && !out.includes("v1.2.0-rc.1"), out).toBe(true);
  expect(read(join(d, ".claude/hooks/factory_x.ts"))).toBe(VERSION_TS("1.1.0"));
  expect(read(join(d, ".claude/agents/a.md"))).toBe("agent 1.1.0\n");
  expect(executable(join(d, "factory")) && executable(join(d, ".claude/ci/ci.sh"))).toBe(true);
  expect(existsSync(join(d, "kit")), "the kit/ forwarders are not installed").toBe(false);
  const p = pin(d);
  const archive = (gh.assets["v1.1.0"] as Record<string, Uint8Array>)["software-factory-1.1.0.tar.gz"] as Uint8Array;
  expect(p.tag === "v1.1.0" && p.version === "1.1.0" && p.sha256 === sha256(archive), JSON.stringify(p)).toBe(true);
  expect(p.previous).toBeNull();
  expect(p.files[".claude/hooks/factory_x.ts"]).toBe(sha256(VERSION_TS("1.1.0")));
  expect(existsSync(join(d, ".claude/factory.json")) && existsSync(join(d, "docs/blocked.md")), "templates on a first install").toBe(true);
  expect(read(join(d, ".gitignore")).split(/\s+/)).toContain("tmp/");
  expect(git(d, "branch", "--list").split(/\s+/).filter(Boolean), "no branch is created").toEqual(["*", "main"]);
  expect(git(d, "log", "--oneline").split("\n").length - 1, "nothing is committed").toBe(1);
  expect(out.includes("git add") && out.includes("commit"), "the report says how to commit it").toBe(true);
});

test("a project with its own factory json gets the manager profile and the next release updates it", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0", { files: { "kit/.claude/manager/settings.json": '{"profile": "1.0.0"}\n' }, date: "2026-10-01T10:00:00Z" });
  gh.add("1.1.0", { files: { "kit/.claude/manager/settings.json": '{"profile": "1.1.0"}\n' }, date: "2026-11-01T10:00:00Z" });
  const own = join(d, ".claude", "factory.json");
  mkdirSync(dirname(own), { recursive: true });
  writeFileSync(own, '{"mainBranch": "trunk"}\n'); // the project already has its own config, so templates are not given
  commit(d);
  const profile = join(d, ".claude", "manager", "settings.json");
  let [rc, out] = await fac(d, env, "update", "1.0.0");
  expect(rc, out).toBe(0);
  expect(read(profile), "an engine file, given even when factory.json exists").toBe('{"profile": "1.0.0"}\n');
  expect(read(own)).toBe('{"mainBranch": "trunk"}\n');
  expect(Object.keys(pin(d).files), "so verification checks it").toContain(".claude/manager/settings.json");
  commit(d);
  [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(read(profile)).toBe('{"profile": "1.1.0"}\n');
  writeFileSync(profile, "{}\n"); // a drifted profile is found and repaired like any engine file
  commit(d);
  [rc, out] = await fac(d, env, "update");
  expect(read(profile), out).toBe('{"profile": "1.1.0"}\n');
});

function settingsAllow(d: string): string[] {
  return ((json(join(d, ".claude", "factory", "settings.json")).permissions as Record<string, unknown>).allow) as string[];
}

test("a projects extra allow entries are merged survive updates and are not drift", async () => {
  const [gh, d, env] = await world();
  const kit = (allow: string[]): Record<string, string> => ({
    "kit/.claude/factory/settings.json": JSON.stringify({ permissions: { allow, deny: ["Bash(rm *)"] } }) + "\n",
  });
  gh.add("1.0.0", { files: kit(["Bash(ls *)"]), date: "2026-10-01T10:00:00Z" });
  gh.add("1.1.0", { files: kit(["Bash(ls *)", "Bash(git log*)"]), date: "2026-11-01T10:00:00Z" });
  const own = join(d, ".claude", "factory.json");
  mkdirSync(dirname(own), { recursive: true });
  writeFileSync(own, JSON.stringify({ permissions: { allow: ["Edit(tmp/**)", "Bash(ls *)", "Bash(mkdir -p *)"] } }) + "\n");
  commit(d);
  let [rc, out] = await fac(d, env, "update", "1.0.0");
  expect(rc, out).toBe(0);
  expect(settingsAllow(d), "the release's entries, then the project's, no repeats").toEqual(["Bash(ls *)", "Edit(tmp/**)", "Bash(mkdir -p *)"]);
  expect((json(join(d, ".claude", "factory", "settings.json")).permissions as Record<string, unknown>).deny).toEqual(["Bash(rm *)"]);
  [rc, out] = await fac(d, env, "version");
  expect(out).toContain("the files match the pin");
  commit(d);
  [rc, out] = await fac(d, env, "update"); // the next release keeps the project's entries
  expect(rc, out).toBe(0);
  expect(settingsAllow(d)).toEqual(["Bash(ls *)", "Bash(git log*)", "Edit(tmp/**)", "Bash(mkdir -p *)"]);
  expect((await fac(d, env, "version"))[1]).not.toContain("differ");
  commit(d);
  const settings = join(d, ".claude", "factory", "settings.json"); // an entry added by hand in settings.json is still drift
  const data = json(settings);
  ((data.permissions as Record<string, unknown>).allow as string[]).push("Bash(curl *)");
  writeFileSync(settings, JSON.stringify(data, null, 2));
  expect((await fac(d, env, "version"))[1]).toContain("settings.json differs from v1.1.0");
});

test("an allow entry added to factory json needs an update to take effect and doctor says so", async () => {
  const [, d, env] = await world("1.0.0");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  writeFileSync(join(d, ".claude", "factory.json"), JSON.stringify({ permissions: { allow: ["Edit(tmp/**)"] } }) + "\n");
  commit(d);
  let [rc, out] = await fac(d, env, "version");
  expect(out.includes("Edit(tmp/**)") && out.includes("differ"), out).toBe(true);
  [rc, out] = await fac(d, env, "update");
  expect(rc === 0 && settingsAllow(d).includes("Edit(tmp/**)"), out).toBe(true);
  expect((await fac(d, env, "version"))[1]).not.toContain("Edit(tmp/**)");
});

test("a bad allow list is refused with a fix and changes nothing", async () => {
  const [, d, env] = await world("1.0.0");
  mkdirSync(join(d, ".claude"));
  writeFileSync(join(d, ".claude", "factory.json"), JSON.stringify({ permissions: { allow: "Edit(tmp/**)" } }) + "\n");
  commit(d);
  const before = snapshot(d);
  const [rc, out] = await fac(d, env, "update");
  expect(rc !== 0 && out.includes("permissions.allow") && out.includes("Fix:"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
});

test("the kits default allow list has what a headless coding agent needs and no unmatched or risky rules", () => {
  const allow = ((json(join(KIT, ".claude", "factory", "settings.json")).permissions as Record<string, unknown>).allow) as string[];
  for (const entry of ["Edit(tmp/**)", "Bash(cd *)", "Bash(ls *)", "Bash(mkdir -p *)", "Bash(git rev-parse*)"]) expect(allow).toContain(entry);
  expect(allow.filter((a) => a.startsWith("Write(")), "Claude Code never matches Write(path) rules").toEqual([]);
  expect(allow.filter((a) => a.includes("python3 -c")), "an inline interpreter would let an agent run anything").toEqual([]);
  expect(allow.length).toBe(new Set(allow).size);
  // #252: the factory's hooks run on Bun; the old Python rule is gone
  expect(allow).toContain("Bash(bun --no-env-file .claude/hooks/*)");
  expect(allow).not.toContain("Bash(python3 .claude/hooks/*)");
});

/** A real release built by tools/build_release.ts, as files on disk: [archive path, SHA256SUMS path]. */
function localRelease(version = "1.0.0"): [string, string] {
  const dist = buildRelease(version);
  return [join(dist, `software-factory-${version}.tar.gz`), join(dist, "SHA256SUMS")];
}

function offline(env: Env): Env {
  return { ...env, FACTORY_RELEASE_API: "http://127.0.0.1:9" }; // nothing listens there: any request would fail
}

test("update from a local archive installs it with no network and records the pin", async () => {
  const [gh, d, env] = await world();
  const [archive, sums] = localRelease("1.0.0");
  const [rc, out] = await fac(d, offline(env), "update", "--archive", archive, "--sums", sums);
  expect(rc, out).toBe(0);
  expect(read(join(d, ".claude/hooks/factory_x.ts"))).toBe(VERSION_TS("1.0.0"));
  const p = pin(d);
  expect(p.tag === "v1.0.0" && p.sha256 === sha256(readFileSync(archive)), JSON.stringify(p)).toBe(true);
  expect(gh.hits, "no request reached the fake GitHub").toEqual([]);
  expect(out.includes("local archive") && out.includes("git add"), out).toBe(true);
  expect(out.includes("not refreshed") && ciLog(env).slice(0, -1).length === 0, "the archive's own scripts are not run to refresh services").toBe(true);
});

test("the sums file defaults to the one beside the archive and a version must agree with the archive", async () => {
  const [, d, env] = await world();
  const [archive, sums] = localRelease("1.0.0");
  let [rc, out] = await fac(d, offline(env), "update", "--archive", archive);
  expect(rc === 0 && pin(d).tag === "v1.0.0", out).toBe(true);
  commit(d);
  [rc, out] = await fac(d, offline(env), "update", "v2.0.0", "--archive", archive, "--sums", sums);
  expect(rc !== 0 && out.includes("[version_mismatch]") && out.includes("Fix:"), out).toBe(true);
});

test("a local archive with a wrong checksum is refused and nothing is changed", async () => {
  const [, d, env] = await world();
  const [archive, sums] = localRelease("1.0.0");
  writeFileSync(sums, "0".repeat(64) + "  software-factory-1.0.0.tar.gz\n");
  const before = snapshot(d);
  const [rc, out] = await fac(d, offline(env), "update", "--archive", archive, "--sums", sums);
  expect(rc !== 0 && out.includes("[bad_checksum]") && out.includes("Fix:"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
});

test("an archive changed after its sums were made is refused", async () => {
  const [, d, env] = await world();
  const [archive, sums] = localRelease("1.0.0");
  const data = new Uint8Array(readFileSync(archive));
  data[data.length - 1] = (data[data.length - 1] as number) ^ 1;
  writeFileSync(archive, data);
  const [rc, out] = await fac(d, offline(env), "update", "--archive", archive, "--sums", sums);
  expect((rc !== 0 && out.includes("bad_checksum")) || out.includes("bad_archive"), out).toBe(true);
  expect(existsSync(join(d, PIN))).toBe(false);
});

test("a missing archive or sums file is refused with the fix", async () => {
  const [, d, env] = await world();
  const [archive, sums] = localRelease("1.0.0");
  let [rc, out] = await fac(d, offline(env), "update", "--archive", archive + ".nope");
  expect(rc !== 0 && out.includes("[missing_file]") && out.includes("Fix:"), out).toBe(true);
  rmSync(sums);
  [rc, out] = await fac(d, offline(env), "update", "--archive", archive);
  expect(rc !== 0 && out.includes("[missing_file]") && out.includes("SHA256SUMS"), out).toBe(true);
  [rc, out] = await fac(d, offline(env), "update", "--sums", sums);
  expect(rc !== 0 && out.includes("--archive"), out).toBe(true);
});

test("an archive whose name is not a release is refused", async () => {
  const [, d, env] = await world();
  const [archive, sums] = localRelease("1.0.0");
  const odd = join(dirname(archive), "release.tgz");
  copyFileSync(archive, odd);
  const [rc, out] = await fac(d, offline(env), "update", "--archive", odd, "--sums", sums);
  expect(rc !== 0 && out.includes("[bad_archive_name]") && out.includes("software-factory-"), out).toBe(true);
});

test("the factory command sends update archive to the release client even before a pin exists", () => {
  const text = read(join(SF, "factory"));
  expect((text.split("update)")[1] as string).split("--layout")[0], "factory update --archive reaches factory_release.ts").toContain("--archive");
});

test("update moves to the newest release removes files it dropped and leaves the projects own files", async () => {
  const [gh, d, env] = await world("1.0.0");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  writeFileSync(join(d, ".claude/factory.json"), '{"mainBranch": "trunk"}\n'); // the project's own settings
  commit(d);
  gh.add("1.1.0", { files: { "hooks/factory_old.ts": null, "hooks/factory_new.ts": "export const NEW = 1;\n" },
    notes: "Software factory v1.1.0.\n\nChanges since v1.0.0:\n\n- faster waits (1111111)\n- quieter checks (2222222)\n" });
  const [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(pin(d).version === "1.1.0" && pin(d).previous?.tag === "v1.0.0", JSON.stringify(pin(d))).toBe(true);
  expect(existsSync(join(d, ".claude/hooks/factory_old.ts"))).toBe(false);
  expect(existsSync(join(d, ".claude/hooks/factory_new.ts"))).toBe(true);
  expect(read(join(d, ".claude/factory.json"))).toBe('{"mainBranch": "trunk"}\n');
  for (const need of ["v1.0.0 -> v1.1.0", "faster waits (1111111)", "quieter checks (2222222)"]) expect(out).toContain(need);
  expect(out.includes("removed") && out.includes("factory_old.ts"), out).toBe(true);
});

// #252: the releases already published (v0.1.0-alpha.3 and before) are Python. `factory update` from such an install to
// a Bun release removes every .py the new release no longer ships, and `factory version` (the drift check doctor
// shares) sees no drift afterwards.
test("update from a python release to a bun release removes the python files and leaves no drift", async () => {
  const [gh, d, env] = await world();
  gh.add("0.1.0-alpha.3", { pre: true, date: "2026-10-01T10:00:00Z", files: {
    "hooks/factory_x.ts": null, "hooks/factory_old.ts": null,
    "hooks/factory_x.py": "VERSION = '0.1.0-alpha.3'\n", "hooks/factory_old.py": "OLD = 1\n",
    "hooks/sub/helper.py": "HELP = 1\n",
    "kit/.claude/factory/settings.json": null, // releases before #258 kept the agents' rules in .claude/settings.json
    "kit/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(python3 .claude/hooks/*)"] }, hooks: { Stop: [{ hooks: [{
      type: "command", command: "python3 \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/factory_x.py" }] }] } }) + "\n",
  } });
  let [rc, out] = await fac(d, env, "update", "v0.1.0-alpha.3");
  expect(rc, out).toBe(0);
  expect(existsSync(join(d, ".claude/hooks/factory_x.py"))).toBe(true);
  commit(d, "on the python release");
  gh.add("0.2.0", { date: "2026-11-01T10:00:00Z" });
  [rc, out] = await fac(d, env, "update", "v0.2.0");
  expect(rc, out).toBe(0);
  for (const gone of [".claude/hooks/factory_x.py", ".claude/hooks/factory_old.py", ".claude/hooks/sub/helper.py"]) {
    expect(existsSync(join(d, gone)), gone).toBe(false);
    expect(out).toContain(`removed ${gone}`);
  }
  expect(existsSync(join(d, ".claude/hooks/sub")), "an emptied folder goes too").toBe(false);
  expect(read(join(d, ".claude/hooks/factory_x.ts"))).toBe(VERSION_TS("0.2.0"));
  expect(Object.keys(pin(d).files).filter((f) => f.endsWith(".py")), "the pin lists no python file").toEqual([]);
  expect(read(join(d, ".claude/factory/settings.json"))).not.toContain("python3");
  expect(existsSync(join(d, ".claude/settings.json")), "the old rules file goes: it matched the pin (#258)").toBe(false);
  expect(out).toContain("removed .claude/settings.json");
  expect(out).toContain("The agents' rules moved from .claude/settings.json to .claude/factory/settings.json");
  commit(d, "on the bun release");
  [rc, out] = await fac(d, env, "version");
  expect(rc === 0 && out.includes("the files match the pin") && !out.includes("differ"), out).toBe(true);
  [rc, out] = await fac(d, env, "rollback"); // and back to Python, from the cache, still verified
  expect(rc === 0 && pin(d).tag === "v0.1.0-alpha.3", out).toBe(true);
  expect(existsSync(join(d, ".claude/hooks/factory_x.py")) && !existsSync(join(d, ".claude/hooks/factory_x.ts"))).toBe(true);
});

test("an old rules file the project changed is kept and named and a dropped file it changed is kept too", async () => {
  // #258: the agents' rules move to .claude/factory/settings.json; a file the project edited is never thrown away
  const [gh, d, env] = await world();
  gh.add("1.0.0", { date: "2026-10-01T10:00:00Z", files: {
    "kit/.claude/factory/settings.json": null,
    "kit/.claude/settings.json": JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }) + "\n",
  } });
  let [rc, out] = await fac(d, env, "update", "1.0.0");
  expect(rc, out).toBe(0);
  writeFileSync(join(d, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm *)"], allow: ["Bash(mine *)"] } }) + "\n");
  writeFileSync(join(d, ".claude", "hooks", "factory_old.ts"), "export const OLD = 2; // changed here\n");
  commit(d, "local changes");
  gh.add("1.1.0", { date: "2026-11-01T10:00:00Z", files: { "hooks/factory_old.ts": null } });
  [rc, out] = await fac(d, env, "update", "1.1.0");
  expect(rc, out).toBe(0);
  expect(read(join(d, ".claude", "settings.json"))).toContain("Bash(mine *)");
  expect(out).toContain("kept .claude/settings.json: it has local changes and this release no longer ships it");
  expect(out).toContain("permissions.allow");
  expect(existsSync(join(d, ".claude", "factory", "settings.json")), "the agents' rules are installed where the factory reads them").toBe(true);
  expect(read(join(d, ".claude", "hooks", "factory_old.ts"))).toContain("changed here");
  expect(out).toContain("kept .claude/hooks/factory_old.ts: it has local changes");
  expect(out).not.toContain("removed .claude/settings.json");
});

test("update from a python release to a bun release rewrites the workflow steps that call a removed python hook", async () => {
  // #254: the workflow is the project's file, but CI on the update PR fails at once while it calls the deleted scripts
  const [gh, d, env] = await world();
  gh.add("0.1.0-alpha.3", { pre: true, date: "2026-10-01T10:00:00Z", files: {
    "hooks/factory_x.ts": null, "hooks/factory_old.ts": null,
    "hooks/factory_x.py": "VERSION = '0.1.0-alpha.3'\n", "hooks/factory_old.py": "OLD = 1\n",
    "kit/.claude/factory/settings.json": null,
    "kit/.claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{
      type: "command", command: "python3 \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/factory_x.py" }] }] } }) + "\n",
  } });
  let [rc, out] = await fac(d, env, "update", "v0.1.0-alpha.3");
  expect(rc, out).toBe(0);
  const ci =join(d, ".github/workflows/ci.yml");
  mkdirSync(dirname(ci), { recursive: true });
  writeFileSync(ci, [
    "name: CI", "on: [pull_request]", "jobs:",
    "  guard:", "    runs-on: ubuntu-latest", "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: python3 .claude/hooks/factory_x.py --base main",
    "  check:", "    runs-on: ubuntu-latest", "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: oven-sh/setup-bun@v2",
    "      - name: Tests", "        run: python3 .claude/hooks/factory_x.py run test",
    "      - run: python3 .claude/hooks/factory_gone.py",
    "",
  ].join("\n"));
  commit(d, "on the python release");
  gh.add("0.2.0", { date: "2026-11-01T10:00:00Z" });
  [rc, out] = await fac(d, env, "update", "v0.2.0");
  expect(rc, out).toBe(0);
  const text = read(ci);
  expect(text).not.toContain("python3 .claude/hooks/factory_x.py");
  expect(text).toContain("run: bun --no-env-file .claude/hooks/factory_x.ts --base main");
  expect(text).toContain("run: bun --no-env-file .claude/hooks/factory_x.ts run test");
  expect(text, "a removed hook with no Bun version is left for doctor to name").toContain("python3 .claude/hooks/factory_gone.py");
  const guard = text.slice(text.indexOf("  guard:"), text.indexOf("  check:"));
  const check = text.slice(text.indexOf("  check:"));
  expect(guard.indexOf("oven-sh/setup-bun@v2"), "the job without Bun gets the setup step").toBeGreaterThan(-1);
  expect(guard.indexOf("oven-sh/setup-bun@v2")).toBeLessThan(guard.indexOf("bun --no-env-file"));
  expect(check.split("oven-sh/setup-bun").length - 1, "a job that has it gets no second one").toBe(1);
  expect(out).toContain("Changed .github/workflows/ci.yml");
  expect(out).toContain("python3 .claude/hooks/factory_x.py  ->  bun --no-env-file .claude/hooks/factory_x.ts");
  const after = read(ci);
  commit(d, "on the bun release");
  [rc, out] = await fac(d, env, "update", "v0.2.0"); // safe to run twice
  expect(rc === 0 && read(ci) === after && !out.includes("Changed .github"), out).toBe(true);
});

test("verification parses every installed ts file and a broken one fails the update", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0", { files: { "hooks/factory_bad.ts": "export const = ;\n" } });
  const [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[verification_failed]") && out.includes(".claude/hooks/factory_bad.ts does not parse"), out).toBe(true);
});

test("running update twice changes nothing the second time even before the first is committed", async () => {
  const [, d, env] = await world("1.0.0");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  const before = snapshot(d);
  const status = git(d, "status", "--porcelain");
  let [rc, out] = await fac(d, env, "update"); // the tree is dirty with the first update: the same update again is fine
  expect(rc === 0 && out.includes("already"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
  expect(git(d, "status", "--porcelain")).toBe(status);
  commit(d);
  [rc, out] = await fac(d, env, "update");
  expect(rc === 0 && out.includes("already") && git(d, "status", "--porcelain") === "", out).toBe(true);
});

test("a named release can be installed newer or older with or without the v", async () => {
  const [, d, env] = await world("1.0.0", "1.1.0", "2.0.0");
  expect((await fac(d, env, "update", "1.1.0"))[0]).toBe(0);
  expect(pin(d).tag).toBe("v1.1.0");
  commit(d);
  let [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc === 0 && pin(d).tag === "v1.0.0" && out.includes("v1.1.0 -> v1.0.0"), out).toBe(true);
  expect(pin(d).previous?.tag).toBe("v1.1.0");
  commit(d);
  [rc, out] = await fac(d, env, "update", "v2.0.0");
  expect(rc === 0 && pin(d).tag === "v2.0.0", out).toBe(true);
});

test("an unknown release is refused with the ones that exist and nothing changes", async () => {
  const [, d, env] = await world("1.0.0", "1.1.0");
  const before = snapshot(d);
  const [rc, out] = await fac(d, env, "update", "v9.9.9");
  expect(rc === 1 && out.includes("[no_such_release]") && out.includes("v1.1.0") && out.includes("factory releases"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
});

test("update never creates a branch or a commit and works from any branch", async () => {
  const [, d, env] = await world("1.0.0");
  git(d, "checkout", "-q", "-b", "stale-topic"); // a leftover local branch with no remote
  const heads = git(d, "rev-parse", "HEAD");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  expect(git(d, "branch", "--show-current").trim()).toBe("stale-topic");
  expect(git(d, "rev-parse", "HEAD")).toBe(heads);
  expect(git(d, "branch", "--format=%(refname:short)").split(/\s+/).filter(Boolean).sort()).toEqual(["main", "stale-topic"]);
});

// --- refusals: dirty tree, checksum, network, interrupted download, unsafe archive -------------------------------

test("a dirty tree is refused with the reason and nothing is changed or stashed", async () => {
  const [gh, d, env] = await world("1.0.0");
  appendFileSync(join(d, "README.md"), "edit\n");
  writeFileSync(join(d, "scratch.txt"), "untracked\n");
  const before = snapshot(d);
  const [rc, out] = await fac(d, env, "update");
  for (const need of ["[dirty_tree]", "README.md", "scratch.txt", "git stash"]) expect(out).toContain(need);
  expect(rc).toBe(1);
  expect(snapshot(d)).toEqual(before);
  expect(git(d, "stash", "list")).toBe("");
  expect(gh.hits, "refused before any download").toEqual([]);
});

test("a bad checksum installs nothing and leaves nothing in the cache", async () => {
  const [gh, d, env] = await world("1.0.0");
  gh.corrupt.add("software-factory-1.0.0.tar.gz");
  const before = snapshot(d);
  let [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[bad_checksum]") && out.includes("v1.0.0"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
  expect(cached(env)).toEqual([]);
  gh.corrupt.clear();
  gh.corrupt.add("SHA256SUMS"); // the checksum file is what is wrong this time
  [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[bad_checksum]"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
});

test("a release without its checksum file is refused", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0");
  delete (gh.assets["v1.0.0"] as Record<string, Uint8Array>).SHA256SUMS;
  const [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[incomplete_release]") && out.includes("SHA256SUMS"), out).toBe(true);
  expect(existsSync(join(d, ".claude"))).toBe(false);
});

test("no network is a plain error and the project is untouched", async () => {
  const [, d, env] = await world("1.0.0");
  env.FACTORY_RELEASE_API = "http://127.0.0.1:1"; // nothing listens
  const before = snapshot(d);
  let [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[no_network]") && out.includes("rollback"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
  [rc, out] = await fac(d, env, "releases");
  expect(rc === 1 && out.includes("[no_network]"), out).toBe(true);
});

test("an interrupted download leaves no partial file and the next try works", async () => {
  const [gh, d, env] = await world("1.0.0");
  gh.truncate.add("software-factory-1.0.0.tar.gz");
  const before = snapshot(d);
  let [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[download_interrupted]") && out.includes("run"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
  expect(cached(env).filter((f) => f.includes("tar.gz"))).toEqual([]);
  gh.truncate.clear();
  [rc, out] = await fac(d, env, "update");
  expect(rc === 0 && pin(d).tag === "v1.0.0", out).toBe(true);
});

test("an archive cannot write outside its folder or unpack a link", async () => {
  const cases: [string, string, "file" | "link"][][] = [
    [["software-factory-6.6.6/../../evil", "x", "file"]],
    [["/tmp/evil-abs", "x", "file"]],
    [["software-factory-6.6.6/factory", "/etc/passwd", "link"]],
    [["other-top/factory", "x", "file"]],
  ];
  for (const entries of cases) {
    const [gh, d, env] = await world();
    evilRelease(gh, [...entries, ["software-factory-6.6.6/MANIFEST.json", "{}", "file"]]);
    const before = snapshot(d);
    const [rc, out] = await fac(d, env, "update");
    expect(rc === 1 && out.includes("[unsafe_archive]"), JSON.stringify(entries) + out).toBe(true);
    expect(snapshot(d)).toEqual(before);
    expect(existsSync("/tmp/evil-abs") || existsSync(join(dirname(d), "evil"))).toBe(false);
  }
});

test("an archive whose files do not match its manifest is refused", async () => {
  const [gh, d, env] = await world();
  const dist = buildRelease("6.6.6");
  const members = [...tarEntries(new Uint8Array(gunzipSync(readFileSync(join(dist, "software-factory-6.6.6.tar.gz")))))]
    .map((e): [string, Uint8Array | string, "file"] => [e.name, e.name.endsWith("hooks/factory_x.ts") ? "tampered\n" : new Uint8Array(e.data), "file"]);
  evilRelease(gh, members);
  const [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[bad_archive]") && out.includes("factory_x.ts"), out).toBe(true);
  expect(existsSync(join(d, ".claude"))).toBe(false);
});

test("agents cannot update the factory", async () => {
  const [, d, env] = await world("1.0.0");
  for (const v of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    const [rc, out] = await fac(d, { ...env, [v]: "1" }, "update");
    expect(rc === 1 && out.includes("[agent_session]"), v + out).toBe(true);
  }
  expect(existsSync(join(d, ".claude"))).toBe(false);
});

test("agents are denied update and rollback in the shipped settings", () => {
  const rules = ((json(join(KIT, ".claude", "factory", "settings.json")).permissions as Record<string, unknown>).deny) as string[];
  for (const rule of ["Bash(factory update*)", "Bash(./factory update*)", "Bash(factory rollback*)", "Bash(./factory rollback*)",
    "Bash(*factory_release*)"]) expect(rules).toContain(rule);
});

// --- rollback and offline use ------------------------------------------------------------------------------------

test("rollback returns to the previous release without the network and again goes forward", async () => {
  const [gh, d, env] = await world("1.0.0", "1.1.0");
  expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
  commit(d);
  expect((await fac(d, env, "update"))[0]).toBe(0);
  expect(pin(d).tag).toBe("v1.1.0");
  commit(d);
  gh.hits.length = 0;
  env.FACTORY_RELEASE_API = "http://127.0.0.1:1"; // the network is gone
  let [rc, out] = await fac(d, env, "rollback");
  expect(rc === 0 && pin(d).tag === "v1.0.0" && out.includes("v1.1.0 -> v1.0.0"), out).toBe(true);
  expect(read(join(d, ".claude/hooks/factory_x.ts"))).toBe(VERSION_TS("1.0.0"));
  expect(pin(d).previous?.tag).toBe("v1.1.0");
  commit(d);
  [rc, out] = await fac(d, env, "rollback");
  expect(rc === 0 && pin(d).tag === "v1.1.0", out).toBe(true);
  expect(gh.hits).toEqual([]);
});

test("rollback with nothing before it says how to name a release", async () => {
  const [, d, env] = await world("1.0.0");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  commit(d);
  let [rc, out] = await fac(d, env, "rollback");
  expect(rc === 1 && out.includes("[no_previous]") && out.includes("factory update v"), out).toBe(true);
  [rc, out] = await fac(tmp(), env, "rollback");
  expect(rc, out).toBe(1);
});

test("rollback checks the cached archive against the checksum recorded in the pin", async () => {
  const [, d, env] = await world("1.0.0", "1.1.0");
  expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
  commit(d);
  expect((await fac(d, env, "update"))[0]).toBe(0);
  commit(d);
  env.FACTORY_RELEASE_API = "http://127.0.0.1:1";
  // someone replaces the cached v1.0.0 archive AND its checksum file with a consistent but different pair
  const cache = join(env.FACTORY_CACHE_DIR as string, "deresegetachew__my-skills", "v1.0.0");
  expect(existsSync(join(cache, "software-factory-1.0.0.tar.gz"))).toBe(true);
  const fake = rawTar([["software-factory-1.0.0/MANIFEST.json", "{}", "file"]]);
  writeFileSync(join(cache, "software-factory-1.0.0.tar.gz"), fake);
  writeFileSync(join(cache, "SHA256SUMS"), `${sha256(fake)}  software-factory-1.0.0.tar.gz\n`);
  const before = snapshot(d);
  const [rc, out] = await fac(d, env, "rollback");
  expect(rc === 1 && out.includes("[bad_checksum]") && out.includes("pin"), out).toBe(true);
  expect(snapshot(d)).toEqual(before);
});

test("a release already downloaded installs again without the network", async () => {
  const [, d, env] = await world("1.0.0", "1.1.0");
  expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
  commit(d);
  env.FACTORY_RELEASE_API = "http://127.0.0.1:1";
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc === 0 && out.includes("already"), out).toBe(true);
});

// --- drift and the machine ---------------------------------------------------------------------------------------

test("a drifted file is found by version and repaired by update even when committed", async () => {
  const [, d, env] = await world("1.0.0");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  commit(d);
  appendFileSync(join(d, ".claude/hooks/factory_x.ts"), "// hand edit\n");
  rmSync(join(d, ".claude/agents/a.md"));
  commit(d, "someone edited the shared files");
  let [rc, out] = await fac(d, env, "version");
  expect(rc === 0 && out.includes("differ") && out.includes("factory_x.ts") && out.includes("a.md"), out).toBe(true);
  [rc, out] = await fac(d, env, "update");
  expect(rc === 0 && out.includes("repaired"), out).toBe(true);
  expect(read(join(d, ".claude/hooks/factory_x.ts"))).toBe(VERSION_TS("1.0.0"));
  expect(existsSync(join(d, ".claude/agents/a.md"))).toBe(true);
  expect((await fac(d, env, "version"))[1]).not.toContain("differ");
});

test("services older than the pin are refreshed only when they are older", async () => {
  const [, d, env] = await world("1.0.0");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  const log = ciLog(env);
  expect(log.includes("stale") && !log.includes("install"), log.join("|")).toBe(true); // nothing was older: no reinstall
  commit(d);
  writeFileSync(env.FAKE_CI_STALE as string, ""); // the machine pulled this pin, but its runner services are from before
  const [rc, out] = await fac(d, env, "update");
  expect(rc === 0 && out.includes("already") && out.includes("runner services"), out).toBe(true);
  expect(ciLog(env)).toContain("install");
  expect(existsSync(env.FAKE_CI_STALE as string)).toBe(false);
  expect(ciLog(env)).toContain("check");
});

test("a runner whose start script cannot be read fails the verification and is not called success", async () => {
  const [, d, env] = await world("1.0.0");
  writeFileSync(env.FAKE_CI_BROKEN as string, "");
  let [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[verification_failed]") && out.includes("entrypoint.sh"), out).toBe(true);
  expect(!out.includes("Updated") && !out.includes("up to date"), out).toBe(true);
  rmSync(env.FAKE_CI_BROKEN as string);
  commit(d);
  [rc, out] = await fac(d, env, "update");
  expect(rc === 0 && out.includes("verified"), out).toBe(true);
});

/** A systemctl on PATH that says a heartbeat unit is installed (or not) and logs what it is asked. */
function fakeSystemd(env: Env, enabled = true, restartFails = false): string {
  const bin = tmp();
  const log = join(bin, "systemctl.log");
  writeExe(join(bin, "systemctl"), `#!/usr/bin/env bash\necho "$*" >>${log}\ncase "$2" in\n  show-environment) exit 0 ;;\n` +
    `  is-enabled) exit ${enabled ? 0 : 1} ;;\n  restart) exit ${restartFails ? 1 : 0} ;;\nesac\n`);
  env.PATH = `${bin}:${env.PATH}`;
  env.FACTORY_AUTOSTART_PLATFORM = "linux";
  return log;
}

const readOr = (p: string): string => (existsSync(p) ? read(p) : "");

test("an installed heartbeat daemon is restarted so it does not keep running the old code", async () => {
  const [, d, env] = await world("1.0.0");
  const log = fakeSystemd(env);
  const [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(readOr(log)).toMatch(/--user restart .*-factory-heartbeat\.service/);
  expect(out.includes("Restarted") && out.includes("heartbeat"), out).toBe(true);
});

test("no heartbeat daemon installed means nothing is restarted and nothing is said about it", async () => {
  const [, d, env] = await world("1.0.0");
  const log = fakeSystemd(env, false);
  const [rc, out] = await fac(d, env, "update");
  expect(rc === 0 && !readOr(log).includes("restart") && !out.includes("heartbeat"), out + readOr(log)).toBe(true);
});

test("a heartbeat daemon that will not restart fails the update with the fix", async () => {
  const [, d, env] = await world("1.0.0");
  fakeSystemd(env, true, true);
  const [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[services_failed]") && out.includes("factory heartbeat install"), out).toBe(true);
  expect(out).not.toContain("Done.");
});

test("verification catches a settings hook that points at a file that is not there", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0", { files: { "hooks/factory_x.ts": null } });
  const [rc, out] = await fac(d, env, "update");
  expect(rc === 1 && out.includes("[verification_failed]") && out.includes(".claude/hooks/factory_x.ts"), out).toBe(true);
});

// --- version and releases ----------------------------------------------------------------------------------------

test("version shows installed pinned newest and what changed since", async () => {
  const [gh, d, env] = await world("1.0.0", "1.1.0");
  gh.add("1.2.0", { notes: "Software factory v1.2.0.\n\nChanges:\n\n- a newer thing (3333333)\n" });
  expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
  commit(d);
  const remote = tmp();
  git(remote, "init", "-q", "--bare");
  git(d, "remote", "add", "origin", remote);
  git(d, "push", "-q", "origin", "main");
  git(d, "fetch", "-q", "origin");
  let [rc, out] = await fac(d, env, "version");
  expect(rc, out).toBe(0);
  for (const need of ["Installed", "v1.0.0", "Pinned", "origin/main", "Newest", "v1.2.0", "a newer thing (3333333)", "change in 1.1.0",
    "factory update"]) expect(out).toContain(need);
  env.FACTORY_RELEASE_API = "http://127.0.0.1:1";
  [rc, out] = await fac(d, env, "version"); // offline still answers what it knows
  expect(rc === 0 && out.includes("v1.0.0") && out.includes("unknown"), out).toBe(true);
  [rc, out] = await fac(d, env, "version", "--json");
  expect(rc, out).toBe(0);
  expect(((JSON.parse(out) as Record<string, Record<string, unknown>>).installed as Record<string, unknown>).tag).toBe("v1.0.0");
});

test("version in a project still on the submodule says so", async () => {
  const [, d, env] = await world("1.0.0");
  writeFileSync(join(d, ".gitmodules"), '[submodule "vendor/my-skills"]\n\tpath = vendor/my-skills\n\turl = https://github.com/deresegetachew/my-skills\n');
  const [rc, out] = await fac(d, env, "version");
  expect(rc === 0 && out.includes("submodule") && out.includes("v1.0.0") && out.includes("no release pin"), out).toBe(true);
});

test("releases lists newest first with dates notes and where you are", async () => {
  const [gh, d, env] = await world("1.0.0", "1.1.0");
  gh.add("1.2.0-rc.1", { pre: true, date: "2026-12-24T10:00:00Z" });
  expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
  const [rc, out] = await fac(d, env, "releases");
  const rows = out.split("\n").filter((l) => /^[* ] +v\d/.test(l));
  expect(rc, out).toBe(0);
  expect(rows.map((r) => r.replace(/^[* ]+/, "").split(/\s+/)[0])).toEqual(["v1.2.0-rc.1", "v1.1.0", "v1.0.0"]);
  for (const need of ["2026-12-24", "change in 1.1.0", "pre-release"]) expect(out).toContain(need);
  expect(rows.find((r) => r.includes("v1.0.0"))).toContain("installed");
  expect(rows.find((r) => r.includes("v1.1.0"))).toContain("newest");
});

// --- the old way keeps working, and the commands are wired in ----------------------------------------------------

/** A project that has the factory as real files (not the submodule), no pin yet, with the real `factory` command. */
function projectWithFactory(): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyFileSync(join(SF, "factory"), join(d, "factory"));
  writeFileSync(join(d, ".claude", "factory.json"), "{}\n");
  commit(d, "project");
  return d;
}

/** Always this checkout's own `factory`: an installed fake release replaces the project's copy with a stub. */
function runFactory(d: string, env: Env, ...args: string[]): Promise<[number, string]> {
  return spawn(["bash", join(SF, "factory"), ...args], d, { ...env, CLAUDE_PROJECT_DIR: d });
}

test("a project with no pin still updates through the submodule as before", async () => {
  const [gh, , env] = await world("1.0.0");
  const d = projectWithFactory();
  const [rc, out] = await runFactory(d, env, "update");
  expect(rc === 1 && out.includes("no my-skills submodule in .gitmodules"), out).toBe(true); // the old command ran, not the release client
  expect(existsSync(join(d, PIN))).toBe(false);
  expect(gh.hits).toEqual([]);
});

test("a project linked to the submodule cannot be overwritten by a release", async () => {
  const [, , env] = await world("1.0.0");
  const d = projectWithFactory();
  const target = join(d, ".claude", "hooks", "factory_x.ts");
  mkdirSync(join(d, "vendor"));
  writeFileSync(join(d, "vendor", "x.ts"), "x\n");
  symlinkSync("../../vendor/x.ts", target);
  commit(d, "linked");
  const [rc, out] = await runFactory(d, env, "update", "v1.0.0");
  expect(rc === 1 && out.includes("[linked_install]") && out.includes("factory_x.ts") && out.includes("submodule"), out).toBe(true);
  expect(lstatSync(target).isSymbolicLink()).toBe(true);
  expect(read(join(d, "vendor", "x.ts"))).toBe("x\n");
});

/** A copy of my-skills' own layout: the factory's real files, VERSION and the release builder at the root (#162). */
function factoryRepoCopy(): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  mkdirSync(join(d, "software-factory"));
  mkdirSync(join(d, "tools"));
  writeFileSync(join(d, "software-factory", "VERSION"), "1.0.0\n");
  writeFileSync(join(d, "tools", "build_release.ts"), "// builds the release archive\n");
  mkdirSync(join(d, ".claude")); // my-skills links .claude/hooks to software-factory/hooks
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  commit(d, "my-skills");
  return d;
}

test("update and rollback refuse inside the factorys own repo and change nothing", async () => {
  const [gh, , env] = await world("1.0.0");
  const d = factoryRepoCopy();
  const before = snapshot(d);
  for (const args of [["update"], ["update", "v1.0.0"], ["update", "--release"], ["update", "--layout", "new"], ["rollback"]]) {
    const [rc, out] = await runFactory(d, env, ...args);
    expect(rc === 1 && out.includes("[factory_repo]") && out.includes("Fix:"), args.join(" ") + out).toBe(true);
    expect(out.includes("software-factory/") && out.includes("release"), out).toBe(true);
  }
  expect(snapshot(d)).toEqual(before);
  expect(git(d, "status", "--porcelain")).toBe("");
  expect(gh.hits).toEqual([]);
  expect(existsSync(join(d, PIN))).toBe(false);
});

test("the release client refuses directly in the factorys own repo even in an agent session", async () => {
  const [gh, , env] = await world("1.0.0");
  const d = factoryRepoCopy();
  for (const cmd of ["update", "rollback"]) {
    const [rc, out] = await fac(d, { ...env, FACTORY_AGENT: "haile" }, cmd);
    expect(rc === 1 && out.includes("[factory_repo]"), cmd + out).toBe(true);
  }
  expect(git(d, "status", "--porcelain")).toBe("");
  expect(gh.hits).toEqual([]);
});

test("an ordinary project is not taken for the factorys repo", async () => {
  const [, , env] = await world("1.0.0");
  const d = projectWithFactory();
  let [rc, out] = await runFactory(d, env, "update");
  expect(!out.includes("[factory_repo]") && out.includes("no my-skills submodule in .gitmodules"), out).toBe(true);
  // a project that only has one of the two marker files is an ordinary project too
  mkdirSync(join(d, "tools"));
  writeFileSync(join(d, "tools", "build_release.ts"), "x\n");
  [rc, out] = await runFactory(d, env, "update");
  expect(out).not.toContain("[factory_repo]");
  const [, d2, env2] = await world("1.0.0");
  [rc, out] = await fac(d2, env2, "update");
  expect(rc === 0 && !out.includes("[factory_repo]"), out).toBe(true);
});

test("the factory command runs version releases update and rollback and lists them in help", async () => {
  const [, , env] = await world("1.0.0", "1.1.0");
  const d = projectWithFactory();
  let [rc, out] = await runFactory(d, env, "help");
  for (const c of ["version", "releases", "update [version]", "rollback"]) expect(out).toContain(c);
  [rc, out] = await runFactory(d, env, "update", "--release"); // no pin yet: --release asks for the release client
  expect(rc === 0 && pin(d).tag === "v1.1.0", out).toBe(true);
  commit(d);
  expect((await runFactory(d, env, "update", "v1.0.0"))[0]).toBe(0);
  commit(d);
  [rc, out] = await runFactory(d, env, "rollback");
  expect(rc === 0 && pin(d).tag === "v1.1.0", out).toBe(true);
  expect((await runFactory(d, env, "version"))[1]).toContain("v1.1.0");
  expect((await runFactory(d, env, "releases"))[1]).toContain("v1.0.0");
  commit(d);
  [rc, out] = await runFactory(d, env, "update"); // a pin exists: plain update is the release client
  expect(rc === 0 && out.includes("already"), out).toBe(true);
});

// --- small pieces ---------------------------------------------------------------------------------------------------

test("versions sort as semantic versions and the checksum file is read strictly", () => {
  const tags = ["v1.10.0", "v1.2.0", "v1.2.0-rc.1", "v2.0.0", "v1.9.9"];
  expect([...tags].sort(m.compareTags)).toEqual(["v1.2.0-rc.1", "v1.2.0", "v1.9.9", "v1.10.0", "v2.0.0"]);
  expect(m.normalizeTag("1.4.0")).toBe("v1.4.0");
  expect(m.normalizeTag("v1.4.0")).toBe("v1.4.0");
  for (const bad of ["latest", "v1.4", "1.4.0; rm -rf /", "../v1.4.0"]) {
    let err: unknown = null;
    try {
      m.normalizeTag(bad);
    } catch (e) {
      err = e;
    }
    expect(err instanceof m.FactoryError && err.code === "bad_version" && Boolean(err.fix), bad).toBe(true);
  }
  const h = "a".repeat(64);
  expect(m.checksumFor(`${h}  software-factory-1.0.0.tar.gz\n${"b".repeat(64)} *other\n`, "software-factory-1.0.0.tar.gz")).toBe(h);
  for (const text of ["", "nothing here\n", `${h}  other.tar.gz\n`, "xyz  software-factory-1.0.0.tar.gz\n"]) {
    let err: unknown = null;
    try {
      m.checksumFor(text, "software-factory-1.0.0.tar.gz");
    } catch (e) {
      err = e;
    }
    expect(err instanceof m.FactoryError && ["bad_checksum", "incomplete_release"].includes(err.code), text).toBe(true);
  }
});

// --- against this repo's own tree --------------------------------------------------------------------------------

test("a release built from this repo installs into a project and passes the verification", async () => {
  const src = tmp();
  cpSync(join(ROOT, "software-factory"), join(src, "software-factory"), {
    recursive: true, verbatimSymlinks: true,
    filter: (p) => !p.includes("__pycache__") && !p.endsWith(".pyc") && !p.includes("node_modules"),
  });
  git(src, "init", "-q", "-b", "main");
  git(src, "add", "-A", "-f");
  git(src, "commit", "-q", "-m", "snapshot");
  const outDir = tmp();
  const built = build(src, outDir, null);
  const tag = "v" + built.version;
  const [gh, d, env] = await world();
  gh.assets[tag] = Object.fromEntries(readdirSync(outDir).map((n) => [n, new Uint8Array(readFileSync(join(outDir, n)))]));
  gh.releases.unshift({ tag, date: "2026-11-01T10:00:00Z", body: "- real tree (abcdef0)\n", pre: false });
  let [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  for (const rel of [".claude/hooks/factory_release.ts", ".claude/hooks/factory_stack.ts", ".claude/ci/ci.sh", ".claude/ci/entrypoint.sh",
    ".claude/factory/settings.json", ".claude/agents/reviewer.md", ".claude/skills/next-task/SKILL.md", "factory", "factory-loop.sh"]) {
    expect(existsSync(join(d, rel)) && !lstatSync(join(d, rel)).isSymbolicLink(), rel).toBe(true);
  }
  expect(executable(join(d, "factory")) && executable(join(d, ".claude/ci/ci.sh"))).toBe(true);
  [rc, out] = await spawn(["bash", join(d, "factory"), "help"], d, env);
  expect(rc === 0 && out.includes("rollback"), out).toBe(true);
  [rc, out] = await spawn(["bash", join(d, "factory"), "version"], d, env);
  expect(rc === 0 && out.includes(tag), out).toBe(true);
  commit(d);
  expect((await fac(d, env, "update"))[0]).toBe(0);
  expect((await fac(d, env, "version"))[1]).not.toContain("differ");
});

async function onlyAPrerelease(): Promise<[FakeGitHub, string, Env]> {
  const [gh, d, env] = await world();
  gh.add("0.1.0-alpha.1", { pre: true });
  return [gh, d, env];
}

test("with only a prerelease update names it in the fix", async () => {
  const [, d, env] = await onlyAPrerelease();
  const [rc, out] = await fac(d, env, "update");
  expect(rc !== 0 && out.includes("no_releases"), out).toBe(true);
  expect(out, "the exact command that works").toContain("factory update v0.1.0-alpha.1");
  expect((await fac(d, env, "update", "v0.1.0-alpha.1"))[0], "and it does").toBe(0);
});

test("with no release at all the fix still says to ask the owner", async () => {
  const [, d, env] = await world();
  const [rc, out] = await fac(d, env, "update");
  expect(rc !== 0 && out.includes("no_releases") && out.includes("ask the owner") && !out.includes("v0"), out).toBe(true);
});

test("version shows the prerelease when there is no full release", async () => {
  const [, d, env] = await onlyAPrerelease();
  let [rc, out] = await fac(d, env, "version");
  for (const need of ["pre-release", "v0.1.0-alpha.1", "factory update v0.1.0-alpha.1"]) expect(out).toContain(need);
  expect(rc).toBe(0);
  [rc, out] = await fac(d, env, "version", "--json");
  expect(((JSON.parse(out) as Record<string, Record<string, unknown>>).prerelease as Record<string, unknown>).tag, out).toBe("v0.1.0-alpha.1");
});

test("version mentions a prerelease newer than the newest full release", async () => {
  const [gh, d, env] = await world("1.0.0");
  gh.add("1.1.0-rc.1", { pre: true });
  const [, out] = await fac(d, env, "version");
  for (const need of ["Newest     v1.0.0", "v1.1.0-rc.1", "Pre-release"]) expect(out).toContain(need);
});

const commands = (d: string): Record<string, string> => json(join(d, ".claude/factory.json")).commands as Record<string, string>;

test("a first release install in a python project gets the python workflow and commands", async () => {
  const [gh, d, env] = await stackWorld({ "tests/test_a.py": UNITTEST_TESTS });
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc, out).toBe(0);
  expect(read(join(d, ".github/workflows/ci.yml"))).toContain("python template");
  expect(existsSync(join(d, ".github/workflows/ci-python.yml.template"))).toBe(false);
  const c = commands(d);
  expect(c.test === "python3 -m unittest discover -s tests" && !c.install && !c.build, JSON.stringify(c)).toBe(true);
  expect(out).toContain("Stack: Python");
  // later updates leave the project's workflow and commands alone
  appendFileSync(join(d, ".github/workflows/ci.yml"), "# mine\n");
  commit(d);
  gh.add("1.1.0");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  expect(read(join(d, ".github/workflows/ci.yml")).endsWith("# mine\n")).toBe(true);
  expect(commands(d).test).toBe("python3 -m unittest discover -s tests");
});

// #249: the first install sets commands.test from detection, and an unattended agent must be able to run it (alone or
// through ./factory run-check) without a prompt: the rules go to permissions.allow in factory.json, so every later
// `factory update` merges them into settings.json too.
test("a first release install in a python project allows the detected test command for unattended agents", async () => {
  const [gh, d, env] = await stackWorld({ "tests/test_a.py": UNITTEST_TESTS });
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc, out).toBe(0);
  const want = ["Bash(python3 -m unittest*)", "Bash(./factory run-check*)"];
  const own = (json(join(d, ".claude/factory.json")).permissions as Record<string, unknown>).allow as string[];
  expect(own).toEqual(want);
  for (const rule of want) expect(settingsAllow(d)).toContain(rule);
  expect(out).toContain("Bash(python3 -m unittest*)");
  commit(d);
  expect((await fac(d, env, "version"))[1], "the merged rules are not drift").toContain("the files match the pin");
  gh.add("1.1.0");
  expect((await fac(d, env, "update"))[0]).toBe(0);
  for (const rule of want) expect(settingsAllow(d), "a later release keeps them").toContain(rule);
});

test("a first release install in a node project adds no allow rule", async () => {
  const [, d, env] = await stackWorld({ "package.json": "{}\n" });
  expect((await fac(d, env, "update", "v1.0.0"))[0]).toBe(0);
  expect(json(join(d, ".claude/factory.json")).permissions).toBeUndefined();
});

test("code in a release is never run by the update", async () => {
  const marker = join(tmp(), "ran");
  const [gh, d, env] = await stackWorld({ "tests/test_a.py": UNITTEST_TESTS });
  const evil = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n` +
    `export function detect(): unknown { writeFileSync(${JSON.stringify(marker)}, "x"); return {}; }\n`;
  gh.add("1.0.1", { files: { "kit/.github/workflows/ci.yml": "name: CI\n# pnpm template\n",
    "kit/.github/workflows/ci-python.yml.template": "name: CI\n# python template\n", "hooks/factory_stack.ts": evil } });
  const [rc, out] = await fac(d, env, "update", "v1.0.1");
  expect(rc, out).toBe(0);
  expect(existsSync(marker), "the release's own factory_stack.ts ran during the update").toBe(false);
  expect(read(join(d, ".github/workflows/ci.yml"))).toContain("python template"); // the client's own detector decided
});

test("a first release install in a node project is unchanged", async () => {
  const [, d, env] = await stackWorld({ "package.json": "{}\n", "tests/test_a.py": UNITTEST_TESTS });
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc, out).toBe(0);
  expect(read(join(d, ".github/workflows/ci.yml"))).toContain("pnpm template");
  expect(commands(d).test).toBe("pnpm -s test");
  expect(out).not.toContain("Stack:");
});

test("a first release install in an unknown stack keeps pnpm and says what to edit", async () => {
  const [, d, env] = await stackWorld({ "main.c": "int main(){}\n" });
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc === 0 && read(join(d, ".github/workflows/ci.yml")).includes("pnpm template"), out).toBe(true);
  expect(out.includes("could not tell") && out.includes(".github/workflows/ci.yml"), out).toBe(true);
});

test("a first release install never overwrites an existing workflow or factory json", async () => {
  const [, d, env] = await stackWorld({ "tests/test_a.py": UNITTEST_TESTS, ".github/workflows/ci.yml": "name: mine\n",
    ".claude/factory.json": '{"commands": {"test": "make test"}}\n' });
  const [rc, out] = await fac(d, env, "update", "v1.0.0");
  expect(rc, out).toBe(0);
  expect(read(join(d, ".github/workflows/ci.yml"))).toBe("name: mine\n");
  expect(commands(d).test).toBe("make test");
});
