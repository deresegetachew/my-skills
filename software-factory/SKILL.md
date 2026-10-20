---
name: software-factory
description: Set up and run a "software factory" on a repo, where a coding agent builds from a PRD and a build plan in a loop (tests first, reviewer subagents, gated self-merging PRs) and a dev manager Claude session reviews, merges and keeps it busy. Use to set one up in a new or existing project ("make this repo a software factory", "set up the coding loop"), or to act as the dev manager ("manage the development", "review and merge the PRs", "keep the coding agent busy").
---

# Software factory

Two roles, one repo:

| Role | Runs where | Does |
|---|---|---|
| **Coding agent** | Claude Code on a machine with the toolchain: `/loop /next-task all` | Takes the next build-plan task, writes failing tests (`test-writer`), builds, asks `reviewer` (and `safety-auditor` / `security-reviewer` when relevant), opens a PR, merges it if the gate allows, ticks the task, repeats |
| **Dev manager** | A Claude session, usually in the cloud | Reviews every PR including protected ones, merges, fixes leftovers, adds tasks, flags blockers and idleness to the owner |

Guard rails live in the repo, not in anyone's memory: `CLAUDE.md` (the rules), `.claude/factory.json`
(paths, commands, protected files), a Stop hook that won't let a turn end with a broken build, a PreToolUse
hook that gates `gh pr create` and `gh pr merge`, and permission deny rules.

Pick the mode from the request: **set up** a project, or **act as dev manager** on one.

## Mode 1: set up a project

1. **Check the inputs.** The project needs a PRD (user stories plus implementation and testing decisions)
   and should have an architecture note. If there is no PRD, help write one first; the factory builds only
   what the PRD and plan say.
2. **Copy the kit** into the project without overwriting existing files:
   `bash <this skill>/install.sh <project dir>`. It copies `kit/` (the `.claude/` hooks, agents, skills and
   settings, the doc templates and a CI workflow) and marks the hooks executable.
3. **Fill in `.claude/factory.json`:** the doc paths, the install, typecheck, lint, test and build commands,
   the folders that hold code, and the protected paths. Protected means "a person or the dev manager merges":
   the rules files, CI, migrations, and anything that implements a critical rule (safety logic, money,
   approval gates).
4. **Write `CLAUDE.md`** from `CLAUDE.factory.md`: the product in a paragraph, the docs to read in order,
   **the rules that matter most** (each one checkable by a reviewer), voice and copy rules, code style, and
   the "How to work" section as given.
5. **Write the build plan** in `docs/build-plan.md` from the PRD:
   - phases that each end in something you can use;
   - tasks sized for one PR each, every one with a **"Done when"** check that can be run, not a feeling;
   - Phase 0 = scaffold, CI and the local stack; CI must exist before the factory can merge anything;
   - things only a person can provide go under "Before launch", or into `docs/blocked.md` when a task needs them.
6. **Adapt the CI workflow** to the stack and the commands in `factory.json`.
7. **Protect the main branch** on GitHub (Settings → Rules → Rulesets): require a pull request, require the
   CI checks, block force pushes. Optional: CODEOWNERS on the protected paths.
8. **Commit on a branch and open a PR.** Then tell the owner how to start the coding agent, in a terminal
   on their machine, in the repo:
   ```
   claude
   /loop /next-task all
   ```
   Keep the machine awake while it runs (on a Mac, `caffeinate -d` in another tab). When it keeps asking to
   approve the same command, approve it with "don't ask again".
9. Offer to be the dev manager (Mode 2).

## Mode 2: act as dev manager

Read `DEV-MANAGER.md` in this skill's folder and follow it: setup, the 10-minute tick, how to review and
merge, waiting for CI, keeping the coding agent busy, and what to tell the owner.

## Lessons this is built on

- **The coding agent should never wait on a person for routine work.** Gate merges on reviewer pass, green
  CI and protected paths, and have the dev manager clear the rest quickly. Stacks of unmerged PRs are the
  main way a factory stalls.
- **The plan is the steering wheel.** To change what gets built, change the build plan (or `docs/blocked.md`)
  in a PR; the coding agent picks the first unticked task each time.
- **Don't stop between phases.** `next-task all` checks the phase's "Done when" and carries on.
- **Tests on observable behaviour, recorded model replies, reviewer pass per commit.** Those make the
  self-merge safe.
- **Critical rules get a dedicated auditor and tests that fail when the rule breaks,** and the dev manager
  reads those diffs line by line even when CI is green.
