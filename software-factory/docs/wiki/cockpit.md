# The cockpit

One terminal window to watch the factory, answer what waits on you and talk to the dev manager and the product owner.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [The cockpit](#the-cockpit)
- [Every agent](#every-agent)
- [Answering an owner ask](#answering-an-owner-ask)
- [Talking to the dev manager and the product owner](#talking-to-the-dev-manager-and-the-product-owner)

<br>

## The cockpit

`factory cockpit` opens it: the list on the left, the selected session on the right, the counts on top. It runs on its
own tmux server, with `C-a` as its prefix. Every key and flag is in the `factory cockpit` row of
[the commands table](commands.md#the-factory-command); this page says how to use it.

The list has three parts:

- **SESSIONS**: this project's agents, with what each one does. Enter shows the session on the right.
- **VIEWS**: Needs you, Pull requests, Tasks & PRD, CI, Agents & machines, Settings, Health & releases, Usage & lessons.
  `1` to `8`, or Enter, opens one as a popup; `q` closes it.
- **TALK TO**: the dev manager and the product owner. Enter opens a chat with that role.

`/` searches across the views, `:` opens the command bar, `r` reads the list again and `q` leaves (the agents keep
running).

<br>

## Every agent

Each row says the agent's name, its state (`working`, `waiting`, `idle`, `down`, or `unknown` when its machine stopped
reporting) and its task. The rows come from the agents' heartbeats and claims, not from tmux (#395), so the list also
shows:

- **A loop outside tmux.** A loop started with `nohup` (or in a plain terminal) says `nohup` on its row. It is alive
  when its claim's process is.
- **Another machine's agents**, marked `on <machine>`, and the cloud's, marked `on cloud`.
- **A down agent** that this machine is expected to run (its names file, `factory machine setup`).
- **Other projects on this machine.** Under OTHER PROJECTS, each project whose heartbeat daemon runs here, with its
  agents and their states. A project whose daemon stopped writing shows its agents as `unknown`. These rows are for
  reading: to work with that project, open its own cockpit (`factory cockpit` in its folder).

The states come from the heartbeat daemon (`factory heartbeat install`); without it this machine's rows are worked out
when the list reads them.

<br>

## Answering an owner ask

The dev manager writes what only you can decide as an ask on the owner queue issue ("Dev manager: needs the owner").
In **Needs you** (`1`), Enter on an ask shows all of it, with its options numbered: the ask's list items, or `yes` and
`no` when it has none. Press the number of your answer. The cockpit asks
``Run `factory owner answer <id> <option>`? It changes the owner queue. [y/N]``; `y` posts it and shows what the
command printed, and any other key posts nothing. Esc goes back to the list, which no longer has the ask.

For an answer that is not one of the options, use the command bar: `owner answer <id> <your answer>`.

<br>

## Talking to the dev manager and the product owner

The dev manager and the product owner are not sessions you can type into: the dev manager starts a short Claude
session for each item. To talk to one, pick it under TALK TO and press Enter. A chat pane opens.

Type a message and press Enter. A fresh session starts as that role, on its settings profile and with its rules. It
reads what it needs (the open pull requests, the owner queue, its notes), does what you ask when its rules allow it,
and answers in a few lines. While it works the pane says it is thinking; an answer can take a few minutes. Esc closes
the pane.

- **It remembers the conversation.** The last turns go into the next message's prompt, and the pane shows them when you
  open it again. They are kept per role in `chat-<role>.json` in this machine's state folder.
- **The owner queue gets a summary.** Each answer ends with a one-line summary, posted on the owner queue issue under
  `<!-- factory-owner-chat role=<role> -->`, so what you agreed is on record next to the asks. With no open owner queue
  issue nothing is posted, and the pane says so.
- **Its rules still hold.** The role cannot merge a protected pull request or publish a release because you asked in a
  chat; it says so, and what you can do instead.

The same works from a shell: `factory owner chat dev-manager "how is #12 going?"` prints the answer as JSON. Only the
owner can run it.

<br>

Previous: [Roles](roles.md) | Next: [Reviews and gates](reviews-and-gates.md)
