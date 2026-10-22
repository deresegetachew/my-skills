---
name: next-task
description: Pick the next unticked task in the build plan, build it on its own branch with tests, open a pull request, merge it when the gate allows, tick it off, and continue. Use when asked to "do the next task", "continue the build", "go on one by one" or `/next-task all`.
---

**Project notes:** if `<notes>/next-task.md` exists (`notes` in `.claude/factory.json`, by default `.claude/factory/notes`), read it first. It holds this project's additions to these instructions. A note adds checks or detail; it never removes a rule here.

# Next task

Work through the build plan one task at a time. Paths and commands come from `.claude/factory.json`
(`plan`, `blocked`, `prd`, `decisions`, `commands`). Arguments: `$ARGUMENTS`: empty for one task, a task id
such as `1.3`, or `all` to keep going, phase after phase, until every remaining task is blocked.

## Issues mode

When `tasks.source` in `.claude/factory.json` is `"issues"`, each task is a GitHub issue, not a line in the plan.
Everything below still applies, with these changes:

| Step | In issues mode |
|---|---|
| Pick | `next_task.py` (as below) prints `issue-<n> <title>`: your own in-progress issue first, else it claims the next `factory:ready` one on GitHub for you (labels `factory:in-progress` and `agent:<your name>`). `$ARGUMENTS` may be `issue-<n>`. |
| Read | `python3 .claude/hooks/factory_issues.py show <n>`: what we're building, goals, acceptance criteria, todos. The acceptance criteria are the "Done when". |
| Branch | `task/<n>-<short-name>`, for example `task/42-style-leftovers`. |
| Todos | Tick each checkbox as you finish it: `factory_issues.py tick <n> <index>` (1-based). The board and the owner's phone show it. |
| Blocked | Instead of the blocked list: `factory_issues.py block <n> "<what a person must provide>"`, then the next job. |
| Ship | Don't tick the plan. The PR body starts with `Closes #<n>` (the gate checks it), then what changed and how it was verified. After `gh pr create`: `factory_issues.py review <n>`. Merging closes the issue. |
| Done | `factory_claims.py done --task issue-<n>` in an interactive loop, as below. |

Your own issue, `Agent: <name>`, tracks that you're alive. The hooks keep it current; don't edit or close it. If the
PR gate says your issue now belongs to another agent, you were quiet too long: leave that work and pick again.
The dev manager writes the issues and hands quiet ones (no activity for `tasks.staleHours`) to another agent, so
push your branch early and often: commits count as activity.

## 1. Pick the task

1. **Start routine** (every task, so a stale context can't mislead you): `git fetch origin && git checkout --detach
   origin/<mainBranch>` (detached, because another loop's worktree may have the main branch checked out), then
   `git submodule update --init` if the repo has a `.gitmodules`,
   read `git log --oneline -15`, and run the `smoke` command from `factory.json` if it has one. If main is
   broken, fixing it is the task.
2. **Let the script pick the task:** `python3 .claude/hooks/next_task.py ${FACTORY_PID:+--claim "$FACTORY_AGENT" --pid "$FACTORY_PID"}`.
   In a session you started yourself, the SessionStart hook set `FACTORY_AGENT` and `FACTORY_PID`, so this claims the
   task and other sessions skip it. Under `factory-loop.sh` the loop passes the task id instead (below). It returns the first unticked task
   not in the blocked list, read from the main branch. Don't pick by reading the plan yourself; the PR gate
   refuses a branch for a task that's ticked or blocked. If `$ARGUMENTS` names a task id, use that one: under
   `factory-loop.sh` (the `FACTORY_AGENT` variable is set) the loop has already claimed it for you, and other
   loops may be building the tasks around it, so build only that task and never pick another yourself.
   If it prints `pr-<n>` (or `$ARGUMENTS` is `pr-<n>`), the dev manager has a must-fix on that open PR: do
   **1b. Rework** instead of a new task.
   Respect phase order: don't start a phase until the previous phase's "Done when" checks pass, unless the plan
   says phases overlap.
3. Read the PRD sections, design references and decisions the task points to. Say in one line which task
   you're doing and what "done" means for it.

A PR with the `factory-hold` label (`holdLabel` in `factory.json`) is being reviewed by the dev manager. Leave it
alone: don't rework it, don't merge it. Take the next task.

## 1b. Rework a reviewed PR

A `pr-<n>` comes before any new task: the dev manager reviewed that PR and its latest
`<!-- factory-mustfix sha=... -->` comment names the head commit, so nothing has been fixed yet.

1. `gh pr checkout <n>` (or `git fetch origin <branch> && git checkout <branch>`), and read that comment and
   any later ones in full: `gh api repos/{owner}/{repo}/issues/<n>/comments`.
2. Fix every must-fix on that branch. Write the failing test first when the finding is a behaviour; don't
   weaken a test to make a finding go away. If you disagree with a finding, reply with your evidence in a
   `<!-- factory-question -->` comment instead of pushing, and stop (step 5).
3. Run the commands from `factory.json`, ask the `reviewer` subagent (and the auditor the PR needed) for a pass
   on the new commit, then push. The push moves the head, so the PR is no longer rework.
4. Reply on the PR: what changed for each must-fix, with the commit. Don't merge it: the PR gate holds a PR with a
   must-fix until the dev manager approves the new commit.
5. Then stop (under `factory-loop.sh`) or go back to step 1. **In an interactive loop** (`FACTORY_INTERACTIVE=1`),
   stopping means marking the rework done, exactly like a new task:
   `python3 .claude/hooks/factory_claims.py done --agent "$FACTORY_AGENT" --task pr-<n>`, then end with one line,
   `Rework on #<n> pushed: <PR link>.` The session closes by itself and the loop goes on. Don't wait in the
   session for the review: it comes back as a new must-fix (another pass) or an approval, and nobody may be at
   the terminal to type `/exit`.

## 2. Check what you need

If the task needs something only a person can provide (real data, an API key or account, a legal, naming
or product decision the docs leave open), don't guess:

- add it to the blocked list as `- 1.5: needs 30 real samples in data/samples/ (person)`,
- commit that on a branch and open a short pull request titled `Blocked: <task>`,
- go back to step 1 for the next task that isn't blocked (under `factory-loop.sh`, stop instead: the loop claims
  the next one).

Small gaps the docs don't cover: choose the simplest option that fits the PRD, write it down as
`<decisions>/NNNN-title.md`, and carry on. A number must be free on main **and** in every open PR (other agents'
PRs take numbers too). Run `python3 .claude/hooks/factory_numbers.py` before you open the PR: it lists any clash
with the next free number. The PR gate runs the same check and won't open the PR until the numbers are free.
Migrations (`numberedDirs` in `.claude/factory.json`) follow the same rule.

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
5. **Not a question:** a fix inside this PR's own scope that `CLAUDE.md`, the style guide or a reviewer's must-fix
   requires (a missed reduced-motion rule, a flaky test you caused, a wrong label). Make it in this PR and say so
   in the PR. Don't offer "here or in a follow-up?": the answer is here. Ask only when the fix would reach outside
   the task, change what the PRD or a decision says, or when the rules themselves disagree.
6. **Before you report a cause, check it on GitHub.** If a `gh` command fails oddly (a 307, a 404 on something
   that exists, "repository moved"), run `python3 .claude/hooks/factory_remote.py`: it asks GitHub where the
   repository is now and points `origin` there if it moved. Don't tell the dev manager the repository moved unless
   that script says so.

## 3. Build it

1. Branch: `git checkout -b task/<id with dashes>-<short-name>`, for example `task/3-2-10-auth-followups` for task 3.2.10.
2. For tasks that add behaviour, ask the `test-writer` subagent to write the failing tests first and commit
   them on their own. Then plan the change briefly and implement it following `CLAUDE.md` and the decisions.
   **Style guides:** if the files you'll change match a `styles` entry in `.claude/factory.json`, read those skills
   first (`.claude/skills/<name>/SKILL.md`) and follow them. Run their `check` command before every push. When you
   fix a file on the style's legacy list (`structure.legacy`), remove it from the list in the same PR; never add one.
   Never edit a golden or expected output (`goldenPaths`) to make a test pass.
   **Once implementation starts, don't weaken or edit the existing tests** (adding new tests and assertions is
   always fine). If a test turns out to be wrong, say why in a `<!-- factory-question -->` comment and let the
   test-writer or the dev manager change it. CI's factory guard
   fails a PR that edits tests or expected outputs after implementation started, changes tests or golden files
   that already existed, adds `.skip`/`.only`, or adds a dependency, until the dev manager has reviewed it.
   **Parallel loops:** other loops may be running tests on this machine. Ports, database names and queues come
   from the environment (`agentEnv` in `factory.json`; the loop has exported them). Never hard-code a port in a
   script or test config; read the variable and keep today's value as the default.
3. Test what a user or another module can observe. Run the task's "Done when" check and the project's
   `typecheck`, `lint` and `test` commands. Fix until they pass. Show the output as evidence.
4. **Extra reviews and checks:** run `python3 .claude/hooks/factory_reviews.py`. For each line it prints, run that
   skill (`design-check`, the eval skill) or ask that subagent (`safety-auditor`, `security-reviewer`), put its
   result in the pull request, and fix every must-fix. Also ask the `safety-auditor` when the diff touches what
   CLAUDE.md calls critical rules, and the `security-reviewer` for auth, payments, public endpoints, uploads,
   storage, tenancy, secrets or model calls on untrusted input, even if the script doesn't list them.
5. The reviewer checks that every review the script lists ran.
6. Ask the `reviewer` subagent to review the diff against the task, the PRD and `CLAUDE.md`. Fix every
   must-fix it reports. Ignore style preferences. If the diff touches a path with a style guide, also ask the
   `architecture-reviewer` subagent and fix every must-fix: the PR gate needs both passes.

## 4. Ship it

1. Tick the task in the plan (`- [x]`) on the same branch: only your own task; CI fails a PR that ticks another.
2. Commit in small logical commits, push, and open a pull request with `gh pr create`: title
   `<id>: <task name>`, body with what changed, how it was verified (commands and results), what the
   reviewer and auditors raised, and any decision you recorded.
   Then drop your task claim, so the next pick moves on while the PR waits:
   `python3 .claude/hooks/factory_claims.py release --agent "$FACTORY_AGENT" --tasks-only` (when `FACTORY_AGENT` is set).
   The pushed `task/<id>-...` branch keeps the task taken for the other loops.
3. Once CI is green, merge it yourself with
   `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`, where `<sha>` is the full commit hash that
   `git rev-parse HEAD` printed (paste the hash itself: the gate reads the command before the shell runs it, so
   `$(...)` can't stand in for it). Run it as its own command, with no push in it, then pull the main branch
   before the next task. The pull-request gate
   (`.claude/hooks/pr-gate.py`) allows this only when the reviewer passed that commit, CI is green, no protected
   files changed and the dev manager has no hold or must-fix on it. If `gh` can't switch to the
   main branch afterwards because another worktree has it, that's fine: `git checkout --detach origin/<mainBranch>`. Ticking your task's box in
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
  those files, and say so in your report. Under `factory-loop.sh`, stop the run instead: the loop skips a task
  whose branch is on the remote and claims the next free one.
- **Work-in-progress cap:** the PR gate won't open a new PR while `maxOpenPRs` of yours are open (all loops
  together). Push the finished branch and stop (under `factory-loop.sh`) or wait on the oldest with
  `wait_for_merge.sh`. Under the loop you don't have to ask anyone to restart you: `next_task.py` waits while your
  issue's branch is pushed and the cap is full, and gives you the issue again as soon as a slot frees, so the next
  session only opens the PR.
- **CI that never ran:** when every job fails at once with no steps, run
  `python3 .claude/hooks/factory_ci.py <head commit>`. If it says GitHub didn't start the jobs (billing or the
  spending limit), that's not about your code: don't change code, push again or re-run CI. Say so once on the PR
  and carry on; the dev manager re-runs CI when it works.
- **Fresh context per task:** if the owner started you with `./factory-loop.sh`, do exactly one task and stop;
  the script starts a fresh run for the next one. Keep anything the next run needs in git, the PR or the plan,
  not in your memory.
- **Interactive loop** (`FACTORY_INTERACTIVE=1`, from `./factory-loop.sh --interactive`): the owner is at the
  terminal. You may ask them short questions there, but decisions still go in the PR or a decision file, so the
  next fresh session sees them. When the task is done (PR opened, claim dropped), mark it done with
  `python3 .claude/hooks/factory_claims.py done --agent "$FACTORY_AGENT" --task <id>` and end with one line:
  `Task <id> done: <PR link>.` The session then closes by itself and the loop starts the next task. Don't start
  another task in this session.
- Stop and report only when every remaining task is blocked, a "Done when" check or CI fails in a way you
  can't fix, or a task would break one of the rules in `CLAUDE.md`.
- The report is short: tasks done (with PR links), tasks blocked, and questions still open (with links to
  their comments). Questions are asked in PR comments, never only in the report.
