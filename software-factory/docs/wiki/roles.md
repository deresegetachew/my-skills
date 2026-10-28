# Roles

The three roles that work in a project: coding agent, dev manager and product owner.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [Roles: coding agent, dev manager, product owner](#roles-coding-agent-dev-manager-product-owner)

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
| Settings | the agents' settings (`.claude/factory/settings.json`, passed at start) | `roles.dev-manager.profile` | `roles.product-owner.profile` |
| Model | `models.builder` | `models.manager` | `models.product-owner` |
| Wait after a pass | `waitMinutes` (inside the loop) | `manager.busyMinutes` (2) / `manager.idleMinutes` (5) | `roles.product-owner.busyMinutes` (30) / `idleMinutes` (60); 0 idle: exit |

Only the coding agent claims a task. Managers and product owners register as live agents (`factory agents` shows the
role) and keep pinging while they wait, so the sweep does not take a sleeping manager for a dead one. A role's profile
is used only when its file exists; then its sessions read just the user's settings and the profile, not the project's
own `.claude/settings.json` (the coding agents' settings deny `gh api`, which the manager and product owner need).
Claude Code then does not load the project's skills either, so a role session's prompt does not start with
`/manage-pass`: it says to read `.claude/skills/manage-pass/SKILL.md` (or `product-pass`) and run it for the item.

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

**What gives the role work** (`factory_roles.ts work product-owner`, one line each): an open issue or PR with
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

Tested end to end in `tests/flow.test.ts` with fakes (a fake `claude` that runs the session's steps, a fake `gh`): init, the
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
- It lives under `.claude/` on purpose: the agents' settings deny editing `.claude/**`, so the
  instructions that govern a role change only through a reviewed pull request.
- `install.sh` scaffolds it for a new project, `factory init-roles` for an existing one (it never overwrites), and
  `factory doctor` reports every path in a `reads.md` that does not exist.

**Migrating from `notes`.** The `notes` folder (`<notes>/reviewer.md`, `manager.md`, `next-task.md` ...) keeps working.
When a role has no folder, its pass is told to read `<notes>/manager.md` (dev manager), `<notes>/product-owner.md`
or `<notes>/next-task.md` instead. To move: run `factory init-roles`, copy the note's text into the role's
`README.md`, delete the note, and commit both in one PR. Remanual's `.claude/factory/notes/` needs no change.

<br>

Previous: [Agent loops](agent-loops.md) | Next: [Reviews and gates](reviews-and-gates.md)
