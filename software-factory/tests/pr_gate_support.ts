// The PR gate (pr-gate.ts) run as Claude Code runs a PreToolUse hook (the tool call as JSON on stdin; exit 2 blocks).
// Shared by pr_gate.test.ts, manager_claims.test.ts, lessons.test.ts and rereview.test.ts. Not a test file.
import { join } from "node:path";
import { HOOKS, sh, type ProcOptions } from "./support.ts";

export const GATE = join(HOOKS, "pr-gate.ts");

export type Env = Record<string, string | undefined>;

/** [exit code, stderr] of the gate for `command`, run in `cwd` with `env`. */
export function runGate(cwd: string, env: Env, command: string, opts: ProcOptions = {}): [number, string] {
  const p = sh([process.execPath, "--no-env-file", GATE], { cwd, env, input: JSON.stringify({ tool_input: { command } }), ...opts });
  return [p.code, p.stderr];
}
