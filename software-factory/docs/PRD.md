# PRD: the software factory as a product

Status: draft for the owner. Date: 22 Oct 2026. Source: what the factory does today in my-skills
(`software-factory/`), how Remanual uses it, and what went wrong on 21–22 Oct. Anything marked *(inference)* is a
reading of the evidence, not something observed.

## 1. Problem and vision

**Problem.** One person wants several AI coding agents to build a product from a PRD, around the clock, without
babysitting them. Today that works, but only with a lot of glue that one person understands:
- shell scripts and Python hooks;
- a dev manager session that has to be told its whole state every 10 minutes;
- GitHub labels and comment markers;
- a phone, and many messages.

When something breaks (billing, a moved repo, a stale claim), the owner finds out late, through chat.

**Vision.** A factory any repo can install in minutes. It turns a PRD and a task list into reviewed, tested,
merged pull requests, and keeps a person in charge of the decisions that are theirs. It has:
- one place to see what is happening (a UI, on a phone too);
- one inbox of decisions waiting for the person;
- clear rules for what each agent may do;
- safe defaults (gates, protected files, CI) that hold even when an agent is wrong.

**Who it is for first:** the owner, building Remanual. Then any repo with a PRD and a test command.

## 2. Users and roles

| Role | Who | What they need |
|---|---|---|
| **Owner** (the person) | One human, often on a phone | See state at a glance; answer decisions; approve what only they may approve; trust that nothing merges that shouldn't |
| **Dev manager** | A Claude session (cloud), on a schedule | Read every PR, review, approve and merge within its rights; answer agents; escalate the rest; keep its own state |
| **Coding agents** | Claude sessions in loops on a machine (named menelik, taytu, ...) | A next task; a branch and folder of their own; tests, reviewers, a gate that says why it blocks |
| **Reviewer subagents** | reviewer, architecture-reviewer, test-writer, safety-auditor, security-reviewer | The diff, the rules, a place to record a pass |
| **External reviewers** | Copilot code review, the nightly security audit, the hourly backup review | A way to comment that the factory reads |
| **CI runner** | GitHub-hosted, or self-hosted on the owner's machine | Run the checks the gate relies on |

## 3. What exists today

Everything below lives in `my-skills/software-factory/` and is linked into a project by `install.sh --link`
(decision 0031 in Remanual).

- **Install and upgrade:**
  - the project pins a my-skills commit as a git submodule (`vendor/my-skills`);
  - `install.sh` links shared files into `.claude/`;
  - `factory update` moves the pin.
  - The loop restarts itself when `factory-loop.sh` changes on main (#33, `reload_if_changed`).
- **Config:** `.claude/factory.json` (`factory_config.py` holds the defaults):
  - commands, protected paths and test paths;
  - styles, `reviews`, `eval`, `design`;
  - `agentEnv` for ports and databases per agent;
  - `maxOpenPRs`, `numberedDirs`;
  - the agent names.

  Per-project notes for each agent or skill live in `.claude/factory/notes/<name>.md`.
- **Tasks:** plan mode (`docs/build-plan.md`) or issues mode (`factory_issues.py`):
  - labels `factory:ready`, `in-progress`, `in-review`, `blocked`, plus `agent:<name>`;
  - race-free claims through a claim comment, where the earliest wins since the last release;
  - dependencies ("Depends on #n");
  - milestone order;
  - stale detection.
- **Agent loops:** `factory-loop.sh` runs one fresh Claude run per task, or `-i` for a session the owner can
  type into.
  - Each agent gets its own git worktree, ports and database (`factory_claims.py`, `factory_env.py`;
    decision 0029).
  - Loops wait when nothing is ready.
  - A finished, interactive session closes by itself through the Stop hook (`factory_stop.py`), after a 10 s
    countdown (#34).
- **Live agents:** each agent has a GitHub issue it pings (`factory_agents.py`). A sweep marks silent agents down
  and releases their issues.
- **The next-task skill:** pick, failing tests first (test-writer), build, run the checks, extra reviews from
  `factory_reviews.py`, the reviewer pass, the PR, merge when the gate allows. Rework a PR when the dev manager
  posts a must-fix on its head commit.
- **The PR gate** (`pr-gate.py`, a PreToolUse hook; hardened in #36). For `gh pr create`, `ready` and `merge`, it
  needs:
  - the reviewer's pass for the head commit, plus the architecture reviewer's on styled paths;
  - green CI;
  - no protected files changed;
  - no hold label;
  - no open must-fix;
  - `--match-head-commit`;
  - free decision and migration numbers (#38).

  It also stops agents posting the dev manager's markers or labels, and it fails closed.
- **CI guard** (`factory_guard.py`): fails a PR that weakens tests, changes golden files, adds `.skip`/`.only` or
  a dependency until reviewed, reuses a decision number, or ticks another task.
- **Settings:** `settings.json` deny rules, for example no push to main, no force-push and no `gh api` for agents.
- **The dev manager:** `DEV-MANAGER.md` is the playbook:
  - the tick;
  - holds, approvals and must-fixes as comment markers;
  - answering questions;
  - the permission table ("you run the agreed process; you don't change it").
- **Diagnostics added on 22 Oct** (#38):
  - `factory_numbers.py`;
  - `factory_remote.py` (repoints a moved repo);
  - `factory_ci.py` (tells CI that never started from real failures);
  - waiting for a PR slot;
  - a running loop keeps its name.
- **Self-hosted CI** (Remanual #149, open): `ops/ci-runner/` runs an ephemeral runner as Linux containers on the
  owner's Mac, chosen by the repo variable `CI_RUNS_ON`.
- **Tests:** `software-factory/tests/` (about 60 tests across the gate, issues, hardening, loop reload and
  countdown, rework, and lessons).

## 4. What hurts today

| # | Pain | Evidence |
|---|---|---|
| P1 | **No single view.** State is spread over labels, comments, the claims file, agent issues and chat. The owner asks "what's waiting for me?" and gets a long list. | Owner messages on 21–22 Oct; the dev manager's 3,000-word state notes repeated every tick |
| P2 | **The dev manager's state lives in its own prompt.** Each tick re-sends the whole state as text; one wrong note carries forward. | The tick message; a stale "approved at b75d44a" after a newer head arrived |
| P3 | **Agents report wrong causes.** "The repo moved to remanual-org" was false: only the agent's remote was stale. | taytu's report, 22 Oct; fixed by `factory_remote.py` |
| P4 | **Numbering clashes.** Decision numbers were renumbered PR after PR. | #115, #127, #144, #145, #107; fixed by `factory_numbers.py` |
| P5 | **Deadlocks on the PR cap.** All slots taken by PRs that can't merge, so finished work can't open. | #107, #134 and #147 waiting on 22 Oct |
| P6 | **CI outages look like code failures.** The billing block turned every check red; agents nearly chased it. | 08:04Z onwards; `factory_ci.py` |
| P7 | **Sessions don't close; loops stall.** Agents sat in finished sessions all night. | #34, #35; "both agents down" from 02:50Z |
| P8 | **Two agents with one name.** A loop's claim expired after 6 h while it still ran. | The owner's report, 11:31 Berlin; fixed in #38 |
| P9 | **Agents ask instead of fixing** what a rule already decides. | menelik on #145 ("here or a follow-up?") |
| P10 | **One GitHub account for everyone.** Agents, dev manager and owner are all `deresegetachew`, so approvals can't be told apart and branch protection can't require an independent review. | `trustedReviewers` unused; README security notes |
| P11 | **No branch protection** on a private free-plan repo. The gate is a guard rail, not a lock. | Owner's settings, 21 Oct |
| P12 | **Hard to set up a second machine.** The steps live in chat. | The owner's request for a dedicated dev laptop, 22 Oct |
| P13 | **Cost is invisible.** No per-agent or per-task token count. | `/usage` only; DEV-MANAGER.md "Token use" |
| P14 | **Everything reaches the owner through one chat.** Decisions, status and noise are mixed; the owner reads on a phone. | This conversation |

## 5. User stories

Each story says who wants what. *Must* is for the first product release, *Should* for soon after, *Could* for later.

### Install and upgrade

1. *Must.* As the owner, I install the factory into any git repo with one command that checks prerequisites
   (git, Python, `gh` signed in, Claude Code) and says what's missing.
2. *Must.* As the owner, a setup wizard asks for my test, lint and build commands, my PRD path and my task source,
   then writes `factory.json`, `CLAUDE.md`, the CI workflow and labels, and opens one PR with it all.
3. *Must.* As the owner, I upgrade the factory with one command that shows what changed and opens the PR. Running
   loops pick up the new version between tasks (exists: #33).
4. *Should.* As the owner, I pin a factory version and roll back to the previous one.

### Configuration

5. *Must.* As the owner, `factory doctor` checks the whole set-up and says what to fix in plain words:
   - the config;
   - the remote (exists: `factory_remote.py`);
   - labels;
   - CI runner reachable;
   - branch protection state;
   - free numbers.
6. *Must.* As the owner, project rules go in notes and config, never in shared files, so upgrades don't conflict
   (exists: decision 0031).
7. *Should.* As the owner, I can edit the config from the UI, which opens a PR rather than changing files in place.

### Tasks

8. *Must.* As the owner, I write a task as an issue from a template; agents pick tasks in milestone order and
   respect "Depends on".
9. *Must.* As the owner, I mark a task high priority and the next free agent takes it first. Today the
   `priority:high` label is ignored by the picker.
10. *Must.* As the owner, I see every task's state and its agent, branch, PR and CI on one board.
11. *Should.* As the owner, I turn a PRD section into draft tasks that I review before they go to `ready`.

### Agents and loops

12. *Must.* As the owner, I start, stop and restart an agent from the CLI or UI, and see whether it is working,
    idle, waiting for a PR slot, or down.
13. *Must.* As the owner, agents run on a dedicated machine (the dev laptop) and keep running after a reboot,
    for example as a LaunchAgent or systemd service.
14. *Must.* As the owner, two machines never run the same agent name; the second start says who holds the name
    and where.
15. *Must.* As a coding agent, when my work is finished but can't open a PR, I wait and open it when a slot frees
    (exists: #38).
16. *Should.* As the owner, I set how many agents run and which models they use, per role.

### PR gate and reviews

17. *Must.* As a coding agent, every gate refusal tells me exactly what to do next.
18. *Must.* As the dev manager, I hold a PR while reviewing, post must-fixes bound to a commit, approve a commit,
    and merge only that commit (exists).
19. *Must.* As the owner, external reviews (Copilot, audits) appear next to the dev manager's review, and real
    findings become must-fixes.
20. *Should.* As the owner, approvals come from a separate account and count only for trusted reviewers (exists
    in config: `trustedReviewers`; needs the account).

### CI

21. *Must.* As the owner, CI runs on GitHub's runners or on my own machine, switched by one setting (exists in
    #149: `CI_RUNS_ON`).
22. *Must.* As the owner, setting up the self-hosted runner is one script that survives reboots, with a status
    command (asked for on #149).
23. *Must.* As everyone, a CI outage (billing, no runner) is shown as an outage, not as a code failure, and
    agents don't chase it (exists: `factory_ci.py`).
24. *Should.* As the owner, the self-hosted runner runs in an isolated VM, so a job can't reach my machine (#150).
25. *Could.* As the owner, several runners split a PR's jobs.

### The dev manager

26. *Must.* As the dev manager, my state (open PRs, heads reviewed, number plan, what waits on whom) is read from
    a state store or GitHub, not carried in my prompt, so a tick is short and can't drift (P2).
27. *Must.* As the owner, the dev manager's rights are a written, versioned table. Every action outside it
    becomes a "needs your yes" item in my inbox, never a done change.
28. *Must.* As the owner, the dev manager's schedule (the tick) is one setting, and a missed tick is noticed and
    recovered.
29. *Should.* As the owner, a backup reviewer (the hourly task today) covers the dev manager when its session is
    down, with the same rights table.

### Observability

30. *Must.* As the owner, I see a timeline per task: claimed, tests, built, reviewed, PR, rework, merged, with who
    did each step.
31. *Must.* As the owner, I see each agent's last ping, current step and the last 20 lines of its output.
32. *Should.* As the owner, I get a daily digest: merged, open, blocked, waiting on me, usage.

### Cost and tokens

33. *Should.* As the owner, I see tokens or cost per agent, per task and per day, where the tools expose it.
    Unknown today: what Claude Code reports per session needs checking.
34. *Could.* As the owner, I set a daily budget per agent; the loop pauses when it's reached.

### Security

35. *Must.* As the owner, agents use their own GitHub account (or a GitHub App) with only the rights they need.
36. *Must.* As the owner, `factory doctor` says whether branch protection or rulesets are on, and what the repo's
    plan allows.
37. *Must.* As the owner, secrets never enter the repo or agent prompts; the factory reads them from the existing
    secret store (SOPS in Remanual).
38. *Must.* As the owner, the factory's own code is audited nightly and only when it changed (exists: the nightly
    audit task).

### Notifications

39. *Must.* As the owner, I get a phone notification only when something needs me. Everything else goes to the
    digest.
40. *Should.* As the owner, I answer a decision from the notification or the inbox in one tap or one line.

### Onboarding

41. *Must.* As a new user, a quick start gets one agent building one task end to end on an example repo.
42. *Must.* As the owner, setting up a new dev machine is one script plus sign-ins, with a checklist (P12).

## 6. UIs

All UIs read the same state (section 7). None of them may do what the rights table forbids. A UI action that
changes the factory opens a PR or an inbox item.

| Option | What it shows | How it reads state | For | Against |
|---|---|---|---|---|
| **`factory` CLI** (exists) | Commands: loop, agents, issues, claims, doctor, status | Local files (claims, env) + GitHub API | Already there; scriptable; works over SSH | Not on a phone; no overview |
| **Terminal TUI** (`factory top`) | Live panes: agents, tasks, PR queue, CI, log tail | Same as the CLI, polled | Fast on the dev laptop; no server | Not on a phone; one machine's view of local state |
| **GitHub-native** (labels, issues, a pinned "Factory status" issue) | A status issue the dev manager edits each tick; labels as the board; Projects view | GitHub only | No new software; on a phone through the GitHub app | Slow to read; noisy; a free-plan repo has limits |
| **Web dashboard** | Agents, task board, PR queue with review state, CI status and runner, "waiting on you", usage | GitHub API + a small state store; optionally a local agent on the dev machine pushes live status | One place, on any screen; the owner can act | Needs hosting and auth; must not become a second source of truth |
| **Mobile inbox of decisions** | Only what needs the person: approve, answer, choose, with context and a recommendation | The same store; each item links to its PR or issue | Matches how the owner works (phone); cuts noise (P14) | Narrow: needs the dashboard or GitHub for detail |

**Recommendation for the first UI:** the **mobile-first inbox plus a read-only status page**, built as one small
web app. *(inference: the owner works from a phone and most of his messages ask "what needs me?")*
- The inbox holds decisions with a one-tap answer that is written back to GitHub as a marked comment, so the
  agents and the dev manager read it as they do today.
- The status page shows agents, tasks, PRs and CI.
- The TUI comes second, for the dev laptop. The CLI stays the base everything else calls.

## 7. Architecture options

**Where state lives.**
- **A. GitHub only** (today, mostly): labels, comments with markers, agent issues, plus a local claims file per
  clone.
  - For: no server, nothing extra to secure.
  - Against: slow, rate-limited (the session hit the 5,000/h limit once), and the dev manager re-derives state
    every tick.
- **B. GitHub as the record, plus a small state store** (one SQLite or JSON service, or a GitHub repo file
  written by the dev manager), which the UI and the dev manager read.
  - For: fast reads, one model of the world, a short tick.
  - Against: one more thing to run, and it can drift from GitHub unless GitHub stays the source of truth and the
    store is rebuilt from it.
- **C. A local daemon on the dev machine** that owns loops, claims and runners, exposes a small API, and syncs
  to GitHub.
  - For: real-time agent status and logs, restarts, budgets.
  - Against: machine-bound; the cloud dev manager can't reach it without a tunnel.

**Recommendation:** B first, with GitHub as the source of truth and the store as a cache that can be rebuilt; C
later for live logs and control. *(inference)*

**Extension points per project** (exist, keep):
- `factory.json`;
- `.claude/factory/notes/<agent>.md`;
- `styles` (style guides with checks);
- `reviews` (which paths need which reviewer);
- `eval`, `design`, `agentEnv`.

Add: pluggable task sources (issues, plan, Linear later), pluggable CI providers, and model choice per role.

**Packaging.**
- **Today:** a git submodule plus links. Pinned and reviewable, but submodules confuse people and CI needs
  `submodules: true`.
- **Options:**
  - an installer CLI (`npx`/`pipx` style) that vendors a versioned copy and upgrades by PR;
  - a Claude Code plugin for the agents, skills and hooks, plus a CLI for loops and runners.
- **Recommendation:** keep the submodule until the UI exists; then decide plugin plus CLI. *(open question)*

## 8. Non-goals, risks, open questions

**Non-goals (for now).**
- Many owners or teams with roles.
- A hosted SaaS for strangers.
- Replacing GitHub as the record.
- Agents that change the factory itself without the owner's yes.

**Risks.**
- **A second source of truth** (the store) drifting from GitHub. Mitigate: rebuild it from GitHub; never write
  only to the store.
- **Security of the self-hosted runner** (privileged Docker today; #150).
- **One shared GitHub account** undermines every approval rule until agents get their own.
- **Costs grow with agents and ticks**, and are unmeasured today.
- **Over-building the UI before the loop is reliable.** The 22 Oct problems were all in the loop, not the UI.
  *(inference)*

**Open questions for the owner.**
1. A separate GitHub account or a GitHub App for the agents and the dev manager: which, and when?
2. GitHub Pro (branch protection, rulesets) or stay on the free plan with the gate as a guard rail?
3. Where should the UI run: your Mac, the dev laptop, or a small hosted service? And who may open it?
4. Is the product just for you across your repos, or for other people too? That changes packaging and auth.
5. Which task sources besides GitHub issues matter (Linear, Jira, the plan file)?
6. What's an acceptable monthly cost for agents plus CI, so budgets have a number?
7. Should the dev manager stay a Claude cloud session, or run next to the agents on the dev laptop?

## 9. Roadmap

| Phase | What | Done when |
|---|---|---|
| **0. Reliable loop** (mostly done) | The 22 Oct fixes (#33–#38), the self-hosted runner (#149) with `install.sh`, the VM runner (#150), the dev-laptop setup script, the priority label honoured | Two agents run 24 h on the dev laptop with no stall the owner has to fix; CI green on the owner's runner; one-script setup of a new machine |
| **1. One place to look** | `factory status` and `factory doctor`; a pinned GitHub status issue the dev manager edits; the state store (option B) rebuilt from GitHub | The owner answers "what's waiting for me?" from one page, and the tick message shrinks to a pointer to the store |
| **2. The inbox** | A mobile web inbox of decisions with one-tap answers written back as marked comments; notifications only for inbox items; a daily digest | A week of operation where every owner decision went through the inbox, not chat |
| **3. Dashboard and TUI** | The status page (agents, board, PR queue, CI, usage where available); `factory top` | The owner can see and act on every agent and PR from a phone or the dev laptop |
| **4. Product** | An installer and wizard for any repo, the agents' own account, packaging (plugin plus CLI or submodule), docs and an example repo | A second repo goes from zero to a first merged agent PR by following the quick start alone |

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
