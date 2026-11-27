import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CREW_TS = resolve(import.meta.dir, "crew.ts");
const tempRoots: string[] = [];
const spawnedPids: number[] = [];

afterEach(() => {
  while (spawnedPids.length > 0) {
    const pid = spawnedPids.pop();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }
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

function setupRepo(crewJson?: Record<string, unknown>, repoFolderName = "repo"): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "crew-test-"));
  tempRoots.push(root);
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const repo = join(root, repoFolderName);
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
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "tag.gpgsign", "false"]);
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

  test("remote ssh start -> list -> status -> wait -> result -> cancel via fake ssh on PATH", async () => {
    const t = setupRepo();
    const remoteRepo = join(t.root, "remote repo");
    mkdirSync(join(remoteRepo, ".claude"), { recursive: true });

    const rGit = (args: string[], cwd = remoteRepo): void => {
      const r = Bun.spawnSync(["git", ...args], { cwd, env: t.env, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) {
        throw new Error(`remote git ${args.join(" ")} failed: ${r.stderr.toString()}`);
      }
    };

    const remoteConfig = {
      roles: {
        remote: { worker: "agy", model: "gemini-4-hydrogen-medium", machine: "dev-pc" },
      },
      machines: { local: "local", "dev-pc": "ssh -p 2222 factory@dev-pc" },
      paths: { "dev-pc": remoteRepo },
    };
    rGit(["init", "-b", "main"]);
    rGit(["config", "user.email", "test@example.com"]);
    rGit(["config", "user.name", "Test User"]);
    rGit(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(remoteRepo, "README.md"), "# Remote\n", "utf8");
    writeFileSync(join(remoteRepo, "..foo.md"), "Remote dotdot brief.\n", "utf8");
    writeFileSync(join(remoteRepo, ".claude", "crew.json"), JSON.stringify(remoteConfig, null, 2), "utf8");
    rGit(["add", "README.md", "..foo.md", ".claude/crew.json"]);
    rGit(["commit", "-m", "remote init"]);

    // Point local repo's dev-pc path to remoteRepo
    writeFileSync(
      join(t.repo, ".claude", "crew.json"),
      JSON.stringify(
        {
          roles: {
            builder: { worker: "agy", model: "gemini-4-hydrogen-medium", machine: "local" },
            remote: { worker: "agy", model: "gemini-4-hydrogen-medium", machine: "dev-pc" },
          },
          machines: { local: "local", "dev-pc": "ssh -p 2222 factory@dev-pc" },
          paths: { "dev-pc": remoteRepo },
        },
        null,
        2,
      ),
      "utf8",
    );

    const sshLog = join(t.root, "ssh-calls.log");
    const sshBin = join(t.binDir, "ssh");
    writeFileSync(
      sshBin,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${sshLog}"
remote_cmd="\${@: -1}"
rewritten="\${remote_cmd//claude-agent-crew\\/runner\\/crew.ts/${CREW_TS}}"
bash -c "$rewritten"
`,
      "utf8",
    );
    chmodSync(sshBin, 0o755);

    installFakeAgy(
      t.binDir,
      `echo '{"conversation_id":"remote-conv-1","result":"Status: DONE\\nRemote work done."}'`,
    );

    // Use a brief file named ..foo.md inside repoRoot (must be sent as relative "..foo.md")
    const dotdotBrief = join(t.repo, "..foo.md");
    writeFileSync(dotdotBrief, "Remote dotdot brief.\n", "utf8");

    const start = runCrew(t, [
      "start",
      "--role",
      "remote",
      "--brief",
      dotdotBrief,
      "--branch",
      "feat/ssh",
      "--timeout",
      "15m",
    ]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);
    expect(start.stdout).toContain(`wait ${jobId}`);

    const sshCalls = readFileSync(sshLog, "utf8");
    expect(sshCalls).toContain("-p 2222 factory@dev-pc");
    expect(sshCalls).toContain(`cd '${remoteRepo}' && `);
    expect(sshCalls).toContain("'--brief' '..foo.md'");
    expect(sshCalls).toContain("'--local'");
    expect(sshCalls).toContain("'--branch' 'feat/ssh'");
    expect(sshCalls).toContain("'--timeout' '15m'");

    // Local JobRecord must exist with remotePath set
    const localRecord = JSON.parse(
      readFileSync(join(t.repo, ".crew", "jobs", `${jobId}.json`), "utf8"),
    ) as { remotePath: string | null; machine: string; status: string };
    expect(localRecord.remotePath).toBe(remoteRepo);
    expect(localRecord.machine).toBe("dev-pc");

    // list shows the remote job
    const listRes = runCrew(t, ["list"]);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain(jobId);

    // wait, status, and result proxy over SSH
    const wait = runCrew(t, ["wait", jobId, "--timeout", "10s"]);
    expect(wait.exitCode).toBe(0);
    expect(wait.stdout).toContain(`Job ${jobId} done.`);

    const status = runCrew(t, ["status", jobId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Status: done");

    const result = runCrew(t, ["result", jobId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status: DONE");
    expect(result.stdout).toContain("Remote work done.");

    // Also test remote cancel
    installFakeAgy(t.binDir, `sleep 30\necho '{"result":"Status: DONE"}'`);
    const startSlow = runCrew(t, [
      "start",
      "--role",
      "remote",
      "--brief",
      dotdotBrief,
      "--branch",
      "feat/ssh-cancel",
    ]);
    expect(startSlow.exitCode).toBe(0);
    const slowId = extractJobId(startSlow.stdout);

    const cancelRes = runCrew(t, ["cancel", slowId]);
    expect(cancelRes.stderr).toBe("");
    expect(cancelRes.exitCode).toBe(0);
    expect(cancelRes.stdout).toContain(`Canceled job ${slowId}`);

    await Bun.sleep(50);
    const slowResult = runCrew(t, ["result", slowId]);
    expect(slowResult.exitCode).toBe(4);
    expect(slowResult.stdout).toContain("Status: CANCELED");
  });

  test("worktree safety: refuses branches checked out in repoRoot or external worktrees, and clean ignores external paths", () => {
    const t = setupRepo();
    const agyMarker = join(t.root, "agy-ran.txt");
    installFakeAgy(
      t.binDir,
      `touch "${agyMarker}"\necho '{"conversation_id":"c1","result":"Status: DONE\\nok"}'`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    // 1. Refuse --branch main when main is checked out in repoRoot
    const mainStart = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "main"]);
    expect(mainStart.exitCode).toBe(1);
    const mainErr = JSON.parse(mainStart.stderr) as { code: string };
    expect(mainErr.code).toBe("BRANCH_CHECKED_OUT_ELSEWHERE");
    expect(existsSync(agyMarker)).toBe(false);

    // 2. Refuse branch checked out in a human's separate worktree outside .crew/worktrees/
    const humanWt = join(t.root, "human-wt");
    const addWt = Bun.spawnSync(["git", "worktree", "add", "-b", "feat/human", humanWt, "HEAD"], {
      cwd: t.repo,
      env: t.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(addWt.exitCode).toBe(0);

    const humanStart = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      briefPath,
      "--branch",
      "feat/human",
    ]);
    expect(humanStart.exitCode).toBe(1);
    const humanErr = JSON.parse(humanStart.stderr) as { code: string };
    expect(humanErr.code).toBe("BRANCH_CHECKED_OUT_ELSEWHERE");
    expect(existsSync(agyMarker)).toBe(false);

    // 3. Even if a JobRecord points to humanWt and feat/human is merged, clean never removes humanWt
    mkdirSync(join(t.repo, ".crew", "jobs"), { recursive: true });
    writeFileSync(
      join(t.repo, ".crew", "jobs", "bogus-human-1.json"),
      JSON.stringify(
        {
          id: "bogus-human-1",
          role: "builder",
          worker: "agy",
          model: null,
          machine: "local",
          machineTarget: "local",
          remotePath: null,
          branch: "feat/human",
          worktree: humanWt,
          briefFile: briefPath,
          pid: null,
          start: new Date().toISOString(),
          end: new Date().toISOString(),
          exit: 0,
          status: "done",
          conversationId: null,
          continuedFrom: null,
          logFile: "",
          stdoutFile: "",
          resultText: "ok",
          error: null,
        },
        null,
        2,
      ),
      "utf8",
    );

    const cleanRes = runCrew(t, ["clean"]);
    expect(cleanRes.exitCode).toBe(0);
    expect(existsSync(humanWt)).toBe(true);
    expect(cleanRes.stdout).toContain("outside .crew/worktrees/");
  });

  test("clean never removes dirty 0-commit builder worktrees, dirty reviewer worktrees, or running worktrees; removes locally deleted branches", () => {
    const t = setupRepo();
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    // 1. Builder fails before making any commit (0 commits ahead of main), leaving dirty file
    installFakeAgy(
      t.binDir,
      `
echo "important uncommitted work" > uncommitted-builder.txt
echo '{"is_error":true,"result":"failed mid-task"}'
exit 1
`,
    );
    const failStart = runCrew(t, ["start", "--role", "builder", "--brief", briefPath]);
    expect(failStart.exitCode).toBe(0);
    const failId = extractJobId(failStart.stdout);
    expect(runCrew(t, ["wait", failId, "--timeout", "10s"]).exitCode).toBe(3);

    const failJob = JSON.parse(
      readFileSync(join(t.repo, ".crew", "jobs", `${failId}.json`), "utf8"),
    ) as { worktree: string };
    expect(existsSync(join(failJob.worktree, "uncommitted-builder.txt"))).toBe(true);

    // 2. Reviewer creates a detached worktree and leaves it dirty
    installFakeAgy(
      t.binDir,
      `
echo "reviewer scratch" > scratch.txt
echo '{"conversation_id":"rev-1","result":"Status: DONE\\nreviewed"}'
`,
    );
    const revStart = runCrew(t, ["start", "--role", "reviewer", "--brief", briefPath, "--branch", "main"]);
    expect(revStart.exitCode).toBe(0);
    const revId = extractJobId(revStart.stdout);
    expect(runCrew(t, ["wait", revId, "--timeout", "10s"]).exitCode).toBe(0);
    const revJob = JSON.parse(
      readFileSync(join(t.repo, ".crew", "jobs", `${revId}.json`), "utf8"),
    ) as { worktree: string };

    // Verify reviewer worktree is detached
    const symRef = Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], {
      cwd: revJob.worktree,
      env: t.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(symRef.exitCode).not.toBe(0);

    // 3. Running job's worktree is kept by clean
    installFakeAgy(t.binDir, `sleep 30\necho '{"result":"Status: DONE"}'`);
    const slowStart = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/running-wt"]);
    expect(slowStart.exitCode).toBe(0);
    const slowId = extractJobId(slowStart.stdout);
    const slowJob = JSON.parse(
      readFileSync(join(t.repo, ".crew", "jobs", `${slowId}.json`), "utf8"),
    ) as { worktree: string };

    const clean1 = runCrew(t, ["clean"]);
    expect(clean1.exitCode).toBe(0);
    expect(existsSync(join(failJob.worktree, "uncommitted-builder.txt"))).toBe(true);
    expect(existsSync(join(revJob.worktree, "scratch.txt"))).toBe(true);
    expect(existsSync(slowJob.worktree)).toBe(true);

    expect(runCrew(t, ["cancel", slowId]).exitCode).toBe(0);

    // 4. Clean removes builder worktree when local branch was deleted
    installFakeAgy(t.binDir, `echo '{"conversation_id":"c-del","result":"Status: DONE\\nok"}'`);
    const delStart = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/local-del"]);
    expect(delStart.exitCode).toBe(0);
    const delId = extractJobId(delStart.stdout);
    expect(runCrew(t, ["wait", delId, "--timeout", "10s"]).exitCode).toBe(0);
    const delJob = JSON.parse(
      readFileSync(join(t.repo, ".crew", "jobs", `${delId}.json`), "utf8"),
    ) as { worktree: string };

    writeFileSync(join(delJob.worktree, "committed.txt"), "hi\n", "utf8");
    Bun.spawnSync(["git", "add", "committed.txt"], { cwd: delJob.worktree, env: t.env });
    Bun.spawnSync(["git", "commit", "-m", "temp commit"], { cwd: delJob.worktree, env: t.env });
    // Detach the worktree and delete the local branch ref
    Bun.spawnSync(["git", "checkout", "--detach"], { cwd: delJob.worktree, env: t.env });
    Bun.spawnSync(["git", "branch", "-D", "feat/local-del"], { cwd: t.repo, env: t.env });

    const clean2 = runCrew(t, ["clean"]);
    expect(clean2.exitCode).toBe(0);
    expect(existsSync(delJob.worktree)).toBe(false);
  });

  test("concurrent builder start on the same branch/worktree is rejected with WORKTREE_IN_USE", () => {
    const t = setupRepo();
    installFakeAgy(t.binDir, `sleep 30\necho '{"result":"Status: DONE"}'`);
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    const s1 = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/shared"]);
    expect(s1.exitCode).toBe(0);
    const id1 = extractJobId(s1.stdout);

    // Worktree is still clean (sleep 30 wrote no files), yet second start must be refused
    const s2 = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/shared"]);
    expect(s2.exitCode).toBe(1);
    const err2 = JSON.parse(s2.stderr) as { code: string };
    expect(err2.code).toBe("WORKTREE_IN_USE");

    expect(runCrew(t, ["cancel", id1]).exitCode).toBe(0);
  });

  test("cancel kills grandchild processes in the process group even if worker ignores SIGTERM, and refuses finished jobs", async () => {
    const t = setupRepo();
    const grandchildPidFile = join(t.root, "grandchild.pid");
    installFakeAgy(
      t.binDir,
      `
trap '' TERM
sleep 60 &
echo "$!" > "${grandchildPidFile}"
wait
`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Ignore SIGTERM.\n", "utf8");

    const start = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/sigkill"]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);

    // Wait for grandchild PID file to appear
    const deadline = Date.now() + 3000;
    let grandchildPid = 0;
    while (Date.now() < deadline) {
      if (existsSync(grandchildPidFile)) {
        const raw = readFileSync(grandchildPidFile, "utf8").trim();
        if (raw && Number(raw) > 0) {
          grandchildPid = Number(raw);
          break;
        }
      }
      await Bun.sleep(25);
    }
    expect(grandchildPid).toBeGreaterThan(0);

    const cancel = runCrew(t, ["cancel", jobId]);
    expect(cancel.exitCode).toBe(0);

    // Grandchild process in the group must be dead
    let alive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);

    // Canceling an already-finished "done" job must not overwrite "done"
    installFakeAgy(t.binDir, `echo '{"conversation_id":"c-done","result":"Status: DONE\\nok"}'`);
    const startDone = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/already-done"]);
    expect(startDone.exitCode).toBe(0);
    const doneId = extractJobId(startDone.stdout);
    expect(runCrew(t, ["wait", doneId, "--timeout", "10s"]).exitCode).toBe(0);

    const cancelDone = runCrew(t, ["cancel", doneId]);
    expect(cancelDone.exitCode).toBe(1);
    const cancelErr = JSON.parse(cancelDone.stderr) as { code: string };
    expect(cancelErr.code).toBe("JOB_NOT_RUNNING");

    const doneRecord = JSON.parse(
      readFileSync(join(t.repo, ".crew", "jobs", `${doneId}.json`), "utf8"),
    ) as { status: string };
    expect(doneRecord.status).toBe("done");
  });

  test("timeout without conversationId enters error (exit 3), and continue command shell-quotes brief path with spaces", () => {
    const t = setupRepo(undefined, "repo with spaces");
    const briefPath = join(t.repo, "my brief.md");
    writeFileSync(briefPath, "Task with spaces.\n", "utf8");

    // 1. Timeout without conversationId (stderr-matched, non-JSON) -> error (exit 3), no --continue
    installFakeAgy(
      t.binDir,
      `
echo "Operation timed out waiting for model" >&2
exit 1
`,
    );
    const startNoConv = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/no-conv"]);
    expect(startNoConv.exitCode).toBe(0);
    const noConvId = extractJobId(startNoConv.stdout);

    const waitNoConv = runCrew(t, ["wait", noConvId, "--timeout", "10s"]);
    expect(waitNoConv.exitCode).toBe(3);
    expect(waitNoConv.stdout).not.toContain("--continue");

    const resNoConv = runCrew(t, ["result", noConvId]);
    expect(resNoConv.exitCode).toBe(3);
    expect(resNoConv.stdout).not.toContain("--continue");

    // 2. Resumable timeout with conversationId in repo path containing spaces -> shell-quoted Next command works
    installFakeAgy(
      t.binDir,
      `echo '{"conversation_id":"conv-spaces-1","subtype":"timeout","result":"Paused."}'`,
    );
    const startSpaces = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/spaces"]);
    expect(startSpaces.exitCode).toBe(0);
    const spacesId = extractJobId(startSpaces.stdout);

    const waitSpaces = runCrew(t, ["wait", spacesId, "--timeout", "10s"]);
    expect(waitSpaces.exitCode).toBe(5);
    const resSpaces = runCrew(t, ["result", spacesId]);
    expect(resSpaces.exitCode).toBe(5);

    const nextLine = resSpaces.stdout.split("\n").find((l) => l.startsWith("Next: "));
    expect(nextLine).toBeDefined();
    const nextCmd = (nextLine ?? "").slice("Next: ".length);
    expect(nextCmd).toContain(`'${briefPath}'`);

    // Actually execute the printed Next command through bash to prove quoting works
    installFakeAgy(
      t.binDir,
      `echo '{"conversation_id":"conv-spaces-1","result":"Status: DONE\\nResumed ok."}'`,
    );
    const rewrittenCmd = nextCmd.replace("claude-agent-crew/runner/crew.ts", CREW_TS);
    const resumed = Bun.spawnSync(["bash", "-c", rewrittenCmd], {
      cwd: t.repo,
      env: t.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(resumed.exitCode).toBe(0);
    const resumedId = extractJobId(resumed.stdout.toString());
    expect(runCrew(t, ["wait", resumedId, "--timeout", "10s"]).exitCode).toBe(0);
  });

  test("list, no-arg status, result exit codes (2, 4, 5), syncJobLiveness crash recovery, and missing agy log", async () => {
    const t = setupRepo();
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    // Empty list and no-arg status
    const emptyList = runCrew(t, ["list"]);
    expect(emptyList.exitCode).toBe(0);
    expect(emptyList.stdout).toContain("No crew jobs recorded.");

    const emptyStatus = runCrew(t, ["status"]);
    expect(emptyStatus.exitCode).toBe(0);
    expect(emptyStatus.stdout).toContain("No crew jobs recorded.");

    // result exit code 2 while running, 4 when canceled
    installFakeAgy(t.binDir, `sleep 30\necho '{"result":"Status: DONE"}'`);
    const sRun = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/res-codes"]);
    expect(sRun.exitCode).toBe(0);
    const runId = extractJobId(sRun.stdout);

    const resRunning = runCrew(t, ["result", runId]);
    expect(resRunning.exitCode).toBe(2);
    const runningErr = JSON.parse(resRunning.stderr) as { code: string };
    expect(runningErr.code).toBe("JOB_STILL_RUNNING");

    // list and no-arg status show the running job
    const listOut = runCrew(t, ["list"]);
    expect(listOut.exitCode).toBe(0);
    expect(listOut.stdout).toContain(runId);
    const statusNoArg = runCrew(t, ["status"]);
    expect(statusNoArg.exitCode).toBe(0);
    expect(statusNoArg.stdout).toContain(runId);

    expect(runCrew(t, ["cancel", runId]).exitCode).toBe(0);
    await Bun.sleep(50);
    const resCanceled = runCrew(t, ["result", runId]);
    expect(resCanceled.exitCode).toBe(4);
    expect(resCanceled.stdout).toContain("Status: CANCELED");

    // syncJobLiveness crash recovery: dead PID AND recycled unrelated PID
    const jobPath = join(t.repo, ".crew", "jobs", `${runId}.json`);
    const baseRec = JSON.parse(readFileSync(jobPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      jobPath,
      JSON.stringify({ ...baseRec, status: "running", end: null, exit: null, pid: 9999999 }, null, 2),
      "utf8",
    );
    const crashedDead = runCrew(t, ["wait", runId, "--timeout", "1s"]);
    expect(crashedDead.exitCode).toBe(3);

    // Now test recycled PID (an unrelated running sleep process)
    const sleepProc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    spawnedPids.push(sleepProc.pid);
    writeFileSync(
      jobPath,
      JSON.stringify({ ...baseRec, status: "running", end: null, exit: null, pid: sleepProc.pid }, null, 2),
      "utf8",
    );
    const crashedRecycled = runCrew(t, ["result", runId]);
    expect(crashedRecycled.exitCode).toBe(3);
    expect(crashedRecycled.stdout).toContain("Status: ERROR");

    // Missing agy on PATH writes log file and error status instead of missing log
    const noAgyBin = join(t.root, "no-agy-bin");
    mkdirSync(noAgyBin, { recursive: true });
    for (const tool of ["git", "ps"]) {
      const bin = Bun.which(tool);
      if (bin) symlinkSync(bin, join(noAgyBin, tool));
    }
    const noAgyEnv: TestEnv = {
      ...t,
      env: { ...t.env, PATH: noAgyBin },
    };
    const noAgyStart = runCrew(noAgyEnv, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/no-agy"]);
    expect(noAgyStart.exitCode).toBe(0);
    const noAgyId = extractJobId(noAgyStart.stdout);
    const noAgyWait = runCrew(noAgyEnv, ["wait", noAgyId, "--timeout", "5s"]);
    expect(noAgyWait.exitCode).toBe(3);
    const logFile = join(t.repo, ".crew", "logs", `${noAgyId}.log`);
    expect(existsSync(logFile)).toBe(true);
    expect(readFileSync(logFile, "utf8").length).toBeGreaterThan(0);
  });

  test("CLI validation, --help flags, _exec error payload, and parseAgyOutput fallback ignoring trailing primitives", () => {
    const t = setupRepo();
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    // --help works on root and subcommands
    expect(runCrew(t, ["--help"]).exitCode).toBe(0);
    expect(runCrew(t, ["start", "--help"]).exitCode).toBe(0);
    expect(runCrew(t, ["list", "--help"]).exitCode).toBe(0);

    // start input validation errors
    const missingRole = runCrew(t, ["start", "--brief", briefPath]);
    expect(missingRole.exitCode).toBe(1);
    expect((JSON.parse(missingRole.stderr) as { code: string }).code).toBe("MISSING_ROLE");

    const missingBrief = runCrew(t, ["start", "--role", "builder"]);
    expect(missingBrief.exitCode).toBe(1);
    expect((JSON.parse(missingBrief.stderr) as { code: string }).code).toBe("MISSING_BRIEF");

    const badBrief = runCrew(t, ["start", "--role", "builder", "--brief", join(t.repo, "nope.md")]);
    expect(badBrief.exitCode).toBe(1);
    expect((JSON.parse(badBrief.stderr) as { code: string }).code).toBe("BRIEF_NOT_FOUND");

    const badRole = runCrew(t, ["start", "--role", "wizard", "--brief", briefPath]);
    expect(badRole.exitCode).toBe(1);
    expect((JSON.parse(badRole.stderr) as { code: string }).code).toBe("UNKNOWN_ROLE");

    const badTimeout = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--timeout", "bogus"]);
    expect(badTimeout.exitCode).toBe(1);
    expect((JSON.parse(badTimeout.stderr) as { code: string }).code).toBe("INVALID_TIMEOUT");

    const zeroTimeout = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--timeout", "0s"]);
    expect(zeroTimeout.exitCode).toBe(1);
    expect((JSON.parse(zeroTimeout.stderr) as { code: string }).code).toBe("INVALID_TIMEOUT");

    const unknownFlag = runCrew(t, ["start", "--bogus", "1"]);
    expect(unknownFlag.exitCode).toBe(1);
    expect((JSON.parse(unknownFlag.stderr) as { code: string }).code).toBe("UNKNOWN_FLAG");

    const extraArg = runCrew(t, ["list", "extra"]);
    expect(extraArg.exitCode).toBe(1);
    expect((JSON.parse(extraArg.stderr) as { code: string }).code).toBe("UNEXPECTED_ARGUMENT");

    // _exec with missing job-id emits structured JSON error
    const execNoId = runCrew(t, ["_exec"]);
    expect(execNoId.exitCode).toBe(1);
    expect((JSON.parse(execNoId.stderr) as { code: string }).code).toBe("MISSING_JOB_ID");

    // parseAgyOutput fallback skips trailing JSON primitives like 0 or "ok"
    installFakeAgy(
      t.binDir,
      `
echo "Diagnostic log line"
echo '{"conversation_id":"c-fb","result":"Status: DONE\\nFound object."}'
echo '0'
echo '"ok"'
`,
    );
    const fbStart = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/fallback"]);
    expect(fbStart.exitCode).toBe(0);
    const fbId = extractJobId(fbStart.stdout);
    expect(runCrew(t, ["wait", fbId, "--timeout", "10s"]).exitCode).toBe(0);
    const fbRes = runCrew(t, ["result", fbId]);
    expect(fbRes.exitCode).toBe(0);
    expect(fbRes.stdout.split("\n")[0]).toBe("Status: DONE");
    expect(fbRes.stdout).toContain("Found object.");
    expect(fbRes.stdout).not.toContain("Diagnostic log line");
    expect(fbRes.stdout).not.toContain("{");
    const fbJob = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${fbId}.json`), "utf8")) as {
      conversationId: string | null;
    };
    expect(fbJob.conversationId).toBe("c-fb");
  });

  test("COLUMNS=80 does not truncate ps args and cancel kills orphaned PGID children after _exec death", async () => {
    const t = setupRepo();
    const childPidFile = join(t.root, "orphan-child.pid");
    installFakeAgy(
      t.binDir,
      `
sleep 60 &
echo "$!" > "${childPidFile}"
wait
`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    const narrowEnv: TestEnv = {
      ...t,
      env: { ...t.env, COLUMNS: "80" },
    };

    const start = runCrew(narrowEnv, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/col80"]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);

    // status under COLUMNS=80 must still see the live job as running (not WORKER_CRASHED)
    const status = runCrew(narrowEnv, ["status", jobId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Status: running");

    // Wait for child PID to appear, then SIGKILL _exec so only PGID children remain
    const deadline = Date.now() + 3000;
    let childPid = 0;
    while (Date.now() < deadline) {
      if (existsSync(childPidFile)) {
        const raw = readFileSync(childPidFile, "utf8").trim();
        if (raw && Number(raw) > 0) {
          childPid = Number(raw);
          break;
        }
      }
      await Bun.sleep(25);
    }
    expect(childPid).toBeGreaterThan(0);

    const jobRecord = JSON.parse(
      readFileSync(join(t.repo, ".crew", "jobs", `${jobId}.json`), "utf8"),
    ) as { pid: number };
    process.kill(jobRecord.pid, "SIGKILL");
    // Give PID 1 / kernel a moment to transition _exec out
    await Bun.sleep(50);

    // cancel must still find and kill the surviving PGID child under COLUMNS=80
    const cancel = runCrew(narrowEnv, ["cancel", jobId]);
    expect(cancel.exitCode).toBe(0);
    expect(cancel.stdout).toContain(`Canceled job ${jobId}`);

    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(false);
  });

  test("worktree safety rejects symlinked .crew/worktrees pointing outside repoRoot", () => {
    const t = setupRepo();
    installFakeAgy(t.binDir, `echo '{"conversation_id":"c1","result":"Status: DONE\\nok"}'`);
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    const outsideDir = join(t.root, "outside-worktrees");
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(join(t.repo, ".crew"), { recursive: true });
    symlinkSync(outsideDir, join(t.repo, ".crew", "worktrees"));

    // Create a fake job record pointing through the symlinked .crew/worktrees
    const escapedWt = join(outsideDir, "escaped-wt");
    const addWt = Bun.spawnSync(["git", "worktree", "add", "-b", "feat/sym", escapedWt, "HEAD"], {
      cwd: t.repo,
      env: t.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(addWt.exitCode).toBe(0);

    mkdirSync(join(t.repo, ".crew", "jobs"), { recursive: true });
    writeFileSync(
      join(t.repo, ".crew", "jobs", "sym-job-1.json"),
      JSON.stringify(
        {
          id: "sym-job-1",
          role: "builder",
          worker: "agy",
          model: null,
          machine: "local",
          machineTarget: "local",
          remotePath: null,
          branch: "feat/sym",
          worktree: join(t.repo, ".crew", "worktrees", "escaped-wt"),
          briefFile: briefPath,
          pid: null,
          start: new Date().toISOString(),
          end: new Date().toISOString(),
          exit: 0,
          status: "done",
          conversationId: null,
          continuedFrom: null,
          logFile: "",
          stdoutFile: "",
          resultText: "ok",
          error: null,
        },
        null,
        2,
      ),
      "utf8",
    );

    const clean = runCrew(t, ["clean"]);
    expect(clean.exitCode).toBe(0);
    expect(existsSync(escapedWt)).toBe(true);
    expect(clean.stdout).toContain("outside .crew/worktrees/");
  });

  test("crew start (builder and reviewer) refuses with WORKTREE_OUTSIDE_CREW and creates nothing when .crew/worktrees is symlinked outside repoRoot", () => {
    const t = setupRepo();
    const agyMarker = join(t.root, "agy-ran-symlink.txt");
    installFakeAgy(
      t.binDir,
      `touch "${agyMarker}"\necho '{"conversation_id":"c1","result":"Status: DONE\\nok"}'`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    const outsideDir = join(t.root, "outside-worktrees-start");
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(join(t.repo, ".crew"), { recursive: true });
    symlinkSync(outsideDir, join(t.repo, ".crew", "worktrees"));

    const builderStart = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      briefPath,
      "--branch",
      "feat/sym-builder",
    ]);
    expect(builderStart.exitCode).toBe(1);
    expect((JSON.parse(builderStart.stderr) as { code: string }).code).toBe("WORKTREE_OUTSIDE_CREW");
    expect(readdirSync(outsideDir)).toEqual([]);
    expect(existsSync(agyMarker)).toBe(false);

    const reviewerStart = runCrew(t, [
      "start",
      "--role",
      "reviewer",
      "--brief",
      briefPath,
      "--branch",
      "main",
    ]);
    expect(reviewerStart.exitCode).toBe(1);
    expect((JSON.parse(reviewerStart.stderr) as { code: string }).code).toBe("WORKTREE_OUTSIDE_CREW");
    expect(readdirSync(outsideDir)).toEqual([]);
    expect(existsSync(agyMarker)).toBe(false);
    expect(readdirSync(join(t.repo, ".crew", "jobs"))).toEqual([]);
  });

  test("dangling .crew/worktrees symlink, symlinked .crew, internal worktrees symlink, and empty --branch are refused cleanly", () => {
    const t = setupRepo();
    const agyMarker = join(t.root, "agy-ran-dangling.txt");
    installFakeAgy(
      t.binDir,
      `touch "${agyMarker}"\necho '{"conversation_id":"c1","result":"Status: DONE\\nok"}'`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    // 1. Empty --branch "" is rejected with INVALID_BRANCH
    const emptyBranch = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", ""]);
    expect(emptyBranch.exitCode).toBe(1);
    expect((JSON.parse(emptyBranch.stderr) as { code: string }).code).toBe("INVALID_BRANCH");
    expect(existsSync(agyMarker)).toBe(false);

    // 2. Dangling .crew/worktrees symlink refuses with WORKTREE_OUTSIDE_CREW (not EEXIST INTERNAL_ERROR)
    mkdirSync(join(t.repo, ".crew"), { recursive: true });
    symlinkSync(join(t.root, "nonexistent-outside"), join(t.repo, ".crew", "worktrees"));
    const danglingBuilder = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      briefPath,
      "--branch",
      "feat/dangling",
    ]);
    expect(danglingBuilder.exitCode).toBe(1);
    expect((JSON.parse(danglingBuilder.stderr) as { code: string }).code).toBe("WORKTREE_OUTSIDE_CREW");
    const danglingReviewer = runCrew(t, [
      "start",
      "--role",
      "reviewer",
      "--brief",
      briefPath,
      "--branch",
      "main",
    ]);
    expect(danglingReviewer.exitCode).toBe(1);
    expect((JSON.parse(danglingReviewer.stderr) as { code: string }).code).toBe("WORKTREE_OUTSIDE_CREW");
    expect(existsSync(agyMarker)).toBe(false);

    // 3. .crew/worktrees symlinked to another directory inside repoRoot is also refused
    rmSync(join(t.repo, ".crew", "worktrees"));
    const insideOther = join(t.repo, "other-dir");
    mkdirSync(insideOther, { recursive: true });
    symlinkSync(insideOther, join(t.repo, ".crew", "worktrees"));
    const insideLink = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      briefPath,
      "--branch",
      "feat/inside-sym",
    ]);
    expect(insideLink.exitCode).toBe(1);
    expect((JSON.parse(insideLink.stderr) as { code: string }).code).toBe("WORKTREE_OUTSIDE_CREW");
    expect(readdirSync(insideOther)).toEqual([]);

    // 4. .crew itself symlinked outside repoRoot writes nothing (no jobs/, logs/, worktrees/, start.lock)
    rmSync(join(t.repo, ".crew"), { recursive: true, force: true });
    const outsideCrew = join(t.root, "outside-crew");
    mkdirSync(outsideCrew, { recursive: true });
    symlinkSync(outsideCrew, join(t.repo, ".crew"));
    const crewSym = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      briefPath,
      "--branch",
      "feat/crew-sym",
    ]);
    expect(crewSym.exitCode).toBe(1);
    expect((JSON.parse(crewSym.stderr) as { code: string }).code).toBe("WORKTREE_OUTSIDE_CREW");
    expect(readdirSync(outsideCrew)).toEqual([]);
    expect(existsSync(agyMarker)).toBe(false);

    // 5. clean deduplicates kept worktrees when multiple finished jobs share the same worktree
    rmSync(join(t.repo, ".crew"), { recursive: true, force: true });
    installFakeAgy(t.binDir, `echo '{"conversation_id":"c-dup","result":"Status: DONE\\nok"}'`);
    const s1 = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/dup-keep"]);
    expect(s1.exitCode).toBe(0);
    const id1 = extractJobId(s1.stdout);
    expect(runCrew(t, ["wait", id1, "--timeout", "10s"]).exitCode).toBe(0);
    const s2 = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/dup-keep"]);
    expect(s2.exitCode).toBe(0);
    const id2 = extractJobId(s2.stdout);
    expect(runCrew(t, ["wait", id2, "--timeout", "10s"]).exitCode).toBe(0);

    const job1 = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${id1}.json`), "utf8")) as {
      worktree: string;
    };
    writeFileSync(join(job1.worktree, "keep-dirty.txt"), "dirty\n", "utf8");
    const cleanDup = runCrew(t, ["clean"]);
    expect(cleanDup.exitCode).toBe(0);
    expect(cleanDup.stdout).toContain("Removed 0 worktree(s); kept 1.");

    // 6. clean keeps and does not follow a dangling .crew/worktrees symlink
    rmSync(join(t.repo, ".crew", "worktrees"), { recursive: true, force: true });
    symlinkSync(join(t.root, "nonexistent-clean-target"), join(t.repo, ".crew", "worktrees"));
    const cleanDangling = runCrew(t, ["clean"]);
    expect(cleanDangling.exitCode).toBe(0);
  });

  test("syncJobLiveness treats surviving PGID children as alive after _exec death", async () => {
    const t = setupRepo();
    const childPidFile = join(t.root, "pgid-alive-child.pid");
    installFakeAgy(
      t.binDir,
      `
sleep 60 &
echo "$!" > "${childPidFile}"
wait
`,
    );
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    const start = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/pgid-alive"]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);

    const deadline = Date.now() + 3000;
    let childPid = 0;
    while (Date.now() < deadline) {
      if (existsSync(childPidFile)) {
        const raw = readFileSync(childPidFile, "utf8").trim();
        if (raw && Number(raw) > 0) {
          childPid = Number(raw);
          break;
        }
      }
      await Bun.sleep(25);
    }
    expect(childPid).toBeGreaterThan(0);

    const jobRecord = JSON.parse(
      readFileSync(join(t.repo, ".crew", "jobs", `${jobId}.json`), "utf8"),
    ) as { pid: number; worktree: string };
    process.kill(jobRecord.pid, "SIGKILL");
    await Bun.sleep(50);

    // status, list, start, and clean must still treat the job as running
    const status = runCrew(t, ["status", jobId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Status: running");

    const listRes = runCrew(t, ["list"]);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain(`${jobId}\trunning`);

    const secondStart = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      briefPath,
      "--branch",
      "feat/pgid-alive",
    ]);
    expect(secondStart.exitCode).toBe(1);
    expect((JSON.parse(secondStart.stderr) as { code: string }).code).toBe("WORKTREE_IN_USE");

    const cleanRes = runCrew(t, ["clean"]);
    expect(cleanRes.exitCode).toBe(0);
    expect(existsSync(jobRecord.worktree)).toBe(true);

    // cancel must still succeed and kill the surviving PGID child
    const cancel = runCrew(t, ["cancel", jobId]);
    expect(cancel.exitCode).toBe(0);
    expect(cancel.stdout).toContain(`Canceled job ${jobId}`);

    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(false);
  });

  test("_exec aborts when job status is not running and handles immediate SIGTERM after pid write", async () => {
    const t = setupRepo();
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");
    const agyMarker = join(t.root, "exec-abort-agy.txt");

    installFakeAgy(
      t.binDir,
      `touch "${agyMarker}"\necho '{"conversation_id":"c1","result":"Status: DONE\\nok"}'`,
    );

    const start = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/exec-abort"]);
    expect(start.exitCode).toBe(0);
    const jobId = extractJobId(start.stdout);
    expect(runCrew(t, ["wait", jobId, "--timeout", "10s"]).exitCode).toBe(0);
    rmSync(agyMarker, { force: true });

    // Mark job as error and re-run _exec: must abort without running agy or overwriting status
    const jobFile = join(t.repo, ".crew", "jobs", `${jobId}.json`);
    const finished = JSON.parse(readFileSync(jobFile, "utf8")) as Record<string, unknown>;
    writeFileSync(
      jobFile,
      JSON.stringify({ ...finished, status: "error", pid: null, exit: 1 }, null, 2),
      "utf8",
    );
    const reExec = runCrew(t, ["_exec", jobId]);
    expect(reExec.exitCode).toBe(3);
    expect(existsSync(agyMarker)).toBe(false);
    const afterAbort = JSON.parse(readFileSync(jobFile, "utf8")) as { status: string; pid: number | null };
    expect(afterAbort.status).toBe("error");
    expect(afterAbort.pid).toBeNull();

    // Immediate SIGTERM as soon as _exec writes pid -> canceled (never WORKER_CRASHED)
    installFakeAgy(t.binDir, `sleep 5\necho '{"result":"Status: DONE"}'`);
    const raceId = "builder-race-sigterm-1";
    const raceWt = join(t.repo, ".crew", "worktrees", "feat-race-sigterm");
    Bun.spawnSync(["git", "worktree", "add", "-b", "feat/race-sigterm", "--", raceWt, "HEAD"], {
      cwd: t.repo,
      env: t.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const raceJobFile = join(t.repo, ".crew", "jobs", `${raceId}.json`);
    writeFileSync(
      raceJobFile,
      JSON.stringify(
        {
          id: raceId,
          role: "builder",
          worker: "agy",
          model: null,
          machine: "local",
          machineTarget: "local",
          remotePath: null,
          branch: "feat/race-sigterm",
          worktree: raceWt,
          briefFile: briefPath,
          pid: null,
          start: new Date().toISOString(),
          end: null,
          exit: null,
          status: "running",
          conversationId: null,
          continuedFrom: null,
          logFile: join(t.repo, ".crew", "logs", `${raceId}.log`),
          stdoutFile: join(t.repo, ".crew", "logs", `${raceId}.stdout.json`),
          resultText: null,
          error: null,
        },
        null,
        2,
      ),
      "utf8",
    );

    const execProc = Bun.spawn([process.execPath, CREW_TS, "_exec", raceId, "--timeout", "10s"], {
      cwd: t.repo,
      env: t.env,
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnedPids.push(execProc.pid);

    let signaled = false;
    const pollDeadline = Date.now() + 3000;
    while (Date.now() < pollDeadline) {
      const rec = JSON.parse(readFileSync(raceJobFile, "utf8")) as { pid: number | null };
      if (rec.pid !== null) {
        process.kill(rec.pid, "SIGTERM");
        signaled = true;
        break;
      }
      await Bun.sleep(1);
    }
    expect(signaled).toBe(true);

    const execCode = await execProc.exited;
    expect(execCode).toBe(4);
    const finalRace = JSON.parse(readFileSync(raceJobFile, "utf8")) as { status: string; error: unknown };
    expect(finalRace.status).toBe("canceled");
    expect(finalRace.error).toBeNull();
  });

  test("remote attention Next command works across differing repo paths, and --continue rejects role/branch mismatches", () => {
    const t = setupRepo();
    const remoteRepo = join(t.root, "remote repo");
    mkdirSync(join(remoteRepo, ".claude"), { recursive: true });
    const rGit = (args: string[]): void => {
      const r = Bun.spawnSync(["git", ...args], { cwd: remoteRepo, env: t.env, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    const remoteConfig = {
      roles: {
        remote: { worker: "agy", model: "gemini-4-hydrogen-medium", machine: "dev-pc" },
      },
      machines: { local: "local", "dev-pc": "ssh factory@dev-pc" },
      paths: { "dev-pc": remoteRepo },
    };
    rGit(["init", "-b", "main"]);
    rGit(["config", "user.email", "test@example.com"]);
    rGit(["config", "user.name", "Test User"]);
    rGit(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(remoteRepo, "README.md"), "# Remote\n", "utf8");
    writeFileSync(join(remoteRepo, "brief.md"), "Remote brief.\n", "utf8");
    writeFileSync(join(remoteRepo, ".claude", "crew.json"), JSON.stringify(remoteConfig, null, 2), "utf8");
    rGit(["add", "README.md", "brief.md", ".claude/crew.json"]);
    rGit(["commit", "-m", "remote init"]);

    writeFileSync(
      join(t.repo, ".claude", "crew.json"),
      JSON.stringify(
        {
          roles: {
            builder: { worker: "agy", model: "gemini-4-hydrogen-medium", machine: "local" },
            reviewer: { worker: "agy", model: "gemini-4-hydrogen-high", machine: "local" },
            remote: { worker: "agy", model: "gemini-4-hydrogen-medium", machine: "dev-pc" },
          },
          machines: { local: "local", "dev-pc": "ssh factory@dev-pc" },
          paths: { "dev-pc": remoteRepo },
        },
        null,
        2,
      ),
      "utf8",
    );

    const sshBin = join(t.binDir, "ssh");
    writeFileSync(
      sshBin,
      `#!/usr/bin/env bash
set -euo pipefail
remote_cmd="\${@: -1}"
rewritten="\${remote_cmd//claude-agent-crew\\/runner\\/crew.ts/${CREW_TS}}"
bash -c "$rewritten"
`,
      "utf8",
    );
    chmodSync(sshBin, 0o755);

    const localBrief = join(t.repo, "brief.md");
    writeFileSync(localBrief, "Local copy of brief.\n", "utf8");

    // 1. Remote job times out with conversationId -> attention Next command prints remote path
    installFakeAgy(
      t.binDir,
      `echo '{"conversation_id":"remote-attn-1","subtype":"timeout","result":"Paused on remote."}'`,
    );
    const rStart = runCrew(t, ["start", "--role", "remote", "--brief", localBrief, "--branch", "feat/remote-attn"]);
    expect(rStart.exitCode).toBe(0);
    const rId = extractJobId(rStart.stdout);
    const rWait = runCrew(t, ["wait", rId, "--timeout", "10s"]);
    expect(rWait.exitCode).toBe(5);

    const nextLine = rWait.stdout.split("\n").find((l) => l.startsWith("Next: "));
    expect(nextLine).toBeDefined();
    const nextCmd = (nextLine ?? "").slice("Next: ".length);
    expect(nextCmd).toContain(remoteRepo);

    // Running that exact Next command on the local orchestrator (where remoteRepo/brief.md is not local repo) succeeds
    const argsLog = join(t.root, "remote-cont-args.txt");
    installFakeAgy(
      t.binDir,
      `printf '%s\n' "$@" > "${argsLog}"\necho '{"conversation_id":"remote-attn-1","result":"Status: DONE\\nResumed ok."}'`,
    );
    const resumed = Bun.spawnSync(["bash", "-c", nextCmd.replace("claude-agent-crew/runner/crew.ts", CREW_TS)], {
      cwd: t.repo,
      env: t.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(resumed.exitCode).toBe(0);
    const resumedId = extractJobId(resumed.stdout.toString());
    expect(runCrew(t, ["wait", resumedId, "--timeout", "10s"]).exitCode).toBe(0);
    expect(readFileSync(argsLog, "utf8")).toContain("remote-attn-1");

    // 2. Local --continue rejects read-only/builder role mismatches and conflicting --branch
    installFakeAgy(
      t.binDir,
      `echo '{"conversation_id":"rev-conv-1","subtype":"timeout","result":"Paused review."}'`,
    );
    const revStart = runCrew(t, ["start", "--role", "reviewer", "--brief", localBrief]);
    expect(revStart.exitCode).toBe(0);
    const revId = extractJobId(revStart.stdout);
    expect(runCrew(t, ["wait", revId, "--timeout", "10s"]).exitCode).toBe(5);

    const revToBuilder = runCrew(t, ["start", "--role", "builder", "--brief", localBrief, "--continue", revId]);
    expect(revToBuilder.exitCode).toBe(1);
    expect((JSON.parse(revToBuilder.stderr) as { code: string }).code).toBe("CONTINUE_ROLE_MISMATCH");

    const revBadBranch = runCrew(t, [
      "start",
      "--role",
      "reviewer",
      "--brief",
      localBrief,
      "--branch",
      "main",
      "--continue",
      revId,
    ]);
    expect(revBadBranch.exitCode).toBe(1);
    expect((JSON.parse(revBadBranch.stderr) as { code: string }).code).toBe("CONTINUE_BRANCH_MISMATCH");

    installFakeAgy(
      t.binDir,
      `echo '{"conversation_id":"bld-conv-1","subtype":"timeout","result":"Paused build."}'`,
    );
    const bldStart = runCrew(t, ["start", "--role", "builder", "--brief", localBrief, "--branch", "feat/bld-cont"]);
    expect(bldStart.exitCode).toBe(0);
    const bldId = extractJobId(bldStart.stdout);
    expect(runCrew(t, ["wait", bldId, "--timeout", "10s"]).exitCode).toBe(5);

    const bldToRev = runCrew(t, ["start", "--role", "reviewer", "--brief", localBrief, "--continue", bldId]);
    expect(bldToRev.exitCode).toBe(1);
    expect((JSON.parse(bldToRev.stderr) as { code: string }).code).toBe("CONTINUE_ROLE_MISMATCH");

    const bldBadBranch = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      localBrief,
      "--branch",
      "feat/other-branch",
      "--continue",
      bldId,
    ]);
    expect(bldBadBranch.exitCode).toBe(1);
    expect((JSON.parse(bldBadBranch.stderr) as { code: string }).code).toBe("CONTINUE_BRANCH_MISMATCH");

    // Passing matching --branch with --continue succeeds
    installFakeAgy(t.binDir, `echo '{"conversation_id":"bld-conv-1","result":"Status: DONE\\nOk."}'`);
    const bldMatchBranch = runCrew(t, [
      "start",
      "--role",
      "builder",
      "--brief",
      localBrief,
      "--branch",
      "feat/bld-cont",
      "--continue",
      bldId,
    ]);
    expect(bldMatchBranch.exitCode).toBe(0);
    expect(runCrew(t, ["wait", extractJobId(bldMatchBranch.stdout), "--timeout", "10s"]).exitCode).toBe(0);
  });

  test("clean checks current worktree branch (wtInfo.branch), parseAgyOutput extracts multi-line JSON, and branch validation/slug disambiguation", () => {
    const t = setupRepo();
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    // 1. parseAgyOutput handles diagnostic lines (including unmatched '{') around pretty-printed multi-line JSON
    installFakeAgy(
      t.binDir,
      `
cat <<'OUT'
[agy] starting {unclosed diagnostic
{
  "conversation_id": "c-multiline-1",
  "result": "Status: DONE\\nMulti-line JSON extracted.",
  "nested":
  {"ignored": true},
  "usage": {
    "input_tokens": 55,
    "output_tokens": 12
  }
}
[agy] trailing log line
OUT
`,
    );
    const mlStart = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat/merged-src"]);
    expect(mlStart.exitCode).toBe(0);
    const mlId = extractJobId(mlStart.stdout);
    expect(runCrew(t, ["wait", mlId, "--timeout", "10s"]).exitCode).toBe(0);
    const mlRes = runCrew(t, ["result", mlId]);
    expect(mlRes.exitCode).toBe(0);
    expect(mlRes.stdout.split("\n")[0]).toBe("Status: DONE");
    expect(mlRes.stdout).toContain("Multi-line JSON extracted.");
    expect(mlRes.stdout).not.toContain("diagnostic");
    expect(mlRes.stdout).not.toContain("{");

    const mlJob = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${mlId}.json`), "utf8")) as {
      conversationId: string | null;
      worktree: string;
    };
    expect(mlJob.conversationId).toBe("c-multiline-1");
    const usageLine = readFileSync(join(t.repo, ".crew", "usage.jsonl"), "utf8").trim().split("\n")[0] ?? "{}";
    expect((JSON.parse(usageLine) as { usage: { input_tokens: number } }).usage.input_tokens).toBe(55);

    // 2. clean keeps worktree when job.branch is merged but checkout was switched to an unmerged branch
    writeFileSync(join(mlJob.worktree, "src.txt"), "merged work\n", "utf8");
    Bun.spawnSync(["git", "add", "src.txt"], { cwd: mlJob.worktree, env: t.env });
    Bun.spawnSync(["git", "commit", "-m", "commit on merged-src"], { cwd: mlJob.worktree, env: t.env });
    Bun.spawnSync(["git", "merge", "--no-ff", "feat/merged-src", "-m", "merge src"], { cwd: t.repo, env: t.env });

    Bun.spawnSync(["git", "checkout", "-b", "feat/switched-unmerged"], { cwd: mlJob.worktree, env: t.env });
    writeFileSync(join(mlJob.worktree, "important.txt"), "unmerged work\n", "utf8");
    Bun.spawnSync(["git", "add", "important.txt"], { cwd: mlJob.worktree, env: t.env });
    Bun.spawnSync(["git", "commit", "-m", "unmerged commit"], { cwd: mlJob.worktree, env: t.env });

    const cleanRes = runCrew(t, ["clean"]);
    expect(cleanRes.exitCode).toBe(0);
    expect(existsSync(mlJob.worktree)).toBe(true);
    expect(existsSync(join(mlJob.worktree, "important.txt"))).toBe(true);
    expect(cleanRes.stdout).toContain("feat/switched-unmerged");

    // 3. Branch validation rejects '-' prefix and invalid git branch names
    const dashBuilder = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "-foo"]);
    expect(dashBuilder.exitCode).toBe(1);
    expect((JSON.parse(dashBuilder.stderr) as { code: string }).code).toBe("INVALID_BRANCH");

    const dashReviewer = runCrew(t, ["start", "--role", "reviewer", "--brief", briefPath, "--branch", "-foo"]);
    expect(dashReviewer.exitCode).toBe(1);
    expect((JSON.parse(dashReviewer.stderr) as { code: string }).code).toBe("INVALID_BRANCH");

    const badRef = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", "feat..bad"]);
    expect(badRef.exitCode).toBe(1);
    expect((JSON.parse(badRef.stderr) as { code: string }).code).toBe("INVALID_BRANCH");

    // 4. Slug disambiguation: feat/slug, feat@slug, and feat-slug get distinct worktree directories
    installFakeAgy(t.binDir, `echo '{"conversation_id":"c-slug","result":"Status: DONE\\nok"}'`);
    const slugPaths = new Set<string>();
    for (const branch of ["feat/slug", "feat@slug", "feat-slug"]) {
      const s = runCrew(t, ["start", "--role", "builder", "--brief", briefPath, "--branch", branch]);
      expect(s.exitCode).toBe(0);
      const id = extractJobId(s.stdout);
      expect(runCrew(t, ["wait", id, "--timeout", "10s"]).exitCode).toBe(0);
      const j = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${id}.json`), "utf8")) as {
        worktree: string;
      };
      slugPaths.add(j.worktree);
    }
    expect(slugPaths.size).toBe(3);
  });

  test("stale start.lock serializes concurrent starts cleanly and remote cancel syncs finished job status", async () => {
    const t = setupRepo();
    const briefPath = join(t.repo, "brief.md");
    writeFileSync(briefPath, "Task.\n", "utf8");

    // 1. Stale start.lock (>10s old) with two concurrent crew start invocations
    mkdirSync(join(t.repo, ".crew", "start.lock"), { recursive: true });
    const past = new Date(Date.now() - 20_000);
    utimesSync(join(t.repo, ".crew", "start.lock"), past, past);

    installFakeAgy(t.binDir, `sleep 1\necho '{"conversation_id":"c-lock","result":"Status: DONE\\nok"}'`);
    const spawnStart = (branch: string) => {
      const p = Bun.spawn([process.execPath, CREW_TS, "start", "--role", "builder", "--brief", briefPath, "--branch", branch], {
        cwd: t.repo,
        env: t.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    };

    const [r1, r2] = await Promise.all([spawnStart("feat/stale-1"), spawnStart("feat/stale-2")]);
    expect(r1[0]).toBe(0);
    expect(r2[0]).toBe(0);
    const id1 = extractJobId(r1[1]);
    const id2 = extractJobId(r2[1]);
    expect(runCrew(t, ["cancel", id1]).exitCode).toBe(0);
    expect(runCrew(t, ["cancel", id2]).exitCode).toBe(0);

    // Also test stale lock with two concurrent starts on the SAME branch: one wins, one gets WORKTREE_IN_USE
    mkdirSync(join(t.repo, ".crew", "start.lock"), { recursive: true });
    utimesSync(join(t.repo, ".crew", "start.lock"), past, past);
    const [same1, same2] = await Promise.all([spawnStart("feat/stale-same"), spawnStart("feat/stale-same")]);
    const exits = [same1[0], same2[0]].sort();
    expect(exits).toEqual([0, 1]);
    const loserErr = same1[0] === 1 ? same1[2] : same2[2];
    expect((JSON.parse(loserErr) as { code: string }).code).toBe("WORKTREE_IN_USE");
    const winnerId = extractJobId(same1[0] === 0 ? same1[1] : same2[1]);
    expect(runCrew(t, ["cancel", winnerId]).exitCode).toBe(0);

    // 2. Remote cancel on an already-finished remote job syncs local JobRecord out of "running"
    const remoteRepo = join(t.root, "remote-cancel-sync");
    mkdirSync(join(remoteRepo, ".claude"), { recursive: true });
    const rGit = (args: string[]): void => {
      const r = Bun.spawnSync(["git", ...args], { cwd: remoteRepo, env: t.env, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    rGit(["init", "-b", "main"]);
    rGit(["config", "user.email", "test@example.com"]);
    rGit(["config", "user.name", "Test User"]);
    rGit(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(remoteRepo, "README.md"), "# Remote\n", "utf8");
    writeFileSync(join(remoteRepo, "brief.md"), "Remote.\n", "utf8");
    writeFileSync(
      join(remoteRepo, ".claude", "crew.json"),
      JSON.stringify(
        {
          roles: { remote: { worker: "agy", machine: "dev-pc" } },
          machines: { local: "local", "dev-pc": "ssh factory@dev-pc" },
          paths: { "dev-pc": remoteRepo },
        },
        null,
        2,
      ),
      "utf8",
    );
    rGit(["add", "README.md", "brief.md", ".claude/crew.json"]);
    rGit(["commit", "-m", "init"]);

    writeFileSync(
      join(t.repo, ".claude", "crew.json"),
      JSON.stringify(
        {
          roles: { remote: { worker: "agy", machine: "dev-pc" } },
          machines: { local: "local", "dev-pc": "ssh factory@dev-pc" },
          paths: { "dev-pc": remoteRepo },
        },
        null,
        2,
      ),
      "utf8",
    );
    const sshBin = join(t.binDir, "ssh");
    writeFileSync(
      sshBin,
      `#!/usr/bin/env bash
set -euo pipefail
remote_cmd="\${@: -1}"
rewritten="\${remote_cmd//claude-agent-crew\\/runner\\/crew.ts/${CREW_TS}}"
bash -c "$rewritten"
`,
      "utf8",
    );
    chmodSync(sshBin, 0o755);

    installFakeAgy(t.binDir, `echo '{"conversation_id":"c-fast","result":"Status: DONE\\nFast."}'`);
    const remoteFast = runCrew(t, ["start", "--role", "remote", "--brief", briefPath, "--branch", "feat/fast-remote"]);
    expect(remoteFast.exitCode).toBe(0);
    const fastId = extractJobId(remoteFast.stdout);

    // Wait briefly for the remote _exec to finish on remoteRepo without calling local wait/status
    const remoteJobPath = join(remoteRepo, ".crew", "jobs", `${fastId}.json`);
    const doneDeadline = Date.now() + 3000;
    while (Date.now() < doneDeadline) {
      if (existsSync(remoteJobPath)) {
        const rj = JSON.parse(readFileSync(remoteJobPath, "utf8")) as { status: string };
        if (rj.status === "done") break;
      }
      await Bun.sleep(25);
    }

    const cancelFinished = runCrew(t, ["cancel", fastId]);
    expect(cancelFinished.exitCode).toBe(1);
    const localAfter = JSON.parse(readFileSync(join(t.repo, ".crew", "jobs", `${fastId}.json`), "utf8")) as {
      status: string;
    };
    expect(localAfter.status).toBe("done");
    const listAfter = runCrew(t, ["list"]);
    expect(listAfter.stdout).toContain(`${fastId}\tdone`);
  });
});
