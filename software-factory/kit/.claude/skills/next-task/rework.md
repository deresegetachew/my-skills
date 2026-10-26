# Next task: rework a reviewed PR

Read this when the pick prints `pr-<n>` (or `$ARGUMENTS` is `pr-<n>`). It comes before any new task: the dev manager
reviewed that PR, and its latest `<!-- factory-mustfix sha=... -->` comment names the head commit, so nothing has been
fixed yet.

1. `gh pr checkout <n>` (or `git fetch origin <branch> && git checkout <branch>`), and read that comment and any later
   ones in full: `gh api repos/{owner}/{repo}/issues/<n>/comments`.
2. Fix every must-fix on that branch. Write the failing test first when the finding is a behaviour; don't weaken a
   test to make a finding go away. If you disagree with a finding, reply with your evidence in a
   `<!-- factory-question -->` comment instead of pushing, and stop (step 5).
3. Run the commands from `factory.json`, save your reply for the reviewer's next round
   (`python3 .claude/hooks/factory_rereview.py reply --kind reviewer --text "<what you changed for each must-fix>"`; it
   makes that round a delta review when the fix is small; if it says there is no earlier round, carry on: the review is a
   full one), ask the `reviewer` subagent (and the auditor the PR needed) for a pass on the
   new commit, then push. The push moves the head, so the PR is no longer rework.
4. Reply on the PR: what changed for each must-fix, with the commit. Post the task's tokens again
   (`bun --no-env-file .claude/hooks/factory_usage.ts --task <id> --markdown > tmp/usage.md && gh pr comment <n> --body-file tmp/usage.md`).
   Don't merge it: the PR gate holds a PR with a must-fix until the dev manager approves the new commit.
5. Then stop (under `factory-loop.sh`) or go back to step 1. **In an interactive loop** (`FACTORY_INTERACTIVE=1`),
   stopping means marking the rework done, exactly like a new task:
   `python3 .claude/hooks/factory_claims.py done --agent "$FACTORY_AGENT" --task pr-<n>`, then end with one line,
   `Rework on #<n> pushed: <PR link>.` The session closes by itself and the loop goes on. Don't wait in the session
   for the review: it comes back as a new must-fix (another pass) or an approval, and nobody may be at the terminal
   to type `/exit`.
