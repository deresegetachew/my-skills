# Agent loops

How the agents run: loops, tasks, live agents, messages, following an agent and starting after a reboot.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [Agent loops](#agent-loops)
- [Tasks](#tasks)
- [Live agents (issues mode)](#live-agents-issues-mode)
- [Messages between agents](#messages-between-agents)
- [Watch and talk to an agent: `factory follow`](#watch-and-talk-to-an-agent-factory-follow)
- [After a reboot: `factory autostart`](#after-a-reboot-factory-autostart)

<br>

## Agent loops

### Three ways to run an agent

- **`factory loop`**: unattended. Each task is a fresh `claude -p "/next-task <id>"` run. Nobody can answer a
  permission prompt, so every headless `claude -p` starts with `--permission-mode acceptEdits` (setting
  `permissionMode`; `default` passes no flag and leaves it to your own Claude Code settings). Edits inside the
  project then need no answer, and the agents' settings (`.claude/factory/settings.json` plus `permissions.allow`, passed when the loop starts the agent, #258) must allow every command the build needs; a command that
  is neither allowed nor denied stops the run. Interactive sessions are not given a mode. Before an unattended run starts, the loop checks that Claude Code trusts the folder (it ignores the whole allow list in one it does not); if not, it prints a `{code, message, fix}` naming the folder to open once with `claude`, starts nothing and stops. A folder it cannot judge (no `~/.claude.json`) goes ahead. `--dry-run` shows the flag,
  and `factory doctor` prints the mode and says `fix` when a headless run would stall (mode `default` with no mode in
  your own settings, or no rule for `git commit`, `git push`, `gh pr` and the like). Best for long stretches away.
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
- **Several machines:** give each machine its own names, never in `factory.json`. Either
  `export FACTORY_AGENTS=menelik,taytu` in the shell profile, or run `factory machine setup menelik,taytu`, which writes
  `~/.config/software-factory/<repo>.json` (`{"agents": [...]}`; `<repo>` is the main clone's folder name). The
  environment variable wins over the file; with neither, every name in `agents` is used, as before. The other machine
  uses other names (`haile,tewodros`). `factory loop` then takes only those names, each with its usual folder, ports
  and database. A name that isn't in `agents` stops the loop with a plain message. `factory machine` shows this
  machine's id and names; `setup` refuses a name another machine has live.
  - **Machine id.** The first time it's needed a random id is saved in `~/.config/software-factory/machine-id` (never
    the hostname; `FACTORY_MACHINE_ID` overrides it). It goes into claims
    (`<!-- factory-claim agent=<name> machine=<id> -->`) and agent pings (`... ping=<time> machine=<id> -->`). If two
    machines do end up with one name, a claim is won by one machine only (the other keeps the shared label off its
    own back and picks again), an agent never resumes an in-progress issue whose winning claim came from another
    machine, and `factory loop` / `register` stop with `{code, message, fix}` (`agent-name-in-use`, exit 3) when the
    open `Agent: <name>` issue was pinged by another machine within `tasks.downMinutes`. The hostname is posted only
    with `tasks.showWhere`; `factory agents` shows the machine id. Claims and pings without a machine id (an older
    kit) are read as before, by name alone.
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
  in one line (`factory_remote.ts`). The old address still reads, but API writes to it answer `307`.
- **Back to main.** The loop checks out `origin/main` (detached), cleans leftovers in agent worktrees (never in the
  project folder), updates the submodules and deletes local task branches whose task is done.
- **Self-update.** If main brought a different `factory-loop.sh`, the loop restarts itself with the new one, as the
  same agent in the same folder. No need to stop and start it.
- **Waiting.** When nothing is ready (every task done, blocked or taken), the loop checks again every `waitMinutes`
  (default 1) and stays `idle` on its agent issue. `"waitMinutes": 0` makes it exit instead. Ctrl-C stops it.
  While fewer than `github.reserve` (500) GitHub calls are left this hour, it waits twice as long.
- **GitHub's limit.** Every agent on the account shares GitHub's 5,000 calls an hour. When a lookup meets the limit,
  the loop says `GitHub limit reached; waiting until HH:MM UTC`, waits for the reset and carries on. A secondary limit
  or a network timeout is tried again after 1, 2, 4, 8, then 15 minutes. Neither counts as a failed pass.
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
`--strict-mcp-config --mcp-config <main's .mcp.json>`, or an empty config when main has none, and the agents'
settings it passes (`--settings`, #258) turn off claude.ai connectors (`disableClaudeAiConnectors`). So agents never load your own claude.ai connectors (Notion,
Slack, Figma ...) or the MCP servers in your user settings. Their tools would go into every turn, cost tokens and
tempt an agent to use them. Your own `claude` sessions outside the factory keep them.

The config is `.mcp.json` as the main branch has it on origin (`factory_mcp.ts` fetches it into
`.git/factory-mcp.json`), never the worktree's copy: Claude starts the servers in it without asking, so an
uncommitted, untracked or branch-only `.mcp.json` must never count. `.mcp.json` is in `protected`, and the deny
rules stop agents editing it, so a change to it needs a person to merge.
`origin` comes from the clone's git config, so anyone who can change that config (`remote.origin.url`, `url.*.insteadOf`) can change which repository the servers come from; the PR gate trusts that config in the same way.

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
- **Cheaper models where it's safe:** the test-writer, the architecture-reviewer and the first pass of the
  `reviewer` run on Sonnet (`model:` in their files). The `safety-auditor` and the `security-reviewer` stay on Opus.
  When the reviewer reports a must-fix, the agent fixes it and the fixed commit is reviewed again on Opus, which says
  how each earlier must-fix was resolved before it records the pass; Opus without a fix is only for items marked
  unsure. A diff over `prSizeWarn` lines, or one that touches a `protected` path, goes to Opus from the start.
- **A model per role** (`models` in `.claude/factory.json`, see [settings](settings.md#factoryjson-settings)), so two machines never run different builder
  models by accident.
- **Read what the task needs.** Every agent reads the PRD sections, decisions and designs the task points to
  and searches long documents, instead of reading them whole. Keep `CLAUDE.md` short and stable (it starts
  every session, and an unchanged start is cheaper to read again); put notes that change often in
  `.claude/factory/notes/`.
- **A smaller Stop check:** set `commands.testChanged` and `typecheckChanged` to run only the changed packages
  (for example `pnpm -s turbo run test --filter=...[origin/main]`). A failure shows the failing lines first,
  `checkOutputLines` in all. After a green check, the next Stop skips it when nothing changed. That means the same
  HEAD, the same tracked changes anywhere in the repo, the same untracked files that aren't ignored, the same
  commands, and `checkRequires` paths (such as `node_modules`) not touched since. Other ignored files, such as
  `.env`, aren't compared.
  It remembers this in the git folder (`.git/factory-check-green`, one per worktree), and a failure is never
  remembered. Like the review markers, it's a guard rail: a hand-written file there skips the check.
- **Quiet checks (`factory run-check <command>`):** runs a check or test command, keeps the full output in
  `checkLogDir` (default `tmp/checks/<name>.log`; the folder ignores itself, so a log is never an untracked file)
  and prints one line when it passes. When it fails it prints `checkOutputLines` lines at most (the failing lines
  first, then the end) and the log path; open the log only if that isn't enough. `--name` names the log, `--lines`
  overrides the cap, and the exit code is the command's. The Stop check and `factory verify` also save the full
  output of a failure there and name the file. `next-task` tells agents to run checks this way. To cut noise at the
  source too, set the `commands` to quiet reporters yourself (for example `pnpm -s`, `vitest --reporter=dot`,
  `turbo --output-logs=errors-only`, `tsc --pretty false`); the kit doesn't pick them, since it can't know your stack.
- **Auto-format before the checks (`commands.fix`, `factory fix`):** set `commands.fix` to your formatter and
  auto-fixer (for example `prettier --write {files} && eslint --fix {files}`; `{files}` is the quoted list of files,
  appended when missing). It runs on the **changed files only**: everything that differs from the merge base with main
  (committed, edited or new and not ignored), minus deleted files, so unrelated files never churn. `fixPaths` (regexes)
  narrows that to the files the tools understand. The Stop check runs it before typecheck and test, and `factory verify`
  before `commands.ci`. The agent is told in one line ("formatted 3 files"), never shown a diff. If the fixer exits
  non-zero, its unfixable findings are shown like a failing check (the failing lines first, `checkOutputLines` in all,
  and the log). `factory verify` refuses a pass when the fixer changed files, since the commit no longer matches the
  files: commit them and run it again. The reviewers are told not to comment on anything the fixer handles. A git
  pre-commit hook was not added: the Stop check and verify cover every path to a pull request without touching
  `.git/hooks`.
- **Edge cases in the task:** the issue template asks for the inputs the reviewers will try, so a task passes
  review in one round instead of several.
- **A quieter dev manager:** the orchestrator has no model, so an idle cycle costs no tokens. It waits
  `manager.busyMinutes` after a cycle with work and `manager.idleMinutes` otherwise, and a sub-manager reads only its one
  item ([Waiting without tokens](#waiting-without-tokens)).

#### Model and effort per role (`models`)

Without a `models` setting nothing changes: a subagent keeps the `model:` in its kit agent file, and the builder and
the manager run on Claude Code's own default. A project sets values in its `.claude/factory.json` (the owner commits
it; `factory settings set models '<json>'` checks it):

```json
"models": {
  "builder":  {"model": "opus", "effort": "high"},
  "manager":  {"model": "sonnet"},
  "test-writer": {"model": "haiku"},
  "reviewer": {"model": "sonnet", "escalateTo": "opus"},
  "architecture-reviewer": {}, "safety-auditor": {}, "security-reviewer": {}
}
```

Roles: `builder`, `manager`, `product-owner`, `test-writer`, `reviewer`, `architecture-reviewer`, `safety-auditor`,
`security-reviewer`. A bad role, an empty model or a bad effort (`low`, `medium`, `high`, `xhigh`, `max`; builder,
manager and product-owner only) is rejected. Where the defaults live: the subagents' in `kit/.claude/agents/<name>.md`
(factory-wide); the builder's and the manager's nowhere, so Claude Code's default.

How the values reach Claude Code: `factory loop` and `factory agent` add `--model` and `--effort` for the builder (the
dev manager's and the product owner's loops do the same for `manager` and `product-owner`).
For a subagent they add `--agents <json>`, which redefines that agent for the session with your model and the agent
file's own prompt, tools and description, so the shared file is never edited or shadowed.
`bun --no-env-file --config=/dev/null .claude/hooks/factory_models.ts flags manager` prints the same arguments for the manager's session.
`factory doctor` prints the effective model per role and what set it. The environment variable
`CLAUDE_CODE_SUBAGENT_MODEL` is not used: on its own the agent file's `model:` wins, and with `..._FORCE=1` it
forces one model on every subagent. `escalateTo` is the model the next-task skill asks the reviewer again on after a must-fix or an item it marked unsure
(`bun --no-env-file --config=/dev/null .claude/hooks/factory_models.ts escalate` prints it; `opus` when unset).

### Waiting without tokens

A Claude session that waits by checking again pays for every check, because each turn re-sends the context. So every
wait is a shell loop that checks GitHub (REST, `gh api`), pauses 15 seconds and then 22, 33 ... up to 60
(`FACTORY_WAIT_START`, `FACTORY_WAIT_MAX`), and returns one line only when there is something to do. Default 30
minutes. The exit code says what happened:

| Exit | Meaning |
|---|---|
| 0 | It happened: merged, CI green, answered, slot free, task ready |
| 1 | `ci`: a check failed (the line names it). `answer`: no question is waiting |
| 2 | Timed out. Do other work and wait again later |
| 3 | `ci`: the PR is merged or closed. `precheck`: there is work |
| 4 | `ci`: GitHub never started the jobs (billing); see `factory_ci.ts` |

`factory wait <pr>` is unchanged. Agents and the dev manager never poll inside the conversation (`next-task` and
[DEV-MANAGER.md](../../DEV-MANAGER.md) say so). A manager pass starts with `factory precheck` and ends there when it
prints `nothing to do`: one short command, no review, no reading of state notes.

**An idle tick makes no model call.** `factory manage-tick` runs the precheck in the shell and only when it lists work
starts one `claude -p "/manage-pass"` session (manager profile, `models.manager` flags, project MCP servers only); that
session ends with the pass. Put it on a timer instead of keeping a session alive to tick, for example
`*/10 * * * * cd /path/to/project && ./factory manage-tick >> .git/factory-manage-tick.log 2>&1`. Nothing stays open between
ticks and an idle one costs no tokens. The orchestrator of `factory dev-manager loop` does the same: it starts a
sub-manager only when `precheck` finds an item.

### Measuring it

`factory usage` reads Claude Code's own session logs on this machine (`~/.claude/projects/`, the project folder
and every agent worktree, with their subagents) and prints tokens per task: fresh input (what missed the cache),
cache reads, output and the cache hit rate. Each reply counts once; a session belongs to the task branch it spent
most replies on.

```sh
factory usage                                # the last 7 days, per task
factory usage --by agent                     # per subagent type: main, reviewer, test-writer, ...
factory usage --by role                      # manager (/manage-pass, or the dev manager marker), product-owner (its marker), builder (all others)
factory usage --since 2026-10-20 --until 2026-10-24 --record "baseline before token savings"
```

Agents also post each task's tokens on its PR, per subagent, when they open it and again before it merges
(`factory usage --task <n> --markdown`, a `<!-- factory-usage task=<n> -->` comment), so whoever merges sees
what the task cost.

`--record` appends one row of per-task averages to `docs/factory-usage.md` (`usageLog`). Commit it, so every
factory change has a before and after row and the next saving can be aimed where the tokens are. Run it on each
machine that runs agents: the logs stay local. Compare like with like (tasks of a similar size), and use `/usage`
or the console for money, since prices differ per model.

`factory report` adds what GitHub knows, the same on every machine: per task pull request opened in the last 7 days
(`--since 2026-10-20` or `--since 30d`), the hours from the agent's claim to the PR (issues mode) and from the PR to
the merge, the rework rounds (the dev manager's must-fix comments), and the CI runs on its branch with how many
failed. Then the medians and totals for the merged ones. `--json` gives the same for scripts. It only reads.
For merged tasks with a budget it also lists used against budget and the median ratio (below).

### Token budgets

A task can have a token budget (#183), so the agent plans before it builds. It is advice: shown, compared and warned
about, never a stop.

- **What it counts:** one task's tokens, all its sessions and subagents on this machine, as `factory usage` reports
  them: fresh input (input + cache writes) + output. Cache reads are not counted (they are cheap and grow with every
  turn), and there is no money: prices differ per model.
- **Where it is set:** a `Budget: 300k` line in the task issue, next to the `PRD:` line (`300k`, `1.2m`, `300000` and
  `300,000` all work); the product owner sizes tasks when writing them. A task without one gets `budget.builder` from
  `.claude/factory.json`. Neither: no budget, and nothing changes.
- **Who may change it:** the claim records the budget the issue had when the task was claimed
  (`<!-- factory-budget tokens=... -->` in the claim comment), and that is the budget from then on, so an edit during
  the task does not move it. The PR gate also refuses a coding agent's `gh issue edit` that changes the `Budget:` line,
  and a comment with the `factory-budget` marker. The product owner and the dev manager may change it; the new number
  counts from the next claim. An agent that needs more asks with a `<!-- factory-question -->` comment.
- **How it reaches the agent:** the loop's prompt states the budget and what it counts. The next-task skill writes a
  short plan with a rough estimate after reading the brief and splits or asks when it clearly won't fit. At the
  checkpoints (tests written, before the first review, before the PR) it runs `factory usage --task <n> --budget`,
  which prints used, budget, left and the percent, and a warning from 80%.
- **Overrun:** the PR's usage comment (`factory usage --task <n> --markdown`) adds used against budget, with the
  percent and the top-spending subagent. The dev manager decides at review: accept, ask for a split, or note it. CI
  never fails on it.

Why no hard stop: the agent only learns the count at checkpoints, and stopping in the middle of a change leaves a
broken branch (red tests, a half-done rebase). Advice plus a warning at 80% keeps the branch whole.

The first budgets are guesses: there are few recorded numbers yet. Record real ones with `factory usage --record`, and
read `factory report`'s median ratio before tightening them. The logs are per machine, so a task built on two machines
shows only this machine's part.

<br>
## Tasks

An agent never chooses a task by reading the plan. `next_task.ts` hands out the next job, in this order:

1. **Rework.** An open PR whose latest `<!-- factory-mustfix sha=... -->` comment names its current head commit
   becomes `pr-<n>`. The agent checks out that branch, fixes every must-fix, gets a new reviewer pass, pushes and
   replies on the PR. The push moves the head, so the PR stops being rework. It doesn't merge it: the gate holds a
   PR with a must-fix until the dev manager approves the new commit. A PR with the `factory-hold` label is never
   rework. In `factory loop -i`, the agent marks the rework done too, so the session closes and the loop goes on.
2. **A new task**, from the plan or from issues.

The agent runs it as plain `next_task.ts`, with no shell variable: Claude Code asks before running a command with
one, and unattended nobody answers. The script takes the agent's name from `FACTORY_AGENT` and claims with
`FACTORY_PID` when the SessionStart hook set it (under the loop, the loop has claimed already).
`factory_claims.ts done --task <id>` and `release` take the name the same way; an explicit `--claim` or `--agent` wins.

### Plan mode (the default)

Tasks are the unticked lines of `docs/build-plan.md` (`- [ ] **1.3 Title**`), in order, minus the ids in
`docs/blocked.md` (`- 1.3: needs ...`). Both are read from `origin/main`, so a stale checkout can't skip or repeat
a task. The branch is `task/<id with dashes>-<name>`, and the PR ticks its own task.

**Claims, so two agents never build the same task:**

- On one clone: a lock file in the shared git folder (`<git-common-dir>/factory/claims.json`, never committed). A
  claim lasts while the loop's process is alive, up to `claimStaleHours` (default 6).
- Across machines: a `task/<id>-...` branch on the remote with a commit within `claimStaleHours` counts as taken.
- A PR's rework (`pr-<n>`, both modes) is also claimed on the PR, so every machine sees it: a
  `<!-- factory-rework-claim agent=<name> machine=<id> host=<host> sha=<head> until=<time> -->` comment. The earliest
  unexpired claim for the PR's head wins, and a loop skips a PR another agent holds. The claim is released when the run
  ends (`factory release <agent>`, or the loop's own release posts `factory-rework-release`), counts for no more than
  `claimStaleHours` after it was posted, and means nothing once a new commit is pushed. `factory claims` lists them as
  `rework` lines with the agent and machine, and the cockpit's Pull requests view shows who is reworking a PR.

### Issues mode

Set `"tasks": { "source": "issues" }` in `factory.json`, and run `factory issues setup` once to create the labels.

- **Each task is an issue**, written from the `factory-task` template: what we're building, goals, acceptance
  criteria (the "Done when") and a checklist of todos. The dev manager writes them:
  `factory issues new --title "..." --body-file f.md --milestone "Phase 3"`.
- **Order:** by milestone (oldest first), then issue number.
- **Dependencies:** `Depends on #12, #14` in the body. Agents skip the issue until those are closed. The numbers can
  be issues or pull requests: a task that depends on an open PR waits until it is merged or closed.
- **Labels show the state:**

  | Label | Meaning |
  |---|---|
  | `factory:ready` | Can be picked up |
  | `factory:in-progress` | An agent is on it |
  | `factory:in-review` | Its PR is open |
  | `factory:blocked` | Needs a person; a comment says what |
  | `agent:<name>` | Which agent has it |
  | `factory-hold` | The dev manager is reviewing its PR |

- **Claims are race-free across machines.** An agent adds its labels and a `<!-- factory-claim agent=<name> machine=<id> -->`
  comment, waits 2 seconds, and reads the comments back. The earliest claim (name and machine) since the last
  `<!-- factory-release -->` wins; the loser takes its label off and picks again. `block` and `release` both post a
  release, so an old claim never outlives them. Unblock an issue with `factory issues release <n>`, not by editing
  labels.
- **An agent starts with its own issue.** If it holds one in progress (and the claim that won it came from this machine), it carries on with it.
- **While it works** it ticks the todos (`factory issues tick <n> <index>`), names the branch `task/<n>-<name>`, opens
  the PR with `Closes #<n>` (the gate checks it), and moves the issue to in-review. Merging closes the issue.
- **Quiet issues.** `factory issues stale` lists in-progress issues with no activity (issue updates or commits on
  their branch) for `tasks.staleHours` (default 3). The dev manager checks the agent is really gone, then releases
  the issue back to ready.

<br>
## Live agents (issues mode)

Each agent also has its own issue, titled `Agent: <name> · <status>` and labelled `factory:agent`. The hooks keep it
current; the task never has to. Only an agent that has registered gets an issue, and never a `down` one: a name in `agents` that has not run has none.

| When | What happens | Who does it |
|---|---|---|
| It starts | Registers: status `idle` | the loop, or the SessionStart hook |
| It takes a task | `working on #42` | `next_task.ts` |
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

### The heartbeat daemon

Pinging on tool use cannot tell an agent that is waiting in `factory wait` for 30 minutes from one that has died, and
it leaves a crashed machine's agents saying `working`. A small daemon, one per machine and project, asks the machine
instead. Every `tasks.heartbeatSeconds` (20) it checks, locally and for free, each agent that runs here: does a live
loop or Claude process hold its checkout (the claim), is a `factory wait` or `wait_for_merge.sh` running below it,
which tmux session and Remote Control link it has, and when it last produced output. From that it derives one state:

| State | Meaning |
|---|---|
| `working` | Alive and holds a task, or its tmux session or transcript changed in the last 2 minutes (a dev manager reviewing, a coding agent on its PR) |
| `waiting` | Alive and deliberately blocked in a `factory wait` (a PR slot, CI, an answer, a merge) |
| `idle` | Alive, no task, and quiet for 2 minutes |
| `down` | No live process holds its checkout (a killed session, a power cut after a reboot) |

- **Cheap on GitHub.** It always writes its local state file (`factory agents ls` reads that, instantly). GitHub gets
  one edit of the agent's own issue only when the state changed and lasted a few seconds, plus a keepalive every
  `tasks.pingMinutes`: at most 12 edits per agent per hour. `down` goes out about one cycle after the process
  disappeared. With the daemon running, the tool-use pings and the `idle` on turn end are left to it.
- **The sweep uses it.** `factory agents sweep` never releases the issues of an agent the daemon sees alive, even one
  waiting for hours. It releases an agent that is really down after `tasks.releaseDownMinutes` (10), and one whose
  daemon-written keepalive is missing for `tasks.heartbeatMissMinutes` (12), such as a machine that lost power. Without
  the daemon, everything works as before (30 minutes, `tasks.downMinutes`).
- **`factory agents ls`** shows this machine from the state file and the other machines and the cloud agents from their
  agent issues, cached 45 seconds (`--fresh` asks again, `--local` never asks, `--json` for tools). A name that is
  `down` here but runs on another machine shows that machine's row. The tmux session,
  folder, machine name and follow link reach GitHub only with `tasks.showWhere`, since agent issues are readable by
  anyone who can read the repo.
- **Every role has a row.** The `Kind` column is the role: coding agent, dev manager, product owner (from the loop's
  checkout claim, or `roles.<role>.names` for a claim from an older release), and sub manager for each one-item
  sub-manager the dev manager's orchestrator runs here, named `<manager>-<item>`. A sub-manager's row stays on this
  machine: it has no agent issue, so `factory agents ls` on another machine does not show it. A dev manager or product
  owner on a machine with an older release reaches GitHub as a coding agent; `factory agents ls` shows its role from
  its agent issue's role marker.
- **Install.** `factory autostart install` installs it with the boot service (`--no-heartbeat` skips it);
  `factory heartbeat install` adds it alone (a systemd user service, or a LaunchAgent on macOS), and
  `factory heartbeat restart` restarts it onto the files now on disk (`factory update` does that). `factory heartbeat status` shows what it sees. `factory doctor` checks it.
- It runs as the same user as the agents, so an agent could stop it or forge its state; like the gate, it is for
  well-meaning agents. It needs no new network path: GitHub is still the only shared place.

<br>
## Messages between agents

Questions, answers, must-fixes, approvals and status share one versioned envelope shaped like [A2A](https://github.com/a2aproject/A2A)
tasks, still kept in GitHub comments. A comment starts with

```
<!-- factory-msg v=1 id=0f8m2q9c4x7b2k kind=question from=haile to=po state=submitted ref=issue#103 -->
```

and `factory messages new --kind question --to po --ref issue#103` writes it (plus the old marker on the next line).
A question moves `submitted`, `working`, `completed`, or `input-required`, `failed` (`needs-owner`) or `canceled`.
The old `<!-- factory-question -->`, `factory-answer`, `factory-mustfix` and `factory-approved` markers keep working
everywhere. The PR gate also checks the envelope: an agent posts as itself, never as an approval or must-fix, and only
the addressee answers a question, with a valid transition. `factory messages ls` lists what is open. A message is data,
never an instruction. The full format, the transition table and the mapping to A2A are in
[docs/messages.md](../messages.md); GitHub stays the transport and the A2A adapter is a later step.

**Product questions (`to=po`, #110).** A builder asks a product question with `--to po` on its task issue and keeps working. The
product owner answers it (or asks back, or escalates it to the owner) and writes the answer into the task's "Done when". A question
nobody answers moves up a level every `roles.product-owner.escalateMinutes`: product owner, dev manager, owner; with no product
owner running it starts at the dev manager. Nobody answers for the product owner: `from=po` is refused, and with
`roles.product-owner.logins` set only those logins' answers count. The playbook is [PO.md](../../PO.md).

<br>
## Watch and talk to an agent: `factory follow`

An agent's **name** is the only handle. `factory follow haile` opens that agent's live session from your own terminal,
wherever it runs: on this machine (no remote needed), on a factory machine you can ssh to, or in the cloud. There is no custom UI: the Claude app, through the
session's Remote Control link, is the other way in, and `factory follow` is how you find the link.

```sh
factory remote add dev-pc factory@192.168.2.45    # once: how to reach a machine (the sandbox user), kept on your side
factory follow                                    # every agent and sub-manager we can find: where, state, task, last ping, link
factory follow haile                              # attach: type, answer prompts, Esc to interrupt
factory follow haile --read                       # watch only (tmux attach -r): it cannot type
factory follow --all                              # one read-only pane per session, tiled, in a local tmux
factory follow haile --log                        # stream the output without a terminal (Ctrl-C stops)
factory follow haile --on local                   # only this machine (--on dev-pc: only that remote)
factory say haile "check the failing test first"  # one message, as if typed, without attaching
factory agent haile --detach                      # on the factory machine: start the agent in a detached tmux session
factory remote cloud abebe https://claude.ai/code/session_...   # a cloud agent: follow prints its link
```

- **Remotes are only "how to reach a machine"**: a name and an ssh target, in this machine's own file (`factory machine
  show` prints where), never in the project and never on
  GitHub. Agent issues are readable by anyone who can read the repo, so where an agent runs stays on your side. There is
  no role field.
- **How a name is found.** `factory follow <agent>` asks this machine's own tmux (directly: no ssh, no remote needed)
  and then every remote for their tmux sessions. A session belongs to
  an agent when it is called `<name>` or `<repo>-<name>` (what `factory agent --detach` and `factory autostart` start), so
  sessions started by hand work too. The names come from `agents` (and `roles.*.names`) in `factory.json`. If two remotes
  answer to one name, or this machine and a remote, `follow` refuses and `--on <remote>` picks (`--on local` is this
  machine, so no remote may be called `local`); unique names across machines is a setup rule. A name that is not
  found, or whose session ended, is refused with the names it knows.
- **Sub-managers.** The one-item sub-managers that the dev manager's orchestrator starts are tmux sessions called
  `<manager>-<item>` (`dev-manager-pr-42`, `manager-issue-7`): they are listed with the agents, with the manager and the item
  in the task column, and `factory follow dev-manager-pr-42` attaches to one.
- **The list** shows the session's state from the agent issue when `tasks.source` is `issues` (alive, silent, down, its task
  and last ping), otherwise `running`; the Remote Control link is read from the session's screen
  (`claude.ai/code/session_...`, it changes when the session restarts), so you can open the same session from the Claude app on a
  phone. A cloud agent has no machine: `follow` prints its link instead of attaching. A remote that cannot be reached is named,
  with the reason, and the others still list.
- **Builders don't run in a claude.ai cloud session** (#182). A builder opens its pull request with `gh pr create`, which
  needs GitHub's GraphQL API, and that is blocked there. The agents' settings deny `gh api`, because a REST call would get
  around the PR gate (a merge or a review marker it never sees), so there is no fallback: the builder stops and reports,
  keeping its claim. Run builders on a factory machine; a cloud session can still be followed, talked to and used for
  work that opens no pull request.
- **Detaching is safe**: `Ctrl-b d` detaches, and closing the terminal or losing the connection only detaches, so the agent
  keeps working. `Ctrl+C` is not detach: it interrupts Claude, and quitting Claude ends the session and drops the agent's
  claims (it then shows as silent in `factory agents`). Everyone attached sees one screen, shrunk to the smallest terminal: give
  extra viewers `--read`.
- **Safe by construction**: every ssh call uses keys only (`BatchMode`) and one shared connection per target
  (`ControlMaster`, so `follow` stays fast). A target where `sudo -n true` succeeds is refused: use the sandbox user that
  [`factory bootstrap`](sandboxed-machine.md#a-sandboxed-machine-factory-bootstrap) made, never an admin account. A remote name `root@` is refused when
  you add it. No secret is stored in the remotes.
- **`say`** types one line (up to 2000 characters, no line breaks or control characters) into that session only, with tmux's
  literal mode so the text is never read as a key name or command, and appends `time, from, via, agent` to
  `~/.local/state/software-factory/say.log` on the machine where the agent runs (not the text). It is for the person who owns the
  machine; never put a secret in it. Agents cannot run `say`, or change the remotes (refused when `FACTORY_AGENT`, `FACTORY_LOOP`
  or `CLAUDECODE` is set); they may list.

<br>
## After a reboot: `factory autostart`

After a reboot, a crash or a power loss, part of a factory machine comes back by itself (the CI runners, rootless
Docker) and part does not: the dev stack is down, and the agents are gone, so their claims go stale and the dev
manager may hand their issues to someone else. `factory autostart` closes that gap. It is **opt-in per machine**.

```sh
factory settings set commands.stackUp 'pnpm stack:up'      # once per project, merged in a PR
factory autostart install --agents haile,tewodros          # on each machine, with its own names
factory autostart status                                   # what is set up and what would start
factory resume --dry-run                                   # what a boot would do, now
```

**What happens at boot.** The service runs `factory resume`, which:

1. waits for Docker (when `commands.stackUp` is set), runs `commands.stackUp`, and waits until `commands.stackHealth`
   passes (if you set one). Wait times: `FACTORY_RESUME_WAIT` seconds, default 300.
2. waits for the network (`git ls-remote origin`), then starts each of this machine's agents in a **detached tmux
   session** named `<repo>-<agent>` (`tmux attach -t proj-haile` shows it; Remote Control is on, as in
   `factory loop -i`). Each runs `factory loop -i` as that one agent, in its own worktree. A session that is already
   running is left alone, so running `factory resume` again is safe.
3. starts an agent **only when its worktree's `.claude/factory/settings.json` resolves** (after `git submodule update
   --init`), so an agent never runs without the factory's hooks and deny rules (#46). If it does not, that agent is
   reported `NOT started` with the fix, and the others carry on.
4. in issues mode, if the agent still holds an in-progress issue, marks it working again on that issue, so the dev
   manager does not give it away.

**Unfinished work is protected.** Before an agent starts, a worktree with uncommitted changes or unpushed commits is
saved to `~/.local/state/<repo>-factory/backups/<agent>-<branch>-<time>/`: `changes.patch` (`git diff HEAD`),
`status.txt`, `unpushed.txt` and `untracked/` (small untracked files). The worktree itself is never reset, cleaned or
switched: the loop starts with `FACTORY_RESUME=1`, which skips its usual move to `origin/<main>` and its tidy for the
first task, and the agent's **first prompt** carries a note: it is resuming after an unexpected restart, on this
branch, with these files changed, backup here; continue your own in-progress issue or PR first.

**The boot report** is one line per component (stack, each agent, each backup) in
`~/.local/state/<repo>-factory/boot.log`, and in issues mode a comment on the first started agent's issue, so it is
visible remotely that the machine rebooted. `"autostartReport": false` in the machine file turns the comment off. A
GitHub failure is only a line in the log. `factory autostart status` prints the last boot's lines.

**This machine's settings** are in its own file (`factory machine show` prints where), never in the project:
`autostart` (true/false), `autostartAgents` (default: the names this machine runs, `factory machine setup`) and
`autostartReport`; `factory settings --local` lists and changes them with `agents` and `remoteControl`. `factory autostart install --agents ...` writes them; `uninstall` turns `autostart` off and removes
the service, and leaves running agents and the stack alone. Variables the agents need that a service does not have
(`SOPS_AGE_KEY_FILE` ...) go in `<config>/<repo>.env`, next to the machine file, as `KEY=value` lines.

| | Linux | macOS |
|---|---|---|
| Service | systemd user unit `<repo>-factory-resume.service` (`Type=oneshot`, `KillMode=process`, so the tmux sessions outlive it) | LaunchAgent `dev.software-factory.<repo>-resume` (`RunAtLoad`, `AbandonProcessGroup`) |
| Runs at | every boot, with **linger** on (`install` turns it on, or prints `sudo loginctl enable-linger <user>`) | every login of that user; use automatic login (or keep the Mac logged in) for a Mac that must come back alone |
| Also needs | tmux, a reachable `systemctl --user` | tmux |

Each agent's folder must have been opened in Claude Code once by hand (the folder-trust prompt cannot be answered
unattended). Test coverage uses fake `systemctl`, `launchctl`, `tmux` and `docker`; what systemd and launchd do at a
real boot is not tested.

<br>

Previous: [The factory command](commands.md) | Next: [Roles](roles.md)
