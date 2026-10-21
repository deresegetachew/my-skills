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
./factory install-shim     # once per machine: then just `factory ...` in any factory project
factory loop
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

**To customise without forking:**
- **Structured values go in `factory.json`.** For example, `"reviews": {"security-reviewer": {"paths": ["auth",
  "billing"]}}` sends every diff touching those paths to the security reviewer.
- **Free text goes in a note.** For example, `.claude/factory/notes/security-reviewer.md` could say "tenants are brands;
  payments are Stripe". A note adds; it never removes a shared rule.
- **To change a shared rule,** change it in my-skills, then update the submodule.

`install.sh . --link` makes the links and copies the templates. A file that differs from the kit is kept and
reported, so nothing is overwritten. Without a submodule, `install.sh <dir>` copies everything instead.

## The `factory` command

Everything you run goes through one command, `./factory` in the project. After `./factory install-shim` (once per
machine) it's just `factory`, from any folder of any factory project. The shim always runs the project's own pinned
version.

| Command | Does |
|---|---|
| `factory loop` | Unattended: one fresh `claude -p` per task |
| `factory loop -i` | Watch and type: a normal session per task. After `/exit` it asks: Enter for the next task, `q` to stop |
| `factory agent 2` | Opens Claude in agent 2's own worktree (created the first time); then `/loop /next-task all` |
| `factory next` | The job the factory would hand out next |
| `factory claims` | Which agent holds which folder and task (`factory release agent-2` drops them) |
| `factory reviews` | Which extra reviews the current change needs |
| `factory env [N]` | This folder's ports and database (or agent N's) |
| `factory check` / `factory guard` | The style checks and the Factory guard, as CI runs them |
| `factory wait <pr>` | Waits for a PR to merge without spending tokens |
| `factory update` | Pulls the newest my-skills into the project and relinks; then commit it in a PR |

You can also run `claude` in the project folder yourself, then `/loop /next-task all`. It's one long session, so
restart it every few hours.

### Several agents at once

Start more loops or sessions when the plan has tasks that don't build on each other:

- **A folder each.** The first agent uses the project folder. Each further agent gets a git worktree in
  `<project>-agents/agent-N`, created the first time and brought up to main at each start (`factory agent N`).
- **A task each.** Each agent claims its task in a lock file (`.git/factory/claims.json`), and the others skip it. A
  claim ends when its process exits. A pushed `task/<id>-…` branch also counts as taken, across machines.
  `factory claims` shows who holds what.
- **Ports and a database each.** `agentEnv` in `factory.json` gives each agent its own values. Slot 1 keeps the
  defaults; slot N shifts ports by `portStep × (N−1)` and adds `_N` to names:

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
    factory                        the command line (factory help)
    factory-loop.sh                one fresh Claude run per task (factory loop)
    CLAUDE.factory.md              template for the project's CLAUDE.md
    .claude/factory.json           template: the project's config
    .claude/factory/notes/         template: the project's additions to the shared agents and skills
    .claude/settings.json          permissions and hooks
    .claude/agents/                reviewer, architecture-reviewer, test-writer, safety-auditor, security-reviewer
    .claude/skills/                next-task, design-check, eval
    .claude/hooks/
      check.py                     Stop hook: typecheck and tests
      pr-gate.py                   PreToolUse hook on gh pr create / merge
      factory_session.py           SessionStart hook: a plain claude session becomes an agent
      next_task.py                 the next job: rework first, then the first free task
      factory_claims.py            lock file: a folder and a task per agent; `worktree N`
      factory_env.py               per-agent ports and database (agentEnv)
      factory_reviews.py           which extra reviews a diff needs
      factory_guard.py             CI guard
      style_checks.py              CI: each style's check
      factory_config.py            reads factory.json, with defaults
      wait_for_merge.sh            waits on a PR without spending tokens
    docs/, .github/                plan, blocked list, decision and CI templates
```
