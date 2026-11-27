import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkCommand, evaluateHookInput } from "./guard";

const GUARD_SCRIPT = join(import.meta.dir, "guard.ts");

function makeHookPayload(commandLine: string): string {
  return JSON.stringify({
    conversationId: "test-conv",
    hookEventName: "PreToolUse",
    toolCall: {
      id: "toolu_01",
      name: "run_command",
      args: {
        CommandLine: commandLine,
      },
    },
  });
}

async function runGuardCli(stdin: string): Promise<{
  exitCode: number;
  output: Record<string, unknown>;
}> {
  const proc = Bun.spawn(["bun", GUARD_SCRIPT], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    output: JSON.parse(stdout) as Record<string, unknown>,
  };
}

describe("guard allowed commands", () => {
  const allowedCases: Array<[string, string]> = [
    ["push to feature branch", "git push origin feature/x"],
    ["push HEAD with upstream", "git push -u origin HEAD"],
    ["echo main chained with push to dev", "echo main && git push origin dev"],
    ["gh pr create --fill", "gh pr create --fill"],
    ["push to branch containing main in path", "git push origin feature/main"],
    ["push local main to feature branch", "git push origin main:feature/from-main"],
    ["push with remote only", "git push origin"],
    ["normal git status and commit", "git status && git commit -m 'update main'"],
    ["git reset --hard HEAD", "git reset --hard HEAD"],
    ["git reset --soft origin/main", "git reset --soft origin/main"],
    ["git checkout main", "git checkout main"],
    ["git branch -d feature/x", "git branch -d feature/x"],
    ["gh pr view", "gh pr view 42"],
    ["gh repo view", "gh repo view owner/repo"],
    ["gh api normal pulls endpoint", "gh api repos/a/b/pulls"],
    ["gh api branch info without protection", "gh api repos/a/b/branches/main"],
    ["echo mentioning forbidden command as literal text", 'echo "git push origin main"'],
    ["single-quoted command substitution is literal", "echo '$(sudo id)'"],
    ["grep mentioning sudo", "grep -rn sudo ./src"],
    ["empty command line", ""],
  ];

  for (const [label, cmd] of allowedCases) {
    test(`allows: ${label}`, () => {
      expect(checkCommand(cmd)).toEqual({ decision: "allow" });
    });
  }
});

describe("guard denied commands", () => {
  const deniedCases: Array<[string, string]> = [
    ["git push origin main", "git push origin main"],
    ["git push origin master", "git push origin master"],
    ["git push origin HEAD:main", "git push origin HEAD:main"],
    ["git push origin HEAD:master", "git push origin HEAD:master"],
    ["git push origin refs/heads/main", "git push origin refs/heads/main"],
    ["git push origin HEAD:refs/heads/main", "git push origin HEAD:refs/heads/main"],
    ["git push origin :main", "git push origin :main"],
    ["git push origin :feature", "git push origin :feature"],
    ["git push --delete origin feature", "git push --delete origin feature"],
    ["git push -d origin feature", "git push -d origin feature"],
    ["git push origin +feature:feature", "git push origin +feature:feature"],
    ["git push --force origin feature", "git push --force origin feature"],
    ["git push -f origin feature", "git push -f origin feature"],
    ["git push -uf origin feature", "git push -uf origin feature"],
    ["env assignment + force-with-lease", "FOO=1 git push --force-with-lease"],
    ["env wrapper + force-with-lease=ref", "env FOO=1 git push --force-with-lease=feature origin feature"],
    ["git -C subdir push origin main", "git -C /tmp/repo push origin main"],
    ["git reset --hard origin/main", "git reset --hard origin/main"],
    ["git reset --hard origin/master", "git reset --hard origin/master"],
    ["git reset --hard main", "git reset --hard main"],
    ["git reset --hard refs/remotes/origin/main", "git reset --hard refs/remotes/origin/main"],
    ["git branch -f main HEAD", "git branch -f main HEAD"],
    ["git branch -D main", "git branch -D main"],
    ["git checkout -B main", "git checkout -B main"],
    ["git switch -C master", "git switch -C master"],
    ["git update-ref refs/heads/main HEAD", "git update-ref refs/heads/main HEAD"],
    ["bash -c pushing to main", 'bash -c "git push origin main"'],
    ["sh -c force push", "sh -c 'git push -f origin dev'"],
    ["sh -lc chained sudo", 'sh -lc "echo hi; sudo ls"'],
    ["pipe to sudo", "echo test | sudo tee /etc/hosts"],
    ["direct sudo", "sudo rm -rf /tmp/foo"],
    ["path-qualified sudo", "/usr/bin/sudo id"],
    ["command substitution executing git push main", 'echo "$(git push origin main)"'],
    ["gh pr merge with squash", "gh pr merge 3 --squash"],
    ["gh -R owner/repo pr merge 3", "gh -R owner/repo pr merge 3"],
    ["gh api delete branch protection", "gh api -X DELETE repos/a/b/branches/main/protection"],
    ["gh api get branch protection subresource", "gh api repos/a/b/branches/main/protection/enforce_admins"],
    ["gh api rulesets endpoint", "gh api -X PUT repos/a/b/rulesets/123"],
    ["gh api org rulesets endpoint", "gh api https://api.github.com/orgs/acme/rulesets"],
    ["gh api graphql branch protection mutation", "gh api graphql -f query='mutation { deleteBranchProtectionRule(input: {id: \"1\"}) { clientMutationId } }'"],
    ["gh repo delete", "gh repo delete owner/repo --yes"],
  ];

  for (const [label, cmd] of deniedCases) {
    test(`denies: ${label}`, () => {
      const res = checkCommand(cmd);
      expect(res.decision).toBe("deny");
      if (res.decision === "deny") {
        expect(res.reason.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("guard payload and CLI contract", () => {
  test("denies malformed JSON with required reason", () => {
    expect(evaluateHookInput("{not valid json")).toEqual({
      decision: "deny",
      reason: "guard could not read the command",
    });
  });

  test("denies empty stdin with required reason", () => {
    expect(evaluateHookInput("")).toEqual({
      decision: "deny",
      reason: "guard could not read the command",
    });
  });

  test("denies missing toolCall.args.CommandLine", () => {
    expect(evaluateHookInput(JSON.stringify({ toolCall: { name: "run_command", args: {} } }))).toEqual({
      decision: "deny",
      reason: "guard could not read the command",
    });
  });

  test("CLI exits 0 and prints allow JSON for allowed payload", async () => {
    const { exitCode, output } = await runGuardCli(makeHookPayload("git push origin feature/x"));
    expect(exitCode).toBe(0);
    expect(output).toEqual({ decision: "allow" });
  });

  test("CLI exits 0 and prints deny JSON for blocked payload", async () => {
    const { exitCode, output } = await runGuardCli(makeHookPayload("git push origin HEAD:main"));
    expect(exitCode).toBe(0);
    expect(output.decision).toBe("deny");
    expect(typeof output.reason).toBe("string");
  });

  test("CLI exits 0 and prints deny JSON for malformed stdin", async () => {
    const { exitCode, output } = await runGuardCli("<<<corrupt>>>");
    expect(exitCode).toBe(0);
    expect(output).toEqual({
      decision: "deny",
      reason: "guard could not read the command",
    });
  });
});
