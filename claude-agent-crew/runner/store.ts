import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CrewConfig, JobRecord, RoleConfig, UsageRecord } from "./types.ts";
import { CrewCliError } from "./types.ts";

export function crewDir(repoRoot: string): string {
  return join(repoRoot, ".crew");
}

export function jobsDir(repoRoot: string): string {
  return join(crewDir(repoRoot), "jobs");
}

export function logsDir(repoRoot: string): string {
  return join(crewDir(repoRoot), "logs");
}

export function worktreesDir(repoRoot: string): string {
  return join(crewDir(repoRoot), "worktrees");
}

export function usageFile(repoRoot: string): string {
  return join(crewDir(repoRoot), "usage.jsonl");
}

function assertSafeCrewDirPath(dirPath: string): void {
  let st;
  try {
    st = lstatSync(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new CrewCliError(
      "WORKTREE_OUTSIDE_CREW",
      `Refusing to use non-directory or symlinked crew path: ${dirPath}`,
      "Ensure .crew/ and .crew/worktrees/ are real directories inside the repository, not symlinks.",
    );
  }
}

export function ensureCrewDirs(repoRoot: string): void {
  assertSafeCrewDirPath(crewDir(repoRoot));
  for (const dir of [jobsDir(repoRoot), logsDir(repoRoot), worktreesDir(repoRoot)]) {
    assertSafeCrewDirPath(dir);
    mkdirSync(dir, { recursive: true });
  }
}

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId);
}

export function assertValidJobId(jobId: string): void {
  if (!isValidJobId(jobId)) {
    throw new CrewCliError(
      "INVALID_JOB_ID",
      `Invalid job id "${jobId}".`,
      "Job ids contain only letters, digits, '_' and '-'. Run `list` to see recorded jobs.",
    );
  }
}

export function jobFilePath(repoRoot: string, jobId: string): string {
  assertValidJobId(jobId);
  return join(jobsDir(repoRoot), `${jobId}.json`);
}

export function writeJob(repoRoot: string, job: JobRecord): void {
  ensureCrewDirs(repoRoot);
  const target = jobFilePath(repoRoot, job.id);
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(job, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}

export function readJob(repoRoot: string, jobId: string): JobRecord | null {
  const target = jobFilePath(repoRoot, jobId);
  if (!existsSync(target)) return null;
  try {
    const raw = readFileSync(target, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as JobRecord;
  } catch {
    return null;
  }
}

export function listJobs(repoRoot: string): JobRecord[] {
  const dir = jobsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const jobs: JobRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.includes(".tmp.")) continue;
    const id = name.slice(0, -".json".length);
    if (!isValidJobId(id)) continue;
    const job = readJob(repoRoot, id);
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => b.start.localeCompare(a.start));
  return jobs;
}

export function appendUsage(repoRoot: string, record: UsageRecord): void {
  ensureCrewDirs(repoRoot);
  appendFileSync(usageFile(repoRoot), JSON.stringify(record) + "\n", "utf8");
}

export function generateJobId(role: string): string {
  const now = new Date();
  const pad = (n: number, len = 2): string => String(n).padStart(len, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const hex = randomBytes(2).toString("hex");
  const safeRole = role.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${safeRole}-${stamp}-${hex}`;
}

export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = match[2] ?? "s";
  switch (unit) {
    case "ms":
      return Math.round(value);
    case "s":
      return Math.round(value * 1000);
    case "m":
      return Math.round(value * 60_000);
    case "h":
      return Math.round(value * 3_600_000);
    default:
      return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCrewConfig(repoRoot: string): CrewConfig {
  const cfgPath = join(repoRoot, ".claude", "crew.json");
  if (!existsSync(cfgPath)) {
    throw new CrewCliError(
      "CONFIG_MISSING",
      `Missing crew config at ${cfgPath}.`,
      "Copy claude-agent-crew/crew.example.json to .claude/crew.json and configure roles and machines.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CrewCliError(
      "CONFIG_INVALID",
      `Invalid JSON in ${cfgPath}: ${msg}`,
      `Fix the JSON syntax in ${cfgPath}.`,
    );
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.roles)) {
    throw new CrewCliError(
      "CONFIG_INVALID",
      `Invalid ${cfgPath}: expected a top-level "roles" object.`,
      `Ensure ${cfgPath} has a "roles" object mapping role names to { worker, model, machine }.`,
    );
  }

  const roles: Record<string, RoleConfig> = {};
  for (const [roleName, rawRole] of Object.entries(parsed.roles)) {
    if (!isPlainObject(rawRole) || typeof rawRole.worker !== "string" || !rawRole.worker.trim()) {
      throw new CrewCliError(
        "CONFIG_INVALID",
        `Role "${roleName}" in ${cfgPath} must specify a string "worker".`,
        `Set "worker" (for example "agy") on role "${roleName}" in ${cfgPath}.`,
      );
    }
    roles[roleName] = {
      worker: rawRole.worker.trim(),
      model: typeof rawRole.model === "string" ? rawRole.model.trim() : undefined,
      machine: typeof rawRole.machine === "string" ? rawRole.machine.trim() : undefined,
      agent: typeof rawRole.agent === "string" && rawRole.agent.trim() !== "" ? rawRole.agent.trim() : undefined,
      maxTurns: positiveNumber(rawRole.maxTurns, "maxTurns", roleName, cfgPath, true),
      maxBudgetUsd: positiveNumber(rawRole.maxBudgetUsd, "maxBudgetUsd", roleName, cfgPath, false),
    };
  }

  const machines: Record<string, string> = {};
  if (isPlainObject(parsed.machines)) {
    for (const [k, v] of Object.entries(parsed.machines)) {
      if (typeof v === "string") machines[k] = v.trim();
    }
  }

  const paths: Record<string, string> = {};
  if (isPlainObject(parsed.paths)) {
    for (const [k, v] of Object.entries(parsed.paths)) {
      if (typeof v === "string") paths[k] = v.trim();
    }
  }

  return { roles, machines, paths };
}

/** An optional positive number (a whole number when `integer`) from a role's config; anything else is refused. */
function positiveNumber(
  value: unknown,
  field: string,
  roleName: string,
  cfgPath: string,
  integer: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  const ok = typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value));
  if (!ok) {
    throw new CrewCliError(
      "CONFIG_INVALID",
      `Role "${roleName}" in ${cfgPath} has an invalid "${field}": ${JSON.stringify(value)}.`,
      `Set "${field}" on role "${roleName}" in ${cfgPath} to a ${integer ? "whole number" : "number"} above 0, or remove it.`,
    );
  }
  return value;
}
