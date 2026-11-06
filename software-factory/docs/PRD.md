# PRD: the software factory

Status: merged (#151). Written 25 Oct 2026 against `main` at commit `b956dbf`; the status wording (what is built, what is
in a pull request, what is published) was brought up to date on 27 Oct 2026 against `main` at commit `973ccda` and the
releases page. It replaces the draft in PR #39 (see [What happened to PR #39](#what-happened-to-pr-39)). Task
issues: #150, #187.

This is the scope of the factory: what it is for, who uses it, what is decided, what is in and out, and what is later
or open. The tasks are GitHub issues, in the order of #114. How the factory works and every setting is in
[README.md](../README.md); the dev manager's rules are in [DEV-MANAGER.md](../DEV-MANAGER.md). If this page and a
decision comment disagree, the newer owner decision wins and this page is wrong: fix it.

**How to read it.** Every statement comes from an issue, a decision comment or the code, and names the issue. Nothing
here is a number we made up. A line that starts `> Open question:` is not decided. Each story has a status:

- **Built**: in `main` today.
- **PR open (#n)**: written, in a pull request that is not merged yet.
- **Decided**: the owner chose it, nothing is built yet.
- **Proposal**: written in an issue for the owner to correct; he has not agreed it. The code for it may already be in
  `main`; the story's scope is still his to correct.

## 1. What the factory is

The factory turns a repo into a software factory. Coding agents run on the owner's machines and build the project one
task at a time: failing tests first, then the code, then reviewer subagents, then a pull request. A dev manager reviews
and merges, answers the agents' questions and keeps them busy. A product owner role handles product questions (the runner, the skill, `factory prd` and the sign-off queue are built: #101, #102).
Hooks, CI and GitHub's branch protection stop work from merging when it should not. Only decisions that are the owner's
reach the owner (README, intro; #95).

Three ideas hold it together (README, "How it fits together"):

1. The repo holds the state, not a session. Every task and every manager pass starts with a fresh, small context.
2. No agent grades its own work. Reviewer subagents, CI and the dev manager each check what the agent cannot edit around.
3. The rules are shared, the config is the project's. Agents, skills and hooks come from my-skills; a project only says
   what is specific to it.

The factory's code lives in this repo (`my-skills`), under `software-factory/`. A project gets it as a numbered release
(#113, #112).

## 2. Decisions taken (scope)

These are settled. Agents and managers build on them and do not reopen them. "Recorded" means the owner answered "your
call" or "do what u think is best" and an agent wrote down its choice; the owner can change it.

| # | Decision | Source |
|---|---|---|
| D1 | *Replaced by the web UI, `factory ui` (decision 0005, 5 Nov 2026); the cockpit was retired in #425 (6 Nov 2026), and `factory cockpit` now only says it moved there. As decided before:* **One terminal window, the cockpit** (`factory cockpit`), built on tmux. The left side lists the sessions and the views. The right side is the selected agent's real Claude Code session, or a view. tmux hosts the live sessions and provides popups, the status line and keys; the sidebar and views are Ink (React for terminals) components, bundled into one file at release, so a project still installs no npm package (decision 0002, 31 Oct 2026). The cockpit needs tmux 3.2 or newer. Every screen is built on one core of factory commands, and the plain text commands (`factory status`, `factory agents ls`, `factory follow`, `factory prs`) stay. It replaces the earlier D1, "No custom UI" (the Claude app plus a Remote Control `-i` session as the UI). A web console, Claude Code's agent view and VS Code's Agents window were set aside. | #295 (owner, 28 Oct 2026), [decisions/0001-cockpit.md](decisions/0001-cockpit.md), [0002](decisions/0002-cockpit-ink.md) (owner, 31 Oct 2026), [0005](decisions/0005-web-ui.md) (owner, 5 Nov 2026), #425; earlier: #114, #97, #101, #106 |
| D2 | **The factory installs from numbered releases** of my-skills: an archive plus a SHA-256 checksum file, on GitHub. The submodule goes away (the old submodule step keeps working until a project migrates). | #113 (owner, option D) |
| D3 | **The installed factory is committed in the project's repo** as real files with a pin file saying which release, so a fresh clone works and an update is a reviewable diff. *Recorded.* | #113 |
| D4 | **Versions are semantic**, such as `v1.4.0`. *Recorded.* | #113, `software-factory/VERSION` |
| D5 | **my-skills builds itself with its own factory.** Its task list is this repo's GitHub issues; it has its own `CLAUDE.md`, `.claude/factory.json`, agents, review gate and CI. | #112 (owner), #141 |
| D6 | **The factory's code moves out of `.claude/`** into `software-factory/`, keeping its current names (`hooks/`, `ci/`, `factory`, `factory-loop.sh`, `tests/`). What a project needs at those paths (agents, skills, the agents' rules, the hooks they call) stays in its `.claude/`. One pull request per step. *The names and the guard entry were recorded. Done: the `kit/` forwarders are gone (#176).* | #112 |
| D7 | **The dev manager is an orchestrator**: a loop script with no model that starts one-item sub-managers. The long cloud session stops managing and goes back to building my-skills and its factory. Scheduled tasks are paused by the owner and are not part of the design. | #97, #109, #95, #100 |
| D8 | **Roles are factory commands run in a terminal**, on any machine, several of each, one fresh pass each: `factory coding-agent\|dev-manager\|product-owner [name] loop [-i]`. The role folder is committed in the project at `.claude/factory/roles/`; the PRD, designs and research stay in `docs/` and `design/`. The product owner role is generic, not Remanual-specific. | #95, #102 |
| D9 | **All roles share one GitHub account.** A marker or claim names the role and name inside its body. `trustedReviewers` cannot tell roles apart. | #95, wiki/roles.md "Roles" |
| D10 | **The factory's own database, the message board, is the record for tasks and the agents' messages; GitHub holds the code, the pull requests, CI and what the PR gate trusts.** Reviewer passes, `factory-approved`, `factory-mustfix`, holds, the review labels, the issues and PRs stay on GitHub, and nothing written on the board changes what may merge. Messages go through a setting: `messaging.transport` is `board` on a machine with a board (`factory board up`, or `factory machine join` on another machine), else `github`; the kinds in `messaging.kinds` (claims, wake-ups, the pull request feed, questions between agents) go to the board, one kind at a time, and a send the board doesn't take falls back to GitHub. With `tasks.source: board` the tasks and every message are on the board. **NATS was removed** (owner, 6 Nov 2026; #504): it was the second transport (decision 0004) until the board carried wake-ups, claims and the pull request feed (#500). Earlier forms of this row: "GitHub is the record; agents' messages go through a setting, GitHub by default, NATS as a plugin" (decision 0004), and before that "GitHub is the state and the transport; nothing opens a port or adds a service". *Being built: the kinds move one at a time (0007 point 9; the owner queue on the board is #502).* | #97, [decisions/0007](decisions/0007-own-record.md) (owner, 6 Nov 2026), [decisions/0004](decisions/0004-agent-messaging-nats.md) (superseded), [messages.md](messages.md), wiki/agent-loops.md "Messages between agents" |
| D11 | **Agents run the agreed process and do not change it** (owner's rule, 21 Oct 2026). Agents cannot edit what governs them: the PR gate, the guard, the agents' rules (`.claude/factory/settings.json`), agent definitions, `.claude/factory.json`, `factory` and `factory-loop.sh` are protected. | DEV-MANAGER.md, my-skills `CLAUDE.md`, `.claude/factory.json`, #263 |
| D12 | **Owner-only actions** (the list below). | #150, #114, `manage-pass` skill, `CLAUDE.md` |
| D13 | **The factory's runtime is Bun.** Every script is TypeScript run by Bun (Bun and Node built-ins only, no npm package at runtime), plus bash. The one exception is build time: the web UI's React and react-dom are bundled into one JavaScript file at release (decision 0005, as decision 0002 first did for the cockpit's Ink and React), so a project installs nothing and gets no `node_modules`; no package is added this way without the owner. The plugin mechanism of decision 0004 (an npm package inside `software-factory/plugins/<name>/`, bundled at release) existed only for the NATS client and went with it (#504). There is no Python in the factory. It replaces the earlier rule "Python 3 standard library only" (3.11 syntax at most). A project's own code may still be Python. | #252 (owner, 26 Oct 2026), decisions 0002 and 0005, `CLAUDE.md` |
| D14 | **The agents' rules are passed only to the sessions the factory starts.** `factory loop` and `factory agent` start Claude with `--settings`: `.claude/factory/settings.json` and the `permissions.allow` from `.claude/factory.json`, both read from `main` on origin, never from the agent's own folder. A project's own `.claude/settings.json` stays the project's and still applies. The Stop check runs only in a factory run. So the owner's own sessions in a project are not governed by the agents' rules. | #258, #256 (owner, 27 Oct 2026) |
| D15 | **Token budgets are per task and advisory.** The unit is one task (issue); it counts fresh input (input + cache writes) + output as `factory usage` reports them, never money or cache reads. It is set by a `Budget:` line in the task issue, else `budget.builder` in factory.json. The budget is taken from the issue when the task is claimed, and a coding agent may not change it. Over 80% the checkpoint warns; there is no hard stop, because stopping mid-change leaves broken branches. An overrun is the dev manager's call at review; CI never fails on it. | #183 (owner, 28 Oct 2026) |

**Owner-only actions.** An agent or manager writes these as a proposal ("this needs your yes: ...") and waits. A yes for
one is not a yes for the next (DEV-MANAGER.md; `manage-pass` skill).

- **Publishing a release**: bumping `software-factory/VERSION`, tagging `vX.Y.Z` and pushing the tag. Nothing else
  publishes one (#113, wiki/updating.md "Cutting a release", `CLAUDE.md`).
- **Closing issues.** The dev manager may not close them without his yes (#114, handover comment).
- **Merging protected changes** (paths in `protected` in `.claude/factory.json`, such as `CLAUDE.md`, `.claude/`,
  `.github/`, `install.sh`, the PR gate and the guard) (#150, `CLAUDE.md`).
  > Open question: README, DEV-MANAGER.md and `CLAUDE.md` say "the dev manager or the owner" merges protected changes,
  > and DEV-MANAGER.md says the dev manager reviews and merges protected PRs too. `factory prs` says
  > `owner merges (protected)`, and #150 lists protected merges as owner-only. Which is it? This page follows #150.
  > Decided for `.claude/` (#247): a change under `.claude/` (a `factory settings pr`, permissions, the agents' rules,
  > the agents' definitions) is merged by the owner, never by the dev manager; the settings help, `factory settings pr`,
  > the `manage-pass` skill, DEV-MANAGER.md and CODEOWNERS say so.
- **Scope and task order**: adding tasks beyond review follow-ups, unblocking, reordering, freezing (the order is
  issue #114) (`manage-pass` skill, #114).
- **Any change to the factory**, the dev manager's own rhythm, merging a manager's own pull requests, anything on the
  owner's computer, and rewriting history (`manage-pass` skill).
- **Pushing to `main`**: nobody, including the owner's agents (`CLAUDE.md`).

## 3. Roles

| Role | What it is | Runs | Source |
|---|---|---|---|
| **Owner** | The one human. Decides what is his; reads the owner queue. | Claude app on a phone or PC | #114, #97 |
| **Coding agent (builder)** | A fresh Claude session per task, named (menelik, taytu, ...). | `factory loop [-i]` on any machine | wiki/agent-loops.md "Agent loops" |
| **Dev manager** | Orchestrator (no model) plus one-item sub-managers (a Claude session each). Reviews, merges within the owner's rule, answers questions, sweeps dead agents. | `factory dev-manager loop [-i]` on any machine | #97, #109, #102 |
| **Product owner (PO)** | Generic role for product questions, the PRD, task order proposals and sign-off. | `factory product-owner loop [-i]` | #101, #110, #102 |
| **Reviewer subagents** | `reviewer`, `architecture-reviewer`, `safety-auditor`, `security-reviewer`, and the `test-writer`. | Inside a builder's or manager's session | wiki/reviews-and-gates.md "Reviews and gates" |
| **CI runner** | GitHub's, or the owner's own machine. | `factory ci` | #40 and the issues in section 4.7 |

## 4. User stories

### 4.1 Builder (coding agent)

- **B1.** As a builder, I never choose a task by reading the plan: `next_task.ts` hands me the next one. Rework on my
  open pull request (a must-fix naming its head commit, from someone in `trustedReviewers` when that list is set, #263) comes first; then a new task, by milestone and then issue
  number, skipping any whose `Depends on` is still open. *Built.* (wiki/agent-loops.md "Tasks")
- **B2.** As a builder, I claim an issue so that two agents, on one machine or on two, never build the same task. The
  earliest claim wins; the loser picks again. When a loop run ends, claims that have no branch or pull request are given
  back, and `factory next` says which issue a down agent still holds. *Built.* (wiki/agent-loops.md "Issues mode"; #45, #191, #192)
- **B3.** As a builder, every task starts in a fresh Claude session, so no task carries the last one's context.
  `factory loop` runs unattended; `factory loop -i` opens a session the owner can watch and type into. An unattended run
  gets `--permission-mode` from the `permissionMode` setting (default `acceptEdits`), `factory doctor` says `fix` when a
  headless run would stall, and a headless loop in a folder Claude Code does not trust stops before it spends tokens.
  *Built.* (#56, #179, #180, #193)
- **B4.** As a builder, I write failing tests first (`test-writer`), build, ask the reviewers, and open one small pull
  request with `Closes #<n>` and the tests. *Built.* (wiki/reviews-and-gates.md "Reviews and gates"; `CLAUDE.md`)
- **B5.** As a builder, the PR gate only lets me open a ready PR when the reviewer passed this exact commit, `factory
  verify` passed it (when `commands.ci` is set), and fewer than `maxOpenPRs` of my PRs are open. It blocks with a reason
  and fails closed. *Built.* (wiki/reviews-and-gates.md "The PR gate"; #58)
- **B6.** As a builder, I merge my own PR only when the gate allows: reviewer pass for the head, CI green, no
  `factory-hold`, no must-fix after the last approval, no protected file changed. The merge carries
  `--match-head-commit`. The gate refuses `--admin`, merges, labels and reviews through `gh api`, and force pushes,
  however the command is quoted. *Built.* (wiki/reviews-and-gates.md "The PR gate"; #263)
- **B7.** As a builder, I ask a question as a `factory-question` comment and keep working on something else while I wait.
  *Built.* (wiki/dev-manager.md "The dev manager"; #107)
- **B8.** As a builder, I wait for a PR slot, CI, an answer, a merge or a ready task with a shell loop that costs no
  tokens, and I never poll in the conversation. *Built.* (#71)
- **B9.** As a builder, I have my own folder, ports and database, and my name is unique across machines; a second machine
  that takes my name is refused. *Built.* (wiki/agent-loops.md "Names and folders"; #45, #48)
- **B10.** As a builder, I read only what the task points to, see only failing lines of a failing check, get my changed
  files formatted for me, and read the short lessons file first. *Built.* (#57, #61, #68, #69, #72)
- **B11.** As a builder, I cannot change what governs me: no edits to `.claude/`, `vendor/`, `CLAUDE.md` or the PRD, no
  settings changes, no dev manager markers, no `gh api`. My rules come from `main`, so an edit in my own folder does not
  loosen my next run. *Built.* (wiki/reviews-and-gates.md "The PR gate", `.claude/factory/settings.json`; #258)
- **B12.** As a builder, an interrupted machine does not lose my unfinished work: `factory autostart` brings the stack
  and my session back, after saving uncommitted and unpushed work. *Built.* (#88)
- **B13.** As a builder in a new worktree, my hooks and deny rules load before I run. *Built.* (#46)
- **B14.** As a builder, `factory issues show N` prints the task's text and then the people's comments on it, so a decision
  posted after the issue was written reaches me. Factory marker comments (claim, approved, mustfix ...) are left out.
  The owner puts decisions into the issue text, and later comments are read too. (#204)

### 4.2 Dev manager (orchestrator and one-item sub-managers)

- **M1.** As the owner, the dev manager's loop is a script with **no model**. Each cycle it runs `factory precheck` and
  starts work only when something needs a manager, so an idle cycle costs no tokens. *Built: the single pass
  (`factory manage-tick`, #143) and the orchestrator (#137; #97 with #109).*
- **M2.** As the orchestrator, for each item that needs a manager (a PR, a question) I start a **one-item
  sub-manager**: `claude -p` (or `-i` when the owner opens it) on the manager settings profile, with the item's fact
  sheet, its note and a lease. It exits when its item is done. *Built.* (#137; #97)
- **M3.** As the owner, at most 2 sub-managers run at once, as the setting `manager.maxSubManagers`; the rest wait for
  the next cycle. *Decided, recorded; built (#137).* (#97)
- **M4.** As the owner, the orchestrator does not start builders. Builders keep their own `factory loop`, so a builder
  fault cannot stop the manager and the reverse. *Decided, recorded.* (#97)
- **M5.** As a sub-manager, I am one session per item. My memory is a note comment on the task issue (on the PR when there
  is no issue); it is not a cache. `factory:in-progress` opens the thread, `factory:in-review` starts the review
  sub-manager, closing the issue ends the thread. *Decided, recorded; built (#137).* (#97)
- **M6.** As the owner, I am told through GitHub itself: a `factory-question` comment or an item on the owner-queue
  issue that mentions me, which reaches my phone through GitHub notifications. No new service. *Decided, recorded.* (#97)
- **M7.** As the owner, if items wait longer than N minutes (default 30) with no dev manager activity, a dead-man's
  switch starts a fresh manager and tells me which PRs wait, on the same channel as M6. *Decided (#109, section 5 kept);
  built (#137).*
- **M8.** As the orchestrator, what "needs attention" is recomputed from GitHub state every cycle, so a missed event hides
  nothing, and a late wake or two managers never review the same head twice. The checks are in #109: a PR head with no
  `pr-watch` marker, an unanswered question, a must-fix or red CI or conflict on a quiet PR, an approved green PR not yet
  merged, a PR waiting too long on the PO or owner, an agent down or idle, a light CI job queued too long. *Decided
  (#109); built (#137).*
- **M9.** As a manager, my standing rules are a skill (`manage-pass`), not a memory: the table of what I do alone and what
  I ask first, the pass order, the exact markers, the hold label and the sha-pinned merge. The project adds to it in its
  own role folder. *Built.* (#96)
- **M10.** As a manager, one command, `factory prs`, gives me every open PR with its head, CI judged by one rule (the
  newest non-skipped run per job decides), the newest marker per commit, any claim, and a next action; then unanswered
  questions and owner asks. *Built.* (#98)
- **M11.** As one of several managers, I claim a review or a question with a lease (`factory manager-claims`), so we never
  do the same item twice, and a manager that dies mid-review does not block a PR. *Built.* (#99)
- **M12.** As a manager, I merge only a head with `factory-approved sha=<head>`, pinned to that sha, with CI judged green,
  and never a PR I opened myself. My profile and `manager_gate.ts` refuse the rest and tell me to write an owner-queue ask
  instead. *Built.* (#96; wiki/dev-manager.md "The dev manager")
- **M13.** As a manager, I answer the builders' `factory-question` comments from the PRD, `CLAUDE.md`, the decisions and
  the sources, and escalate only what is the owner's (scope, legal or customer-facing, money, names, files or keys) as
  `needs-owner:` plus an owner-queue ask with a recommendation. *Built.* (DEV-MANAGER.md; `manage-pass`)
- **M14.** As a manager, I mark dead agents down and put their in-progress issues back to ready (`factory agents sweep`),
  and release quiet issues after checking the agent is gone. *Built.* (wiki/agent-loops.md "Live agents")
- **M15.** As the owner, I reach any item the manager is working on with `factory dev-manager loop -i` from any machine
  with the factory installed, or from the Claude app through Remote Control. `factory follow` lists the one-item
  sub-managers next to the agents. *Built (`-i`; `factory follow` lists sessions named `<manager>-<item>`); the orchestrator that starts them is built (#137).* (#97, #106)
- **M16.** As the owner, the dev manager is handed over from the cloud session to terminal managers without a gap and
  without losing state, and DEV-MANAGER.md is rewritten around the orchestrator. Steps 2 to 5 of the handover run on my
  computer and change my schedule, so they are mine. *DEV-MANAGER.md and `factory handover` are built (#147); steps 2 to 5 are the owner's, and whether they are done is open.* (#100)

### 4.3 Product owner

The PO role is the least built. #101 says plainly: "The boundaries above are my reading of his messages. Nothing is built
until he agrees them."

- **P1.** As the owner, the PO is a generic role, usable in any project: `factory product-owner [name] loop [-i]`, run
  like the other roles on any machine. The project supplies a role folder; the factory supplies the skill. *Runner and
  role folder built (#102); the `product-pass` skill is built (#142).*
- **P2.** As the PO, I own the PRD (scope, stories, numbering), task order and milestones as proposals, answers to
  escalated product questions, product decisions recorded in the project, and the sign-off queue. I never review or merge
  PRs, answer technical questions or touch CI. I never decide scope without the owner's yes. *Proposal; built (#142).*
  (#101)
- **P3.** As the owner, `-i` is the PO's main mode: I chat with the PRD in a session that loads the PRD, designs and
  queues through its `reads.md`. A pass without `-i` only triages and writes a digest and proposals. *Proposal; built
  (#142).* (#101)
- **P4.** As the owner, I see the link between a task and a PRD story and progress against the PRD as plain text:
  a `PRD: US-n` line in the task template and `factory prd`, which prints per story its tasks and their state, computed
  from GitHub. The PRD's story numbers must be unique first. *Proposal; built (#142, #148).* (#101)
- **P5.** As the owner, items only a person can check (test plans, manual tests) wait in a sign-off and testing queue,
  each with how to check it; builders add an entry when a task's "Done when" needs a person. *Proposal; built (#142).*
  (#101)
- **P6.** As the owner, a builder's or manager's product question goes to the PO as `to=po` on the task issue, and the
  builder keeps working. An unanswered question moves up one level (PO, dev manager, owner); with no PO running, the dev
  manager answers or escalates. Coding agents cannot post a PO answer. *Proposal; built (#145).* (#110)
- **P7.** As the PO, I check the comments addressed to me as part of my routine and write each answer where it lasts (the
  task's acceptance criteria, a decision, or a PRD change as a PR). *Proposal; built (#145).* (#110)
- **P8.** As the PO, I use the project's artifacts and designs through repo copies first (`factory artifacts pull`, with a
  manifest of where each came from). Live access is for my interactive (`-i`) sessions only, when the owner turns on
  `roles.product-owner.artifacts` (off by default; unattended passes have no artifact tool); publishing to an artifact needs
  the owner's yes. The dev manager and the coding agents never get it. *Built (#146, #104).* (#104)
- **P9.** As the owner, from an empty folder and the three role commands, I reach an approved PRD, design and task issues
  (vision, design, plan, hand over), then build, check and pivot, with no chat session holding required state. Stage gates
  wait for my approval. *Built (#148); this is the acceptance test of the roles epic.* (#103, #95)
- **P10.** As the PO, I also test the running app: someone sets it up, I write test plans, the owner confirms what is
  tested, and results are recorded. *To be seen; needs a spike.* (#101)

### 4.4 Reviewer

- **R1.** As the reviewer, I review every change before its pull request: I run the checks and the Factory guard, check the
  task, the PRD and `CLAUDE.md`, and record a pass for that exact commit with one command, `factory review-pass reviewer|arch`. A new commit needs a new
  review. *Built.* (wiki/reviews-and-gates.md "Reviews and gates"; #197)
- **R2.** As a specialist reviewer, `architecture-reviewer` reviews changes on paths with a style guide, `safety-auditor`
  reviews changes on its listed paths, and `security-reviewer` reviews changes on its listed paths. The PR gate needs the
  architecture pass on styled paths. `factory reviews` lists which extra reviews a change needs. *Built.*
- **R3.** As a reviewer, after a fix I check only the delta since my last round, with my earlier findings and the builder's
  reply; I do a full review when the delta is large, the base moved or the history changed. *Built.* (#70)
- **R4.** As a reviewer, I read the lessons file first and treat a change that repeats a lesson as a must-fix. *Built.* (#72)
- **R5.** As the owner, no agent grades its own work. The Factory guard in CI fails a PR that deletes or weakens a test,
  changes a golden output, adds `.skip`/`.only`, adds a dependency, reuses a decision number, ticks another task's box or
  uses `pull_request_target`; only the dev manager adds `tests-reviewed` or `deps-reviewed`, after reading the change.
  *Built.* (wiki/reviews-and-gates.md "The Factory guard")
- **R6.** As the owner, subagents use cheaper models where a miss is cheap and the strongest where it is costly: the
  `test-writer`, `architecture-reviewer` and the reviewer's first pass on Sonnet; the `safety-auditor` and
  `security-reviewer` on Opus; a must-fix is re-reviewed on Opus. The `models` setting sets one per role. *Built.* (#82,
  #94)

### 4.5 The owner

- **O1.** As the owner, I can run the factory with plain text commands, and from my phone with the Claude app plus a
  Remote Control `-i` session. Remote Control needs a claude.ai login on a Pro, Max, Team or Enterprise plan. From a
  browser, the web UI (`factory ui`, decision 0005) is the main way; it replaced the terminal cockpit of section 4.10
  (#425). *Built (the commands); changed by the new D1 (#295).* (#114;
  wiki/agent-loops.md "From your phone")
- **O2.** As the owner, I am told only what needs me, each as one item on the owner-queue issue ("Dev manager: needs the
  owner") with the question, a recommendation and the exact command or step, posted once however many managers want to
  post it. *Built.* (#95; `factory manager-claims ask`)
- **O3.** As the owner, I can stop any role with Ctrl-C or one command, and every claim it held is dropped. *Built.* (#95,
  wiki/agent-loops.md "Agent loops")
- **O4.** As the owner, I see the whole factory at a glance, read-only, across machines: `factory status` (agents, claims,
  PRs, CI queue, tasks), `factory agents ls`, `factory prs`, `factory report`, `factory usage`. *Built.* (#64, #65, #108)
- **O5.** As the owner, I watch and talk to any agent or sub-manager by name from my own terminal, wherever it runs:
  `factory follow <name>`, `--read` to watch only, `factory say`. The ssh target must be a sandbox user, never an admin
  account. *Built.* (#106)
- **O6.** As the owner, the order of work is mine. It is issue #114; agents keep that order unless I change it. *Decided.*
  (#114)
- **O7.** As the owner, branch protection on `main` is the lock, and the PR gate and hooks are guard rails for well-meaning
  agents. Everything is opened under one account, so branch protection requires a pull request with 0 approvals, the CI
  checks, no force pushes and no bypass. *Built (documented).* (wiki/reviews-and-gates.md "Branch protection")
  > Open question: #261 (from the #43 audit) says the real merge boundary needs the agents on an account without admin
  > rights and branch protection that requires the checks and a review. `factory doctor` now checks both and the
  > setup is documented (wiki/reviews-and-gates.md); setting it up on GitHub is the owner's.
- **O8.** As the owner, secrets never enter the repo or an agent's prompt. Agents are denied reading `.env` files, and
  the factory never reads, prints or stores a token or key. *Built.* (wiki/sandboxed-machine.md "Security notes", "bootstrap")
- **O9.** As the owner, my-skills is built by its own factory: its tasks are issues with the `factory:*` labels, its
  agents and gate are the ones any project gets, and its protected paths include the gate, the guard, the agents' rules,
  the agents, skills and CI. *Built.* (#112, #141)
- **O10.** As the owner, my own Claude sessions in a project are mine: the agents' deny list, hooks and Stop check apply
  only to the sessions the factory starts. *Built.* (D14; #256, #258)

### 4.6 Install and update (releases)

- **U1.** As the owner, the factory is delivered as numbered releases built by a workflow in this repo: on a `vX.Y.Z` tag
  it checks the tag is on `main` and matches `software-factory/VERSION`, runs the tests, builds the archive with
  `tools/build_release.ts`, verifies the checksum and publishes with `SHA256SUMS` and notes. *Built.* (#113, #119;
  `.github/workflows/release.yml`)
  Four pre-releases are published: `v0.1.0-alpha.1` (#184) to `v0.1.0-alpha.3` are the Python factory, and
  `v0.2.0-alpha.1` is the first on Bun (D13). A tag with a hyphen is a pre-release, so you name it to install it.
  > Open question: no full release (such as `v0.1.0`) exists yet. Cutting it is the owner's call, and whether it is cut
  > from the current `main` was not answered in #113.
- **U2.** As anyone, four commands cover the whole lifecycle: `factory version`, `factory releases`, `factory update
  [version]` and `factory rollback`. With only a pre-release published, `factory update` names it in its fix (`factory update
  v0.1.0-alpha.1`) and `factory version` shows it. *Built.* (#113, #126, #188)
- **U3.** As the owner, `factory update` does the whole job in one command and is safe to run twice. It refuses a dirty
  tree and names the files; downloads the archive and checks its SHA-256 (a mismatch or a cut transfer installs nothing);
  unpacks with every path checked; writes the files, undoing everything if a write fails; refreshes this machine's CI
  runner services and the heartbeat daemon; rewrites the CI workflow's steps that call a hook the release removed (#254);
  verifies (every file against the pin, every hook named in the agents' rules exists, scripts parse, the runner
  entrypoint is readable and starts as the container's user); prints what changed; and never commits or pushes. If
  verification fails it says so and does not claim success. *Built.* (#113, #126, #144, #254)
- **U4.** As the owner, a rollback goes back to the previously installed release from the download cache with no network,
  and is refreshed and verified the same way. *Built.* (#113)
- **U5.** As the owner, the pin is one file, `.claude/factory/release.json`, committed like any change, so the whole team
  and every machine end on one release; a machine that pulled a new pin catches up with `factory update`. *Built.* (#113)
- **U6.** As a project owner, what stays mine is `.claude/factory.json`, the notes, the lessons file, the roles folder,
  `CLAUDE.md`, my docs and CI workflow; a rule that should change everywhere is changed in my-skills. I never edit a
  shared file in my project. My own allow rules go in `.claude/factory.json` (`permissions.allow`), and the factory
  adds them to the agents' rules (`.claude/factory/settings.json`) each time it starts an agent (#258), so a
  new rule applies after one owner merge, with nothing else to run (#251). *Built.* (wiki/submodule.md "Shared and project-owned"; #112, #198)
- **U7.** As a project on the submodule, I keep working until I move. I move to releases in one reviewed pull
  request, with no flag day. `factory update --release` refuses where the files are still links. Moving
  Remanual changes protected files there, so it is the owner's merge. *Built (the commands); the migration is owner-led.*
  (#112, #113)
  The code has moved out of `kit/` into `hooks/`, `ci/`, `factory` and `factory-loop.sh` (#120, #121), and the `kit/`
  forwarders and `--layout old` are gone (#176): a link a project still has through `kit/` is relinked by
  `install.sh --link`. `factory migrate-to-release` (#170, #264), the manager-profile note (#172), a safe `factory
  update` at an old pin (#174) and the local archive mode (#175) are built, and Remanual is on releases (#113, its PR
  440). It keeps `vendor/my-skills` only for the nestjs skills, which are not in a release.
- **U8.** As the owner, a bump of the pin for the whole team is a separate, deliberate step from updating one machine.
  *Decided in principle; `factory update --propose` is not built, and its name is the owner's choice.* (#113, #114
  handover)
- **U9.** As anyone, anything copied for a service or a container (a runner's start script, compose files) gets the modes
  its reader needs, readable by that user and not writable by others, with a test. *Built.* (#111, `CLAUDE.md`)
- **U10.** As the owner, a new machine is two commands and three sign-ins: `factory bootstrap machine` (a dedicated
  unprivileged user, rootless Docker, a network guard) and `factory bootstrap project`, ending with `factory doctor
  --sandbox` green. Nothing privileged runs unless I pass `--apply` as root, and the human steps (`gh auth login`, the
  Claude login, the age key) stay mine. *Built, Linux only.* (#105)
- **U11.** As the owner, `factory doctor` says in plain words what is wrong on this machine or project and the fix, and
  exits 1 when something needs fixing. *Built.* (#63)
- **U12.** As the owner, a project can be set up by `install.sh` (links, or a copy), which scaffolds the role folder and
  templates and never overwrites an existing file. On a first install it tells the stack (Node with a `package.json`; Python
  from `pyproject.toml`, `setup.py`, `requirements*.txt` or `tests/test_*.py`; otherwise unknown) and chooses the CI
  workflow and `commands.*` to match, from `install.sh` and from a first `factory update <tag>`; an existing `ci.yml` is
  kept. `factory doctor` checks that the workflow matches `factory.json` (#205, #224). *Built,
  including `factory init` for an empty folder (#148).* (#102, #103, #199, #205)
- **U13.** As the owner, the machines come back after a reboot: `factory autostart` starts the dev stack and this machine's
  agents in detached tmux sessions. *Built.* (#88)

### 4.7 CI runners

- **C1.** As the owner, CI runs on GitHub's runners or on my own machine, switched by one command, `factory ci use
  local|github` (the repo variable `CI_RUNS_ON`). Pull requests from forks always run on GitHub's runners. *Built.* (#40)
- **C2.** As the owner, `factory ci install` sets up the self-hosted runner as a launchd service on macOS or a systemd
  user service on Linux, and running it again updates it; several machines can serve one label. The runner is GitHub's
  runner image as a container with its own Docker, one job per registration, then everything is removed. *Built.* (#40,
  #62)
- **C3.** As the owner, light jobs (the Factory guard) have their own lane so a merge never waits hours behind heavy
  jobs, and `ci.runners` sets how many heavy runners a machine runs. *Built.* (#90, #67, #91)
- **C4.** As the owner, rounds are faster with a pre-built runner image and a Docker Hub pull-through mirror, and no pnpm
  store is shared between jobs, so one PR cannot plant code that a later job runs. *Built.* (#60)
- **C5.** As everyone, a CI outage (GitHub's billing block, no runner) is reported as an outage, not as a code failure,
  and agents do not push or re-run to chase it. An agent reads why its own CI failed with `factory ci log <pr>`. *Built.*
  (wiki/reviews-and-gates.md "The PR gate"; `factory_ci.ts`; #206)
- **C6.** As the owner, `factory ci status` works in both modes and shows where CI runs, the latest runs, the runners and
  runs queued for a long time; `factory ci stale` and `factory ci check` say whether the installed copies are older than
  the checkout and fit to start. *Built.* (#40, #113)
- **C7.** As the owner, an optional shared Turborepo build cache serves agents and CI, off until set up, falling back to
  the local cache if it does not answer. *Built.* (#59)
- **C8.** As the owner, I know the risk: the Docker-in-Docker container is privileged and runs the tested branch's code,
  so it is not a security boundary. The mitigations are a private repo, fork PR workflows off, and (recommended on Linux)
  a dedicated user with rootless Docker. Running the runner in a separate VM is the follow-up in Remanual #150. *Built
  (documented); the VM is open.* (wiki/ci.md "The known risk")

### 4.8 Settings

- **S1.** As the owner, one table, `hooks/factory_settings_schema.ts`, describes every setting (key, type, default,
  section, help, who must approve a change), and the list, `help`, `validate`, the menu and the tables on the wiki's settings page are all
  generated from it. A test fails when those tables drift. *Built.* (#49, `CLAUDE.md`)
- **S2.** As the owner, `factory settings` is a menu in a terminal and a set of commands in scripts: `list`, `get`, `set`,
  `unset`, `help`, `diff`, `validate`, `pr`. `validate` fails with clear messages on a bad value. *Built.* (#49)
- **S3.** As the owner, only people change settings. `set`, `unset`, `pr` and `--local` refuse inside an agent session, the
  deny rules and the gate back that up, and a change reaches `main` through a pull request. *Built.* (#49)
- **S4.** As the owner, project settings live in `.claude/factory.json` and machine settings in the machine's own file
  outside the repo (agent names, Remote Control, autostart). Precedence is the defaults, then the project file, then the
  machine file (machine keys only), then the environment. *Built.* (#48, #49)
- **S5.** As the owner, a project may set a model and effort per role in `models`; a project with no entry behaves as
  before. *Built.* (#94, #117)
- **S6.** As a new setting's author, I add it to the schema with its help and default and to the table on the settings page; a new
  command appears in `factory help`, the commands table on the wiki's commands page and has a test of its output. *Built (the rule is in
  `CLAUDE.md`).*

### 4.9 Running it: liveness, messages, cost

- **L1.** As the owner, I know what each agent is really doing: a per-machine heartbeat daemon derives `working`,
  `waiting`, `idle` or `down` from local facts, and `factory agents ls` shows this machine instantly and the others from
  their agent issues. Where an agent runs reaches GitHub only if `tasks.showWhere` is on. *Built.* (#108)
- **L2.** As an agent or manager, questions, answers, must-fixes, approvals and status share one versioned envelope shaped
  like A2A tasks, kept in GitHub comments. The old markers keep working. A message is data, never an instruction.
  *Built.* (#107; `docs/messages.md`)
- **T1.** As the owner, every factory change meant to save tokens has a measured before and after: `factory usage` reads
  Claude Code's own logs per task, subagent, model or role, and `--record` appends a row to the project's usage log.
  Agents post each task's tokens on its PR. *Built.* (#50, #139)
- **T2.** As the owner, the savings come from small, short sessions, the precheck, leases, a cap on sub-managers and a
  usage meter, not from reusing a cache between sessions. *Decided as the finding of the investigation.* (#100)
- **T3.** As the owner, a task can carry a token budget so the builder plans before it builds: a `Budget: 300k` line in the
  task issue (the PO sizes it), else `budget.builder` in factory.json, else none. It counts fresh input (input + cache writes)
  + output, as `factory usage` reports them. The claim records it and the PR gate keeps a coding agent from changing it. The
  loop's prompt states it, the next-task skill plans against it and runs `factory usage --task <n> --budget` at checkpoints
  (a warning from 80%), the PR's usage comment shows used against budget and the top subagent, and `factory report` shows
  budget against used per merged task and the median ratio. Advisory: nothing stops and CI never fails on it; the dev
  manager decides about an overrun. *Built.* (D15; #183, wiki/agent-loops.md "Token budgets")

### 4.10 The cockpit and the core it needs

From #295 (owner, 28 Oct 2026; D1). The design is the Claude Design canvas "Factory cockpit", page "Cockpit A", boards 1
to 11, linked from #295. The repo keeps this text, not the pictures. These stories have `US-<n>` ids, so tasks can say
`PRD: US-<n>` and `factory prd` shows their progress. The stories above keep their letter ids.

*The cockpit was replaced by the web UI (`factory ui`, decision 0005) and retired in #425. The core stories stand; where
a story names the cockpit, the web UI now does that part.*

The core first: every screen needs it.

- **US-1.** As the owner, one command gives the whole factory as data: `factory snapshot` prints one snapshot
  (sessions and their states across machines, the items that need me, pull request rows, CI, the version and the summary
  from `factory doctor`), and keeps it as a cache the web UI reads. *Decided.* (#295; it was `factory cockpit --json`
  until #425. The tmux status line, `factory cockpit --status`, went with the cockpit.)
- **US-2.** As the owner, the heartbeat covers every role, not only coding agents: dev managers, product owners and
  sub-managers each have a row with their role, and `factory agents ls` shows them. *Decided.* (#295; L1)
- **US-3.** As the owner, every session the factory starts runs in its own tmux window, through one shared step used by
  `factory owner start`, `factory autostart`, resume and `loop -i` (today `loop -i` runs in the current terminal). *Decided.* (#295)
- **US-4.** As the owner, I can see what a sub-manager is doing: it runs in its own tmux window, started through the
  shared step of US-3, and `tmux attach -r -t =<session>` (the orchestrator prints it) shows that window read-only
  (`factory cockpit watch` until #425). Today a sub-manager runs as `claude -p` with no
  screen. *Decided.* (#295; owner's answer in #293, 28 Oct 2026)
- **US-5.** As the owner, `factory follow <name>` finds a session on this machine directly, not only through an ssh
  remote. *Decided.* (#295; O5)
- **US-6.** As the owner, what I do by hand is a factory command, so the web UI and the command line share it:
  `factory owner merge`, `label`, `answer` and `release`. `merge` keeps the protected-file check: it says when a pull
  request touches protected paths. The dev manager may run them too, still under the PR gate; a coding agent may not,
  so inside a coding agent's session they refuse with `{code, message, fix}`. *Decided.* (#295; D12; owner's answer in
  #293, 28 Oct 2026)
- **US-7.** As the owner, I am alerted when a new item needs me: a terminal bell and a desktop notice (osascript on
  macOS, notify-send on Linux; nothing to install). Once per new item, not on every refresh. *Decided.* (#295; O2)
- **US-8.** As the owner, the GitHub views (`factory prs`, `watch`, `messages`, CI) read from one background cache, like
  `factory agents ls` does, so a view opens without waiting on GitHub, and `factory ci status --json` gives CI as data.
  *Decided.* (#295; C6)
- **US-9.** As the owner, settings I stage collect into one `factory settings pr`; machine settings save
  at once, as they do in `factory settings` today. *Built* (`set --stage`, `diff --staged`, `unstage`, #306; the
  cockpit's settings view, US-13, was retired with the cockpit, #425). (#295; S2, S3, S4)

Then the cockpit, in steps. *Replaced by the web UI (decision 0005): its channels (agents, tasks, pull requests, CI,
owner queue, machines) took over US-10 to US-13, and the cockpit was retired in #425.*

- **US-10.** As the owner, `factory cockpit` opens one terminal window that works over plain ssh. On the left, SESSIONS
  (dev managers, product owners, coding agents, other machines), each with its state and a "needs you" badge, and under
  it the VIEWS: Needs you, Pull requests, Tasks & PRD, CI, Agents & machines, Settings, Health & releases, Usage &
  lessons. On the right, the selected agent's real Claude Code session, and I type into it. On top, the counts and "N
  need you"; at the bottom, the keys that work now. `:` opens a fuzzy command bar over the factory commands; `/` inside
  a session stays Claude's. The cockpit has its own prefix, `C-a`, so tmux nested over ssh keeps `C-b`. Views open as
  popups that run the existing commands. Read-only in this step. Without tmux 3.2 or newer it stops with
  `{code, message, fix}`. *Built* (#308; `C-a C-a` comes back to the list). *Replaced by the web UI (#425).* (#295)
- **US-11.** As the owner, I act from the cockpit: merge, label, release, answer, start and stop an agent, say. Each
  asks me first when it changes GitHub or the machine. *Built* (#309; the `:` bar runs `factory owner merge`, `label`,
  `answer`, `release`, `start`, `stop` and `factory say` after a y/N question; `m` in the Pull requests view merges
  pinned to the head it shows, `s`, `x` and `n` in the list say, stop and start). *Replaced by the web UI (#425).* (#295; US-6)
- **US-12.** As the owner, the cockpit shows the alerts of US-7 in its own window: the badge, the count and the bell.
  *Built* (#310; the bell rings from the list once per new owner ask, no second desktop notice). *Replaced by the web
  UI (#425); `factory alerts` still rings and notifies.* (#295)
- **US-13.** As the owner, the views move towards the canvas boards: pull request detail, CI cards, the settings table,
  usage bars. *Decided.* *Replaced by the web UI's channels (#424, #425).* (#295)

Not in the cockpit, nor in the web UI, on purpose: the commands that agents and the gate use (`review-pass`, `wait`, `run-check`, the
guard, rereview record and reply, the `manager-claims` actions). (#295)

### 4.11 The factory's own record (decision 0007)

From #472 (owner, 6 Nov 2026) and [decisions/0007](decisions/0007-own-record.md). The numbers start at US-40, so the
web UI section proposed on #293 (US-14 onward) keeps its range. The owner accepted 0007 on 6 Nov 2026.

- **US-40.** As the owner, the factory's tasks, epics, dependencies, claims and every conversation about them (questions,
  answers, hand-offs, the PO's proposals, the owner queue, the dev manager's notes, a pull request's back-and-forth) are
  kept in the factory's own database, so agents stop reading GitHub as a database and the shared account's hourly limit
  stops running out. GitHub keeps the code, the pull requests, CI, the dev manager's final verdict and the labels the PR
  gate and the Factory guard read. *Being built: the framework (#489) and its adapters (#500): with `tasks.source: board`
  the tasks, claims and messages are on the board, and with `messaging.transport: board` claims, wake-ups and the pull
  request feed; NATS was removed (#504).* (#472; 0007 point 2)
- **US-41.** As the owner, setting up a new factory and connecting GitHub, I can import the repo's issues and their
  comments as tasks, from the first-launch screens and from the command line. A dry run says first what it will bring
  and what it skips. Running it twice updates and never duplicates. *Built from the command line (`factory board import
  github`, #494); the first-launch screens are #457.* (#472; #457; 0007 point 4)
- **US-42.** As the owner, I can still follow the work on GitHub: a task's issue is updated when its state changes, one
  way, on by default and off with a setting. Each new owner ask also appears on the owner-queue issue, so GitHub's
  notifications still reach my phone, and my answer there is read back. *Decided (0007, 6 Nov).* (#472; M6; 0007 point 5)
- **US-43.** As the owner, the web UI shows tasks, threads and the owner queue from the database, updated live, with no
  GitHub calls for them; `factory status`, `prd`, `next` and `messages` give the same answers. *Being built: the web UI
  reads tasks from the board, live (#498); `factory next` and `messages` read it with `tasks.source: board` (#500).*
  (#472; 0007 point 6)
- **US-44.** As the owner, the database runs on the hub machine in Docker, reached over Tailscale only, with `up`,
  `down`, `status` and `backup` commands, a nightly backup, and `factory doctor` saying when it can't be reached and the
  fix. Another machine joins with a login of its own (`factory machine add` and `join`), which `machine remove` drops.
  Moving to a hosted Postgres later is a change of address. *Built: `factory board up|down|status|backup` (#489), the
  doctor's check (#500), and machines joining with board logins (#504); the nightly backup is a job set up on the
  machine.* (#472; 0007 points 3 and 8)
- **US-45.** As the owner, the move happens one kind at a time with both copies kept: for a period each moved kind is
  written to the database and to GitHub, misses are counted, and I stop the GitHub copy when nothing was missed.
  *Decided (0007, 6 Nov).* (#472; 0007 point 9)
- **US-46.** As the author of another agent system, I can use the task and messaging layer without the factory: it has
  a generic model (agents and people, tasks, claims, threads, verdicts), its own docs, tests, settings and run
  commands, and imports nothing from the factory. The factory is one user of it, through its ports. Where it lives and
  its name are the owner's. *Built: factory-message-board, `software-factory/message-board/` (#489; the owner chose the
  folder and the name on #481).* (#472, owner's direction 6 Nov; 0007 point 1)
- **US-47.** As a builder or a manager, a task can hold subtasks to any depth and typed dependencies to tasks at any
  level (blocks, waits-for, discovered-from, supersedes, duplicates); a cycle is refused, and "blocked" and the ready
  list that `factory next` reads are computed from them, never from prose. *Decided (0007, 6 Nov).* (#472, #469; 0007 point 7)
- **US-48.** As a builder, when I take a task I see the discoveries, blockers and decisions other agents recorded on the
  tasks linked to it, without searching for them. *Decided (0007, 6 Nov).* (#469, plandb's context entries; 0007 point 7)

### 4.12 Agents' prompts, skills and workflows

From #477 (owner, 6 Nov 2026, on the web UI design canvas): "An agent has two important parts. The first is its
prompt ... The second is its skills and context ... The other aspect of an agent is its workflow." The numbers start at
US-60, so the web UI section proposed on #293 (US-14 onward) and decision 0007's section (US-40 onward, PR #481) keep
their ranges. One rule shapes every story here: agents cannot change what governs them (D11), and a change under
`.claude/` is merged by the owner (#247). So nothing is written live: an edit in the web UI opens a pull request, which
also gives versions and diffs.

- **US-60.** As the owner, I see each agent's profile in the web UI: its prompt in five parts (role, context, examples,
  constraints, return values), the skills it loads, its workflows, and its history. It is read from the files on
  `main`, and each part says which file it comes from. *Decided (owner, 6 Nov).* (#477)
- **US-61.** As the owner, an agent's rule files are written in those five parts, so the profile shows what the files
  say rather than a guess at it. Today `DEV-MANAGER.md`, the product owner's rules and `kit/.claude/agents/*.md` are not
  split that way. *Decided (owner, 6 Nov).* The files are rewritten in five headed parts (not guessed from today's prose). (#477)
- **US-62.** As the owner, I edit a prompt part, a skill or a workflow in the web UI and it becomes a pull request: I see
  the diff before it is opened, and it is merged like any change under `.claude/`, by me. An agent may propose such a
  change as a pull request but never merges it. *Decided (owner, 6 Nov).* (#477; D11, #247)
- **US-63.** As the owner, I add a skill to an agent, from the skills in my-skills or the project's own, as a pull request.
  *Decided (owner, 6 Nov).* (#477)
- **US-64.** As the owner, a project tunes an agent without forking it: the project's additions (today
  `.claude/factory/notes/<agent>.md`) are shown as a layer over the shared rules, each line marked shared or project. A
  project layer only adds rules; it never removes one. *Decided (owner, 6 Nov).* (#477; U6)
- **US-65.** As the owner, I save an agent's prompt, skills and workflows as a template and apply it to another agent or
  project, which opens a pull request there. *Decided (owner, 6 Nov).* Shared templates live in my-skills and ship with a release; a project's own live in its role folder. (#477)
- **US-66.** As the owner, a workflow (for example the dev manager's "review a pull request", "review a PRD and give the
  PO feedback", "break work items into tasks") is data: its steps, the choices between them, and what each step runs. The
  web UI draws it, I edit it as a pull request, and the pass skill runs from it. Today's pass skills (`manage-pass`,
  `product-pass`, `next-task`) keep working until each is converted, one at a time. *Decided (owner, 6 Nov).* The editor starts as a list of steps in a form; a drag-and-drop canvas comes later. The owner isn't sure a list will be enough ("try it"), so the first version is checked with him before more is built on it. (#477)
- **US-67.** As the owner, every run records which version (the commit) of the prompt, skills and workflow it ran with,
  and the agent's history shows it. So I can compare runs before and after a change, with numbers read from `factory
  usage` and `factory report`. *Decided (owner, 6 Nov).* (#477; T1)

## 5. Out of scope

- **A custom UI other than the web UI** (`factory ui`, decision 0005, which replaced the terminal cockpit, #425): no
  second dashboard or console, no phone queue. (D1; #114, #295)
- **New dependencies.** The factory is TypeScript on Bun, with Bun and Node built-ins only, and bash. An npm package
  is used only at build time, bundled at release, and only with the owner's yes. (D13, `CLAUDE.md`)
- **An agent changing the process.** Agents do not edit the gate, the guard, the agents' rules, agent definitions or
  `.claude/factory.json`, do not publish a release, and do not push to `main`. (D11)
- **A model in the dev manager's idle loop.** (#97, #109)
- **Scheduled cloud tasks** as part of the design. (#109)
- **A hard security boundary on the agents' machine.** The gate, hooks and heartbeat are guard rails for well-meaning
  agents; the lock is GitHub's branch protection, and a separate GitHub account for agents is the recommendation. (wiki/sandboxed-machine.md
  "Security notes")
- **Bootstrap on macOS or as a VM.** `factory bootstrap` is Linux only for now, and does not create the GitHub account.
  (wiki/sandboxed-machine.md "A sandboxed machine")

## 6. Later / open

Nothing in this section is decided or scheduled. It is the owner's brainstorm of 25 Oct 2026, recorded as he gave it in
the second comment on #150.

### A. Agents and the owner work together in a chat tool (Slack or Mattermost)

The owner's vision: instead of terminals, a channel per issue where the dev manager, the PO, the builder, the reviewers
and the owner talk, like a team. Not a UI we build; an existing chat tool is the UI.

What was discussed:

- **Bridge, not a new UI.** A small module (a Slack app, or a Mattermost integration) with two jobs. GitHub to chat: when
  an issue is claimed it creates the channel once (named from the issue number and title), adds the owner, the dev manager
  and the PO, posts the fact sheet, then mirrors progress, questions, reviews and CI results and tags the right person.
  Chat to GitHub: only explicit things: a reply under a question becomes the `factory-answer` marker, a few commands
  ("merge", "hold") become labels or comments. GitHub stays the record and the source the loop reads.
- **Agents never touch the chat tool.** Only the bridge holds the token. One app can post under per-role names and icons
  (believed to need Slack's `chat:write.customize`; not verified).
- **A mention does not wake an agent.** The bridge turns a mention or handoff into the existing GitHub signal (label or
  marker).
- **Unattended sessions replace `-i`.** Replies reach an agent at its next wait point or next pass, not mid-task; each new
  session loads the thread as its context. This would shrink the `-i` parts of #97, #100, #101, #109.
- **Slack Code ("code channels")** exists at slack.com/features/code-channels (a temporary channel per task; agents listed
  include Claude, Copilot, Devin). Plan and API details were not checked; Mattermost is self-hostable and open.
- **Rules it must keep:** the bridge maps only the owner's chat user to the owner's GitHub account (approval means that
  account); no secrets or safety text to a chat tool; agents post only when a person is needed or a state changes; if chat
  and GitHub disagree, GitHub wins.

> Open question: Slack or Mattermost (or GitHub Discussions)?
> Open question: who hosts the always-on listener?
> Open question: phone use through the chat app instead of the Claude app?
> Open question: whether a Slack Marketplace listing is ever wanted (only to distribute the factory to other teams; a
> private app needs none).

### B. Is Python a performance concern? (closed)

Decided by D13 (#252): the factory moved from Python to Bun. The earlier measurement found the test run dominated by the
processes the tests start (git, gh, bash, docker), not by the language, so the cheaper levers (parallel tests, fewer
processes per test) still apply.

### C. Other things that are later or not agreed

- **A VS Code extension on stable APIs**, as a second screen on the same core as the web UI. (#295)
- **An A2A adapter** for the message envelope, in the heartbeat daemon. GitHub stays the transport; the adapter is a later
  step that needs no format change. (wiki/agent-loops.md "Messages between agents"; `docs/messages.md`)
- **The PO testing the running app**, scripted or Claude-driven browser: needs a spike. (#101)
- **Ideas in the PR #39 draft that no issue or decision picked up.** They were proposals in that draft and are not
  scope: a `priority:high` label the picker honours (its story 9), a task board kept in step with the labels (55), the dev manager building a small task when no agent runs (51), a duplicate-task check
  before a claim (54), a notice when a reviewer is unavailable (53).

### D. Open questions

> Open question: the owner's decisions recorded as "your call" in #97 (cap of 2, no builders, one session per item, GitHub
> as the channel), #112 (names, guard entry, order) and #113 (install location, version scheme) are an agent's choices. The
> owner can change any of them; has he confirmed them?

> Open question: the watcher of #109 is built as `factory dev-manager loop` on a PC (D7, #137). Whether it should
> also run another way (a GitHub Actions workflow, a systemd timer) was not decided.

> Open question: what the PO may decide alone, and the wait before a question moves up a level (#110, "Decisions needed
> from the owner"). Whether the PO may proceed on low-risk items when the owner is away, or waits (#103; its default
> proposal is that gates wait).

> Open question: the name of the command that bumps the pin for the team (`factory update --propose` was only an example in
> #113).

> Open question: the PRD's location. #150 names `docs/PRD.md` "or the path the owner picks". `tools/check_skills.ts`
> fails on a top-level folder that is not a skill, so this page lives at `software-factory/docs/PRD.md`, next to
> `messages.md`.

## What happened to PR #39

PR #39 was a draft PRD, written 22 to 24 Oct, that nobody had reviewed (#114, #150). This page replaces it. Closing PR
#39 is the owner's call.

| In the #39 draft | Here |
|---|---|
| Roles, what exists today | Section 3 and section 4, checked against `main` and updated. |
| The numbered stories, marked Must/Should/Could | Rewritten as the stories above, marked by status, each naming its issue. Stories for work that is now built say *Built*. |
| UI options (CLI, TUI, dashboard, mobile inbox) and a recommendation to start with a mobile inbox | **Dropped.** Superseded by D1 (then "no custom UI"; since #295, the terminal cockpit; since decision 0005 and #425, the web UI). |
| Architecture options (a state store, a local daemon) | **Dropped, then taken up again.** The message board (decision 0007) is the factory's own state store, on Postgres (D10). The per-machine heartbeat daemon exists for liveness (#108). |
| 31 numbered pains with evidence from 21 to 24 Oct | Not carried over as a list. The ones that led to built features appear as the issues those features name. |
| Roadmap of five phases | Dropped. The order is issue #114. |
| Stories nobody picked up | Listed under "Later / open", section C, as proposals. |

## Where to read next

- [README.md](../README.md): the front page, "Where things live" and the contents of the wiki ([docs/wiki/](wiki/): the commands, the settings, releases).
- [DEV-MANAGER.md](../DEV-MANAGER.md) and `kit/.claude/skills/manage-pass/SKILL.md`: the dev manager's rules.
- [messages.md](messages.md): the message envelope.
- Issue #114: the order of work. `factory next` shows the next task.
