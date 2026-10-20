# software-factory

Turn a repo into a software factory: a coding agent builds from a PRD and a build plan in a loop, and a dev
manager Claude session reviews, merges and keeps it busy. See `SKILL.md` for how it works and how to set it
up, and `DEV-MANAGER.md` for the dev manager's playbook.

## How it works

```mermaid
flowchart TB
    plan[("PRD + build plan")] --> pick

    subgraph agent["1 · Coding agent (laptop, factory-loop.sh, fresh session per task)"]
        pick["Pick the next job<br/>next_task.py: rework first,<br/>then a task no other loop holds"] --> tests["Write failing tests<br/>test-writer"]
        tests --> code["Implement"]
        code --> stop{"Stop hook:<br/>tests pass?"}
        stop -->|"no"| code
        stop -->|"yes"| rev{"reviewer<br/>subagent"}
        rev -->|"must-fix"| code
        rev -->|"pass"| pr["Open PR<br/>pr-gate.py"]
    end

    subgraph ci["2 · CI on GitHub"]
        guard["Factory guard"]
        checks["Typecheck, lint, test, build"]
    end

    subgraph dm["3 · Dev manager (Claude in the cloud, every 10 min)"]
        read["Review the diff and<br/>the guard findings"] --> ok{"Good?"}
        ok -->|"yes"| merge["Add label if justified,<br/>merge"]
        ok -->|"no"| fix["factory-mustfix comment<br/>(gate holds the merge),<br/>or fix it on the branch"]
        answer["Answer factory-questions"]
    end

    pr --> guard
    pr --> checks
    guard --> read
    checks --> read
    merge --> main[("main")]
    main -->|"wait_for_merge.sh"| pick
    fix -.->|"rework pr-n"| pick
    code -.->|"stuck"| answer
    answer -.-> code
    answer -.->|"owner-only"| owner(["Owner"])
```

The coding agent never merges anything protected and never grades its own tests: the reviewer subagent checks
the diff before the PR, CI checks what the agent can't edit around, and the dev manager reads every finding
before it labels or merges. Only owner-only decisions reach a person.

### Fresh context, one task per run

`factory-loop.sh` starts a new `claude -p "/next-task <id>"` for every task and lets it end, so no run remembers
the one before and nothing piles up in the context. What carries over is what's in git and on GitHub: CLAUDE.md,
the PRD, the plan, decisions, the code, and the PRs with their comments. Anything a run needs to pass on goes
into a commit, the PR or a decision file. (`claude` then `/loop /next-task all` also works, as one long
interactive session; restart it every few hours.)

### Several loops and the lock file

Start `./factory-loop.sh` in as many terminals as you like:

- **A checkout each.** The first loop works in the project folder. Each further loop gets its own git worktree
  next to it, in `<project>-agents/agent-2`, `agent-3` and so on, created on first use with the local
  `.env*.local` files copied and `commands.install` run once. Worktrees share the repo, so branches and fetches
  are shared, but the files aren't.
- **A task each.** Before building, a loop claims its task in a lock file in the repo's shared git folder
  (`.git/factory/claims.json`, under a file lock, never committed). Other loops skip claimed tasks.
- **Claims end by themselves.** A claim lapses when its loop exits (Ctrl-C or a crash, checked by process id)
  or after `claimStaleHours` (6 by default). After a run pushes its branch, the loop drops the claim: a recent
  `task/<id>-…` branch on the remote counts as taken, which is also how loops on other machines avoid each other.
- **See who holds what:** `python3 .claude/hooks/factory_claims.py list`.
- **When it helps:** only when the plan has tasks that don't build on each other. Each loop spends its own
  tokens, and `maxOpenPRs` counts all loops together, so raise it to about the number of loops plus one. The
  dev manager merges in plan order and asks a branch to rebase when an earlier merge conflicts with it.

### Rework comes first

When the dev manager finds a must-fix, its comment starts with `<!-- factory-mustfix sha=<head> -->`. Then:

1. `next_task.py` hands that PR out as `pr-<n>` before any new task, for as long as the PR's head is still the
   commit the comment names.
2. `/next-task pr-<n>` checks out the branch, fixes each finding (failing test first), asks its reviewers again,
   pushes and replies on the PR. The push moves the head, so the PR stops being rework.
3. `pr-gate.py` refuses the agent's own `gh pr merge` while the latest marker on the PR is a must-fix. The dev
   manager re-reviews, then merges it or posts `<!-- factory-approved sha=<head> -->`.

### The Factory guard

`kit/.claude/hooks/factory_guard.py` runs in CI on every pull request. It compares the branch with main and
fails when the change could make the build look better than it is:

| Finding | Passes with |
|---|---|
| An existing test deleted, or an assertion or test case removed or rewritten | `tests-reviewed` label |
| A test softened in a commit after implementation started | `tests-reviewed` label |
| An existing golden or expected output changed | `tests-reviewed` label |
| A new `.skip`, `.only`, `xit`, `test.todo` | `tests-reviewed` label |
| A new dependency in a package manifest | `deps-reviewed` label |
| Two decision files with the same number | never: renumber |
| A task branch ticking another task in the plan | never |
| A workflow using `pull_request_target` | never |

Large PRs get a warning, not a failure. The labels belong to the dev manager, who adds one only after reading
the change. A label change re-runs only the guard job.

```
software-factory/
  SKILL.md          set up a project (mode 1) or act as dev manager (mode 2)
  DEV-MANAGER.md    the dev manager playbook: ticks, reviews, merges, keeping the coding agent busy
  install.sh        copies kit/ into a project without overwriting
  kit/
    CLAUDE.factory.md            template for the project's CLAUDE.md
    .claude/factory.json         paths, commands and protected files for this project
    .claude/settings.json        permissions and the two hooks
    .claude/hooks/check.py       Stop hook: typecheck and tests must pass before a turn ends
    .claude/hooks/pr-gate.py     PreToolUse hook: reviewer pass, green CI, no protected files, or no merge;
                                 refuses ticked or blocked tasks and more than maxOpenPRs at once
    .claude/hooks/factory_guard.py   CI guard: tests/golden edits, skips, new deps, decision numbers, task ticks
    .claude/hooks/next_task.py   picks the next task from the plan on main (--claim: one no other loop holds)
    .claude/hooks/factory_claims.py  lock file for several loops: a checkout each, one task each
    .claude/hooks/wait_for_merge.sh  waits on a PR without spending tokens
    factory-loop.sh              runs one fresh Claude session per task; start it again for a second loop
    .claude/agents/              reviewer, test-writer, safety-auditor, security-reviewer
    .claude/skills/              next-task, design-check, eval
    docs/                        build-plan, blocked list and decision templates
    .github/                     CI workflow and CODEOWNERS templates
```

Quick start in a project that has a PRD:

```bash
bash ~/path/to/my-skills/software-factory/install.sh .
# fill in .claude/factory.json, CLAUDE.md and docs/build-plan.md (or ask Claude: "set up the software factory")
./factory-loop.sh        # or: claude, then /loop /next-task all
./factory-loop.sh        # again, in a second terminal, for a second loop on other tasks
```

Then, in a Claude session with the repo attached (cloud, so it runs with the laptop closed): "be the dev
manager for this repo".

The hooks need Python 3 and the GitHub CLI (`gh`) on the coding agent's machine.
