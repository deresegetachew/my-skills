// PreToolUse hook for a headless `claude -p` crew worker.
// It reuses the agy guard's command check, so both workers refuse the same commands.
// Claude sends {tool_name, tool_input: {command}}; a refusal is a JSON permissionDecision "deny".
// An allowed command prints nothing, so Claude's own permission rules still apply.
import { checkCommand } from "../agy/plugin/scripts/guard.ts";

const UNREADABLE = "The crew guard could not read this tool call, so it refuses it.";

export interface ClaudeHookDeny {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

function deny(reason: string): ClaudeHookDeny {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Returns a deny object, or null when the call may go ahead. */
export function evaluateClaudeHookInput(rawStdin: string): ClaudeHookDeny | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStdin.trim());
  } catch {
    return deny(UNREADABLE);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return deny(UNREADABLE);
  const record = parsed as Record<string, unknown>;
  if (typeof record.tool_name !== "string") return deny(UNREADABLE);
  if (record.tool_name !== "Bash") return null;
  const input = record.tool_input;
  if (typeof input !== "object" || input === null) return deny(UNREADABLE);
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string") return deny(UNREADABLE);
  try {
    const verdict = checkCommand(command);
    return verdict.decision === "deny" ? deny(verdict.reason) : null;
  } catch {
    return deny(UNREADABLE);
  }
}

if (import.meta.main) {
  let out: ClaudeHookDeny | null;
  try {
    out = evaluateClaudeHookInput(await Bun.stdin.text());
  } catch {
    out = deny(UNREADABLE);
  }
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
