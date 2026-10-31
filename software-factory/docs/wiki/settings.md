# Settings and style guides

Every setting in `factory.json`, with its default, and the style guides the agents follow.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [Style guides](#style-guides)
- [factory.json settings](#factoryjson-settings)

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

Link the skills from my-skills into `.claude/skills/` (see the [my-skills README](../../../README.md)). On those paths:

- CI runs the `check` (`factory check` runs it locally);
- the `architecture-reviewer` reviews against the guide;
- the PR gate needs its pass.

Files that don't follow the guide yet go on a legacy list (`structure.legacy`). The list only shrinks.

<br>
## factory.json settings

The template has every key with a short `_about`. Missing keys fall back to the defaults in `factory_config.ts`.
`factory settings` is how you browse, understand and change them without editing JSON. In a terminal it opens a menu
(plain prompts on the terminal, no extra packages, so it works over SSH):

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
factory settings pr [--ready]                         # propose the staged changes, else the edited file, as one pull request (a draft by default)
factory settings set --stage maxOpenPRs 5             # stage a change instead of writing the file (unset --stage too)
factory settings diff --staged                        # what is staged
factory settings unstage [maxOpenPRs]                 # drop one staged change, or all
factory settings --local set remoteControl off        # the machine scope (below)
```

Staging (#306) is how the cockpit collects changes: each `set --stage` is kept in the git directory, not in the
file, and `factory settings pr` puts them all in one pull request. It builds that on the main branch as `origin` has it
now, in a temporary worktree, so it works from any checkout and after main has moved on. It checks each staged value
again first: if one is no longer valid (or no longer a setting) it stops, opens nothing and says which to `unstage`.
Machine settings (`--local`) are saved at once, never staged.

`validate` fails on: a regex that does not compile, a `tasks.source` that is not `plan` or `issues`, a duplicate or
invalid agent name, an integer below its minimum (`maxOpenPRs`, `portStep` ... at least 1), a `prd`, `plan` or
`decisions` path that does not exist, a bad `models`, `styles` or `agentEnv` value, and `agentEnv` ports that collide
across the agents' slots. A key that is not a setting is only a warning (probably a typo); it is kept and ignored.
Saving keeps the file readable: key order and `_about` entries stay, the file's own indent is kept, and the write is
atomic.

**Only people change settings.** `.claude/` is protected, so a project change reaches main through a pull request.
`set`, `unset`, `pr`, `--local` changes and saving in the menu refuse inside an agent session (`FACTORY_AGENT`,
`FACTORY_LOOP` or `CLAUDECODE` is set); `settings.json` denies them and the PR gate blocks them, also inside `bash -c`.
Reading (`list`, `get`, `help`, `diff`, `validate`) stays allowed. Nothing merges settings by itself: the owner merges the pull request, because it changes
`.claude/` (#247).

**Machine scope** (`factory settings --local ...`, section 10 of the menu). Some settings belong to a machine, not the
project, so they live in its own file outside the repo (`factory machine show` prints where) and are never committed:
`agents` (the names this machine runs; `FACTORY_AGENTS` overrides), `remoteControl` (start sessions with Remote Control;
`FACTORY_REMOTE_CONTROL=0|1` overrides), `autostart`, `autostartAgents` and `autostartReport`. The order of precedence
is the defaults in `factory_config.ts`, then the project file, then the machine file (machine keys only), then the
environment.

**One table describes every setting** (`hooks/factory_settings_schema.ts`): key, type, default (read from
`factory_config.ts`), section, short and long help, examples, who reads it, who must approve a change, and how a value is
checked. The list, `help`, `validate`, the menu and the tables below are all generated from it, so they cannot drift.
A test fails when the tables below are out of date; refresh them with `factory settings docs --write`. The `_about`
strings in the template stay readable, but this is the documentation.

<!-- settings:begin -->
(Generated by `factory settings docs --write` from the settings table in `hooks/factory_settings_schema.ts`:
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
| `artifacts.fetch` | str | `""` | A command that exports the artifact `{url}` into the folder `{out}`, for `factory artifacts pull`. Empty: pull takes an export made by hand (`--from`). Unattended sessions have no artifact tool (#104), so this is your own exporter. |
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
| `structure.roots` | list | `[]` | Folders the structure check (the hexagonal skill's check_structure script) looks at, when a style uses it. |
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
| `reviewMarkers` | str | `"tmp/reviews"` | Where the re-review history (`<branch>.reviews.json`) is kept. Review passes are not: they are in the git folder (`factory-reviews`, #260). |
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
| `roles.product-owner.minReady` | int | `4` | Issues mode: when fewer `factory:ready` tasks than this can start now (no open `Depends on`, not claimed), the product owner has a planning pass: it files the next tasks from approved stories. 0: off. |
| `roles.product-owner.busyMinutes` | int | `30` | Minutes the product owner's loop waits after a pass that had work. |
| `roles.product-owner.idleMinutes` | int | `60` | Minutes it waits when there was none. 0: it exits instead. |
| `roles.product-owner.escalateMinutes` | int | `120` | A question addressed `to=po` that nobody answered moves up one level after this many minutes: product owner, then dev manager, then the owner. With no product owner running it starts at the dev manager. |
| `roles.product-owner.logins` | list | `[]` | GitHub logins whose answers count for the product owner. Empty: any login. An answer from another login is ignored. |
| `roles.product-owner.artifacts` | bool | `false` | Let the product owner's interactive (`-i`) sessions use the `Artifact` and `DesignSync` tools to read claude.ai artifacts live. Off: its sessions deny them. The dev manager and the coding agents never get them. Read from main. |
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
| `permissionMode` | one of acceptEdits/default | `"acceptEdits"` | How unattended `claude -p` runs get their permissions: acceptEdits (the default) or default (your own Claude Code settings decide). |
| `waitMinutes` | int | `1` | How often an idle loop looks for work. 0: it exits instead. |
| `views.cacheSeconds` | int | `45` | How long `factory prs`, `factory watch` and `factory messages ls` answer from their cache instead of asking GitHub; they say how old it is, and `--fresh` asks now. 0: no cache. |
| `github.reserve` | int | `500` | GitHub's API limit is shared by every agent on the account (5,000 calls an hour). When fewer than this many are left, idle loops wait twice as long, so the limit is not used up. 0: never slow down. |
| `models` | dict | `{}` | The model per role (builder, manager, product-owner, test-writer, reviewer, architecture-reviewer, safety-auditor, security-reviewer): {"builder": {"model": "opus", "effort": "high"}, "reviewer": {"model": "sonnet", "escalateTo": "opus"}}. effort (low, medium, high, xhigh, max) is for builder and manager only. A role with no entry keeps today's model: the agent file's, or Claude Code's default. |
| `budget.builder` | int | `null` | The token budget of a task whose issue has no `Budget:` line, counting fresh input (input + cache writes) + output as `factory usage` reports them. Advisory: shown and compared, a warning at 80%, never a stop. Empty: no budget. |
| `permissions.allow` | list | `[]` | Extra Claude Code allow rules for this project's agents, like "Edit(src/**)". A rule applies on an agent's next run once the pull request from `factory settings pr` is merged: the factory adds them to the agents' settings, after the release's own. |

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
| `ci.runners` | int | `1` | Heavy runner loops per machine (each with its own Docker); a machine's own count (`factory ci runners <n>`) and FACTORY_CI_RUNNERS win over it. |
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
| `ci.runners` | int | `null` | Heavy CI runners for this project on this machine (`factory ci runners <n>`); wins over the project's `ci.runners`. Empty: the project's. |
<!-- settings:end -->

<br>

<details>
<summary>The files in the kit</summary>

<br>

Previous: [A sandboxed machine](sandboxed-machine.md) | Next: [The files in the kit](kit-files.md)
