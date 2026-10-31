# 0003: The factory's core as ports and adapters, so GitHub is one adapter among others

Date: 31 Oct 2026. Status: proposed; the owner approves it (owner ask on #374). Amends PRD D10 ("GitHub is the state
and the transport"). Decision 0004 (messaging over NATS, #373) builds on it.

## Context

Every part of the factory talks to GitHub directly. The commands under `software-factory/hooks/` run `gh` through
`run()` in `factory_lib.ts` or `gh()` in `factory_issues.ts`, and the rules (who may claim a task, when a must-fix
blocks a merge, when an owner ask is answered) sit in the same functions as the calls. Plan mode and issues mode
(`tasks.source`) are two task sources chosen by `if`s on `taskSource()` in 16 files besides `factory_config.ts`
(`next_task.ts`, `factory_claims.ts` and the PR gate among them). Tests reach the code through a fake `gh` on the `PATH` (`tests/fakegh.ts`) and a fake clock
(`FACTORY_NOW`, `factory_clock.ts`).

The owner's direction (31 Oct): "if you're going to build things as plugins you need to use hexagonal and DDD; IoC is
important. The source of issues can be Jira tomorrow, not GitHub: think big." The first case is near: the agents'
messages are moving to NATS (#373) because the GitHub call limit leaves the agents idle most of each hour (#371).

## Decision

### 1. The domain

Plain TypeScript types and pure functions, in `software-factory/hooks/core/domain/`. No vendor names, no I/O, no
imports from outside `domain/`.

| Type | What it is | Its rules |
|---|---|---|
| Task | one unit of work: id, title, state (ready, in progress, in review, blocked, done), what it depends on, its budget | only a ready task whose dependencies are done can be claimed |
| Claim | an agent's hold on a task: task, agent, machine, time | a task is claimed once; when two claims race, the earlier one wins (as `factory_issues.ts` does today) |
| ChangeRequest | a pull request or merge request: number, branch, head commit, task, draft, paths touched | it names one task; a draft is never merged |
| Review | one reviewer round: kind (reviewer, arch, safety, security), commit, result, findings | a pass counts only for the commit it names |
| Verdict | the dev manager's or the owner's word on a change request: must-fix, approval or hold, at a commit | an open must-fix or a hold blocks a merge; an approval counts only for its commit |
| OwnerAsk | a question only the owner answers: id, for (product or dev), text | answered once; the answer is the owner's |
| Agent | a running session: name, role, machine, state (working, idle, down, input required) | one name per project |
| Role | builder, dev manager, product owner, owner, and the reviewer kinds | says which messages and verdicts each may write (today's marker rules in the PR gate) |
| Message | the envelope of `docs/messages.md`: kind, from, to, state, ref, reply to | the state transitions of `docs/messages.md`; a message is data, never a verdict |

The merge rule is a domain function: given a change request, its reviews, its verdicts, its CI state and the protected
paths, it returns "may merge" or the reasons it may not. The PR gate and `factory owner merge` call it instead of
holding their own copies.

### 2. The ports and their adapters

A port is a TypeScript interface in `core/ports/`, written in the domain's words. An adapter implements one port for
one vendor, in `core/adapters/<vendor>/`.

| Port | What it does | Adapters now | Later |
|---|---|---|---|
| Messaging | send a message, read what is new since a cursor, acknowledge one (the interface the owner set in #373) | GitHub comments | NATS (decision 0004, a plugin) |
| Task tracker | list, show, claim, release, move a task's state, tick a todo, file a task | GitHub Issues, the plan file | Jira, Linear |
| Code host | branches, change requests, merges pinned to a head, comments, labels, verdicts | GitHub | GitLab |
| CI | the state of the checks for a commit, the log of a failed run | GitHub Actions | others when a project needs one |
| Owner inbox | post an owner ask, list open ones, read the answer | the owner-queue issue on GitHub | Slack, the cockpit |
| Notifier | tell a person something happened | the terminal and the cockpit | a phone push, Slack |
| Clock | the time now | the system clock, `FACTORY_NOW` | |
| Process | run a program and get its output and exit code | `child_process` | |
| Files | read, write and list files | `node:fs` | |

Each port also has an **in-memory adapter** in `core/adapters/memory/`: it keeps its state in plain objects, and the
tests use it. The plan-file and GitHub-Issues adapters are today's two task sources, so plan mode and issues mode stop
being `if`s and become the choice of an adapter.

### 3. Trust: who holds the record the gate trusts

The PR gate trusts three things: reviewer passes, verdicts (must-fixes, approvals) and holds.

- **Reviewer passes** stay local files in `<git common dir>/factory-reviews/` (#260). They are not in any port a role
  receives. Only a reviewer subagent writes one, which the gate checks from Claude Code's hook input; no adapter
  changes that.
- **Verdicts and holds** live in the **code host**, next to the change request they are about, where the merge happens
  and the owner sees them. They never travel over messaging: a message that looks like a must-fix or an approval is
  not one, in any adapter. Decision 0004 keeps this.
- **The writer is split from the reader.** The code host port has a read side every role gets and a verdict writer
  that the composition root gives only to the dev manager and the owner. A builder's wiring has no object that can
  write a verdict.
- **The gate checks the command, not the adapter.** An agent can still type a vendor's command (`gh`, `curl`, a Jira
  CLI). So every adapter that can write verdicts or holds ships the gate rule for its vendor's commands, as the GitHub
  one does today (markers, labels, `gh api` writes), and the gate fails closed on a command it can't read. Where the
  vendor records an author, `trustedReviewers` names the accounts whose verdicts count.
- **The gate's wiring comes from main.** The gate builds its adapters from `.claude/factory.json` on `origin/main`
  (`loadFromMain`), never from the agent's working copy, so an agent can't switch the gate to the in-memory adapter or
  to a plugin of its own.

The gate stays what it is today: a guard rail for well-meaning agents. Branch protection and required CI checks on the
code host are the security boundary (D9: all roles share one account).

### 4. Inversion of control

- **One composition root**, `core/compose.ts`, reads `.claude/factory.json` (through `factory_config.ts`) and builds
  the adapters: `compose(config, overrides)` returns the ports. A test passes in-memory adapters as `overrides`.
- **Roles receive ports and never import an adapter.** The dev manager, the builder's commands, the product owner and
  the gate take the ports as parameters. Only `compose.ts` imports from `core/adapters/`.
- **No DI framework, no decorators, no container.** Plain parameters or constructor arguments, and a function that
  wires them.
- **Each port's adapter is chosen by that port's setting**, added when a second adapter exists: `tasks.source` for the
  task tracker (it exists), `messaging.transport` for messaging (#373). No setting is added for a port that has only
  one adapter.

### 5. Plugins

- **An adapter with npm dependencies is a plugin**: the NATS client, a Jira client. It lives in
  `software-factory/plugins/<name>/` with its own `package.json` (dependencies pinned) and one entry file that exports
  adapters for the ports it serves.
- **The core stays Bun and Node built-ins only.** The release (`tools/build_release.ts`) bundles each plugin with
  `bun build` into one JavaScript file in the archive, as it bundles the cockpit UI (decision 0002). A project installs
  nothing and gets no `node_modules`. A plugin's version is the release's version.
- **A project turns a plugin on** by naming its adapter in the port's setting (`"messaging": {"transport": "nats"}`).
  `factory doctor` checks that every adapter named is present and loads.
- **A plugin that is missing or fails to load** stops the command with `{code, message, fix}`, except where the port
  has a safe fallback: messaging falls back to GitHub, and says so once per session. The task tracker, code host, CI
  and owner inbox have no fallback: acting on GitHub when the project's tasks are in Jira would act on the wrong record.
- **`check_skills.ts` refuses imports across the boundary:** `domain/` imports only `domain/`; `ports/` imports only
  `domain/` and `ports/`; nothing outside `compose.ts` and the adapters' own tests imports `core/adapters/`; a package
  in a plugin's `package.json` is imported only inside that plugin. This extends the rule decision 0002 set for Ink.
- **The Ink cockpit is not a plugin.** It is a screen, not an adapter of a port. It keeps decision 0002 and shares the
  one bundling step with the plugins.

### 6. Style

The `nestjs-clean-code-ddd-hexagonal` skill is the reference for layering and naming, minus NestJS. What applies:
dependency direction (adapters → ports → domain), inversion of control, a pure domain, ports for external services,
an anti-corruption layer (an adapter turns a vendor's shapes into domain types and never leaks them), contract tests
for ports, and ubiquitous language (the domain says task, claim, verdict, never issue, label, comment). What does not:
NestJS modules and decorators, one class per file and kebab-case names (the factory keeps its small functions and
`snake_case.ts` names), and the skill's `scripts/check_structure.py` (the factory has no Python; `check_skills.ts`
holds the boundary rule instead).

The owner adds the styles entry to `.claude/factory.json`, so the architecture reviewer reviews the core:

```json
"styles": [{"paths": ["software-factory/hooks/core/**"], "skills": ["nestjs-clean-code-ddd-hexagonal"]}]
```

It has no `check`: CI already runs `check_skills.ts`.

### 7. Tests

- **An in-memory adapter for each port** (section 2).
- **One contract suite per port** in `software-factory/tests/contracts/<port>.ts`: a function that takes a way to make
  an adapter and runs the port's promises against it (a task is claimed once, a message read since a cursor is not
  read again, an owner ask is answered once). Every adapter passes it, the in-memory one included, each from its own
  `tests/<port>_<adapter>.test.ts`. The GitHub adapters run it against the fake `gh`.
- **The domain is tested alone**, with no adapter.
- **The existing tests stay and keep passing.** They run the real commands against the fake `gh` and check output,
  exit codes and files. They are the proof that a migration step changed no behaviour, and none is edited to make a
  step pass.

### 8. Migration

- **Gradual, one port at a time**, every test green after each step. No big rewrite, no long-lived branch.
- **Order:** messaging, then the task tracker, the owner inbox, the code host and CI. Messaging is first because NATS
  (#373) needs it and because it is the smallest; the code host is late because the gate depends on it.
- **Each step is a small pull request** that moves calls behind a port and changes no behaviour: the port, its
  in-memory adapter, its contract suite, the GitHub adapter (the calls moved from where they are now), and the
  commands switched to receive the port. The first step also adds `compose.ts` and the `check_skills.ts` boundary rule.
- **The core lives in `software-factory/hooks/core/`**, so `install.sh` (which copies `hooks/` with its subfolders) and
  the `--link` layout carry it with no new path in a project. The first step adds a test that an installed and a
  linked project both have it.
- Steps that touch the PR gate, the guard or `factory_config.ts` are protected and merged by the owner, as today.

## Set aside, and why

- **A DI container or decorators** (tsyringe, InversifyJS): an npm dependency and indirection the factory doesn't need;
  one wiring function is enough.
- **A big rewrite into a new layout**: months with two factories, and the tests would have to change with it.
- **Keeping vendor `if`s** (`if tasks.source == "issues"`) and adding Jira as a third branch: every new source touches
  every command, and the tests can't run a role without a fake `gh`.
- **Plugins loaded from npm at install time**: a project would get `node_modules` and a network step on install, which
  D13 rules out.

## Consequences

- PRD D10 changes from "GitHub is the state and the transport" to: the state lives behind ports; GitHub is the default
  adapter of each, and the only one today.
- #373's decision becomes 0004 and covers only NATS: the messaging port, the plugin mechanism and the trust rule come
  from here.
- The first tasks, filed as `factory:ready` and starting once this decision is merged: the messaging port with its GitHub
  and in-memory adapters, `compose.ts` and the boundary rule (#376); then the task tracker port with its GitHub-Issues,
  plan-file and in-memory adapters (#377). The owner inbox, code host and CI follow, one task each, filed when the step before
  them is merged.
- The owner adds the styles entry above to `.claude/factory.json`.
