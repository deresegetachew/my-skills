# Claude worker

A crew member run as a headless `claude -p` session. Set `"worker": "claude"` for a role in `.claude/crew.json`;
the job runner (`runner/crew.ts`) starts it the same way as an agy job, so `start`, `wait`, `result`, `cancel`
and `--continue` all work unchanged (the crew skill says not to use `--continue`; see `SKILL.md` step 4).

## How the runner starts it

```
claude -p --output-format json --settings <settings.worker.json> --append-system-prompt <crew rules>
       [--model <model>] [--disallowedTools Edit Write NotebookEdit] (--session-id <new id> | --resume <id>)
```

- **The brief goes on stdin**, never as an argument, so a brief that starts with `-` is not read as a flag.
- **Crew rules:** the same file the agy plugin uses (`workers/agy/plugin/rules/AGENTS.md`), added to the system
  prompt.
- **Read-only roles** (`reviewer`, `*-reviewer`, `*-check`, `auditor`, `researcher`) cannot edit or write files.
- **Session id:** the runner picks it and records it before the run starts. A run stopped by `--timeout` therefore
  ends as `attention` (exit 5). `--continue <job>` would pass `--resume`, but the crew starts a fresh job on the
  same branch instead, which is cheaper.
- **Timeout:** claude has no print timeout of its own. The runner stops the worker and every process under it when
  `--timeout` (default `30m`, `0` for none) runs out.
- **Usage:** the result's `usage` and `total_cost_usd` go to `.crew/usage.jsonl`.

## Guard rails

`settings.worker.json` (a project can override it with `.claude/settings.worker.claude.json`):

- **Permissions:**
  - `defaultMode: dontAsk`: anything not allowed is refused, and no one is asked.
  - Bypass mode is disabled.
  - Deny rules for `sudo`, force-pushes, pushes to main/master, `gh pr merge` and `gh repo delete`.
- **PreToolUse hook on Bash:** run with the runner's own bun (`CREW_BUN`), so a missing `bun` on `PATH` cannot
  skip it. `hook.ts` runs the agy guard's own `checkCommand`, so both workers refuse the same
  commands. A refusal is Claude's `permissionDecision: "deny"` with the reason. An allowed command prints nothing,
  so the deny rules above still apply. A tool call the hook cannot read is refused.

As with agy, the guard is a first layer only. The hard guarantees are the rule on main, per-role GitHub tokens and
a crew OS user without sudo (see `project-setup.md` and `machines.md`).

## Proven

- **27 Nov:** a real `claude -p` builder job on `claude-haiku-5-5`.
  - The hook refused `sudo -n true`.
  - `git status` ran.
  - The worker refused a push to main under the crew rules.
  - The cost of $0.005 was logged.
- **Tests:**
  - `bun test claude-agent-crew/workers/claude/hook.test.ts`;
  - the `claude worker` tests in `runner/crew.test.ts` (fake `claude` on `PATH`).

## Signing in on a crew machine

Run `claude setup-token` once as the crew user and save the `sk-ant-…` token it prints to
`~/.config/crew/claude-oauth-token` (mode 600, the human pastes it; nobody else sees it). The runner passes it to each
claude job as `CLAUDE_CODE_OAUTH_TOKEN`; it never prints or logs it. A normal `claude auth login` also works but expires.

## Known limits

- `claude` must be installed and signed in on the machine that runs the job. On 27 Nov it was on the Mac, not the
  dev PC.
- Workers must not start sub-agents or `/swarm`-style fan-outs unless the brief asks. The crew rules say so, but
  nothing enforces it.
