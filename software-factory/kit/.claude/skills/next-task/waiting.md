# Next task: continue, wait or stop

Read this after shipping a task, or when you have to wait.

- With `all`, go back to step 1. When a phase's tasks are all ticked, run its "Done when" check; if it passes, carry
  straight on with the next phase. Don't stop to report between phases.
- Pull requests waiting for review don't stop you. Before each task, pull the main branch; if the PR you stacked on
  has merged, start the next branch from the main branch, not from the old one.
- **Never sleep waiting for a merge; wait on GitHub.** You get no notification when a PR merges, so a timed pause
  ("I'll check back in 30 minutes") wastes the whole wait. When the next task depends on an unmerged PR (it changes
  the same files, or the plan stacks on it), run `.claude/hooks/wait_for_merge.sh <n> 30`. It polls GitHub every
  minute without using model tokens and returns as soon as the PR merges (exit 0). If it times out (exit 2), take
  `bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --after <id>` for a task that doesn't touch those files, and say so in your
  report. Under `factory-loop.sh`, stop the run instead: the loop skips a task whose branch is on the remote and
  claims the next free one.
- **Every wait goes through `factory wait`; never poll in the conversation** (each check is a turn that re-sends the
  whole context). `factory wait ci <pr>` until CI has finished (0 green, 1 failed with the check named),
  `factory wait answer <pr>` until a `factory-question` is answered, `factory wait slot` until a PR slot frees,
  `factory wait ready` until a task is ready. Exit 2 means timed out: do other work. Same as `wait_for_merge.sh`
  for merges.
- **Work-in-progress cap:** the PR gate won't open a new PR while `maxOpenPRs` of yours are open (all loops
  together). Push the finished branch and stop (under `factory-loop.sh`) or wait on the oldest with
  `wait_for_merge.sh`. Under the loop you don't have to ask anyone to restart you: `next_task.ts` waits while your
  issue's branch is pushed and the cap is full, and gives you the issue again as soon as a slot frees, so the next
  session only opens the PR. **In an interactive loop**, end that session the usual way so the loop can wait:
  `bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts done --agent "$FACTORY_AGENT" --task <id>`, then one line,
  `Task <id> pushed; its PR waits for a slot.` Keep the issue (don't release it): the loop gives it back to you.
- **CI that never ran:** when every job fails at once with no steps, run
  `bun --no-env-file --config=/dev/null .claude/hooks/factory_ci.ts <head commit>`. If it says GitHub didn't start the jobs (billing or the spending limit), that's not about your code:
  don't change code, push again or re-run CI. Say so once on the PR and carry on; the dev manager re-runs CI when it
  works.
- **Fresh context per task:** if the owner started you with `./factory-loop.sh` (or `factory loop`), do exactly one
  task and stop; the loop starts a fresh run for the next one. Keep anything the next run needs in git, the PR or the
  issue, not in your memory.
- **Interactive loop** (`FACTORY_INTERACTIVE=1`, from `factory loop -i`): the owner may be at the terminal. You may
  ask them short questions there, but decisions still go in the PR or a decision file, so the next fresh session sees
  them. When the task is done (PR opened, claim dropped), mark it done with
  `bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts done --agent "$FACTORY_AGENT" --task <id>` and end with one line:
  `Task <id> done: <PR link>.` The session then closes by itself and the loop starts the next task. Don't start
  another task in this session.
- Stop and report only when every remaining task is blocked, a "Done when" check or CI fails in a way you can't fix,
  or a task would break one of the rules in `CLAUDE.md`.
- The report is short: tasks done (with PR links), tasks blocked, and questions still open (with links to their
  comments). Questions are asked in PR comments, never only in the report.
