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
    factory_watch.py                    the dev manager's seven checks on GitHub (`factory watch`), no model
    factory_orchestrator.py             `factory dev-manager loop`: cycles, thread notes, owner asks, sub-managers
    factory_lease.py                    the lease on an item (claim comments), the interface #99 will replace
    factory_roles.py                    the roles' definitions, role folders (`init-roles`) and `choose`
    manager_gate.py                     PreToolUse for the manager: merge gate, refs, protected places, secrets
    factory_ci_judge.py                 CI judged the manager's way: newest non-skipped run per job
    factory_lessons.py                  the curated lessons file: show, check, suggest, add, prune
    factory_manager_claims.py           several dev managers at once: review and question claims with a lease
    factory_rereview.py                 incremental re-review: the delta since a reviewer's last round
    factory_reset_run.py                `factory reset-run`: list and clean what an earlier run left (claims, Agent issues, CI containers, runners, a runs-on variable)
    factory_stack.py                    the project's stack on a first install (node, python, unknown) and the Python CI's command runner
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

Previous: [Settings and style guides](settings.md) | Next: [Projects that use the submodule](submodule.md)
