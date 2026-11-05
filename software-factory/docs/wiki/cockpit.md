# The cockpit

One terminal window to watch the factory, answer it and talk to its roles: `factory cockpit`.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [Open it](#open-it)
- [Every agent](#every-agent)
- [Talking to the dev manager and the product owner](#talking-to-the-dev-manager-and-the-product-owner)
- [Answering an owner ask](#answering-an-owner-ask)

## Open it

`factory cockpit` opens the cockpit in tmux (3.2 or newer), on its own tmux server with its own prefix, `C-a`. On the
left is the list: SESSIONS, then the other projects on this machine, then the VIEWS. On the right is the session you
picked. `C-a d` leaves, and everything keeps running. Every key and view is in the
[commands table](commands.md#the-factory-command) under `factory cockpit`.

| Key in the list | What it does |
|---|---|
| `↑` `↓` (or `j` `k`) | Move. |
| Enter | On a coding agent: show its Claude Code session on the right. On the dev manager or the product owner: open the talk with it. On a view: open it. |
| `1`–`8` | The views: Needs you, Pull requests, Tasks & PRD, CI, Agents & machines, Settings, Health & releases, Usage & lessons. |
| `9`, `0` | Talk to the dev manager, talk to the product owner. |
| `/` | Search across the views. |
| `:` | The command bar. |
| `s`, `x`, `n` | Say something to a session, stop it, start one (each asks first). |

## Every agent

The list and the Agents & machines view (`5`) come from the heartbeat and the claims, not only from tmux. So a loop
started with `nohup`, or in a plain terminal, shows too.

- **This machine** comes first. Each session has its state (`working`, `waiting`, `idle`, `down`), its task, and
  `nohup` when it runs outside tmux. A session that is down shows only when this machine's names file expects it here.
- **How it runs** (`runs` in `factory agents ls --json`) is `tmux` (its tmux session), `nohup` (a live loop with no
  tmux session), or `cloud`. For a `nohup` loop, the Agents view shows the file its output goes to (`log <path>`) when
  the system can tell (Linux).
- **What it waits on** includes GitHub's hourly limit: a loop in its limit wait shows `waiting for the GitHub limit until
  HH:MM UTC`.
- **Other machines** show when they are alive, marked `on <machine>`. Their rows come from their agent issues on GitHub.
- **Other projects on this machine** are listed under OTHER PROJECTS, each with its agents, read from that project's
  heartbeat file (`~/.local/state/<project>-factory/heartbeat.json`). A project whose heartbeat stopped says `not
  reporting`. You can see them here but not pick them: run `factory cockpit` in that project to act on them.

A loop outside tmux can still be stopped: `factory owner stop <name>` (or `x` in the list) ends a `nohup` loop by the pid
in its checkout claim, along with what runs below it. To restart it, stop it, then `factory owner start <role> <name>`,
which starts it in tmux. To read its log, open the file the Agents view names.

## Talking to the dev manager and the product owner

The dev manager is a program that starts a short Claude session for each item, so it has no session you can type into.
The cockpit gives you a conversation with it instead. The product owner works the same way.

Open it with `9` (the dev manager) or `0` (the product owner), or with Enter on that role in the list. You can also run
`factory cockpit --chat dev-manager` or `factory cockpit --chat product-owner` in a terminal.

1. Type a line and press Enter. For example: "What is waiting on me?", "Why is #12 held?" or "Merge #14 when CI is
   green."
2. The role answers in a fresh session. That session reads its rules (the `manage-pass` or `product-pass` skill), its
   context (the open pull requests, the owner queue, its notes) and the conversation so far. It does what you ask when
   its rules allow it, and says so when they don't. A fresh session takes a minute or so to answer, and the pane says
   `<name> is answering…` meanwhile.
3. The answer shows in the pane. A summary of the turn (your line and the answer) is posted on the owner queue issue
   ("Dev manager: needs the owner"). It is marked `<!-- factory-cockpit-chat role=<role> -->`, so the next pass sees it
   as context. It never counts as your answer to an owner ask.

Esc closes the pane. If there is no owner queue yet, the answer still shows and the pane says no summary was posted. A
session that fails posts nothing, and the pane shows the error and what to do (`chat_failed`).

Each line is one `factory cockpit --chat-send <role> <text> [<history-json>]`. The session gets the role's settings,
model and permissions, as the dev manager's sub-managers do, and runs for at most `FACTORY_CHAT_MINUTES` minutes
(default 15, from 1 to 19: the pane waits 20 minutes for an answer). Only the last 10 turns of the conversation go
with each line. Only the owner can do this: in an agent session it stops with `cockpit_agent_session`.

## Answering an owner ask

Needs you (`1`) lists the owner-queue asks waiting for you. Enter on an ask shows it whole, with its options: the lines
of the ask that are a list (`- `, `* `, `1. `, `1) `, `A) `), and **Type your own answer** at the end.

- `j` `k` pick an option, and Enter asks: ``Answer <id> with “<option>”? It posts `factory owner answer <id> <answer>`
  on the owner queue. [y/N]``.
- Only `y` posts it, through `factory owner answer`, and the pane shows what that printed. Any other key posts nothing
  and says `Not run: nothing changed.`
- **Type your own answer**: type it, press Enter, then `y`.
- Esc goes back to the list, which reads the snapshot again if you answered.

The ask's text comes from `factory prs --json` (`text` on each owner ask). An older cache without it still opens, with
only the line to type an answer.

<br>

Previous: [Roles](roles.md) | Next: [Reviews and gates](reviews-and-gates.md)
