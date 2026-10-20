---
name: next-task
description: Pick the next unticked task in the build plan, build it on its own branch with tests, open a pull request, merge it when the gate allows, tick it off, and continue. Use when asked to "do the next task", "continue the build", "go on one by one" or `/next-task all`.
---

# Next task

Work through the build plan one task at a time. Paths and commands come from `.claude/factory.json`
(`plan`, `blocked`, `prd`, `decisions`, `commands`). Arguments: `$ARGUMENTS`: empty for one task, a task id
such as `1.3`, or `all` to keep going, phase after phase, until every remaining task is blocked.

## 1. Pick the task

1. **Start routine** (every task, so a stale context can't mislead you): `git checkout <mainBranch> && git pull`,
   read `git log --oneline -15`, and run the `smoke` command from `factory.json` if it has one. If main is
   broken, fixing it is the task.
2. **Let the script pick the task:** `python3 .claude/hooks/next_task.py`. It returns the first unticked task
   not in the blocked list, read from the main branch. Don't pick by reading the plan yourself; the PR gate
   refuses a branch for a task that's ticked or blocked. If `$ARGUMENTS` names a task id, use that one.
   Respect phase order: don't start a phase until the previous phase's "Done when" checks pass, unless the plan
   says phases overlap.
3. Read the PRD sections, design references and decisions the task points to. Say in one line which task
   you're doing and what "done" means for it.

## 2. Check what you need

If the task needs something only a person can provide (real data, an API key or account, a legal, naming
or product decision the docs leave open), don't guess:

- add it to the blocked list as `- 1.5: needs 30 real samples in data/samples/ (person)`,
- commit that on a branch and open a short pull request titled `Blocked: <task>`,
- go back to step 1 for the next task that isn't blocked.

Small gaps the docs don't cover: choose the simplest option that fits the PRD, write it down as
`<decisions>/NNNN-title.md`, and carry on. Number it from main at the moment you open the PR (highest number on
`origin/<mainBranch>` + 1); CI fails a PR whose decision number is already taken, and then you renumber.

## 2b. Questions go to the dev manager, not the terminal

The owner isn't watching your terminal; the dev manager is watching the repo. Whenever you need a decision
(the docs disagree, a rule gives a strange result, a reviewer suggestion is a judgement call, you'd otherwise
write "Decision for you" in a report):

1. Post it as a comment on the pull request it concerns (or, if there's no PR yet or you're stuck before the
   reviewer has passed, open a **draft** PR with `gh pr create --draft --title "Question: <topic>"`; drafts
   skip the reviewer check), starting with the marker `<!-- factory-question -->`. Write one question per comment, with the
   options you see, what each would change, and your recommendation.
2. Don't wait idle. Continue with the parts that don't depend on the answer, or the next task that doesn't.
3. Check for answers at each poll and before each task: `gh pr view <n> --comments`. An answer starts with
   `<!-- factory-answer -->`. Apply it, reply with what you changed, and carry on.
4. Only things the dev manager has marked `needs-owner` wait for a person; for those, keep going around them.

## 3. Build it

1. Branch: `git checkout -b task/<id>-<short-name>`.
2. For tasks that add behaviour, ask the `test-writer` subagent to write the failing tests first and commit
   them on their own. Then plan the change briefly and implement it following `CLAUDE.md` and the decisions.
   **Once implementation starts, the tests are read-only for you.** If a test turns out to be wrong, say why in
   a `<!-- factory-question -->` comment and let the test-writer or the dev manager change it. CI's factory guard
   fails a PR that edits tests or expected outputs after implementation started, changes tests or golden files
   that already existed, adds `.skip`/`.only`, or adds a dependency, until the dev manager has reviewed it.
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

1. Tick the task in the plan (`- [x]`) on the same branch: only your own task; CI fails a PR that ticks another.
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
- **Never sleep waiting for a merge; wait on GitHub.** You get no notification when a PR merges, so a timed
  pause ("I'll check back in 30 minutes") wastes the whole wait. When the next task depends on an unmerged PR
  (it changes the same files, or the plan stacks on it), run `.claude/hooks/wait_for_merge.sh <n> 30`. It
  polls GitHub every minute without using model tokens and returns as soon as the PR merges (exit 0). If it
  times out (exit 2), take `python3 .claude/hooks/next_task.py --after <id>` for a task that doesn't touch
  those files, and say so in your report.
- **Work-in-progress cap:** the PR gate won't open a new PR while `maxOpenPRs` of yours are open. Wait on the
  oldest with `wait_for_merge.sh`, or answer whatever is holding it up.
- **Fresh context per task:** if the owner started you with `./factory-loop.sh`, do exactly one task and stop;
  the script starts a fresh run for the next one. Keep anything the next run needs in git, the PR or the plan,
  not in your memory.
- Stop and report only when every remaining task is blocked, a "Done when" check or CI fails in a way you
  can't fix, or a task would break one of the rules in `CLAUDE.md`.
- The report is short: tasks done (with PR links), tasks blocked, and questions still open (with links to
  their comments). Questions are asked in PR comments, never only in the report.
