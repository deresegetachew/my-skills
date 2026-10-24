# PRD: the software factory as a product

Status: draft for the owner. Date: 22 Oct 2026, updated 24 Oct 2026. Source: what the factory does today in
my-skills (`software-factory/`), how Remanual uses it, and what went wrong on 21–24 Oct. Anything marked
*(inference)* is a reading of the evidence, not something observed.

**What changed since 22 Oct.** `factory ci` merged (#40), with #41, #42 and #44 after it. Between the evening of 23
Oct and 01:30Z on 24 Oct the factory merged 23 Remanual PRs, with one self-hosted runner on the owner's Mac. That night showed new pains
(P18–P28): CI capacity on one shared machine, the dev manager's chain of ticks, decisions made where the dev
manager can't see them, and everything stopping when the Mac sleeps. New stories 43–55 cover them.

**What changed on 24 Oct (evening).** A second machine (Ubuntu) runs agents next to the Mac, which showed agent
names colliding across machines (P29, my-skills #45 and #48) and an agent starting without the hooks in a new
worktree (P30, #46). The owner asked to cut token use, measure it and keep a record (P31, #50): stories 56–60 and
the token plan under "Cost and tokens".

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
- **`factory ci`** (my-skills #40, merged; it moved Remanual's `ops/ci-runner/` from #149 into the kit). It runs
  CI on GitHub's runners or on an ephemeral self-hosted runner, as Linux containers on the owner's Mac, chosen by
  the repo variable `CI_RUNS_ON`.
  - `status` works in both modes. `use local|github` switches the mode. `install`, `uninstall`, `start`, `stop`
    and `logs` manage the runner.
  - The names come from the project: `<repo>-ci`, label `<repo>-local`, or `"ci"` in `factory.json`.
  - Several Macs can run runners with one label.
- **Merged since 22 Oct:**
  - one agent issue per agent, instead of a copy on every ping (#41);
  - `factory ci status` on Python 3.8 (#42);
  - branches are brought up to date by merging main, never by rebasing, and the `git rebase origin/*` allow is
    gone (#44). Agents had rebased a pushed branch, then were stuck because force-push is denied.
- **Tests:** `software-factory/tests/` (71 tests on 22 Oct, across the gate, issues, hardening, loop reload and
  countdown, rework, and lessons; #40 added 14 for `factory ci`).

## 4. What hurts today

| # | Pain | Evidence |
|---|---|---|
| P1 | **No single view.** State is spread over labels, comments, the claims file, agent issues and chat. The owner asks "what's waiting for me?" and gets a long list. | Owner messages on 21–22 Oct; the dev manager's 3,000-word state notes repeated every tick |
| P2 | **The dev manager's state lives in its own prompt.** Each tick re-sends the whole state as text; one wrong note carries forward. | The tick message; a stale "approved at b75d44a" after a newer head arrived |
| P3 | **Agents report wrong causes.** "The repo moved to remanual-org" was false: only the agent's remote was stale. | taytu's report, 22 Oct; fixed by `factory_remote.py` |
| P4 | **Numbering clashes.** Decision numbers were renumbered PR after PR. | #115, #127, #144, #145, #107; fixed by `factory_numbers.py` |
| P5 | **Deadlocks on the PR cap.** All slots taken by PRs that can't merge, so finished work can't open. | #107, #134 and #147 waiting on 22 Oct |
| P6 | **CI outages look like code failures.** The billing block turned every check red; agents nearly chased it. GitHub Actions stopped for the whole account, which is why the self-hosted runner was built the same day. | 08:04Z onwards; `factory_ci.py`; Remanual #149 |
| P7 | **Sessions don't close; loops stall.** Agents sat in finished sessions all night. | #34, #35; "both agents down" from 02:50Z |
| P8 | **Two agents with one name.** A loop's claim expired after 6 h while it still ran. | The owner's report, 11:31 Berlin; fixed in #38 |
| P9 | **Agents ask instead of fixing** what a rule already decides. | menelik on #145 ("here or a follow-up?") |
| P10 | **One GitHub account for everyone.** Agents, dev manager and owner are all `deresegetachew`, so approvals can't be told apart and branch protection can't require an independent review. | `trustedReviewers` unused; README security notes |
| P11 | **No branch protection** on a private free-plan repo. The gate is a guard rail, not a lock. | Owner's settings, 21 Oct |
| P12 | **Hard to set up a second machine.** The steps live in chat. | The owner's request for a dedicated dev laptop, 22 Oct |
| P13 | **Cost is invisible.** No per-agent or per-task token count. | `/usage` only; DEV-MANAGER.md "Token use". Being addressed: `factory usage` (#50) |
| P14 | **Everything reaches the owner through one chat.** Decisions, status and noise are mixed; the owner reads on a phone. | This conversation |
| P15 | **The self-hosted runner lacked what GitHub's image has.** `pnpm/action-setup` failed without `node` (Node must come first). Parallel test runs timed out on a Mac shared with the agents (`--concurrency=1` there). There was no Google Chrome for Lighthouse (Playwright's Chromium with `--no-sandbox`). | Remanual #149, decision 0047, 22 Oct |
| P16 | **The runner showed as `bash`** in macOS's background items, and the owner asked for it to show its own name. `factory ci` installs the loop as an executable named after the runner. The process is still `bash`; what macOS shows now is untested. | Owner's message, 22 Oct; #40 |
| P17 | **The runner was Remanual-only.** Its names (`remanual-ci-runner`, `remanual-local`) were hard-coded, its commands were scripts in one repo, and status only made sense in local mode. | `ops/ci-runner/` on Remanual main; the owner's ask for "`<project>-ci status`"; #40 |
| P18 | **One runner for everything.** One self-hosted runner takes one job at a time, so every open PR and every merge to main queue behind each other. PRs that passed review waited hours for CI. | Remanual, night of 23–24 Oct: up to four PRs and main queued at once |
| P19 | **The agents' own work starves CI.** Agents run the full test suite on the same Mac as the runner. Test jobs ran past their 15-minute limit 6 times, Lighthouse failed under load, and timing tests failed. None were code faults, so each meant a manual re-run. | Remanual CI, 23 Oct; the owner's yes to raise the limit still pending |
| P20 | **The runner drops off.** It lost its connection to GitHub 5 times on 23 Oct, once when the Mac went to sleep at night. Jobs then fail as "lost communication", which looks like a red build. | Run annotations, 23 Oct |
| P21 | **Everything stops when the Mac sleeps.** Agents, the runner and the owner's sessions share one laptop. "Remote sessions are offline" on 24 Oct meant no agent, no CI and no merges for the whole morning. | 24 Oct, 01:00–12:00Z |
| P22 | **The guard judges stale labels.** A push-event CI run reads the labels from the event, so a run started before `tests-reviewed` was added fails for good; re-running it fails again. The dev manager has to run the guard by hand to see the real answer. | #393, #395 and #399, 23–24 Oct |
| P23 | **The dev manager's tick chain breaks silently.** Each tick schedules the next one. One tick ended without scheduling, and nothing ran for 6.5 hours until the owner asked. | 24 Oct, 05:09Z–11:47Z |
| P24 | **Decisions are made where the dev manager can't see them.** The owner answered an agent in its terminal ("no separate VM, Docker is enough" on #150); the dev manager only learnt it from the agent's release note and had to ask again. | #150, 24 Oct |
| P25 | **The owner's queue keeps growing.** By 24 Oct more than 15 questions waited on the owner (timeouts, page limits, keys, wording, closing issues). They live in chat and in the tick message, with no list he can work through. | The tick message's "Waiting on the owner" list |
| P26 | **When agents are offline, nobody can land work.** The dev manager may build a task, but may not merge its own PR without the owner's yes, and its cloud workspace couldn't install packages or run the full test suite. | 24 Oct: #173 built by the dev manager with a stand-in test runner |
| P27 | **Reviewer quota and access run out quietly.** Copilot's review quota ran out mid-day; the cloud session can't read job logs or the runner list (403), so it judges CI from annotations and job steps. | 23 Oct; DEV-MANAGER.md notes |
| P28 | **Duplicate and stale tasks.** Two issues held the same task (#350 and #351); the agent found it only after claiming one. | #350, 24 Oct |
| P29 | **Agent names collide across machines.** Names are unique per clone only, and claims compare names, so two machines' `menelik` both win a claim. | Owner's second machine, 24 Oct; my-skills #45, #48 |
| P30 | **A new worktree started without the hooks.** `factory agent` ran Claude before the submodule existed, so no gate or deny rules. | Ubuntu set-up, 24 Oct; #46 |
| P31 | **Tokens go to reading.** Every subagent ran on the strongest model, tasks read whole documents, and the dev manager's long session re-reads its context on every reply (about 75M cache reads in a day). | `factory usage --by agent`, 24 Oct; #50 |

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

21. *Must.* As the owner, CI runs on GitHub's runners or on my own machine, switched by one command:
    `factory ci use local|github`, which sets or deletes the repo variable `CI_RUNS_ON` (my-skills #40). Pull
    requests from forks always stay on GitHub's runners.
22. *Must.* As the owner, setting up the self-hosted runner is one command that survives reboots:
    `factory ci install` (#40). Running it again updates the runner in place, and it warns when the checkout
    isn't on main.
23. *Must.* As everyone, a CI outage (billing, no runner) is shown as an outage, not as a code failure, and
    agents don't chase it (exists: `factory_ci.py`).
24. *Could.* As the owner, the self-hosted runner runs in an isolated VM, so a job can't reach my machine (#150).
    On 24 Oct the owner told an agent Docker is enough for now, so this moved from Should to Could.
25. *Could.* As the owner, several runners split a PR's jobs. Several Macs with one label already share the
    queue (#40); GitHub gives each job to one of them.
25a. *Must.* As the owner, `factory ci status` works in both modes. It shows:
    - where CI runs;
    - the latest run on main and on each open PR;
    - runs queued for long.

    In local mode it also shows the LaunchAgent and its pid, Docker, every runner with the label, and the last
    log lines (#40).
25b. *Must.* As the owner of several projects, each project's runner is named after it (`<repo>-ci`, label
    `<repo>-local`, unless `factory.json` says otherwise), so runners of two projects run side by side. Each
    shows by its own name in launchd and in GitHub's runner list (#40).
25c. *Must.* As the owner, one `factory` command handles CI whichever mode is on. The agents' commands don't
    change with the mode (#40).
25d. *Should.* As the owner, a project with its own runner from before `factory ci` moves to it in one
    `factory ci install`. `"ci": {"replaces": [...]}` names the old LaunchAgent, which is unloaded and removed
    (#40; Remanual's migration).

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

33. *Should.* As the owner, I see tokens per agent, per task and per day. **In progress (#50):** `factory usage`
    reads Claude Code's own session logs on each machine, where every reply records input, cache writes, cache
    reads and output. It reports per task, per subagent type or per model. Money stays with `/usage` or the console,
    since prices differ per model.
56. *Must.* As the owner, every factory change meant to save tokens has a measured before and after.
    `factory usage --record "<label>"` appends a row of per-task averages to `docs/factory-usage.md` in the project,
    and the change's PR names the row it should move. Run it on each agent machine: the logs stay local.
57. *Should.* As the owner, routine subagents run on a cheaper model, and the reviews where a miss is costly keep
    the strongest. **In progress (#50):** the test-writer and architecture-reviewer run on Sonnet.
58. *Should.* As a coding agent, I read the parts of the docs the task and the diff point to, never whole documents
    by habit. My Stop check runs on the changed packages only and shows the failing lines first. **In progress (#50).**
59. *Should.* As the dev manager, I write the edge cases the reviewers will try into each task, so it passes review in
    one round. I tick every 10 minutes with work open, every 30 otherwise, and start a fresh session once a day so my own
    context stays small. **In progress (#50).**
60. *Should.* As the owner, `factory settings` lists every setting with its value, default, type and options, and
    changes one checked against its type. Agents can read settings but never change them. **In progress (#50)**;
    this covers story 7 from the command line.
34. *Could.* As the owner, I set a daily budget per agent; the loop pauses when it's reached.

**Token plan (squeezing the lemon).** Measure, change one thing, measure again, and keep each row:

| Step | Change | Expected to move | Status |
|---|---|---|---|
| 0 | Baseline: `factory usage --since <a week back> --until <rollout> --record "baseline"` on each machine | — | to run |
| 1 | Sonnet for the test-writer and architecture-reviewer | subagent tokens on the strongest model | #50 |
| 2 | Read what the task points to (CLAUDE.md, the agents, next-task) | fresh input per task | #50 |
| 3 | Changed-only Stop check, failures first | tokens per Stop and turn time | #50; project sets `commands.testChanged` |
| 4 | Edge cases in each task | review rounds per task | #50 |
| 5 | Quieter dev manager, a fresh session daily | the dev manager's cache reads | #50 |
| next | Pick from the largest row of `factory usage --by agent`: e.g. prompt size of the loop's first message, a smaller CLAUDE.md, fewer subagent re-reads | — | after step 0 and the first "after" row |

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

### Learnt on 23–24 Oct

43. *Must.* As the owner, CI has enough capacity: several runners, or GitHub's runners for some jobs, so a PR
    that passed review doesn't wait hours (P18). `factory ci status` shows the queue and how long each job
    waited.
44. *Must.* As the owner, agents' local test runs and CI don't share one machine's cores, or the factory limits
    how many run at once (P19).
45. *Must.* As everyone, a job that ran out of time, lost its runner or was cancelled by a newer commit is shown as
    infrastructure, not as a failed check. The factory re-runs it once by itself and tells the owner only if it
    happens again (P19, P20).
46. *Must.* As the owner, the factory keeps working when my laptop sleeps: agents and the runner live on a machine
    that stays on, or the laptop is kept awake while the factory runs (P21).
47. *Must.* As a coding agent, the Factory guard judges the labels the PR has now, not the ones on the event that
    started the run (P22).
48. *Must.* As the owner, the dev manager's schedule doesn't depend on each tick scheduling the next. A missed
    tick is noticed within one interval and restarted (P23; sharpens story 28).
49. *Must.* As the owner, a decision I give an agent in its terminal is written to the issue or PR as a marked
    comment, so the dev manager and other agents see it (P24).
50. *Must.* As the owner, every question waiting on me is one item in one list, with its context, a recommendation
    and the options, and it leaves the list when I answer (P25; this is the inbox of section 6).
51. *Should.* As the owner, when no agent is running, the dev manager can build a small task with the same tests
    and reviews, and I can say whether it may merge its own PR (P26).
52. *Should.* As the dev manager, my workspace can install the project's packages and run its test suite, or I
    can ask the dev machine to run it (P26).
53. *Should.* As the owner, the factory notices when a reviewer is unavailable (Copilot's quota, no log access)
    and says so once, instead of each review finding out (P27).
54. *Should.* As a coding agent, before I claim a task the factory checks it isn't a duplicate of an open or
    closed one (P28).
55. *Could.* As the owner, the task board is a GitHub Projects board the factory keeps in step with the labels.
    I chose this on 23 Oct; it waits on the GitHub MCP server being set up on the Mac.

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

The night of 23–24 Oct supports this order: almost every message to the owner was either a question for him or
"CI is queued on your Mac" (P18, P25). Design alternatives for the UI are in the "Software factory UI" design.

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
- **Security of the self-hosted runner** (privileged Docker today; #150). `factory ci` makes it easy to turn on in
  every project, which spreads the same risk. *(inference)*
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
8. Once the billing block is lifted, should CI go back to GitHub's runners (`factory ci use github`), stay on the
   Mac, or depend on the project? The local runner costs no minutes but runs branch code on your Mac (#150).
9. Should `factory ci` support Linux machines (systemd) as well as macOS, for example for the dev laptop? Today
   it is macOS only.
10. Where should the agents and the runner live so they keep going when your laptop sleeps (P21): the dev
    laptop, a small always-on machine, or GitHub's runners for CI?
11. May the dev manager merge its own PRs when no agent is running, after the reviewer and CI pass (P26)?
12. Should CI's test-job time limit go from 15 to 25 minutes now, while the runner is shared (P19)?

## 9. Roadmap

| Phase | What | Done when |
|---|---|---|
| **0. Reliable loop** (mostly done) | Done: the 22 Oct fixes (#33–#38), `factory ci` (#40), #41, #42, merge-not-rebase (#44). Left: CI capacity and re-runs of infrastructure failures (stories 43–45), an always-on machine (46), the guard reading current labels (47), a tick that can't break (48), the dev-laptop setup script, the priority label honoured | Two agents run 24 h with no stall the owner has to fix; CI keeps up with them; one-script setup of a new machine |
| **1. One place to look** | `factory status` and `factory doctor` (taking in `factory ci status`); a pinned GitHub status issue the dev manager edits; the state store (option B) rebuilt from GitHub | The owner answers "what's waiting for me?" from one page, and the tick message shrinks to a pointer to the store |
| **2. The inbox** | A mobile web inbox of decisions with one-tap answers written back as marked comments; notifications only for inbox items; a daily digest | A week of operation where every owner decision went through the inbox, not chat |
| **3. Dashboard and TUI** | The status page (agents, board, PR queue, CI, usage where available); `factory top` | The owner can see and act on every agent and PR from a phone or the dev laptop |
| **4. Product** | An installer and wizard for any repo, the agents' own account, packaging (plugin plus CLI or submodule), docs and an example repo | A second repo goes from zero to a first merged agent PR by following the quick start alone |

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
