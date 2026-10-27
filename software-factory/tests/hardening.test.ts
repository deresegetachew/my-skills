// Smaller fixes from the 22 Oct security audit: blocking ends a claim, env keys and agent names are checked, the
// stop hook never signals a guessed process.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeAgent } from "../hooks/factory_config.ts";
import { agentEnv } from "../hooks/factory_env.ts";
import { Exit } from "../hooks/factory_lib.ts";
import { isClaude } from "../hooks/factory_session.ts";
import { issue, labels, loadDb, run, saveDb, setup } from "./issues_support.ts";
import { runHook, sh, tmp, write } from "./support.ts";
import type { Config } from "../hooks/factory_config.ts";

test("a block ends the old claim so a later claim wins", () => {
  const [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:menelik"])]);
  let state = loadDb(db);
  state.comments = { 1: [{ body: "<!-- factory-claim agent=menelik -->", at: 0 }] };
  saveDb(db, state);
  run(d, env, "block", "1", "waits for #2");
  state = loadDb(db); // the owner unblocks by hand: labels only
  (state.issues[0] as { labels: { name: string }[] }).labels = [{ name: "factory:ready" }];
  saveDb(db, state);
  expect(run(d, env, "pick", "--agent", "taytu")[1]).toBe("issue-1 Task 1");
  expect(labels(db, 1)).toEqual(["agent:taytu", "factory:in-progress"]);
});

test("an env key that is not a plain name is refused", () => {
  const d = tmp();
  sh(["git", "init", "-q", d]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agentEnv: { "X=1; touch pwned #": "v" } }));
  const p = runHook("factory_env", [], { cwd: d });
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("valid variable name");
  expect(existsSync(join(d, "pwned"))).toBe(false);
});

test("an agent name that could be a path is refused", () => {
  expect(safeAgent("taytu")).toBe("taytu");
  for (const bad of ["../x", "a/b", "Taytu", "", "x".repeat(41)]) expect(() => safeAgent(bad), bad).toThrow(Exit);
});

test("only claude itself counts as claude", () => {
  expect(isClaude("claude --remote-control=taytu /next-task 3")).toBe(true);
  expect(isClaude("/usr/local/bin/claude")).toBe(true);
  expect(isClaude("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(true);
  expect(isClaude("bash /home/claude/project/factory-loop.sh -i")).toBe(false);
  expect(isClaude("python3 /home/claude/x.py")).toBe(false);
});

test("agent env refuses bad keys for every caller", () => {
  expect(agentEnv({ agentEnv: { PORT: "{port:4100}" } } as unknown as Config, 2).PORT).toBe("4110");
  expect(() => agentEnv({ agentEnv: { "X;rm -rf ~": "v" } } as unknown as Config, 1)).toThrow(Exit);
});

test("release takes the blocked label off", () => {
  const [d, db, env] = setup([issue(1, ["factory:blocked"])]);
  run(d, env, "release", "1", "unblocked");
  expect(labels(db, 1)).toEqual(["factory:ready"]);
});
