import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSshStartCommand, toRemoteBriefPath } from "./worker.ts";

const CREW_TS = resolve(import.meta.dir, "crew.ts");
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface TestEnv {
  root: string;
  home: string;
  binDir: string;
  repo: string;
  env: Record<string, string>;
}

function setupRepo(crewJson?: Record<string, unknown>): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "crew-test-"));
  tempRoots.push(root);
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(repo, ".claude"), { recursive: true });

  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };

  const git = (args: string[], cwd = repo): void => {
    const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    }
  };

  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "README.md"), "# Test Repo\n", "utf8");

  const defaultConfig = crewJson ?? {
    roles: {
      builder: { worker: "agy", model: "gemini-4-hydrogen-medium", machine: "local" },
      reviewer: { worker: "agy", model: "gemini-4-hydrogen-high", machine: "local" },
      "design-check": { worker: "agy", model: "gemini-3.8-flash-medium", machine: "local" },
      auditor: { worker: "claude", machine: "local" },
      remote: { worker: "agy", model: "gemini-4-hydrogen-medium", machine: "dev-pc" },
    },
    machines: { local: "local", "dev-pc": "ssh factory@dev-pc" },
    paths: { "dev-pc": "/srv/repo" },
  };
  writeFileSync(join(repo, ".claude", "crew.json"), JSON.stringify(defaultConfig, null, 2), "utf8");
  git(["add", "README.md", ".claude/crew.json"]);
  git(["commit", "-m", "initial commit"]);

  return { root, home, binDir, repo, env };
}

function installFakeAgy(binDir: string, scriptBody: string): void {
  const agyPath = join(binDir, "agy");
  writeFileSync(agyPath, `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`, "utf8");
  chmodSync(agyPath, 0o755);
}

function runCrew(
  t: TestEnv,
  args: string[],
  cwd = t.repo,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, CREW_TS, ...args], {
    cwd,
    env: t.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function extractJobId(startStdout: string): string {
  const m = /Started job (\S+)/.exec(startStdout);
  if (!m || !m[1]) throw new Error(`Could not extract job id from:\n${startStdout}`);
  return m[1];
}

describe("crew job runner", () => {
  test("start -> wait (exit 0) -> result -> usage.jsonl -> .git/info/exclude", () => {
    const t = setupRepo();
    const argsLog = join(t.root, "agy-args.txt");
    installFakeAgy(
      t.binDir,
      `
printf '%s\n' "$@" > "${argsLog}"
cat <<'JSON'
{
  "conversation_id": "conv-123",
  "result": "Status: DONE\\nImplemented feature X.",
  "is_error": false,
  "usage": { "input_tokens": 120, "output_tokens": 45 }
}
JSON
`,
    );

    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Build feature X.\n", "utf8");

    const start = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/x"]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);
    expect(start.stdout).toContain(`wait ${jobId}`);

    const wait = runCrew(t, ["wait", jobId, "--timeout", "10s"]);
    expect(wait.exitCode).toBe(0);
    expect(wait.stdout).toContain(`result ${jobId}`);

    const res = runCrew(t, ["result", jobId]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.split("\n")[0]).toBe("Status: DONE");
    expect(res.stdout).toContain("Implemented feature X.");

    // Verify agy flags
    const recordedArgs = readFileSync(argsLog, "utf8");
    expect(recordedArgs).toContain("--agent");
    expect(recordedArgs).toContain("builder");
    expect(recordedArgs).toContain("--model");
    expect(recordedArgs).toContain("gemini-4-hydrogen-medium");
    expect(recordedArgs).toContain("--output-format");
    expect(recordedArgs).toContain("json");
    expect(recordedArgs).toContain("--add-dir");
    expect(recordedArgs).toContain("--settings");

    // Verify .crew/ state and .git/info/exclude (never .gitignore)
    expect(existsSync(join(t.repo, ".gitignore"))).toBe(false);
    const exclude = readFileSync(join(t.repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".crew/");

    const jobJson = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${jobId}.json`), "utf8")) as {
      role: string;
      worker: string;
      model: string;
      machine: string;
      branch: string;
      conversationId: string;
      exit: number;
    };
    expect(jobJson.role).toBe("builder");
    expect(jobJson.worker).toBe("agy");
    expect(jobJson.model).toBe("gemini-4-hydrogen-medium");
    expect(jobJson.machine).toBe("local");
    expect(jobJson.branch).toBe("feat/x");
    expect(jobJson.conversationId).toBe("conv-123");
    expect(jobJson.exit).toBe(0);

    const usageLines = readFileSync(join(t.repo, ".crew", "usage.jsonl"), "utf8").trim().split("\n");
    expect(usageLines.length).toBe(1);
    const usageRec = JSON.parse(usageLines[0] ?? "{}") as {
      role: string;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(usageRec.role).toBe("builder");
    expect(usageRec.model).toBe("gemini-4-hydrogen-medium");
    expect(usageRec.usage.input_tokens).toBe(120);
    expect(usageRec.usage.output_tokens).toBe(45);
  });

  test("exit code 1 for invalid commands and claude worker not yet supported (T5)", () => {
    const t = setupRepo();
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Audit repo.\n", "utf8");

    const badCmd = runCrew(t, ["bogus"]);
    expect(badCmd.exitCode).toBe(1);
    const badErr = JSON.parse(badCmd.stderr) as { code: string; message: string; fix: string };
    expect(badErr.code).toBe("UNKNOWN_COMMAND");

    const claudeCmd = runCrew(t, ["start", "--role", "auditor", "--brief", briefPath]);
    expect(claudeCmd.exitCode).toBe(1);
    const claudeErr = JSON.parse(claudeCmd.stderr) as { code: string; message: string; fix: string };
    expect(claudeErr.code).toBe("WORKER_NOT_SUPPORTED");
    expect(claudeErr.message).toContain("not yet supported (T5)");
    expect(claudeErr.fix.length).toBeGreaterThan(0);
  });

  test("exit code 2 when wait times out, and exit code 4 on cancel", async () => {
    const t = setupRepo();
    installFakeAgy(
      t.binDir,
      `
sleep 30
echo '{"result":"Status: DONE"}'
`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Long task.\n", "utf8");

    const start = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/slow"]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);

    const waitStillRunning = runCrew(t, ["wait", jobId, "--timeout", "150ms"]);
    expect(waitStillRunning.exitCode).toBe(2);
    expect(waitStillRunning.stdout).toContain("still running");

    const cancel = runCrew(t, ["cancel", jobId]);
    expect(cancel.exitCode).toBe(0);
    expect(cancel.stdout).toContain(`Canceled job ${jobId}`);

    const waitCanceled = runCrew(t, ["wait", jobId, "--timeout", "1s"]);
    expect(waitCanceled.exitCode).toBe(4);

    // Give OS a moment to reap killed process group
    await Bun.sleep(50);
    const status = runCrew(t, ["status", jobId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Status: canceled");
  });

  test("exit code 3 on worker failure or empty response", () => {
    const t = setupRepo();
    installFakeAgy(
      t.binDir,
      `
echo '{"is_error":true,"result":"boom"}'
exit 1
`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Fail task.\n", "utf8");

    const start = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/fail"]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);

    const wait = runCrew(t, ["wait", jobId, "--timeout", "10s"]);
    expect(wait.exitCode).toBe(3);

    // Also test exit 0 with empty response (not "accepted" as done)
    installFakeAgy(t.binDir, `echo '{"result":""}'`);
    const start2 = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/empty"]);
    expect(start2.exitCode).toBe(0);
    const jobId2 = extractJobId(start2.stdout);
    const wait2 = runCrew(t, ["wait", jobId2, "--timeout", "10s"]);
    expect(wait2.exitCode).toBe(3);
  });

  test("exit code 5 (attention) and --continue passes --conversation <id>", () => {
    const t = setupRepo();
    const argsLog = join(t.root, "agy-continue-args.txt");
    installFakeAgy(
      t.binDir,
      `
cat <<'JSON'
{
  "conversation_id": "conv-resumable-99",
  "subtype": "timeout",
  "result": "Partial progress saved."
}
JSON
`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Complex task.\n", "utf8");

    const start1 = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/cont"]);
    expect(start1.exitCode).toBe(0);
    const jobId1 = extractJobId(start1.stdout);

    const wait1 = runCrew(t, ["wait", jobId1, "--timeout", "10s"]);
    expect(wait1.exitCode).toBe(5);
    expect(wait1.stdout).toContain(`--continue ${jobId1}`);

    // Now switch fake agy to succeed and record args
    installFakeAgy(
      t.binDir,
      `
printf '%s\n' "$@" > "${argsLog}"
echo '{"conversation_id":"conv-resumable-99","result":"Status: DONE\\nFinished after continue."}'
`,
    );
    const start2 = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      briefPath,
      "--continue",
      jobId1,
    ]);
    expect(start2.exitCode).toBe(0);
    const jobId2 = extractJobId(start2.stdout);

    const wait2 = runCrew(t, ["wait", jobId2, "--timeout", "10s"]);
    expect(wait2.exitCode).toBe(0);

    const recordedArgs = readFileSync(argsLog, "utf8");
    expect(recordedArgs).toContain("--conversation");
    expect(recordedArgs).toContain("conv-resumable-99");
  });

  test("worktree create, reuse, dirty-workspace refusal, and clean", () => {
    const t = setupRepo();
    installFakeAgy(t.binDir, `echo '{"conversation_id":"c1","result":"Status: DONE\\nok"}'`);
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    // 1. Builder creates branch worktree
    const b1 = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/wt"]);
    expect(b1.exitCode).toBe(0);
    const b1Id = extractJobId(b1.stdout);
    expect(runCrew(t, ["wait", b1Id, "--timeout", "10s"]).exitCode).toBe(0);
    const b1Job = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${b1Id}.json`), "utf8")) as {
      worktree: string;
    };
    expect(existsSync(b1Job.worktree)).toBe(true);

    // 2. Clean builder worktree can be reused
    const b2 = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/wt"]);
    expect(b2.exitCode).toBe(0);
    const b2Id = extractJobId(b2.stdout);
    expect(runCrew(t, ["wait", b2Id, "--timeout", "10s"]).exitCode).toBe(0);
    const b2Job = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${b2Id}.json`), "utf8")) as {
      worktree: string;
    };
    expect(b2Job.worktree).toBe(b1Job.worktree);

    // 3. Dirty builder worktree refuses a fresh job
    writeFileSync(join(b1Job.worktree, "uncommitted.txt"), "dirty\n", "utf8");
    const dirty = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/wt"]);
    expect(dirty.exitCode).toBe(1);
    const dirtyErr = JSON.parse(dirty.stderr) as { code: string };
    expect(dirtyErr.code).toBe("DIRTY_WORKSPACE");

    // 4. Reviewer gets a detached worktree
    const rev = runCrew(t, ["start", "--role", "reviewer", "--brief", briefPath, "--branch", "feat/wt"]);
    expect(rev.exitCode).toBe(0);
    const revId = extractJobId(rev.stdout);
    expect(runCrew(t, ["wait", revId, "--timeout", "10s"]).exitCode).toBe(0);
    const revJob = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${revId}.json`), "utf8")) as {
      worktree: string;
    };
    expect(existsSync(revJob.worktree)).toBe(true);

    // 5. Commit a change on feat/wt so it is unmerged, then run clean:
    // reviewer worktree is removed, unmerged builder worktree is kept
    Bun.spawnSync(["git", "add", "uncommitted.txt"], { cwd: b1Job.worktree, env: t.env });
    Bun.spawnSync(["git", "commit", "-m", "work on feat/wt"], { cwd: b1Job.worktree, env: t.env });

    const clean1 = runCrew(t, ["clean"]);
    expect(clean1.exitCode).toBe(0);
    expect(existsSync(revJob.worktree)).toBe(false);
    expect(existsSync(b1Job.worktree)).toBe(true);

    // 6. Merge feat/wt into main, then clean removes the builder worktree too
    Bun.spawnSync(["git", "merge", "--no-ff", "feat/wt", "-m", "merge feat/wt"], {
      cwd: t.repo,
      env: t.env,
    });
    const clean2 = runCrew(t, ["clean"]);
    expect(clean2.exitCode).toBe(0);
    expect(existsSync(b1Job.worktree)).toBe(false);
  });

  test("clean removes builder worktree when branch is deleted on origin", () => {
    const t = setupRepo();
    const bareOrigin = join(t.root, "origin.git");
    Bun.spawnSync(["git", "init", "--bare", bareOrigin], { env: t.env });
    Bun.spawnSync(["git", "remote", "add", "origin", bareOrigin], { cwd: t.repo, env: t.env });
    Bun.spawnSync(["git", "push", "-u", "origin", "main"], { cwd: t.repo, env: t.env });

    installFakeAgy(t.binDir, `echo '{"conversation_id":"c1","result":"Status: DONE\\nok"}'`);
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    const start = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/remote-del"]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);
    expect(runCrew(t, ["wait", jobId, "--timeout", "10s"]).exitCode).toBe(0);
    const job = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${jobId}.json`), "utf8")) as {
      worktree: string;
    };

    writeFileSync(join(job.worktree, "file.txt"), "hello\n", "utf8");
    Bun.spawnSync(["git", "add", "file.txt"], { cwd: job.worktree, env: t.env });
    Bun.spawnSync(["git", "commit", "-m", "feat commit"], { cwd: job.worktree, env: t.env });
    Bun.spawnSync(["git", "push", "-u", "origin", "feat/remote-del"], { cwd: job.worktree, env: t.env });
    // Delete branch on origin (without pruning local remote-tracking ref)
    Bun.spawnSync(["git", "push", "origin", "--delete", "feat/remote-del"], { cwd: t.repo, env: t.env });

    const clean = runCrew(t, ["clean"]);
    expect(clean.exitCode).toBe(0);
    expect(existsSync(job.worktree)).toBe(false);
  });

  test("ssh machine command building", () => {
    const cmd = buildSshStartCommand({
      sshCommand: "ssh -p 2222 factory@dev-pc",
      remotePath: "/srv/my repo",
      role: "builder",
      briefArg: "briefs/t4.md",
      branch: "feat/ssh",
      continueJobId: "builder-1",
      timeout: "15m",
    });

    expect(cmd.slice(0, 4)).toEqual(["ssh", "-p", "2222", "factory@dev-pc"]);
    const remoteShell = cmd[4] ?? "";
    expect(remoteShell).toContain("cd '/srv/my repo' && ");
    expect(remoteShell).toContain("'bun' 'claude-agent-crew/runner/crew.ts' 'start'");
    expect(remoteShell).toContain("'--role' 'builder'");
    expect(remoteShell).toContain("'--brief' 'briefs/t4.md'");
    expect(remoteShell).toContain("'--local'");
    expect(remoteShell).toContain("'--branch' 'feat/ssh'");
    expect(remoteShell).toContain("'--continue' 'builder-1'");
    expect(remoteShell).toContain("'--timeout' '15m'");

    expect(toRemoteBriefPath("/repo", "/repo/docs/brief.md")).toBe("docs/brief.md");
  });
});
