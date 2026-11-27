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
    ["checkout -B feature branch from main", "git checkout -B feature/x main"],
    ["switch -C feature branch from main", "git switch -C feature/x main"],
    ["branch -f feature branch from main", "git branch -f feature/x main"],
    ["branch -C main to feature branch", "git branch -C main feature/copy"],
    ["rebase feature branch onto origin/main", "git rebase origin/main"],
    ["rebase --onto main feature", "git rebase --onto main feature/x"],
    ["gh pr create with quoted heredoc mentioning sudo", "gh pr create --title \"Docs\" --body-file - <<'EOF'\nsudo is blocked\nEOF"],
    ["cat quoted heredoc mentioning git push origin main", "cat <<'EOF' > /tmp/notes\ngit push origin main\nEOF"],
    ["cat quoted heredoc with space before delimiter", "cat << 'EOF' > /tmp/notes\nsudo id\nEOF"],
    ["cat unquoted heredoc with plain text", "cat <<EOF > /tmp/notes\nplain notes\nEOF"],
    ["command -v sudo query", "command -v sudo"],
    ["command -V sudo query", "command -V sudo"],
    ["arithmetic expansion without command sub", "echo $((1 + 2))"],
    ["nested parens arithmetic expansion", "echo $(( (1 + 2) * 3 ))"],
    ["agy -p /usage quota check", "agy -p /usage"],
    ["agy normal prompt", 'agy --agent builder -p "fix the bug"'],
    ["agy plugin validate", "agy plugin validate --strict claude-agent-crew/workers/agy/plugin"],
    ["piped normal prompt to agy", 'echo "fix bug" | agy'],
    ["bash syntax check", "bash -n ./scripts/build.sh"],
    ["bash script execution", "bash software-factory/install.sh . --link"],
    ["xargs grep", "git ls-files | xargs grep TODO"],
    ["source virtualenv", "source .venv/bin/activate"],
    ["dot source env file", ". ./env.sh"],
    ["backtick with balanced single quotes without backticks", 'echo "`echo \'hello\'`"'],
    ["git commit with quoted heredoc containing ) inside $()", 'git commit -m "$(cat <<\'EOF\'\nfix: handle ) parens\nEOF\n)"'],
    ["bash -c echo with safe command sub", 'bash -c "echo $(date)"'],
    ["parallel cat with placeholder", 'parallel "cat {}" ::: file1 file2'],
    ["echo -e without backslash piped to agy", 'echo -e "fix bug" | agy'],
    ["printf %s piped to agy", 'printf "fix %s\\n" "bug" | agy'],
    ["agy -p normal prompt containing cmdsub", 'agy -p "fix $(date)"'],
    ["single-quoted literal binary name", "'$(echo sudo)' id"],
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
    ["agy -p /swarm", "agy -p /swarm"],
    ["agy -p /teamwork", 'agy -p "/teamwork do x"'],
    ["agy --prompt /boost", 'agy --prompt "/boost fix"'],
    ["agy --prompt=/boost", "agy --prompt=/boost"],
    ["agy positional /swarm", "agy /swarm"],
    ["echo /boost piped to agy", 'echo "/boost" | agy'],
    ["printf /teamwork piped to agy", 'printf "/teamwork\\n" | agy'],
    ["cat heredoc /swarm piped to agy", "cat <<'EOF' | agy\n/swarm\nEOF"],
    ["agy here-string /boost", 'agy <<< "/boost"'],
    ["sh here-string", "sh <<<'git push origin main'"],
    ["bash here-string", 'bash <<<"sudo id"'],
    ["sh here-string without spaces", "sh<<<'echo hi'"],
    ["bash heredoc", "bash <<'EOF'\necho hi\nEOF"],
    ["sh unquoted heredoc", "sh <<EOF\ngit push origin main\nEOF"],
    ["unquoted heredoc with command substitution", "cat <<EOF > /tmp/notes\n$(git push origin main)\nEOF"],
    ["unquoted heredoc with single-quoted command substitution", "cat <<EOF > /tmp/notes\n'$(sudo id)'\nEOF"],
    ["ANSI-C quoting sudo", "$'sudo' id"],
    ["ANSI-C quoting git subcommand", "git $'push' origin main"],
    ["ANSI-C quoting branch", "git push origin $'main'"],
    ["locale quoting gh", '$"gh" pr merge 1'],
    ["command substitution inside redirect", "echo >$(sudo id)"],
    ["quoted command substitution inside redirect", 'cat <"$(git push origin main)"'],
    ["command substitution inside >& redirect", "echo >&$(sudo id)"],
    ["command substitution inside arithmetic", "echo $((0+$(git push origin main)))"],
    ["command substitution sudo inside arithmetic", "echo $((1+$(sudo id)))"],
    ["backtick inside arithmetic", "echo $((1+`sudo id`))"],
    ["subshell disguised as $((...))", "echo $((git push origin main); echo hi)"],
    ["command substitution inside $[...] arithmetic", "echo $[1+$(sudo id)]"],
    ["case pattern ) inside $()", 'echo "$(case x in x) git push origin main ;; esac)"'],
    ["case optional (pattern) inside $()", 'echo "$(case x in (a|b) sudo id ;; esac)"'],
    ["single-quoted backtick inside backticks", "echo \"`echo '`'; sudo id; echo '`'`\""],
    ["eval with quoted command", 'eval "git push origin main"'],
    ["eval with unquoted tokens", "eval git push -f origin dev"],
    ["xargs git push", "echo main | xargs git push origin"],
    ["xargs sudo", "echo id | xargs sudo"],
    ["xargs gh pr merge", "echo 1 | xargs gh pr merge"],
    ["xargs sh -c", 'echo hi | xargs -I{} sh -c "{}"'],
    ["parallel git push", "echo main | parallel git push origin {}"],
    ["parallel sudo", "parallel sudo ::: id"],
    ["parallel ::: command", 'parallel ::: "git push origin main"'],
    ["parallel quoted command string", 'parallel "git push origin {}" ::: main'],
    ["source with process substitution", 'source <(echo "git push origin main")'],
    ["dot with process substitution", '. <(echo "sudo id")'],
    ["cat with process substitution running sudo", "cat <(sudo id)"],
    ["zsh alias bypass", "zsh -c \"alias p='git push origin main'; p\""],
    ["pipe into bash", 'echo "git push origin main" | bash'],
    ["pipe into sh", 'echo "echo hi" | sh'],
    ["pipe into zsh", 'echo "echo hi" | zsh'],
    ["multiline pipe into bash", 'echo "echo hi" |\nbash'],
    ["bash -O extglob -c", 'bash -O extglob -c "git push origin main"'],
    ["bash --rcfile -c", 'bash --rcfile /dev/null -c "sudo id"'],
    ["bash --init-file -c", 'bash --init-file /dev/null -c "sudo id"'],
    ["sh -c --", 'sh -c -- "git push origin main"'],
    ["bash -c -l", 'bash -c -l "git push origin main"'],
    ["bash unrecognized flag with -c", 'bash --unknown-opt -c "echo hi"'],
    ["sh unrecognized short flag with -c", 'sh -Z -c "echo hi"'],
    ["timeout wrapper", "timeout 30 git push origin main"],
    ["timeout with signal flag", "timeout -s KILL 30s sudo id"],
    ["nice wrapper", "nice sudo id"],
    ["nice -n wrapper", "nice -n 10 git push origin main"],
    ["nohup wrapper", "nohup git push origin main"],
    ["env attached -S", 'env -S"git push origin main"'],
    ["env -S combined with trailing args", 'env -S "git push" origin main'],
    ["more than 16 env assignments", "A=1 B=2 C=3 D=4 E=5 F=6 G=7 H=8 I=9 J=10 K=11 L=12 M=13 N=14 O=15 P=16 Q=17 git push origin main"],
    ["sudo with attached redirect", "sudo>/dev/null id"],
    ["git push --mirror", "git push --mirror origin"],
    ["git push --all", "git push --all origin"],
    ["git push wildcard refs/heads/*", 'git push origin "refs/heads/*"'],
    ["git push wildcard *:*", 'git push origin "*:*"'],
    ["git -c alias.go push main", "git -c alias.go='push origin main' go"],
    ["git -c alias.go shell command", "git -c alias.go='!sudo id' go"],
    ["git attached -calias.go", "git -calias.go='!sudo id' go"],
    ["git -c remote.origin.push", "git -c remote.origin.push=HEAD:main push origin"],
    ["git -c case-insensitive remote.origin.Push", "git -c REMOTE.origin.Push=HEAD:main push origin"],
    ["git -c core.hooksPath bypass", "git -c core.hooksPath=/dev/null push origin feature/x"],
    ["git rebase origin/main main", "git rebase origin/main main"],
    ["git rebase -i HEAD~2 main", "git rebase -i HEAD~2 main"],
    ["git rebase --onto HEAD~3 HEAD~1 main", "git rebase --onto HEAD~3 HEAD~1 main"],
    ["git rebase --root main", "git rebase --root main"],
    ["git rebase -x sudo", 'git rebase -x "sudo id" origin/main'],
    ["git filter-branch main", "git filter-branch -f --tree-filter 'rm -f x' main"],
    ["git filter-branch --all", "git filter-branch --all"],
    ["git branch -M feature main", "git branch -M feature main"],
    ["git branch -M main feature", "git branch -M main feature"],
    ["git branch -C feature main", "git branch -C feature main"],
    ["git checkout -qB main", "git checkout -qB main"],
    ["git switch -qC main", "git switch -qC main"],
    ["git switch --force-create=main", "git switch --force-create=main"],
    ["git reset --hard main~1", "git reset --hard main~1"],
    ["git reset --hard origin/main~1", "git reset --hard origin/main~1"],
    ["git reset --hard main^", "git reset --hard main^"],
    ["git reset --hard main@{1}", "git reset --hard main@{1}"],
    ["git update-ref --stdin", 'echo "update refs/heads/main HEAD" | git update-ref --stdin'],
    ["gh api graphql --input -", 'echo \'{"query":"mutation { deleteBranchProtectionRule(input:{branchProtectionRuleId:\\"1\\"}) { clientMutationId } }"}\' | gh api graphql --input -'],
    ["gh api graphql --input file", "gh api graphql --input payload.json"],
    ["gh api graphql attached -fquery=", 'gh api graphql -fquery=\'mutation { deleteBranchProtectionRule(input: {id: "1"}) { clientMutationId } }\''],
    ["gh api graphql -F query=@file", "gh api graphql -F query=@mutation.graphql"],
    ["gh api full GHE graphql URL", 'gh api https://ghe.example.com/api/graphql -f query=\'mutation { deleteBranchProtectionRule(input: {id: "1"}) { clientMutationId } }\''],
    ["heredoc ) inside $() hiding trailing sudo", 'echo "$(cat <<\'EOF\'\n)\nEOF\nsudo id)"'],
    ["bash with process substitution", 'bash <(echo "git push origin main")'],
    ["sh with process substitution", 'sh <(echo "sudo id")'],
    ["unclosed single quote", "echo 'sudo id"],
    ["unclosed double quote", 'echo "sudo id'],
    ["command substitution as binary name", "$(echo sudo) id"],
    ["backtick as binary name", "`echo sudo` id"],
    ["bash -c whose command is command substitution", 'bash -c "$(echo git push origin main)"'],
    ["git subcommand via command substitution", "git $(echo push) origin main"],
    ["env -S expanding env flags before sudo", 'env -S "-i sudo" id'],
    ["nested env -S", 'env -S "-S sudo" id'],
    ["xargs nested xargs sudo", "echo id | xargs xargs sudo"],
    ["xargs -I{} placeholder as command", "echo sudo | xargs -I{} {} id"],
    ["xargs -i placeholder as command", "echo sudo | xargs -i {} id"],
    ["xargs --replace flag before sudo", "echo 1 | xargs --replace sudo id"],
    ["xargs --eof flag before sudo", "echo 1 | xargs --eof sudo id"],
    ["xargs --max-lines flag before sudo", "echo 1 | xargs --max-lines sudo id"],
    ["parallel nested xargs sudo", "parallel xargs sudo ::: id"],
    ["parallel {} placeholder as command", 'parallel {} ::: "sudo id"'],
    ["parallel {1} {2} placeholder as command", 'parallel "{1} {2}" ::: sudo ::: id'],
    ["git rebase attached -x", "git rebase -xsudo origin/main"],
    ["git rebase combined -ix", 'git rebase -ix "sudo id" origin/main'],
    ["git filter-branch --branches=main", "git filter-branch --branches=main"],
    ["git filter-branch --tree-filter running sudo", "git filter-branch -f --tree-filter 'sudo id' HEAD~1..HEAD"],
    ["git -c remote.origin.mirror=true", "git -c remote.origin.mirror=true push origin"],
    ["gh api graphql trailing slash", 'gh api graphql/ -f query=\'mutation { deleteBranchProtectionRule(input: {id: "1"}) { clientMutationId } }\''],
    ["printf octal escape /boost piped to agy", 'printf "\\057boost" | agy'],
    ["echo -e hex escape /boost piped to agy", 'echo -e "\\x2fboost" | agy'],
    ["echo command sub piped to agy", 'echo "$(cat /tmp/x)" | agy'],
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
