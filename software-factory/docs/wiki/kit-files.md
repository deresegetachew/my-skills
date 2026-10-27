# The files in the kit

What the kit holds and what a project receives from it.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [The files in the kit](#the-files-in-the-kit)

<br>

## The files in the kit

```
software-factory/
  README.md                               the front page; the wiki pages are in docs/wiki/
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
    factory_watch.ts                    the dev manager's seven checks on GitHub (`factory watch`), no model
    factory_orchestrator.ts             `factory dev-manager loop`: cycles, thread notes, owner asks, sub-managers
    factory_lease.ts                    the lease on an item (claim comments), the interface #99 will replace
    factory_roles.ts                    the roles' definitions, role folders (`init-roles`) and `choose`
    manager_gate.ts                     PreToolUse for the manager: merge gate, refs, protected places, secrets
    factory_ci_judge.ts                 CI judged the manager's way: newest non-skipped run per job
    factory_lessons.ts                  the curated lessons file: show, check, suggest, add, prune
    factory_manager_claims.ts           several dev managers at once: review and question claims with a lease
    factory_rereview.ts                 incremental re-review: the delta since a reviewer's last round
    factory_reset_run.ts                `factory reset-run`: list and clean what an earlier run left (claims, Agent issues, CI containers, runners, a runs-on variable)
    factory_stack.ts                    the project's stack on a first install (node, python, unknown) and the CI command runner for a Python project
    pr-gate.ts                          PreToolUse: gates gh pr create, ready and merge, and the markers
    check.ts                            Stop: typecheck and tests (in a factory run only)
    factory_stop.ts                     Stop: closes a finished session in `factory loop -i`
    factory_session.ts                  SessionStart: a plain `claude` session becomes an agent
    factory_agents.ts                   live agents: register, ping, down, sweep (and the hook entry)
    next_task.ts                        the next job: rework first, then a free task
    factory_machine.ts                  this machine's id, agent names and autostart settings (outside the repo)
    factory_autostart.ts                `factory autostart`: status, install and uninstall of the boot service
    factory_resume.ts                   `factory resume`: the boot step (stack, backups, agents in tmux)
    factory_heartbeat.ts                `factory heartbeat`: the per-machine liveness daemon
    factory_heartbeat_service.ts        install and uninstall of the daemon's service
    factory_agents_ls.ts                `factory agents ls`
    factory_claims.ts                   lock file: a folder and a task per agent; worktrees; clean
    factory_status.ts                   `factory status`: agents, PRs, CI and tasks at a glance, read-only
    factory_prs.ts                      `factory prs`: the manager's one list; the CI rule and marker reading `status` shares
    factory_issues.ts                   tasks as GitHub issues: pick, claim, tick, block, release, stale
    factory_env.ts                      per-agent ports and database
    factory_follow.ts                   `factory follow`, `say`, `remote` and `agent --detach`
    factory_remotes.ts                  remotes, ssh calls and finding sessions by name
    factory_doctor.ts                   `factory doctor`: checks a machine and project, read-only
    factory_release.ts                  `factory version | releases | update | rollback`: the release client
    factory_bootstrap.ts                `factory bootstrap`: machine, project, status, uninstall (plan first, --apply as root)
    factory_bootstrap_core.ts           the steps and actions bootstrap is built from, and the executor
    factory_bootstrap_machine.ts        the root steps: packages, user, subuid, linger, guard, SSH, keep awake
    factory_bootstrap_project.ts        the user's steps: rootless Docker, Node, Claude Code, checkout, runners; the human steps
    factory_netguard.ts                 renders the nftables rules and the guard's systemd unit
    factory_sandbox.ts                  `factory doctor --sandbox`
    factory_models.ts                   the `models` setting: claude flags per role, effective models
    factory_fix.ts                      `factory fix`: format and auto-fix the changed files (`commands.fix`)
    factory_run_check.ts                `factory run-check`: a quiet check with the full log on disk
    factory_messages.ts                 the message envelope (`factory-msg`): build, parse and states (docs/messages.md)
    factory_cards.ts                    agent cards: who an agent is and what it can do, as data
    factory_clock.ts                    the one clock the scripts share; tests can set the time
    factory_reviews.ts                  which extra reviews a change needs
    factory_report.ts                   `factory report`: per-task timings, rework rounds and CI runs from GitHub
    factory_settings.ts                 `factory settings`: the commands (list, get, set, unset, help, diff, validate, pr, docs)
    factory_settings_schema.ts          the table that describes every setting: help, limits, defaults, README tables
    factory_settings_store.ts           reads and writes factory.json and the machine file (order, indent, atomic)
    factory_settings_interactive.ts     the interactive menu behind `factory settings`
    factory_settings_save.ts            `factory settings pr`: branch, commit, push and open the pull request
    factory_usage.ts                    `factory usage`: tokens per task from the local Claude Code logs
    factory_artifacts.ts                `factory artifacts`: repo copies of artifacts and designs, the manifest, status
    factory_handover.ts                 `factory handover snapshot`: the state a manager hands over, read from GitHub
    factory_init.ts                     `factory init`: the project's scaffold (roles, labels, owner queue, PRD stub)
    factory_flow.ts                     `factory prd --stage`: the flow stages and the owner's gates
    factory_po.ts                       `to=po` questions: their level (product owner, dev manager, owner) from age and whether a PO runs
    factory_prd.ts                      `factory prd`: progress against the PRD, per user story
    factory_signoff.ts                  `factory signoff`: the sign-off and testing queue (plans, confirmations, results)
    factory_verify.ts                   `factory verify`: what CI runs, here, before a PR (`commands.ci`)
    factory_guard.ts                    the CI guard
    style_checks.ts                     CI: each style's check
    factory_config.ts                   reads factory.json, with defaults
    wait_for_merge.sh                   waits on a PR without spending tokens
    factory_wait.ts                     the other waits (ci, answer, slot, ready) and the dev manager's precheck
    factory_tick.ts                     `factory manage-tick`: the precheck, then one manage-pass session only when there is work
    factory_turbo.ts                    `factory turbo`: the shared Turborepo cache (status, install, down, env, ci-env)
  ci/                                     `factory ci`: ci.sh (the commands), loop.sh (installed as <name>),
                                          compose.yaml, compose-light.yaml, compose-caches.yaml, compose-turbo.yaml,
                                          runner.Dockerfile, install-tools.sh, entrypoint.sh, ci_names.ts,
                                          ci_status.ts
  kit/                                    what a project is given (templates, agents, skills, settings); no
                                          factory code and no symlinks (the forwarders went in #176)
    CLAUDE.factory.md                     template for the project's CLAUDE.md
    .claude/factory.json                  template: the project's config
    .claude/factory/notes/                template: the project's notes for the agents
    .claude/factory/lessons.md            template: the curated lessons file (empty)
    .claude/factory/settings.json         the agents' rules (permissions and hooks); the factory passes it when it starts an agent, a plain session never loads it (#258)
    .claude/agents/                       reviewer, architecture-reviewer, safety-auditor, security-reviewer, test-writer
    .claude/skills/                       next-task, design-check, eval
    .claude/skills/manage-pass/           the dev manager's standing rules (one page)
    .claude/skills/product-pass/          the product owner's standing rules (one page)
    .claude/manager/settings.json         the dev manager's settings profile (gh api, read-only git, no pushes to main); a release installs and updates it
    .github/                              template: CI workflow, factory-task issue template, CODEOWNERS
    docs/                                 templates: build plan, blocked list, decision template
```

Run one test file with `bun tools/run_tests.ts pr_gate` (each file runs in its own process).

</details>

<br>

Previous: [Settings and style guides](settings.md) | Next: [Projects that use the submodule](submodule.md)
