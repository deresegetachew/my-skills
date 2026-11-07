# Every command and the web UI (#446)

The UI comes first (owner, 6 Nov): everything the factory does from a terminal can be done in the web UI. This is the
checklist. Each command `factory help` lists has one row; `tests/ui_parity.test.ts` fails when a command has no row, when
a row names a command that is gone, or when a row does not say how the UI covers it. `CommandMap.dc.html` is the same
map as a design page.

**In the UI** is one of:

- `built`: the web UI does it today (`factory ui`). A **Task** on a built row is the screen task that redoes it to the
  reference design.
- `planned`: its screen is designed; **Task** is the issue that builds it.
- `agents only`: a tool the agents run. The owner sees its result on the screen named.
- `terminal only`: it stays in a terminal, and **Where** says why.

A new command gets its row in the same pull request. When a screen ships, its rows turn `built`.

## First launch and setup

| Command | In the UI | Where | Task |
|---|---|---|---|
| `ui` | terminal only | Starts the web UI itself | |
| `ui sessions ls` | terminal only | The sign-in sessions, read on the hub machine; a person locked out of the page still reaches it there | #542 |
| `ui sessions revoke` | terminal only | Ends a sign-in session from the hub machine, also when the browser that holds it is lost | #542 |
| `ui mail set` | terminal only | Takes the mail key or password, which never goes through a page | #542 |
| `ui mail show` | terminal only | The mail settings, read on the hub machine, with no secret shown | #542 |
| `ui mail test` | terminal only | Sends a test mail, before anyone can sign in with a code | #542 |
| `install-shim` | terminal only | Puts `factory` on the PATH, before there is a UI to open; Welcome (Welcome.dc.html) says how | #457 |
| `doctor` | built | Health (Health.dc.html): each check grouped, with its fix, and Check again (`factory doctor --json`); Machine check (MachineCheck.dc.html, #457) shows this machine's, the board's and GitHub's checks on first launch | #455 |
| `bootstrap machine` | terminal only | Needs sudo; Machine check (MachineCheck.dc.html, built) shows the one admin step to type, with Copy | #457 |
| `bootstrap all` | terminal only | Needs sudo, as bootstrap machine | #457 |
| `bootstrap uninstall` | terminal only | Needs sudo; removes the sandbox user and its guard | |
| `bootstrap project` | planned | Machine check (MachineCheck.dc.html) | #457 |
| `bootstrap status` | planned | Machine check (MachineCheck.dc.html) | #457 |
| `init` | built | Project wizard (ProjectWizard.dc.html), Add project (AddProject.dc.html) | #447 |
| `init-roles` | built | Project wizard (ProjectWizard.dc.html): `factory init` makes the role folders | #447 |
| `prd` | planned | Kickoff (Kickoff.dc.html) for the stage; the PRD itself is in Docs (Docs.dc.html, built) | #457 |

## Team and machines

| Command | In the UI | Where | Task |
|---|---|---|---|
| `loop` | built | An agent's channel: start, after a confirm (runs the loop in its own window) | #453 |
| `coding-agent` | built | An agent's channel: start | #453 |
| `dev-manager` | built | The dev manager's channel: start | #453 |
| `product-owner` | built | The product owner's channel: start | #453 |
| `owner start` | built | An agent's channel and Team: start, after a confirm (Team also says when this machine runs as many coding agents as it may) | #581 |
| `owner stop` | built | An agent's channel and Team: stop, after a confirm | #581 |
| `agent` | planned | Agent (Agent.dc.html): open its session | #453 |
| `follow` | planned | Agent (Agent.dc.html): recent output and its Remote Control link | #453 |
| `say` | built | An agent's channel: chat | |
| `env` | planned | Agent (Agent.dc.html): details | #453 |
| `worktree` | planned | Agent (Agent.dc.html): details | #453 |
| `agents ls` | built | The agents in the sidebar and their channels | |
| `agents` | built | The agents in the sidebar; sweep stays with the dev manager | |
| `machine` | planned | Machines (Machines.dc.html); agent names in Choose team (ChooseTeam.dc.html) | #455 |
| `machine add` | built | Add machine (AddMachine.dc.html): the join code and the one command to run there | #445 |
| `machine join` | built | Join my factory (JoinHub.dc.html), on the new machine's own web UI: paste the code, see what it connects to, Join after a confirm (`POST /api/setup/join`) | #457 |
| `machine leave` | terminal only | Runs on a machine that joined, to stop using the board there; machine administration, like join | #514 |
| `machine ls` | built | Machines (Machines.dc.html): each machine added and whether it joined, its code is still waiting, or its code expired (its board login removed) | #445 |
| `machine remove` | planned | Machines (Machines.dc.html), after a confirm | #455 |
| `remote` | planned | Add machine (AddMachine.dc.html) | #445 |
| `board up` | terminal only | Starts the message board's Postgres on one machine, once; the web UI reads the board once it runs | |
| `board down` | terminal only | Stops the board's Postgres: machine administration | |
| `board status` | planned | Machines (Machines.dc.html): whether the message board answers | #472 |
| `board migrate` | terminal only | `factory update` runs it on the hub; while migrations are pending the Board page shows a notice with the fix | #570 |
| `board backup` | terminal only | Machine administration; a nightly backup is a job on the machine | |
| `board restore` | terminal only | Machine administration: it replaces the board's data, after `--yes` | #515 |
| `board sweep` | terminal only | Machine administration: the dev manager's loop runs it on each pass (#513); by hand or as a job on the board's machine otherwise | #511, #513 |
| `board queue` | built | Inbox: the page reads the owner queue with it when the owner queue is on the board | #513 |
| `board login add` | terminal only | `machine add` and `machine remove` make and drop a machine's board login; by hand it is machine administration | |
| `heartbeat` | planned | Machines (Machines.dc.html) | #455 |
| `autostart` | planned | Machines (Machines.dc.html), Team setup (TeamSetup.dc.html) | #455 |
| `resume` | planned | Machines (Machines.dc.html) | #455 |

## Every day

| Command | In the UI | Where | Task |
|---|---|---|---|
| `status` | built | Home (Main.dc.html): needs attention (#579), needs you, the team, progress by epic, recent activity | #451 |
| `snapshot` | built | What the UI reads; refresh asks for it again | |
| `talk` | built | An agent channel's talk box for the dev manager and the product owner: one turn, answer in the chat | |
| `owner answer` | built | The owner queue channel: answer, after a confirm | |
| `alerts check` | planned | Inbox (Inbox.dc.html): notify me | #451 |
| `alerts watch` | planned | Inbox (Inbox.dc.html): notify me | #451 |
| `messages` | planned | Activity (Activity.dc.html): the feed and open questions (the board's events show who asked whom; the messages themselves are next) | #451 |
| `issues` | built | The tasks channel; issues setup is in the Project wizard (ProjectWizard.dc.html) | #452 |
| `next` | planned | Task (Task.dc.html): next in line | #452 |

## Tasks and pull requests

| Command | In the UI | Where | Task |
|---|---|---|---|
| `prs` | built | The pull requests channel, and each pull request's page (PR.dc.html) | #453 |
| `owner merge` | built | PR (PR.dc.html): Merge, pinned to the head, after a confirm with its preconditions | #453 |
| `owner label` | planned | Task (Task.dc.html), PR (PR.dc.html) | #452 |
| `reviews` | agents only | PR (PR.dc.html): checks and reviews | |
| `rereview plan` | agents only | PR (PR.dc.html): reviews | |
| `rereview prompt` | agents only | PR (PR.dc.html): reviews | |
| `rereview record` | agents only | PR (PR.dc.html): reviews | |
| `rereview reply` | agents only | PR (PR.dc.html): reviews | |
| `review-pass reviewer` | agents only | PR (PR.dc.html): reviews | |
| `review-pass arch` | agents only | PR (PR.dc.html): reviews | |
| `claims` | planned | Maintenance (Maintenance.dc.html); Agent: its task | #456 |
| `release` | planned | Maintenance (Maintenance.dc.html): drop an agent's claims, after a confirm | #456 |
| `board tasks` | built | Board (Board.dc.html): a project's tasks read from the message board, live, when its issues are on it | #498 |
| `board ready` | built | Board (Board.dc.html): ready and blocked as the message board works them out | #498 |
| `board show` | built | Task (Task.dc.html): its thread and context entries read from the message board | #498 |
| `board prime` | agents only | An agent's start of task; the web UI's first read has the same shape | #472 |
| `board mcp --as` | agents only | An agent's session reaches the message board through it, and with `--role owner` the owner's own Claude Code session moves, creates, assigns and links cards (#503); the owner sees what they wrote on Task (Task.dc.html) and the board, live | #495 |
| `board mirror` | agents only | The dev manager's loop runs it before each pass (`--max-seconds 300`), and `--watch` runs it beside the loops, so GitHub follows the board; the web UI's own writes are carried by it | #502 |
| `board ask` | agents only | The dev manager's asks to the owner; the owner answers them in the owner-queue channel | #502 |
| `board import github` | planned | First launch (decision 0007 step 2): import the issues when a new factory connects GitHub | #457 |

## Product

| Command | In the UI | Where | Task |
|---|---|---|---|
| `signoff ls` | built | Sign-off and testing (Signoff.dc.html) | #454 |
| `signoff add` | built | Sign-off and testing (Signoff.dc.html): Add something to check | #454 |
| `signoff plan` | agents only | Sign-off item (SignoffItem.dc.html): the product owner writes the plan; you confirm it or ask for a change | |
| `signoff confirm` | built | Sign-off item (SignoffItem.dc.html): Confirm plan | #454 |
| `signoff result` | built | Sign-off item (SignoffItem.dc.html): Passed, Failed | #454 |
| `artifacts pull` | built | Artifacts (Artifacts.dc.html): Pull new copy, Add an artifact (each opens a pull request) | #454 |
| `artifacts status` | built | Artifacts (Artifacts.dc.html): each copy's state, Check for new versions | #454 |
| `artifacts list` | built | Artifacts (Artifacts.dc.html) | #454 |

## CI

| Command | In the UI | Where | Task |
|---|---|---|---|
| `ci status` | built | The CI channel: the verdict first, runs, runners | #455 |
| `ci use local` | built | The CI channel: run CI here, after a confirm | |
| `ci use github` | built | The CI channel: run CI on GitHub, after a confirm | |
| `ci install` | built | The CI channel: install the runners, after a confirm | |
| `ci runners` | built | The CI channel: more or fewer runners, after a confirm | |
| `ci clean` | built | The CI channel: clean up, after a confirm | |
| `ci log` | built | The CI channel: why a run failed | |
| `ci stale` | planned | CI (CI.dc.html): runners older than the checkout; check too | #455 |
| `ci uninstall` | planned | CI (CI.dc.html): remove a runner, with its preconditions | #455 |
| `ci start` | planned | CI (CI.dc.html): start and stop a runner by hand | #455 |
| `ci logs` | planned | CI (CI.dc.html): a runner's log | #455 |
| `turbo status` | planned | Integrations (Integrations.dc.html): the build cache | #441 |
| `turbo install` | planned | Integrations (Integrations.dc.html): turn the build cache on; down too | #441 |

## Health and measure

| Command | In the UI | Where | Task |
|---|---|---|---|
| `reset-run` | built | Maintenance (Maintenance.dc.html): list, then clean after a confirm; Health (Health.dc.html) is #455 | #456 |
| `usage` | built | Usage and cost (Usage.dc.html): tokens per task and per agent against the budget, GitHub calls | #455 |
| `usage --task` | planned | Usage and cost (Usage.dc.html); Task (Task.dc.html): its budget | #455 |
| `report` | planned | Usage and cost (Usage.dc.html) | #455 |
| `lessons` | planned | Maintenance (Maintenance.dc.html); Usage (Usage.dc.html) | #456 |

## Maintain and release

| Command | In the UI | Where | Task |
|---|---|---|---|
| `version` | built | Releases (Releases.dc.html): what runs, what main pins, the newest; Home: the new-version line is #451 | #456 |
| `releases` | planned | Releases (Releases.dc.html) | #456 |
| `update` | built | Releases (Releases.dc.html): update, after a confirm with its preconditions | #456 |
| `rollback` | planned | Releases (Releases.dc.html): roll back, after a confirm | #456 |
| `migrate-to-release` | planned | Releases (Releases.dc.html): a project still on the submodule | #456 |
| `owner release` | terminal only | Publishing a release is the owner's own step; Releases has no publish (RULES.md) | |
| `clean` | built | Maintenance (Maintenance.dc.html): what it will and won't touch, after a confirm | #456 |
| `handover snapshot` | planned | Maintenance (Maintenance.dc.html) | #456 |
| `manager-claims list` | planned | Maintenance (Maintenance.dc.html): who holds what | #456 |
| `manager-claims next` | agents only | PR (PR.dc.html): review claim | |
| `manager-claims review` | agents only | PR (PR.dc.html): review claim | |
| `manager-claims answer` | agents only | Activity (Activity.dc.html): who answers a question | |
| `manager-claims release` | agents only | Maintenance (Maintenance.dc.html) | |
| `manager-claims sweep` | agents only | Maintenance (Maintenance.dc.html) | |
| `manager-claims merge` | agents only | PR (PR.dc.html): review claim | |
| `manager-claims ask` | agents only | Inbox (Inbox.dc.html) | |
| `wait` | agents only | PR (PR.dc.html): the agent waits for the merge | |
| `wait ci` | agents only | PR (PR.dc.html): checks | |
| `wait answer` | agents only | Activity (Activity.dc.html): open questions | |
| `precheck` | agents only | Home (Main.dc.html): what the manager sees | |
| `watch` | agents only | Home (Main.dc.html): what the manager sees | |
| `manage-tick` | agents only | Home (Main.dc.html): what the manager sees | |

## Check

| Command | In the UI | Where | Task |
|---|---|---|---|
| `verify` | agents only | PR (PR.dc.html): checks | |
| `fix` | agents only | PR (PR.dc.html): checks | |
| `run-check` | agents only | PR (PR.dc.html): checks | |
| `check` | agents only | PR (PR.dc.html): checks | |
| `guard` | agents only | PR (PR.dc.html): checks | |

## Settings and integrations

| Command | In the UI | Where | Task |
|---|---|---|---|
| `settings` | built | Settings (Settings.dc.html): browse by section, search, help, change | #456 |
| `settings list` | built | Settings (Settings.dc.html) | #456 |
| `settings help` | built | Settings (Settings.dc.html): each setting's help | #456 |
| `settings show` | built | Settings (Settings.dc.html) | #456 |
| `settings get` | built | Settings (Settings.dc.html) | #456 |
| `settings set` | built | Settings (Settings.dc.html): checked against its type and limits | #456 |
| `settings set --stage` | built | Settings (Settings.dc.html): a project change is staged | #456 |
| `settings diff` | built | Settings (Settings.dc.html): where a value comes from | #456 |
| `settings diff --staged` | built | Settings (Settings.dc.html): the staged changes | #456 |
| `settings validate` | built | Settings (Settings.dc.html): a bad value is refused with its fix | #456 |
| `settings pr` | built | Settings (Settings.dc.html): propose the staged changes as a pull request | #456 |
| `settings --local` | built | Settings (Settings.dc.html): this machine, saved at once | #456 |
| `settings docs` | agents only | Writes the settings page of the wiki from the schema; nothing to show | |
