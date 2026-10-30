// Tests never sign (#337): on a machine whose git config signs commits and tags (the owner's Mac), a test that makes a
// commit or an annotated tag must still pass. tools/run_tests.ts gives each test file a git config that includes the
// machine's own and then turns signing off.
//
// The check runs the runner on this file with a HOME whose .gitconfig signs with a program that always fails; in that
// inner run (GIT_SIGNING_PROBE set) the probe test commits and tags with the machine's config as the runner gives it.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { ROOT, sh, tmp, write } from "./support.ts";

const PROBE = Boolean(process.env.GIT_SIGNING_PROBE);

test("probe: commits and tags under the runner's git config", () => {
  if (!PROBE) return; // runs only inside the runner the next test starts
  const repo = tmp();
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  // the machine's config is still read: its gpg.program comes through
  expect(sh(["git", "config", "--get", "gpg.program"], { env }).stdout.trim()).toBe("false");
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "one"], ["tag", "-a", "v1.0.0", "-m", "v1.0.0"],
    ["tag", "v1.0.1"]]) {
    const p = sh(["git", "-C", repo, ...args], { env });
    expect(p.code, `git ${args.join(" ")}: ${p.out}`).toBe(0);
  }
});

test("a test makes commits and tags even when the machine's git config signs them", () => {
  if (PROBE) return;
  const home = tmp();
  // signing that always fails: `false` stands in for gpg
  write(join(home, ".gitconfig"), "[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n\tforceSignAnnotated = true\n" +
    "[gpg]\n\tprogram = false\n");
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_SIGNING_PROBE: "1",
    BUN_INSTALL_CACHE_DIR: join(home, "bun-cache") };
  delete env.GIT_CONFIG_GLOBAL;
  const p = sh([process.execPath, "--no-env-file", "--config=/dev/null", join(ROOT, "tools", "run_tests.ts"), "git_signing"],
    { cwd: ROOT, env, timeoutMs: 120_000 });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("2 passed, 0 failed");
});
