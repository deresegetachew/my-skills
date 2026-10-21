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
| `factory loop` | Runs agents unattended: one fresh Claude run per task. When nothing is ready, it waits and checks again every minute (`waitMinutes` in `factory.json`; `0` exits instead) |
| `factory loop -i` | One session per task that you can watch and type into, also from your phone (Remote Control). It closes by itself when the task is done, and the next starts after 10 s (`q` stops) |
| `factory agent taytu` | Opens that agent in its own folder (`factory agent 2` is the second name). Then type `/loop /next-task all` |
| `factory next` | Shows the job the factory would hand out next |
| `factory claims` | Shows which agent holds which task |
| `factory update` | Moves the project to the newest my-skills. Commit the result in a PR |
| `factory clean` | Removes agent worktrees no agent is using, and local branches of finished tasks |
| `factory issues` | Lists the task issues and their state (issues mode) |
| `factory agents` | Lists the agents: working, idle or down, and their last ping (issues mode) |
| `factory help` | Lists the rest: `reviews`, `env`, `check`, `guard`, `wait`, `release` |

**From your phone:** sessions started by `factory loop -i` and `factory agent <name>` have Remote Control on. They appear
at claude.ai/code and in the Claude app, named after the agent and task, so you can follow them and type into them,
`/exit` included, when you're away. Remote Control needs a claude.ai login on a Pro, Max, Team or Enterprise plan; set
`FACTORY_REMOTE_CONTROL=0` to turn it off. For days away, `factory loop` (no `-i`) needs no one at all.

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

## Tasks as GitHub issues

Instead of the build plan, tasks can be GitHub issues. Set this in `factory.json`:

```json
"tasks": { "source": "issues" }
```

- **Each issue is one task:** what we're building, goals, acceptance criteria and a checklist of todos (the
  `factory-task` template).
- **Labels show the state:** `factory:ready`, `factory:in-progress`, `factory:in-review`, `factory:blocked`, plus
  `agent:<name>` for who has it. A GitHub Project board shows the same as columns.
- **An agent starts with its own issue.** If it holds one in progress, it carries on; otherwise it claims the next
  ready one. Claims live on GitHub, so two agents never take the same issue, even on different machines.
- **The agent ticks the todos as it goes,** opens the PR with `Closes #<n>`, and merging closes the issue.
- **The dev manager watches for dead agents:** an issue with no activity for `staleHours` goes back to ready, and
  another agent picks it up.

`factory issues` lists the issues and their state; `factory issues setup` creates the labels.

**Live agents.** In issues mode each agent also has its own issue, `Agent: taytu · working on #42`, labelled
`factory:agent`. The agent keeps it current by itself, with no extra work in the task:

| When | Its issue says |
|---|---|
| It starts | `idle`, with the machine and folder |
| It takes a task | `working on #42` |
| It's working | a ping at most every 5 minutes (any tool use) |
| A turn ends | `idle` |
| It exits | `down` |

No ping for 30 minutes means down: it crashed, the laptop slept, or it waits at a prompt. The dev manager's
`factory agents sweep` marks it down and puts its issues back to ready, so another agent takes them. If the silent
agent comes back, the PR gate stops it opening a PR for an issue that has moved on. `factory agents` lists them all.
Change the timings with `pingMinutes` and `downMinutes` in `tasks`.

<br>

## Agent names

Agents have names. They show in the terminal, on Remote Control, in folder names (`<project>-agents/taytu`) and on
issue labels (`agent:taytu`). The default ten are figures from Ethiopian history: menelik, taytu, haile, tewodros,
yohannes, zewditu, lalibela, ezana, alula, abebe. The first works in the project folder.

Choose your own in `factory.json`, in order, lowercase:

```json
"agents": ["ada", "grace", "linus"]
```

Start one by name: `factory agent taytu` (or `factory agent 2`, the second name).

<br>

## Several agents at once

Worth it when the plan has tasks that don't depend on each other. Each agent gets:

- **its own folder:** the first agent uses the project folder, and the others get git worktrees in
  `<project>-agents/<name>`;
- **its own task:** agents claim tasks in a shared lock file, and a pushed task branch counts as taken too;
- **its own ports and database:** set in `agentEnv` in `factory.json`, so tests on one machine don't collide:

  ```json
  "agentEnv": { "API_PORT": "{port:4100}", "DATABASE_URL": "postgres://app:app@localhost:5440/app{suffix}" }
  ```

  Agent 1 keeps the defaults. Agent N shifts every port by `10 × (N − 1)` and adds `_N` to names.

Start one with `factory loop` in another terminal, or `factory agent taytu`. An agent with nothing to do waits for the next
ready task instead of exiting, and stays `idle` on its agent issue, so you can start several and leave them. Set `maxOpenPRs` to about the number of
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
| **Hold** | The `factory-hold` label: the dev manager is reviewing the PR. Agents skip it and can't merge it |

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
      factory_issues.py                   tasks as GitHub issues: pick, claim, tick, block, stale
      factory_agents.py                   live agents: register, ping, down, sweep
      factory_env.py                      per-agent ports and database
      factory_reviews.py                  which extra reviews a change needs
      factory_guard.py                    the CI guard
      style_checks.py                     CI: each style's check
      factory_config.py                   reads factory.json, with defaults
      wait_for_merge.sh                   waits on a PR without spending tokens
    docs/, .github/                       templates: plan, blocked list, decisions, CI
```

</details>
