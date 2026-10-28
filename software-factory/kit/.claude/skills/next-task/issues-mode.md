# Next task: issues mode

Read this when `tasks.source` in `.claude/factory.json` is `"issues"`. Each task is then a GitHub issue, not a line in
the plan, and the steps in SKILL.md change like this:

| Step | In issues mode |
|---|---|
| Pick | `next_task.ts` prints `issue-<n> <title>`: your own in-progress issue first, else it claims the next `factory:ready` one on GitHub for you (labels `factory:in-progress` and `agent:<your name>`). Your prompt may name `issue-<n>`. When the dev manager named your issue, claim exactly it: `bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --issue <n>` (refused with `{code, message, fix}` if taken or blocked; then stop and say so). |
| Read | `bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts show <n>`: the brief, goals, acceptance criteria, edge cases, todos. The acceptance criteria are the "Done when". |
| Branch | `task/<n>-<short-name>`, for example `task/42-style-leftovers`. |
| Todos | Tick each checkbox as you finish it: `bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts tick <n> <index>` (1-based). The board and the owner's phone show it. |
| Blocked | Instead of the blocked list: `bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts block <n> "<what a person must provide>"`, then the next job. |
| Ship | Don't tick the plan. The PR body starts with `Closes #<n>` (the gate checks it), then what changed and how it was verified. After `gh pr create`: `bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts review <n>`. Merging closes the issue. |
| Done | `bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts done --task issue-<n>` in an interactive loop (see `waiting.md`). |

Your own issue, `Agent: <name>`, tracks that you're alive. The hooks keep it current; don't edit or close it. If the
PR gate says your issue now belongs to another agent, you were quiet too long: leave that work and pick again. The
dev manager writes the issues and hands quiet ones (no activity for `tasks.staleHours`) to another agent, so push your
branch early and often: commits count as activity.

To bring a branch up to date with the main branch, merge it in (`git merge origin/<mainBranch>`); never rebase a
branch you have pushed. Force pushes are blocked, so a rebased branch can't be pushed again. Merge commits on the branch
are fine.
