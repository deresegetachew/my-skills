# Crew Job Runner

Headless job runner for `claude-agent-crew`. In a project, run it from the project's repo as
`bun ~/.claude/skills/claude-agent-crew/runner/crew.ts <command>` (the skill linked as in `machines.md`); inside
my-skills, `bun claude-agent-crew/runner/crew.ts <command>`. Over ssh the remote side uses the runner in its repo if
there is one, else the remote user's installed skill.
Bun and TypeScript only, no npm packages.

The job-lifecycle design (`start`, `wait`, `status`, `result`, `cancel`, `list`, `clean`) is adapted from
[agy-staff](https://github.com/keli-wen/agy-staff) (MIT). The terse `Status:` result format follows the Caveman
and Ponytail prompt ideas.

## Commands

| Command | What it does |
| --- | --- |
| `start --role <role> --brief <file> [--branch <name>] [--continue <job-id>] [--timeout <dur>] [--local]` | Creates a job and a worktree under `.crew/worktrees/`, starts the worker detached, prints `Started job <id>`. |
| `wait <job-id> [--timeout 10m]` | Blocks until the job leaves `running` or the timeout passes. |
| `status [job-id]` | One job in detail, or the list when no id is given. |
| `result <job-id>` | Prints the worker's final answer (first line `Status: DONE` / `ATTENTION` / ...). |
| `cancel <job-id>` | SIGTERM, then SIGKILL, to the job's whole process group. |
| `list` | One line per job. Running remote jobs are refreshed over ssh first (best effort). |
| `clean` | Removes worktrees that are safe to remove (see below). |

`--help` works on every command. Unknown flags, missing flag values and extra arguments are rejected.
Job ids contain only letters, digits, `_` and `-`; anything else is refused (`INVALID_JOB_ID`).

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done / command succeeded |
| 1 | usage or runner error (JSON `{code, message, fix}` on stderr) |
| 2 | still running (`wait` timed out, `result` called too early) |
| 3 | job failed (`error`) |
| 4 | job canceled |
| 5 | needs attention: resumable timeout, the printed `Next:` command continues it |

## Layout

Everything lives in `.crew/` (added to `.git/info/exclude`):

- `.crew/jobs/<id>.json`: the job record. `.crew/logs/<id>.log` and `<id>.stdout.json`: worker output.
- `.crew/worktrees/`: one worktree per builder branch, one detached worktree per read-only job (reviewers etc.).
- `.crew/usage.jsonl`: token usage reported by the worker.
- `.crew/start.lock/`: held by `start` and `clean`. It holds the owner pid; a lock is only taken over when
  that pid is dead, never because it is old.

`.crew` and `.crew/worktrees` must be real directories inside the repo; symlinks are refused
(`WORKTREE_OUTSIDE_CREW`) and `clean` then keeps everything.

## `clean` safety rules

`clean` never passes `--force` to `git worktree remove` and keeps a worktree, saying why in its output, when:

- a job using it is still running;
- it has uncommitted changes, or ignored files (`.env`, build output) that removal would delete;
- it is outside `.crew/worktrees/`;
- its HEAD is detached or branchless and **no branch, remote-tracking branch or tag contains HEAD** (the commits
  would be lost). When unsure, for example HEAD cannot be read, it keeps the worktree;
- a builder branch is neither merged into `origin/main` (or `main`) nor deleted on origin.

`start` and `clean` share one lock and `clean` reads job statuses inside it, so a worktree handed to a new job is
never removed under it.

## Other behavior worth knowing

- A job stuck in `running` with no pid after 30 s (`CREW_PID_GRACE_MS`) counts as failed (`EXEC_START_FAILED`);
  `cancel` can end a pid-less job.
- A `timed out` line on stderr only means timeout when the worker exited non-zero.
- `--continue` exists, but the crew skill does not use it: resuming a long conversation re-reads all of it on every
  step. Start a fresh job on the same branch instead.
- `--continue` refuses a worktree whose branch was switched (`CONTINUE_BRANCH_CHANGED`) or that is outside
  `.crew/worktrees/`.
- Remote roles (`machine` with an ssh target): a brief inside the repository is passed by its path, so it must
  already be on the remote. A brief anywhere else (such as the orchestrator's scratch folder) is copied over ssh to
  `.crew/briefs/` in the remote repo first.
  Every ssh call has a timeout (`CREW_SSH_TIMEOUT_MS`, default 60 s; `wait` adds its own `--timeout`).
- Environment knobs, mainly for tests: `CREW_LOCK_WAIT_MS` (default 5000), `CREW_PID_GRACE_MS`,
  `CREW_SSH_TIMEOUT_MS`.

## Tests

`bun test claude-agent-crew/runner/crew.test.ts` (fake `agy`, `claude` and `ssh` on `PATH`, real git repositories in temp dirs).
