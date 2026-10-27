// `factory agent <name>` with nothing else to do says that the queue runs better in `factory loop -i`, which gives
// each task a fresh context (#56). With a prompt or other arguments it stays quiet.
import { expect, test } from "bun:test";
import { readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, read, SF, sh, tmp, write, writeExe } from "./support.ts";

const HINT = "factory loop -i";

function project(): [string, Record<string, string | undefined>] {
  const d = tmp();
  const work = join(d, "proj");
  const git = (...a: string[]) => sh(["git", ...a], { cwd: work });
  write(join(work, ".claude", "hooks", ".keep"), "");
  git("init", "-q", "-b", "main");
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(work, ".claude", "hooks", f));
  write(join(work, ".claude", "factory", "settings.json"), JSON.stringify({ hooks: {} })); // the agents' rules (#258)
  write(join(work, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"] }));
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start");
  // `factory agent` reads the agents' rules from main on origin, never the folder's copy
  const origin = join(d, "origin.git");
  sh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "HEAD:main");
  const bin = join(d, "bin");
  writeExe(join(bin, "claude"), "#!/bin/sh\necho CLAUDE STARTED\n");
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FACTORY_REMOTE_CONTROL: "0" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"]) delete env[k];
  return [work, env];
}

function agent(...args: string[]) {
  const [work, env] = project();
  return sh(["bash", join(SF, "factory"), "agent", ...args], { cwd: work, env, timeoutMs: 60_000 });
}

test("a bare agent session points at the loop for the queue", () => {
  const p = agent("menelik");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("CLAUDE STARTED");
  const hint = (p.stdout + p.stderr).split("\n").filter((l) => l.includes(HINT));
  expect(hint.length, p.out).toBe(1); // one line, not a lecture
  expect(hint[0]).toContain("fresh");
});

test("an agent session with arguments starts without the hint", () => {
  const p = agent("menelik", "fix the flaky test in packages/x");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("CLAUDE STARTED");
  expect(p.stdout + p.stderr).not.toContain(HINT);
});

test("no name says how to use it and mentions the loop", () => {
  const p = agent();
  expect(p.code).not.toBe(0);
  expect(p.stdout).not.toContain("CLAUDE STARTED");
  expect(p.stderr).toContain("factory agent <name|N>");
  expect(p.stderr).toContain(HINT);
});

test("help keeps each entry together and nothing recommends loop in one session", () => {
  const out = sh(["bash", join(SF, "factory"), "help"], { cwd: project()[0] }).stdout.split("\n");
  for (const [start, follow] of [["  loop [-i] [N]", "which closes by itself"], ["  agent <name|N>", "To run the queue"]] as const) {
    const i = out.findIndex((l) => l.startsWith(start));
    expect(out[i + 1], out.slice(i, i + 3).join("\n")).toContain(follow);
  }
  // The hook's opening comment (the Python docstring before #252).
  const text = read(join(HOOKS, "factory_session.ts"));
  const session = text.slice(0, text.indexOf("\nimport "));
  expect(session).not.toContain("then `/loop /next-task all`");
  expect(session).toContain("factory loop -i");
});
