import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { JobRecord } from "./types.ts";
import { CrewCliError } from "./types.ts";
import { worktreesDir } from "./store.ts";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString().trimEnd(),
    stderr: proc.stderr.toString().trimEnd(),
  };
}

export function getRepoRoot(cwd: string): string {
  const res = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    throw new CrewCliError(
      "NOT_A_GIT_REPO",
      `Not inside a git repository (cwd: ${cwd}).`,
      "Run this command from inside your project's git repository.",
    );
  }
  return resolve(res.stdout.trim());
}

export function ensureCrewExcluded(repoRoot: string): void {
  const res = runGit(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    throw new CrewCliError(
      "GIT_EXCLUDE_FAILED",
      `Could not locate .git/info/exclude: ${res.stderr}`,
      "Ensure this directory is a valid git repository.",
    );
  }
  const rawPath = res.stdout.trim();
  const excludePath = isAbsolute(rawPath) ? rawPath : resolve(repoRoot, rawPath);
  mkdirSync(dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(".crew/") || lines.includes(".crew")) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(excludePath, `${existing}${prefix}.crew/\n`, "utf8");
}

const READ_ONLY_ROLES = new Set([
  "reviewer",
  "security-reviewer",
  "architecture-reviewer",
  "auditor",
  "researcher",
  "design-check",
]);

export function isReadOnlyRole(role: string): boolean {
  return READ_ONLY_ROLES.has(role) || role.endsWith("-reviewer") || role.endsWith("-check");
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  detached: boolean;
}

export function listWorktrees(repoRoot: string): WorktreeInfo[] {
  const res = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  if (res.exitCode !== 0) return [];
  const entries: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: resolve(line.slice("worktree ".length)), branch: null, detached: false };
    } else if (current && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (current && line === "detached") {
      current.detached = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function isWorktreeDirty(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const res = runGit(worktreePath, ["status", "--porcelain"]);
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}

function sanitizeBranchSlug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export interface WorktreeAssignment {
  worktree: string;
  branch: string | null;
  reused: boolean;
}

export function prepareWorktree(
  repoRoot: string,
  opts: {
    jobId: string;
    role: string;
    branch?: string;
    continueJob?: JobRecord | null;
  },
): WorktreeAssignment {
  if (opts.continueJob) {
    const prevWt = opts.continueJob.worktree;
    if (existsSync(prevWt)) {
      return { worktree: prevWt, branch: opts.continueJob.branch, reused: true };
    }
  }

  const readOnly = isReadOnlyRole(opts.role);
  if (readOnly) {
    const targetRef = opts.branch ?? "HEAD";
    const wtPath = join(worktreesDir(repoRoot), opts.jobId);
    const addRes = runGit(repoRoot, ["worktree", "add", "--detach", wtPath, targetRef]);
    if (addRes.exitCode !== 0) {
      throw new CrewCliError(
        "WORKTREE_CREATE_FAILED",
        `Failed to create detached worktree for "${targetRef}": ${addRes.stderr}`,
        `Verify that branch or ref "${targetRef}" exists in git and try again.`,
      );
    }
    return { worktree: wtPath, branch: opts.branch ?? null, reused: false };
  }

  const branchName = opts.branch ?? `crew/${opts.jobId}`;
  const existing = listWorktrees(repoRoot).find((w) => w.branch === branchName);
  if (existing) {
    if (isWorktreeDirty(existing.path)) {
      throw new CrewCliError(
        "DIRTY_WORKSPACE",
        `Worktree for branch "${branchName}" at ${existing.path} has uncommitted changes.`,
        `Commit or stash changes in ${existing.path}, or pass --continue <job-id> to resume an existing job.`,
      );
    }
    return { worktree: existing.path, branch: branchName, reused: true };
  }

  const wtPath = join(worktreesDir(repoRoot), sanitizeBranchSlug(branchName));
  const branchExists =
    runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).exitCode === 0;
  const addArgs = branchExists
    ? ["worktree", "add", wtPath, branchName]
    : ["worktree", "add", "-b", branchName, wtPath, "HEAD"];
  const addRes = runGit(repoRoot, addArgs);
  if (addRes.exitCode !== 0) {
    throw new CrewCliError(
      "WORKTREE_CREATE_FAILED",
      `Failed to create worktree for branch "${branchName}": ${addRes.stderr}`,
      `Check git worktree state with \`git worktree list\` and try again.`,
    );
  }
  return { worktree: wtPath, branch: branchName, reused: false };
}

function resolveBaseBranch(repoRoot: string): string | null {
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const res = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", candidate]);
    if (res.exitCode === 0) return candidate;
  }
  return null;
}

function isBranchMerged(repoRoot: string, branch: string): boolean {
  const base = resolveBaseBranch(repoRoot);
  if (!base || base === branch) return false;
  const branchExists =
    runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
  if (!branchExists) return false;
  const res = runGit(repoRoot, ["merge-base", "--is-ancestor", branch, base]);
  return res.exitCode === 0;
}

function isBranchDeletedOnOrigin(repoRoot: string, branch: string): boolean {
  const originUrl = runGit(repoRoot, ["remote", "get-url", "origin"]);
  if (originUrl.exitCode !== 0) return false;
  const hadRemoteTracking =
    runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).exitCode === 0 ||
    runGit(repoRoot, ["config", "--get", `branch.${branch}.remote`]).stdout.trim() === "origin";
  if (!hadRemoteTracking) return false;
  const remoteHeads = runGit(repoRoot, ["ls-remote", "--heads", "origin", branch]);
  if (remoteHeads.exitCode !== 0) return false;
  return remoteHeads.stdout.trim().length === 0;
}

export interface CleanResult {
  removed: string[];
  kept: Array<{ worktree: string; reason: string }>;
}

export function cleanFinishedWorktrees(
  repoRoot: string,
  jobs: JobRecord[],
  isRunning: (job: JobRecord) => boolean,
): CleanResult {
  const activeWorktrees = new Set(
    jobs.filter((j) => isRunning(j)).map((j) => resolve(j.worktree)),
  );
  const trackedWorktrees = new Set(listWorktrees(repoRoot).map((w) => resolve(w.path)));
  const removedSet = new Set<string>();
  const removed: string[] = [];
  const kept: Array<{ worktree: string; reason: string }> = [];

  for (const job of jobs) {
    const wt = resolve(job.worktree);
    if (wt === resolve(repoRoot)) continue;
    if (removedSet.has(wt)) continue;
    if (!existsSync(wt) && !trackedWorktrees.has(wt)) continue;

    if (activeWorktrees.has(wt)) {
      kept.push({ worktree: wt, reason: "job still running" });
      continue;
    }

    if (isReadOnlyRole(job.role)) {
      const rm = runGit(repoRoot, ["worktree", "remove", "--force", wt]);
      if (rm.exitCode === 0) {
        removedSet.add(wt);
        removed.push(wt);
      } else {
        kept.push({ worktree: wt, reason: rm.stderr || "worktree remove failed" });
      }
      continue;
    }

    const branch = job.branch;
    if (!branch) {
      kept.push({ worktree: wt, reason: "builder job has no branch recorded" });
      continue;
    }

    const merged = isBranchMerged(repoRoot, branch);
    const deletedRemote = isBranchDeletedOnOrigin(repoRoot, branch);
    if (!merged && !deletedRemote) {
      kept.push({ worktree: wt, reason: `branch "${branch}" not merged or deleted on origin` });
      continue;
    }

    const rm = runGit(repoRoot, ["worktree", "remove", "--force", wt]);
    if (rm.exitCode === 0) {
      removedSet.add(wt);
      removed.push(wt);
    } else {
      kept.push({ worktree: wt, reason: rm.stderr || "worktree remove failed" });
    }
  }

  runGit(repoRoot, ["worktree", "prune"]);
  return { removed, kept };
}
