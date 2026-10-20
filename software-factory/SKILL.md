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
   the rules files, CI, lockfiles, migrations, and anything that implements a critical rule (safety logic,
   money, approval gates). Set `testPaths` and `goldenPaths` to where tests and expected outputs live, and
   `smoke` to a quick command that proves main works.
   **Style guides:** ask the owner which style skills each part of the code follows, for example the NestJS backend
   skills `nestjs-clean-code-ddd-hexagonal` and `nestjs-best-practices` from this repo.
   - **Copy them into the project**, so CI, fresh clones and the cloud dev manager can read them:
     `<my-skills>/install.sh --project . --copy <skill> [...]`.
   - **Add a `styles` entry for each path**, for example
     `{"paths": ["apps/api/**"], "skills": ["nestjs-clean-code-ddd-hexagonal", "nestjs-best-practices"], "check": "python3 .claude/hooks/check_structure.py"}`.
   - **For the hexagonal skill, also copy the checker:** `scripts/check_structure.py` into `.claude/hooks/`. Then set
     `structure.roots`, and seed the legacy list with `check_structure.py --legacy` when existing code doesn't follow
     the rules yet. That list only shrinks.
   - **Enforcement:** the architecture-reviewer reviews diffs on those paths, the PR gate needs its pass, and CI runs
     the `check` commands.
4. **Write `CLAUDE.md`** from `CLAUDE.factory.md`: the product in a paragraph, the docs to read in order,
   **the rules that matter most** (each one checkable by a reviewer), voice and copy rules, code style, and
   the "How to work" section as given.
5. **Write the build plan** in `docs/build-plan.md` from the PRD:
   - phases that each end in something you can use;
   - tasks sized for one PR each, every one with a **"Done when"** check that can be run, not a feeling;
   - Phase 0 = scaffold, CI and the local stack; CI must exist before the factory can merge anything;
   - things only a person can provide go under "Before launch", or into `docs/blocked.md` when a task needs them.
6. **Adapt the CI workflow** to the stack and the commands in `factory.json`. Keep its **Factory guard** job:
   it checks, where the agent can't edit around it, that tests and expected outputs weren't quietly changed,
   no `.skip`/`.only` slipped in, new dependencies were reviewed, decision numbers don't collide, and a branch
   ticks only its own task. Once the project has an eval, run it in CI too, so the score isn't self-reported.
7. **Protect the main branch** on GitHub (Settings → Rules → Rulesets): require a pull request, require the
   CI checks (including Factory guard), block force pushes. Optional: CODEOWNERS on the protected paths.
   **Stronger, when the project matters:** let the coding agent's GitHub token push branches but not merge, and
   have the reviewer pass posted as a commit status by a separate identity (a GitHub App or a second account)
   that the ruleset requires. The local hooks then stay as the fast check, and the agent can't approve itself.
8. **Commit on a branch and open a PR.** Then tell the owner how to start the coding agent, in a terminal
   on their machine, in the repo:
   ```
   ./factory-loop.sh          # recommended: a fresh Claude run per task
   ```
   or, interactively, `claude` then `/loop /next-task all`. The loop script starts a clean context for every
   task, which is cheaper and avoids an agent misled by a long, stale conversation; state lives in git, the PRs
   and the plan. It runs without anyone to approve prompts, so `.claude/settings.json` must allow every command
   the build needs. Keep the machine awake while it runs (on a Mac, `caffeinate -d` in another tab), and run the
   agent with the sandbox on rather than with permission checks skipped.
   **More than one loop:** run `./factory-loop.sh` again in another terminal. Each loop gets its own checkout
   (a git worktree in `<project>-agents/agent-N`, with `commands.install` run once) and claims its task in a
   shared lock file, so no two loops build the same task; loops on other machines skip tasks whose
   `task/<id>-...` branch is on the remote. It helps only when the plan has tasks that don't build on each other,
   and costs tokens per loop. Raise `maxOpenPRs` to about loops + 1.
   **Tokens:** most of the cost is input, so the fresh context per task matters most; use cheaper models for
   routine subagents. Terse-reply skills such as the community `/caveman` save a few percent at most.
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
- **A gate is only as strong as who controls its signal.** Agents edit tests to pass and approve their own work
  when they can, and asking them not to barely helps. So the checks that matter run in CI (the factory guard),
  tests are read-only for the implementer, task choice is a script, and only the dev manager clears findings.
- **Questions go to the dev manager in PR comments; the owner is the last stop.**
