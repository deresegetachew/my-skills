# software-factory

Turns a repo into a software factory. Coding agents build the project one task at a time, from a PRD and a build
plan. A dev manager reviews their pull requests, merges them, and keeps the agents busy. Only decisions that really
belong to you reach you.

<br>

## The idea

There are two roles:

| Role | Where it runs | What it does |
|---|---|---|
| **Coding agent** | Claude Code on your machine, started with `factory loop` | Takes the next task, writes failing tests, builds it, gets it reviewed, opens a PR |
| **Dev manager** | A Claude session in the cloud | Reviews every PR, merges, answers the agents' questions, flags blockers to you |

Three ideas make it safe to leave running:

1. **The repo holds the state, not a session.** The PRD, the plan, decisions, code and PR comments are what carry
   over. So every task can start with a fresh context.
2. **No agent grades its own work.** Reviewer subagents check each change, CI checks what an agent can't edit
   around, and the dev manager reads every finding before merging.
3. **The rules are shared, the config is the project's.** Agents, skills and hooks come from this repo; a project
   only says what's specific to it.

<br>

## Set up a project

You need a PRD first. The factory only builds what the PRD and the plan say.

1. **Add my-skills and install the factory:**

   ```bash
   git submodule add https://github.com/deresegetachew/my-skills.git vendor/my-skills
   bash vendor/my-skills/software-factory/install.sh . --link
   ```

   The installer does two things:
   - **Links the shared files.** For every agent, skill and hook in the kit it makes a symlink in the project's
     `.claude/`, pointing into `vendor/my-skills` (see [Why `.claude/` holds links](#why-claude-holds-links)).
   - **Copies the templates** you fill in: `factory.json`, `CLAUDE.factory.md`, the plan.

   Commit the result. Git stores each link as its target path, so every clone gets the links back.

2. **Fill in the templates**, or ask Claude to "set up the software factory":
   - `.claude/factory.json`: commands, paths, protected files;
   - `CLAUDE.md`, starting from `CLAUDE.factory.md`: the project's rules;
   - `docs/build-plan.md`: the tasks.

3. **Install the `factory` command on your machine,** once:

   ```bash
   ./factory install-shim
   ```

4. **Start building:**

   ```bash
   factory loop
   ```

5. **Start the dev manager:** in a Claude session with the repo attached, say "be the dev manager for this repo".

You need Python 3 and the GitHub CLI (`gh`) on the machine that runs the agents.

<br>

## Everyday use: the `factory` command

Everything goes through one command. Run it from any folder inside the project.

| Command | What it does |
|---|---|
| `factory loop` | Runs agents unattended: one fresh Claude run per task |
| `factory loop -i` | One session per task that you can watch and type into. After `/exit`: Enter for the next task, `q` to stop |
| `factory agent 2` | Opens a second agent in its own folder. Then type `/loop /next-task all` |
| `factory next` | Shows the job the factory would hand out next |
| `factory claims` | Shows which agent holds which task |
| `factory update` | Moves the project to the newest my-skills. Commit the result in a PR |
| `factory help` | Lists the rest: `reviews`, `env`, `check`, `guard`, `wait`, `release` |

`factory` works in every factory project. It finds the project you're in and runs that project's own copy, so each
project uses the factory version it pins.

<br>

## How one task flows

```mermaid
flowchart TB
    plan[("PRD + build plan")] --> pick

    subgraph agent["1 · Coding agent: a fresh session per task"]
        pick["Pick the next job<br/>rework first, then a free task"] --> tests["Write failing tests"]
        tests --> code["Implement"]
        code --> stop{"Tests pass?"}
        stop -->|"no"| code
        stop -->|"yes"| rev{"Reviewers"}
        rev -->|"must-fix"| code
        rev -->|"pass"| pr["Open the PR"]
    end

    subgraph ci["2 · CI"]
        checks["Typecheck, lint, test, build,<br/>style checks, Factory guard"]
    end

    subgraph dm["3 · Dev manager"]
        read["Review"] --> ok{"Good?"}
        ok -->|"yes"| merge["Merge"]
        ok -->|"no"| fix["Must-fix comment"]
    end

    pr --> checks --> read
    merge --> main[("main")] --> pick
    fix -.->|"rework"| pick
```

<br>

## Why `.claude/` holds links

Claude Code only looks for agents, skills and hooks in the project's `.claude/` folder. It never looks in `vendor/`.
So the real files stay in the submodule, and `.claude/` holds symlinks that point to them:

```
.claude/agents/reviewer.md  ──►  vendor/my-skills/software-factory/kit/.claude/agents/reviewer.md
   where Claude looks               the real file
```

- **There's one copy of each file,** in `vendor/my-skills`, pinned to one my-skills commit.
- **Opening a link shows the real file.** Your editor and Claude both follow it. `ls -l .claude/agents` shows the
  `->` arrows.
- **Never edit a link.** Change the file in my-skills, then run `factory update` in the project.

<br>

## What's shared and what's the project's

| Shared, linked from `vendor/my-skills` | The project's own |
|---|---|
| The agents: reviewer, architecture-reviewer, test-writer, safety-auditor, security-reviewer | `.claude/factory.json`: commands, paths, protected files, style guides, ports, which paths need which review |
| The skills: next-task, design-check, eval, the style guides | `.claude/factory/notes/<agent>.md`: a few lines an agent needs that only this project knows |
| The hooks, `settings.json`, `factory`, `factory-loop.sh` | `CLAUDE.md`, the PRD, the plan, the decisions |

**To customise, never edit a shared file in the project.**

- **Structured settings go in `factory.json`.** For example, this sends every change touching auth or billing to the
  security reviewer:

  ```json
  "reviews": { "security-reviewer": { "paths": ["auth", "billing"] } }
  ```

- **Free text goes in a note.** For example, `.claude/factory/notes/security-reviewer.md` might say "tenants are
  brands; payments are Stripe". A note adds to the shared rules; it never removes one.

- **A rule that should change everywhere** is changed here in my-skills. Then each project takes it with
  `factory update`.

<br>

## Several agents at once

Worth it when the plan has tasks that don't depend on each other. Each agent gets:

- **its own folder:** the first agent uses the project folder, and the others get git worktrees in
  `<project>-agents/agent-N`;
- **its own task:** agents claim tasks in a shared lock file, and a pushed task branch counts as taken too;
- **its own ports and database:** set in `agentEnv` in `factory.json`, so tests on one machine don't collide:

  ```json
  "agentEnv": { "API_PORT": "{port:4100}", "DATABASE_URL": "postgres://app:app@localhost:5440/app{suffix}" }
  ```

  Agent 1 keeps the defaults. Agent N shifts every port by `10 × (N − 1)` and adds `_N` to names.

Start one with `factory loop` in another terminal, or `factory agent 2`. Set `maxOpenPRs` to about the number of
agents + 1.

<br>

## Safety nets

| Net | What it stops |
|---|---|
| **Stop hook** | A turn ending while typecheck or tests fail |
| **Reviewers** | The `reviewer` on every change. `factory reviews` lists the extra ones a change needs: safety, security, eval, design, architecture |
| **PR gate** | Opening or merging a PR without the reviewer's pass, with red CI, with protected files, or for a task that's done or blocked |
| **Factory guard (CI)** | Changes that make the build look better than it is (below) |
| **Rework** | A dev manager must-fix makes that PR the agent's next job and holds its merge until the dev manager approves |

The **Factory guard** fails a PR for:

| Finding | Passes once the dev manager adds |
|---|---|
| A test deleted, or an assertion removed or rewritten | `tests-reviewed` |
| A test weakened after implementation started | `tests-reviewed` |
| A golden or expected output changed | `tests-reviewed` |
| A new `.skip`, `.only`, `xit` or `test.todo` | `tests-reviewed` |
| A new dependency | `deps-reviewed` |
| A reused decision number, a branch ticking another task, `pull_request_target` | never: fix it |

<br>

## Style guides

How the code is written comes from style-guide skills, chosen per path in `factory.json`:

```json
"styles": [{
  "paths":  ["apps/api/**"],
  "skills": ["nestjs-clean-code-ddd-hexagonal", "nestjs-best-practices"],
  "check":  "python3 vendor/my-skills/nestjs-clean-code-ddd-hexagonal/scripts/check_structure.py"
}]
```

On those paths:
- CI runs the `check`;
- the `architecture-reviewer` reviews against the guide;
- the PR gate needs its pass.

Files that don't follow the guide yet go on a legacy list. The list only shrinks.

<br>

<details>
<summary>Reference: the files in the kit</summary>

```
software-factory/
  README.md, SKILL.md, DEV-MANAGER.md     this page, setup and dev-manager instructions, the playbook
  install.sh                              install into a project (--link with the submodule)
  kit/
    factory                               the command line
    factory-loop.sh                       the loop behind `factory loop`
    CLAUDE.factory.md                     template for the project's CLAUDE.md
    .claude/factory.json                  template: the project's config
    .claude/factory/notes/                template: the project's notes for the agents
    .claude/settings.json                 permissions and hooks
    .claude/agents/                       the five reviewers and the test writer
    .claude/skills/                       next-task, design-check, eval
    .claude/hooks/
      check.py                            Stop hook: typecheck and tests
      pr-gate.py                          gate on gh pr create and merge
      factory_session.py                  session start: a plain `claude` session becomes an agent
      next_task.py                        the next job: rework first, then the first free task
      factory_claims.py                   lock file: a folder and a task per agent
      factory_env.py                      per-agent ports and database
      factory_reviews.py                  which extra reviews a change needs
      factory_guard.py                    the CI guard
      style_checks.py                     CI: each style's check
      factory_config.py                   reads factory.json, with defaults
      wait_for_merge.sh                   waits on a PR without spending tokens
    docs/, .github/                       templates: plan, blocked list, decisions, CI
```

</details>
