# software-factory

Turns a repo into a software factory. Coding agents run on your machine and build the project one task at a time,
from a PRD and a build plan: failing tests first, then the code, then reviewer subagents, then a pull request. A dev
manager, a Claude session in the cloud, reviews the pull requests, merges them, answers the agents' questions and
keeps them busy. Hooks, CI and GitHub's branch protection stop the work from merging when it shouldn't. Only
decisions that really belong to you reach you. The factory itself lives in my-skills, and each project pins one
version of it as a git submodule.

<br>

## Contents

- [Quick start](#quick-start)
- [How it fits together](#how-it-fits-together)
- [Installed as a submodule: what's shared and what's yours](#installed-as-a-submodule-whats-shared-and-whats-yours)
- [Updating the factory](#updating-the-factory)
- [The `factory` command](#the-factory-command)
- [Agent loops](#agent-loops)
- [Tasks](#tasks)
- [Live agents (issues mode)](#live-agents-issues-mode)
- [Reviews and gates](#reviews-and-gates)
- [The dev manager](#the-dev-manager)
- [CI: GitHub's runners or your own Mac](#ci-githubs-runners-or-your-own-mac)
- [Security notes](#security-notes)
- [Style guides](#style-guides)
- [factory.json settings](#factoryjson-settings)
- [The files in the kit](#the-files-in-the-kit)

<br>

<a id="set-up-a-project"></a>

## Quick start

You need a PRD first. The factory only builds what the PRD and the plan say. On the machine that runs the agents you
need git, bash, Python 3, Claude Code and the GitHub CLI (`gh`, signed in).

1. **Add my-skills and install the factory**, in the project's folder:

   ```bash
   git submodule add https://github.com/deresegetachew/my-skills.git vendor/my-skills
   bash vendor/my-skills/software-factory/install.sh . --link
   ```

   The installer links the shared files into `.claude/` and copies the templates you fill in
   ([details](#what-the-installer-does)).

2. **Fill in the templates**, or ask Claude to "set up the software factory" (the `software-factory` skill walks
   through it):
   - `.claude/factory.json`: commands, paths, protected files, ports. Add `^vendor/my-skills` and `^\.gitmodules$` to
     `protected`, and start `commands.install` with `git submodule update --init`.
   - `CLAUDE.md`, from `CLAUDE.factory.md`: the project's rules.
   - `docs/build-plan.md`: the tasks (or use [GitHub issues](#issues-mode) instead).
   - `.github/workflows/ci.yml`: your stack's commands. Give every `actions/checkout` step `submodules: true`, because
     the hooks CI runs are links into the submodule.

3. **Commit it on a branch, open a PR and merge it.** Then set up [branch protection](#branch-protection-the-real-lock)
   on main.

4. **On your machine, once:**

   ```bash
   ./factory install-shim              # puts a `factory` command in ~/.local/bin
   git config submodule.recurse true   # so `git pull` also updates vendor/my-skills
   ```

5. **Start an agent:** `factory loop -i` (a session per task that you can watch and type into), or `factory loop`
   (unattended). [Which one](#three-ways-to-run-an-agent).

6. **Start the dev manager:** in a Claude session with the repo attached, say "be the dev manager for this repo". It
   follows [DEV-MANAGER.md](DEV-MANAGER.md).

<br>

## How it fits together

```mermaid
flowchart LR
    owner(["Owner"])

    subgraph cloud["Cloud"]
        dm["Dev manager<br/>a Claude session, on a timer"]
    end

    subgraph machine["Owner's machine"]
        loop["factory loop, loop -i<br/>or factory agent"]
        subgraph folders["One folder per agent"]
            a1["menelik<br/>project folder"]
            a2["taytu<br/>project-agents/taytu"]
        end
        hooks["Hooks in every session<br/>SessionStart: factory_session<br/>PreToolUse: pr-gate<br/>PostToolUse: agent ping<br/>Stop: check, factory_stop, idle<br/>SessionEnd: down"]
        subs["Subagents<br/>test-writer, reviewer,<br/>architecture-reviewer,<br/>safety-auditor, security-reviewer"]
        links[".claude/ links"]
        vendor["vendor/my-skills<br/>submodule, one pinned commit"]
    end

    subgraph github["GitHub"]
        issues["Task issues<br/>or the build plan"]
        agentissues["Agent issues<br/>Agent: name, status"]
        prs["Pull requests<br/>and marker comments"]
        ci["CI<br/>Factory guard, checks"]
        bp["Branch protection<br/>on main"]
    end

    myskills[("my-skills repo")]

    owner -->|"starts"| loop
    owner -->|"asks"| dm
    loop -->|"a fresh Claude session per task"| folders
    folders --- hooks
    folders --- subs
    hooks -->|"read"| links
    links -->|"point into"| vendor
    myskills -->|"factory update, in a PR"| vendor
    folders -->|"claim, tick, open PRs"| issues
    hooks -->|"ping"| agentissues
    folders -->|"push, gh pr create, gh pr merge"| prs
    prs --> ci
    ci --> bp
    dm -->|"review, must-fix, approve, merge"| prs
    dm -->|"write tasks, sweep"| issues
    dm -->|"only what needs you"| owner
```

One task's life, with the plan or with issues:

```mermaid
sequenceDiagram
    participant L as Loop
    participant A as Agent session
    participant R as Reviewers
    participant G as PR gate hook
    participant H as GitHub
    participant D as Dev manager
    L->>L: Back to origin/main, update the submodule
    L->>H: next_task.py claims the next job (rework first)
    L->>A: claude "/next-task id"
    A->>A: test-writer writes failing tests, then build
    A->>R: reviewer, plus what factory_reviews.py lists
    R-->>A: pass recorded for this commit
    A->>G: gh pr create
    G-->>A: allowed, the reviewer passed this commit
    A->>H: PR opened, CI runs the guard and the checks
    alt CI green, no protected files, no hold, no must-fix
        A->>G: gh pr merge n --match-head-commit sha
        G->>H: merge
    else Protected files or hold label
        A->>L: leaves it open and ends the task
        D->>H: reviews, then merges or posts a must-fix
    end
    opt Must-fix on the head commit
        D->>H: factory-mustfix sha=head
        L->>A: next pick is pr-n, before any new task
        A->>H: fix, push, reply on the PR
        D->>H: factory-approved sha=new head, or merges itself
    end
```

Three ideas make it safe to leave running:

1. **The repo holds the state, not a session.** The PRD, the plan, the decisions, the code and the PR comments carry
   over, so every task starts with a fresh context.
2. **No agent grades its own work.** Reviewer subagents check each change, CI checks what an agent can't edit around,
   and the dev manager reads the findings before merging.
3. **The rules are shared, the config is the project's.** Agents, skills and hooks come from my-skills. A project
   only says what's specific to it.

<br>

## Installed as a submodule: what's shared and what's yours

### What the installer does

`bash vendor/my-skills/software-factory/install.sh . --link`, run from the project's folder:

- **Links the shared files.** For every agent, skill, hook, `factory ci` file (`.claude/ci/`), `settings.json`,
  `factory` and `factory-loop.sh` in the kit, it makes a relative symlink in the project that points into `vendor/my-skills`. A plain copy that's identical
  to the kit becomes a link. A copy that differs is kept, with a warning: move its project lines into `factory.json`
  or a note, delete it, and run the installer again.
- **Copies the templates** the first time only (when there's no `.claude/factory.json` yet): `factory.json`, the
  notes folder, `CLAUDE.factory.md`, the docs templates, the CI workflow, the issue template and `CODEOWNERS`. It
  never overwrites a file that's there.
- **Adds `tmp/` and `__pycache__/`** to `.gitignore`.

Without `--link` (`bash install.sh <project dir>`), it copies everything instead, for a project without the
submodule. Then nothing updates by itself.

Commit the links. Git stores a link as its target path, so every clone gets them back.

### Why `.claude/` holds links

Claude Code looks for agents, skills and hooks in the project's `.claude/` folder, never in `vendor/`. So the real
files stay in the submodule, and `.claude/` points to them:

```
.claude/agents/reviewer.md  ──►  vendor/my-skills/software-factory/kit/.claude/agents/reviewer.md
   where Claude looks               the real file
```

- There's one copy of each file, pinned to one my-skills commit.
- Your editor and Claude follow the link. `ls -l .claude/hooks` shows the arrows.
- **Never edit a link.** Agents can't anyway (`Edit(./.claude/**)` and `Edit(./vendor/**)` are denied). Change the
  file in my-skills, then [update](#updating-the-factory).

### Shared and project-owned

| Shared: links into `vendor/my-skills` | The project's own |
|---|---|
| The agents: reviewer, architecture-reviewer, test-writer, safety-auditor, security-reviewer | `.claude/factory.json`: commands, paths, protected files, ports, which paths need which review |
| The skills: next-task, design-check, eval | `.claude/factory/notes/<agent or skill>.md`: what an agent needs that only this project knows |
| The hooks, `.claude/ci/`, `settings.json`, `factory`, `factory-loop.sh` | `CLAUDE.md`, the PRD, the plan, the decisions, the CI workflow |
| Style-guide skills you link from my-skills | The `.gitmodules` entry and the pinned commit |

**To customise, never edit a shared file in the project:**

- **Structured settings go in `factory.json`.** For example, this sends every change touching auth or billing to the
  security reviewer:

  ```json
  "reviews": { "security-reviewer": { "paths": ["auth", "billing"] } }
  ```

- **Free text goes in a note.** `.claude/factory/notes/security-reviewer.md` might say "tenants are brands; payments
  are Stripe". Each agent and skill reads its note first. A note adds to the shared rules; it never removes one.
- **A rule that should change everywhere** is changed in my-skills. Each project then takes it with `factory update`.

<br>

## Updating the factory

**The pin.** The project doesn't store my-skills' files. It stores one commit id for `vendor/my-skills` (a
"gitlink"; `git ls-files -s vendor/my-skills` shows it). The folder is a checkout of that commit. Nothing in my-skills
reaches a project until the project moves its pin, in a PR.

**To take a newer factory:**

1. Change the file in my-skills and merge it to main there.
2. In the project, on a clean main: `factory update`.
3. Commit the result on a branch and open a PR. `factory update` prints the commands, for example
   `git checkout -b chore/update-my-skills && git add -A && git commit -m "Update my-skills to <commit>"`.
4. When `vendor/my-skills` and `.gitmodules` are protected (they should be), the gate won't let an agent merge it:
   the dev manager or you merge it.

**What each command does:**

| Command | What it does | Changes the pin? |
|---|---|---|
| `git submodule update --init` | Makes `vendor/my-skills` match the pinned commit (clones it the first time) | No |
| `git submodule update --remote vendor/my-skills` | Moves the folder to my-skills' newest main | Yes, in your working tree: you commit it |
| `factory update` | Runs both of the above, lists the new my-skills commits, re-runs `install.sh . --link` to link any new shared files, and tells you to commit. It doesn't commit or push | Yes, like `--remote` |
| `git config submodule.recurse true` | One setting per clone (not committed). After it, `git pull`, `checkout` and `switch` also update the submodule to the pin | No |
| `git clone --recurse-submodules <url>` | Clones the project with the submodule checked out | No |

**After the update PR merges:**

- **Running agents need nothing.** Between tasks the loop goes back to `origin/main` and runs
  `git submodule update --init`. If `factory-loop.sh` changed, it [restarts itself](#agent-loops). Each new Claude
  session also runs `git submodule update --init` in its SessionStart hook, so it uses the new hooks.
- **Your own clones:** `git pull` moves the pin but, without `submodule.recurse`, leaves the files where they were.
  `git status` then shows `modified: vendor/my-skills (new commits)`. Run `git submodule update --init` to fix it.

<br>

## The `factory` command

Run it from any folder inside the project or an agent worktree. `./factory install-shim` puts a small `factory`
command on your PATH that runs the `./factory` of whichever project you're in, so each project uses the factory
version it pins. `factory help` lists everything.

| Command | What it does |
|---|---|
| `factory loop [N]` | Starts an agent loop: one fresh, unattended Claude run per task (`claude -p`). `N` caps the number of tasks. Run it again in another terminal for another agent |
| `factory loop -i [N]` | The same, but each task opens a normal session you can watch and type into. It closes by itself when the task is done |
| `factory agent <name\|N>` | Opens Claude in that agent's folder (created the first time), with Remote Control on, for manual work there. To run the queue, use `factory loop -i` |
| `factory next` | Shows the job the factory would hand out next, without claiming it |
| `factory claims` | Which agent holds which folder and task on this clone (live or stale) |
| `factory reviews` | Which extra reviews and checks the current change needs |
| `factory env [name\|N]` | The ports and database of this folder, or of that agent |
| `factory worktree <name\|N>` | Prints that agent's folder (creates it the first time): `cd "$(factory worktree taytu)"` |
| `factory agents [list\|sweep]` | Issues mode: who is working, idle or down. `sweep` marks silent agents down and releases their issues |
| `factory issues [cmd]` | Issues mode: `list` (default), `show N`, `peek`, `new`, `tick`, `review`, `block`, `release`, `stale`, `setup` |
| `factory usage` | Tokens per task (or `--by agent`, `--by model`) from this machine's Claude Code logs; `--record "label"` appends a row to the usage log. [Measuring it](#measuring-it) |
| `factory settings` | Every setting in `factory.json`: its value here (or the default) and what it does. `settings show <key>` gives its type, default and options; `settings set <key> <value>` changes one, checked against its type; `settings unset <key>` goes back to the default. Then commit the file in a PR. Agents can't run `set` or `unset` |
| `factory check` | Runs the style checks CI runs (`styles[].check`) |
| `factory guard` | Runs the Factory guard on the current branch against `origin/<main>` (without labels) |
| `factory release <agent>` | Drops an agent's local claims, for example after a crash |
| `factory clean` | Removes agent worktrees no live agent uses and that have no uncommitted work, and local task branches whose task is done |
| `factory wait <pr> [minutes]` | Waits for a PR to merge (default 30 minutes), polling GitHub once a minute, without spending tokens |
| `factory update` | Takes the newest my-skills and relinks. [Then commit it in a PR](#updating-the-factory) |
| `factory install-shim` | Installs the `factory` command in `~/.local/bin` |
| `factory ci status` | Where CI runs (local or github), the latest runs on main and open PRs, and the local runner. [CI](#ci-githubs-runners-or-your-own-mac) |
| `factory ci use local\|github` | Sends CI jobs to the self-hosted runners with the project's label, or back to GitHub's |
| `factory ci install` / `uninstall` | Installs the runner as `<repo>-ci` (again to update), or removes it: a LaunchAgent on macOS, a systemd `--user` service on Linux. [Linux](#ci-on-linux) |
| `factory ci start` / `stop` | Runs the runner once by hand, in the background, until `stop` or a restart |
| `factory ci logs [-f]` | The runner's log |

<br>

## Agent loops

### Three ways to run an agent

- **`factory loop`**: unattended. Each task is a fresh `claude -p "/next-task <id>"` run. Nobody can answer a
  permission prompt, so `.claude/settings.json` must allow every command the build needs. Best for long stretches
  away.
- **`factory loop -i`**: interactive. Each task opens a Claude session with `/next-task <id>` already started. When
  the agent has opened its PR, it marks the task done and the session closes by itself. The loop then counts down
  10 seconds and starts the next task; type `q` and Enter to stop. If the session ends before the task is done
  (`/exit`, a crash, a usage limit), the loop also carries on after the same 10 s countdown, so it never waits all
  night for a key.
- **`factory agent <name>`**: your own Claude session in that agent's folder, for manual work there (a fix by hand,
  a look around). The SessionStart hook claims the folder, runs the install (in a worktree) and `agentSetup`, sets the
  agent's ports and database, and (issues mode) registers the agent. Started with no other arguments, it says in one
  line that the queue belongs in `factory loop -i`.

**Which one to use.** Run the queue with `factory loop -i`, on every machine: each task gets a fresh session, and you
can still type into it, here or through Remote Control. Use `factory loop` when nobody will watch. On a second machine,
give it its own agent names with `FACTORY_AGENTS` (see [Names and folders](#names-and-folders)), then run
`factory loop -i` there too. Avoid `/loop /next-task all` in one `factory agent` session: that session keeps every
task's context and grows with each one, which costs tokens and attention until it compacts.

### Names and folders

Agents have names. They show in the terminal, on Remote Control, in folder names and on issue labels
(`agent:taytu`). The default ten are figures from Ethiopian history: menelik, taytu, haile, tewodros, yohannes,
zewditu, lalibela, ezana, alula, abebe. Choose your own in `factory.json`, in order, with lowercase letters, digits
and dashes:

```json
"agents": ["ada", "grace", "linus"]
```

- The first agent works in the project folder. The others get git worktrees in `<project>-agents/<name>`, next to the
  project, created on first use and reused after that.
- A new loop takes the first name that no live loop on this clone holds. `factory agent 2` means the second name.
- **Several machines:** give each machine its own names with `FACTORY_AGENTS` in its shell profile, never in
  `factory.json`. For example `export FACTORY_AGENTS=menelik,taytu` on the Mac and
  `export FACTORY_AGENTS=haile,tewodros` on the Linux machine. `factory loop` then takes only those names, each
  with its usual folder, ports and database, so two machines never run the same agent. A name that isn't in
  `agents` stops the loop with a plain message.
  A loop holds its name for as long as it runs, however long that is. (Before 22 Oct a loop older than
  `claimStaleHours` lost its name, so a new loop could start as a second menelik.)
- Each time a loop starts in a worktree, it checks out `origin/main`, copies `.env.local` and `.env.*.local` across
  if they're missing, updates the submodules and runs `commands.install`.

### Own ports and database per agent

Agents on one machine mustn't share ports or databases. List the variables in `agentEnv`:

```json
"agentEnv": { "API_PORT": "{port:4100}", "DATABASE_URL": "postgres://app:app@localhost:5440/app{suffix}" }
```

| Placeholder | Agent 1 | Agent N |
|---|---|---|
| `{port:4100}` | 4100 | 4100 + `portStep` × (N − 1); `portStep` is 10 by default |
| `{suffix}` | empty | `_N` |
| `{slot}` | 1 | N |

The loop exports them (plus `FACTORY_SLOT` and `FACTORY_AGENT`), then runs `commands.agentSetup`, for example to
create that agent's database. Make the project's scripts and test configs read these variables, with today's values
as defaults.

### Between tasks

- **Remote.** If the repository was moved or renamed on GitHub, the loop points `origin` at its new name and says so
  in one line (`factory_remote.py`). The old address still reads, but API writes to it answer `307`.
- **Back to main.** The loop checks out `origin/main` (detached), cleans leftovers in agent worktrees (never in the
  project folder), updates the submodules and deletes local task branches whose task is done.
- **Self-update.** If main brought a different `factory-loop.sh`, the loop restarts itself with the new one, as the
  same agent in the same folder. No need to stop and start it.
- **Waiting.** When nothing is ready (every task done, blocked or taken), the loop checks again every `waitMinutes`
  (default 1) and stays `idle` on its agent issue. `"waitMinutes": 0` makes it exit instead. Ctrl-C stops it.
- **Waiting for a PR slot** (issues mode). When the agent's issue has its branch pushed, no PR yet, and `maxOpenPRs`
  ready PRs are open, the loop waits and takes no new work. As soon as a slot frees, it gives the agent that issue
  again, and the session opens the PR. Nobody has to restart it.
- **Stuck.** If the same task comes up 3 times in a row without being ticked or pushed, the loop stops and says so,
  so a person or the dev manager can look.

On exit, the loop drops its local claims and (issues mode) marks its agent issue `down`.

### From your phone: Remote Control

Sessions started by `factory loop -i` and `factory agent <name>` have Remote Control on. They appear at
claude.ai/code and in the Claude app, named after the agent and the task, so you can follow them and type into them,
`/exit` included. Remote Control needs a claude.ai login on a Pro, Max, Team or Enterprise plan. Set
`FACTORY_REMOTE_CONTROL=0` to turn it off. Unattended `factory loop` runs don't use it.

### MCP servers: the project's only

Every factory session (`factory loop`, `factory loop -i` and `factory agent`) starts Claude with
`--strict-mcp-config --mcp-config <main's .mcp.json>`, or an empty config when main has none, and with
`--settings '{"disableClaudeAiConnectors": true}'`. So agents never load your own claude.ai connectors (Notion,
Slack, Figma ...) or the MCP servers in your user settings. Their tools would go into every turn, cost tokens and
tempt an agent to use them. Your own `claude` sessions outside the factory keep them.

The config is `.mcp.json` as the main branch has it on origin (`factory_mcp.py` fetches it into
`.git/factory-mcp.json`), never the worktree's copy: Claude starts the servers in it without asking, so an
uncommitted, untracked or branch-only `.mcp.json` must never count. `.mcp.json` is in `protected`, and the deny
rules stop agents editing it, so a change to it needs a person to merge.

If the agents need an MCP server (a docs or design server, for example), add it to `.mcp.json` at the project root
in a PR that a person merges. Check a new session with `/mcp`: it should list only the project's servers.

### Practical notes

- More agents only help when the plan has tasks that don't depend on each other, and each one costs tokens.
- Set `maxOpenPRs` to about the number of agents + 1. The gate won't open more ready PRs than that.
- Keep the machine awake while agents run (on a Mac, `caffeinate -d` in another tab).

### Saving tokens

Most of the cost is what the agents read, not what they write.

- **A fresh session per task** (the loop already does this), so no task carries the last one's context.
- **No personal MCP connectors:** agent sessions load only the project's `.mcp.json`
  ([MCP servers](#mcp-servers-the-projects-only)).
- **Cheaper models for routine subagents:** the test-writer and the architecture-reviewer run on Sonnet
  (`model:` in their files); the reviewer and the safety and security reviews keep the session's model.
- **Read what the task needs.** Every agent reads the PRD sections, decisions and designs the task points to
  and searches long documents, instead of reading them whole. Keep `CLAUDE.md` short and stable (it starts
  every session, and an unchanged start is cheaper to read again); put notes that change often in
  `.claude/factory/notes/`.
- **A smaller Stop check:** set `commands.testChanged` and `typecheckChanged` to run only the changed packages
  (for example `pnpm -s turbo run test --filter=...[origin/main]`). A failure shows the failing lines first,
  `checkOutputLines` in all.
- **Edge cases in the task:** the issue template asks for the inputs the reviewers will try, so a task passes
  review in one round instead of several.
- **A quieter dev manager:** ticks every 10 minutes while an agent PR is open or a question waits, every 30
  otherwise, with short state notes.

### Measuring it

`factory usage` reads Claude Code's own session logs on this machine (`~/.claude/projects/`, the project folder
and every agent worktree, with their subagents) and prints tokens per task: fresh input (what missed the cache),
cache reads, output and the cache hit rate. Each reply counts once; a session belongs to the task branch it spent
most replies on.

```sh
factory usage                                # the last 7 days, per task
factory usage --by agent                     # per subagent type: main, reviewer, test-writer, ...
factory usage --since 2026-10-20 --until 2026-10-24 --record "baseline before token savings"
```

Agents also post each task's tokens on its PR, per subagent, when they open it and again before it merges
(`factory usage --task <n> --markdown`, a `<!-- factory-usage task=<n> -->` comment), so whoever merges sees
what the task cost.

`--record` appends one row of per-task averages to `docs/factory-usage.md` (`usageLog`). Commit it, so every
factory change has a before and after row and the next saving can be aimed where the tokens are. Run it on each
machine that runs agents: the logs stay local. Compare like with like (tasks of a similar size), and use `/usage`
or the console for money, since prices differ per model.

<br>

## Tasks

An agent never chooses a task by reading the plan. `next_task.py` hands out the next job, in this order:

1. **Rework.** An open PR whose latest `<!-- factory-mustfix sha=... -->` comment names its current head commit
   becomes `pr-<n>`. The agent checks out that branch, fixes every must-fix, gets a new reviewer pass, pushes and
   replies on the PR. The push moves the head, so the PR stops being rework. It doesn't merge it: the gate holds a
   PR with a must-fix until the dev manager approves the new commit. A PR with the `factory-hold` label is never
   rework. In `factory loop -i`, the agent marks the rework done too, so the session closes and the loop goes on.
2. **A new task**, from the plan or from issues.

### Plan mode (the default)

Tasks are the unticked lines of `docs/build-plan.md` (`- [ ] **1.3 Title**`), in order, minus the ids in
`docs/blocked.md` (`- 1.3: needs ...`). Both are read from `origin/main`, so a stale checkout can't skip or repeat
a task. The branch is `task/<id with dashes>-<name>`, and the PR ticks its own task.

**Claims, so two agents never build the same task:**

- On one clone: a lock file in the shared git folder (`<git-common-dir>/factory/claims.json`, never committed). A
  claim lasts while the loop's process is alive, up to `claimStaleHours` (default 6).
- Across machines: a `task/<id>-...` branch on the remote with a commit within `claimStaleHours` counts as taken.

### Issues mode

Set `"tasks": { "source": "issues" }` in `factory.json`, and run `factory issues setup` once to create the labels.

- **Each task is an issue**, written from the `factory-task` template: what we're building, goals, acceptance
  criteria (the "Done when") and a checklist of todos. The dev manager writes them:
  `factory issues new --title "..." --body-file f.md --milestone "Phase 3"`.
- **Order:** by milestone (oldest first), then issue number.
- **Dependencies:** `Depends on #12, #14` in the body. Agents skip the issue until those are closed.
- **Labels show the state:**

  | Label | Meaning |
  |---|---|
  | `factory:ready` | Can be picked up |
  | `factory:in-progress` | An agent is on it |
  | `factory:in-review` | Its PR is open |
  | `factory:blocked` | Needs a person; a comment says what |
  | `agent:<name>` | Which agent has it |
  | `factory-hold` | The dev manager is reviewing its PR |

- **Claims are race-free across machines.** An agent adds its labels and a `<!-- factory-claim agent=<name> -->`
  comment, waits 2 seconds, and reads the comments back. The earliest claim since the last
  `<!-- factory-release -->` wins; the loser takes its label off and picks again. `block` and `release` both post a
  release, so an old claim never outlives them. Unblock an issue with `factory issues release <n>`, not by editing
  labels.
- **An agent starts with its own issue.** If it holds one in progress, it carries on with it.
- **While it works** it ticks the todos (`factory issues tick <n> <index>`), names the branch `task/<n>-<name>`, opens
  the PR with `Closes #<n>` (the gate checks it), and moves the issue to in-review. Merging closes the issue.
- **Quiet issues.** `factory issues stale` lists in-progress issues with no activity (issue updates or commits on
  their branch) for `tasks.staleHours` (default 3). The dev manager checks the agent is really gone, then releases
  the issue back to ready.

<br>

## Live agents (issues mode)

Each agent also has its own issue, titled `Agent: <name> · <status>` and labelled `factory:agent`. The hooks keep it
current; the task never has to:

| When | What happens | Who does it |
|---|---|---|
| It starts | Registers: status `idle` | the loop, or the SessionStart hook |
| It takes a task | `working on #42` | `next_task.py` |
| It uses any tool | A ping, at most every `tasks.pingMinutes` (default 5), in the background | PostToolUse hook |
| A turn ends | `idle` | Stop hook |
| It exits | `down`, label `factory:agent-down` | the loop on exit, or the SessionEnd hook for your own sessions |

- **Down.** No ping for `tasks.downMinutes` (default 30) means it crashed, the laptop slept, or it's waiting at a
  prompt. `factory agents` shows such an agent as `silent`. The dev manager's `factory agents sweep` marks it down
  and puts its in-progress issues back to ready, so another agent takes them. If the silent agent comes back, the
  PR gate stops it opening a PR for an issue another agent now holds.
- **One issue per agent.** Only registering may open an agent's issue, and only when the agent has none, open or
  closed. A ping, a turn's end or an exit that can't find it changes nothing, and a lookup that fails is an error,
  never "no issue". If copies exist anyway, only the open one with the newest ping counts (in `list` and `sweep`),
  and `sweep` closes the others, so an old copy that went quiet never releases a live agent's work.
- **Where.** By default the issue says only the agent's slot. With `"tasks": { "showWhere": true }` it also posts
  the machine name and folder name.
- The hooks never fail or slow a session: errors are ignored.

<br>

## Reviews and gates

### The subagents

| Subagent | When | What it does |
|---|---|---|
| `test-writer` | Start of every task that adds behaviour | Writes failing tests from the "Done when" and the PRD. Never touches production code |
| `reviewer` | Every change, before the PR | Runs the checks and the guard, checks the task, the PRD and `CLAUDE.md`, and records a pass for the commit |
| `architecture-reviewer` | Changes on paths with a style guide (`styles`) | Reviews against the style-guide skills, runs their `check`, and records its own pass |
| `safety-auditor` | Changes on `reviews.safety-auditor.paths`, or anything touching the critical rules | Checks each critical rule still holds and is tested; writes a summary for whoever merges |
| `security-reviewer` | Changes on `reviews.security-reviewer.paths`, plus auth, payments, uploads, tenancy, secrets | Reports exploitable problems with file, line and fix |

`factory reviews` (`factory_reviews.py`) lists the extra reviews and checks a change needs, from `reviews`, `eval`,
`design` and `styles` in `factory.json`: for example `safety-auditor`, `security-reviewer`, `eval`, `design-check`,
`architecture-reviewer`. The `reviewer` is always needed and isn't listed. The next-task skill runs each listed one,
and the reviewer checks they ran.

**Review markers.** A pass is a file: the reviewer writes the commit id to `tmp/reviews/<branch>.ok`, the
architecture reviewer to `<branch>.arch.ok` (`reviewMarkers` sets the folder). A pass counts only for that exact
commit, so any new commit needs a new review.

### The PR gate

`pr-gate.py` is a PreToolUse hook. It reads every Bash command Claude runs, including compound ones (`;`, `&&`,
pipes, subshells), and blocks the pull-request commands that aren't ready:

| Command | Allowed only when |
|---|---|
| `gh pr create`, `gh pr new`, `gh pr ready` | The reviewer passed the current commit (and the architecture reviewer, on styled paths). Fewer than `maxOpenPRs` of your ready PRs are open. Plan mode: the task isn't ticked or blocked on main. Issues mode: the issue is open, not blocked, not held by another agent, and the body says `Closes #<n>`. Every new decision or migration file (`decisions`, `numberedDirs`) takes a number neither main nor another open PR has; the message names the next free one (`factory_numbers.py`). Drafts (`--draft`) skip all of this: they're how agents ask questions |
| `gh pr merge` | The PR is named by number or URL. It has no `factory-hold` label. The latest marker on it isn't a must-fix, and if it's an approval, it names the current head. The command has `--match-head-commit <head>`, so GitHub merges only the commit the gate checked. The reviewer passes (and the architecture reviewer's, on styled paths) are for that head. CI is green (`gh pr checks`); when the jobs never started (GitHub billing or the spending limit), the gate says that isn't a code result, so the agent doesn't push or re-run to chase it (`factory_ci.py`). No protected file changed (all files, past the first 100) |

It also blocks:

- more than one PR command, or a push and a merge, in one command;
- `gh` aliases and anything that isn't a known `gh` command;
- an agent posting the dev manager's markers (`factory-approved`, `factory-answer`, `factory-mustfix`) in a PR or issue
  comment, edit, review or close; `gh pr review --approve`; adding `tests-reviewed` or `deps-reviewed`; removing
  `factory-hold`.

**It fails closed.** If it hits an error (a broken `factory.json`, `gh` not signed in, a command it can't parse), it
blocks the command and says why.

**Trusted reviewers.** With `"trustedReviewers": ["<login>"]` in `factory.json`, only approvals from those GitHub
logins count. This only helps once the agents use a different GitHub account from the dev manager (see
[Security notes](#security-notes)).

`settings.json` backs it up with deny rules: no force push, no push to main, no `--no-verify`, no deleting remote
branches, no `gh api` and no `gh alias` from the agent, no edits to `.claude/`, `vendor/`, `CLAUDE.md` or the PRD,
no reading `.env` files.

### Other hooks

| Hook | What it does |
|---|---|
| Stop: `check.py` | Won't let a turn end while typecheck or tests fail, when code under `codePaths` changed |
| Stop: `factory_stop.py` | In `factory loop -i`, closes the session a few seconds after the agent marks its task done |
| SessionStart: `factory_session.py` | Updates the submodules. For your own sessions, also claims the folder, installs, sets the agent's env and registers it |
| Post-tool, Stop, SessionEnd: `factory_agents.py hook` | Pings, idle and down on the agent issue (issues mode) |

### The Factory guard (CI)

`factory_guard.py` runs in CI on every pull request, where the agent can't edit around it. It fails a PR for:

| Finding | Passes once the dev manager adds |
|---|---|
| An existing test deleted, or an assertion or test case removed or rewritten | `tests-reviewed` |
| A test weakened in a commit after implementation started | `tests-reviewed` |
| An existing golden or expected output changed or deleted (`goldenPaths`) | `tests-reviewed` |
| A new `.skip`, `.only`, `xit`, `fit`, `test.todo` or `@pytest.mark.skip` | `tests-reviewed` |
| A new dependency in a `package.json` | `deps-reviewed` |
| Two decision files with the same number | never: renumber |
| A task branch ticking a task other than its own | never: fix it |
| A workflow using `pull_request_target` | never: fix it |

It warns, without failing, when a PR is over `prSizeWarn` changed lines. A label change re-runs only the guard.
Create the two labels once in the repo. Only the dev manager adds them, after reading the change.

Protected files are not the guard's job: the PR gate stops an agent merging them, and branch protection with
`CODEOWNERS` can require you.

### Branch protection: the real lock

The gate and the hooks are guard rails for well-meaning agents. They run on your machine, inside the agent's own
session, and see only Bash commands. They are not a security boundary. **GitHub's branch protection is the lock.**
Set a ruleset (Settings, Rules, Rulesets) or a branch protection rule on main:

- **Require a pull request before merging, with 0 required approvals.** Everything is opened under one GitHub
  account, and GitHub doesn't let an author approve their own PR, so requiring an approval would block every merge.
- **Require status checks to pass:** `Factory guard` and `Typecheck, lint, test, build` (the job names in the kit's
  CI), plus any you add.
- **Block force pushes** (and deletions).
- **Include administrators:** no bypass list, so the rules hold for your own account too, which is the account the
  agents use.

Optional: `CODEOWNERS` on the protected paths, with "require review from code owners" once agents have their own
account.

<br>

## The dev manager

A Claude session, usually in the cloud, that runs the process the owner agreed. It ticks on a timer, reviews every
PR (protected ones included), merges, fixes small leftovers, answers questions, sweeps dead agents, writes issues in
issues mode, and tells you only what needs you. It can't type into an agent's terminal. Its levers are PRs, comments,
labels, the plan and the blocked list. Changing the factory, the scope or its own rhythm needs your yes.

It talks to the agents through markers in PR comments:

| Marker | Written by | Meaning |
|---|---|---|
| `<!-- factory-question -->` | An agent | A decision it needs. It keeps working around it |
| `<!-- factory-answer -->` | Dev manager | The answer, or `needs-owner: ...` when it's yours |
| `<!-- factory-mustfix sha=<head> -->` | Dev manager | Must-fixes for that commit. Makes the PR rework and holds its merge |
| `<!-- factory-approved sha=<head> -->` | Dev manager | That commit is approved. Clears a must-fix for that commit only |
| `factory-hold` label | Dev manager | It's reviewing. Agents skip the PR and can't merge it |

The full playbook is [DEV-MANAGER.md](DEV-MANAGER.md). To start it, say "be the dev manager for this repo" in a Claude
session with the repo attached.

<br>

## CI: GitHub's runners or your own Mac

A project's CI can run on GitHub's runners (the default) or on a self-hosted runner on your Mac, which uses no
GitHub Actions minutes, for example when the account's Actions minutes or billing are blocked. GitHub still starts
the jobs and shows the checks on each pull request; only the machine changes. `factory ci` does both, and doesn't
care which: `factory ci status` works in either mode.

```sh
factory ci install        # once, from a checkout on main, with Docker Desktop running and gh logged in
factory ci use local      # sends jobs to it (the repo variable CI_RUNS_ON)
factory ci status         # mode, latest runs, the runner, Docker, the last log lines
factory ci use github     # back to GitHub's runners; the runner stays installed and idle
factory ci uninstall
```

**Names come from the project.** For `acme/widget` the runner is `widget-ci` and its jobs ask for the label
`widget-local`. The LaunchAgent is `dev.software-factory.widget-ci`, the installed copy is
`~/Library/Application Support/widget-ci/widget-ci`, the log is `~/.local/state/widget-ci/runner.log`, the compose
project is `widget-ci`, and each registration is `widget-ci-<mac>-<time>`. To choose others, or to replace an older
install under another LaunchAgent label (`factory ci install` unloads it and removes its file first):

```json
"ci": {"name": "widget-ci", "label": "widget-local", "repo": "acme/widget", "replaces": ["com.example.old-runner"]}
```

**Several Macs.** Run `factory ci install` on each: they register with the same label and GitHub gives each job to
one of them. `factory ci status` lists every runner with the label; `factory ci stop` removes only this Mac's idle
registrations (and any of the project's that are offline and idle).

**How it runs.** The runner is GitHub's runner image as a Linux container, with its own Docker beside it
(Docker-in-Docker, on a unix socket only, no TCP port). Each registration is ephemeral: one job, then both
containers and all their volumes are removed (`down -v`) and a new round starts. No token is stored: each round gets
a registration token from your `gh` login (`factory ci start` also takes one on stdin or from `RUNNER_TOKEN`, and
never writes it). launchd runs a private copy in `~/Library/Application Support/<name>/`, never the checkout, so a
branch checked out later can't change what runs unattended; `factory ci install` warns when the checkout isn't on
`origin/main`. The LaunchAgent has only absolute PATH entries, is checked with `plutil -lint`, and is reloaded with
`launchctl bootout`, a wait until launchd lets go, then `bootstrap`. The loop is an executable named after the
runner (`#!/bin/bash`), so `ps` shows `/bin/bash …/<name>` and `factory ci stop` only kills a process with exactly
that command line. *Not tested:* what macOS shows for it in Login Items and Activity Monitor; the process itself is
still `bash`.

<a id="ci-on-linux"></a>

**On Linux.** `factory ci install` writes a systemd user service, `~/.config/systemd/user/<name>.service`, that runs
the private copy in `~/.local/share/<name>/`, with `Restart=always`. It then runs `systemctl --user daemon-reload`
and `enable --now`. `uninstall`, `status`, `stop` and `logs` work as on a Mac.
- **Linger:** without it, systemd stops a user's services at logout and doesn't start them at boot. `install` says so
  and gives the command: `sudo loginctl enable-linger <user>`.
- **Docker:** the service gets `DOCKER_HOST` from your shell, else from the current `docker context`, else
  `$XDG_RUNTIME_DIR/docker.sock` when rootless Docker is there.
- **The user manager:** `systemctl --user` needs that user's session. From `sudo -iu ci` or `su - ci` there is none, so
  `factory ci` stops before changing anything and says how to get one (log in as the user directly, or enable linger
  and set `XDG_RUNTIME_DIR=/run/user/<uid>`).
- **gh on the CI user:** sign in with `gh auth login --insecure-storage`, so the token is in gh's own file. A keyring
  can't be unlocked by a service at boot. Never put a token in the unit.
- **Recommended:** run CI as a dedicated user with **rootless Docker**. The privileged Docker-in-Docker container
  then has only that user's rights, which contains the known risk below.
- Several machines, Mac or Linux, can serve the same label.

**The workflow.** Each job picks its machine from the repo variable `CI_RUNS_ON`, and a pull request from another
repository (a fork) always runs on GitHub's runners:

```yaml
runs-on: ${{ fromJSON(github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && '"ubuntu-latest"' || vars.CI_RUNS_ON || '"ubuntu-latest"') }}
```

What the self-hosted runner needs that GitHub's image has (found in remanual, decision 0047 there):

- `actions/setup-node` **before** `pnpm/action-setup`: pnpm's installer needs `node`, which the runner image lacks.
  Use `pnpm/action-setup`'s own `cache: true` then.
- Tests one package at a time there: `pnpm run test ${{ runner.environment == 'self-hosted' && '--concurrency=1' || '' }}`.
  The Mac's CPUs are shared with the agents' work, and parallel test runs pushed slow tests past their timeouts.
- No Google Chrome (and none for Linux ARM64): for Lighthouse, point `CHROME_PATH` at Playwright's Chromium,
  wrapped with `--no-sandbox` (a container has no user namespaces for Chrome's sandbox).

**Before you use it.** Keep the repository private, and leave *Settings → Actions → General → Run workflows from
fork pull requests* off: that is what keeps outside code off your Mac (the `runs-on` rule above is a second layer).
Creating registration tokens needs admin on the repository. Keep the Mac awake while CI should run; queued jobs
wait (GitHub keeps them up to 24 hours) and start when the runner is back. `factory ci status` calls out runs
queued for a long time with no runner online.

**The known risk.** A job runs the code of the branch it tests, and the Docker-in-Docker container is privileged,
so it is not a security boundary: a job that tries can reach Docker Desktop's VM, your other containers and their
data, the folders Docker Desktop shares (by default all of `/Users`), and services on your Mac's `localhost`. Only
people who can push to the repository (you and the agents) run code on it. Running the runner in a separate VM is
the follow-up ([remanual #150](https://github.com/deresegetachew/remanual/issues/150)).

<br>

## Security notes

- **One GitHub login for everything is the weak spot.** By default the agents use your `gh` login. When the dev manager
  also posts as your account, GitHub can't tell them apart: an agent's token can merge, label and
  comment like the dev manager, and `trustedReviewers` can't separate them. The gate and the deny rules stop an agent
  doing this through its normal commands, but they're not a boundary against one that writes its own script.
- **Recommended for projects that matter: a separate GitHub account for the agents**, with write access (not admin)
  to the repo. Then put the dev manager's login in `trustedReviewers`, require approvals or code-owner reviews in
  branch protection, and the agents can't approve their own work.
- **The agents run on your machine.** Keep Claude Code's sandbox on rather than skipping permission checks, and keep
  secrets out of the repo (`.env.local`, the host's secret store). Agents are denied reading `.env` files.
- **Agent issues are public to anyone who can read the repo.** They show the slot only, unless you set
  `tasks.showWhere`.
- **CI:** the kit's workflow has read-only permissions and no secrets, and the guard fails a workflow that uses
  `pull_request_target`. A self-hosted runner (`factory ci`) runs branch code on your Mac with a privileged
  container: see [the known risk](#ci-githubs-runners-or-your-own-mac).

<br>

## Style guides

How the code is written comes from style-guide skills, chosen per path:

```json
"styles": [{
  "paths":  ["apps/api/**"],
  "skills": ["nestjs-clean-code-ddd-hexagonal", "nestjs-best-practices"],
  "check":  "python3 vendor/my-skills/nestjs-clean-code-ddd-hexagonal/scripts/check_structure.py"
}]
```

Link the skills from my-skills into `.claude/skills/` (see the [my-skills README](../README.md)). On those paths:

- CI runs the `check` (`factory check` runs it locally);
- the `architecture-reviewer` reviews against the guide;
- the PR gate needs its pass.

Files that don't follow the guide yet go on a legacy list (`structure.legacy`). The list only shrinks.

<br>

## factory.json settings

The template has every key with a short `_about`. Missing keys fall back to the defaults in `factory_config.py`.
`factory settings` lists them with their values and changes them for you:

```sh
factory settings                          # every setting, its value here or the default, and what it does
factory settings show tasks.source        # type, default, value here, options (plan, issues)
factory settings set maxOpenPRs 5
factory settings set agents '["ada","grace"]'   # lists and objects as JSON
factory settings unset maxOpenPRs         # back to the default
```

`set` and `unset` only write `.claude/factory.json`; commit it on a branch and merge it in a PR (`.claude/` is
protected). They refuse inside an agent session, and `settings.json` denies them to agents, because the PR gate
reads these settings.

| Key | What it sets | Default |
|---|---|---|
| `prd`, `plan`, `blocked`, `decisions` | Where the docs live | `docs/PRD.md`, `docs/build-plan.md`, `docs/blocked.md`, `docs/decisions` |
| `mainBranch` | The main branch | `main` |
| `commands` | `install`, `typecheck`, `lint`, `test`, `build`, `smoke`, `agentSetup`; `typecheckChanged` and `testChanged` run in the Stop check instead, for the changed packages only | empty |
| `checkOutputLines` | How many lines of a failing Stop check the agent sees: the failing lines first, then the end | 40 |
| `codePaths` | Folders with code: the Stop check runs when they change | `["src"]` |
| `checkRequires` | Paths that must exist before the Stop check runs, such as `node_modules` | `[]` |
| `protected` | Regexes of files an agent may not merge | `CLAUDE.md`, `.claude/`, `.github/`, `.env`, lockfiles |
| `alwaysAllowed` | Files that are never protected | the plan and the blocked list |
| `testPaths`, `goldenPaths`, `dependencyManifests` | What the guard treats as tests, expected outputs and manifests | see the template |
| `maxOpenPRs` | Ready PRs an account may have open at once | 3 |
| `prSizeWarn` | The guard warns above this many changed lines | 600 |
| `reviewMarkers` | Where review passes are written | `tmp/reviews` |
| `trustedReviewers` | GitHub logins whose approvals count | none: any approval counts |
| `holdLabel` | The hold label | `factory-hold` |
| `agents` | The agents' names, in order | the ten names above |
| `agentEnv`, `portStep` | Per-agent variables, and the port step | `{}`, 10 |
| `claimStaleHours` | How long a local claim or a pushed task branch holds a task | 6 |
| `waitMinutes` | How often an idle loop checks for work; 0 exits | 1 |
| `tasks` | `source` (`plan` or `issues`), `labels`, `staleHours` (3), `pingMinutes` (5), `downMinutes` (30), `showWhere` (off) | plan mode |
| `reviews` | Path regexes for `safety-auditor` and `security-reviewer` | empty |
| `eval`, `design` | Settings and paths for the eval and design-check skills | off |
| `styles`, `structure` | Style guides per path, and the structure check's roots and legacy list | none |
| `notes` | The notes folder | `.claude/factory/notes` |

<br>

<details>
<summary>The files in the kit</summary>

## The files in the kit

```
software-factory/
  README.md                               this page
  SKILL.md                                the skill: set up a project, or act as dev manager
  DEV-MANAGER.md                          the dev manager's playbook
  install.sh                              install into a project (--link with the submodule)
  tests/                                  tests for the gate, issues, the loop and the hooks
  kit/
    factory                               the command line
    factory-loop.sh                       the loop behind `factory loop`
    CLAUDE.factory.md                     template for the project's CLAUDE.md
    .claude/factory.json                  template: the project's config
    .claude/factory/notes/                template: the project's notes for the agents
    .claude/settings.json                 permissions and hooks
    .claude/agents/                       reviewer, architecture-reviewer, safety-auditor, security-reviewer, test-writer
    .claude/skills/                       next-task, design-check, eval
    .claude/hooks/
      pr-gate.py                          PreToolUse: gates gh pr create, ready and merge, and the markers
      check.py                            Stop: typecheck and tests
      factory_stop.py                     Stop: closes a finished session in `factory loop -i`
      factory_session.py                  SessionStart: a plain `claude` session becomes an agent
      factory_agents.py                   live agents: register, ping, down, sweep (and the hook entry)
      next_task.py                        the next job: rework first, then a free task
      factory_claims.py                   lock file: a folder and a task per agent; worktrees; clean
      factory_issues.py                   tasks as GitHub issues: pick, claim, tick, block, release, stale
      factory_env.py                      per-agent ports and database
      factory_reviews.py                  which extra reviews a change needs
      factory_settings.py                 `factory settings`: list, show, set and unset factory.json values
      factory_usage.py                    `factory usage`: tokens per task from the local Claude Code logs
      factory_guard.py                    the CI guard
      style_checks.py                     CI: each style's check
      factory_config.py                   reads factory.json, with defaults
      wait_for_merge.sh                   waits on a PR without spending tokens
    .claude/ci/                           `factory ci`: ci.sh (the commands), loop.sh (installed as <name>),
                                          compose.yaml, entrypoint.sh, ci_names.py, ci_status.py
    .github/                              template: CI workflow, factory-task issue template, CODEOWNERS
    docs/                                 templates: build plan, blocked list, decision template
```

Run a test file with `python3 software-factory/tests/test_pr_gate.py` (each file runs its own tests).

</details>
