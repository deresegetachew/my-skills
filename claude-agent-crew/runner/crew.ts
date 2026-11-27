#!/usr/bin/env bun
// Job runner for claude-agent-crew.
// Job-lifecycle design (start/wait/status/result/cancel/list/clean) credited to
// github.com/keli-wen/agy-staff (MIT).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanFinishedWorktrees,
  ensureCrewExcluded,
  getRepoRoot,
  prepareWorktree,
} from "./git.ts";
import {
  appendUsage,
  ensureCrewDirs,
  generateJobId,
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
  buildSshStartCommand,
  parseAgyOutput,
  readWorkerSettings,
  toRemoteBriefPath,
} from "./worker.ts";

const RUNNER_CMD = "bun claude-agent-crew/runner/crew.ts";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isExpectedJobProcess(pid: number, jobId: string): boolean {
  const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return false;
  return res.stdout.toString().includes(jobId);
}

function syncJobLiveness(repoRoot: string, job: JobRecord): JobRecord {
  if (job.status !== "running" || job.pid === null) return job;
  if (isPidAlive(job.pid)) return job;
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

function parseFlags(args: string[]): { positionals: string[]; flags: Map<string, string | boolean> } {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "local") {
      flags.set(key, true);
      continue;
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
  return { positionals, flags };
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function formatContinueCmd(job: JobRecord): string {
  return `${RUNNER_CMD} start --role ${job.role} --brief ${job.briefFile} --continue ${job.id}`;
}

async function cmdStart(repoRoot: string, args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const role = stringFlag(flags, "role");
  const briefArg = stringFlag(flags, "brief");
  const branch = stringFlag(flags, "branch");
  const continueId = stringFlag(flags, "continue");
  const timeout = stringFlag(flags, "timeout") ?? "30m";
  const forceLocal = flags.get("local") === true;

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

  const briefPath = resolve(process.cwd(), briefArg);
  if (!existsSync(briefPath)) {
    throw new CrewCliError(
      "BRIEF_NOT_FOUND",
      `Brief file not found: ${briefPath}`,
      "Pass a valid path to --brief <file>.",
    );
  }

  const config = readCrewConfig(repoRoot);
  const roleConfig = config.roles[role];
  if (!roleConfig) {
    throw new CrewCliError(
      "UNKNOWN_ROLE",
      `Role "${role}" is not defined in .claude/crew.json.`,
      `Add "${role}" to "roles" in .claude/crew.json or use one of: ${Object.keys(config.roles).join(", ")}.`,
    );
  }

  assertWorkerSupported(roleConfig.worker, role);

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
    const remotePath = config.paths?.[machineName];
    if (!remotePath) {
      throw new CrewCliError(
        "MISSING_MACHINE_PATH",
        `No repo path configured for remote machine "${machineName}" in .claude/crew.json.`,
        `Add "paths": { "${machineName}": "/path/to/repo" } in .claude/crew.json.`,
      );
    }
    const sshCmd = buildSshStartCommand({
      sshCommand: machineTarget,
      remotePath,
      role,
      briefArg: toRemoteBriefPath(repoRoot, briefPath),
      branch,
      continueJobId: continueId,
      timeout,
    });
    const res = Bun.spawnSync(sshCmd, { stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) {
      throw new CrewCliError(
        "SSH_START_FAILED",
        `Failed to start remote job on "${machineName}": ${res.stderr.toString().trim() || res.stdout.toString().trim()}`,
        `Verify SSH connectivity (${machineTarget}) and that ${remotePath} exists on ${machineName}.`,
      );
    }
    const out = res.stdout.toString().trim();
    console.log(`Started remote job on ${machineName} (${remotePath}):\n${out}`);
    return 0;
  }

  ensureCrewExcluded(repoRoot);
  ensureCrewDirs(repoRoot);

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

  const jobId = generateJobId(role);
  const assignment = prepareWorktree(repoRoot, {
    jobId,
    role,
    branch: branch ?? continueJob?.branch ?? undefined,
    continueJob,
  });

  const logFile = resolve(logsDir(repoRoot), `${jobId}.log`);
  const stdoutFile = resolve(logsDir(repoRoot), `${jobId}.stdout.json`);

  const job: JobRecord = {
    id: jobId,
    role,
    worker: roleConfig.worker,
    model: roleConfig.model ?? null,
    machine: machineName,
    machineTarget,
    remotePath: null,
    branch: assignment.branch,
    worktree: assignment.worktree,
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

  const child = spawn(
    process.execPath,
    [import.meta.path, "_exec", jobId, "--timeout", timeout],
    {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  // Wait briefly for _exec to record its pid (or finish) before returning
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const current = readJob(repoRoot, jobId);
    if (current && (current.pid !== null || current.end !== null)) break;
    await Bun.sleep(15);
  }

  const branchInfo = assignment.branch ? `, branch: ${assignment.branch}` : "";
  console.log(`Started job ${jobId} (role: ${role}, machine: ${machineName}${branchInfo})`);
  console.log(`Next: ${RUNNER_CMD} wait ${jobId}`);
  return 0;
}

async function cmdExec(repoRoot: string, args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const jobId = positionals[0];
  if (!jobId) return 1;

  const job = readJob(repoRoot, jobId);
  if (!job) return 1;

  job.pid = process.pid;
  writeJob(repoRoot, job);

  const printTimeout = stringFlag(flags, "timeout") ?? "30m";
  const briefText = readFileSync(job.briefFile, "utf8");
  const settingsJson = readWorkerSettings(repoRoot);
  const agyArgs = buildAgyArgs({
    briefText,
    role: job.role,
    model: job.model,
    printTimeout,
    worktree: job.worktree,
    settingsJson,
    conversationId: job.continuedFrom ? job.conversationId : null,
  });

  const proc = Bun.spawn(["agy", ...agyArgs], {
    cwd: job.worktree,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  writeFileSync(job.stdoutFile, stdoutText, "utf8");
  writeFileSync(
    job.logFile,
    `[job ${job.id}] exit=${exitCode}\n--- stderr ---\n${stderrText}\n--- stdout ---\n${stdoutText}\n`,
    "utf8",
  );

  const latest = readJob(repoRoot, job.id);
  if (latest && latest.status === "canceled") {
    return 4;
  }

  const parsed = parseAgyOutput(stdoutText, stderrText);
  const endTime = new Date().toISOString();
  let status: JobStatus;
  let errorPayload: JobRecord["error"] = null;

  if (parsed.timedOut) {
    status = "attention";
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

  const finished: JobRecord = {
    ...(latest ?? job),
    pid: process.pid,
    end: endTime,
    exit: exitCode,
    status,
    conversationId: parsed.conversationId ?? job.conversationId,
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
}

async function cmdWait(repoRoot: string, args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
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
  const { positionals } = parseFlags(args);
  const jobId = positionals[0];
  if (!jobId) return cmdList(repoRoot);

  const raw = readJob(repoRoot, jobId);
  if (!raw) {
    throw new CrewCliError(
      "JOB_NOT_FOUND",
      `Job "${jobId}" not found.`,
      `Run \`${RUNNER_CMD} list\` to see available jobs.`,
    );
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
  const { positionals } = parseFlags(args);
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
  if (/^Status:\s*\S+/i.test(firstLine)) {
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
  const { positionals } = parseFlags(args);
  const jobId = positionals[0];
  if (!jobId) {
    throw new CrewCliError(
      "MISSING_JOB_ID",
      "Missing required <job-id> argument.",
      `Run: ${RUNNER_CMD} cancel <job-id>`,
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

  const job = syncJobLiveness(repoRoot, raw);
  if (job.status !== "running" || job.pid === null) {
    throw new CrewCliError(
      "JOB_NOT_RUNNING",
      `Job "${job.id}" is not running (status: ${job.status}).`,
      `Run \`${RUNNER_CMD} status ${job.id}\` to inspect it.`,
    );
  }

  if (!isExpectedJobProcess(job.pid, job.id)) {
    throw new CrewCliError(
      "PROCESS_MISMATCH",
      `Refusing to kill pid ${job.pid}: process command line does not match job "${job.id}".`,
      `Inspect \`ps -p ${job.pid} -o args=\` manually.`,
    );
  }

  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // already exited
    }
  }

  const killDeadline = Date.now() + 1500;
  while (Date.now() < killDeadline && isPidAlive(job.pid)) {
    await Bun.sleep(50);
  }
  if (isPidAlive(job.pid)) {
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {
      try {
        process.kill(job.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  }

  const canceled: JobRecord = {
    ...job,
    status: "canceled",
    end: new Date().toISOString(),
    exit: 143,
  };
  writeJob(repoRoot, canceled);
  console.log(`Canceled job ${job.id} (pid ${job.pid}).`);
  return 0;
}

function cmdList(repoRoot: string): number {
  const jobs = listJobs(repoRoot).map((j) => syncJobLiveness(repoRoot, j));
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

function cmdClean(repoRoot: string): number {
  const jobs = listJobs(repoRoot).map((j) => syncJobLiveness(repoRoot, j));
  const result = cleanFinishedWorktrees(
    repoRoot,
    jobs,
    (job) => job.status === "running",
  );
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
  start --role <role> --brief <file> [--branch <name>] [--continue <job-id>] [--timeout <dur>]
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
      return cmdList(repoRoot);
    case "clean":
      return cmdClean(repoRoot);
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
