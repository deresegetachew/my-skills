# 0001: the cockpit, one terminal window built on tmux

Status: decided by the owner on 28 Oct 2026 (#295). Replaces PRD D1, "No custom UI".

## Context

The owner ran the factory through the Claude app, a Remote Control `-i` session and plain text commands (the old D1).
The owner does not want to depend on Claude Code or VS Code forever, and wants a way that works over plain ssh to a
dev machine.

## Decision

The owner runs the factory from one terminal window, the cockpit (`factory cockpit`), built on tmux.

- Left: the sessions (dev managers, product owners, coding agents, other machines) with their state and a "needs you"
  badge, and the views under them.
- Right: the selected agent's real Claude Code session, swapped in by tmux, so the owner types into it. Or a view.
- Top: the counts and "N need you". Bottom: the keys that work now.
- `:` opens a fuzzy command bar over the factory commands; `/` inside a session stays Claude's; `C-a` returns to the
  cockpit.

tmux is the widget toolkit, so the no-new-dependencies rule holds: `display-popup` for views (factory commands through
`less -R`), `display-menu` and `command-prompt` for the command bar, the status line for counts, `choose-tree` for
picking a session, `bind-key` for keys. The factory writes one small sidebar list. The cockpit needs tmux 3.2 or newer;
nothing else in the factory does.

The core comes first (PRD US-1 to US-9), then the cockpit in four steps (US-10 to US-13).

## Set aside, and why

- Claude Code's agent view and mods: closed source; a mod can't draw in the agent view.
- VS Code's Agents window: its session and agents-window APIs are unfinished and allowlisted to GitHub and OpenAI, and
  its Claude agent bills the Copilot subscription.
- A VS Code extension on stable APIs: a possible second screen later, on the same core (PRD section 6C).
- A web console: it needs a browser terminal library, a new dependency.

## Consequences

- The PRD's D1, O1, "Out of scope" and section 4.10 change in the same pull request.
- The plain text commands stay; the cockpit runs them.
- Section 6A of the PRD (a chat-tool bridge) stays later.
