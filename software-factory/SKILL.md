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
2. **Install the kit.** Prefer my-skills as a git submodule, so the project runs one pinned version of the factory:
   `git submodule add https://github.com/deresegetachew/my-skills.git vendor/my-skills`, then
   `bash vendor/my-skills/software-factory/install.sh . --link`. The engine (`factory-loop.sh`, `.claude/hooks/*`)
   and every shared file (agents, skills, `settings.json`) become relative links into the submodule. The templates
   (`factory.json`, doc templates, CI) are copied for you to fill in. Project specifics never go in a shared file:
   paths that need the safety auditor, security reviewer, eval or design check go in `factory.json` (`reviews`,
   `eval`, `design`), and the few lines an agent needs that only this project knows go in
   `.claude/factory/notes/<agent>.md`. Add `^vendor/my-skills` and `^\.gitmodules$` to `protected`, give CI's checkout
   `submodules: true`, and put `git submodule update --init` first in `commands.install`. To take a newer factory
   later, the owner runs `factory update` and commits it in a PR; `git config submodule.recurse true` once per clone
   makes `git pull` update the submodule too (README, "Updating the factory"). Without a submodule,
   `bash <this skill>/install.sh <project dir>` copies everything and never overwrites existing files.
3. **Fill in `.claude/factory.json`:** the doc paths, the install, typecheck, lint, test and build commands,
   the folders that hold code, and the protected paths. Protected means "a person or the dev manager merges":
   the rules files, CI, lockfiles, migrations, and anything that implements a critical rule (safety logic,
   money, approval gates). Set `testPaths` and `goldenPaths` to where tests and expected outputs live, and
   `smoke` to a quick command that proves main works.
   **Style guides:** ask the owner which style skills each part of the code follows, for example the NestJS backend
   skills `nestjs-clean-code-ddd-hexagonal` and `nestjs-best-practices` from this repo.
   - **Put them in the project**, so CI, fresh clones and the cloud dev manager can read them. Prefer a submodule:
     add my-skills at `vendor/my-skills` (https URL), with relative links `.claude/skills/<skill>` →
     `../../vendor/my-skills/<skill>`. Add `^vendor/my-skills` and `^\.gitmodules$` to `protected`, put
     `git submodule update --init` first in `commands.install`, and give CI's checkout `submodules: true` (root
     README, "Use in a project as a git submodule"). Otherwise copy them: `<my-skills>/install.sh --project . --copy <skill> [...]`.
   - **Add a `styles` entry for each path**, for example
     `{"paths": ["apps/api/**"], "skills": ["nestjs-clean-code-ddd-hexagonal", "nestjs-best-practices"], "check": "python3 vendor/my-skills/nestjs-clean-code-ddd-hexagonal/scripts/check_structure.py"}`
     (with a copy, copy the script into `.claude/hooks/` and point `check` there).
   - **For the hexagonal skill, set** `structure.roots`, and seed the legacy list with `check_structure.py --legacy` when existing code doesn't follow
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
7. **Protect the main branch** on GitHub (Settings → Rules → Rulesets). The PR gate is a guard rail; this is the
   lock. Require a pull request with 0 approvals (everything is opened under one account, and an author can't
   approve their own PR), require the CI checks (`Factory guard` and `Typecheck, lint, test, build`), block force
   pushes, and include administrators (no bypass list). Optional: CODEOWNERS on the protected paths.
   **Stronger, when the project matters:** let the coding agent's GitHub token push branches but not merge, and
   have the reviewer pass posted as a commit status by a separate identity (a GitHub App or a second account)
   that the ruleset requires. The local hooks then stay as the fast check, and the agent can't approve itself.
8. **Commit on a branch and open a PR.** Then tell the owner how to start the coding agent, in a terminal
   on their machine, in the repo:
   ```
   ./factory install-shim     # once per machine: then `factory ...` works in any factory project
   factory loop               # recommended: a fresh Claude run per task (factory loop -i to watch and type)
   ```
   or `claude` then `/loop /next-task all`. The loop starts a clean context for every
   task, which is cheaper and avoids an agent misled by a long, stale conversation; state lives in git, the PRs
   and the plan. It runs without anyone to approve prompts, so `.claude/settings.json` must allow every command
   the build needs. Keep the machine awake while it runs (on a Mac, `caffeinate -d` in another tab), and run the
   agent with the sandbox on rather than with permission checks skipped.
   **The `factory` command:** tell the owner to run `./factory install-shim` once; then `factory help` lists
   everything (`factory loop`, `factory loop -i`, `factory agent taytu`, `factory claims`, `factory update` ...).
   **Your own sessions instead of the loop:** `factory agent taytu` opens Claude in taytu's worktree; then
   `/loop /next-task all`. The SessionStart hook gives the session its slot, ports, database and task claims.
   **More than one loop:** run `factory loop` again in another terminal. Each loop gets its own checkout
   (a git worktree in `<project>-agents/<name>`, with `commands.install` run at each start) and claims its task in a
   shared lock file, so no two loops build the same task; loops on other machines skip tasks whose
   `task/<id>-...` branch is on the remote. It helps only when the plan has tasks that don't build on each other,
   and costs tokens per loop. Raise `maxOpenPRs` to about loops + 1.
   **Ports and databases for parallel loops:** during setup, find every fixed port and database or queue name the
   tests and dev scripts use (docker-compose, vite/playwright configs, `DATABASE_URL`). Make each one read an
   environment variable with today's value as the default, then list them in `agentEnv` and add an `agentSetup`
   command that creates the slot's database. Slot 1 keeps the defaults.
   **Tokens:** most of the cost is input, so the fresh context per task matters most; use cheaper models for
   routine subagents. Terse-reply skills such as the community `/caveman` save a few percent at most.
9. Offer to be the dev manager (Mode 2).

## Mode 2: act as dev manager

Read `DEV-MANAGER.md` in this skill's folder and follow it: setup, the 10-minute tick, how to review and
merge, waiting for CI, keeping the coding agent busy, and what to tell the owner.

**Before anything else, read its section "What you may change on your own, and what needs the owner's yes".** You
run the agreed process; changing the factory, your own tick, the scope, or merging your own PRs needs the owner's yes.

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
