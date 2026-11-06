# factory-message-board

A task and messaging framework on Postgres: tasks with subtasks and typed dependencies, a ready queue, claims with
tokens, threads, context notes and an events log. Agents and people use it to share work and talk about it.

It is its own framework (decision 0007). It knows nothing about the software factory, and the factory reaches it only
through `src/index.ts`. `tools/check_skills.ts` enforces both:

- a file in this folder imports only Bun and Node built-ins and other files in this folder;
- a file outside it imports only `message-board/src/index.ts`.

It uses Bun's built-in Postgres client (`SQL` from `bun`). It adds no npm package.

## What is here

| Path | What it is |
|---|---|
| `src/index.ts` | The public API: `Board`, `BoardError` and the types |
| `src/board.ts` | The rules, as SQL inside one transaction per write |
| `src/migrations/NNN_name.sql` | The schema, applied in order by `migrate` and recorded in `mb_migrations` |
| `src/server.ts` | The board's own Postgres container, for the command |
| `src/mcp.ts` | The MCP server over stdio, for `factory board mcp` |
| `bin.ts` | The command: `factory board <verb>` (`factory board help`) |
| `tests/` | Tests against a real Postgres |

## The API

```ts
import { Board } from "./src/index.ts";

const board = await Board.open("postgres://factory:...@127.0.0.1:5433/board", { as: "haile", session: "s-1" });
await board.migrate();
const t = await board.create({ title: "Write the importer", priority: 1 });
const claim = await board.claim(); // the first ready task, or null; board.claim(t.id) for a named one
if (claim) await board.close(claim.task.id, { token: claim.token, outcome: "done" });
await board.end();
```

A board writes as one actor (`as`, default `system`). Every method is async. A refusal is a `BoardError` with `code`,
`message` and `fix`.

**Tasks**
- `create({ title, body?, kind?, priority?, parentId?, ref? })`: kind is `task`, `epic`, `bug`, `decision` or `note`.
  A lower priority is claimed first. `ref` is an outside id such as `github:owner/repo#123` (unique).
- `get(id)`, `tasks({ all? })`, `ready({ for? })`, `edges(id)`. `ready()` leaves out tasks handed to someone;
  `ready({ for })` adds the ones handed to that actor.
- `update(id, { version, title?, body?, kind?, priority?, parentId?, ref?, status? })`: `version` is the one you read.
  `status` may be `open`, `in_review` or `deferred`; open and deferred clear the outcome (a reopened task).
- `link(from, to, kind)` and `unlink(from, to, kind)`: kind is `blocks`, `waits_for`, `discovered_from`, `supersedes`,
  `duplicates` or `related`. "from blocks to".
- `claim(id?, { ttlSeconds? })`: returns `{ task, token }`.
- `heartbeat(id, token, { ttlSeconds? })`.
- `release(id, token, { next: "ready" | "deferred" | "handoff", to?, reason })`.
- `close(id, { outcome, token?, reason? })`: outcome is `done`, `wont_do`, `duplicate` or `superseded`.
- `sweep({ quietSeconds? })`.

**Threads:** `post({ task?, kind, to?, body, inReplyTo? })` and `thread({ thread } | { task })`. Kind is `question`,
`answer`, `status`, `note`, `verdict` or `ask`. A reply joins its parent's thread. An answer marks its question
answered. A question or an ask stays open until then.

**Context:** `note(taskId, { kind, body })` and `contextFor(taskId)`. Kind is `discovery`, `decision`, `blocker` or
`result`.

**Views**
- `prime(actor)`: the tasks it holds (each with its context), the ready queue for it, the blocked tasks and the last
  20 events.
- `onMe(actor)`: the tasks it holds or was handed, and the open messages addressed to it.
- `delegated(actor)`: the tasks it created and does not hold, with where each is now, and its open questions and asks.

**Live:** `events(after)` reads the log. `listen(onEvent, { after? })` calls `onEvent` for each new event, in order, once
each.

**Also:** `actor(id, { kind, role })` records an agent or a person, `info()` gives the server version, the migrations
and the counts, `end()` closes the connections.

## The rules

- **Ready and blocked are computed when read** (the `task_blockers` and `ready` views). A task is blocked while a
  `blocks` or `waits_for` edge points to it, or to one of its parents at any depth, from a task that isn't done. Ready
  means a task or a bug that is open, not blocked, and held by nobody. Epics, notes and decisions are never ready
  and never claimed: they aren't work items. Nothing is stored that a write could forget to refresh.
- **A claim is atomic.** One `UPDATE` takes the first ready task with `FOR UPDATE SKIP LOCKED`, so two claimers never
  get the same task; when its pick was taken by a claim that committed meanwhile, it tries again (up to 5 times) while
  something is still ready. A named claim succeeds only when the task is ready, or the caller already holds it. Each
  claim gets a new token.
- **The holder's later writes name the token.** A heartbeat, release or close with a token that no longer holds the
  task is refused with `claim-lost`. A held task can't be closed without its token, and a done task can't be closed
  again: reopen it first.
- **A release says what happens next:** `ready` (anyone may claim it), `deferred`, or `handoff` to a named actor (only
  that actor may claim it), with a reason.
- **The sweep releases a claim only when both have gone quiet:** its time (`claim_until`) has passed, and its holder
  sent no claim or heartbeat for the quiet time (default 30 minutes). Both are checked again inside the same `UPDATE`.
  A swept task goes back to open, except one in review, which stays in review without a holder. The sweep records a
  `task.swept` event as `system`.
- **Edits carry the version they read.** Every write raises a task's version. A mismatch is a `conflict`, and nothing
  changes.
- **No loops.** A `blocks` or `waits_for` edge that would make a task wait on itself is refused (`cycle`). That
  includes loops through parents, since a block on a task also blocks its children. A parent that would make a loop
  is refused too.
- **Every write records an event in the same transaction**, then sends `NOTIFY mb_events, '<seq>'`. Event inserts take
  a lock until commit, so the order of the sequence numbers is the order of the commits, and a reader's cursor never
  skips one. A refused write records nothing.
- **Context reaches linked tasks.** `contextFor(task)` returns the task's own entries and those of every task linked
  to it by an edge, either way. `prime` shows them with each task the actor holds.

## Running it

`factory board up` starts Postgres (`postgres:17-alpine`) in Docker on this machine, on `127.0.0.1` and the Tailscale
address only. It writes the URL to `<machine settings folder>/message-board/url` (mode 600), then migrates.
`MB_URL` overrides the file. `factory board help` lists the other verbs, and the wiki's commands page describes them.

## The MCP server

`factory board mcp --as <actor> [--session <id>]` serves the board to one agent as an MCP server over stdio (#495). It
speaks JSON-RPC 2.0, one message a line, to the handshake revisions of the Model Context Protocol up to
[2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) (`initialize` answers with the version asked for
when it has it, else 2025-11-25). It is written with Bun and Node built-ins only: no SDK, no package. It logs to stderr
only and exits, with the board's connections closed, when stdin closes.

**The actor is fixed when it starts.** Every write is recorded as `--as`, with `--session` on its events. No tool
takes a sender, and an input a tool doesn't list is refused, so an agent can't write as the dev manager (decision 0007
point 8).

**The tools**, each with a JSON Schema for its inputs, checked before anything runs:

| Tool | Inputs | What it does |
|---|---|---|
| `board_prime` | none | What I hold (with context), what is ready, what is blocked, recent events |
| `board_ready` | `limit?` | The tasks I may claim, in claim order |
| `board_claim` | `task?`, `ttlSeconds?` | Claim the first ready task or a named one; returns `{ claim: { task, token } }` or `{ claim: null }` |
| `board_heartbeat` | `task`, `token`, `ttlSeconds?` | Keep a claim |
| `board_release` | `task`, `token`, `next`, `reason`, `to?` | Give a task back: `ready`, `deferred` or `handoff` (with `to`) |
| `board_close` | `task`, `outcome`, `token?`, `reason?` | Close with `done`, `wont_do`, `duplicate` or `superseded` |
| `board_show` | `task` | A task with its edges, context and thread |
| `board_post` | `kind`, `body`, `task?`, `to?`, `inReplyTo?` | A question, answer, status or note |
| `board_thread` | `task` or `thread` | A thread's messages, oldest first |
| `board_note` | `task`, `kind`, `body` | A discovery, decision, blocker or result |
| `board_on_me` | none | The tasks I hold or was handed, and the open messages to me |
| `board_delegated` | none | The tasks I made that I don't hold, and my open questions |

A result is one text block with the JSON, and the same object as `structuredContent`. A refusal is a result with
`isError: true`, the text `<code>: <message> Fix: <fix>` and `structuredContent: { error: { code, message, fix } }`.

**From a Claude Code session.** Add it for one agent:

```sh
claude mcp add message-board -- factory board mcp --as haile
```

or start a session with only this server:

```sh
claude --strict-mcp-config --mcp-config board-mcp.json
```

```json
{
  "mcpServers": {
    "message-board": { "type": "stdio", "command": "factory", "args": ["board", "mcp", "--as", "haile", "--session", "s-1"] }
  }
}
```

The factory's own agent sessions are not wired to it yet: that comes with step 3 of decision 0007, once the factory
reads from the board.

## Tests

`bun tools/run_tests.ts board_rules board_cli board_mcp`. The tests need a real Postgres:

- `MB_TEST_URL` is a server they may create databases on (CI sets it to its `postgres` service).
- Without it, they start a throwaway `postgres:17-alpine` container with Docker and remove it when they finish.
- Without either, they fail and say how to fix it.
