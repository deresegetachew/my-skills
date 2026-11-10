# 0009: Plugins and separable adapters: the code host, CI and notifications behind ports; Jira as the first outside adapter

Date: 10 Nov 2026. Status: **proposed** (#538); the owner approves it. Part of epic #243.
The owner's direction (7 Nov): "the plugins are needed, jira can be one … we need to make sure things are separable,
not for now but future."
**Builds on 0003** (ports and adapters) and **0007** (the message board is the record). It fills in what 0003 left for
later: which ports come next, how an adapter that is not built in is found and checked, and the rule that keeps new code
separable. Decision number 0006 is kept for the web UI amendment (#293) and 0008 for the single `factory` binary (PRD
4.6, planned).

## Context

Decision 0003 put the core behind ports. What is built today (`software-factory/hooks/core/`):

| Port | File | Adapters | Contract suite |
|---|---|---|---|
| `TaskTracker` | `core/ports/task_tracker.ts` | github, plan, board, memory | `tests/contracts/task_tracker.ts` |
| `Messaging`, `Leases`, `Wakes`, `PrFeed` | `core/ports/messaging.ts` | github, board, routed, memory | `tests/contracts/messaging.ts`, `bus.ts` |
| `AgentRoster` | `core/ports/agents.ts` | board | none |
| `Notifier` | `core/ports/notifications.ts` | mail over HTTP, mail over SMTP (#542) | none |

All of them are built in and chosen by a setting in `core/compose.ts`, the only file that imports an adapter
(`tools/check_skills.ts` enforces it). The plugin loader of decision 0004 (an npm package in
`software-factory/plugins/<name>/`, run in a child Bun) existed only for the NATS client and went with it (#504).

Everything about pull requests, checks and CI is still outside the ports. Counted roughly with grep on main on 10 Nov
2026 (the numbers move with the pattern; #243's inventory step makes the exact list):
- about 30 files in `hooks/` call `gh pr ...` or read `pulls` and check runs, the PR gate (`pr-gate.ts`) and the dev manager's
  gate (`manager_gate.ts`) among them;
- at least 9 files read Actions runs, jobs or runners;
- about 45 files outside `core/adapters/github/` call `gh` in some form, through the shared `gh`/`ghAll` in
  `factory_issues.ts` and `factory_lib.ts` or a call of their own.

The PR gate decides merges by reading the agent's shell command: it allows `gh pr merge <n> --match-head-commit <sha>`
and refuses `gh api` (#182). That ties the gate to one vendor's command line.

## Decision

### 1. The ports

Each says what it does in the factory's words. An adapter maps them onto a vendor.

| Port | What it does | Built-in adapters | Status |
|---|---|---|---|
| `TaskTracker` | the tasks, their state, claims, todos, epics, dependencies | board, github, plan, memory | built |
| `Messaging` (with `Leases`, `Wakes`, `PrFeed`) | questions, answers, verdicts, wake-ups between agents | board, github, memory | built |
| `AgentRoster` | who is alive, on which machine, doing what | board | built; needs a fake |
| `Notifier` | tell a person something outside the web UI (a code, an ask waiting) | mail (HTTP, SMTP) | built; needs a fake |
| **`CodeHost`** | a change request (a pull request or merge request): open it, read its head commit, files, size and comments, comment on it, label it, and **merge it pinned to one head commit**; delete its branch | github | new |
| **`GateRecord`** | the facts the gates trust, for one head commit: the reviewer's pass, approvals, must-fixes, holds, and who wrote each | github | new |
| **`Ci`** | the checks for a commit (pending, green, red with the failing jobs, not started), a job's log, a rerun, and where jobs run (`factory ci use local\|github`, the runners) | github (Actions and the local runner) | new |
| **`RepoConfig`** | the account, the owner's login, the main branch, and `factory.json` as read from main | github | new |

0003's `OwnerInbox` is not a port of its own: under 0007 the owner queue is on the board (`Messaging`), and its GitHub
issue is the mirror's.

### 2. What stays in the core

An adapter reports facts. It never decides. These stay in the core, in protected files:

- **The gates' rules:** what a merge needs (the reviewer's pass for the head commit, CI green, no protected file, no
  hold or must-fix from the dev manager, the owner's merge for `.claude/` changes). The gate asks `GateRecord` and `Ci`
  for facts and applies the rules itself.
- **Trust:** which logins count (the owner, the dev manager's account), and that a fact counts only for the head
  commit. `GateRecord` returns who wrote what; the core checks the login.
- **Protected paths** and the owner's merges. `CodeHost` returns the changed files; the core matches them.
- **Pinning:** a merge is always pinned to the head commit the gate checked. A code host that cannot pin a merge
  cannot be a `CodeHost` adapter; `factory doctor` says so.
- **Failing closed:** a missing, failing or unknown adapter refuses the merge with `{code, message, fix}`.
- **`factory.json` from main** for the gates (`RepoConfig`), never from the branch.

`CodeHost`, `GateRecord` and `RepoConfig` are **built-in only**: their adapters live in `hooks/core/adapters/`, which is
protected, and no outside plugin may provide them (point 3). A second code host (GitLab) is built in the same way.
`GateRecord` always uses the same vendor and login as `CodeHost` (0003 point 3).

**The gate stops reading vendor commands.** An agent merges with one factory command, `factory pr merge <n> --head
<sha>` (and opens one with `factory pr create`), which runs the gate's checks itself and calls `CodeHost`. The PR gate
hook then refuses the vendor's own merge and API commands (`gh pr merge`, `gh api`, later `glab mr merge`, `glab api`),
from a list each built-in code-host adapter declares. While both exist, `gh pr merge` keeps working as today.

### 3. How an adapter is found, configured and checked

Options weighed:

| | (a) Built in, chosen by a setting | (b) A TypeScript module in a folder, imported | (c) A command in a folder, JSON on stdin and stdout |
|---|---|---|---|
| What it is | today's: `core/adapters/<name>/`, `compose.ts` picks it | `plugins/<name>/index.ts`, loaded with `import()` | `plugins/<name>/plugin.json` names a command; one request per run |
| Language | TypeScript | TypeScript, Bun only | any |
| npm packages | none (house rule) | bundled at release, as 0004 did | the plugin's own business |
| With the single binary (0008) | embedded | needs loading code from disk into a compiled binary: unproven | a child process; nothing to load |
| Isolation | none needed (it is the core) | none: it runs in the factory's process with its secrets | its own process, env and exit code; a hang is a timeout |
| Fits the ports | yes | yes | yes: the ports are synchronous, and the board adapter already works this way (`core/adapters/board/child.ts`) |

**Decision:**
- **Adapters the factory ships are built in (a).** That covers everything here, Jira included: Jira's REST API needs
  only `fetch`.
- **An outside plugin uses the command protocol (c).** It is built when the first adapter the factory does not ship
  is needed, not now. Its shape is fixed here so new ports stay fit for it:
  - **Found** in `.claude/factory/plugins/<name>/` (a protected path), with `plugin.json`: `name`, `version`,
    `protocol` (1), `ports` (which ports it provides), `command` (relative to the folder), `settings` (its keys with help
    and default, as `factory_settings_schema.ts` has them).
  - **Turned on** in `factory.json`: `"plugins": {"<name>": {"sha256": "<of plugin.json and the command>"}}`, and the
    port's setting names it (for example `"tasks": {"source": "plugin:<name>"}`). A plugin whose hash does not match is
    refused. Its settings sit under `"plugins": {"<name>": {"settings": {...}}}`.
  - **Secrets** never go in `factory.json` (it is in git): they are in the machine settings folder, mode 600, as the
    mail settings are (`ui/mail.json`), or the environment, and are passed in the plugin's environment only.
  - **A call** is one run: `{"protocol": 1, "port": "tasks", "op": "list", "args": {...}}` on stdin, and on stdout
    `{"ok": true, "result": ...}` or `{"ok": false, "error": {"code", "message", "fix"}}`. Exit 0 either way; any
    other exit, bad JSON or a timeout (setting, default 30 s) is a `plugin-failed` CoreError. The core checks each
    result against the domain type before using it.
  - **`describe`** returns the name, version, protocol and ports; **`health`** checks its settings and that it can
    reach its service.
  - **Checked:** `factory doctor` runs `describe` and `health` for each turned-on plugin and checks the hash, with the
    fix for each failure. The port's contract suite can run against a plugin through the protocol, so a plugin author
    tests it the same way the built-in adapters are tested.
  - **Released:** a plugin is not part of the factory's release archive. The owner installs it into the project and
    pins its hash. The factory's release carries the protocol version it speaks; `factory doctor` refuses a plugin for
    another version.
- A plugin may provide `TaskTracker`, `Notifier`, `AgentRoster` and `Ci`'s read side. It may never provide `CodeHost`,
  `GateRecord` or `RepoConfig` (point 2).

### 4. Jira as the first outside adapter: tasks only, GitHub for code

Under 0007 the board is the record and GitHub Issues is its import and its mirror. Jira takes the same place:

- **Choice (recommended): Jira as the board's import and mirror.** `factory board import` learns a Jira source and brings
  the project's issues in, and `factory board mirror` carries each state change back to Jira, as it does for GitHub's
  labels today. Claims, heartbeats, threads and the owner queue stay on the board, where they already work.
- **The other option: Jira as a `TaskTracker` of its own** (`tasks.source: jira`), for a project with no board. It
  needs claims Jira does not have (below), so it comes later, if a project asks.

Mapping:

| The factory | Jira | Fits? |
|---|---|---|
| Task id (`#5`, `b12`) | the issue key (`SHOP-123`); the board keeps it as the card's source | yes; branches become `task/shop-123-<name>` |
| Title, body | summary, description | the description is Atlassian Document Format (JSON), not markdown: converted both ways, losing what doesn't map |
| ready, in progress, in review, blocked, done | statuses, reached by **transitions** | only through a status map in the settings (`jira.statuses`), because every Jira workflow differs. The adapter moves a task by finding a transition to the mapped status; none is `jira-no-transition` with the fix. `factory doctor` checks every mapped status exists and is reachable |
| Blocked, and why | a status or a flag, and a comment | yes |
| Claim (who holds it, until when) | assignee | no: all agents share the owner's account (D9), so the assignee can't tell them apart, and Jira has no expiry or compare-and-set. The claim stays on the board; the mirror may set the assignee to the owner's account |
| Todos (`- [ ]`) | none built in (sub-tasks or a marketplace app) | no: the todos stay in the board's copy of the body |
| Epics, subtasks | epics (the parent field), sub-tasks | yes |
| Dependencies | issue links ("blocks", "is blocked by") | yes |
| Group (milestone, phase) | fix version or sprint | yes, one chosen in the settings |
| Tags | labels | yes |
| What people said | comments | yes; but there are no hidden comments, so the factory's markers would show. Markers stay on the board and GitHub |
| `Closes #n` in a pull request | nothing: GitHub can't close a Jira issue | the factory closes the task after the merge, as `factory board sweep` does on the board today (#536), and the mirror moves the Jira issue to done |
| The `Budget:` line, the PRD wait (#578) | a custom field, or a line in the description | a line in the description, read on import |

Also: Jira Cloud signs in with an email and an API token, Data Center with a personal access token; both are secrets
(point 3). Jira's rate limits are per user, so the import and mirror read only what changed since a cursor (`updated`
in JQL).

### 5. Separability rules for new code, from now on

1. **No new direct `gh` call outside `core/adapters/github/`.** `tools/check_skills.ts` lists the files that spawn `gh`
   or call `api.github.com` today (the inventory of #243's second step). A file not on the list that does so fails the
   check, with the fix: use a port, or add the call to the GitHub adapter. The list only shrinks: an entry that no
   longer calls `gh` fails too, so it is removed when its file moves behind a port.
2. **Every port has a fake and a contract suite.** For each file in `core/ports/`, `check_skills.ts` requires an
   in-memory adapter in `core/adapters/memory/` and a suite in `tests/contracts/`, and the built-in adapters run the
   suite. `AgentRoster` and `Notifier` get theirs first.
3. **The core never names a vendor.** `core/domain/` and `core/ports/` already import only each other (checked today);
   their words are the factory's (change request, checks), not GitHub's (pull request, Actions), except in comments
   that say which adapter does what.

### 6. The order of work, as issues under #243

1. This decision (#538), with 0003's status line made true.
2. The separability check (point 5.1) with today's list of `gh` files, which is #243's inventory; fakes and contract
   suites for `AgentRoster` and `Notifier` (point 5.2).
3. One GitHub transport for the hooks (0003 step 1): the private `gh` wrappers onto one module, commands byte for byte
   the same.
4. The `CodeHost`, `GateRecord`, `Ci` and `RepoConfig` ports, their fakes and contract suites, and the GitHub adapters,
   with no caller moved yet.
5. Move the callers, read-only first: status, the web UI, reports and waits; then create, comment and label; each step
   shrinks the list.
6. `factory pr create` and `factory pr merge`, and the gates onto `GateRecord` and `Ci`. Protected: reviewed and
   merged by the owner.
7. Jira as the board's import and mirror (point 4), once the owner picks it.
8. The command protocol for outside plugins, `factory doctor` for plugins, and the wiki page on writing an adapter,
   when the first outside adapter is wanted.

## Open questions for the owner

1. **Jira's place:** the board's import and mirror (recommended), or a `TaskTracker` of its own for projects with no
   board?
2. **Outside plugins:** is the command protocol (any language, its own process) the right shape, and should it wait
   until an outside adapter is wanted, as proposed?
3. **The gate:** agents merge with `factory pr merge` and the gate stops reading `gh pr merge` once it exists. Agreed?
4. **`factory.json`:** this adds `plugins` and `jira` sections and keeps today's layout. Or does the next major release
   break it?
5. **Which code host second**, if any: GitLab is the closest fit; none is planned in this decision.

## Consequences

- More ports and files; in return the gates and roles name no vendor, and Jira (or GitLab later) is an adapter and a
  setting.
- The PR gate gets simpler: it guards one factory command and refuses the vendors' own, instead of parsing `gh`.
- Nothing about trust moves to a plugin: the code host, the gate's facts and the repo's config stay built in and
  protected.
- The check in point 5 makes the migration visible: the list of `gh` files is how far there is to go.
