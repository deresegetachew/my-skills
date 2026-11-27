# claude-agent-crew (agy plugin)

The crew plugin for `agy`.

## Contents

- `plugin.json` — plugin manifest (`claude-agent-crew`, MIT)
- `rules/AGENTS.md` — always-on repository safety, workflow, and terse reporting rules
- `agents/` — ten role agents (`test-writer`, `builder`, `reviewer`, `security-reviewer`, `architecture-reviewer`, `auditor`, `journey-tester`, `designer`, `design-check`, `researcher`), each with `mainAgent: true` and `subagent: true`
- `hooks.json` + `scripts/guard.ts` — `PreToolUse` guard on `run_command` blocking pushes to `main`/`master`, force-pushes, branch deletes, history rewrites on `main`, `gh pr merge`, `gh repo delete`, `gh api` branch-protection/ruleset writes, `sudo`, `/teamwork`/`/swarm`/`/boost` invocations, and unreadable shell constructs
- `settings.worker.json` — headless worker permissions (`always-proceed` + prefix deny rules)

## Safety layers

The `PreToolUse` guard (`scripts/guard.ts`) and `settings.worker.json` are only the first layer: they block known dangerous commands and refuse shell constructs the guard cannot fully read. They do not catch everything: shell variables, scripts written and then run, some wrappers, `gh api` calls and git config tricks can get past them (listed in https://github.com/deresegetachew/my-skills/issues/684). The hard guarantees are elsewhere: the rule on `main` (PR required, approval from another identity, CI green, no bypass), each job holding only its own role's short-lived token, crew jobs running as an OS user without sudo, and the git `pre-push` hook.

## Install and use

Install the plugin once per machine:

```bash
agy plugin install <path-to-plugin>
```

Pass `settings.worker.json` per headless run with `--settings`:

```bash
agy --agent <role> --model <model> --settings <path-to-plugin>/settings.worker.json --output-format json -p "<brief>"
```

## Credits

Role and prompt ideas adapted from [keli-wen/agy-staff](https://github.com/keli-wen/agy-staff) (MIT) and the Caveman and Ponytail prompt patterns.
