# software-factory

Turns a repo into a software factory. Coding agents build the project task by task from a PRD and a build plan. A
dev manager (a Claude session, usually in the cloud) reviews, merges and keeps them busy. Only decisions that are
truly the owner's reach a person.

- `SKILL.md`: how Claude sets up a project (mode 1) or acts as dev manager (mode 2).
- `DEV-MANAGER.md`: the dev manager's playbook.

## Quick start

In a project that has a PRD:

```bash
git submodule add https://github.com/deresegetachew/my-skills.git vendor/my-skills
bash vendor/my-skills/software-factory/install.sh . --link
# fill in .claude/factory.json, CLAUDE.md and docs/build-plan.md (or ask Claude: "set up the software factory")
./factory-loop.sh
```

Then, in a Claude session with the repo attached, say "be the dev manager for this repo".

Needs Python 3 and the GitHub CLI (`gh`) on the coding agent's machine.

## How it works

```mermaid
flowchart TB
    plan[("PRD + build plan")] --> pick

    subgraph agent["1 · Coding agent (one fresh session per task)"]
        pick["Pick the next job<br/>next_task.py: rework first,<br/>then a task no other agent holds"] --> tests["Write failing tests<br/>test-writer"]
        tests --> code["Implement"]
        code --> stop{"Stop hook:<br/>tests pass?"}
        stop -->|"no"| code
        stop -->|"yes"| rev{"reviewer + the reviews<br/>factory_reviews.py lists"}
        rev -->|"must-fix"| code
        rev -->|"pass"| pr["Open PR<br/>pr-gate.py"]
    end

    subgraph ci["2 · CI on GitHub"]
        guard["Factory guard"]
        checks["Typecheck, lint, test, build, style checks"]
    end

    subgraph dm["3 · Dev manager (Claude in the cloud)"]
        read["Review the diff and<br/>the guard findings"] --> ok{"Good?"}
        ok -->|"yes"| merge["Add label if justified,<br/>merge"]
        ok -->|"no"| fix["factory-mustfix comment<br/>(gate holds the merge)"]
        answer["Answer factory-questions"]
    end

    pr --> guard
    pr --> checks
    guard --> read
    checks --> read
    merge --> main[("main")]
    main --> pick
    fix -.->|"rework pr-n"| pick
    code -.->|"stuck"| answer
    answer -.-> code
    answer -.->|"owner-only"| owner(["Owner"])
```

- **The agent never grades its own work.** Subagents review the diff before the PR, and CI checks what the agent
  can't edit around. The dev manager reads every finding before it labels or merges.
- **State lives in the repo, not in a session:** CLAUDE.md, the PRD, the plan, the decisions, the code and the PRs.
  So each task can start with a fresh context.

## Shared vs the project's own

Everything reusable lives once, in my-skills. A project keeps only its config.

| Shared (linked from `vendor/my-skills`) | The project's own |
|---|---|
| `factory-loop.sh` and `.claude/hooks/*` | `.claude/factory.json`: commands, paths, protected files, styles, per-agent ports, which paths need which review |
| `.claude/agents/*`: reviewer, architecture-reviewer, test-writer, safety-auditor, security-reviewer | `.claude/factory/notes/<agent or skill>.md`: the few lines an agent needs that only this project knows |
| `.claude/skills/*`: next-task, design-check, eval, the style guides | `CLAUDE.md`, the PRD, the plan, the decisions (every agent reads these) |
| `.claude/settings.json` | |

### Your own sessions in worktrees, without the script

You can also skip `factory-loop.sh` and run plain `claude` sessions, one per worktree:

```bash
claude                                                       # slot 1: the project folder
cd "$(python3 .claude/hooks/factory_claims.py worktree 2)"   # creates <project>-agents/agent-2 the first time
claude                                                       # then: /loop /next-task all
```

The `SessionStart` hook (`factory_session.py`) turns each session into a factory agent:
- it records the session's checkout in the lock file, so loops avoid that folder;
- it fetches submodules, runs `commands.install` (in worktrees), then runs `commands.agentSetup`;
- it puts the slot's `agentEnv` (own ports and database), `FACTORY_AGENT` and `FACTORY_PID` into the session's
  environment.

`/next-task` then claims each task as that agent, so two sessions never build the same task. After opening the PR it
drops the claim, and the pushed branch keeps the task taken. One long session collects context, so restart it every
few hours.

### Several loops and the lock file

`install.sh . --link` makes the links and copies the templates. A file that differs from the kit is kept and
reported, so nothing is overwritten. Without a submodule, `install.sh <dir>` copies everything instead.

- **A checkout each.** The first loop works in the project folder. Each further loop gets its own git worktree
  next to it, in `<project>-agents/agent-2`, `agent-3` and so on, created on first use with the local
  `.env*.local` files copied and `commands.install` run at each start (main may have new dependencies). Each start also brings a reused worktree up to main before reading its hooks. Worktrees share the repo, so branches and fetches
  are shared, but the files aren't.
- **A task each.** Before building, a loop claims its task in a lock file in the repo's shared git folder
  (`.git/factory/claims.json`, under a file lock, never committed). Other loops skip claimed tasks.
- **Claims end by themselves.** A claim lapses when its loop exits (Ctrl-C or a crash, checked by process id)
  or after `claimStaleHours` (6 by default). After a run pushes its branch, the loop drops the claim: a recent
  `task/<id>-…` branch on the remote counts as taken, which is also how loops on other machines avoid each other.
- **Own ports and database.** Loops on one machine would otherwise share the dev servers' ports, the test database
  and any job queue in it, so one loop's tests could take the other's jobs or migrations. `agentEnv` in
  `factory.json` gives each slot its own values: slot 1 (the project folder) keeps the defaults, and slot N shifts
  each port by `portStep * (N-1)` and adds `_N` to names:

  ```json
  "agentEnv": { "API_PORT": "{port:4100}", "DATABASE_URL": "postgres://app:app@localhost:5440/app{suffix}" },
  "commands": { "agentSetup": "docker compose exec -T postgres createdb -U app app_$FACTORY_SLOT || true" }
  ```

  The loop and the SessionStart hook export these and run `agentSetup`, so every script and test must read ports
  from the environment. `maxOpenPRs` counts all agents together, so set it to about the number of agents + 1.

## Quality gates

| Gate | What it does |
|---|---|
| **Stop hook** (`check.py`) | A turn can't end while typecheck or tests fail. |
| **Reviews** | `reviewer` on every change. `factory_reviews.py` lists the extra ones a diff needs: `safety-auditor` and `security-reviewer` (from `reviews` paths), `eval`, `design-check`, and `architecture-reviewer` (from `styles`). |
| **PR gate** (`pr-gate.py`) | Blocks `gh pr create` and `gh pr merge` without the reviewer's pass (and the architecture pass on styled paths), with red CI, with protected files, with a ticked or blocked task, or above `maxOpenPRs`. |
| **Factory guard** (CI) | Fails a PR that could make the build look better than it is (table below). |
| **Rework** | A dev manager `<!-- factory-mustfix sha=… -->` comment makes that PR the agent's next job (`pr-<n>`) and holds its merge until a `<!-- factory-approved sha=… -->`. |

**The Factory guard**

| Finding | Passes with |
|---|---|
| An existing test deleted, or an assertion removed or rewritten | `tests-reviewed` label |
| A test softened after implementation started | `tests-reviewed` label |
| An existing golden or expected output changed | `tests-reviewed` label |
| A new `.skip`, `.only`, `xit`, `test.todo` | `tests-reviewed` label |
| A new dependency | `deps-reviewed` label |
| Two decisions with the same number, a branch ticking another task, `pull_request_target` | never |

Only the dev manager adds labels, and only after reading the change.

### Style guides

How the code is written comes from style-guide skills, chosen per path:

```json
"styles": [{ "paths": ["apps/api/**"],
             "skills": ["nestjs-clean-code-ddd-hexagonal", "nestjs-best-practices"],
             "check": "python3 vendor/my-skills/nestjs-clean-code-ddd-hexagonal/scripts/check_structure.py" }],
"structure": { "roots": ["apps/api/src"], "legacy": "docs/structure-legacy.txt" }
```

CI runs each `check`. The `architecture-reviewer` reviews against the guide's checklist, and the PR gate requires its
pass. The legacy list exempts existing files until they're fixed, and it only shrinks.

## Files

```
software-factory/
  SKILL.md, DEV-MANAGER.md, install.sh
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
    .claude/hooks/factory_env.py     per-loop ports, database names and queues (agentEnv)
    .claude/hooks/factory_session.py SessionStart: a plain `claude` session in a worktree becomes a factory agent
    .claude/hooks/wait_for_merge.sh  waits on a PR without spending tokens
    factory-loop.sh              runs one fresh Claude session per task; start it again for a second loop
    .claude/agents/              reviewer, architecture-reviewer, test-writer, safety-auditor, security-reviewer
    .claude/hooks/style_checks.py    CI: runs each style's `check` command from factory.json
    .claude/skills/              next-task, design-check, eval
    docs/                        build-plan, blocked list and decision templates
    .github/                     CI workflow and CODEOWNERS templates
```

### One factory, many projects

The factory has two parts:
- **The engine** is the same in every project: `factory-loop.sh` and `.claude/hooks/*.py`/`*.sh` (claims, the PR
  gate, the guard, next_task, the session hook, style checks).
- **The templates** each project tailors: `factory.json`, `settings.json`, the agents, the `next-task` skill,
  CLAUDE.md, the plan and CI.

With my-skills as a git submodule (`vendor/my-skills`), `install.sh . --link` links the engine into the submodule and
copies the templates. Each project then pins one factory version, the submodule commit, and a factory fix reaches it
through one "update my-skills" PR. A project never ends up with a stale copy of a script. Without a submodule,
`install.sh <dir>` copies everything, as before.

Quick start in a project that has a PRD:

```bash
git submodule add https://github.com/deresegetachew/my-skills.git vendor/my-skills
bash vendor/my-skills/software-factory/install.sh . --link     # or, without a submodule: bash ~/path/to/my-skills/software-factory/install.sh .
# fill in .claude/factory.json, CLAUDE.md and docs/build-plan.md (or ask Claude: "set up the software factory")
./factory-loop.sh        # or: claude, then /loop /next-task all
./factory-loop.sh        # again, in a second terminal, for a second loop on other tasks
./factory-loop.sh -i     # interactive: a normal Claude session per task; /exit moves on to the next
cd "$(python3 .claude/hooks/factory_claims.py worktree 2)" && claude   # or your own session per worktree: /loop /next-task all
```

Then, in a Claude session with the repo attached (cloud, so it runs with the laptop closed): "be the dev
manager for this repo".

The hooks need Python 3 and the GitHub CLI (`gh`) on the coding agent's machine.
