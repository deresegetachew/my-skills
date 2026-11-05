# 0005: The factory's UI is a web page, `factory ui`

Date: 5 Nov 2026. Status: **accepted** (the owner, 5 Nov: "the tmux UI was a mistake, we should have built it as a web
UI. I like the layout and the concept in tmux. We could have a project namespace where all the agents and the views
live, like a Slack channel."). Epic #420, tasks #421 to #425.
**Supersedes decision 0002's choice of UI** (the cockpit's sidebar and views drawn with Ink in tmux) and amends
decision 0001 (the cockpit on tmux). 0002's bundling rule stands and is widened here: react-dom joins Ink and React as a
build-time dependency, bundled at release.

## Context

The cockpit (0001, 0002) puts the factory in one tmux window: sessions and views on the left, an agent's real Claude
Code session on the right, views as popups. The owner likes its layout and its idea (one place for every agent and
every view) but not the medium: a terminal can't be opened from a phone or another machine without ssh and tmux, its
views are popups over popups, and each new view meant terminal layout code and its own tests through a fake tmux.

A browser does layout, scrolling, search, dialogs, links and light and dark for free, on every device the owner has.
Inspiration, for ideas only (no code is taken from either): rerun (one board of every agent and machine, chat with any
agent, approvals inline; AGPL-3.0) and squad.

## Decision

1. **`factory ui [--port N] [--host]`** starts a Bun server (`Bun.serve`, built-ins only) on the machine that runs it:
   one page, its script, and a JSON API. The page is laid out like Slack: projects on the far left (this one and those
   in the `ui.projects` setting), the selected project's channels (one per agent, one per view: tasks, pull requests,
   CI, owner queue, machines), a search across every channel, and the channel on the right.
2. **Bound to localhost; `--host` adds the Tailscale address**, nothing else. A token, made once and kept in
   `.git/factory/ui-token` (mode 600), is printed with the address and required on every API call and the WebSocket.
   Starting it is the owner's: an agent session is refused.
3. **The server reads through what exists**: `factory agents ls --json`, the cockpit's cache and the limit file today,
   the messaging port when NATS lands (0004). It pushes changes over a WebSocket from one poll loop, which runs only
   while a page is open. Actions run the same commands the command line runs (`factory owner start|stop`), after a
   confirm on the page.
4. **React and react-dom are build-time dependencies** (`software-factory/package.json` devDependencies, pinned:
   `react-dom` 19.3.1 and `@types/react-dom` 19.3.0 beside 0002's). The release bundles `software-factory/web/` for the
   browser into one file, `hooks/factory_ui_app.js` (`tools/build_web.ts`); a project installs nothing and gets no
   `node_modules`. A my-skills checkout builds it from the source when the server starts.
5. **Only `software-factory/web/` may import react-dom**, and it may import React and react-dom only (never Ink).
   `check_skills.ts` refuses anything else, as it does for the cockpit (0002 point 4).
6. **The cockpit stays** until the web UI covers what it does (chat and the owner's approvals, #423; the tasks, pull
   requests and CI views, #424); then it is retired (#425). No new cockpit view is built meanwhile.

## Consequences

- The API is tested against a real server on a free port (status codes, JSON, token refusals, the WebSocket getting an
  update after a change), with a fake `gh` and a fake `factory`. The page keeps its logic in `web/model.ts`, tested on
  its own; the rest only draws what the API returns.
- A view is a channel: chat and approvals (#423) and the remaining views (#424) are added as channels, without changing
  the shell.
- The server is reachable only from this machine and the tailnet, and only with the token. It is not meant to be put
  behind a public address.
