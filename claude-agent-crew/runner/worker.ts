import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { UsageMetrics } from "./types.ts";
import { CrewCliError } from "./types.ts";
import { parseDurationMs } from "./store.ts";

function crewRootDir(): string {
  return resolve(dirname(import.meta.path), "..");
}

export function readWorkerSettings(repoRoot: string, worker = "agy"): string {
  const crewRoot = crewRootDir();
  if (worker === "claude") {
    const candidates = [
      join(repoRoot, ".claude", "settings.worker.claude.json"),
      join(crewRoot, "workers", "claude", "settings.worker.json"),
    ];
    for (const path of candidates) {
      if (existsSync(path)) return readFileSync(path, "utf8").trim();
    }
    throw new CrewCliError(
      "WORKER_SETTINGS_MISSING",
      "No settings file for the claude worker was found.",
      `Restore ${join(crewRoot, "workers", "claude", "settings.worker.json")}.`,
    );
  }
  const candidates = [
    join(repoRoot, ".claude", "settings.worker.json"),
    join(repoRoot, "claude-agent-crew", "workers", "agy", "settings.worker.json"),
    join(repoRoot, "claude-agent-crew", "workers", "agy", "plugin", "settings.worker.json"),
    join(repoRoot, "claude-agent-crew", "settings.worker.json"),
    join(crewRoot, "workers", "agy", "settings.worker.json"),
    join(crewRoot, "workers", "agy", "plugin", "settings.worker.json"),
    join(crewRoot, "settings.worker.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
  }
  return "{}";
}

/** The crew rules every worker gets (the agy plugin's rules file, shared with the claude worker). */
export function readCrewRules(): string {
  const path = join(crewRootDir(), "workers", "agy", "plugin", "rules", "AGENTS.md");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

export function crewRootForWorkers(): string {
  return crewRootDir();
}

/** Arguments for `claude`. The brief goes on stdin, so a brief starting with "-" is never read as a flag. */
export function buildClaudeArgs(opts: {
  model: string | null;
  settingsJson: string;
  rulesText: string;
  readOnly: boolean;
  sessionId: string;
  resume: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
}): string[] {
  const args = ["-p", "--output-format", "json", "--settings", opts.settingsJson];
  if (opts.model) args.push("--model", opts.model);
  if (opts.rulesText) args.push("--append-system-prompt", opts.rulesText);
  if (opts.readOnly) args.push("--disallowedTools", "Edit", "Write", "NotebookEdit");
  if (opts.maxTurns !== undefined) args.push("--max-turns", String(opts.maxTurns));
  if (opts.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.resume) {
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
  }
  return args;
}

/** A worker timeout such as "30m", "90s" or "2h" in milliseconds; "0" means no limit (null). */
export function workerTimeoutMs(text: string): number | null {
  const ms = parseDurationMs(text);
  if (ms === null) {
    throw new CrewCliError(
      "INVALID_TIMEOUT",
      `Cannot read timeout "${text}".`,
      "Use a value like 30m, 90s, 2h, or 0 for no limit.",
    );
  }
  return ms === 0 ? null : ms;
}

/** Reads `claude -p --output-format json`: one JSON object with type "result". */
export function parseClaudeOutput(
  stdoutText: string,
  stderrText: string,
  exitCode: number | null,
  timedOut: boolean,
  sessionId: string,
): ParsedWorkerOutput {
  let result: Record<string, unknown> | null = null;
  const lines = stdoutText.trim().split("\n").reverse();
  for (const line of [stdoutText.trim(), ...lines]) {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && (value as Record<string, unknown>).type === "result") {
        result = value as Record<string, unknown>;
        break;
      }
    } catch {
      // not JSON; keep looking
    }
  }
  if (!result) {
    return {
      conversationId: sessionId,
      resultText: timedOut ? "" : stderrText.trim().slice(-2000),
      usage: null,
      isError: true,
      timedOut,
      validJson: false,
    };
  }
  const usage: UsageMetrics = {};
  const rawUsage = result.usage;
  if (typeof rawUsage === "object" && rawUsage !== null) {
    for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
      const v = (rawUsage as Record<string, unknown>)[key];
      if (typeof v === "number") usage[key] = v;
    }
  }
  if (typeof result.total_cost_usd === "number") usage.total_cost_usd = result.total_cost_usd;
  const text = typeof result.result === "string" ? result.result : "";
  const session = typeof result.session_id === "string" && result.session_id ? result.session_id : sessionId;
  return {
    conversationId: session,
    resultText: text,
    usage: Object.keys(usage).length > 0 ? usage : null,
    isError: result.is_error === true || (exitCode !== null && exitCode !== 0),
    timedOut,
    validJson: true,
  };
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
  if (worker === "agy" || worker === "claude") return;
  throw new CrewCliError(
    "UNKNOWN_WORKER",
    `Unknown worker "${worker}" for role "${role}".`,
    `Set "worker" to "agy" or "claude" in .claude/crew.json.`,
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

  // The runner inside the repo (my-skills itself), else the skill installed for that user.
  const runner =
    'R=claude-agent-crew/runner/crew.ts && { [ -f "$R" ] || R="$HOME/.claude/skills/claude-agent-crew/runner/crew.ts"; }';
  // ssh runs a non-interactive shell, which often lacks the default install folders of bun and agy on PATH.
  const path = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"';
  const remoteCmd = `${path} && cd ${shellQuote(opts.remotePath)} && ${runner} && bun "$R" ${opts.crewArgs.map(shellQuote).join(" ")}`;
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

function canonical(path: string): string {
  // macOS: /var is a symlink to /private/var, and git prints the real path, so compare real paths.
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export function toRemoteBriefPath(repoRoot: string, briefFile: string, remotePath?: string): string {
  const abs = canonical(briefFile);
  if (remotePath) {
    const remoteRel = relative(canonical(remotePath), abs);
    if (remoteRel !== ".." && !remoteRel.startsWith(`..${sep}`) && !isAbsolute(remoteRel)) {
      return remoteRel || ".";
    }
  }
  const rel = relative(canonical(repoRoot), abs);
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

const AGY_PAYLOAD_KEYS = [
  "conversation_id",
  "conversationId",
  "session_id",
  "sessionId",
  "result",
  "response",
  "text",
  "output",
  "subtype",
  "timed_out",
  "timedOut",
  "is_error",
  "isError",
  "usage",
];

function isAgyPayloadObject(obj: Record<string, unknown>): boolean {
  return AGY_PAYLOAD_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function extractLastJsonObject(text: string): Record<string, unknown> | null {
  let lastAny: Record<string, unknown> | null = null;
  let lastPayload: Record<string, unknown> | null = null;
  let i = 0;
  let failedAttempts = 0;
  const maxFailedAttempts = 2000;

  while (i < text.length && failedAttempts < maxFailedAttempts) {
    const start = text.indexOf("{", i);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let matchedEnd = -1;

    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          matchedEnd = j;
          break;
        }
      }
    }

    if (matchedEnd !== -1) {
      try {
        const candidate: unknown = JSON.parse(text.slice(start, matchedEnd + 1));
        if (isRecord(candidate)) {
          lastAny = candidate;
          if (isAgyPayloadObject(candidate)) {
            lastPayload = candidate;
          }
          i = matchedEnd + 1;
          continue;
        }
      } catch {
        // Not valid JSON; advance past this '{'
      }
    }
    failedAttempts++;
    i = start + 1;
  }

  return lastPayload ?? lastAny;
}

const STDERR_TIMEOUT_PATTERN = /timed?\s*out/i;

export function parseAgyOutput(
  stdoutText: string,
  stderrText = "",
  exitCode: number | null = null,
): ParsedWorkerOutput {
  // A "timed out" line on stderr only counts when the worker also failed: a successful run
  // can log "request timed out, retrying" and still finish its job.
  const stderrTimedOut = exitCode !== null && exitCode !== 0 && STDERR_TIMEOUT_PATTERN.test(stderrText);
  const trimmed = stdoutText.trim();
  if (!trimmed) {
    return {
      conversationId: null,
      resultText: "",
      usage: null,
      isError: false,
      timedOut: stderrTimedOut,
      validJson: false,
    };
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Handle diagnostic lines around single-line or pretty-printed multi-line JSON
    parsed = extractLastJsonObject(trimmed);
  }

  if (!isRecord(parsed)) {
    return {
      conversationId: null,
      resultText: trimmed,
      usage: null,
      isError: false,
      timedOut: stderrTimedOut,
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

/**
 * The environment for a `claude -p` job. A long-lived token from `claude setup-token`, saved by the human in
 * `~/.config/crew/claude-oauth-token` (mode 600), is passed as CLAUDE_CODE_OAUTH_TOKEN unless the environment already
 * has one. The token is never printed or logged.
 */
export function claudeJobEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    const file = join(base.HOME ?? homedir(), ".config", "crew", "claude-oauth-token");
    if (existsSync(file)) {
      const token = readFileSync(file, "utf8").trim();
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
  }
  return env;
}
