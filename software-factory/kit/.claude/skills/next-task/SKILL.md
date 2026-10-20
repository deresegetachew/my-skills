---
name: next-task
description: Pick the next unticked task in the build plan, build it on its own branch with tests, open a pull request, merge it when the gate allows, tick it off, and continue. Use when asked to "do the next task", "continue the build", "go on one by one" or `/next-task all`.
---

# Next task

Work through the build plan one task at a time. Paths and commands come from `.claude/factory.json`
(`plan`, `blocked`, `prd`, `decisions`, `commands`). Arguments: `$ARGUMENTS`: empty for one task, a task id
such as `1.3`, or `all` to keep going, phase after phase, until every remaining task is blocked.

## 1. Pick the task

1. `git checkout <mainBranch> && git pull`.
2. Open the plan and the blocked list (create the blocked list if missing).
3. Take the first unticked `- [ ]` task, in order, that is not in the blocked list. Respect phase order:
   don't start a phase until the previous phase's "Done when" checks pass, unless the plan says phases overlap.
4. Read the PRD sections, design references and decisions the task points to. Say in one line which task
   you're doing and what "done" means for it.

## 2. Check what you need

If the task needs something only a person can provide (real data, an API key or account, a legal, naming
or product decision the docs leave open), don't guess:

- add it to the blocked list as `- 1.5: needs 30 real samples in data/samples/ (person)`,
- commit that on a branch and open a short pull request titled `Blocked: <task>`,
- go back to step 1 for the next task that isn't blocked.

Small gaps the docs don't cover: choose the simplest option that fits the PRD, write it down as
`<decisions>/NNNN-title.md`, and carry on.

## 3. Build it

1. Branch: `git checkout -b task/<id>-<short-name>`.
2. For tasks that add behaviour, ask the `test-writer` subagent to write the failing tests first. Then plan
   the change briefly and implement it following `CLAUDE.md` and the decisions.
3. Test what a user or another module can observe. Run the task's "Done when" check and the project's
   `typecheck`, `lint` and `test` commands. Fix until they pass. Show the output as evidence.
4. UI work: run the `design-check` skill if the project has design references. Work on prompts, models or
   scoring: run the `eval` skill if the project has an eval.
5. If the diff touches what CLAUDE.md calls critical rules, ask the `safety-auditor` subagent and put its
   report in the pull request. If it touches auth, payments, public endpoints, uploads, storage, tenancy,
   secrets or model calls on untrusted input, ask the `security-reviewer` subagent. Fix every must-fix.
6. Ask the `reviewer` subagent to review the diff against the task, the PRD and `CLAUDE.md`. Fix every
   must-fix it reports. Ignore style preferences.

## 4. Ship it

1. Tick the task in the plan (`- [x]`) on the same branch.
2. Commit in small logical commits, push, and open a pull request with `gh pr create`: title
   `<id>: <task name>`, body with what changed, how it was verified (commands and results), what the
   reviewer and auditors raised, and any decision you recorded.
3. Once CI is green, merge it yourself with `gh pr merge --squash --delete-branch`, then pull the main
   branch before the next task. The pull-request gate (`.claude/hooks/pr-gate.py`) allows this only when the
   reviewer passed the latest commit, CI is green and no protected files changed. Ticking your task's box in
   the plan or adding to the blocked list is not a protected change. If the gate says a person must merge it,
   write "A person merges this one: <why>" at the end of the PR description, leave it open and continue: the
   dev manager reviews and merges those. If the person said not to merge, leave every pull request open.

## 5. Continue or stop

- With `all`, go back to step 1. When a phase's tasks are all ticked, run its "Done when" check; if it passes,
  carry straight on with the next phase. Don't stop to report between phases.
- Pull requests waiting for review don't stop you. Before each task, pull the main branch; if the PR you
  stacked on has merged, start the next branch from the main branch, not from the old one.
- Stop and report only when every remaining task is blocked, a "Done when" check or CI fails in a way you
  can't fix, or a task would break one of the rules in `CLAUDE.md`.
- The report is short: tasks done (with PR links), tasks blocked and what each needs from the person.
