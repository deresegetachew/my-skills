# software-factory

You write down what you want built. AI coding agents build it, one small task at a time, while other agents review
their work and a dev manager merges what is good. You hear about it only when a decision is really yours.

That is the whole idea. This page explains how it works, why it is built this way, and how to run it.

The scope of the factory is written down in [`software-factory/docs/PRD.md`](docs/PRD.md). It is the source of truth:
when this page and the PRD disagree, the PRD wins.

<br>

## The idea in one picture

```mermaid
flowchart LR
    you(["You<br/>write the PRD,<br/>make the real decisions"])
    plan["The plan<br/>small tasks, each one<br/>a GitHub issue"]
    agent["Coding agent<br/>tests first,<br/>then the code"]
    review["Reviewers<br/>other agents check<br/>the work"]
    pr["Pull request"]
    ci["CI and the gate<br/>checks an agent<br/>cannot edit around"]
    dm["Dev manager<br/>reads, merges or<br/>sends it back"]
    main[("main")]

    you --> plan --> agent --> review --> pr --> ci --> dm --> main
    dm -. "only what is yours" .-> you
    dm -. "sends back with notes" .-> agent
```

Every box is a separate piece with one job. None of them marks its own homework.

<br>

## Why it is built this way

An AI agent is good at a small, clear job: "add this function, here is the test it must pass". It is bad at three
things that matter when a project gets bigger. It forgets between sessions. It is too kind to its own work. And it
doesn't know when to stop and ask. The factory is the process around the agent that covers those three gaps.

```mermaid
flowchart TB
    subgraph problem["What goes wrong with a lone agent"]
        p1["It forgets everything<br/>when the session ends"]
        p2["It says its own work<br/>is fine"]
        p3["It guesses instead of asking,<br/>or asks you everything"]
    end
    subgraph answer["What the factory does about it"]
        a1["The repo is the memory.<br/>PRD, plan, decisions and PR comments<br/>carry over. Every task starts fresh."]
        a2["Someone else checks.<br/>Reviewer agents, CI, then the dev manager.<br/>Rules live in hooks, not in good intentions."]
        a3["Questions go to the right place.<br/>Product questions to the product owner,<br/>review questions to the dev manager,<br/>only real decisions to you."]
    end
    p1 --> a1
    p2 --> a2
    p3 --> a3
```

Two more choices follow from this:

- **Tasks are small.** One task, one pull request, one thing to review. Small things are easy to check and easy to undo.
- **The shared rules are separate from your project.** Agents, skills and hooks come from the factory. Your project
  only says what is special about it: its commands, its protected files, its ports. That is `.claude/factory.json`.

<br>

## Who does what

Four roles. Three are Claude sessions you start with one command each. The fourth is you.

```mermaid
flowchart LR
    subgraph you_side["You"]
        owner(["Owner<br/>vision, the PRD, the hard calls"])
    end
    subgraph claude["Claude roles, each started with a factory command"]
        po["Product owner<br/>scope, order of work,<br/>what to test next"]
        dm["Dev manager<br/>reviews pull requests,<br/>answers agents' questions,<br/>keeps agents busy"]
        ca["Coding agents<br/>build one task at a time,<br/>as many as you want to run"]
    end
    owner <-->|"proposals and your yes"| po
    po -->|"tasks and the PRD"| ca
    ca -->|"pull requests"| dm
    dm -->|"merged work, or notes to fix"| ca
    dm -->|"only what needs you"| owner
```

| Role | Start it with | What it does |
|---|---|---|
| Coding agent | `factory loop -i` | Takes the next task, writes failing tests, builds it, asks the reviewers, opens one pull request |
| Dev manager | `factory dev-manager loop` | Reads each pull request, merges the good ones, sends the rest back with a clear note, answers questions |
| Product owner | `factory product-owner loop -i` | Keeps the PRD and the task list in order. Writes proposals; your yes comes as a reply |

The dev manager is a small program with no model of its own. It starts a short Claude session for each item, so a
quiet hour costs nothing.

<br>

## One task, start to finish

```mermaid
sequenceDiagram
    participant L as Loop
    participant A as Coding agent
    participant R as Reviewers
    participant G as PR gate hook
    participant H as GitHub
    participant D as Dev manager
    L->>H: claim the next task (fixes first)
    L->>A: start a fresh session on it
    A->>A: write failing tests, then the code
    A->>R: ask the reviewers
    R-->>A: pass, recorded for this exact commit
    A->>G: open the pull request
    G-->>A: allowed, because the reviewer passed this commit
    A->>H: pull request opened, CI runs
    alt CI green, nothing protected touched, no hold
        A->>H: merge it
    else Protected files, or a hold label
        A->>L: leave it open and finish
        D->>H: read it, then merge or send back
    end
    opt Dev manager sends it back
        D->>H: a must-fix note on that commit
        L->>A: next session fixes it before any new task
        A->>H: push the fix and reply
    end
```

A few things worth noticing:

- **Tests come first.** The failing test says what "done" means before any code exists.
- **A reviewer's pass belongs to one commit.** Change the code and the pass no longer counts.
- **Fixes jump the queue.** A pull request sent back is picked up before new work starts.
- **A session is short.** When the task ends the session ends, and the next one starts clean from `main`.

<br>

## What stops bad work

Nothing relies on an agent behaving well. There are four layers, and each one assumes the one before it missed
something.

```mermaid
flowchart TB
    start(["An agent finishes a change"])
    l1["1. Reviewer agents<br/>check the diff against the plan, the PRD and your rules"]
    l2["2. The PR gate hook<br/>blocks 'open the PR' or 'merge'<br/>until the reviewer passed this commit"]
    l3["3. The Factory guard in CI<br/>fails changes that weaken tests, skip them,<br/>or add a dependency unreviewed"]
    l4["4. Branch protection on main<br/>the lock GitHub holds,<br/>no agent can open it"]
    done(["Merged"])
    start --> l1 --> l2 --> l3 --> l4 --> done
```

Files that govern the agents themselves (the gate, the settings, the agent definitions) are on a protected list.
A change to them is never merged by the agent that wrote it. The dev manager or you merges it.

<br>

## Where the machines and GitHub meet

```mermaid
flowchart LR
    owner(["Owner"])

    subgraph machine["Your machines"]
        dm["Dev manager<br/>factory dev-manager loop"]
        loop["factory loop, loop -i<br/>or factory agent"]
        subgraph folders["One folder per agent"]
            a1["menelik<br/>the project folder"]
            a2["taytu<br/>project-agents/taytu"]
        end
        hooks["Hooks in every session<br/>start, before and after tools,<br/>stop, end"]
        subs["Subagents<br/>test-writer, reviewer,<br/>architecture-reviewer,<br/>safety-auditor, security-reviewer"]
        files[".claude/ in the project<br/>the factory's agents, skills,<br/>hooks and settings"]
    end

    subgraph github["GitHub"]
        issues["Task issues"]
        agentissues["Agent issues<br/>who is alive, who is doing what"]
        prs["Pull requests<br/>and marker comments"]
        ci["CI<br/>Factory guard, checks"]
        bp["Branch protection<br/>on main"]
    end

    release[("A factory release<br/>from the my-skills repo")]

    owner -->|"starts"| loop
    owner -->|"starts, or reaches through Remote Control"| dm
    loop -->|"a fresh Claude session per task"| folders
    folders --- hooks
    folders --- subs
    hooks -->|"read"| files
    release -->|"factory update, in a reviewed PR"| files
    folders -->|"claim, tick, open PRs"| issues
    hooks -->|"heartbeat"| agentissues
    folders -->|"push, open and merge PRs"| prs
    prs --> ci
    ci --> bp
    dm -->|"review, must-fix, approve, merge"| prs
    dm -->|"write tasks, sweep"| issues
    dm -->|"only what needs you"| owner
```

Each agent gets its own folder, so two agents never trip over each other's files. Waiting costs no tokens: a loop
that has nothing to do sleeps instead of asking a model.

<br>

## Where things stand

The factory is in alpha. The one release is `v0.1.0-alpha.1`, a pre-release, so you name it when you install
([Updating from releases](#updating-from-releases)).

Not built yet:

- A custom screen. The Claude app, Remote Control and the plain-text commands (`factory status`, `factory prs`,
  `factory agents ls`, `factory follow`) are the interface.
- `factory bootstrap` runs on Linux only.
- One command to bump the pin for a whole team.
- A Slack or Mattermost bridge. It is an idea, not scheduled (PRD, sections 5 and 6).

<br>

## Contents

- [Quick start](#quick-start)
- [Where things live](#where-things-live)
- [Updating from releases (`factory update`)](#updating-from-releases)
- [The `factory` command](#the-factory-command)
- [Agent loops](#agent-loops)
- [Roles: coding agent, dev manager, product owner](#roles)
- [Tasks](#tasks)
- [Live agents (issues mode)](#live-agents-issues-mode)
- [Messages between agents](#messages-between-agents)
- [Watch and talk to an agent: `factory follow`](#watch-and-talk-to-an-agent-factory-follow)
- [After a reboot: `factory autostart`](#after-a-reboot-factory-autostart)
- [Reviews and gates](#reviews-and-gates)
- [The dev manager](#the-dev-manager)
- [CI: GitHub's runners or your own Mac](#ci-githubs-runners-or-your-own-mac)
- [A shared build cache](#a-shared-build-cache)
- [A sandboxed machine: `factory bootstrap`](#a-sandboxed-machine-factory-bootstrap)
- [Security notes](#security-notes)
- [Style guides](#style-guides)
- [factory.json settings](#factoryjson-settings)
- [The files in the kit](#the-files-in-the-kit)
- [Appendix: projects that use the submodule](#appendix-projects-that-use-the-submodule)

<br>

<a id="set-up-a-project"></a>

## Quick start

You need a PRD first. The factory only builds what the PRD and the plan say. On the machine that runs the agents you
need git, bash, Python 3, Claude Code and the GitHub CLI (`gh`, signed in).

```mermaid
flowchart LR
    s1["1. Install<br/>from a release"] --> s2["2. Fill in<br/>the templates"] --> s3["3. Check<br/>your machine"] --> s4["4. Run one task"] --> s5["5. Start the<br/>other roles"]
```

### 1. Install the factory in the project

1. **Download and check the release.** From the [releases page](https://github.com/deresegetachew/my-skills/releases)
   take `software-factory-<version>.tar.gz` and `SHA256SUMS` into one folder outside the project, run
   `sha256sum -c SHA256SUMS`, and unpack the archive there.
2. **Install it.** In the project's folder, in a terminal of your own (an agent session is refused), on a clean tree:

   ```bash
   python3 <unpacked folder>/hooks/factory_release.py update v0.1.0-alpha.1
   ```

   The release client uses only the Python standard library, so it can install into a project that has no factory
   yet. It checks the archive's checksum, writes the shared files (`.claude/hooks`, `.claude/ci`, the agents, the
   skills, `settings.json`, `factory`, `factory-loop.sh`) as real files, writes the pin `.claude/factory/release.json`
   and, on a first install, adds the templates you fill in, never over a file that exists. It commits nothing.
   [What it does, step by step](#updating-from-releases).

### 2. Fill in the templates and merge

- `.claude/factory.json`: commands, paths, protected files, ports. `factory settings` is the guided way
  ([settings](#factoryjson-settings)), or ask Claude to "set up the software factory" (the `software-factory` skill
  walks through it).
- `CLAUDE.md`, from `CLAUDE.factory.md`: the project's rules.
- The tasks: `docs/build-plan.md`, or [GitHub issues](#issues-mode) (`factory issues setup` makes the labels once).
- `.github/workflows/ci.yml`: your stack's commands.
- For a project with no PRD scaffold yet, `factory init` adds the role folders, the labels, the owner queue, a starter
  PRD and the PRD-change PR template, and adds nothing twice ([From an idea to a first milestone](#from-an-idea-to-a-first-milestone)).

Commit it on a branch, open a PR and merge it. Then set up [branch protection](#branch-protection-the-real-lock) on
main.

### 3. Set up your machine, once

```bash
./factory install-shim              # puts a `factory` command in ~/.local/bin
factory doctor                      # what's missing on this machine, and how to fix it
```

### 4. Run the first task

- `factory next` shows the job the factory would hand out next. It claims nothing; its last line shows the command that
  does.
- `factory loop -i` starts a coding agent: a fresh session per task that you can watch and type into. `factory loop` is
  the unattended version. [Which one](#three-ways-to-run-an-agent).
- The agent writes failing tests, builds, asks the reviewers and opens one pull request with `Closes #<n>`.
  [How a task is picked](#tasks).

### 5. Start the other roles

Every role is a factory command ([Roles](#roles)). The table above lists them. `factory loop -i` in a terminal with no
role asks which role and which name. From the Claude app, reach a running session through Remote Control; there is no
web console.

### Where to read next

- [The `factory` command](#the-factory-command): every command, in one table.
- [factory.json settings](#factoryjson-settings): every setting, with its default.
- [`docs/PRD.md`](docs/PRD.md): what is in scope, what is decided, and what is later.

<br>

## Where things live

The factory's code sits in plain folders of `software-factory/` (#112): `hooks/`, `ci/`, `factory` and `factory-loop.sh`. `kit/` holds only what a project is given.

```
software-factory/
  factory                       the command line
  factory-loop.sh               the loop behind `factory loop`
  install.sh                    puts the factory into a project (links, or copies)
  VERSION                       the release number (a `vX.Y.Z` tag must match it)
  hooks/                        every hook and every `factory_*.py` command, next_task.py, pr-gate.py, check.py ...
  ci/                           `factory ci`: ci.sh, the compose files, the runner image, entrypoint.sh
  tests/                        the tests (run with tools/run_tests.py at the repo root)
  docs/                         reference pages (PRD.md, messages.md, manager-handover.md)
  kit/                          what a project is given:
    .claude/agents, skills, manager/, settings.json       Claude Code reads these from the project's .claude/
    .claude/factory.json, factory/notes/, CLAUDE.factory.md, docs/, .github/, .gitignore     templates, copied once
    factory, factory-loop.sh, .claude/hooks/*, .claude/ci/*     symlink forwarders to the real files above
```

The `kit/` forwarders exist only so a project that links through `kit/` keeps working until it switches. A release
archive stores them as plain copies, which the client does not install. Nothing new is added to them.

**What a project sees stays the same.** Claude Code reads agents, skills and `settings.json` from the project's
`.claude/`, so the project still has `.claude/hooks/`, `.claude/ci/`, `.claude/agents/`, `.claude/skills/`,
`.claude/settings.json`, `factory` and `factory-loop.sh` at those paths. Only where they come from differs:

| The project takes the factory as | Those paths are | They change by |
|---|---|---|
| A release (`.claude/factory/release.json` exists) | real files, committed | `factory update` or `factory rollback`, then a reviewed pull request |
| The submodule, layout `new` | relative symlinks to `vendor/my-skills/software-factory/hooks/...`, `.../ci/...`, `.../factory` | the pin of `vendor/my-skills`, then `factory update` |
| The submodule, layout `old` | symlinks through `vendor/my-skills/software-factory/kit/...` (the forwarders): what every project had before the move | the same |

What stays the project's own in every case: `.claude/factory.json`, `.claude/factory/notes/`, `.claude/factory/lessons.md`,
`CLAUDE.md`, its docs, its CI workflow, and (on releases) the pin file.

**A project on the submodule switches to the `new` layout** in one reviewed pull request:

1. On a clean main, run `factory update --layout new` (it does the same as
   `bash vendor/my-skills/software-factory/install.sh . --link --layout new` after moving the submodule to my-skills'
   newest main). Each link is re-pointed from `kit/` to the new folder. The links keep their places in `.claude/`, so
   `settings.json` and the docs need no change. `--layout auto`, the default, leaves a project that links through
   `kit/` alone, so a plain `factory update` never switches one by surprise.
2. Check: `ls -l .claude/hooks` shows `.../software-factory/hooks/...`, and `factory doctor` is green.
3. Commit the changed links and open the pull request. `.claude/` is a protected path, so the dev manager or the owner
   merges it. A CI workflow, a `protected` list or a document that names `.claude/hooks/...` needs no change for this
   step, because those paths did not move.
4. On a machine that runs the CI runners, `factory update` reinstalls them when their copies are older; if you did not
   run it, run `factory ci install` once.

A project that moves to releases instead needs no `--layout`: `factory update --release` installs real files. It
refuses where the files are still links into the submodule, so take the submodule step out first, in its own pull
request (see [Updating from releases](#updating-from-releases)).

**The nestjs skills are not in the release.** `nestjs-best-practices` and `nestjs-clean-code-ddd-hexagonal` are
top-level folders of my-skills, outside `software-factory/`, and a release ships only `software-factory/`. A project
that uses them (remanual) keeps `vendor/my-skills` as a submodule after it moves to releases, for these things only:
its `.claude/skills/nestjs-*` links, the `check` command in `.claude/factory.json` that runs
`vendor/my-skills/nestjs-clean-code-ddd-hexagonal/scripts/check_structure.py`, and `submodules: true` on the
`actions/checkout` steps in its `ci.yml`. Keep them; the factory itself (hooks, CI, agents, `factory`) comes from the
release. A project that does not use the nestjs skills drops the submodule entirely.

**What is left of the move** (#112):

- The first release exists: `v0.1.0-alpha.1`, a pre-release (see [Updating from releases](#updating-from-releases)). Cutting
  a release stays the owner's call.
- Remanual, the first project, then relinks or moves to releases in its own reviewed pull request. That changes
  protected files in that repo, so it is the owner's merge.
- After remanual has merged, the `kit/` forwarders are removed from my-skills in a pull request of their own, and the
  `--layout old` and `auto` handling in `install.sh` can go with them.

<br>

## Updating from releases

A project on releases has the factory as plain files committed in its repo (`.claude/hooks/`, `.claude/ci/`, `factory`,
`factory-loop.sh`, and the agents, skills and `settings.json` in `.claude/`), plus one file that says which release they
are: `.claude/factory/release.json`, the **pin**. Updating is a normal reviewed diff. For the common case you need one
command:

```
factory update          # newest release: download, check, install, refresh this machine, verify
```

| Want | Command |
|---|---|
| See where I am | `factory version`: installed release, the one `origin/main` pins, the newest, and what changed since |
| See what exists | `factory releases` (`--all` for the old ones): tag, date, one-line note, and where you are |
| Update to the newest | `factory update`: the newest full release. A pre-release is used only when you name it |
| Use a specific release | `factory update v1.4.0` (the `v` is optional; it can be older, too; a pre-release such as `v0.1.0-alpha.1` is taken this way) |
| Go back | `factory rollback`: the release installed before, from this machine's download cache, no network needed |
| Catch up after a pull | `factory update` again: the files came with the pull, so it only refreshes this machine's runner services and verifies |

**`factory update` and `factory rollback` refuse inside the factory's own repository** (my-skills, found by
`software-factory/VERSION` and `tools/build_release.py` at the root) with `[factory_repo]`, before anything else and
without changing a file. The `.claude/` entries there are links into `software-factory/`, and the releases come from
that repo. The fix: edit the real files in `software-factory/`, then cut a release with `tools/build_release.py`. Every
other project is unaffected.

`factory update` does this, in order, and stops at the first problem with `[code] message` and `Fix: ...`:

1. Refuses a dirty working tree (it names the files; it stashes nothing). The only dirty tree it accepts is one that
   holds just a previous `factory update` you have not committed yet, so running it twice is safe.
2. Finds the release, downloads the archive and `SHA256SUMS` from GitHub, and checks the archive's SHA-256. A mismatch
   installs nothing and leaves nothing in the cache. A transfer that stops part way does the same.
3. Unpacks in memory with every path checked (nothing outside the archive's own folder, no links, no duplicate or
   unlisted file) and checks every file against the archive's `MANIFEST.json`.
4. Writes the files into the project, undoing everything if a write fails, removes files the new release dropped, and
   writes the pin. On a project's first release it also adds the templates it does not have (`factory.json`, docs,
   `.gitignore` lines), never over an existing file.
5. Refreshes this machine: if CI runner services are installed here and older than the files (`factory ci stale`), it
   runs `factory ci install`, which also rebuilds the runner image. If the heartbeat daemon is installed here it is
   restarted too (`factory heartbeat restart`), because it is one long process that would otherwise keep running the
   old code.
6. Verifies: every file matches the pin; every hook named in `settings.json` exists; the Python and shell scripts parse;
   and the installed runner files are readable by the runner container's user, not writable by others, and match the
   checkout (`factory ci check`, which, when Docker and the runner image are on the machine, also starts the installed
   entrypoint in the image as the container's own user and parses it). If any of that fails it exits 1, names each problem and does not say it worked.
   `factory doctor` runs the same checks.
7. Prints what changed (old to new, with the release notes' commit titles) and the commands to commit it. **It never
   commits, pushes or makes a branch**: you commit the diff in a pull request, and everyone else gets it by pulling and
   running `factory update`. Agent sessions cannot run it (the PR gate reads these files).

Where things live: downloads are cached in `~/.cache/software-factory/<repo>/<tag>/` (`FACTORY_CACHE_DIR` moves it).
`release.repo` in `factory.json` names the repository whose releases are used (default `deresegetachew/my-skills`);
`GH_TOKEN` is sent if set (rate limits, private forks). A rollback checks the cached archive against the checksum the
pin recorded, so a replaced cache is refused.

**A project that has no pin keeps working as before.** `factory update` without a pin runs the submodule update
described [below](#updating-the-factory) until the project migrates. `factory update --release` (or naming a version)
starts taking releases in a project whose factory files are plain copies; it refuses, and changes nothing, where the
files are links into the submodule. Moving a project off the submodule is its own reviewed pull request.

**Which releases exist.** One so far: `v0.1.0-alpha.1`, a pre-release, built from the commit that bumped
`software-factory/VERSION` to `0.1.0-alpha.1` (#184). A tag with a hyphen is published as a pre-release. Until a full
release such as `v0.1.0` exists, `factory update` with no version stops with `[no_releases]` and says to name a
pre-release: `factory update v0.1.0-alpha.1`. `factory releases` lists what exists.

**Cutting a release** (the owner): bump `software-factory/VERSION` in a merged PR, tag that commit `vX.Y.Z` on main and
push the tag. `.github/workflows/release.yml` checks the tag, runs the tests, builds the archive with
`tools/build_release.py`, and publishes it with `SHA256SUMS` and notes. Agents never publish a release or push a tag.

## The `factory` command

Run it from any folder inside the project or an agent worktree. `./factory install-shim` puts a small `factory`
command on your PATH that runs the `./factory` of whichever project you're in, so each project uses the factory
version it pins. `factory help` lists everything.

| Command | What it does |
|---|---|
| `factory loop [N]` | Starts an agent loop: one fresh, unattended Claude run per task (`claude -p`). `N` caps the number of tasks. Run it again in another terminal for another agent |
| `factory loop -i [N]` | The same, but each task opens a normal session you can watch and type into. It closes by itself when the task is done |
| `factory coding-agent\|dev-manager\|product-owner [name\|N] loop [-i] [--once] [--dry-run]` | The three roles, started the same way and run by the same loop. `factory loop` is `factory coding-agent loop`. [Roles](#roles) |
| `factory prd [--open] [--story N] [--json]` | Progress against the PRD from GitHub: per user story its tasks and state. [Product owner](#the-product-owner-factory-prd-and-the-sign-off-and-testing-queue) |
| `factory artifacts pull\|status\|list` | The project's artifacts and designs as reviewed copies in the repo, with a manifest; `status` says which copy is older than its artifact. [Artifacts](#artifacts-and-designs-factory-artifacts) |
| `factory signoff ls\|add\|plan\|confirm\|result` | The sign-off and testing queue: what only a person can check, and test plans for the running app |
| `factory init [--dry-run]` | The project's scaffold after `install.sh`: role folders, labels, the owner queue, a starter PRD and the PRD-change PR template; adds nothing twice (see [From an idea to a first milestone](#from-an-idea-to-a-first-milestone)) |
| `factory prd --stage [--ask vision\|design\|plan]` | Where the project is on the way to a first milestone, and the owner's gates |
| `factory init-roles [--force]` | Creates the project's role folder (`.claude/factory/roles/<role>/README.md` and `reads.md`) |
| `factory agent <name\|N>` | Opens Claude in that agent's folder (created the first time), with Remote Control on, for manual work there. To run the queue, use `factory loop -i` |
| `factory next` | Shows the job the factory would hand out next. It does not claim it: the last line says so and shows the command that does, `python3 .claude/hooks/next_task.py --claim <agent> --pid $$`. `next_task.py --claim <agent> --issue <n>` (issues mode) claims that one issue for the agent if it is free and its dependencies are done; a taken, blocked or missing issue is refused with `{code, message, fix}` and nothing changes. The dev manager uses it to hand a builder a named task |
| `factory rereview plan\|prompt\|record\|reply` | Incremental re-review (#70): `plan` says whether a reviewer's next round is a delta or a full review and why; `prompt` prints its instructions (the delta, its earlier findings, the agent's reply); `record` stores a round's result; `reply` stores the agent's answer to it. `--kind` is reviewer, arch, safety or security |
| `factory manager-claims list\|next\|review\|answer\|release\|sweep\|merge\|ask` | Several dev managers at once (#99): claim a PR or a question with a lease so two managers never do the same one, and see who holds what. See [Several managers at once](#several-managers-at-once) |
| `factory lessons [show\|check\|suggest\|add\|prune]` | The curated lessons file (#72): `show` prints it (the builder and the reviewers read it first), `check` keeps it under `lessonsCap`, `suggest` proposes lessons from recent must-fix comments, review findings and CI failures, `add` and `prune` change it (dev manager only) |
| `factory status [--json]` | The whole factory at a glance, across machines, read-only: agents from their agent issues (working, idle, silent, down), this machine's claims, open PRs (draft, CI, the reviewer's pass when the marker is on this machine, hold, the dev manager's must-fix or approval by the gate's rule, so an approval of an older commit or from a login not in main's `trustedReviewers` shows as stale or not at all, "a person merges this one"), the CI queue and runners, and the tasks (ready by milestone, in progress, in review, blocked; plan mode: the next task). A section GitHub can't answer says so |
| `factory prs [--json] [--since-days N]` | The one list a dev manager starts a pass from, read-only and REST only: every open PR with its head and age, labels, CI judged by one rule, the newest marker per commit, any review claim and a next action (`review`, `merge`, `wait CI`, `rerun flake`, `waiting for agent`, `owner merges (protected)`, `held by <manager>`, `none`); below them the unanswered questions, owner asks and quiet agents. [Details and the `--json` schema](#the-list-a-manager-starts-from-factory-prs) |
| `factory machine [show\|setup <names>]` | This machine's id and agent names; `setup` writes the names file and refuses a name another machine has live |
| `factory autostart [status\|install\|uninstall]` | Makes this machine bring the factory back after a reboot: the dev stack and its agents, with unfinished work saved and left in place. `status` shows what would start; `install --agents haile,tewodros` turns it on and installs the boot service (systemd user unit with linger, or a LaunchAgent). [Details](#after-a-reboot-factory-autostart) |
| `factory resume [--dry-run]` | What autostart runs at boot: waits for Docker and the network, runs `commands.stackUp`, starts this machine's agents in detached tmux sessions. Safe to run by hand: running agents are left alone |
| `factory claims` | Which agent holds which folder and task on this clone (live or stale) |
| `factory reviews` | Which extra reviews and checks the current change needs |
| `factory env [name\|N]` | The ports and database of this folder, or of that agent |
| `factory worktree <name\|N>` | Prints that agent's folder (creates it the first time): `cd "$(factory worktree taytu)"` |
| `factory follow [<agent>]`, `say`, `remote` | Watch and talk to an agent by name, on another machine or in the cloud: the list shows where each agent and sub-manager runs, its state and its Remote Control link; `follow <agent>` attaches (`--read` to watch only), `say <agent> "text"` types one line, `remote add <name> <user@host>` says how to reach a machine. [Details](#watch-and-talk-to-an-agent-factory-follow) |
| `factory agents ls [--json] [--local] [--fresh]` | Every agent in one table: kind, where it runs, state (working, waiting, idle, down), task, since, last seen, how to follow it. [Details](#the-heartbeat-daemon) |
| `factory agents [list\|card\|sweep]` | Issues mode: who is working, idle or down. `list --json` and `card <name>` give each agent's card. `sweep` marks silent agents down and releases their issues, but never those of an agent that is alive and waiting |
| `factory heartbeat [status\|install\|uninstall\|restart\|once\|run]` | The per-machine daemon that knows what each agent here is really doing. [Details](#the-heartbeat-daemon) |
| `factory messages [ls\|new]` | Questions, answers and status between agents, the dev manager and the PO. `ls [--to X] [--state S] [--ref N]` lists the open ones across issues and PRs; `new --kind question --to po` prints the envelope to paste into a comment. [Details](#messages-between-agents) |
| `factory issues [cmd]` | Issues mode: `list` (default), `show N` (the issue text, then the people's comments; factory marker comments are left out), `peek`, `new`, `tick`, `review`, `block`, `release`, `stale`, `setup`. `review N` prints one line, such as `#7 is in review: added factory:in-review, removed factory:in-progress.` (or `#7 was already in review: nothing changed.`) |
| `factory report [--since D]` | Per task PR, from GitHub: claim to PR to merge in hours, rework rounds, CI runs and failures; medians for the merged ones. [Measuring it](#measuring-it) |
| `factory usage` | Tokens per task (or `--by agent`, `--by model`, `--by role`: manager sessions against builder ones) from this machine's Claude Code logs; `--record "label"` appends a row to the usage log. [Measuring it](#measuring-it) |
| `factory settings` | The interactive menu (in a terminal): browse by section, `/` to search, `?` for the long help of a setting, change, reset, review the diff and save (write the file, or open a pull request). In a pipe it prints the list. Non-interactively: `list [--section S] [--json]`, `get`, `set`, `unset`, `help [<key>]`, `diff`, `validate`, `pr`; `--local` is the same for this machine's own settings. Agents can't change settings. [Details](#factoryjson-settings) |
| `factory verify` | Runs what CI runs (`commands.ci`) for the current commit and records a pass; a ready PR needs it when `commands.ci` is set. [Details](#the-pr-gate) |
| `factory fix` | Formats and auto-fixes the files this branch changed (`commands.fix`); the Stop check and `factory verify` run it first, so style never costs a turn |
| `factory run-check <command>` | Runs a check or test quietly: one line if it passes; if it fails, the first errors (capped by `checkOutputLines`) and the path of the full log |
| `factory check` | Runs the style checks CI runs (`styles[].check`) |
| `factory guard` | Runs the Factory guard on the current branch against `origin/<main>` (without labels) |
| `factory bootstrap machine\|project\|all\|status\|uninstall` | Set up a sandboxed factory machine: the dedicated user, rootless Docker and the network guard. The plan is printed first; `--apply` (as root) runs the privileged steps, `--script FILE` writes them as a bash script. Ends with `factory doctor --sandbox`. [Details](#a-sandboxed-machine-factory-bootstrap) |
| `factory doctor` | Checks this machine and project and prints `ok`, `fix` (with the fix) or `note` per line: git, Python, Claude Code, GitHub access (a real `gh api user` call; `gh auth status` failing alone is only a note), Node against `.nvmrc` and the `packageManager` (when there's a `package.json`), Docker and whether it's rootless (when there's a compose file), the submodules, `.claude/settings.json`, on a project with a release pin the same checks `factory update` ends with, `.env.local`, sops and `SOPS_AGE_KEY_FILE` (when there's a `.sops.yaml`; it never decrypts or prints a secret), the shim and `FACTORY_AGENTS`, and autostart (tmux, the boot service, linger). and the shared build cache when `turbo.api` is set (a note when it can't be reached; it never runs `turbo.secretsCommand`). Read-only; exits 1 when something needs fixing. `--sandbox` adds the checks of a bootstrapped machine |
| `factory release <agent>` | Drops an agent's local claims, for example after a crash. Prints one line, such as `Released taytu: the checkout and the task claim issue-5.`, or `Nothing to release: haile holds no checkout or task claim.` |
| `factory clean` | Removes agent worktrees no live agent uses and that have no uncommitted work, and local task branches whose task is done |
| `factory wait <pr> [minutes]` | Waits for a PR to merge (default 30 minutes), polling GitHub once a minute, without spending tokens |
| `factory wait ci <pr>` / `answer <pr>` / `slot` / `ready` `[minutes]` | The other waits, also without tokens: until CI on the PR's head commit has finished, until its `factory-question` comments have a later `factory-answer`, until fewer than `maxOpenPRs` of your PRs are open, until a task is ready. [Waiting](#waiting-without-tokens) |
| `factory precheck` | For the dev manager: prints `nothing to do` (exit 0), or one line per PR with an unreviewed commit, unanswered question or quiet agent (exit 3). Reads GitHub only |
| `factory watch [--json]` | For the dev manager: the seven checks (unreviewed head, open question, must-fix or red CI or conflict, approved and green, owner waits, agents down or idle, queued CI), one line each with who it is for (manager or owner); exit 3 when any, no model. [The orchestrator starts from it](#run-a-manager) |
| `factory handover snapshot [--json]` | What a manager hands over, read from GitHub: open PRs, tasks, owner asks, what needs a manager now, agents and numbers in use. The runbook is [docs/manager-handover.md](docs/manager-handover.md) |
| `factory manage-tick [--dry-run]` | One dev manager tick without a model when idle: runs the precheck, prints `nothing to do` and ends (no model call) or, when it lists work, starts one `claude -p "/manage-pass"` on the manager profile with the `models.manager` flags. Run it from cron, launchd or a systemd timer. `--dry-run` prints the command and starts nothing |
| `factory version` | The installed release, the one `origin/main` pins, the newest, and what changed since. [Releases](#updating-from-releases) |
| `factory releases [--all]` | The releases that exist, with dates and a one-line note |
| `factory update [version]` | A project on releases: installs the newest full release (or the one you name, a pre-release too), checks its checksum, refreshes this machine's runner services, verifies, and leaves the diff for you to commit. Safe to run twice. `--release` starts taking releases in a project that has no pin yet. Without a pin it is the submodule update below. Refused inside my-skills itself (`[factory_repo]`) and in an agent session |
| `factory rollback` | Back to the release installed before (offline, from the download cache), refreshed and verified the same way. Refused inside my-skills itself, like `update` |
| `factory update [--layout new]` (no pin) | A project still on the submodule: takes the newest my-skills and relinks (`--layout new` points the links at the factory's own folders). [Then commit it in a PR](#updating-the-factory) |
| `factory install-shim` | Installs the `factory` command in `~/.local/bin` |
| `factory ci status` | Where CI runs (local or github), the latest runs on main and open PRs, and the local runner. [CI](#ci-githubs-runners-or-your-own-mac) |
| `factory ci use local\|github` | Sends CI jobs to the self-hosted runners with the project's label, or back to GitHub's |
| `factory ci install` / `uninstall [i]` | Installs `ci.runners` heavy runners and the light lane (again to update or change the number), or removes them (or one: `2`, `light`): LaunchAgents on macOS, systemd `--user` services on Linux. [Lanes](#ci-lanes) · [Linux](#ci-on-linux) |
| `factory ci stale` / `check` | Are the installed runner copies older than the checkout (exit 3, a line per file), and are they fit to start (readable by the container's user, not writable by others). `factory update` runs both |
| `factory ci start` / `stop` | Runs the runner once by hand, in the background, until `stop` or a restart |
| `factory ci logs [i] [-f]` | A runner's log: instance 1, or `2`, `light` ... |
| `factory turbo status` | The shared Turborepo build cache: what is set, where the token comes from (never the token), and whether the cache answers. [Details](#a-shared-build-cache) |
| `factory turbo install [--no-github]` | Starts the cache server on this machine (Docker, restarts with it) and gives CI the same cache through repository variables and secrets. Run it again to update. `--no-github` leaves the repository alone |
| `factory turbo down [--purge]` | Stops the cache server; `--purge` also removes the stored artifacts |

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
- **A model per role** (`models` in `.claude/factory.json`, below), so two machines never run different builder
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
`python3 .claude/hooks/factory_models.py flags manager` prints the same arguments for the manager's session.
`factory doctor` prints the effective model per role and what set it. The environment variable
`CLAUDE_CODE_SUBAGENT_MODEL` is not used: on its own the agent file's `model:` wins, and with `..._FORCE=1` it
forces one model on every subagent. `escalateTo` is the model the next-task skill asks the reviewer again on after a must-fix or an item it marked unsure
(`python3 .claude/hooks/factory_models.py escalate` prints it; `opus` when unset).

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
| 4 | `ci`: GitHub never started the jobs (billing); see `factory_ci.py` |

`factory wait <pr>` is unchanged. Agents and the dev manager never poll inside the conversation (`next-task` and
[DEV-MANAGER.md](DEV-MANAGER.md) say so). A manager pass starts with `factory precheck` and ends there when it
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

<br>

<a id="roles"></a>

## Roles: coding agent, dev manager, product owner

Every role is a factory command you run in a terminal, on any machine, several of each, with a fresh and small session
per pass (#95, #102):

```
factory coding-agent  [name|N] loop [-i] [--once] [--dry-run] [N]     (today's `factory loop`, which stays)
factory dev-manager   [name|N] loop [-i] [--once] [--dry-run]
factory product-owner [name|N] loop [-i] [--once] [--dry-run]
```

`name` is one of the role's names (`agents` for coding agents, `roles.dev-manager.names`,
`roles.product-owner.names`); a number means that position in the list (`factory dev-manager 2 loop` is the second).
Without a name the loop takes the first one no live loop holds. `--once` runs one pass and exits. `--dry-run` reads
GitHub, prints what a pass would do and starts, claims, registers and writes nothing. `-i` opens a session you can
type into, with Remote Control (the Claude app on your phone is the screen).

**One runner.** `factory-loop.sh` runs all three. What is shared is written once: tidy the folder to main, reload when
main brings a new script, the isolated MCP config, register and ping as a live agent (the agent issue carries the
role), the stop rule (the same item three times, or three failed passes in a row), interactive mode, and the wait
between passes. What differs is small:

| | coding agent | dev manager | product owner |
|---|---|---|---|
| Skill a pass runs | `/next-task` | `/manage-pass <item>`, started by the orchestrator once per item | `/product-pass` |
| Has work when | a task is ready (it claims it) | `factory watch` lists something (the orchestrator, no model) | an issue or PR has `roles.product-owner.workLabel`, an owner-queue ask is tagged `for=product`, or a test plan or sign-off item waits |
| Settings | the project's `settings.json` | `roles.dev-manager.profile` | `roles.product-owner.profile` |
| Model | `models.builder` | `models.manager` | `models.product-owner` |
| Wait after a pass | `waitMinutes` (inside the loop) | `manager.busyMinutes` (2) / `manager.idleMinutes` (5) | `roles.product-owner.busyMinutes` (30) / `idleMinutes` (60); 0 idle: exit |

Only the coding agent claims a task. Managers and product owners register as live agents (`factory agents` shows the
role) and keep pinging while they wait, so the sweep does not take a sleeping manager for a dead one. A role's profile
is used only when its file exists; then its sessions read just the user's settings and the profile (the project's own
`settings.json` denies `gh api`, which the manager and product owner need).

**`factory loop -i` with no role asks.** In a terminal it asks which role (coding agent, dev manager, product owner)
and which name (a free one, or type one). `factory loop -i dev-manager` or `FACTORY_ROLE=dev-manager` skips the
question. An unattended `factory loop` (no `-i`, no terminal, scripts, `factory autostart`) never asks and stays a
coding agent, so nothing running today changes.

**Identity.** All roles share one GitHub account. A marker or claim names the role and name inside its body
(`manager=<name>`), and `trustedReviewers` cannot tell roles apart; do not rely on it for that. `factory usage --by
role` separates the sessions: each pass ends with `<!-- factory-role role=... name=... -->`, and a session without it
is a coding agent's.

### The product owner: `factory prd` and the sign-off and testing queue

The product owner is the role for what needs the owner's yes: scope, order, the PRD, wording a customer reads, and what
to test. `factory product-owner loop -i` is the main way in: a session the owner talks to ("chat with the PRD") with the
PRD, designs and queues loaded through its `reads.md`. Unattended, a pass only **triages**: it writes proposals and a
digest, and decides nothing. The `product-pass` skill holds the standing rules; the project's `README.md` and `reads.md`
in `<roles.dir>/product-owner/` hold the product's voice, what the owner decides alone, and where the PRD and designs are.
There is no custom UI: the owner reads progress and queues as plain text, below.

**What gives the role work** (`factory_roles.py work product-owner`, one line each): an open issue or PR with
`roles.product-owner.workLabel`; an owner-queue ask tagged `for=product` that nobody has answered; a test plan that waits
for the owner or for a run; sign-off items. `factory product-owner loop --once --dry-run` prints where the role reads, then
that list, and the command it would run. It writes nothing.

**Asks for the product owner.** The dev manager writes scope, order and PRD questions to the owner queue as
`<!-- factory-owner-ask id=<slug> for=product -->`. The product owner replies under it with a proposal (the options and a
recommendation); the owner's yes comes in a reply there. Asks without the tag stay with the owner.

**`factory prd [--open] [--story N] [--json]`** shows progress against the PRD, computed from GitHub. A story's id is `US-<n>`
at the start of its heading or list item in the PRD file (`prd` in `factory.json`). A task issue says which stories it serves
with one line, `PRD: US-3, US-5` (the task template has it). Per story it prints the state (done, in progress, planned, no
task) and the tasks, then how many stories and tasks are done. It reports a story number two stories share (a task cannot say
which it means) and tasks that name a story the PRD does not have. A task closed as "not planned" counts for nothing.

```
docs/PRD.md: 5 stories: 1 done, 1 in progress, 1 planned, 2 with no task. Tasks: 2 of 4 done.

US-1   done         2/2   Upload a manual
US-2   in progress  0/1   Review the draft guide
        #12 in progress
```

**`factory signoff`** is the sign-off and testing queue: one issue, "Sign-off and testing queue" (pin it), made on first use,
with one comment per item. The state is read from the comments after the item, so nothing is edited.

| Command | What it does |
|---|---|
| `factory signoff ls [--all] [--json]` | Open items (all with `--all`), one line each |
| `factory signoff add <id> --task N --check "..."` | A task's "Done when" needs a person: say how they check it |
| `factory signoff plan <id> [--task N] (--file F \| --text T)` | A test plan for the running app. It is *proposed*; a revised plan has to be confirmed again |
| `factory signoff confirm <id> [--by NAME]` | The owner says this is what gets tested |
| `factory signoff result <id> pass\|fail\|blocked [--note T] [--build REF]` | Record a result. A plan takes one only once it is confirmed; the command refuses otherwise |

The product owner writes the plans from the PRD story and its "Done when"; someone else sets the app up; the owner confirms
what is tested; results are recorded with who and which build. **How a plan is run is not decided** (a scripted browser,
or Claude driving a browser: needs a spike). This part keeps the plans, confirmations and results, whichever produces them.
Markers: `factory-signoff`, `factory-signoff-result`, `factory-testplan`, `factory-testplan-confirm`, `factory-testresult`.

### From an idea to a first milestone

The flow the roles make possible, from an empty folder, using only their commands. Nothing lives in a chat session: every
hand-off is a file in the repository or an issue, pull request or comment on GitHub, so a role started on another machine
finds it.

| Stage | Who | Command, and what is committed | The owner's gate |
|---|---|---|---|
| 0 Start | Owner | `install.sh`, then `factory init`: role folders, labels, the owner queue issue, a starter PRD, the PRD-change PR template. Run again, it adds nothing | |
| 1 Vision | Product owner | `factory product-owner loop -i`: with nothing queued, `-i` starts a discovery session (`/product-pass discover`) that interviews the owner and writes `docs/PRD.md` with numbered stories | `factory prd --stage --ask vision` |
| 2 Design | Product owner | design references and the style file in `design/` | `--ask design` (only after the vision is approved) |
| 3 Plan | Product owner | milestones and task issues (`factory issues new`), each with `PRD: US-<n>` and a "Done when" | `--ask plan` (only after the design is approved) |
| 4 Hand over | Owner | `factory prd --stage` says when the three are approved and tasks are ready; then `factory dev-manager loop` and `factory coding-agent loop` | |
| 5, 6 Build, check, learn | Coding agents, dev manager, product owner | PRs and reviews, the sign-off and testing queue, `factory prd`, `factory usage --by role` | reviews as today |
| 7 Pivot | Product owner | a PRD-change pull request from `.github/PULL_REQUEST_TEMPLATE/prd-change.md` (stories, tasks that move, a decision record), and the task issues changed | the owner's yes on scope and order |

`factory prd --stage` prints the stages, what is done and what the owner has approved. An approval is the owner's reply under
the ask `stage-<name>` in the owner queue: a first word of yes, approved, ok or go ahead, or the marker `<!-- factory-owner-answer
id=stage-<name> -->`. Anything else is a question, the stage stays open and the product owner reads it. While the owner is away,
the stages wait: no role proceeds on its own at a gate. Errors are `{code, message, fix}`.

Tested end to end in `tests/test_flow.py` with fakes (a fake `claude` that runs the session's steps, a fake `gh`): init, the
three gates, the hand over, a pivot, and a role on a fresh clone. What it cannot test is the interview and the quality of the
PRD; the owner runs the flow once with a real model. Gaps: the dev manager's plan check (buildability, order, missing "Done when") is not built; and the design stage always
needs a file in `design/`, so a project with no UI adds a one-line `design/README.md` saying so.

### Artifacts and designs: `factory artifacts`

A project's artifacts (a PRD page, a design canvas, a design system, an illustration brief) are written where they are written.
**The repo holds the reviewed copy, and the roles read that**: a role's `reads.md` names the copy's path like any other
document (`- docs/artifacts/prd/index.html - the PRD as designed, a copy of an artifact`), and `factory doctor` checks the path
exists. This works on every machine, with no connector, and keeps a role's context small.

```
factory artifacts pull <url|id> [dest] [--from DIR] [--title T] [--version V] [--force] [--dry-run]
factory artifacts status [--json]      per copy: up to date, OLDER than its artifact, edited locally, missing, or can't tell
factory artifacts list
```

`pull` copies the artifact's published files into `dest` (default `<artifacts.dir>/<id>`, `docs/artifacts/<id>`) and records the
copy in the manifest `docs/artifacts.json` (`artifacts.manifest`): the artifact's url and id, title, version or updated time when
known, where the copy is, who pulled it and when, and a sha256 per file. Commit both in a pull request, like any change to the
project. A copy someone edited by hand is not overwritten without `--force`; a folder that holds other files is refused; a
destination outside the project is refused. Where the files come from:

- `artifacts.fetch`, a command that writes the artifact `{url}` into the folder `{out}`; or
- `--from DIR`, an export made by hand (the way to start today).

`artifacts.info` is a command that prints `{"title", "updated", "version"}` for `{url}`; with it `status` and `factory doctor` say
which copies are older than their artifact. Without it they say they can't tell. Both settings are empty by default.

**Spike (not done): can a terminal role read artifacts live?** The loop starts every role with `--strict-mcp-config`, an MCP
config taken from the project's `.mcp.json`, and `disableClaudeAiConnectors: true` (#55), so a role in a terminal has no claude.ai
connectors. Whether a Claude Code terminal session can list and read artifacts at all, with which tool, whether the isolation
blocks it, what it costs per turn, and whether a Design artifact's boards and comments can be read as files: **none of this has
been checked**. The check is small: in a plain terminal session on a development machine, with the owner's login, try to list and
read one artifact; then repeat under the loop's flags; write the finding in #104. Until then there is no per-role allowlist
(`roles.<role>.tools` / `roles.<role>.mcp`); layer 2 is built only if the spike says it is possible, default off, and a role
writing to an artifact would count as publishing (the owner's yes).

### The role folder

Each project has a folder for what its roles need, committed in the project's own repo (the kit stays here):

```
.claude/factory/roles/          (setting `roles.dir`)
  coding-agent/   README.md  reads.md
  dev-manager/    README.md  reads.md
  product-owner/  README.md  reads.md
```

- `README.md` is the project's own instructions for the role: what the factory's skill cannot know (known flaky
  tests, protected paths, numbering rules, who the owner is, the product's voice).
- `reads.md` lists the documents the role reads, one per line with a reason: `- docs/PRD.md#user-stories - the
  stories`. The role's skill reads this list first and nothing else up front, so a pass does not load the whole PRD
  or the repo's docs; a `#section` lets it `grep -n` for the part. The PRD, designs and research stay where they are
  (`docs/`, `design/`); `reads.md` only points at them.
- It lives under `.claude/` on purpose: the shared `settings.json` denies agents editing `.claude/**`, so the
  instructions that govern a role change only through a reviewed pull request.
- `install.sh` scaffolds it for a new project, `factory init-roles` for an existing one (it never overwrites), and
  `factory doctor` reports every path in a `reads.md` that does not exist.

**Migrating from `notes`.** The `notes` folder (`<notes>/reviewer.md`, `manager.md`, `next-task.md` ...) keeps working.
When a role has no folder, its pass is told to read `<notes>/manager.md` (dev manager), `<notes>/product-owner.md`
or `<notes>/next-task.md` instead. To move: run `factory init-roles`, copy the note's text into the role's
`README.md`, delete the note, and commit both in one PR. Remanual's `.claude/factory/notes/` needs no change.

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

### The heartbeat daemon

Pinging on tool use cannot tell an agent that is waiting in `factory wait` for 30 minutes from one that has died, and
it leaves a crashed machine's agents saying `working`. A small daemon, one per machine and project, asks the machine
instead. Every `tasks.heartbeatSeconds` (20) it checks, locally and for free, each agent that runs here: does a live
loop or Claude process hold its checkout (the claim), is a `factory wait` or `wait_for_merge.sh` running below it,
which tmux session and Remote Control link it has, and when it last produced output. From that it derives one state:

| State | Meaning |
|---|---|
| `working` | Alive and holds a task |
| `waiting` | Alive and deliberately blocked in a `factory wait` (a PR slot, CI, an answer, a merge) |
| `idle` | Alive, no task |
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
  agent issues, cached 45 seconds (`--fresh` asks again, `--local` never asks, `--json` for tools). The tmux session,
  folder, machine name and follow link reach GitHub only with `tasks.showWhere`, since agent issues are readable by
  anyone who can read the repo.
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
[docs/messages.md](docs/messages.md); GitHub stays the transport and the A2A adapter is a later step.

**Product questions (`to=po`, #110).** A builder asks a product question with `--to po` on its task issue and keeps working. The
product owner answers it (or asks back, or escalates it to the owner) and writes the answer into the task's "Done when". A question
nobody answers moves up a level every `roles.product-owner.escalateMinutes`: product owner, dev manager, owner; with no product
owner running it starts at the dev manager. Nobody answers for the product owner: `from=po` is refused, and with
`roles.product-owner.logins` set only those logins' answers count. The playbook is [PO.md](PO.md).

<br>

## Watch and talk to an agent: `factory follow`

An agent's **name** is the only handle. `factory follow haile` opens that agent's live session from your own terminal,
wherever it runs: on a factory machine you can ssh to, or in the cloud. There is no custom UI: the Claude app, through the
session's Remote Control link, is the other way in, and `factory follow` is how you find the link.

```sh
factory remote add dev-pc factory@192.168.2.45    # once: how to reach a machine (the sandbox user), kept on your side
factory follow                                    # every agent and sub-manager we can find: where, state, task, last ping, link
factory follow haile                              # attach: type, answer prompts, Esc to interrupt
factory follow haile --read                       # watch only (tmux attach -r): it cannot type
factory follow --all                              # one read-only pane per session, tiled, in a local tmux
factory follow haile --log                        # stream the output without a terminal (Ctrl-C stops)
factory say haile "check the failing test first"  # one message, as if typed, without attaching
factory agent haile --detach                      # on the factory machine: start the agent in a detached tmux session
factory remote cloud abebe https://claude.ai/code/session_...   # a cloud agent: follow prints its link
```

- **Remotes are only "how to reach a machine"**: a name and an ssh target, in this machine's own file (`factory machine
  show` prints where), never in the project and never on
  GitHub. Agent issues are readable by anyone who can read the repo, so where an agent runs stays on your side. There is
  no role field.
- **How a name is found.** `factory follow <agent>` asks every remote in parallel for its tmux sessions. A session belongs to
  an agent when it is called `<name>` or `<repo>-<name>` (what `factory agent --detach` and `factory autostart` start), so
  sessions started by hand work too. The names come from `agents` (and `roles.*.names`) in `factory.json`. If two remotes
  answer to one name, `follow` refuses and `--on <remote>` picks; unique names across machines is a setup rule.
- **Sub-managers.** The one-item sub-managers that the dev manager's orchestrator starts are tmux sessions called
  `<manager>-<item>` (`dev-manager-pr-42`, `manager-issue-7`): they are listed with the agents, with the manager and the item
  in the task column, and `factory follow dev-manager-pr-42` attaches to one.
- **The list** shows the session's state from the agent issue when `tasks.source` is `issues` (alive, silent, down, its task
  and last ping), otherwise `running`; the Remote Control link is read from the session's screen
  (`claude.ai/code/session_...`, it changes when the session restarts), so you can open the same session from the Claude app on a
  phone. A cloud agent has no machine: `follow` prints its link instead of attaching. A remote that cannot be reached is named,
  with the reason, and the others still list.
- **Detaching is safe**: `Ctrl-b d` detaches, and closing the terminal or losing the connection only detaches, so the agent
  keeps working. `Ctrl+C` is not detach: it interrupts Claude, and quitting Claude ends the session and drops the agent's
  claims (it then shows as silent in `factory agents`). Everyone attached sees one screen, shrunk to the smallest terminal: give
  extra viewers `--read`.
- **Safe by construction**: every ssh call uses keys only (`BatchMode`) and one shared connection per target
  (`ControlMaster`, so `follow` stays fast). A target where `sudo -n true` succeeds is refused: use the sandbox user that
  [`factory bootstrap`](#a-sandboxed-machine-factory-bootstrap) made, never an admin account. A remote name `root@` is refused when
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
3. starts an agent **only when its worktree's `.claude/settings.json` resolves** (after `git submodule update
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

## Reviews and gates

### The subagents

| Subagent | When | What it does |
|---|---|---|
| `test-writer` | Start of every task that adds behaviour | Writes failing tests from the "Done when" and the PRD. Never touches production code |
| `reviewer` | Every change, before the PR | Runs the checks and the guard, checks the task, the PRD and `CLAUDE.md`, and records a pass for the commit |
| `architecture-reviewer` | Changes on paths with a style guide (`styles`) | Reviews against the style-guide skills, runs their `check`, and records its own pass |
| `safety-auditor` | Changes on `reviews.safety-auditor.paths`, or anything touching the critical rules | Checks each critical rule still holds and is tested; writes a summary for whoever merges |
| `security-reviewer` | Changes on `reviews.security-reviewer.paths`, plus auth, payments, uploads, tenancy, secrets | Reports exploitable problems with file, line and fix |

**Models.** The test-writer, the architecture-reviewer and the reviewer's first pass run on Sonnet; the
safety-auditor and the security-reviewer run on Opus. A reviewer must-fix is fixed first, then the fixed commit is
reviewed on Opus; a diff over `prSizeWarn` lines or one on a `protected` path starts on Opus
([Saving tokens](#saving-tokens)).

`factory reviews` (`factory_reviews.py`) lists the extra reviews and checks a change needs, from `reviews`, `eval`,
`design` and `styles` in `factory.json`: for example `safety-auditor`, `security-reviewer`, `eval`, `design-check`,
`architecture-reviewer`. The `reviewer` is always needed and isn't listed. The next-task skill runs each listed one,
and the reviewer checks they ran.

**Review markers.** A pass is a file: the reviewer writes the commit id to `tmp/reviews/<branch>.ok`, the
architecture reviewer to `<branch>.arch.ok` (`reviewMarkers` sets the folder). A pass counts only for that exact
commit, so any new commit needs a new review.

**Incremental re-review.** After a review finds problems and the agent fixes them, the same reviewer should not read the
whole diff again. Each reviewer (`reviewer`, `arch`, `safety`, `security`) records its rounds with
`factory rereview record`: the commit it reviewed, pass or fail, a short findings summary, and the files and changed
lines of the branch diff at that moment, in `<reviewMarkers>/<branch>.reviews.json` (next to the markers, never in
them). The agent saves its answer with `factory rereview reply`. The reviewer's first step is `factory rereview prompt`,
which prints its instructions for this round:

- **delta:** `git diff <last reviewed commit>..HEAD`, the reviewer's own earlier findings and the agent's reply. It checks
  that each finding is fixed and that the new lines are fine, and does not re-read the rest of the branch diff;
- **full:** the whole branch diff, with the earlier findings listed for reference. This is the answer for a first round,
  and when the earlier commit is no longer in the branch's history (rebase or reset), the branch's base moved (main merged
  in), the change touches a file the earlier round never saw, the delta is more than `reReviewPercent` (default 30) percent
  of the branch diff's changed lines, or `reReviewPercent` is 0 (the old behaviour).

`factory rereview plan --kind reviewer` prints which it will be, and why, as JSON. The gate is unchanged: the pass marker
is still a file holding HEAD's id and nothing else, so the last round of every reviewer ends on the PR's head commit. A
round nobody recorded (another machine, a cleaned `tmp/`) simply gets a full review.

**Lessons (#72).** The same mistakes come back across tasks: the dev manager writes the same must-fix, a reviewer flags
the same problem, CI fails for the same reason. Each repeat costs a review round, a CI run and a fix session, so the
project keeps one short **lessons file** (`lessons` in `factory.json`, by default `.claude/factory/lessons.md`):

- **Short on purpose.** At most `lessonsCap` (40) lessons, one line each, each with an example or a link (a `code span`, a
  URL, `#123` or "e.g."): *packages/validators: annotate recursive helpers' return types (e.g. TS7022 in `schema.ts`)*.
  `factory lessons check` fails on a longer file, a wrapped lesson or one without an example, and CI runs it in the
  Factory guard job. Adding past the cap is refused until something is pruned.
- **Read up front.** The builder reads it at the start of a task (`next-task`, step 1) and the four reviewers read it
  before the diff; the `reviewer` treats a change that repeats a lesson as a must-fix and quotes the lesson.
  `factory lessons show` prints the lessons and nothing else, so reading it costs a few hundred tokens.
- **Fed from three sources.** `factory lessons suggest [--last 20] [--min 2]` reads the last N closed task pull
  requests from GitHub and lists causes that came back on at least `--min` of them: the dev manager's must-fix items
  (the list items of each `factory-mustfix` comment), CI failures (the job and step that failed, once per PR, from the
  failed runs on its branch, the data `factory report` counts), and this machine's reviewer findings from
  `<reviewMarkers>/*.reviews.json` (failing rounds; findings on other machines are not seen). Similar wording is grouped,
  and what an existing lesson already says is left out. It prints each candidate with its PRs and a ready
  `factory lessons add "..."` command, and changes nothing.
- **The dev manager approves.** Agents cannot edit `.claude/`, and `add` and `prune --apply` refuse inside an agent
  session (and are denied in `settings.json`); the dev manager runs them and merges the change in a pull request. An agent
  that learns something writes "lesson candidate: ..." in its PR description.
- **Pruned when enforced.** A lesson a hook, lint rule or check enforces now is dead weight. Tag it
  `[enforced: path/to/check]`; `factory lessons prune` lists the tagged lessons whose enforcement exists, `--apply` removes
  them, and `check` warns about a tag that points at nothing.
- **Measured.** `factory report --since <date>` counts must-fix rounds and failed CI runs per task (#65); fewer repeated
  rounds after a lesson is added is the test of the lesson.

### The PR gate

`pr-gate.py` is a PreToolUse hook. It reads every Bash command Claude runs, including compound ones (`;`, `&&`,
pipes, subshells), and blocks the pull-request commands that aren't ready:

| Command | Allowed only when |
|---|---|
| `gh pr create`, `gh pr new`, `gh pr ready` | The reviewer passed the current commit (and the architecture reviewer, on styled paths). When main's `factory.json` sets `commands.ci`, `factory verify` passed that commit too. Fewer than `maxOpenPRs` of your ready PRs are open. Plan mode: the task isn't ticked or blocked on main. Issues mode: the issue is open, not blocked, not held by another agent, and the body says `Closes #<n>`. Every new decision or migration file (`decisions`, `numberedDirs`) takes a number neither main nor another open PR has; the message names the next free one (`factory_numbers.py`). Drafts (`--draft`) skip all of this: they're how agents ask questions |
| `gh pr merge` | The PR is named by number or URL. It has no `factory-hold` label. The latest marker on it isn't a must-fix, and if it's an approval, it names the current head. The command has `--match-head-commit <head>`, so GitHub merges only the commit the gate checked. The reviewer passes (and the architecture reviewer's, on styled paths) are for that head. CI is green (`gh pr checks`); when the jobs never started (GitHub billing or the spending limit), the gate says that isn't a code result, so the agent doesn't push or re-run to chase it (`factory_ci.py`). No protected file changed (all files, past the first 100) |

It also blocks:

- more than one PR command, or a push and a merge, in one command;
- `gh` aliases and anything that isn't a known `gh` command;
- an agent posting the dev manager's markers (`factory-approved`, `factory-answer`, `factory-mustfix`) in a PR or issue
  comment, edit, review or close; `gh pr review --approve`; adding `tests-reviewed` or `deps-reviewed`; removing
  `factory-hold`.

**A local CI check before the PR** (`commands.ci`). Set it to what the CI job runs, scoped to what changed and
building dependent packages first, for example
`pnpm -s turbo run typecheck lint test build --filter=...[{base}]` (`{base}` becomes `origin/<main>`).
`factory verify` runs main's `commands.ci` (read from GitHub like the gate's rules, so a branch can't change or
miss it; the worktree's copy only when GitHub can't be reached, and it says so). It needs a clean working tree,
with no uncommitted changes and no untracked files that aren't ignored, and records the commit in
`<reviewMarkers>/<branch>.ci.ok`. The gate
then needs that mark for the PR's commit at `gh pr create` and `gh pr ready`, so a type error doesn't cost a CI round
trip and a new session. Drafts don't need it, nor does the merge (CI itself is green by then). Without `commands.ci`
on main, nothing changes.

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
| Stop: `check.py` | Won't let a turn end while typecheck or tests fail, when code under `codePaths` changed. Skips a rerun when nothing changed since the last green check |
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

A role you run in a terminal, on any machine, that runs the process the owner agreed (`factory dev-manager loop`, see
[Run a manager](#run-a-manager)). An orchestrator with no model watches GitHub and starts a one-item sub-manager (a
Claude session) for each thing that needs one. A sub-manager reviews a PR (protected ones included), merges, fixes small
leftovers, answers a question, sweeps dead agents, writes issues in issues mode, and tells you only what needs you. It
can't type into an agent's terminal. Its levers are PRs, comments, labels, the plan and the blocked list. Changing the
factory, the scope or its own rhythm needs your yes.

It talks to the agents through markers in PR comments:

| Marker | Written by | Meaning |
|---|---|---|
| `<!-- factory-question -->` | An agent | A decision it needs. It keeps working around it |
| `<!-- factory-answer -->` | Dev manager | The answer, or `needs-owner: ...` when it's yours |
| `<!-- factory-mustfix sha=<head> -->` | Dev manager | Must-fixes for that commit. Makes the PR rework and holds its merge |
| `<!-- factory-approved sha=<head> -->` | Dev manager | That commit is approved. Clears a must-fix for that commit only |
| `factory-hold` label | Dev manager | It's reviewing. Agents skip the PR and can't merge it |

### Several managers at once

Two or more managers (any machine) can work one repository without reviewing, answering, merging or asking the same
thing twice, and a manager that dies mid-review does not block a PR. The protocol is a few comments on GitHub, so it
needs no server. `factory manager-claims` (`hooks/factory_manager_claims.py`) implements it; every command needs the
manager's name, `--manager dm-1`.

| Marker | Written by | Meaning |
|---|---|---|
| `<!-- factory-review-claim manager=<name> sha=<head> until=<ISO time> -->` | A manager | "I am reviewing this head until then." A lease |
| `<!-- factory-answer-claim manager=<name> question=<comment id> until=<ISO time> -->` | A manager | The same for a `factory-question` |
| `<!-- factory-claim-release manager=<name> sha=<head> -->` (or `question=<id>`) | A manager | "I gave this up before the lease ran out" |
| `<!-- factory-owner-ask id=<slug> -->` | A manager | One ask on the owner-queue issue, "Dev manager: needs the owner" |

How a review is claimed (`factory manager-claims review <pr>`, or `next` for every free PR and question):

1. A PR whose head has no marker (`factory-approved`, `factory-mustfix`, `pr-watch`) and no unexpired claim by another
   manager is free. The manager posts a claim with `until` = now + `manager.claimMinutes` (default 20).
2. It re-reads the comments. The earliest unexpired claim for that head wins, in the order GitHub lists the comments.
   If it lost, it does nothing more (exit code 3) and moves on.
3. The winner puts `factory-hold` on, reviews, ends with the usual marker and takes the hold off
   (`factory manager-claims release <pr>`). A new head commit changes the sha, so the old claim means nothing.
4. If the manager dies, `until` passes. The next `next` (or `sweep`) takes `factory-hold` off a PR that has had a
   claim and has none running, and the PR can be claimed again. A hold on a PR nobody ever claimed is the owner's and
   is left alone. A lease never counts for more than two hours after its comment, whatever `until` says.

A question is claimed the same way (`answer <comment id>`); the `factory-answer` comment ends it. A claim is not an
answer: `factory wait answer` and `factory precheck` ignore `factory-answer-claim`.

`merge <pr>` merges only a head with `factory-approved sha=<head>` and passes that sha to GitHub, so a second
manager's merge of an already merged or changed PR is refused by GitHub. The command reads that refusal as "done by
someone else" (or "the head moved; it needs a new review") and exits 0, not as an error.

`ask --id <slug> --text "..."` posts an ask on the owner-queue issue (created if missing; pin it by hand, the REST API
cannot) only if no comment there carries that id. If two managers post at once, the earliest stays and the other
removes its own.

`factory manager-claims list [--json]` and `factory status` show every claim. `claimMinutes` is the setting
`manager.claimMinutes`. All managers and builders use one GitHub account, so the name lives inside the comment, and
`trustedReviewers` cannot tell managers apart: nothing here relies on it. Builders cannot post the claim markers
(PR gate) or run the command (`settings.json`).
**The standing rules are a skill, not a memory (#96).** `/manage-pass` (`kit/.claude/skills/manage-pass/SKILL.md`, linked into
a project like the other skills) holds everything a fresh session needs: the two-column table of what the manager does
alone and what it asks the owner first (the one copy; the playbook links to it), the pass order, the exact markers, the hold
label, the sha-pinned REST merge (`PUT .../pulls/<n>/merge` with `sha`), the CI rule, and the "never" list. The project's own
additions go in `<roles.dir>/dev-manager/README.md` (or, without a role folder, `<notes>/manager.md`); the skill says to
read them first. `claude -p "/manage-pass --dry-run"` reads, prints what it would do and writes nothing.

### Run a manager

```
factory dev-manager [name] loop            the orchestrator, unattended; keep it running (tmux, a VM, factory autostart)
factory dev-manager [name] loop --once     one cycle, then exit (cron or a systemd timer can run this)
factory dev-manager [name] loop --dry-run  read GitHub, print what a cycle would do, write nothing
factory dev-manager [name] loop -i         one item in a session you can type into, with Remote Control (cap 1)
factory watch [--json]                     the seven checks on their own: one line per item and who it is for
```

**The orchestrator has no model (#97).** `factory dev-manager loop` is a loop script. Each cycle it runs the seven checks
(`factory_watch.py`; `factory precheck` is its checks 1, 2 and the quiet agents and issues), reads labels and comments as
the only truth, and starts a fresh one-item sub-manager for each item that needs a manager: `claude -p "/manage-pass pr-417"`
on the manager settings profile, with the item's fact sheet and its thread note in the prompt. A sub-manager does its one item
and exits. The orchestrator never starts a builder, and it never merges or reviews itself.

| # | Check | Goes to | Fires when |
|---|---|---|---|
| 1 | an unreviewed head commit | a sub-manager | the PR has no verdict or `pr-watch` for its head, and the commit is older than `manager.quietMinutes` (5) |
| 2 | an open question | a sub-manager | a `factory-question` (or `factory-msg kind=question to=dev-manager`) has no later answer |
| 3 | must-fix, red CI, a conflict | a sub-manager | the head was reviewed and the problem is older than `manager.staleMinutes` (15) |
| 4 | approved and green | a sub-manager to merge; the owner if the manager opened the PR | the verdict names the head and CI is green by the manager's rule |
| 5 | an owner wait | the owner queue | a PR has had `roles.product-owner.workLabel` or `factory:needs-owner` for `manager.ownerWaitMinutes` (120) |
| 6 | agents | a sub-manager (silent agent); the owner queue (down, or idle) | a coding agent is silent, down, or idle for `manager.agentIdleMinutes` (45) while tasks are ready |
| 7 | queued CI | the owner queue | Actions runs queued for `manager.ciQueuedMinutes` (10), with "no runner online" when it can see that |

**Leases.** A sub-manager takes a lease on its item first (a comment: `factory-review-claim manager= sha= until=`,
`factory-answer-claim`, or `factory-item-claim`) and ends it when it exits. The earliest unexpired claim wins; a claim
that is not renewed expires after `manager.claimMinutes` (20). Two orchestrators (two machines) therefore never start the
same item. A new head is a new key. The cap is `manager.maxSubManagers` (2) sub-managers at once, counting the ones this
orchestrator started and the items other managers hold; the rest wait for the next cycle. `-i` runs one at a time.
`manager.subManagerMinutes` (30) stops a sub-manager that runs too long. The marker formats are the ones #99 defines;
`factory_lease.py` is the small module behind them, to be replaced by #99's.

**Thread notes.** The memory of a sub-manager is a comment on the task issue (on the PR when there is no issue):
`<!-- factory-manager-note thread=issue-20 status=open -->`. The orchestrator opens it when an issue gets
`factory:in-progress` and marks it `closed` when the issue closes, with no model. The sub-manager reads it from its prompt and
edits it (`PATCH .../issues/comments/<id>`) before it exits. It is a memory, not a source of truth.

**Telling the owner.** The channel is GitHub: one comment on the issue "Dev manager: needs the owner", mentioning
`manager.notify` (a login) or, when that is empty, the repository's owner if that is a person. GitHub's own notifications
reach the phone. An ask has an `id` and is posted once. Items for the owner: the queued CI, a down or idle agent, a PR
waiting on the product owner, the manager's own approved PR, and the dead-man's switch.

**The dead-man's switch.** If work that needs a manager has waited `manager.deadManMinutes` (30) and no dev manager has
acted in that time (a verdict, an answer, a watch, an owner ask, a merge, or a "working" ping; taking a lease does not
count), the orchestrator posts one ask naming the items, so a dead manager is not silent. The same check runs when
something else runs the cycle: `factory dev-manager loop --once` from cron or a systemd timer works if no machine stays
logged in:

```
*/10 * * * * cd /path/to/project && factory dev-manager lead loop --once >> .git/factory-manager/cron.log 2>&1
```

A scheduled GitHub Actions workflow could run the same check without a machine, but `.github/` is protected, so adding it
is an owner step; `factory watch --json` is what it would call.

Logs: `.git/factory-manager/<name>.log` (the cycle) and `.git/factory-manager/<name>.d/<item>.out` (a sub-manager's output).
`factory doctor` checks that `gh` is signed in, the manager profile resolves and its hook scripts exist.

**A settings profile and a gate keep it inside the rules.** The shared `settings.json` denies `Bash(gh api *)`, so builders
cannot be reused for a manager. The manager runs on its own profile, `.claude/manager/settings.json` (pass it with
`claude --setting-sources user --settings .claude/manager/settings.json`; `factory dev-manager loop` does): it allows `gh api`,
read-only git, `Read`/`Grep`/`Glob` and subagents, and denies pushing to main, force-push, editing `.claude/**`, `vendor/**`,
`CLAUDE.md` and `docs/PRD.md`, `gh pr merge` and reading secrets files. Its PreToolUse hook `manager_gate.py` refuses, and says
to write an owner-queue ask instead: a merge unless the PR's latest approval marker is `factory-approved sha=<the head being
merged>`, no must-fix came after it, the merge is pinned to that head and CI is judged green (newest non-skipped run per job
name, `factory_ci_judge.py`); a merge of a PR the manager opened (a `manager/` branch, or a body with
`<!-- factory-role role=dev-manager ... -->`: its own PRs wait for the owner); deleting refs, force-pushing and pushing to
main; `gh api` writes to `.github/` content, branch protection, rulesets, Actions secrets and variables, webhooks and deploy
keys; and shell commands that read secrets files. Like `pr-gate.py` it is a guard rail, not a lock: keep branch protection
and required CI on GitHub.

The full playbook is [DEV-MANAGER.md](DEV-MANAGER.md). To start it, run `factory dev-manager loop` (or `-i`) on a machine with the factory installed; the handover from a
cloud-session manager is [docs/manager-handover.md](docs/manager-handover.md), and `factory handover snapshot` prints the
state to hand over from GitHub.

### The list a manager starts from: `factory prs`

`factory prs` is read-only and uses the REST API only (`gh api`; no `gh pr`, no GraphQL, so it works where `gh pr` is
blocked). A pass reads it first instead of paginating comments and check runs.

```
Open pull requests (2)
#12 review: Task 7
    task/7-x | cccccc1 (14 min) | agent:taytu
    CI green | no marker for the head (older: factory-approved 0000000) | no claim
#13 waiting for agent: Task 9
    task/9-y | dddddd2 (3 h) | draft
    CI red (lint) | factory-mustfix | no claim
Questions
  pr #13 waiting 40 min: https://github.com/o/r/pull/13#issuecomment-1
Owner asks
  none waiting
Agents
  all agents answering
```

**CI, judged by one rule.** For each job name, the newest run that was not skipped decides: a re-run replaces a
failure, and a skipped run decides nothing. The PR gets one state: `red` (a job failed, was cancelled or timed out),
else `running`, else `queued`, else `green`. `none` means GitHub shows no runs yet; `unknown` means they could not be
read (the other PRs still show). `notGreen` names the jobs that are not green. `factory status` uses the same rule
and the same reading of the markers (both come from `factory_prs.py`).

**Markers per commit.** `markers` holds the newest `factory-approved`, `factory-mustfix` or `pr-watch` for each
commit, oldest first, and `namesHead` says whether it names the current head. Only the head's marker decides:
an approval of an older commit does not count. Approvals follow the merge gate's rule (only a login in main's
`trustedReviewers`, when that is set), and a must-fix holds the merge until an approval of the head comes after it.

**Review claim.** A `<!-- factory-review-claim manager=<name> sha=<head> until=<ISO time> -->` comment for the
current head that has not expired; the earliest one wins. A claim for another commit, or past its `until`, is ignored.
(The protocol, with releases and the lease cap, is `factory manager-claims`, which this reads through the same code.)

**Next action**, the first rule that fits:

| Order | When | Next action |
|---|---|---|
| 1 | `factory-hold` is on, and a live claim or no claim exists (an expired claim and no marker for the head makes it a stale hold: it falls through) | `held by <manager>` (the claimant, else `manager`) |
| 2 | Draft | `waiting for agent` |
| 3 | CI could not be read | `none`, with an error |
| 4 | Not an agent PR (the manager's own, or a person's): red, then waiting, then green | `none`; `wait CI`; `owner merges (own PR)` |
| 5 | A must-fix names the head, or holds the merge | `waiting for agent` |
| 6 | CI red: every red job is in `manager.flakes` and has run once on this commit | `rerun flake`; otherwise `waiting for agent` |
| 7 | No marker for the head | `review` (even while CI runs) |
| 8 | `pr-watch` for the head (reviewed, not approved) | `none` |
| 9 | Approved, CI not finished | `wait CI` |
| 10 | Approved, green, protected path changed or the body says "a person merges this one" | `owner merges (protected)` |
| 11 | Approved, green | `merge` |

An agent PR is one on a `task/<n>-...` branch or with an `agent:<name>` label. All roles share one GitHub account, so
this is the only way to tell the manager's own PRs from the agents'.

**Below the PRs.** `questions`: open `factory-question` comments with no later `factory-answer`, on open PRs and on
open issues (issues are searched `--since-days` back, default 14). `ownerAsks`: asks in the open issue titled
`Dev manager: needs the owner` (comments starting `<!-- factory-owner-ask id=<slug> -->`) that no comment answers; an ask
is answered by any comment after it and before the next ask, or by `<!-- factory-owner-answer id=<slug> -->`. `agents`:
agents that are `silent` or `down`, and `staleTasks`: in-progress tasks quiet for `tasks.staleHours` (issues mode only).

**`--json`**, stable for scripts. A part GitHub could not answer is `{"error": "..."}` in its place.

```
{
  "generatedAt": "2026-10-25T12:00:00Z",
  "pulls": [ {
      "number": 12, "title": "...", "url": "https://github.com/o/r/pull/12", "branch": "task/7-x", "draft": false,
      "head": {"sha": "<40 hex>", "ageMinutes": 14},                  // age of the head commit
      "labels": ["factory-hold", "agent:taytu"],
      "agent": "taytu" | null, "agentPr": true,
      "ci": {"state": "green|red|running|queued|none|unknown", "notGreen": [{"name": "lint", "state": "red"}], "runs": 3},
      "markers": [{"kind": "factory-approved|factory-mustfix|pr-watch", "sha": "<hex>" | null, "at": "<ISO>", "namesHead": true}],
      "headMarker": "factory-approved|factory-mustfix|pr-watch" | null,
      "gate": "approved|approval stale|must-fix|must-fix (older commit)" | null,   // the merge gate's reading
      "claim": {"manager": "ana", "until": "<ISO>", "expired": false} | null,
      "staleHold": false,
      "protected": true | false | null,                               // null: not looked at (only for a PR that could merge)
      "next": {"action": "review|merge|wait-ci|rerun-flake|waiting-for-agent|owner-merges|held|none",
               "text": "review", "reason": "protected|not-agent-pr", "by": "ana", "jobs": ["e2e"], "error": "..."}
  } ],                                                                 // "reason", "by", "jobs", "error": only when they apply
  "questions": [{"kind": "pr|issue", "number": 13, "title": "...", "url": "...", "ageMinutes": 40}],
  "ownerAsks": [{"id": "slug", "issue": 60, "url": "...", "ageMinutes": 300}],
  "agents": [{"name": "taytu", "status": "silent|down", "minutesAgo": 95}],
  "staleTasks": [{"number": 7, "title": "...", "quietHours": 4.2}],
  "note": "..."                                                        // only outside issues mode
}
```

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
"ci": {"name": "widget-ci", "label": "widget-local", "repo": "acme/widget", "replaces": ["com.example.old-runner"],
       "runners": 3, "light": true, "lightLabel": "widget-light", "image": "build", "caches": true}
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

<a id="ci-faster"></a>

**Faster rounds: a pre-built image and a registry mirror (#60).** A fresh runner per job used to download everything
again: Node, pnpm, the service images (Postgres ...) and Playwright's browser. Two things now carry over.

1. **The runner image** (`ci.image`, default `"build"`). `factory ci install` builds `<name>-runner:latest` from
   `runner.Dockerfile`: GitHub's runner image plus what this checkout asks for.
   - Node from `.nvmrc`, in the tool cache `actions/setup-node` looks in first, so it doesn't download it.
   - pnpm from `package.json`'s `packageManager`, through corepack.
   - Playwright's Chromium and its system libraries, in `/ms-playwright`, at the version in the lockfile. The jobs'
     user owns that folder, because Playwright's install writes a lock there even when the browser is present.
   - The image sets `FACTORY_CI_IMAGE=1`, so a workflow can leave out `--with-deps` there.
   - It is labelled with the three versions. `factory ci status` says when the checkout wants others (after a Node
     bump on main, say): then run `install` again, which rebuilds it.
   - If the build fails, the runners use GitHub's plain image and say so. `"image": "base"` skips the build. The
     light lane always uses the plain image.
2. **A pull-through mirror of Docker Hub** (`ci.caches`, default on; heavy runners only). It is `<name>-mirror`, a
   pinned `registry:2.8.3`, one per project and machine, and dind uses it as its registry mirror. Each instance
   reaches it over a network of its own (`<project>-cache`), so two jobs never share a network, and their
   published service ports stay apart.

**What persists, and who can write it.** Only the mirror's store of image layers, and only the mirror writes it,
from Docker Hub.
- A job can pull through it but can't push to it: a pull-through registry takes no pushes, and its volume is mounted
  in no job.
- dind checks every layer against its digest.
- No workspace, build output, environment variable, token or secret is written there.
- **No pnpm store is shared.** Job steps could write into one, and pnpm doesn't re-check a stored file's hash, so one
  pull request could plant code that later jobs (main pushes too) would run. Each job's pnpm store is new.
- dind's data (the job's own images, containers and volumes), the runner's workspace and the job's networks are
  removed by `down --volumes` after every job, so a job never sees another job's files.
- `factory ci uninstall` removes the mirror, its networks and the image too.
- The Turborepo results of the **[shared build cache](#a-shared-build-cache)** are a separate, opt-in service on the
  host (`factory turbo install`), not part of a runner; it has its own security notes.
- **`factory ci start`** (one loop by hand) uses neither: it runs GitHub's plain image with no mirror. Use `install`
  for the faster rounds.

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

<a id="ci-lanes"></a>

**Two lanes: light and heavy jobs.** Every runner takes one job at a time, so a 30-second Factory guard waits behind
whatever is queued before it. The guard reruns on every label change, and label changes are the dev manager's merge
steps (approval, `tests-reviewed`, the hold), so on one busy runner a merge could wait hours for it (#90). So:

- **Light jobs**: the Factory guard, and any other short job that runs on label changes and needs no Docker. They
  go to the **light lane**: one small runner per machine, label `<repo>-light`, without Docker-in-Docker
  (`compose-light.yaml`, 1 CPU, 1 GB), that takes nothing else.
- **Heavy jobs**: typecheck, lint, tests, build, browsers, evals, anything with service containers. They go to the
  `ci.runners` heavy runners, label `<repo>-local`, each with its own Docker.

`factory ci install` installs both (`"ci": {"light": false}` leaves the light lane out). `factory ci use local` sets
`CI_RUNS_ON` to `["self-hosted","<repo>-local"]` and `CI_RUNS_ON_LIGHT` to `["self-hosted","<repo>-light"]`, and
`use github` deletes both. `install` sets `CI_RUNS_ON_LIGHT` too when local mode is on. If gh can't set a variable
(that needs admin on the repository), the command prints the value, and a person sets it under *Settings → Secrets
and variables → Actions → Variables*. With no light runner online, light jobs wait. Then set `CI_RUNS_ON_LIGHT` to the
same value as `CI_RUNS_ON`, or delete it.

**How many runners** (`ci.runners`, default 1, set with `factory settings set ci.runners 3`). Each heavy runner is
a loop with its own compose project (`<name>`, `<name>-2`, ...), registration names (`<name>-<host>.2-<time>`),
Docker-in-Docker, volumes and workspace, all removed after each job ([what persists](#ci-faster)). They share the label, so GitHub gives each job
to whichever is free, on any machine. A machine can override the number with `FACTORY_CI_RUNNERS=3` in its shell
profile (a CI box runs 3, a laptop 1); run `factory ci install` again after changing either.
- Budget about 4 GB of memory per heavy runner (a job, its dind and its service containers) and 1 GB for the light
  one. `install` warns when that is more than the machine has free.
- CPU matters less: most jobs use one or two cores.
- Scaling down removes the extra instances and their idle registrations. An instance that is running a job stays
  until the job ends, and so does one whose state GitHub can't tell `install` (gh offline); run `install` again then.
  There is a short window between that check and the unload: a job that starts in it is cancelled, and GitHub
  shows it as failed.
- **Running `install` again restarts every instance**, so jobs in progress on this machine are cancelled. Run it when
  the runners are idle (`factory ci status`).
- Registration names keep machines apart: `<name>-<host>-<time>` for instance 1, `<name>-<host>.2-<time>` and
  `<name>-<host>.light-<time>` for the others (a host name never has a dot here). So instance 2 on `foo` and a
  machine called `foo-2` never touch each other's runners.
- On a Mac, the memory check uses Docker Desktop's VM (the jobs run there). On Linux it uses free memory, counting
  the instances that already run.
- With `"light": false`, `install` and `use local` delete `CI_RUNS_ON_LIGHT` (or say a person must), and `status`
  warns whenever `CI_RUNS_ON_LIGHT` names a label that no online runner has.

**The workflow.** Each job picks its machine from those variables, and a pull request from another repository (a
fork) always runs on GitHub's runners. The kit's `.github/workflows/ci.yml` does this:

```yaml
# light: the Factory guard
runs-on: ${{ fromJSON(github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && '"ubuntu-latest"' || vars.CI_RUNS_ON_LIGHT || vars.CI_RUNS_ON || '"ubuntu-latest"') }}
# heavy: everything else
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

<a id="a-shared-build-cache"></a>

## A shared build cache

Turborepo caches the result of every task (build, typecheck, test), but only on the machine that ran it. So each agent
worktree, each machine and each CI runner (a new container per job) started cold and rebuilt packages nobody had
touched (#59). The fix is one **self-hosted Turborepo remote cache** per project: a small server
([ducktors/turborepo-remote-cache](https://github.com/ducktors/turborepo-remote-cache), pinned in
`ci/compose-turbo.yaml`) on the factory machine. The agents' sessions and the CI jobs send results to it and take
results from it, so a package that did not change is done once.

**It is off until you set it up, and it degrades by itself.** With `turbo.api` empty nothing changes. With it set, but
no token, or the server not answering, every agent session and CI job says so in one line and builds with the local
cache only, as before. Nothing fails because the cache is away.

### Set it up: one command, once the owner has supplied a token

The token is the one thing the factory cannot make for you, and it is never in the repository or in `factory.json`.

1. **Make a token** and keep it where only you can read it: `openssl rand -hex 32`. For signed artifacts (below) also
   make a signature key of 32 or more characters, the same way.
2. **Tell the factory where to find it**, either of these (the environment wins):
   - export `TURBO_TOKEN` (and `TURBO_REMOTE_CACHE_SIGNATURE_KEY`) in the shell profile of every machine that runs
     agents, and on the machine that runs the server; or
   - set `turbo.secretsCommand` to a command that prints `KEY=value` lines. With sops (which the factory's projects
     already use): put `TURBO_TOKEN: ...` in an encrypted file and set
     `factory settings set turbo.secretsCommand 'sops -d --output-type dotenv secrets/factory.yaml'`. Agents and
     `factory turbo install` run it; `factory doctor` never does.
3. **Pick the address** the agents and CI will use: the machine's Tailscale or LAN address, and a port (3335 by
   default): `factory settings set turbo.api http://100.64.0.7:3335` and `factory settings set turbo.bind 100.64.0.7`.
   Commit `.claude/factory.json` in a PR.
4. **Run `factory turbo install`** on the machine that will host the cache. It starts the server (`docker compose up
   -d`, `restart: unless-stopped`, so it is back after a reboot), waits until it answers, and sets the repository
   variables `TURBO_API` and `TURBO_TEAM` and the secrets `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` (the
   secrets go to `gh` on stdin, never in an argument, so CI uses the same cache. Setting them needs admin on the
   repository; without it the command says what to ask an admin, and `--no-github` skips the step).

`factory turbo status` shows what is set and whether the cache answers, and never prints a secret. Run `factory turbo
install` again to update the server or change the token (the server restarts with the new one); agents pick up a
changed token or address at their next task.

### What agents and CI get

- **Agents.** `factory-loop.sh` asks `factory turbo env` before every task, and the SessionStart hook asks it for a
  plain `factory agent` session. When the cache answers, the session gets `TURBO_API`, `TURBO_TEAM`, `TURBO_TOKEN`
  (and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` when there is one), plus `TURBO_REMOTE_CACHE_TIMEOUT=10` so a slow cache
  cannot stall a build. All agents share one `TURBO_TEAM`, so they share results. The hook never prints the token into
  the session.
- **CI.** The kit's `ci.yml` has a step, *Shared remote cache (optional)*, before the install, that runs
  `factory_turbo.py ci-env >> "$GITHUB_ENV"` with `vars.TURBO_API`, `vars.TURBO_TEAM` and the two secrets. It sets the
  variables only when they are all there and the cache answers. It is skipped for a pull request from another
  repository (a fork gets no secrets and runs on GitHub's runners). A project that copied `ci.yml` earlier adds the step
  by hand.
- **Reaching it.** The server listens only on `turbo.bind`: `127.0.0.1` unless you choose another address, and
  `install` says when `turbo.api` and `turbo.bind` do not fit (for example a Tailscale address in `turbo.api` and a
  loopback `bind`). The CI runner containers reach the host's Tailscale or LAN address through Docker's normal
  networking, so use that address, not `localhost`. Never put it on the public internet.

### The project's side (a PR in the project, once this is in the pinned my-skills)

- `turbo.json` needs no `TURBO_*` entries: Turborepo reads them itself.
- To sign artifacts, add `"remoteCache": { "signature": true }` to `turbo.json`, and give every machine and CI the same
  `TURBO_REMOTE_CACHE_SIGNATURE_KEY`. `factory doctor` notes a key without that setting.
- Check it works: run a task twice from two agents' worktrees (`pnpm turbo run typecheck`); the second shows
  `cache hit, replaying logs` for the packages nobody changed and `FULL TURBO` at the end. CI shows the same for the
  packages a pull request left alone.

### Security

- **What it stores:** build outputs and logs of Turborepo tasks. No source, no environment, no registry credentials.
  Anyone with the token can read all of it and write to it.
- **Poisoning is the risk.** A cached output that is wrong is replayed by every later run with the same task hash. So:
  - the server answers only with the token, and listens only where you bound it (Tailscale or the LAN, never the
    internet);
  - **sign artifacts** (`remoteCache.signature` plus a signature key): a client then refuses an artifact whose
    signature does not match, so anyone who can reach the server but lacks the key cannot plant one. *Check that your
    server version stores the signature tag:* a server that does not (reported for some storage backends in upstream
    issue 394) makes every signed task a miss, which `FULL TURBO` shows. Then leave signing off until it is fixed;
  - **the token and the key reach everyone who runs jobs with them:** the agents (their sessions have the variables, as
    do commands they run) and the pull-request jobs of this repository. They can write artifacts. That is the same trust
    you already give them to run code on your machine and on the runners, no more, but it means a branch's CI run can
    write what main's run later reads. For a project that does not accept this, leave the repository variable
    `TURBO_API` unset: CI then builds locally, and only the agents share a cache;
  - **forks never use it:** the workflow skips the step, a fork's pull request has no secrets, and it already runs on
    GitHub's runners (not your machine), so it cannot reach a private address anyway. Leave *Run workflows from fork
    pull requests* off, as for the runners;
  - the server container is unprivileged: every capability dropped, a read-only file system, no host mounts, a named
    volume for the artifacts, and a pinned image (`TURBO_CACHE_VERSION` overrides the tag).
- **The token is in the server container's configuration** (`docker inspect`), readable by people in the `docker` group
  on that machine. It is in no file the factory writes and in no command line it runs.
- **Rotating:** change the token where it comes from, run `factory turbo install` (restarts the server and updates the
  repository secret), and the agents pick it up at their next task. `factory turbo down --purge` also clears everything
  stored.

<br>

## A sandboxed machine: `factory bootstrap`

`factory bootstrap` takes a fresh Ubuntu or Debian machine (systemd) to a state where agents and CI runners run as a
dedicated, unprivileged user behind a network guard, and ends with `factory doctor --sandbox` green. It is the hand-built
setup of a factory machine written down as code: reinstalling the machine or adding a third one is two commands and
three sign-ins. Linux only for now.

```sh
sudo factory bootstrap machine                 # prints the plan, changes nothing
sudo factory bootstrap machine --script s.sh   # the same steps as a bash script to read (and run with sudo bash s.sh)
sudo factory bootstrap machine --apply         # runs them, as root, after a y/N question (--yes: no question)
sudo -u factory -i                             # or ssh in as that user; then, from the project's checkout:
factory bootstrap project                      # as the sandbox user, never as root
```

`factory bootstrap` works before there is a checkout (it runs from where the `factory` script lives); `project` takes
`--repo URL [--dir PATH]` to clone one, with its submodules.

**Nothing privileged runs by itself.** The machine part and `uninstall` only print their plan unless you pass `--apply`
and run as root; `--dry-run` is accepted everywhere. Every step has a check, so a second run changes nothing, and every
system change is written to a manifest (`/var/lib/software-factory/bootstrap.json`) that `status` and `uninstall` use.
The project part is refused as root. Agents cannot run it: it refuses inside an agent session (`FACTORY_AGENT`, `FACTORY_LOOP` or `CLAUDECODE` set), `status` excepted.

| Part | What it does |
|---|---|
| `machine` (root) | Packages (`uidmap`, `slirp4netns`, `dbus-user-session`, `git`, `gh`, `age`, `tmux`, `nftables` ...); `sops` as the release binary with its checksum checked; the user (default `factory`: no password, no sudo, not in the docker group, its home and the admin's home mode 750); subuid/subgid ranges; `loginctl enable-linger`; the network guard; with `--authorized-keys FILE` the given public keys; with `--harden-ssh` key-only SSH and no root login; with `--keep-awake` (the default on a laptop, `--no-keep-awake` to refuse) no sleep, suspend or lid switch |
| `project` (the user) | Rootless Docker (`dockerd-rootless-setuptool.sh install`, `systemctl --user enable --now docker`); `DOCKER_HOST`, `SOPS_AGE_KEY_FILE` and `PATH` in `~/.bashrc`; `~/.secrets` (700); Node from `.nvmrc` through nvm and `corepack enable`; Claude Code with the official installer; submodules, `.env.local` from `.env.example`, `commands.install`; `factory install-shim`; with `--agents a,b` the machine's agent names; then, after the sign-ins, `commands.stackUp`, the CI runners (`factory ci install`, `--runners N` for `FACTORY_CI_RUNNERS`) and autostart; last, `factory doctor --sandbox` |
| `status` | The manifest against what is there now; exit 1 when something drifted |
| `uninstall` | The guard, its unit and rules, the sleep and SSH drop-ins, the saved settings and the manifest. The user, its home, backups and the installed packages stay. `--remove-user` or `--delete-home` remove the account (only one bootstrap created) and need its name typed (`--confirm NAME` for scripts) |

**The human steps stay yours.** `gh auth login`, the Claude login (and its folder-trust prompt for the project) and
copying the age key are never done by bootstrap. `project` stops after the first part when one is open, prints the exact
commands and exits 2; run it again after, and it carries on with the runners and autostart. It only checks that they
exist (`gh auth status`, the credentials file, `sops -d` of the first file under `secrets/`, output discarded). It never
reads, prints, logs or stores a token or the key.

### Network guard

The default policy: **internet yes; home network no; Tailscale no; other users' files no; no sudo; no docker group.** It is
an nftables table `factory_guard`, loaded by the systemd unit `factory-net-guard.service`, that matches the sandbox user's
uid (`meta skuid`):

- DNS only to the resolver, which is read from `/etc/resolv.conf` and `resolvectl dns` (a systemd-resolved stub on
  127.0.0.53 needs no rule), not hard-coded;
- `--allow-host ADDR[:PORT]` (repeat) lets one home-network host through, such as a Postgres or a build cache;
- everything private is dropped with the log prefix `FACTORY-BLOCK `: RFC1918, the Tailscale range 100.64.0.0/10,
  link-local, and IPv6 ULA and tailnet addresses;
- loopback ports of other users' services are dropped: `--block-loopback-port PORT` (repeat) plus, at every run, every
  loopback or wildcard port that a process of another user listens on (`ss -ltnHe`). A service started later is covered the
  next time `sudo factory bootstrap machine --apply` runs, and `factory doctor --sandbox` fails until then;
- `--block-inbound-port PORT` drops those ports from other hosts (`FACTORY-INBOUND `);
- `--egress none` closes the internet too.

The settings are saved in `/etc/software-factory/sandbox.json`, so a re-run converges on them (`user`, `egress`,
`allowHosts`, `blockLoopbackPorts`, `blockInboundPorts`). Rules are rendered from `hooks/factory_netguard.py`, which is also
what the tests check.

### `factory doctor --sandbox`

Run it as the sandbox user. Each check prints `ok`, `fix` (with the fix) or `note`:

- identity: the user is the one bootstrap made; no sudo (`sudo -n true` fails); not in the sudo, docker or admin groups;
  the admin's home and `.ssh` are unreadable; `~/.secrets` is 700;
- network: GitHub, npm and the Claude API answer; the router, the tailnet, link-local and the blocked local ports do not;
  `FACTORY-BLOCK` entries appear in the kernel log (a note when this user may not read the log);
- **local services of other users** (known gap 1): every loopback or wildcard port that another user listens on is in the
  guard's rules; if not, run the machine step again;
- **containers** (known gap 2): a container started by this user (`docker run busybox wget` to the router) cannot reach the
  router either, which is true when Docker is rootless because its traffic leaves through the user's own process;
- rootless Docker with overlayfs, the `cpu`, `memory` and `pids` cgroup controllers delegated to the user's systemd
  (the ingest sandbox tests need memory limits), linger on;
- the CI runner units are active (at least `ci.runners`) and every agent worktree has its submodules checked out.

A user account is a weaker boundary than a VM, and the agents still hold what their job needs inside the sandbox: a `gh`
token, the age key and the Claude login. Keep the separate GitHub account for agents from [Security notes](#security-notes).
Not in this version: macOS, a VM mode, creating the GitHub account.

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
- **CI:** the kit's workflow has read-only permissions and, unless you set up the [shared build cache](#a-shared-build-cache),
  no secrets, and the guard fails a workflow that uses `pull_request_target`. A self-hosted runner (`factory ci`) runs branch code on your Mac with a privileged
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
`factory settings` is how you browse, understand and change them without editing JSON. In a terminal it opens a menu
(plain `input()` and `print()`, no extra packages, so it works over SSH):

```
factory settings
  1  Paths & docs   2  Commands   3  Tests & protected paths   4  PR gate & reviews   5  Agents & loops
  6  Issues mode    7  Ports & per-agent env   8  CI   9  Design & eval   10  Machine (local)
Choose a number, /text to search, s to review and save, q to quit >
```

Each setting shows its name, current value, default, whether it is overridden and a one-line description:
`maxOpenPRs   4  (default 3, overridden)`. On a setting, `c` changes it (typed input is checked; lists and objects get
add, edit and remove one item at a time; regex lists are compiled and can be tested against example paths), `r` resets it
to the default (the key leaves the file) and `?` shows the long help: what it does, examples, what reads it, and who
must approve a change (for example, `testPaths` needs the dev manager's `tests-reviewed` label). `/text` searches names
and descriptions anywhere. `s` shows a unified diff of `.claude/factory.json`, flags the changes that need a review, and
asks how to save: write the file only, or create a branch `settings/<short-name>`, commit, push and open a pull request
(a draft or ready) whose body lists each change and the review it needs. Quitting, or the input ending, writes nothing.

The same things work in scripts, tests and CI:

```sh
factory settings list [--section commands] [--json]   # value, default, overridden, description (JSON has every field)
factory settings get tasks.source                     # dotted keys; the value as JSON
factory settings set maxOpenPRs 5
factory settings set agents '["ada","grace"]'         # lists and objects as JSON
factory settings unset maxOpenPRs                     # back to the default
factory settings help [tasks.source]                  # the long help, or the list of sections
factory settings diff                                 # what the file sets differently from the defaults
factory settings validate                             # exit 1 with clear messages when a value is wrong
factory settings pr [--ready]                         # propose the edited file as a pull request (a draft by default)
factory settings --local set remoteControl off        # the machine scope (below)
```

`validate` fails on: a regex that does not compile, a `tasks.source` that is not `plan` or `issues`, a duplicate or
invalid agent name, an integer below its minimum (`maxOpenPRs`, `portStep` ... at least 1), a `prd`, `plan` or
`decisions` path that does not exist, a bad `models`, `styles` or `agentEnv` value, and `agentEnv` ports that collide
across the agents' slots. A key that is not a setting is only a warning (probably a typo); it is kept and ignored.
Saving keeps the file readable: key order and `_about` entries stay, the file's own indent is kept, and the write is
atomic.

**Only people change settings.** `.claude/` is protected, so a project change reaches main through a pull request.
`set`, `unset`, `pr`, `--local` changes and saving in the menu refuse inside an agent session (`FACTORY_AGENT`,
`FACTORY_LOOP` or `CLAUDECODE` is set); `settings.json` denies them and the PR gate blocks them, also inside `bash -c`.
Reading (`list`, `get`, `help`, `diff`, `validate`) stays allowed. Nothing merges settings by itself: the dev manager or
the owner merges the pull request.

**Machine scope** (`factory settings --local ...`, section 10 of the menu). Some settings belong to a machine, not the
project, so they live in its own file outside the repo (`factory machine show` prints where) and are never committed:
`agents` (the names this machine runs; `FACTORY_AGENTS` overrides), `remoteControl` (start sessions with Remote Control;
`FACTORY_REMOTE_CONTROL=0|1` overrides), `autostart`, `autostartAgents` and `autostartReport`. The order of precedence
is the defaults in `factory_config.py`, then the project file, then the machine file (machine keys only), then the
environment.

**One table describes every setting** (`hooks/factory_settings_schema.py`): key, type, default (read from
`factory_config.py`), section, short and long help, examples, who reads it, who must approve a change, and how a value is
checked. The list, `help`, `validate`, the menu and the tables below are all generated from it, so they cannot drift.
A test fails when the tables below are out of date; refresh them with `factory settings docs --write`. The `_about`
strings in the template stay readable, but this is the documentation.

<!-- settings:begin -->
(Generated by `factory settings docs --write` from the settings table in `hooks/factory_settings_schema.py`:
change the table there, not here. `factory settings help <key>` has the long help for each setting.)

**Paths & docs**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `prd` | str | `"docs/PRD.md"` | Where the PRD lives. Agents read the sections a task points to. |
| `plan` | str | `"docs/build-plan.md"` | The build plan (plan mode: its unticked lines are the tasks). |
| `blocked` | str | `"docs/blocked.md"` | The blocked list (plan mode): `- 1.3: needs ...` lines are skipped. |
| `decisions` | str | `"docs/decisions"` | The folder of numbered decision records. |
| `numberedDirs` | list | `[]` | More folders of numbered files (migrations): a new file takes a free number. |
| `mainBranch` | str | `"main"` | The main branch. |
| `artifacts.manifest` | str | `"docs/artifacts.json"` | Where `factory artifacts` records each artifact copy kept in the repo: where it came from, when, by whom, and a hash of each file. |
| `artifacts.dir` | str | `"docs/artifacts"` | The default folder for an artifact's repo copy: <dir>/<artifact id>. |
| `artifacts.fetch` | str | `""` | A command that exports the artifact `{url}` into the folder `{out}`, for `factory artifacts pull`. Empty: pull takes an export made by hand (`--from`). How a terminal session may read an artifact is not settled. |
| `artifacts.info` | str | `""` | A command that prints JSON {title, updated, version} for the artifact `{url}`, for `factory artifacts status` and `factory doctor`. Empty: they say they can't tell whether a copy is older. |
| `notes` | str | `".claude/factory/notes"` | The folder of project notes for the shared agents and skills. |
| `usageLog` | str | `"docs/factory-usage.md"` | Where `factory usage --record` appends its rows (commit it to keep the history). |
| `release.repo` | str | `"deresegetachew/my-skills"` | The GitHub repository whose releases `factory update` installs (owner/name). Default: the factory's own, deresegetachew/my-skills. |

**Commands**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `commands.install` | str | `""` | Installs dependencies in a new worktree (start it with `git submodule update --init`). |
| `commands.typecheck` | str | `""` | The typecheck CI and the Stop check run. |
| `commands.lint` | str | `""` | The lint command. |
| `commands.test` | str | `""` | The full test command. |
| `commands.build` | str | `""` | The build command. |
| `commands.smoke` | str | `""` | A quick command proving main still works. |
| `commands.stackUp` | str | `""` | Brings the dev stack up (Postgres, MinIO ...); `factory resume` runs it at boot. Should return once the stack is started. Empty: no stack at boot. |
| `commands.stackHealth` | str | `""` | Passes (exit 0) once the stack is healthy; `factory resume` asks until it does. Empty: stackUp is enough. |
| `commands.agentSetup` | str | `""` | Runs once per loop after the env is set, e.g. to create the slot's database. |
| `commands.typecheckChanged` | str | `""` | The Stop check's typecheck, for the changed packages only (saves time and tokens). Empty: use commands.typecheck. |
| `commands.ci` | str | `""` | What CI runs (typecheck, lint, test, build), for `factory verify`; `{base}` is origin/<main>. When set on main, a ready PR needs it passed for its commit. |
| `commands.fix` | str | `""` | Formats and auto-fixes the files this branch changed, e.g. `prettier --write {files} && eslint --fix {files}` (`{files}` is the quoted list; without it the list is appended). The Stop check and `factory verify` run it first, so agents never spend a turn on style. |
| `fixPaths` | list | `[]` | Regexes: commands.fix gets only changed files matching one of them. Empty: every changed file. |
| `commands.testChanged` | str | `""` | The Stop check's tests, for the changed packages only. Empty: use commands.test. |
| `codePaths` | list | `["src"]` | Folders with code: the Stop check runs only when they changed. |
| `checkRequires` | list | `[]` | Paths that must exist before the Stop check runs, e.g. ["node_modules"]. |
| `checkOutputLines` | int | `40` | How many lines of a failing check the agent is shown (failures first). |
| `checkLogDir` | str | `"tmp/checks"` | Where a check's full output is saved; the agent sees a capped summary and this path. |
| `styles` | list | `[]` | Style guides per path: [{"paths": [...], "skills": [...], "check": "..."}]. |
| `structure.roots` | list | `[]` | Folders the structure check (check_structure.py) looks at, when a style uses it. |
| `structure.legacy` | str | `""` | The list of legacy files the structure check leaves alone (it only shrinks). |

**Tests & protected paths**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `protected` | list | `see `factory settings help protected`` | Regexes of files an agent may not merge. |
| `alwaysAllowed` | list | `["docs/build-plan.md", "docs/blocked.md"]` | Files that are never protected (the plan, the blocked list). |
| `testPaths` | list | `see `factory settings help testPaths`` | Regexes the Factory guard treats as tests. |
| `goldenPaths` | list | `see `factory settings help goldenPaths`` | Regexes the guard treats as expected outputs. |
| `dependencyManifests` | list | `["(^\|/)package\\.json$"]` | Regexes of dependency manifests (a new dependency needs deps-reviewed). |

**PR gate & reviews**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `maxOpenPRs` | int | `3` | Ready PRs the account may have open at once. About the number of agents + 1. |
| `prSizeWarn` | int | `600` | The guard warns above this many changed lines. |
| `reviewMarkers` | str | `"tmp/reviews"` | Where review passes are written. |
| `reReviewPercent` | int | `30` | A reviewer's second round reads only what changed since its last round, unless that is more than this percent of the branch diff (or touches a new file): then it is a full review. 0: always a full review. |
| `lessons` | str | `".claude/factory/lessons.md"` | The curated lessons file: one-line rules the builder and the reviewers read first (`factory lessons`). |
| `lessonsCap` | int | `40` | The most lessons the file may hold; `factory lessons check` fails above it and add refuses. Prune what a check enforces now. |
| `manager.flakes` | list | `[]` | Names of CI jobs known to fail now and then for no reason. `factory prs` says `rerun flake` for a PR whose only red jobs are these, failing for the first time on that commit; a second failure goes back to the agent. |
| `trustedReviewers` | list | `[]` | GitHub logins whose approvals count. Empty: any. |
| `holdLabel` | str | `"factory-hold"` | The label the dev manager puts on a PR it is reviewing. |
| `reviews.safety-auditor.paths` | list | `[]` | Regexes of paths that need the safety auditor. |
| `reviews.security-reviewer.paths` | list | `[]` | Regexes of paths that need the security reviewer. |

**Agents & loops**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `roles.dir` | str | `".claude/factory/roles"` | The project's role folder: <dir>/<role>/README.md (the project's own instructions for the role) and reads.md (what it reads, one per line). Committed in the project. A project without it falls back to `notes`. `factory init-roles` creates it. |
| `roles.dev-manager.names` | list | `["fasil", "yekuno", "amda", "sarsa", "susenyos"]` | The dev managers' names: `factory dev-manager [name\|N] loop`. Lowercase letters, digits, dashes; none may be a coding agent's name. |
| `roles.dev-manager.profile` | str | `".claude/manager/settings.json"` | The Claude settings file the dev manager's sessions run on (read only when it exists). |
| `roles.product-owner.names` | list | `["mentewab", "eleni", "sabla"]` | The product owners' names: `factory product-owner [name\|N] loop`. |
| `roles.product-owner.profile` | str | `".claude/product-owner/settings.json"` | The Claude settings file the product owner's sessions run on (read only when it exists). |
| `roles.product-owner.workLabel` | str | `"factory:needs-product"` | An open issue or pull request with this label is work for the product owner. Empty: it never has any. |
| `roles.product-owner.busyMinutes` | int | `30` | Minutes the product owner's loop waits after a pass that had work. |
| `roles.product-owner.idleMinutes` | int | `60` | Minutes it waits when there was none. 0: it exits instead. |
| `roles.product-owner.escalateMinutes` | int | `120` | A question addressed `to=po` that nobody answered moves up one level after this many minutes: product owner, then dev manager, then the owner. With no product owner running it starts at the dev manager. |
| `roles.product-owner.logins` | list | `[]` | GitHub logins whose answers count for the product owner. Empty: any login. An answer from another login is ignored. |
| `manager.busyMinutes` | int | `2` | Minutes the dev manager's loop waits after a cycle that had work. |
| `manager.idleMinutes` | int | `5` | Minutes it waits when there was none. 0: it exits instead. |
| `manager.maxSubManagers` | int | `2` | How many one-item sub-managers the dev-manager orchestrator runs at once. Items beyond the cap wait for the next cycle. |
| `manager.claimMinutes` | int | `20` | How long a dev manager's lease on an item lasts: a sub-manager's, or a review or answer claim on a PR or question (it ends sooner when the review marker or the answer is posted). A manager that dies leaves a claim that expires on its own. |
| `manager.deadManMinutes` | int | `30` | Work that has waited this long with no dev-manager activity (no marker, answer, merge or working heartbeat) is reported to the owner: the dead-man's switch. |
| `manager.notify` | str | `""` | The GitHub login mentioned in an owner-queue comment, so GitHub notifies the owner's phone. Empty: the repository's owner. |
| `manager.quietMinutes` | int | `5` | A pull request whose head commit has no review marker is left this long before the watcher counts it (check 1). |
| `manager.staleMinutes` | int | `15` | A must-fix, failing CI or merge conflict with no new commit for this long is the manager's (check 3). |
| `manager.ownerWaitMinutes` | int | `120` | A pull request labelled for the product owner or the owner that has waited this long is reported (check 5). |
| `manager.agentIdleMinutes` | int | `45` | A coding agent idle this long while tasks are ready is reported to the owner (check 6). |
| `manager.ciQueuedMinutes` | int | `10` | A CI run queued this long is reported (check 7). |
| `manager.subManagerMinutes` | int | `30` | A sub-manager session is stopped after this many minutes. |
| `agents` | list | `see `factory settings help agents`` | The agents' names, in order (lowercase letters, digits, dashes). |
| `claimStaleHours` | int | `6` | How long a local claim or a pushed task branch holds a task. |
| `waitMinutes` | int | `1` | How often an idle loop looks for work. 0: it exits instead. |
| `models` | dict | `{}` | The model per role (builder, manager, product-owner, test-writer, reviewer, architecture-reviewer, safety-auditor, security-reviewer): {"builder": {"model": "opus", "effort": "high"}, "reviewer": {"model": "sonnet", "escalateTo": "opus"}}. effort (low, medium, high, xhigh, max) is for builder and manager only. A role with no entry keeps today's model: the agent file's, or Claude Code's default. |

**Issues mode**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `tasks.source` | one of plan/issues | `"plan"` | Where tasks come from. |
| `tasks.staleHours` | int | `3` | An in-progress issue with no activity this long counts as stale. |
| `tasks.pingMinutes` | int | `5` | How often a working agent pings its agent issue, at most. |
| `tasks.downMinutes` | int | `30` | No ping for this long: the agent counts as down. |
| `tasks.heartbeatSeconds` | int | `20` | How often the heartbeat daemon (`factory heartbeat`) looks at this machine's agents. It writes to GitHub only on a change, and every pingMinutes as a keepalive. |
| `tasks.heartbeatMissMinutes` | int | `12` | An agent the daemon writes for counts as silent after this many minutes without a keepalive (instead of downMinutes). |
| `tasks.releaseDownMinutes` | int | `10` | An agent that is plainly down (its loop or the daemon said so) gets its in-progress issues back to ready by the sweep after this long. |
| `tasks.showWhere` | bool | `false` | Post the machine, folder, tmux session and Remote Control link on agent issues (anyone who can read the repo sees them). |
| `tasks.labels` | dict | `see `factory settings help tasks.labels`` | The GitHub labels that mark a task: ready, inProgress, inReview, blocked and the agentPrefix. |

**Ports & per-agent env**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `agentEnv` | dict | `{}` | Per-loop variables: {"API_PORT": "{port:4100}", "DATABASE_URL": "...{suffix}"}. |
| `portStep` | int | `10` | How far each agent's ports move from the previous agent's. |

**CI**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `ci.name` | str | `""` | The self-hosted runner's name (default `<repo>-ci`). |
| `ci.label` | str | `""` | The runner label CI jobs ask for (default `<repo>-local`). |
| `ci.runners` | int | `1` | Heavy runner loops per machine (each with its own Docker); FACTORY_CI_RUNNERS overrides it on one machine. |
| `ci.light` | bool | `true` | Also run one small runner without Docker for light jobs (the Factory guard), label `<repo>-light`. |
| `ci.image` | str | `"build"` | The heavy runners' image: build (with the project's Node, pnpm and Playwright, faster jobs) or base. |
| `ci.caches` | bool | `true` | Keep a pull-through Docker Hub mirror between jobs (heavy runners; read-only to jobs, no workspace or secrets). |
| `turbo.api` | str | `""` | The shared Turborepo cache's address, as agents and CI reach it: http://<Tailscale or LAN address>:3335. Empty: no shared cache. `factory turbo install` starts it. |
| `turbo.team` | str | `""` | The cache's team name (default: the repository's name). |
| `turbo.bind` | str | `"127.0.0.1"` | The address the cache server listens on, on the machine that runs it. 127.0.0.1 reaches only that machine; use its Tailscale or LAN address for others. |
| `turbo.port` | int | `3335` | The port the cache server listens on. |
| `turbo.secretsCommand` | str | `""` | A command that prints TURBO_TOKEN=... (and TURBO_REMOTE_CACHE_SIGNATURE_KEY=...) lines, for example `sops -d --output-type dotenv secrets/factory.yaml`. The token is never stored in factory.json; TURBO_TOKEN in the environment wins. |
| `ci.lightLabel` | str | `""` | The light runner's label (default `<repo>-light`). |

**Design & eval**

| Key | Type | Default | What it sets |
|---|---|---|---|
| `eval.command` | str | `""` | The eval command (e.g. `pnpm golden`). Empty: no eval yet. |
| `eval.baseline` | str | `""` | The eval's baseline file. |
| `design.references` | str | `""` | The folder of design references. Empty: no design check. |
| `eval.skill` | str | `"eval"` | The skill that runs the eval. |
| `eval.metrics` | list | `[]` | The metrics the eval reports. |
| `eval.mustNotDrop` | list | `[]` | Metrics that must not drop against the baseline, e.g. ["warning recall 100%"]. |
| `eval.paths` | list | `[]` | Regexes of changed paths that need the eval. |
| `design.skill` | str | `"design-check"` | The skill that runs the design check. |
| `design.renders` | str | `""` | The folder of reference renders (images) the design check compares with. |
| `design.preview` | str | `""` | The command that serves a preview of the built screens. |
| `design.paths` | list | `[]` | Regexes of changed paths that need the design check. |

**Machine (local)** (`factory settings --local`, not in the project file)

| Key | Type | Default | What it sets |
|---|---|---|---|
| `agents` | list | `[]` | The agent names this machine runs. Two machines must never share a name. |
| `remoteControl` | bool | `true` | Start loop and agent sessions with Remote Control, so you can reach them from claude.ai/code or your phone. |
| `autostart` | bool | `false` | Bring the stack and this machine's agents back after a reboot (`factory autostart`). |
| `autostartAgents` | list | `[]` | The agents it starts at boot. Empty: the names this machine runs. |
| `autostartReport` | bool | `true` | Post the boot report on the first started agent's issue (issues mode). |
<!-- settings:end -->

<br>

<details>
<summary>The files in the kit</summary>

## The files in the kit

```
software-factory/
  README.md                               this page
  SKILL.md                                the skill: set up a project, or act as dev manager
  DEV-MANAGER.md                          the dev manager's playbook (orchestrator and one-item sub-managers)
  PO.md                                   the product owner's playbook
  docs/PRD.md                             the factory's PRD: scope, decisions, user stories, what is later
  docs/manager-handover.md                runbook: from the cloud-session manager to terminal managers
  install.sh                              install into a project (--link with the submodule)
  factory                                 the command line
  factory-loop.sh                         the loop behind `factory loop`
  VERSION                                 the release number
  docs/messages.md                        the message envelope, states and the A2A mapping
  tests/                                  tests for the gate, issues, the loop and the hooks
  hooks/
    factory_watch.py                    the dev manager's seven checks on GitHub (`factory watch`), no model
    factory_orchestrator.py             `factory dev-manager loop`: cycles, thread notes, owner asks, sub-managers
    factory_lease.py                    the lease on an item (claim comments), the interface #99 will replace
    factory_roles.py                    the roles' definitions, role folders (`init-roles`) and `choose`
    manager_gate.py                     PreToolUse for the manager: merge gate, refs, protected places, secrets
    factory_ci_judge.py                 CI judged the manager's way: newest non-skipped run per job
    factory_lessons.py                  the curated lessons file: show, check, suggest, add, prune
    factory_manager_claims.py           several dev managers at once: review and question claims with a lease
    factory_rereview.py                 incremental re-review: the delta since a reviewer's last round
    pr-gate.py                          PreToolUse: gates gh pr create, ready and merge, and the markers
    check.py                            Stop: typecheck and tests
    factory_stop.py                     Stop: closes a finished session in `factory loop -i`
    factory_session.py                  SessionStart: a plain `claude` session becomes an agent
    factory_agents.py                   live agents: register, ping, down, sweep (and the hook entry)
    next_task.py                        the next job: rework first, then a free task
    factory_machine.py                  this machine's id, agent names and autostart settings (outside the repo)
    factory_autostart.py                `factory autostart`: status, install and uninstall of the boot service
    factory_resume.py                   `factory resume`: the boot step (stack, backups, agents in tmux)
    factory_heartbeat.py                `factory heartbeat`: the per-machine liveness daemon
    factory_heartbeat_service.py        install and uninstall of the daemon's service
    factory_agents_ls.py                `factory agents ls`
    factory_claims.py                   lock file: a folder and a task per agent; worktrees; clean
    factory_status.py                   `factory status`: agents, PRs, CI and tasks at a glance, read-only
    factory_prs.py                      `factory prs`: the manager's one list; the CI rule and marker reading `status` shares
    factory_issues.py                   tasks as GitHub issues: pick, claim, tick, block, release, stale
    factory_env.py                      per-agent ports and database
    factory_follow.py                   `factory follow`, `say`, `remote` and `agent --detach`
    factory_remotes.py                  remotes, ssh calls and finding sessions by name
    factory_doctor.py                   `factory doctor`: checks a machine and project, read-only
    factory_release.py                  `factory version | releases | update | rollback`: the release client
    factory_bootstrap.py                `factory bootstrap`: machine, project, status, uninstall (plan first, --apply as root)
    factory_bootstrap_core.py           the steps and actions bootstrap is built from, and the executor
    factory_bootstrap_machine.py        the root steps: packages, user, subuid, linger, guard, SSH, keep awake
    factory_bootstrap_project.py        the user's steps: rootless Docker, Node, Claude Code, checkout, runners; the human steps
    factory_netguard.py                 renders the nftables rules and the guard's systemd unit
    factory_sandbox.py                  `factory doctor --sandbox`
    factory_models.py                   the `models` setting: claude flags per role, effective models
    factory_fix.py                      `factory fix`: format and auto-fix the changed files (`commands.fix`)
    factory_run_check.py                `factory run-check`: a quiet check with the full log on disk
    factory_messages.py                 the message envelope (`factory-msg`): build, parse and states (docs/messages.md)
    factory_cards.py                    agent cards: who an agent is and what it can do, as data
    factory_clock.py                    the one clock the scripts share; tests can set the time
    factory_reviews.py                  which extra reviews a change needs
    factory_report.py                   `factory report`: per-task timings, rework rounds and CI runs from GitHub
    factory_settings.py                 `factory settings`: the commands (list, get, set, unset, help, diff, validate, pr, docs)
    factory_settings_schema.py          the table that describes every setting: help, limits, defaults, README tables
    factory_settings_store.py           reads and writes factory.json and the machine file (order, indent, atomic)
    factory_settings_interactive.py     the interactive menu behind `factory settings`
    factory_settings_save.py            `factory settings pr`: branch, commit, push and open the pull request
    factory_usage.py                    `factory usage`: tokens per task from the local Claude Code logs
    factory_artifacts.py                `factory artifacts`: repo copies of artifacts and designs, the manifest, status
    factory_handover.py                 `factory handover snapshot`: the state a manager hands over, read from GitHub
    factory_init.py                     `factory init`: the project's scaffold (roles, labels, owner queue, PRD stub)
    factory_flow.py                     `factory prd --stage`: the flow stages and the owner's gates
    factory_po.py                       `to=po` questions: their level (product owner, dev manager, owner) from age and whether a PO runs
    factory_prd.py                      `factory prd`: progress against the PRD, per user story
    factory_signoff.py                  `factory signoff`: the sign-off and testing queue (plans, confirmations, results)
    factory_verify.py                   `factory verify`: what CI runs, here, before a PR (`commands.ci`)
    factory_guard.py                    the CI guard
    style_checks.py                     CI: each style's check
    factory_config.py                   reads factory.json, with defaults
    wait_for_merge.sh                   waits on a PR without spending tokens
    factory_wait.py                     the other waits (ci, answer, slot, ready) and the dev manager's precheck
    factory_tick.py                     `factory manage-tick`: the precheck, then one manage-pass session only when there is work
    factory_turbo.py                    `factory turbo`: the shared Turborepo cache (status, install, down, env, ci-env)
  ci/                                     `factory ci`: ci.sh (the commands), loop.sh (installed as <name>),
                                          compose.yaml, compose-light.yaml, compose-caches.yaml, compose-turbo.yaml,
                                          runner.Dockerfile, install-tools.sh, entrypoint.sh, ci_names.py,
                                          ci_status.py
  kit/                                    what a project is given (templates, agents, skills, settings); its
                                          factory, factory-loop.sh, .claude/hooks and .claude/ci are forwarders
    CLAUDE.factory.md                     template for the project's CLAUDE.md
    .claude/factory.json                  template: the project's config
    .claude/factory/notes/                template: the project's notes for the agents
    .claude/factory/lessons.md            template: the curated lessons file (empty)
    .claude/settings.json                 permissions and hooks
    .claude/agents/                       reviewer, architecture-reviewer, safety-auditor, security-reviewer, test-writer
    .claude/skills/                       next-task, design-check, eval
    .claude/skills/manage-pass/           the dev manager's standing rules (one page)
    .claude/skills/product-pass/          the product owner's standing rules (one page)
    .claude/manager/settings.json         the dev manager's settings profile (gh api, read-only git, no pushes to main); a release installs and updates it
    .github/                              template: CI workflow, factory-task issue template, CODEOWNERS
    docs/                                 templates: build plan, blocked list, decision template
```

Run a test file with `python3 software-factory/tests/test_pr_gate.py` (each file runs its own tests).

</details>

<br>

## Appendix: projects that use the submodule

Some projects still take the factory through a git submodule (`vendor/my-skills`). This part is for them.

### Moving a project from the submodule to releases

A project that takes the factory from the submodule has its engine files as links. A release does not overwrite links:
`factory update v0.1.0-alpha.1` (or `--release`) stops with `[linked_install]` and changes nothing. The move is its own
reviewed pull request, and today most of it is by hand:

1. **Start from a clean main** and make a branch for the move.
2. **Remove the links the installer made** for the engine files: `.claude/hooks/*`, `.claude/ci/*`, the agents and skills
   the factory ships, `.claude/settings.json`, `.claude/manager/settings.json`, `factory` and `factory-loop.sh`. By hand;
   no command does this step yet. Keep your own files (`.claude/factory.json`, `.claude/factory/notes/`, `CLAUDE.md`).
   Keep the `.claude/skills/nestjs-*` links if you use them (see the next section). Commit the removal on the branch:
   `factory update` refuses a tree with uncommitted changes (`[dirty_tree]`) when the project has no pin yet.
3. **Install the release.** `factory` is gone with its link, so run the client from the submodule that is still there:
   `python3 vendor/my-skills/software-factory/hooks/factory_release.py update v0.1.0-alpha.1`. It writes real files, the
   pin `.claude/factory/release.json` and no templates over yours.
4. **Decide about the submodule.** A project that uses the nestjs skills keeps `vendor/my-skills` for them only; a
   project that does not removes the submodule, its `.gitmodules` entry and the `submodules: true` lines in CI. Both are
   by hand.
5. **Check:** `factory doctor` is green, and `factory version` shows the release.
6. **Commit the install and open the pull request.** `.claude/` and `.gitmodules` are normally in `protected`, so the
   dev manager or the owner merges it. After that, `factory update` is the only way the factory changes in the project.

Steps 2 and 4 are the parts still manual. Moving Remanual, the first project, is the owner's merge.

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

*This section is for a project still on the submodule. A project with `.claude/factory/release.json` uses
[releases](#updating-from-releases).*

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
| `factory update` | Runs both of the above, lists the new my-skills commits, re-runs `install.sh . --link` to link any new shared files (`--layout new` also switches the links to the new folders), and tells you to commit. It doesn't commit or push | Yes, like `--remote` |
| `git config submodule.recurse true` | One setting per clone (not committed). After it, `git pull`, `checkout` and `switch` also update the submodule to the pin | No |
| `git clone --recurse-submodules <url>` | Clones the project with the submodule checked out | No |

**After the update PR merges:**

- **Running agents need nothing.** Between tasks the loop goes back to `origin/main` and runs
  `git submodule update --init`. If `factory-loop.sh` changed, it [restarts itself](#agent-loops). Each new Claude
  session also runs `git submodule update --init` in its SessionStart hook, so it uses the new hooks.
- **Your own clones:** `git pull` moves the pin but, without `submodule.recurse`, leaves the files where they were.
  `git status` then shows `modified: vendor/my-skills (new commits)`. Run `git submodule update --init` to fix it.

<br>
