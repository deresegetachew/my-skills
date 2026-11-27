import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const HOOK = resolve(import.meta.dir, "hook.ts");

function runHook(stdin: string): { exitCode: number; stdout: string } {
  const r = Bun.spawnSync([process.execPath, HOOK], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString().trim() };
}

function bash(command: string): string {
  return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
}

function decision(stdout: string): string | undefined {
  const out = JSON.parse(stdout) as {
    hookSpecificOutput?: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  expect(out.hookSpecificOutput?.permissionDecisionReason.length ?? 0).toBeGreaterThan(0);
  return out.hookSpecificOutput?.permissionDecision;
}

describe("claude worker guard hook", () => {
  test("refuses what the agy guard refuses, in Claude's hook format", () => {
    for (const cmd of ["git push origin HEAD:main", "sudo id", "git push --force origin feat/x", "gh pr merge 5"]) {
      const r = runHook(bash(cmd));
      expect(r.exitCode).toBe(0);
      expect(decision(r.stdout)).toBe("deny");
    }
  });

  test("prints nothing for an allowed command, so Claude's own rules still decide", () => {
    for (const cmd of ["git status", "bun test", "git push origin feat/x"]) {
      const r = runHook(bash(cmd));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  test("ignores other tools", () => {
    const r = runHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("refuses a call it cannot read", () => {
    for (const raw of ["", "not json", "[]", JSON.stringify({ tool_name: "Bash" }), JSON.stringify({ tool_name: "Bash", tool_input: { command: 5 } })]) {
      const r = runHook(raw);
      expect(r.exitCode).toBe(0);
      expect(decision(r.stdout)).toBe("deny");
    }
  });
});
