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
- **Discoveries** (a decision, a blocker, a result the next agent needs) go on the task with `board_note`.
- The pull request, its review, CI and the gate stay on GitHub, as `SKILL.md` says.
