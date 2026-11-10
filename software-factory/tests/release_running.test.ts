// `factory release <agent>` (#554) refuses an agent that runs: releasing its checkout would make a live loop look down.
// The loop's own exit trap is allowed (it runs the release as its child), --tasks-only is never refused, and a stopped
// agent is released as before. A fake loop is a real process whose command line `ps` shows as factory-loop.sh.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { aLoop, baseEnv, project } from "./claims_support.ts";
import { HOOKS, runHook, tmp, write, writeExe } from "./support.ts";

const DEAD = 2 ** 22 + 12345;

/** claims.json of `clone`: agent's checkout and one task claim, both held by `pid` on this machine. */
function claimsFile(clone: string): string {
  return join(clone, ".git", "factory", "claims.json");
}

function hold(clone: string, agent: string, pid: number): void {
  const mine = { agent, pid, host: hostname(), at: Date.now() / 1000 };
  write(claimsFile(clone), JSON.stringify({ checkouts: { [agent]: { ...mine, path: `${clone}-agents/${agent}`, role: "coding-agent" } },
    tasks: { "7": mine } }, null, 2));
}

const release = (clone: string, ...extra: string[]) =>
  runHook("factory_claims", ["release", "--agent", "taytu", ...extra], { cwd: clone, env: baseEnv() });

test("release of an agent whose loop runs is refused with release_running and changes nothing", () => {
  const clone = project();
  const loop = aLoop();
  try {
    hold(clone, "taytu", loop.pid);
    const before = readFileSync(claimsFile(clone), "utf8");
    const r = release(clone);
    expect(r.code, r.out).toBe(1);
    expect(JSON.parse(r.stderr.trim().split("\n").at(-1) as string)).toEqual({
      code: "release_running",
      message: "taytu is running here; releasing its checkout would make it look down.",
      fix: "Stop it first (factory owner stop taytu), then release.",
    });
    expect(readFileSync(claimsFile(clone), "utf8")).toBe(before);
    const list = runHook("factory_claims", ["list"], { cwd: clone, env: baseEnv() });
    expect(list.stdout).toMatch(/checkout\s+taytu/);
    expect(list.stdout).toMatch(/task\s+7\s+taytu/);
  } finally {
    loop.kill();
  }
});

test("the loop releasing itself (it runs the release as its child, as its exit trap does) is allowed", async () => {
  const clone = project();
  const d = tmp();
  const go = join(d, "go");
  const out = join(d, "out");
  const cmd = [process.execPath, "--no-env-file", "--config=/dev/null", join(HOOKS, "factory_claims.ts"), "release", "--agent", "taytu"]
    .map((w) => `'${w}'`).join(" ");
  const script = writeExe(join(d, "factory-loop.sh"), `#!/bin/sh\nwhile [ ! -e '${go}' ]; do sleep 0.1; done\n${cmd} >'${out}' 2>&1\n`);
  const p = Bun.spawn([script], { cwd: clone, env: baseEnv() as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    hold(clone, "taytu", p.pid);
    writeFileSync(go, "");
    const finished = await Promise.race([p.exited.then(() => true), Bun.sleep(60_000).then(() => false)]);
    expect(finished).toBe(true);
    const said = readFileSync(out, "utf8");
    expect(said).toContain("Released taytu: the checkout");
    const claims = JSON.parse(readFileSync(claimsFile(clone), "utf8")) as { checkouts: object; tasks: object };
    expect(claims.checkouts).toEqual({});
    expect(claims.tasks).toEqual({});
  } finally {
    p.kill(9);
  }
});

test("--tasks-only is never refused: the task claims go and the checkout stays, while the loop runs", () => {
  const clone = project();
  const loop = aLoop();
  try {
    hold(clone, "taytu", loop.pid);
    const r = release(clone, "--tasks-only");
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain("Released taytu: the task claim 7. The checkout stays.");
    const claims = JSON.parse(readFileSync(claimsFile(clone), "utf8")) as { checkouts: Record<string, unknown>; tasks: object };
    expect(Object.keys(claims.checkouts)).toEqual(["taytu"]);
    expect(claims.tasks).toEqual({});
  } finally {
    loop.kill();
  }
});

test("release of a stopped agent (its checkout's pid is dead) releases the checkout and the task claim as before", () => {
  const clone = project();
  hold(clone, "taytu", DEAD);
  const r = release(clone);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("Released taytu: the checkout and the task claim 7.");
  expect(existsSync(claimsFile(clone))).toBe(true);
  const claims = JSON.parse(readFileSync(claimsFile(clone), "utf8")) as { checkouts: object; tasks: object };
  expect(claims.checkouts).toEqual({});
  expect(claims.tasks).toEqual({});
});
