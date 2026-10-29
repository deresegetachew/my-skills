// Tests never sign (#337): on a machine whose git config signs commits and tags (the owner's Mac), a test that makes a
// commit or an annotated tag must still pass. tools/run_tests.ts gives each test file a git config that turns signing off.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { sh, tmp, write } from "./support.ts";

test("a test makes commits and tags even when the machine's git config signs them", () => {
  const home = tmp();
  // signing that always fails: `false` stands in for gpg
  write(join(home, ".gitconfig"), "[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n\tforceSignAnnotated = true\n" +
    "[gpg]\n\tprogram = false\n");
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const repo = tmp();
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "one"], ["tag", "-a", "v1.0.0", "-m", "v1.0.0"],
    ["tag", "v1.0.1"]]) {
    const p = sh(["git", "-C", repo, ...args], { env });
    expect(p.code, `git ${args.join(" ")}: ${p.out}`).toBe(0);
  }
});
