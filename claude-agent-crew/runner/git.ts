import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  if (res.exitCode !== 0) return true;
  return res.stdout.trim().length > 0;
}

function pathEntryExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function canonicalizePath(p: string, depth = 0): string {
  const abs = resolve(p);
  if (depth > 40) return abs;
  const trailing: string[] = [];
  let cur = abs;
  while (!pathEntryExists(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    trailing.unshift(basename(cur));
    cur = parent;
  }
  try {
    return trailing.length === 0 ? realpathSync(cur) : join(realpathSync(cur), ...trailing);
  } catch {
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(cur), readlinkSync(cur));
        const next = trailing.length === 0 ? target : join(target, ...trailing);
        return canonicalizePath(next, depth + 1);
      }
    } catch {
      // fall through
    }
    return abs;
  }
}

function isSubpath(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function isUnderWorktreesDir(repoRoot: string, wtPath: string): boolean {
  const canonRepo = canonicalizePath(repoRoot);
  const canonBase = canonicalizePath(worktreesDir(repoRoot));
  const canonTarget = canonicalizePath(wtPath);
  if (canonBase !== join(canonRepo, ".crew", "worktrees")) return false;
  if (!isSubpath(canonRepo, canonBase)) return false;
  if (!isSubpath(canonBase, canonTarget)) return false;
  return isSubpath(resolve(worktreesDir(repoRoot)), resolve(wtPath));
}

export function validateBranchName(repoRoot: string, branch: string, readOnly: boolean): void {
  if (!branch.trim() || branch.trim().startsWith("-")) {
    throw new CrewCliError(
      "INVALID_BRANCH",
      `Invalid branch or ref "${branch}".`,
      "Pass a valid branch name not starting with '-' or omit --branch.",
    );
  }
  if (!readOnly) {
    const check = runGit(repoRoot, ["check-ref-format", "--branch", branch]);
    if (check.exitCode !== 0) {
      throw new CrewCliError(
        "INVALID_BRANCH",
        `Invalid git branch name "${branch}".`,
        "Pass a valid git branch name (see `git help check-ref-format`) or omit --branch.",
      );
    }
  }
}

function sanitizeBranchSlug(branch: string): string {
  const base = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
  if (base === branch && branch !== "." && branch !== "..") {
    return base;
  }
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export interface WorktreeAssignment {
  worktree: string;
  branch: string | null;
  reused: boolean;
}

function findWorktreeHolder(
  runningJobs: JobRecord[] | undefined,
  wtPath: string,
  branchName: string,
): JobRecord | undefined {
  if (!runningJobs) return undefined;
  const canonTarget = canonicalizePath(wtPath);
  return runningJobs.find(
    (j) =>
      j.remotePath === null &&
      (canonicalizePath(j.worktree) === canonTarget || (j.branch !== null && j.branch === branchName)),
  );
}

export function prepareWorktree(
  repoRoot: string,
  opts: {
    jobId: string;
    role: string;
    branch?: string;
    continueJob?: JobRecord | null;
    runningJobs?: JobRecord[];
  },
): WorktreeAssignment {
  const readOnly = isReadOnlyRole(opts.role);
  if (opts.continueJob) {
    const prevReadOnly = isReadOnlyRole(opts.continueJob.role);
    if (prevReadOnly !== readOnly) {
      throw new CrewCliError(
        "CONTINUE_ROLE_MISMATCH",
        `Cannot continue ${prevReadOnly ? "read-only" : "builder"} job "${opts.continueJob.id}" (role "${opts.continueJob.role}") with ${readOnly ? "read-only" : "builder"} role "${opts.role}".`,
        `Use role "${opts.continueJob.role}" with --continue ${opts.continueJob.id}, or start a fresh job without --continue.`,
      );
    }
    if (opts.branch !== undefined && opts.branch !== opts.continueJob.branch) {
      throw new CrewCliError(
        "CONTINUE_BRANCH_MISMATCH",
        `Cannot pass --branch "${opts.branch}" with --continue ${opts.continueJob.id} (recorded branch: ${opts.continueJob.branch ?? "none"}).`,
        `Omit --branch to continue on "${opts.continueJob.branch ?? "HEAD"}", or start a fresh job without --continue.`,
      );
    }
    const prevWt = opts.continueJob.worktree;
    if (existsSync(prevWt)) {
      if (!isUnderWorktreesDir(repoRoot, prevWt)) {
        throw new CrewCliError(
          "WORKTREE_OUTSIDE_CREW",
          `Refusing to reuse worktree outside .crew/worktrees/: ${prevWt}`,
          "Start a fresh job so the runner creates a worktree under .crew/worktrees/.",
        );
      }
      const canonPrev = canonicalizePath(prevWt);
      const isRegistered = listWorktrees(repoRoot).some((w) => canonicalizePath(w.path) === canonPrev);
      if (isRegistered) {
        if (!readOnly && opts.continueJob.branch) {
          const external = listWorktrees(repoRoot).find(
            (w) => w.branch === opts.continueJob?.branch && !isUnderWorktreesDir(repoRoot, w.path),
          );
          if (external) {
            throw new CrewCliError(
              "BRANCH_CHECKED_OUT_ELSEWHERE",
              `Branch "${opts.continueJob.branch}" is already checked out outside .crew/worktrees/ at ${external.path}.`,
              `Switch ${external.path} to another branch or start a fresh job with a different --branch.`,
            );
          }
        }
        const holder = opts.runningJobs?.find(
          (j) => j.remotePath === null && canonicalizePath(j.worktree) === canonPrev,
        );
        if (holder) {
          throw new CrewCliError(
            "WORKTREE_IN_USE",
            `Worktree at ${prevWt} is already in use by running job "${holder.id}".`,
            `Wait for job "${holder.id}" (\`bun claude-agent-crew/runner/crew.ts wait ${holder.id}\`) before continuing.`,
          );
        }
        return { worktree: prevWt, branch: opts.continueJob.branch, reused: true };
      }
    }
  }

  const requestedBranch = opts.branch ?? opts.continueJob?.branch ?? undefined;

  if (readOnly) {
    const targetRef = requestedBranch ?? "HEAD";
    const wtPath = join(worktreesDir(repoRoot), opts.jobId);
    if (!isUnderWorktreesDir(repoRoot, wtPath)) {
      throw new CrewCliError(
        "WORKTREE_OUTSIDE_CREW",
        `Refusing to create worktree outside .crew/worktrees/: ${wtPath}`,
        "Ensure .crew/worktrees/ is a directory inside the repository, not a symlink pointing outside.",
      );
    }
    const addRes = runGit(repoRoot, ["worktree", "add", "--detach", "--", wtPath, targetRef]);
    if (addRes.exitCode !== 0) {
      throw new CrewCliError(
        "WORKTREE_CREATE_FAILED",
        `Failed to create detached worktree for "${targetRef}": ${addRes.stderr}`,
        `Verify that branch or ref "${targetRef}" exists in git and try again.`,
      );
    }
    return { worktree: wtPath, branch: requestedBranch ?? null, reused: false };
  }

  const branchName = requestedBranch ?? `crew/${opts.jobId}`;
  const matchingWorktrees = listWorktrees(repoRoot).filter((w) => w.branch === branchName);
  const external = matchingWorktrees.find((w) => !isUnderWorktreesDir(repoRoot, w.path));
  if (external) {
    throw new CrewCliError(
      "BRANCH_CHECKED_OUT_ELSEWHERE",
      `Branch "${branchName}" is already checked out outside .crew/worktrees/ at ${external.path}.`,
      `Switch ${external.path} to another branch or pass a different --branch to crew start.`,
    );
  }

  const existing = matchingWorktrees.find((w) => isUnderWorktreesDir(repoRoot, w.path));
  if (existing) {
    const holder = findWorktreeHolder(opts.runningJobs, existing.path, branchName);
    if (holder) {
      throw new CrewCliError(
        "WORKTREE_IN_USE",
        `Worktree at ${existing.path} (branch "${branchName}") is already in use by running job "${holder.id}".`,
        `Wait for job "${holder.id}" (\`bun claude-agent-crew/runner/crew.ts wait ${holder.id}\`) or pass a different --branch.`,
      );
    }
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
  if (!isUnderWorktreesDir(repoRoot, wtPath)) {
    throw new CrewCliError(
      "WORKTREE_OUTSIDE_CREW",
      `Refusing to create worktree outside .crew/worktrees/: ${wtPath}`,
      "Ensure .crew/worktrees/ is a directory inside the repository, not a symlink pointing outside.",
    );
  }
  const holder = findWorktreeHolder(opts.runningJobs, wtPath, branchName);
  if (holder) {
    throw new CrewCliError(
      "WORKTREE_IN_USE",
      `Worktree for branch "${branchName}" is already in use by running job "${holder.id}".`,
      `Wait for job "${holder.id}" (\`bun claude-agent-crew/runner/crew.ts wait ${holder.id}\`) or pass a different --branch.`,
    );
  }

  const branchExists =
    runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).exitCode === 0;
  const addArgs = branchExists
    ? ["worktree", "add", "--", wtPath, branchName]
    : ["worktree", "add", "-b", branchName, "--", wtPath, "HEAD"];
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

function localBranchExists(repoRoot: string, branch: string): boolean {
  return runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
}

function isBranchMerged(repoRoot: string, branch: string): boolean {
  const base = resolveBaseBranch(repoRoot);
  if (!base || base === branch) return false;
  if (!localBranchExists(repoRoot, branch)) return false;
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

function isBranchPresentOnOrigin(repoRoot: string, branch: string): boolean {
  const originUrl = runGit(repoRoot, ["remote", "get-url", "origin"]);
  if (originUrl.exitCode !== 0) return false;
  const remoteHeads = runGit(repoRoot, ["ls-remote", "--heads", "origin", branch]);
  if (remoteHeads.exitCode !== 0) return true; // Assume present if origin unreachable
  return remoteHeads.stdout.trim().length > 0;
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
    jobs
      .filter((j) => isRunning(j) && j.remotePath === null)
      .map((j) => canonicalizePath(j.worktree)),
  );
  const trackedList = listWorktrees(repoRoot);
  const trackedMap = new Map<string, WorktreeInfo>();
  for (const w of trackedList) {
    trackedMap.set(canonicalizePath(w.path), w);
  }

  const seenWorktrees = new Set<string>();
  const removed: string[] = [];
  const kept: Array<{ worktree: string; reason: string }> = [];

  for (const job of jobs) {
    if (job.remotePath !== null) continue;
    const wt = resolve(job.worktree);
    const canonWt = canonicalizePath(wt);
    if (canonWt === canonicalizePath(repoRoot)) continue;
    if (seenWorktrees.has(canonWt)) continue;
    if (!existsSync(wt) && !trackedMap.has(canonWt)) continue;
    seenWorktrees.add(canonWt);

    if (!isUnderWorktreesDir(repoRoot, wt)) {
      kept.push({ worktree: wt, reason: "outside .crew/worktrees/" });
      continue;
    }

    if (activeWorktrees.has(canonWt)) {
      kept.push({ worktree: wt, reason: "job still running" });
      continue;
    }

    if (isWorktreeDirty(wt)) {
      kept.push({ worktree: wt, reason: "worktree has uncommitted changes" });
      continue;
    }

    if (!existsSync(wt)) {
      runGit(repoRoot, ["worktree", "prune"]);
      if (!listWorktrees(repoRoot).some((w) => canonicalizePath(w.path) === canonWt)) {
        removed.push(wt);
      } else {
        kept.push({ worktree: wt, reason: "worktree prune did not remove entry" });
      }
      continue;
    }

    if (isReadOnlyRole(job.role)) {
      const rm = runGit(repoRoot, ["worktree", "remove", wt]);
      if (rm.exitCode === 0) {
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

    const wtInfo = trackedMap.get(canonWt);
    if (wtInfo?.detached && localBranchExists(repoRoot, branch)) {
      kept.push({ worktree: wt, reason: "builder worktree is in detached HEAD state" });
      continue;
    }
    const effectiveBranch = wtInfo?.branch ?? branch;

    if (localBranchExists(repoRoot, effectiveBranch)) {
      const merged = isBranchMerged(repoRoot, effectiveBranch);
      const deletedRemote = isBranchDeletedOnOrigin(repoRoot, effectiveBranch);
      if (!merged && !deletedRemote) {
        kept.push({ worktree: wt, reason: `branch "${effectiveBranch}" not merged or deleted on origin` });
        continue;
      }
    } else if (isBranchPresentOnOrigin(repoRoot, effectiveBranch)) {
      kept.push({ worktree: wt, reason: `branch "${effectiveBranch}" still exists on origin` });
      continue;
    }

    // Never force-remove a builder worktree
    const rm = runGit(repoRoot, ["worktree", "remove", wt]);
    if (rm.exitCode === 0) {
      removed.push(wt);
    } else {
      kept.push({ worktree: wt, reason: rm.stderr || "worktree remove failed" });
    }
  }

  runGit(repoRoot, ["worktree", "prune"]);
  return { removed, kept };
}
