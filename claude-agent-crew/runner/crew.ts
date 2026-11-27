#!/usr/bin/env bun
// Job runner for claude-agent-crew.
// Job-lifecycle design (start/wait/status/result/cancel/list/clean) credited to
// github.com/keli-wen/agy-staff (MIT).

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type CleanResult,
  cleanFinishedWorktrees,
  ensureCrewExcluded,
  getRepoRoot,
  isReadOnlyRole,
  prepareWorktree,
  validateBranchName,
} from "./git.ts";
import {
  appendUsage,
  crewDir,
  ensureCrewDirs,
  generateJobId,
  isValidJobId,
  jobFilePath,
  listJobs,
  logsDir,
  parseDurationMs,
  readCrewConfig,
  readJob,
  writeJob,
} from "./store.ts";
import { CrewCliError, type JobRecord, type JobStatus } from "./types.ts";
import {
  assertWorkerSupported,
  buildAgyArgs,
  buildClaudeArgs,
  claudeJobEnv,
  buildSshCrewCommand,
  buildSshStartCommand,
  crewRootForWorkers,
  parseAgyOutput,
  parseClaudeOutput,
  readCrewRules,
  readWorkerSettings,
  shellQuote,
  toRemoteBriefPath,
  workerTimeoutMs,
} from "./worker.ts";

// How to call this runner again: relative inside the repo that holds it (my-skills), else its absolute path
// (a project using the installed skill).
const RUNNER_REL = relative(process.cwd(), import.meta.path);
const RUNNER_CMD = `bun ${
  RUNNER_REL && !RUNNER_REL.startsWith("..") && !isAbsolute(RUNNER_REL) && /^[A-Za-z0-9_./-]+$/.test(RUNNER_REL)
    ? RUNNER_REL
    : shellQuote(import.meta.path)
}`;

/** A remote runner prints its own path in "Next:" lines; the orchestrator must see this machine's runner. */
function localizeNext(remoteOut: string): string {
  return remoteOut.replace(/^Next: bun (?:'(?:[^']|'\\'')*'|\S+) /gm, `Next: ${RUNNER_CMD} `);
}

interface ProcEntry {
  pid: number;
  pgid: number;
  stat: string;
  args: string;
}

function listProcesses(): ProcEntry[] | null {
  const res = Bun.spawnSync(["ps", "-ww", "-eo", "pid=,pgid=,stat=,args="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return null;
  const entries: ProcEntry[] = [];
  for (const line of res.stdout.toString().split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      stat: match[3] ?? "",
      args: match[4] ?? "",
    });
  }
  return entries;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function hasLiveProcessInPgid(pgid: number): boolean {
  const entries = listProcesses();
  if (entries !== null) {
    return entries.some((e) => e.pgid === pgid && !e.stat.startsWith("Z"));
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function inspectJobPgid(pid: number, jobId: string): "alive" | "mismatch" | "exited" {
  const entries = listProcesses();
  if (entries === null) {
    return isPidAlive(pid) ? "alive" : "exited";
  }
  const leader = entries.find((e) => e.pid === pid);
  const liveInGroup = entries.some((e) => e.pgid === pid && !e.stat.startsWith("Z"));
  if (leader) {
    if (!leader.stat.startsWith("Z")) {
      return leader.args.includes(jobId) ? "alive" : "mismatch";
    }
    return liveInGroup ? "alive" : "exited";
  }
  return liveInGroup ? "alive" : "exited";
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** How long a `running` job may go without `_exec` recording its pid before it counts as never started. */
function pidGraceMs(): number {
  return envMs("CREW_PID_GRACE_MS", 30_000);
}

function syncJobLiveness(repoRoot: string, job: JobRecord): JobRecord {
  if (job.status === "running" && job.pid === null && job.remotePath === null) {
    const age = Date.now() - Date.parse(job.start);
    if (!(age > pidGraceMs())) return job;
    const fresh = readJob(repoRoot, job.id);
    if (fresh && (fresh.status !== "running" || fresh.pid !== null)) return syncJobLiveness(repoRoot, fresh);
    const stuck: JobRecord = {
      ...(fresh ?? job),
      status: "error",
      end: new Date().toISOString(),
      exit: 1,
      error: {
        code: "EXEC_START_FAILED",
        message: `Job "${job.id}" never recorded a pid: its supervisor did not start (start was interrupted).`,
        fix: `Run \`${RUNNER_CMD} start\` again; \`${RUNNER_CMD} clean\` can then release its worktree.`,
      },
    };
    writeJob(repoRoot, stuck);
    return stuck;
  }
  if (job.status !== "running" || job.pid === null || job.remotePath !== null) return job;
  if (inspectJobPgid(job.pid, job.id) === "alive") return job;
  const fresh = readJob(repoRoot, job.id);
  if (fresh && fresh.status !== "running") return fresh;

  const updated: JobRecord = {
    ...(fresh ?? job),
    status: "error",
    end: new Date().toISOString(),
    exit: 1,
    error: {
      code: "WORKER_CRASHED",
      message: `Job "${job.id}" process (pid ${job.pid}) exited unexpectedly without recording a result.`,
      fix: `Check the job log at ${job.logFile}.`,
    },
  };
  writeJob(repoRoot, updated);
  return updated;
}

function exitCodeForStatus(status: JobStatus): number {
  switch (status) {
    case "done":
      return 0;
    case "running":
      return 2;
    case "error":
      return 3;
    case "canceled":
      return 4;
    case "attention":
      return 5;
  }
}

interface ParseSpec {
  booleanFlags?: string[];
  valueFlags?: string[];
  maxPositionals?: number;
  usage: string;
}

function parseFlags(
  args: string[],
  spec: ParseSpec,
): { positionals: string[]; flags: Map<string, string | boolean>; help: boolean } {
  const booleanSet = new Set(spec.booleanFlags ?? []);
  const valueSet = new Set(spec.valueFlags ?? []);
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new CrewCliError(
        "UNKNOWN_FLAG",
        `Unknown flag "${arg}".`,
        spec.usage,
      );
    }
    const key = arg.slice(2);
    if (booleanSet.has(key)) {
      flags.set(key, true);
      continue;
    }
    if (!valueSet.has(key)) {
      throw new CrewCliError(
        "UNKNOWN_FLAG",
        `Unknown flag "--${key}".`,
        spec.usage,
      );
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new CrewCliError(
        "MISSING_FLAG_VALUE",
        `Flag "--${key}" requires a value.`,
        `Pass a value after "--${key}".`,
      );
    }
    flags.set(key, next);
    i++;
  }

  if (!help && spec.maxPositionals !== undefined && positionals.length > spec.maxPositionals) {
    throw new CrewCliError(
      "UNEXPECTED_ARGUMENT",
      `Unexpected argument "${positionals[spec.maxPositionals]}".`,
      spec.usage,
    );
  }

  return { positionals, flags, help };
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function formatContinueCmd(job: JobRecord): string {
  const safeArg = (v: string): string =>
    /^[a-zA-Z0-9_./:@%+=,-]+$/.test(v) ? v : shellQuote(v);
  return `${RUNNER_CMD} start --role ${safeArg(job.role)} --brief ${shellQuote(job.briefFile)} --continue ${safeArg(job.id)}`;
}

/**
 * Lock owner file content is "<pid>-<token>". A lock is stale when its owner pid is dead, or, for a lock
 * with no owner file at all (written by an older runner), when its directory is older than 10 s.
 * A live owner is never stolen, however long `git worktree add` takes.
 */
function readLockOwner(lockDir: string): string | null {
  try {
    return readFileSync(join(lockDir, "owner"), "utf8");
  } catch {
    return null;
  }
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (owner !== null && owner.trim() !== "") {
    const pid = Number(owner.split("-", 1)[0]);
    return !(Number.isInteger(pid) && pid > 0 && isPidAlive(pid));
  }
  try {
    return Date.now() - statSync(lockDir).mtimeMs > 10_000;
  } catch {
    return false;
  }
}

function reclaimStaleLock(lockDir: string, reclaimLock: string): boolean {
  if (!isLockStale(lockDir)) return false;
  const seen = readLockOwner(lockDir);
  let held = false;
  try {
    mkdirSync(reclaimLock);
    held = true;
    if (isLockStale(lockDir) && readLockOwner(lockDir) === seen) {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    try {
      if (Date.now() - statSync(reclaimLock).mtimeMs > 10_000) {
        rmSync(reclaimLock, { recursive: true, force: true });
      }
    } catch {
      // reclaim lock already released
    }
    return false;
  } finally {
    if (held) rmSync(reclaimLock, { recursive: true, force: true });
  }
}

function withStartLock<T>(repoRoot: string, fn: () => T): T {
  ensureCrewDirs(repoRoot);
  const lockDir = join(crewDir(repoRoot), "start.lock");
  const reclaimLock = `${lockDir}.reclaim`;
  const ownerToken = `${process.pid}-${randomBytes(4).toString("hex")}`;
  // The lock directory appears atomically with its owner file already inside (rename of a
  // non-empty directory fails when the target exists), so there is no ownerless window.
  const staging = `${lockDir}.${ownerToken}`;
  mkdirSync(staging);
  writeFileSync(join(staging, "owner"), ownerToken, "utf8");
  const deadline = Date.now() + envMs("CREW_LOCK_WAIT_MS", 5000);
  const waitBuf = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;

  try {
    while (!acquired) {
      try {
        renameSync(staging, lockDir);
        acquired = true;
        break;
      } catch {
        // lock is held
      }
      if (reclaimStaleLock(lockDir, reclaimLock)) continue;
      if (Date.now() >= deadline) {
        throw new CrewCliError(
          "LOCK_TIMEOUT",
          "Timed out waiting for the crew start lock held by a concurrent start or clean.",
          "Wait a moment and retry.",
        );
      }
      Atomics.wait(waitBuf, 0, 0, 15);
    }
  } finally {
    if (!acquired) rmSync(staging, { recursive: true, force: true });
  }

  try {
    return fn();
  } finally {
    try {
      if (readLockOwner(lockDir) === ownerToken) {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // Lock already removed or reclaimed
    }
  }
}

interface SshResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Runs an ssh command with a hard timeout (CREW_SSH_TIMEOUT_MS, default 60 s, plus `extraMs`). */
function runSsh(
  cmd: string[],
  failure: { code: string; what: string; target: string },
  opts: { extraMs?: number; maxMs?: number; stdin?: Buffer } = {},
): SshResult {
  const base = envMs("CREW_SSH_TIMEOUT_MS", 60_000);
  const timeoutMs = Math.min(base, opts.maxMs ?? base) + (opts.extraMs ?? 0);
  let res: ReturnType<typeof Bun.spawnSync>;
  try {
    res = Bun.spawnSync(cmd, {
      stdin: opts.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CrewCliError(
      failure.code,
      `Failed to run ssh (${failure.target}) while ${failure.what}: ${msg}`,
      `Verify that \`ssh\` is installed on PATH and ${failure.target} is reachable.`,
    );
  }
  if (res.exitCode === null || res.exitedDueToTimeout === true) {
    throw new CrewCliError(
      failure.code,
      `Failed to run ssh (${failure.target}) while ${failure.what}${res.exitedDueToTimeout === true ? ` (timed out after ${Math.round(timeoutMs / 1000)}s)` : ""}.`,
      `Verify that \`ssh\` is installed on PATH and ${failure.target} is reachable.`,
    );
  }
  return { exitCode: res.exitCode, stdout: Buffer.from(res.stdout ?? ""), stderr: Buffer.from(res.stderr ?? "") };
}

const REMOTE_STATUSES: readonly JobStatus[] = ["running", "done", "error", "canceled", "attention"];

/** Applies the output of a remote `status <id>` to the local record. Returns the updated record, or null. */
function applyRemoteStatusOutput(repoRoot: string, raw: JobRecord, out: string): JobRecord | null {
  const statusVal = /^Status:\s*(\S+)/m.exec(out)?.[1];
  const status = REMOTE_STATUSES.find((s) => s === statusVal);
  if (!status) return null;
  const convMatch = /^Conversation:\s*(\S+)/m.exec(out);
  const updated: JobRecord = {
    ...raw,
    status,
    conversationId: convMatch?.[1] ?? raw.conversationId,
    end: status === "running" ? null : (raw.end ?? new Date().toISOString()),
  };
  writeJob(repoRoot, updated);
  return updated;
}

/** Best-effort refresh of a running remote job for `list`: never throws, leaves the record alone on failure. */
function refreshRemoteJob(repoRoot: string, job: JobRecord): JobRecord {
  if (job.remotePath === null || job.status !== "running") return job;
  try {
    const res = runSsh(
      buildSshCrewCommand({ sshCommand: job.machineTarget, remotePath: job.remotePath, crewArgs: ["status", job.id] }),
      { code: "SSH_EXEC_FAILED", what: `refreshing job "${job.id}"`, target: job.machineTarget },
      { maxMs: 15_000 },
    );
    if (res.exitCode !== 0) return job;
    return applyRemoteStatusOutput(repoRoot, job, res.stdout.toString()) ?? job;
  } catch {
    return job;
  }
}

function statusFromExitCode(code: number): JobStatus | null {
  switch (code) {
    case 0:
      return "done";
    case 2:
      return "running";
    case 3:
      return "error";
    case 4:
      return "canceled";
    case 5:
      return "attention";
    default:
      return null;
  }
}

function syncRemoteJobStatus(repoRoot: string, job: JobRecord, exitCode: number): void {
  const nextStatus = statusFromExitCode(exitCode);
  if (!nextStatus) return;
  const updated: JobRecord = {
    ...job,
    status: nextStatus,
    end: nextStatus === "running" ? null : (job.end ?? new Date().toISOString()),
    exit:
      nextStatus === "done" || nextStatus === "attention"
        ? 0
        : nextStatus === "canceled"
          ? 143
          : nextStatus === "error"
            ? 1
            : null,
  };
  writeJob(repoRoot, updated);
}

async function cmdStart(repoRoot: string, args: string[]): Promise<number> {
  const { flags, help } = parseFlags(args, {
    booleanFlags: ["local"],
    valueFlags: ["role", "brief", "branch", "continue", "timeout"],
    maxPositionals: 0,
    usage: `Run: ${RUNNER_CMD} start --role <role> --brief <file> [--branch <name>] [--continue <job-id>] [--timeout <dur>] [--local]`,
  });
  if (help) {
    printHelp();
    return 0;
  }

  const role = stringFlag(flags, "role");
  const briefArg = stringFlag(flags, "brief");
  const branch = stringFlag(flags, "branch");
  const continueId = stringFlag(flags, "continue");
  const timeout = stringFlag(flags, "timeout") ?? "30m";
  const forceLocal = flags.get("local") === true;

  const timeoutMs = parseDurationMs(timeout);
  if (timeoutMs === null || timeoutMs <= 0) {
    throw new CrewCliError(
      "INVALID_TIMEOUT",
      `Invalid timeout duration "${timeout}".`,
      "Use a positive duration like 30s, 10m, 1h, or 500ms.",
    );
  }

  if (!role) {
    throw new CrewCliError(
      "MISSING_ROLE",
      "Missing required --role <role> flag.",
      `Run: ${RUNNER_CMD} start --role <role> --brief <file>`,
    );
  }
  if (!briefArg) {
    throw new CrewCliError(
      "MISSING_BRIEF",
      "Missing required --brief <file> flag.",
      `Run: ${RUNNER_CMD} start --role ${role} --brief <file>`,
    );
  }
  if (branch !== undefined && !branch.trim()) {
    throw new CrewCliError(
      "INVALID_BRANCH",
      'Flag "--branch" cannot be empty.',
      "Pass a non-empty branch name or omit --branch.",
    );
  }

  const briefPath = resolve(process.cwd(), briefArg);

  const config = readCrewConfig(repoRoot);
  const roleConfig = config.roles[role];
  if (!roleConfig) {
    throw new CrewCliError(
      "UNKNOWN_ROLE",
      `Role "${role}" is not defined in .claude/crew.json.`,
      `Add "${role}" to "roles" in .claude/crew.json or use one of: ${Object.keys(config.roles).join(", ")}.`,
    );
  }

  if (branch !== undefined) {
    validateBranchName(repoRoot, branch, isReadOnlyRole(role));
  }

  assertWorkerSupported(roleConfig.worker, role);
  if (roleConfig.worker === "claude") workerTimeoutMs(timeout);

  const machineName = roleConfig.machine ?? "local";
  const machineTarget =
    machineName === "local" ? "local" : (config.machines?.[machineName] ?? "");

  if (machineName !== "local" && !machineTarget) {
    throw new CrewCliError(
      "UNKNOWN_MACHINE",
      `Machine "${machineName}" for role "${role}" is not defined in .claude/crew.json.`,
      `Add "${machineName}": "local" or "ssh user@host" under "machines" in .claude/crew.json.`,
    );
  }

  if (!forceLocal && machineTarget !== "local") {
    if (!existsSync(briefPath)) {
      throw new CrewCliError(
        "BRIEF_NOT_FOUND",
        `Brief file not found: ${briefPath}`,
        "Write the brief file first, then retry.",
      );
    }
    const remotePath = config.paths?.[machineName];
    if (!remotePath) {
      throw new CrewCliError(
        "MISSING_MACHINE_PATH",
        `No repo path configured for remote machine "${machineName}" in .claude/crew.json.`,
        `Add "paths": { "${machineName}": "/path/to/repo" } in .claude/crew.json.`,
      );
    }
    let remoteBrief = toRemoteBriefPath(repoRoot, briefPath, remotePath);
    if (isAbsolute(remoteBrief)) {
      // A brief outside the repo (the usual case: the orchestrator's scratch folder) is copied to the remote.
      remoteBrief = `.crew/briefs/brief-${Date.now()}-${randomBytes(3).toString("hex")}.md`;
      const copy = runSsh(
        [
          ...machineTarget.trim().split(/\s+/).filter(Boolean),
          `cd ${shellQuote(remotePath)} && mkdir -p .crew/briefs && cat > ${shellQuote(remoteBrief)}`,
        ],
        { code: "SSH_START_FAILED", what: "copying the brief", target: machineTarget },
        { stdin: readFileSync(briefPath) },
      );
      if (copy.exitCode !== 0) {
        throw new CrewCliError(
          "SSH_START_FAILED",
          `Could not copy brief ${briefPath} to ${remotePath} on "${machineName}": ${copy.stderr.toString().trim()}`,
          `Verify SSH connectivity (${machineTarget}) and that ${remotePath} exists on ${machineName}.`,
        );
      }
    }
    const sshCmd = buildSshStartCommand({
      sshCommand: machineTarget,
      remotePath,
      role,
      briefArg: remoteBrief,
      branch,
      continueJobId: continueId,
      timeout,
    });
    const res = runSsh(sshCmd, { code: "SSH_START_FAILED", what: `starting a ${role} job`, target: machineTarget });
    if (res.exitCode !== 0) {
      throw new CrewCliError(
        "SSH_START_FAILED",
        `Failed to start remote job on "${machineName}": ${res.stderr.toString().trim() || res.stdout.toString().trim()}`,
        `Verify SSH connectivity (${machineTarget}) and that ${remotePath} exists on ${machineName}.`,
      );
    }
    const out = res.stdout.toString().trim();
    const idMatch = /Started job (\S+)/.exec(out);
    if (!idMatch || !idMatch[1]) {
      throw new CrewCliError(
        "SSH_START_FAILED",
        `Remote start on "${machineName}" succeeded but did not return a job ID:\n${out}`,
        `Verify that ${remotePath} on ${machineName} runs the crew job runner.`,
      );
    }
    const remoteJobId = idMatch[1];
    if (!isValidJobId(remoteJobId)) {
      throw new CrewCliError(
        "SSH_START_FAILED",
        `Remote start on "${machineName}" returned an invalid job id "${remoteJobId}".`,
        `Verify that ${remotePath} on ${machineName} runs the crew job runner.`,
      );
    }
    const branchMatch = /, branch: ([^)\r\n]+)/.exec(out);
    const remoteBranch = branchMatch?.[1]?.trim() ?? branch ?? null;

    ensureCrewExcluded(repoRoot);
    ensureCrewDirs(repoRoot);
    const remoteJobRecord: JobRecord = {
      id: remoteJobId,
      role,
      worker: roleConfig.worker,
      agent: roleConfig.agent ?? role,
      model: roleConfig.model ?? null,
      machine: machineName,
      machineTarget,
      remotePath,
      branch: remoteBranch,
      worktree: `(remote:${machineName}:${remotePath})`,
      briefFile: briefPath,
      pid: null,
      start: new Date().toISOString(),
      end: null,
      exit: null,
      status: "running",
      conversationId: null,
      continuedFrom: continueId ?? null,
      logFile: "",
      stdoutFile: "",
      resultText: null,
      error: null,
    };
    writeJob(repoRoot, remoteJobRecord);

    console.log(`Started remote job on ${machineName} (${remotePath}):\n${localizeNext(out)}`);
    return 0;
  }

  if (!existsSync(briefPath)) {
    throw new CrewCliError(
      "BRIEF_NOT_FOUND",
      `Brief file not found: ${briefPath}`,
      "Pass a valid path to --brief <file>.",
    );
  }

  ensureCrewExcluded(repoRoot);
  ensureCrewDirs(repoRoot);

  const { jobId, assignment } = withStartLock(repoRoot, () => {
    let continueJob: JobRecord | null = null;
    if (continueId) {
      continueJob = readJob(repoRoot, continueId);
      if (!continueJob) {
        throw new CrewCliError(
          "JOB_NOT_FOUND",
          `Cannot continue: job "${continueId}" was not found.`,
          `Run \`${RUNNER_CMD} list\` to see recorded jobs.`,
        );
      }
      if (!continueJob.conversationId) {
        throw new CrewCliError(
          "NO_CONVERSATION_ID",
          `Job "${continueId}" has no recorded conversationId to continue.`,
          `Start a fresh job without --continue.`,
        );
      }
    }

    const runningJobs = listJobs(repoRoot)
      .map((j) => syncJobLiveness(repoRoot, j))
      .filter((j) => j.status === "running");

    let id = generateJobId(role);
    for (let n = 0; n < 20 && existsSync(jobFilePath(repoRoot, id)); n++) id = generateJobId(role);
    const wtAssignment = prepareWorktree(repoRoot, {
      jobId: id,
      role,
      branch,
      continueJob,
      runningJobs,
    });

    const logFile = resolve(logsDir(repoRoot), `${id}.log`);
    const stdoutFile = resolve(logsDir(repoRoot), `${id}.stdout.json`);

    const job: JobRecord = {
      id,
      role,
      worker: roleConfig.worker,
      agent: roleConfig.agent ?? role,
      model: roleConfig.model ?? null,
      machine: machineName,
      machineTarget,
      remotePath: null,
      branch: wtAssignment.branch,
      worktree: wtAssignment.worktree,
      briefFile: briefPath,
      pid: null,
      start: new Date().toISOString(),
      end: null,
      exit: null,
      status: "running",
      conversationId: continueJob?.conversationId ?? null,
      continuedFrom: continueJob?.id ?? null,
      logFile,
      stdoutFile,
      resultText: null,
      error: null,
    };
    writeJob(repoRoot, job);
    return { jobId: id, assignment: wtAssignment };
  });

  let execExited = false;
  let execExitCode: number | null = null;
  let spawnErrorMsg: string | null = null;

  const child = spawn(
    process.execPath,
    [import.meta.path, "_exec", jobId, "--timeout", timeout],
    {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
    },
  );
  child.on("exit", (code) => {
    execExited = true;
    execExitCode = code;
  });
  child.on("error", (err) => {
    execExited = true;
    spawnErrorMsg = err.message;
  });
  child.unref();

  // Wait briefly for _exec to record its pid (or finish) before returning
  const deadline = Date.now() + 2000;
  let current: JobRecord | null = null;
  while (Date.now() < deadline) {
    current = readJob(repoRoot, jobId);
    if (current && (current.pid !== null || current.end !== null)) break;
    if (execExited) {
      current = readJob(repoRoot, jobId);
      break;
    }
    await Bun.sleep(15);
  }
  if (!current || (current.pid === null && current.end === null)) {
    current = readJob(repoRoot, jobId);
  }

  if (!current || (current.pid === null && current.end === null)) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
    const baseJob = readJob(repoRoot, jobId) ?? current;
    const errMsg = spawnErrorMsg
      ? `Failed to spawn job supervisor: ${spawnErrorMsg}`
      : `Job supervisor exited (${execExitCode ?? "timeout"}) before recording a PID.`;
    if (baseJob && baseJob.status === "running") {
      writeJob(repoRoot, {
        ...baseJob,
        status: "error",
        end: new Date().toISOString(),
        exit: execExitCode ?? 1,
        error: {
          code: "EXEC_START_FAILED",
          message: errMsg,
          fix: `Inspect ${baseJob.logFile} or verify \`${RUNNER_CMD} --help\`.`,
        },
      });
    }
    throw new CrewCliError(
      "EXEC_START_FAILED",
      errMsg,
      `Verify Bun and worker environment, then retry \`${RUNNER_CMD} start\`.`,
    );
  }

  const branchInfo = assignment.branch ? `, branch: ${assignment.branch}` : "";
  console.log(`Started job ${jobId} (role: ${role}, machine: ${machineName}${branchInfo})`);
  console.log(`Next: ${RUNNER_CMD} wait ${jobId}`);
  return 0;
}

/** Signals a process and every descendant, deepest first (pgrep -P walks the tree). */
function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  const found = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" });
  for (const line of found.stdout.toString().split("\n")) {
    const child = Number(line.trim());
    if (Number.isInteger(child) && child > 0) killProcessTree(child, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

async function cmdExec(repoRoot: string, args: string[]): Promise<number> {
  const { positionals, flags, help } = parseFlags(args, {
    valueFlags: ["timeout"],
    maxPositionals: 1,
    usage: `Run: ${RUNNER_CMD} _exec <job-id> [--timeout 30m]`,
  });
  if (help) {
    printHelp();
    return 0;
  }

  const jobId = positionals[0];
  if (!jobId) {
    throw new CrewCliError(
      "MISSING_JOB_ID",
      "Missing required <job-id> argument.",
      `Run: ${RUNNER_CMD} _exec <job-id> [--timeout 30m]`,
    );
  }

  let cancelRequested = false;
  let activeProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  const forwardedSignals = new Set<NodeJS.Signals>();
  const onSignal = (sig: NodeJS.Signals): void => {
    cancelRequested = true;
    if (forwardedSignals.has(sig)) return;
    forwardedSignals.add(sig);
    if (activeProc) {
      try {
        process.kill(-process.pid, sig);
      } catch {
        try {
          activeProc.kill(sig);
        } catch {
          // already exited
        }
      }
    }
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  // JS signal handlers only run when the event loop turns: yield here and again right before
  // spawning agy, so a cancel that arrived earlier is seen by the guards below.
  await Bun.sleep(1);

  const job = readJob(repoRoot, jobId);
  if (!job) {
    throw new CrewCliError(
      "JOB_NOT_FOUND",
      `Job "${jobId}" not found.`,
      `Run \`${RUNNER_CMD} list\` to see available jobs.`,
    );
  }
  if (job.status !== "running") {
    return exitCodeForStatus(job.status);
  }
  if (cancelRequested) {
    const latest = readJob(repoRoot, job.id);
    if (latest && latest.status !== "running") {
      return exitCodeForStatus(latest.status);
    }
    writeJob(repoRoot, {
      ...(latest ?? job),
      pid: process.pid,
      status: "canceled",
      end: new Date().toISOString(),
      exit: 143,
    });
    return 4;
  }

  job.pid = process.pid;
  writeJob(repoRoot, job);

  try {
    const printTimeout = stringFlag(flags, "timeout") ?? "30m";
    const briefText = readFileSync(job.briefFile, "utf8");
    const isClaude = job.worker === "claude";
    const settingsJson = readWorkerSettings(repoRoot, job.worker);
    const resume = Boolean(job.continuedFrom && job.conversationId);
    const sessionId = resume && job.conversationId ? job.conversationId : crypto.randomUUID();
    const timeoutMs = isClaude ? workerTimeoutMs(printTimeout) : null;
    const workerArgs = isClaude
      ? buildClaudeArgs({
          model: job.model,
          settingsJson,
          rulesText: readCrewRules(),
          readOnly: isReadOnlyRole(job.role),
          sessionId,
          resume,
        })
      : buildAgyArgs({
          briefText,
          role: job.agent ?? job.role,
          model: job.model,
          printTimeout,
          worktree: job.worktree,
          settingsJson,
          conversationId: job.continuedFrom ? job.conversationId : null,
        });
    if (isClaude) {
      // Record the session id first, so a run that times out or crashes can still be continued.
      job.conversationId = sessionId;
      writeJob(repoRoot, job);
    }

    await Bun.sleep(5);
    const latestBefore = readJob(repoRoot, job.id);
    if (latestBefore && latestBefore.status !== "running") {
      return exitCodeForStatus(latestBefore.status);
    }
    if (cancelRequested) {
      writeJob(repoRoot, {
        ...(latestBefore ?? job),
        pid: process.pid,
        status: "canceled",
        end: new Date().toISOString(),
        exit: 143,
      });
      return 4;
    }

    const proc = Bun.spawn([isClaude ? "claude" : "agy", ...workerArgs], {
      cwd: job.worktree,
      stdin: isClaude ? new Blob([briefText]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: isClaude
        ? claudeJobEnv(process.env, { CREW_ROOT: crewRootForWorkers(), CREW_BUN: process.execPath })
        : process.env,
    });
    activeProc = proc;

    let workerTimedOut = false;
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            workerTimedOut = true;
            // Tool commands (and their children) would keep the output pipes open, so stop the whole tree.
            killProcessTree(proc.pid, "SIGTERM");
            setTimeout(() => killProcessTree(proc.pid, "SIGKILL"), 2000).unref();
          }, timeoutMs);

    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (timer) clearTimeout(timer);
    const pipes = Promise.all([stdoutPromise, stderrPromise]);
    const [stdoutText, stderrText] = workerTimedOut
      ? await Promise.race([pipes, Bun.sleep(3000).then((): [string, string] => ["", ""])])
      : await pipes;

    writeFileSync(job.stdoutFile, stdoutText, "utf8");
    writeFileSync(
      job.logFile,
      `[job ${job.id}] exit=${exitCode}\n--- stderr ---\n${stderrText}\n--- stdout ---\n${stdoutText}\n`,
      "utf8",
    );

    const latest = readJob(repoRoot, job.id);
    if (cancelRequested || (latest && latest.status === "canceled")) {
      if (!latest || latest.status !== "canceled") {
        writeJob(repoRoot, {
          ...(latest ?? job),
          pid: process.pid,
          status: "canceled",
          end: new Date().toISOString(),
          exit: exitCode,
        });
      }
      return 4;
    }
    if (latest && latest.status !== "running") {
      return exitCodeForStatus(latest.status);
    }

    const parsed = isClaude
      ? parseClaudeOutput(stdoutText, stderrText, exitCode, workerTimedOut, sessionId)
      : parseAgyOutput(stdoutText, stderrText, exitCode);
    const endTime = new Date().toISOString();
    const effectiveConversationId = parsed.conversationId ?? job.conversationId;
    let status: JobStatus;
    let errorPayload: JobRecord["error"] = null;

    if (parsed.timedOut) {
      if (effectiveConversationId) {
        status = "attention";
      } else {
        status = "error";
        errorPayload = {
          code: "WORKER_TIMEOUT",
          message:
            parsed.resultText ||
            stderrText.trim() ||
            `Worker timed out without a resumable conversationId (exit ${exitCode}).`,
          fix: `Inspect ${job.logFile} and re-run without --continue.`,
        };
      }
    } else if (exitCode !== 0 || parsed.isError) {
      status = "error";
      errorPayload = {
        code: "WORKER_FAILED",
        message: parsed.resultText || stderrText.trim() || `Worker exited with code ${exitCode}.`,
        fix: `Inspect ${job.logFile} for details.`,
      };
    } else if (!parsed.resultText.trim()) {
      status = "error";
      errorPayload = {
        code: "EMPTY_RESPONSE",
        message: "Worker exited 0 without delivering a response.",
        fix: `Inspect ${job.logFile} and re-run with a clearer brief.`,
      };
    } else {
      status = "done";
    }

    // Re-read right before the final write so a cancel that landed meanwhile is not overwritten.
    const beforeFinish = readJob(repoRoot, job.id);
    if (beforeFinish && beforeFinish.status !== "running") {
      return exitCodeForStatus(beforeFinish.status);
    }

    const finished: JobRecord = {
      ...(beforeFinish ?? latest ?? job),
      pid: process.pid,
      end: endTime,
      exit: exitCode,
      status,
      conversationId: effectiveConversationId,
      resultText: parsed.resultText || null,
      error: errorPayload,
    };
    writeJob(repoRoot, finished);

    if (parsed.usage) {
      appendUsage(repoRoot, {
        jobId: finished.id,
        role: finished.role,
        worker: finished.worker,
        model: finished.model,
        machine: finished.machine,
        timestamp: endTime,
        usage: parsed.usage,
      });
    }

    return exitCodeForStatus(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      writeFileSync(job.logFile, `[job ${job.id}] supervisor error: ${msg}\n`, "utf8");
    } catch {
      // ignore if log directory is unreachable
    }
    const latest = readJob(repoRoot, job.id);
    if (latest && latest.status !== "running") {
      return exitCodeForStatus(latest.status);
    }
    if (cancelRequested) {
      writeJob(repoRoot, {
        ...(latest ?? job),
        pid: process.pid,
        status: "canceled",
        end: new Date().toISOString(),
        exit: 143,
      });
      return 4;
    }
    writeJob(repoRoot, {
      ...(latest ?? job),
      pid: process.pid,
      end: new Date().toISOString(),
      exit: 1,
      status: "error",
      error: {
        code: "EXEC_FAILED",
        message: msg,
        fix: `Inspect ${job.logFile} and ensure "${job.worker}" is installed on PATH.`,
      },
    });
    return 3;
  }
}

async function cmdWait(repoRoot: string, args: string[]): Promise<number> {
  const { positionals, flags, help } = parseFlags(args, {
    valueFlags: ["timeout"],
    maxPositionals: 1,
    usage: `Run: ${RUNNER_CMD} wait <job-id> [--timeout 10m]`,
  });
  if (help) {
    printHelp();
    return 0;
  }

  const jobId = positionals[0];
  if (!jobId) {
    throw new CrewCliError(
      "MISSING_JOB_ID",
      "Missing required <job-id> argument.",
      `Run: ${RUNNER_CMD} wait <job-id> [--timeout 10m]`,
    );
  }

  const timeoutRaw = stringFlag(flags, "timeout") ?? "10m";
  const timeoutMs = parseDurationMs(timeoutRaw);
  if (timeoutMs === null) {
    throw new CrewCliError(
      "INVALID_TIMEOUT",
      `Invalid timeout duration "${timeoutRaw}".`,
      "Use a duration like 30s, 10m, 1h, or 500ms.",
    );
  }

  let job = readJob(repoRoot, jobId);
  if (!job) {
    throw new CrewCliError(
      "JOB_NOT_FOUND",
      `Job "${jobId}" not found.`,
      `Run \`${RUNNER_CMD} list\` to see available jobs.`,
    );
  }

  if (job.remotePath !== null) {
    const sshCmd = buildSshCrewCommand({
      sshCommand: job.machineTarget,
      remotePath: job.remotePath,
      crewArgs: ["wait", job.id, "--timeout", timeoutRaw],
    });
    const res = runSsh(
      sshCmd,
      { code: "SSH_EXEC_FAILED", what: `waiting for job "${job.id}"`, target: job.machineTarget },
      { extraMs: timeoutMs },
    );
    process.stdout.write(localizeNext(res.stdout.toString()));
    process.stderr.write(res.stderr);
    const code = res.exitCode;
    syncRemoteJobStatus(repoRoot, job, code);
    return code;
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    job = syncJobLiveness(repoRoot, job);
    if (job.status !== "running") break;
    if (Date.now() >= deadline) break;
    await Bun.sleep(100);
    const next = readJob(repoRoot, jobId);
    if (next) job = next;
  }

  const code = exitCodeForStatus(job.status);
  switch (job.status) {
    case "done":
      console.log(`Job ${job.id} done.`);
      console.log(`Next: ${RUNNER_CMD} result ${job.id}`);
      break;
    case "running":
      console.log(`Job ${job.id} still running.`);
      console.log(`Next: ${RUNNER_CMD} wait ${job.id}`);
      break;
    case "canceled":
      console.log(`Job ${job.id} canceled.`);
      break;
    case "attention":
      console.log(`Job ${job.id} needs attention (resumable timeout).`);
      console.log(`Next: ${formatContinueCmd(job)}`);
      break;
    case "error":
      console.log(`Job ${job.id} failed (exit ${job.exit ?? 1}): ${job.error?.message ?? "unknown error"}`);
      console.log(`Log: ${job.logFile}`);
      break;
  }
  return code;
}

function cmdStatus(repoRoot: string, args: string[]): number {
  const { positionals, help } = parseFlags(args, {
    maxPositionals: 1,
    usage: `Run: ${RUNNER_CMD} status [job-id]`,
  });
  if (help) {
    printHelp();
    return 0;
  }

  const jobId = positionals[0];
  if (!jobId) return cmdList(repoRoot, []);

  const raw = readJob(repoRoot, jobId);
  if (!raw) {
    throw new CrewCliError(
      "JOB_NOT_FOUND",
      `Job "${jobId}" not found.`,
      `Run \`${RUNNER_CMD} list\` to see available jobs.`,
    );
  }

  if (raw.remotePath !== null) {
    const sshCmd = buildSshCrewCommand({
      sshCommand: raw.machineTarget,
      remotePath: raw.remotePath,
      crewArgs: ["status", raw.id],
    });
    const res = runSsh(sshCmd, {
      code: "SSH_EXEC_FAILED",
      what: `checking status for job "${raw.id}"`,
      target: raw.machineTarget,
    });
    process.stdout.write(localizeNext(res.stdout.toString()));
    process.stderr.write(res.stderr);
    const code = res.exitCode;
    if (code === 0) applyRemoteStatusOutput(repoRoot, raw, res.stdout.toString());
    return code;
  }

  const job = syncJobLiveness(repoRoot, raw);
  console.log(`Job: ${job.id}`);
  console.log(`Status: ${job.status}`);
  console.log(`Role: ${job.role} (${job.worker}${job.model ? ` / ${job.model}` : ""})`);
  console.log(`Machine: ${job.machine}`);
  if (job.branch) console.log(`Branch: ${job.branch}`);
  console.log(`Worktree: ${job.worktree}`);
  if (job.conversationId) console.log(`Conversation: ${job.conversationId}`);
  console.log(`Start: ${job.start}`);
  if (job.end) console.log(`End: ${job.end} (exit ${job.exit ?? "?"})`);
  if (job.status === "running") {
    console.log(`Next: ${RUNNER_CMD} wait ${job.id}`);
  } else if (job.status === "done") {
    console.log(`Next: ${RUNNER_CMD} result ${job.id}`);
  } else if (job.status === "attention") {
    console.log(`Next: ${formatContinueCmd(job)}`);
  }
  return 0;
}

function cmdResult(repoRoot: string, args: string[]): number {
  const { positionals, help } = parseFlags(args, {
    maxPositionals: 1,
    usage: `Run: ${RUNNER_CMD} result <job-id>`,
  });
  if (help) {
    printHelp();
    return 0;
  }

  const jobId = positionals[0];
  if (!jobId) {
    throw new CrewCliError(
      "MISSING_JOB_ID",
      "Missing required <job-id> argument.",
      `Run: ${RUNNER_CMD} result <job-id>`,
    );
  }

  const raw = readJob(repoRoot, jobId);
  if (!raw) {
    throw new CrewCliError(
      "JOB_NOT_FOUND",
      `Job "${jobId}" not found.`,
      `Run \`${RUNNER_CMD} list\` to see available jobs.`,
    );
  }

  if (raw.remotePath !== null) {
    const sshCmd = buildSshCrewCommand({
      sshCommand: raw.machineTarget,
      remotePath: raw.remotePath,
      crewArgs: ["result", raw.id],
    });
    const res = runSsh(sshCmd, {
      code: "SSH_EXEC_FAILED",
      what: `reading result for job "${raw.id}"`,
      target: raw.machineTarget,
    });
    process.stdout.write(localizeNext(res.stdout.toString()));
    process.stderr.write(res.stderr);
    const code = res.exitCode;
    syncRemoteJobStatus(repoRoot, raw, code);
    return code;
  }

  const job = syncJobLiveness(repoRoot, raw);

  if (job.status === "running") {
    throw new CrewCliError(
      "JOB_STILL_RUNNING",
      `Job "${job.id}" is still running.`,
      `Run \`${RUNNER_CMD} wait ${job.id}\` first.`,
      2,
    );
  }
  if (job.status === "canceled") {
    console.log("Status: CANCELED");
    console.log(`Job ${job.id} was canceled.`);
    return 4;
  }
  if (job.status === "error") {
    console.log("Status: ERROR");
    console.log(job.error?.message ?? job.resultText ?? "Job failed.");
    return 3;
  }

  const text = (job.resultText ?? "").trim();
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (/^(Status|Verdict):\s*\S+/i.test(firstLine)) {
    console.log(text);
  } else {
    const label = job.status === "attention" ? "ATTENTION" : "DONE";
    console.log(`Status: ${label}`);
    if (text) console.log(text);
  }
  if (job.status === "attention") {
    console.log(`\nNext: ${formatContinueCmd(job)}`);
    return 5;
  }
  return 0;
}

async function cmdCancel(repoRoot: string, args: string[]): Promise<number> {
  const { positionals, help } = parseFlags(args, {
    maxPositionals: 1,
    usage: `Run: ${RUNNER_CMD} cancel <job-id>`,
  });
  if (help) {
    printHelp();
    return 0;
  }

  const jobId = positionals[0];
  if (!jobId) {
    throw new CrewCliError(
      "MISSING_JOB_ID",
      "Missing required <job-id> argument.",
      `Run: ${RUNNER_CMD} cancel <job-id>`,
    );
  }

  let raw = readJob(repoRoot, jobId);
  if (!raw) {
    throw new CrewCliError(
      "JOB_NOT_FOUND",
      `Job "${jobId}" not found.`,
      `Run \`${RUNNER_CMD} list\` to see available jobs.`,
    );
  }

  if (raw.remotePath !== null) {
    const sshCmd = buildSshCrewCommand({
      sshCommand: raw.machineTarget,
      remotePath: raw.remotePath,
      crewArgs: ["cancel", raw.id],
    });
    const res = runSsh(sshCmd, {
      code: "SSH_EXEC_FAILED",
      what: `canceling job "${raw.id}"`,
      target: raw.machineTarget,
    });
    process.stdout.write(localizeNext(res.stdout.toString()));
    process.stderr.write(res.stderr);
    const code = res.exitCode;
    if (code === 0) {
      writeJob(repoRoot, {
        ...raw,
        status: "canceled",
        end: new Date().toISOString(),
        exit: 143,
      });
    } else {
      const errLines = res.stderr.toString().trim().split(/\r?\n/).reverse();
      for (const line of errLines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsedErr: unknown = JSON.parse(line);
          if (
            typeof parsedErr === "object" &&
            parsedErr !== null &&
            "code" in parsedErr &&
            (parsedErr as { code?: unknown }).code === "JOB_NOT_RUNNING" &&
            "message" in parsedErr &&
            typeof (parsedErr as { message?: unknown }).message === "string"
          ) {
            const msg = (parsedErr as { message: string }).message;
            const m = /\(status:\s*(done|error|canceled|attention)\)|status\s+"(done|error|canceled|attention)"/.exec(
              msg,
            );
            const remoteStatus = (m?.[1] ?? m?.[2]) as JobStatus | undefined;
            if (remoteStatus) {
              syncRemoteJobStatus(repoRoot, raw, exitCodeForStatus(remoteStatus));
              break;
            }
          }
        } catch {
          // Non-JSON stderr line from SSH/remote
        }
      }
    }
    return code;
  }

  if (raw.status === "running" && raw.pid === null) {
    const pidDeadline = Date.now() + 2000;
    while (Date.now() < pidDeadline) {
      await Bun.sleep(25);
      const refreshed = readJob(repoRoot, jobId);
      if (!refreshed) break;
      raw = refreshed;
      if (raw.status !== "running" || raw.pid !== null) break;
    }
  }

  if (raw.status === "running" && raw.pid === null) {
    // The supervisor never recorded a pid (start was interrupted): nothing to kill, so mark it canceled.
    const latestRaw = readJob(repoRoot, raw.id);
    if (latestRaw && latestRaw.status === "running" && latestRaw.pid === null) {
      writeJob(repoRoot, { ...latestRaw, status: "canceled", end: new Date().toISOString(), exit: 143 });
      console.log(`Canceled job ${raw.id} (it had not started yet).`);
      return 0;
    }
    raw = latestRaw ?? raw;
  }

  if (raw.status !== "running" || raw.pid === null) {
    const job = syncJobLiveness(repoRoot, raw);
    throw new CrewCliError(
      "JOB_NOT_RUNNING",
      `Job "${job.id}" is not running (status: ${job.status}).`,
      `Run \`${RUNNER_CMD} status ${job.id}\` to inspect it.`,
    );
  }

  const pgidState = inspectJobPgid(raw.pid, raw.id);
  if (pgidState === "mismatch") {
    throw new CrewCliError(
      "PROCESS_MISMATCH",
      `Refusing to kill pid ${raw.pid}: process command line does not match job "${raw.id}".`,
      `Inspect \`ps -ww -p ${raw.pid} -o args=\` manually.`,
    );
  }
  if (pgidState === "exited") {
    const fresh = readJob(repoRoot, raw.id);
    if (fresh && fresh.status !== "running") {
      throw new CrewCliError(
        "JOB_NOT_RUNNING",
        `Job "${raw.id}" is not running (status: ${fresh.status}).`,
        `Run \`${RUNNER_CMD} status ${raw.id}\` to inspect it.`,
      );
    }
    const synced = syncJobLiveness(repoRoot, fresh ?? raw);
    throw new CrewCliError(
      "JOB_NOT_RUNNING",
      `Job "${raw.id}" is not running (status: ${synced.status}).`,
      `Run \`${RUNNER_CMD} status ${raw.id}\` to inspect it.`,
    );
  }
  const job = raw;
  const pid = job.pid;
  if (pid === null) {
    throw new CrewCliError(
      "JOB_NOT_RUNNING",
      `Job "${job.id}" has no recorded process.`,
      `Run \`${RUNNER_CMD} status ${job.id}\` to inspect it.`,
    );
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already exited
    }
  }

  const killDeadline = Date.now() + 1500;
  while (Date.now() < killDeadline && hasLiveProcessInPgid(pid)) {
    await Bun.sleep(50);
  }
  if (hasLiveProcessInPgid(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
    const reapDeadline = Date.now() + 500;
    while (Date.now() < reapDeadline && hasLiveProcessInPgid(pid)) {
      await Bun.sleep(25);
    }
  }

  const latest = readJob(repoRoot, job.id);
  if (latest && latest.status !== "running") {
    if (latest.status === "canceled") {
      console.log(`Canceled job ${job.id} (pid ${job.pid}).`);
      return 0;
    }
    throw new CrewCliError(
      "JOB_NOT_RUNNING",
      `Job "${job.id}" already finished with status "${latest.status}" before cancel completed.`,
      `Run \`${RUNNER_CMD} status ${job.id}\` to inspect it.`,
    );
  }

  const canceled: JobRecord = {
    ...(latest ?? job),
    status: "canceled",
    end: new Date().toISOString(),
    exit: 143,
  };
  writeJob(repoRoot, canceled);
  console.log(`Canceled job ${job.id} (pid ${job.pid}).`);
  return 0;
}

function cmdList(repoRoot: string, args: string[]): number {
  const { help } = parseFlags(args, {
    maxPositionals: 0,
    usage: `Run: ${RUNNER_CMD} list`,
  });
  if (help) {
    printHelp();
    return 0;
  }

  const jobs = listJobs(repoRoot).map((j) =>
    j.remotePath !== null ? refreshRemoteJob(repoRoot, j) : syncJobLiveness(repoRoot, j),
  );
  if (jobs.length === 0) {
    console.log("No crew jobs recorded.");
    return 0;
  }
  for (const job of jobs) {
    const branch = job.branch ? ` branch=${job.branch}` : "";
    console.log(`${job.id}\t${job.status}\t${job.role}\t${job.machine}${branch}`);
  }
  return 0;
}

function cmdClean(repoRoot: string, args: string[]): number {
  const { help } = parseFlags(args, {
    maxPositionals: 0,
    usage: `Run: ${RUNNER_CMD} clean`,
  });
  if (help) {
    printHelp();
    return 0;
  }

  // Same lock as `start`: a worktree that start just handed out must not be removed under its new job,
  // and job statuses are read inside the lock so liveness is current when clean decides.
  const runClean = (): CleanResult =>
    cleanFinishedWorktrees(
      repoRoot,
      listJobs(repoRoot).map((j) => syncJobLiveness(repoRoot, j)),
      (job) => job.status === "running",
    );
  let crewDirsSafe = true;
  try {
    ensureCrewDirs(repoRoot);
  } catch (err) {
    // A symlinked .crew or .crew/worktrees cannot be locked safely, but clean still has to run so it can
    // report that it keeps everything (nothing outside the real .crew/worktrees is ever removed).
    if (!(err instanceof CrewCliError && err.code === "WORKTREE_OUTSIDE_CREW")) throw err;
    crewDirsSafe = false;
  }
  const result = crewDirsSafe ? withStartLock(repoRoot, runClean) : runClean();
  console.log(`Removed ${result.removed.length} worktree(s); kept ${result.kept.length}.`);
  for (const wt of result.removed) {
    console.log(`- removed: ${wt}`);
  }
  for (const item of result.kept) {
    console.log(`- kept: ${item.worktree} (${item.reason})`);
  }
  return 0;
}

function printHelp(): void {
  console.log(`Usage: ${RUNNER_CMD} <command>

Commands:
  start --role <role> --brief <file> [--branch <name>] [--continue <job-id>] [--timeout <dur>] [--local]
  wait <job-id> [--timeout 10m]
  status [job-id]
  result <job-id>
  cancel <job-id>
  list
  clean`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return command ? 0 : 1;
  }

  const knownCommands = new Set([
    "start",
    "_exec",
    "wait",
    "status",
    "result",
    "cancel",
    "list",
    "clean",
  ]);
  if (!knownCommands.has(command)) {
    throw new CrewCliError(
      "UNKNOWN_COMMAND",
      `Unknown command "${command}".`,
      `Run \`${RUNNER_CMD} --help\` for supported commands.`,
    );
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp();
    return 0;
  }

  const repoRoot = getRepoRoot(process.cwd());
  switch (command) {
    case "start":
      return await cmdStart(repoRoot, rest);
    case "_exec":
      return await cmdExec(repoRoot, rest);
    case "wait":
      return await cmdWait(repoRoot, rest);
    case "status":
      return cmdStatus(repoRoot, rest);
    case "result":
      return cmdResult(repoRoot, rest);
    case "cancel":
      return await cmdCancel(repoRoot, rest);
    case "list":
      return cmdList(repoRoot, rest);
    case "clean":
      return cmdClean(repoRoot, rest);
    default:
      throw new CrewCliError(
        "UNKNOWN_COMMAND",
        `Unknown command "${command}".`,
        `Run \`${RUNNER_CMD} --help\` for supported commands.`,
      );
  }
}

if (import.meta.main) {
  try {
    const code = await main();
    process.exit(code);
  } catch (err) {
    if (err instanceof CrewCliError) {
      console.error(JSON.stringify(err.toPayload()));
      process.exit(err.exitCode);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        code: "INTERNAL_ERROR",
        message: msg,
        fix: `Re-run with \`${RUNNER_CMD} --help\` or inspect .crew/logs/.`,
      }),
    );
    process.exit(1);
  }
}
