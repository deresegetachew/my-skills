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
| `src/import.ts` | An import, applied in one transaction (`Board.import`) |
| `src/github/import.ts` | The GitHub adapter: a repo's issues and comments as an import, read with the `gh` CLI |
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

**Threads:** `post({ task?, kind, tag?, to?, body, inReplyTo? })` and `thread({ thread } | { task })`. Kind is `question`,
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

**Import:** `import(batch, { dryRun? })` brings in tasks, parents, `blocks` edges, context entries and messages, each
keyed by an outside id (`ref`), in one transaction: a second run updates what changed and adds what is new, never a
duplicate. A dry run does the same work and rolls it back, so its counts are a real run's. `lastImport(source)` gives
the last run's time and options. The board's rules hold: a task held on the board keeps its status, an edge or parent
that would make a loop is left out (and listed), an answer marks the question it replies to answered. Messages carry
the `ref` they came with and a `tag`, the user's own word for what a message is (free text, like an actor's role).

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

## The import from GitHub

`factory board import github [--closed] [--dry-run] [--repo owner/name]` (`src/github/import.ts`) reads a repo's issues
with the `gh` CLI (`gh api`, 100 a page; the repo's comments in bulk, `since` the last run when no new issue came in)
and prints how many calls it made. What an issue means is the software factory's convention, given as
`FACTORY_MAPPING` (a caller may pass its own); the adapter imports nothing from the factory and writes the few markers it
reads again, with a comment saying where the factory defines each.

- **Tasks:** open issues (`--closed`: closed ones too, as done, with GitHub's reason as the outcome), each with the ref
  `github:<owner>/<repo>#<n>`. Pull requests are left out. Label `epic` makes an epic, `bug` a bug; agent issues and the
  owner queue are notes (never claimed). The body is kept, with its `PRD:` and `Budget:` lines, and a `Milestone:` line
  is added.
- **Status:** ready or no label is open; in review is in review; closed is done. **In progress comes in open, with no
  holder,** and a context entry "was in progress on GitHub, claimed by <agent>": a holder needs a claim token, which only
  `claim` gives, so claims start fresh on the board (the agent claims it again). Blocked comes in open with the reason
  (the `**Blocked:**` comment) as a blocker entry: blocked on the board is computed from edges only.
- **Edges and parents:** `Depends on #n` lines become `blocks` edges (the import's own edges follow the lines on the next
  run; edges made on the board are kept); an epic's `- [ ] #n` lines set the parent.
- **Threads:** each comment is a message keyed by `github:<owner>/<repo>/comments/<id>`. The factory's markers set the kind
  and the tag: `factory-question` and `factory-answer`, owner asks and answers (an answer replies to its ask),
  `factory-po-reply`, `factory-manager-note`, the claim markers (statuses), `factory-approved`, `factory-mustfix` and
  `pr-watch` (verdicts), and the `factory-msg` envelope (its from, to and in-reply-to). A plain comment is a note tagged
  `comment`.

## Running it

`factory board up` starts Postgres (`postgres:17-alpine`) in Docker on this machine, on `127.0.0.1` and the Tailscale
address only. It writes the URL to `<machine settings folder>/message-board/url` (mode 600), then migrates.
`MB_URL` overrides the file. `factory board help` lists the other verbs, and the wiki's commands page describes them.

## Tests

`bun tools/run_tests.ts board_rules board_cli board_import`. The import's tests put a fake `gh` on PATH that serves JSON
fixtures. The tests need a real Postgres:

- `MB_TEST_URL` is a server they may create databases on (CI sets it to its `postgres` service).
- Without it, they start a throwaway `postgres:17-alpine` container with Docker and remove it when they finish.
- Without either, they fail and say how to fix it.
