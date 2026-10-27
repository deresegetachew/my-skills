// `factory migrate-to-release` takes a project off the my-skills submodule links and onto a numbered release (#170).
// The release client runs from the downloaded release (bun <release>/hooks/factory_release.ts), so it works when
// ./factory is itself one of the links.
import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { commit, type Env, fac, type FakeGitHub, git, PIN, world } from "./release_support.ts";
import { readmeAndWiki, SF, sh } from "./support.ts";

const SUB = "vendor/my-skills";

/** A project file that is a link into the submodule, as install.sh --link made it. */
function link(d: string, rel: string, targetInSub: string, content: string): void {
  const src = join(d, SUB, targetInSub);
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, content);
  const dst = join(d, rel);
  mkdirSync(dirname(dst), { recursive: true });
  symlinkSync(relative(dirname(dst), src), dst);
}

async function submoduleProject(...versions: string[]): Promise<[FakeGitHub, string, Env]> {
  const [gh, d, env] = await world(...(versions.length ? versions : ["1.0.0"]));
  writeFileSync(join(d, ".gitmodules"), `[submodule "${SUB}"]\n\tpath = ${SUB}\n\turl = https://github.com/deresegetachew/my-skills.git\n`);
  link(d, "factory", "software-factory/factory", "#!/usr/bin/env bash\necho old\n");
  link(d, ".claude/hooks/factory_x.ts", "software-factory/hooks/factory_x.ts", "export const OLD = 1;\n");
  link(d, ".claude/agents/a.md", "software-factory/kit/.claude/agents/a.md", "old agent\n");
  link(d, ".claude/settings.json", "software-factory/kit/.claude/settings.json", "{}\n");
  link(d, ".claude/skills/nestjs-x/SKILL.md", "nestjs-x/SKILL.md", "not in the release\n");
  writeFileSync(join(d, ".claude", "factory.json"), "{}\n");
  commit(d, "linked to the submodule");
  return [gh, d, env];
}

/** Every path (not .git) with what it is: a link's target or a file's bytes and mode. */
function state(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      if (n === ".git") continue;
      const p = join(dir, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[relative(d, p)] = "link:" + readlinkSync(p);
      else if (st.isDirectory()) walk(p);
      else out[relative(d, p)] = readFileSync(p, "latin1") + ":" + statSync(p).mode.toString(8);
    }
  };
  walk(d);
  return out;
}

const isLink = (p: string): boolean => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

test("it ends on the release keeps the links it does not ship and prints the steps", async () => {
  const [, d, env] = await submoduleProject();
  const [rc, out] = await fac(d, env, "migrate-to-release");
  expect(rc, out).toBe(0);
  for (const rel of ["factory", ".claude/hooks/factory_x.ts", ".claude/agents/a.md", ".claude/factory/settings.json"]) {
    expect(!isLink(join(d, rel)) && statSync(join(d, rel)).isFile(), rel).toBe(true);
  }
  // #258: the link to the kit's old rules file goes (every session would load it); the release's file replaces it
  expect(lstatSync(join(d, ".claude/settings.json"), { throwIfNoEntry: false })).toBeUndefined();
  expect(out).toContain("removed link .claude/settings.json");
  expect(readFileSync(join(d, SUB, "software-factory/kit/.claude/settings.json"), "utf8"), "only the link goes").toBe("{}\n");
  expect(readFileSync(join(d, ".claude/hooks/factory_x.ts"), "utf8")).toContain('VERSION = "1.0.0"');
  expect(isLink(join(d, ".claude/skills/nestjs-x/SKILL.md")), "what the release does not ship stays a link").toBe(true);
  expect((JSON.parse(readFileSync(join(d, PIN), "utf8")) as Record<string, string>).tag).toBe("v1.0.0");
  expect(readFileSync(join(d, SUB, "software-factory/hooks/factory_x.ts"), "utf8"), "the submodule is never written through").toBe("export const OLD = 1;\n");
  expect(out.includes("nestjs-x") && !out.includes("git submodule deinit"), out).toBe(true); // links remain, so the submodule stays
  expect(out.includes("git add -A") && out.includes("pull request"), out).toBe(true);
  const status = git(d, "status", "--porcelain");
  for (const l of status.split("\n").filter(Boolean)) {
    if (l.slice(3) === ".claude/settings.json") expect(l.slice(0, 2).trim(), status).toBe("D"); // the old rules link, removed
    else expect(["M", "T", "A", "??", "AM"], status).toContain(l.slice(0, 2).trim());
  }
  expect(status.includes(".gitmodules") || status.includes(SUB), status).toBe(false);
});

test("when no link is left it prints the commands to drop the submodule and runs none", async () => {
  const [, d, env] = await submoduleProject();
  rmSync(join(d, ".claude/skills/nestjs-x/SKILL.md"));
  commit(d, "no nestjs link");
  const [rc, out] = await fac(d, env, "migrate-to-release");
  expect(rc, out).toBe(0);
  expect(out.includes(`git submodule deinit -f ${SUB}`) && out.includes(`git rm -f ${SUB}`), out).toBe(true);
  expect(statSync(join(d, SUB)).isDirectory() && git(d, "ls-files").includes(".gitmodules"), "it only prints them").toBe(true);
});

test("a dirty tree is refused and nothing changes", async () => {
  const [gh, d, env] = await submoduleProject();
  writeFileSync(join(d, "notes.txt"), "mine\n");
  const before = state(d);
  const [rc, out] = await fac(d, env, "migrate-to-release");
  expect(rc === 1 && out.includes("[dirty_tree]") && out.includes("Fix:"), out).toBe(true);
  expect(state(d)).toEqual(before);
  expect(gh.hits, "nothing changed, nothing downloaded").toEqual([]);
});

test("a failure midway puts every link back", async () => {
  const [, d, env] = await submoduleProject();
  // the release ships ci/ci.sh: a plain file where its folder should be makes the write fail after other files were written
  writeFileSync(join(d, ".claude", "ci"), "in the way\n");
  commit(d, "a file where the ci folder goes");
  const before = state(d);
  const [rc, out] = await fac(d, env, "migrate-to-release");
  expect(rc === 1 && out.includes("[install_failed]"), out).toBe(true);
  expect(state(d), "links and files are as they were").toEqual(before);
  expect(git(d, "status", "--porcelain")).toBe("");
});

test("it is safe to run twice", async () => {
  const [, d, env] = await submoduleProject();
  expect((await fac(d, env, "migrate-to-release"))[0]).toBe(0);
  const after = state(d);
  const [rc, out] = await fac(d, env, "migrate-to-release");
  expect(rc === 0 && out.includes("already on"), out).toBe(true);
  expect(state(d)).toEqual(after);
});

test("a project with no submodule links is told what to use instead", async () => {
  const [, d, env] = await world("1.0.0");
  const before = state(d);
  const [rc, out] = await fac(d, env, "migrate-to-release");
  expect(rc === 1 && out.includes("[nothing_to_migrate]") && out.includes("factory update --release"), out).toBe(true);
  expect(state(d)).toEqual(before);
});

test("it refuses inside the factorys own repo and in an agent session", async () => {
  const [, d, env] = await submoduleProject();
  const [rc, out] = await fac(d, { ...env, FACTORY_AGENT: "taytu" }, "migrate-to-release");
  expect(rc === 1 && out.includes("[agent_session]"), out).toBe(true);
});

test("help and readme list the command", () => {
  const helped = sh(["bash", join(SF, "factory"), "help"]).stdout;
  expect(helped).toContain("migrate-to-release");
  expect(readmeAndWiki()).toContain("| `factory migrate-to-release");
});
