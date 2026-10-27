// A headless loop run in a folder Claude Code does not trust stops with a plain {code, message, fix} before claude
// starts, instead of spending tokens on a run that ignores the allow list (#193). A fake ~/.claude.json is only read.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { calls, type Env, loopProject } from "./loop_support.ts";
import { HOOKS, type Proc, sh } from "./support.ts";

function claudeJson(home: string, trusted: string[] = [], untrusted: string[] = []): string {
  const projects: Record<string, unknown> = {};
  for (const p of trusted) projects[realpathSync(p)] = { hasTrustDialogAccepted: true };
  for (const p of untrusted) projects[realpathSync(p)] = { hasTrustDialogAccepted: false, allowedTools: ["secret-token-xyz"] };
  const path = join(home, ".claude.json");
  writeFileSync(path, JSON.stringify({ projects, oauthAccount: { emailAddress: "secret@example.com" } }));
  return path;
}

function loop(trusted: boolean): [Proc, string, Env] {
  const [work, env] = loopProject();
  for (const name of ["factory_trust.ts", "factory_roles.ts", "factory_config.ts", "factory_models.ts"]) {
    copyFileSync(join(HOOKS, name), join(work, ".claude", "hooks", name));
  }
  const home = join(dirname(work), "home");
  env.HOME = home;
  mkdirSync(home);
  claudeJson(home, trusted ? [work] : [], trusted ? [] : [work]);
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env, timeoutMs: 60_000 });
  return [p, work, env];
}

test("a headless run in an untrusted folder stops with a plain error before claude starts", () => {
  const [p, work, env] = loop(false);
  expect(p.code, p.out).not.toBe(0);
  expect(existsSync(env.CLAUDE_LOG as string), "claude must not be started").toBe(false);
  const line = [...p.stdout.split("\n"), ...p.stderr.split("\n")].find((l) => l.includes("folder_not_trusted")) as string;
  expect(line, p.out).toBeDefined();
  const err = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, string>;
  expect(Object.keys(err).sort()).toEqual(["code", "fix", "message"]);
  expect(err.fix).toContain(realpathSync(work));
  expect(p.out).not.toContain("secret");
});

test("a headless run in a trusted folder starts as before", () => {
  const [p, , env] = loop(true);
  expect(p.code, p.out).toBe(0);
  expect(calls(env).length).toBe(1);
});
