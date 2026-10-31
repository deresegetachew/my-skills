---
name: next-task
description: Pick the next unticked task in the build plan, build it on its own branch with tests, open a pull request, merge it when the gate allows, tick it off, and continue. Use when asked to "do the next task", "continue the build", "go on one by one" or `/next-task all`.
---

**Project instructions:** if the project has a role folder (`roles.dir`, by default `.claude/factory/roles`), read `coding-agent/README.md` and then `coding-agent/reads.md` there first, and open only the documents `reads.md` lists that the task needs. Otherwise, if `<notes>/next-task.md` exists (`notes` in `.claude/factory.json`, by default `.claude/factory/notes`), read it first. It holds this project's additions to these instructions. A note adds checks or detail; it never removes a rule here.

# Next task

One task at a time: pick, test, build, review, ship. Paths and commands come from `.claude/factory.json` (`plan`,
`blocked`, `prd`, `decisions`, `commands`). The argument (what follows `/next-task` in your prompt): empty for one task, a task id such as `1.3`,
`issue-<n>`, `pr-<n>`, or `all` to keep going until every remaining task is blocked.

This file is the core. Open the others in this folder only when they apply:

| File | When |
|---|---|
| `issues-mode.md` | `tasks.source` is `"issues"`: how picking, reading, todos, blocking and shipping change |
| `rework.md` | the pick prints `pr-<n>`: a must-fix on your open PR comes before any new task |
| `questions.md` | you need something only a person has, a decision the docs leave open, or a decision number |
| `waiting.md` | after shipping, or when you'd wait: merges, the PR cap, CI that never ran, the interactive loop, stopping |

## 1. Pick the task

1. **Start routine:** `git fetch origin && git checkout --detach origin/<mainBranch>`, then
   `git submodule update --init` if the repo has a `.gitmodules`. Read `git log --oneline -15`, and run the `smoke`
   command if `factory.json` has one. If main is broken, fixing it is the task.
2. **Let the script pick:** `bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts`,
   exactly so, with no variable (it claims as your `FACTORY_AGENT`). Told which issue to build? Add `--issue <n>`
   (issues mode) so the claim takes that one and no other. Never pick by reading the plan yourself. If your prompt names a task, under `factory-loop.sh` the loop has
   already claimed it: build only that one. `pr-<n>` means rework (`rework.md`). Respect phase order unless the plan
   says phases overlap.
3. **Read the brief first.** The task (or issue) lists what to read: PRD sections, decisions, design references,
   files, edge cases, out of scope. Open those, and widen only when they don't answer your question. Search long
   documents (`grep -n`) instead of reading them whole: most of a task's cost is what it reads. Say in one line which
   task you're doing and what "done" means.
   Read an issue with `./factory issues show <n> --comments`, not
   `gh issue view`, which your rules refuse. When a read-only command is refused, try the factory command first.
4. **Read the lessons.** `bun --no-env-file --config=/dev/null .claude/hooks/factory_lessons.ts show` prints this project's short list of repeated
   mistakes (one line each, with an example). Check your work against it before every push; the reviewers do too.
   If a person's must-fix or a CI failure teaches something new, say so in the PR description as "lesson candidate:";
   you cannot edit the file, the dev manager does (`factory lessons suggest`).
5. **Plan against the budget.** A task can have a token budget (the issue's `Budget:` line, or `budget.builder`; the
   loop's prompt states it). It counts fresh input (input + cache writes) + output for the whole task, subagents
   included; cache reads are not counted. `factory usage --task <id> --budget` shows it (exit 0; warns from 80%):
   `bun --no-env-file --config=/dev/null .claude/hooks/factory_usage.ts --task <id> --budget`. Write a short plan
   (the steps, the files, the reviews) with a rough token estimate, and compare it with the budget. Fits: go. Clearly
   too big: propose a split, or ask the dev manager in a `<!-- factory-question -->` comment, before building. Never
   edit the `Budget:` line yourself (the gate refuses it). No budget: still plan, and skip the comparison.

A PR with the `factory-hold` label is being reviewed by the dev manager: don't rework or merge it.

## 2. Check what you need

Anything only a person can provide, or a gap the docs leave open: `questions.md`. Questions go to the dev manager as
`<!-- factory-question -->` PR comments, never only to the terminal, and you keep working around them.

## 3. Build it

1. Branch: `git checkout -b task/<id with dashes>-<short-name>` (issues mode: `task/<n>-<short-name>`).
2. For tasks that add behaviour, ask the `test-writer` subagent for the failing tests first, starting with the edge
   cases the task lists, and commit them on their own. Then implement, following `CLAUDE.md` and the decisions.
   - **Style guides:** if your files match a `styles` entry in `factory.json`, read those skills first and run their
     `check` before every push. Fixing a file on the legacy list means removing it from the list; never add one.
   - **Tests are fixed once implementation starts.** Add tests freely, but don't weaken or edit existing ones or a
     golden output (`goldenPaths`). If a test is wrong, ask in a `<!-- factory-question -->` comment. CI's factory
     guard fails edited tests, `.skip`/`.only` and new dependencies until the dev manager has reviewed them.
   - **Parallel loops:** ports, database names and queues come from the environment (`agentEnv`). Never hard-code a
     port; read the variable and keep today's value as the default.
   - **Budget checkpoints** (when the task has a budget): run the `--budget` command from step 1.5 after the failing
     tests are committed, before the first review, and before opening the PR. From 80% it warns: finish the step you
     are on, commit a working state, and write in the PR what is left; if the rest won't fit, ask before going on.
     Nothing stops at the limit, and the reviews and tests are never the place to save: never skip them for it.
3. Test what a user or another module can observe. Run the "Done when" check and the `typecheck`, `lint` and `test`
   commands until they pass, and keep the output as evidence. Run them through `./factory run-check <command>`: it prints one
   line when they pass, or the first errors and the log path when they fail; open the full log only if that isn't enough.
   Don't spend a turn on formatting or auto-fixable lint findings: when `commands.fix` is set, the Stop check and
   `./factory verify` run it on the files you changed ("formatted 3 files"); `./factory fix` runs it by hand. If verify
   says it formatted files, commit them and run it again.
4. **Extra reviews:** run `bun --no-env-file --config=/dev/null .claude/hooks/factory_reviews.ts` and do each line it prints (a skill such as
   `design-check` or the eval, or a subagent such as `safety-auditor` or `security-reviewer`), fixing every must-fix.
   Ask the `safety-auditor` whenever the diff touches what CLAUDE.md calls critical rules, and the
   `security-reviewer` for auth, payments, public endpoints, uploads, storage, tenancy, secrets or model calls on
   untrusted input.
5. Ask the `reviewer` subagent to review the diff, and the `architecture-reviewer` on styled paths. Fix every
   must-fix; the PR gate needs their passes for the current commit.
6. **The reviewer starts on Sonnet, Opus when it finds something.** The `reviewer` runs on Sonnet (`model:` in its
   file); the `safety-auditor` and `security-reviewer` run on Opus. When the reviewer reports a must-fix, fix it and
   commit, then ask the reviewer again with `model: "opus"` on the fixed commit (or the model
   `bun --no-env-file --config=/dev/null .claude/hooks/factory_models.ts escalate` prints, when the project sets `models.reviewer.escalateTo`), naming each earlier must-fix; it
   says how each one was resolved before it records the pass. Asking again without a fix is only for items it marked
   **unsure**. Keep `opus` for its later rounds on this task, and start on `opus` when the diff is over `prSizeWarn`
   lines or touches a `protected` path.
7. **Re-reviews read only the delta** (#70). Each reviewer records its round (commit, result, findings), and the next
   round of the same reviewer checks only what changed since: the diff since its last commit, its own findings and
   your reply. After fixing and committing, and before asking again, save your reply for each finding:
   `bun --no-env-file --config=/dev/null .claude/hooks/factory_rereview.ts reply --kind reviewer --text "<what you changed for each finding>"`
   (`--kind arch` for the `architecture-reviewer`, `safety` and `security` for the auditors). Then ask the subagent as
   before; it runs `factory_rereview.ts prompt` itself and reads the delta. `factory_rereview.ts plan --kind reviewer`
   shows which it will be. A big fix (over `reReviewPercent` of the branch diff), a new file, a rebase or a merge of
   main makes the next round a full review. The pass the PR gate needs is still the reviewer's marker for the head
   commit, so the last round always ends on HEAD.

## 4. Ship it

1. Plan mode: tick your own task (`- [x]`) on the branch, and no other. Issues mode: see `issues-mode.md`.
2. Commit in small logical commits, push, and open the PR with `gh pr create`: title `<id>: <task name>`, body with
   what changed, how it was verified (commands and results), what the reviewers raised, and any decision recorded. Write the body to `tmp/pr.md` (git-ignored, and the allow list covers it), then `--body-file tmp/pr.md`.
   **If `gh pr create` fails** (for example GraphQL is blocked, as in a claude.ai cloud session), don't open it another
   way: `gh api` is denied, because it would get around the PR gate (#182). Stop and report what failed, with the error
   and the pushed branch; keep your task claim, so the task waits for you. Builders need a machine where `gh pr` works.
   Then drop your task claim: `bun --no-env-file --config=/dev/null .claude/hooks/factory_claims.ts release --tasks-only`
   (when `FACTORY_AGENT` is set). **Post the task's tokens** on the PR, so whoever merges it sees what it cost:
   `bun --no-env-file --config=/dev/null .claude/hooks/factory_usage.ts --task <id> --markdown > tmp/usage.md && gh pr comment <n> --body-file tmp/usage.md`
   (`<id>` is the issue number in issues mode). Post it even when it finds no replies. With a budget it adds used
   against budget and the top subagent; over the budget, say in the PR body why and what you would split next time.
3. Once CI is green, post the tokens again (the same command), then merge it yourself:
   `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`, with the full hash from `git rev-parse HEAD`
   pasted in (the gate reads the command before the shell runs, so `$(...)` can't stand in for it). Run it on its
   own, with no push in the same command. The gate allows it only when the reviewer passed that commit, CI is green,
   no protected file changed and the dev manager has no hold or must-fix on it. If it says a person must merge it,
   end the PR body with "A person merges this one: <why>", leave it open and carry on. If another worktree has the
   main branch, `git checkout --detach origin/<mainBranch>` is fine.
   **If you did not merge** (CI is red, the gate said no, a person merges it, or the run is ending), do not say you will
   merge it later: nobody is left to do that. End your final message with `PR #<n> is open and not merged: <why>.
   The dev manager carries it on: start it with `factory dev-manager loop` if it is not running.`

## 5. Continue or stop

Read `waiting.md`: under `factory-loop.sh` you do one task and stop; in an interactive loop you mark the task done and
the session closes; with `all` you go back to step 1. Keep anything the next session needs in git, the PR or the issue,
not in your memory.
