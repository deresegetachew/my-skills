import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { UsageMetrics } from "./types.ts";
import { CrewCliError } from "./types.ts";

export function readWorkerSettings(repoRoot: string): string {
  const runnerDir = dirname(import.meta.path);
  const crewRoot = resolve(runnerDir, "..");
  const candidates = [
    join(repoRoot, ".claude", "settings.worker.json"),
    join(repoRoot, "claude-agent-crew", "workers", "agy", "settings.worker.json"),
    join(repoRoot, "claude-agent-crew", "settings.worker.json"),
    join(crewRoot, "workers", "agy", "settings.worker.json"),
    join(crewRoot, "settings.worker.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
  }
  return "{}";
}

export function buildAgyArgs(opts: {
  briefText: string;
  role: string;
  model: string | null;
  printTimeout: string;
  worktree: string;
  settingsJson: string;
  conversationId: string | null;
}): string[] {
  const args = ["-p", opts.briefText, "--agent", opts.role];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push(
    "--output-format",
    "json",
    "--print-timeout",
    opts.printTimeout,
    "--add-dir",
    opts.worktree,
    "--settings",
    opts.settingsJson,
  );
  if (opts.conversationId) {
    args.push("--conversation", opts.conversationId);
  }
  return args;
}

export function assertWorkerSupported(worker: string, role: string): void {
  if (worker === "agy") return;
  if (worker === "claude") {
    throw new CrewCliError(
      "WORKER_NOT_SUPPORTED",
      `Worker "claude" for role "${role}" is not yet supported (T5).`,
      `Change role "${role}" in .claude/crew.json to use worker "agy", or wait for T5.`,
    );
  }
  throw new CrewCliError(
    "UNKNOWN_WORKER",
    `Unknown worker "${worker}" for role "${role}".`,
    `Set "worker" to "agy" in .claude/crew.json.`,
  );
}

export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildSshCrewCommand(opts: {
  sshCommand: string;
  remotePath: string;
  crewArgs: string[];
}): string[] {
  const sshParts = opts.sshCommand.trim().split(/\s+/).filter(Boolean);
  if (sshParts.length === 0) {
    throw new CrewCliError(
      "INVALID_MACHINE",
      "SSH machine command cannot be empty.",
      `Set a valid ssh command (e.g. "ssh user@host") under "machines" in .claude/crew.json.`,
    );
  }

  const crewArgs = ["bun", "claude-agent-crew/runner/crew.ts", ...opts.crewArgs];
  const remoteCmd = `cd ${shellQuote(opts.remotePath)} && ${crewArgs.map(shellQuote).join(" ")}`;
  return [...sshParts, remoteCmd];
}

export function buildSshStartCommand(opts: {
  sshCommand: string;
  remotePath: string;
  role: string;
  briefArg: string;
  branch?: string;
  continueJobId?: string;
  timeout?: string;
}): string[] {
  const crewArgs = [
    "start",
    "--role",
    opts.role,
    "--brief",
    opts.briefArg,
    "--local",
  ];
  if (opts.branch) {
    crewArgs.push("--branch", opts.branch);
  }
  if (opts.continueJobId) {
    crewArgs.push("--continue", opts.continueJobId);
  }
  if (opts.timeout) {
    crewArgs.push("--timeout", opts.timeout);
  }
  return buildSshCrewCommand({
    sshCommand: opts.sshCommand,
    remotePath: opts.remotePath,
    crewArgs,
  });
}

export function toRemoteBriefPath(repoRoot: string, briefFile: string): string {
  const abs = resolve(briefFile);
  const rel = relative(resolve(repoRoot), abs);
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    return rel || ".";
  }
  return briefFile;
}

export interface ParsedWorkerOutput {
  conversationId: string | null;
  resultText: string;
  usage: UsageMetrics | null;
  isError: boolean;
  timedOut: boolean;
  validJson: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractUsage(raw: unknown): UsageMetrics | null {
  if (!isRecord(raw)) return null;
  const out: UsageMetrics = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parseAgyOutput(stdoutText: string, stderrText = ""): ParsedWorkerOutput {
  const trimmed = stdoutText.trim();
  if (!trimmed) {
    const timedOut = /timed?\s*out/i.test(stderrText);
    return {
      conversationId: null,
      resultText: "",
      usage: null,
      isError: false,
      timedOut,
      validJson: false,
    };
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Handle case where diagnostic lines precede or follow a JSON object
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const candidate: unknown = JSON.parse(line);
        if (isRecord(candidate)) {
          parsed = candidate;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!isRecord(parsed)) {
    return {
      conversationId: null,
      resultText: trimmed,
      usage: null,
      isError: false,
      timedOut: /timed?\s*out/i.test(stderrText),
      validJson: false,
    };
  }

  const conversationId =
    typeof parsed.conversation_id === "string"
      ? parsed.conversation_id
      : typeof parsed.conversationId === "string"
        ? parsed.conversationId
        : typeof parsed.session_id === "string"
          ? parsed.session_id
          : typeof parsed.sessionId === "string"
            ? parsed.sessionId
            : null;

  const resultText =
    typeof parsed.result === "string"
      ? parsed.result
      : typeof parsed.response === "string"
        ? parsed.response
        : typeof parsed.text === "string"
          ? parsed.text
          : typeof parsed.output === "string"
            ? parsed.output
            : "";

  const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
  const timedOut =
    subtype === "timeout" ||
    subtype === "error_max_turns" ||
    parsed.timed_out === true ||
    parsed.timedOut === true;
  const isError = parsed.is_error === true || parsed.isError === true;
  const usage = extractUsage(parsed.usage);

  return {
    conversationId,
    resultText,
    usage,
    isError,
    timedOut,
    validJson: true,
  };
}
