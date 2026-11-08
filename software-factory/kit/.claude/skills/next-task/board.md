# When the board is on

With `tasks.source` or `messaging.transport` set to `board` (or no transport set, on a machine with a board), your
session has one MCP server, `board`, and you use its tools for tasks and messages. Everything else in `SKILL.md` stays the same. With the board off, use `SKILL.md`'s
commands: nothing changes.

- **Start** with `board_prime`: what you hold, what is ready, what is blocked, recent events.
- **Your task.** Under the loop it is already claimed for you, and the loop keeps the claim alive while your session
  runs: you send no heartbeat. When you pick by hand, `board_claim` it and keep the token. Pass the token to
  `board_heartbeat` while you work (a claim lasts 30 minutes), to `board_release` when you give the task back (say what
  happens next), and to `board_close` when it is done or won't be done.
- **Questions and answers** go with `board_post` (to the dev manager, on the task); read a thread with `board_thread`.
  A question only the owner can answer is an owner ask (`questions.md`), never Claude Code's picker.
- **Discoveries** (a decision, a blocker, a result the next agent needs) go on the task with `board_note`.
- The pull request, its review, CI and the gate stay on GitHub, as `SKILL.md` says. Your task's id is the issue number
  (`3`), or `b17` for a task made on the board.
- **After `gh pr create`**, move the task to review:
  `bun --no-env-file --config=/dev/null .claude/hooks/factory_issues.ts review <n>`. Under the loop the claim's token is the
  loop's, not yours, so `board_close` is refused while you hold the task (`claim-lost`); this command ends the claim with
  the token this machine keeps.
- **After the merge**, close it: `board_close` with outcome `done` and a one-line reason (the PR number), with no token:
  the task is no longer held. Merging closes the GitHub issue, but not the task on the board, which is the record.
- **Then**, in an interactive loop, say you are done:
  `bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts done --task issue-<n>`. Run each of these
  commands on its own, not joined with others.
