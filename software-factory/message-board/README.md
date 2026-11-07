# factory-message-board

A task and messaging framework on Postgres: tasks with subtasks and typed dependencies, a ready queue, claims with
tokens, threads, context notes and an events log. Agents and people use it to share work and talk about it.

It is its own framework (decision 0007). It knows nothing about the software factory, and the factory reaches it only
through `src/index.ts`. `tools/check_skills.ts` enforces both:

- a file in this folder imports only Bun and Node built-ins and other files in this folder;
- a file outside it imports only `message-board/src/index.ts`.

It uses Bun's built-in Postgres client (`SQL` from `bun`). It adds no npm package.

The factory uses it as its record for tasks, their threads and the owner queue when a project sets `tasks.source` to
`board`, and for claims, wake-ups and the pull request feed with `messaging.transport` `board`. How to set that up and
go live is on the wiki's [message board page](../docs/wiki/board.md). This page is the framework itself.

On this page: [what is here](#what-is-here), [setting it up](#setting-it-up), [logins for other machines](#logins-for-other-machines),
[the API](#the-api), [the rules](#the-rules), [the import from GitHub](#the-import-from-github),
[the mirror to GitHub](#the-mirror-to-github), [the MCP server](#the-mcp-server),
[who can write as whom](#who-can-write-as-whom), [from synchronous code](#from-synchronous-code-the-child), [tests](#tests).

## What is here

| Path | What it is |
|---|---|
| `src/index.ts` | The public API: `Board`, `BoardError` and the types |
| `src/board.ts` | The rules, as SQL inside one transaction per write |
| `src/migrations/NNN_name.sql` | The schema, applied in order by `migrate` and recorded in `mb_migrations` |
| `src/server.ts` | The board's own Postgres container, for the command |
| `src/child.ts` | One request per process, for synchronous callers (the factory's ports) |
| `src/mcp.ts` | The MCP server over stdio, for `factory board mcp` |
| `src/numbers.ts` | How people name a task: `#3` for an issue of the project, `b17` for a task made on the board, read back to a board id (#515) |
| `src/import.ts` | An import, applied in one transaction (`Board.import`) |
| `src/logins.ts` | Logins for other machines: one Postgres role each, with only the board's rights (`Board.addLogin`, `logins`, `removeLogin`) |
| `src/github/import.ts` | The GitHub adapter: a repo's issues and comments as an import, read with the `gh` CLI |
| `src/github/mirror.ts` | The GitHub adapter's mirror: the board's state changes, asks and answers sent to GitHub one way, and the answers there read back |
| `bin.ts` | The command: `factory board <verb>` (`factory board help`) |
| `tests/` | Tests against a real Postgres |

## Setting it up

`bun message-board/bin.ts <verb>` is its command; in a factory project it is `factory board <verb>`, and
`factory board help` lists the verbs (the wiki's commands page describes each).

- **Start it:** `factory board up [--port N]` starts Postgres (`postgres:17-alpine`) in Docker on this machine, published
  on `127.0.0.1` and the Tailscale address only, never `0.0.0.0`. It writes the URL, with its password, to
  `<machine settings folder>/message-board/url` (mode 600), then migrates. `MB_URL` overrides the file. The password
  is never printed. Other machines use the next port (N+1) on the Tailscale address. `factory board down [--purge]`
  stops it (`--purge` also removes its data).
- **The schema:** `factory board migrate` applies the migrations not applied yet, each in one transaction, recorded
  in `mb_migrations`. Safe to run twice. `factory board status` says whether it answers, the last migration, how many
  migrations are pending (with the fix) and the task counts. `factory update` runs `factory board migrate --if-hub`
  (#570): on the machine that runs the board it applies what the release brings; on a machine that joined it changes
  nothing and warns.
- **Backups:** `factory board backup [--out FILE]` runs `pg_dump --no-owner --no-privileges` inside the container and
  writes it mode 600; its default name, `backups/board-<date>-<time>-utc.sql`, is in UTC and says so. A nightly backup
  is a job you set up on the machine (cron or a systemd timer) that runs it.
- **Restore:** `factory board restore <file> --yes` (#515) replaces the board's data with a backup's, inside the running
  container: `psql --single-transaction` drops the `public` schema and loads the dump, so a failure changes nothing.
  Then it migrates. Without `--yes` it refuses (`needs-yes`). The dump has no owner and no grants, so it loads with no
  role errors; machine logins (their roles and grants) aren't in it, so each other machine joins again.
- **Naming tasks:** the CLI's `tasks`, `ready`, `show`, `prime` and `sweep` name a task by its number (#515,
  `src/numbers.ts`): `#3` for issue 3 of the project (ref `github:<owner>/<repo>#3`), `owner/name#3` for another repo's,
  `b17` for a task made on the board. `show` takes `3`, `#3`, `b17` or `owner/name#3`. The project's repo is `--repo`,
  else `GH_REPO` or the git remote `origin` (as the import finds it). `--json` keeps each task's `id` and adds `number`.
  The board's API keeps taking ids; this is a lookup in front of it.
- **Stale claims:** `factory board sweep [--quiet-minutes N]` releases them (see the rules). The dev manager's loop runs
  it on each pass (#513), and a builder's loop sends a heartbeat on its claim while its session runs.
- **Other machines** reach it with a login of their own (next section); `factory machine add` and `factory machine join`
  make one and write it on the new machine.

## Logins for other machines

Another machine reaches the board over Tailscale with a login of its own (#504), so one can be taken away without
touching the others:

- `factory board login add <name> [--valid-for SECONDS] [--json]`, on the machine that runs the board, makes a Postgres role
  `<database>_l_<name>` in the group `<database>_logins`. The group may connect to the board's database and read and
  write its tables (and use their sequences), nothing more: no new tables, no roles, no `mb_logins` or `mb_locks`,
  and `mb_migrations` only to read. Tables a later migration adds are granted too (default privileges, and each `add`
  grants again). It prints the login's URL once: the board's Tailscale address and port from `state.json`, its database,
  and the password, which the board doesn't keep (Postgres keeps only its hash).
- The board notes when a login is first used itself: a login event trigger (Postgres 17) stamps `mb_logins.first_seen`
  and `last_seen` (at most once a minute), and a login connected now (`pg_stat_activity`) counts too.
  `factory board login ls [--json]` shows it.
- `factory board login remove <name> [--unused|--unredeemed]` drops the login's roles and ends their connections; with
  `--unused`, only a login that was never used (`login-used` otherwise); with `--unredeemed`, only one whose join code
  wasn't redeemed (`login-redeemed` otherwise). How, so that nothing a session holds can stop it (#514):
  1. The roles are cut off with statements that wait on nothing a session of theirs can hold, committed on their own:
     `REVOKE CONNECT` on the database, `REVOKE EXECUTE` on the redeem and `REVOKE` of the logins group.
  2. Their sessions are ended. A redeem one of them held open rolls back, and they can't connect again.
  3. Under the login row's lock, every role the login has now (a redeem that committed meanwhile gave it a fresh one) is
     made `NOLOGIN`, what it owns is dropped (`DROP OWNED`, then `REASSIGN OWNED` to the board's user for anything
     left; a role can set its default privileges without CREATE, and `DROP ROLE` alone would refuse it), and it is
     dropped.
  4. Its sessions are ended again, looking every 200 ms until none show (600 ms to 3 s), even when the drop failed.

  Each statement waits at most 2 s for a lock; on a timeout the login's roles are cut off and their sessions ended
  again, and the step runs again, for up to 20 s (`busy` after that).
- **Join codes (#514).** `login add --valid-for <seconds>` makes a join code's role: `LOGIN` with `VALID UNTIL` that
  long from now by the server's clock (Postgres itself refuses its password afterwards), `CONNECTION LIMIT 2`, and only
  `CONNECT` on the board's database and `EXECUTE` on `mb_redeem_login()`. It is not in the logins group.
- `mb_redeem_login()` (`Board.redeemLogin(keep)`) redeems a join code once. Called by the code's role, it makes a fresh
  role for the login (`<code role>_<8 hex>`, no expiry, a new random password of two `gen_random_uuid()`, 64 hex
  characters, in the logins group), points `mb_logins` at it (`role`; the spent one in `code_role`, and `redeemed_at`),
  makes the code's role `NOLOGIN` and returns the fresh role and its password. It refuses a login already redeemed
  (`login-redeemed`), one that expired or is being removed (`login-expired`), and a caller that isn't an unredeemed join
  code's role (`not-found`). It runs in the caller's transaction and `keep` gets the role and password before the
  commit: a `keep` that throws undoes it, so the code still works. After the commit `redeemLogin` ends the code role's
  other sessions (`pg_terminate_backend(pid, 5000)`, looking again every 200 ms for 600 ms to 3 s) and connects as the
  fresh role; if a session doesn't end or that fails, it refuses `login-compromised` (the code may have been copied).
  The function is `SECURITY DEFINER`, owned by the board's user, with `search_path` pinned to `pg_catalog, public,
  pg_temp`; it touches only the row of `session_user`, its role and the fresh one, takes the role's name from
  `mb_logins` (which logins can't write), builds its statements with `format('%I', '%L')`, and changes neither the
  database's nor its own catalog row, so a remove never waits on it. PUBLIC can't execute it; the logins group can (it
  refuses them).
- The spent code role is dropped by the board's own user at the next `login ls`, `login remove` or sweep; a role that
  can't be dropped is a warning on stderr and the others go on. `VALID UNTIL` stops only new sessions:
  `Board.dropExpiredLogins`, run by `factory board sweep`, drops each login whose code expired unredeemed and ends its
  sessions. `factory machine add` makes its login with `--valid-for` (the code's time), `factory machine join` redeems
  it.
- **What a leaked join code can do.** Until it expires (15 minutes by default) or is redeemed, whoever holds it can
  connect to the board's database (two connections at most) and call the redeem; nothing else: no board table, no
  advisory lock (PUBLIC can't take any on this database), no large object, no other database. If they redeem it first, they get the
  machine's login, and the real machine's join is refused (`code-refused`) or reports `code-compromised`. Short of
  that, they can change the code role's own password (`ALTER ROLE ... PASSWORD` is open to any role that can log in), so
  the real machine's join is refused, or hold its two connections, so the join says `code-in-use` (the board's
  `login-in-use`: the code may have been copied). Neither is worse than redeeming it first. Either way
  the owner runs `factory machine remove <name>` on the hub, which takes every role of that login away whatever its
  sessions hold, and makes a new code. A code nobody redeems is refused by Postgres when it expires, and the hub's
  `machine ls`, `machine add` and `factory board sweep` drop it.
- **The board's locks.** Login changes and migrations take a row of `mb_locks` (`logins`, `migrate`) with
  `SELECT ... FOR UPDATE`, waiting at most 10 s (60 s for a migration; `busy` after that). Only the board's own user may
  read or write `mb_locks`, so no login or code can take or hold these locks (advisory locks were used before, and any
  role can take those). Logins may still take the advisory locks the board's writes use; codes may not.
- A login the board refuses (wrong or rotated password, expired, removed: SQLSTATE 28P01 or 28000, or no CONNECT) is
  `login-refused`, whose message and fix say to ask the hub for a new code or `factory machine leave`. A board that
  doesn't answer is still `no-answer`.

Making logins needs the board's own user (a superuser: the one `factory board up` made), because of the roles and the
login trigger; a login can't make logins (`no-rights`).

What else `login add` changes on the server, each time (safe to run twice):

- PUBLIC loses CONNECT and TEMPORARY on the board's database, so only the board's user and the logins reach it, and a
  login can't make temporary tables. PUBLIC also loses CONNECT on `postgres` and `template1`, so a login reaches no
  other database (`template0` takes no connections anyway). The board's server holds only these databases, and its one
  user is a superuser, whom none of this limits. On a server shared with other databases, those are left as they are;
  a non-superuser that needs `postgres` must then be granted CONNECT there by name.
- PUBLIC loses EXECUTE on the functions that make or write large objects (`lo_create`, `lo_creat`, `lo_from_bytea`,
  `lo_import`, `lowrite`, `lo_put`) on the board's database, and nobody gets it back: the board uses none, so no login or
  code can fill the database with them or own one.
- PUBLIC loses EXECUTE on the advisory lock functions (`pg_advisory_*`, `pg_try_advisory_*`) on the board's database;
  the logins group gets it, for the board's writes. So a join code's role can take no lock that would stall the board.
- The password is in the `CREATE ROLE` statement, so that transaction sets `log_statement = 'none'` and
  `log_min_error_statement = 'panic'` first (for itself only): neither a logged statement nor a failed one writes it to
  the server's log. `factory machine add|join|ls|remove` use these verbs.

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
- `get(id)`, `tasks({ all? })`, `ready({ for? })`, `edges(id?)` (no id: every edge). `ready()` leaves out tasks handed to someone;
  `ready({ for })` adds the ones handed to that actor.
- `byRef(ref, { anyRepo? })`: the task whose `ref` is `ref`, in any case, as a list (empty or one); with `anyRepo`, every
  task whose ref is a GitHub issue of that number in any repo. Read-only: how a person's `#3` finds its task (#515).
- `update(id, { version, title?, body?, kind?, priority?, parentId?, ref?, status? })`: `version` is the one you read.
  `status` may be `open`, `in_review` or `deferred`; open and deferred clear the outcome (a reopened task).
- `link(from, to, kind)` and `unlink(from, to, kind)`: kind is `blocks`, `waits_for`, `discovered_from`, `supersedes`,
  `duplicates` or `related`. `blocks`: from must be done before to can start. `waits_for`: from can't start until to
  is done (the same order as "to blocks from").
- `claim(id?, { ttlSeconds? })`: returns `{ task, token }`.
- `heartbeat(id, token, { ttlSeconds? })`.
- `release(id, token, { next: "ready" | "deferred" | "review" | "handoff", to?, reason })`: `review` ends the claim and
  leaves the task in review, held by nobody, so anyone may close it.
- `close(id, { outcome, token?, reason? })`: outcome is `done`, `wont_do`, `duplicate` or `superseded`.
- `move(id, { to, reason?, blockedBy?, outcome? })` (#503): to is `ready`, `in_progress`, `in_review`, `done`,
  `deferred` or `blocked`. It is the board's authorised move, for the owner and the dev manager: it takes no token. A
  held task is taken back from its holder, which needs a reason (see the rules). `blocked` needs `blockedBy` (each
  task gets a `blocks` edge to it, and it stays open, so it shows as blocked) or a reason alone (it is deferred); a
  reason with blocked is kept as a `blocker` context entry. `done` takes an outcome (default `done`). `in_progress`
  is refused unless the task is held: only a claim puts a task there. One transaction, one `task.moved` event.
- `assign(id, to, { reason? })` (#503): hand a task to one actor, so only they may claim it. It keeps its column; a
  held task is taken back first (with a reason) and goes back to open. A done task is refused. Event `task.assigned`.
- `sweep({ quietSeconds? })`.

**Threads:** `post({ task?, kind, tag?, to?, body, inReplyTo? })` and `thread({ thread } | { task })`, and `messages({ after? })`: every message, or those posted after a cursor it gave, with the next cursor. Kind is `question`,
`answer`, `status`, `note`, `verdict` or `ask`. A reply joins its parent's thread. An answer marks its question
answered. A question or an ask stays open until then.

**Context:** `note(taskId, { kind, body })` and `contextFor(taskId)`. Kind is `discovery`, `decision`, `blocker` or
`result`.

**Views**
- `prime(actor)`: the tasks it holds (each with its context), the ready queue for it, the blocked tasks and the last
  20 events.
- `onMe(actor)`: the tasks it holds or was handed, and the open messages addressed to it.
- `delegated(actor)`: the tasks it created and does not hold, with where each is now, and its open questions and asks.

**Live:** `events(after, limit?, { since?, kind? })` reads the log; `lastSeq()` is its last seq. `signal(name, payload)` records an event and nothing else (`signal.<name>`), for a listener such as a waiting agent. `listen(onEvent, { after? })` calls `onEvent` for each new event, in order, once
each.

**Leases:** `lease(key, holder, ttlSeconds)` holds a named claim on anything that isn't a task (one holder until its time runs out; the holder taking it again moves the time on) and says `{ held, holder }`. `unlease(key, holder)`, `leaseHolder(key)` (`""` for nobody) and `dropLease(key)`.

**Values:** `setValue(key, value, signals?)` keeps a JSON value by name, replacing what was there, and records the signals with it in one transaction (a watcher's snapshot and the changes it saw); `value(key)` reads it (null for none); `values(prefix)` lists every value whose key starts with `prefix`, with who wrote
it last and when (the factory keeps each agent's liveness as `<project>:agent:<name>`, #513).

**Import:** `import(batch, { dryRun?, keepBoardStatus? })` brings in tasks, parents, `blocks` edges, context entries and messages, each
keyed by an outside id (`ref`), in one transaction: a second run updates what changed and adds what is new, never a
duplicate. A dry run does the same work and rolls it back, so its counts are a real run's. `lastImport(source)` gives
the last run's time and options. The board's rules hold: a task held on the board keeps its status, an edge or parent
that would make a loop is left out (and listed), an answer marks the question it replies to answered. Messages carry
the `ref` they came with and a `tag`, the user's own word for what a message is (free text, like an actor's role).
With `keepBoardStatus` the board is the record: a task whose status the board changed since the last import from the
same source (a claim, release, close, move, hand-off, sweep, or an update that set it) keeps it too.

**One at a time:** `exclusive(name, fn, { waitMs? })` runs `fn` while holding a Postgres session lock named `name`,
on a connection kept for the whole run (a caller that dies lets it go); `{ ran: false }` when it was still held after
`waitMs` (15 s).

**Messages by id:** `message(id)` reads one; `linkMessage(id, ref)` records where a message was copied to outside (a
GitHub comment's ref), so an import that meets the copy knows it: a reply to it joins the message's thread, and the copy
is never brought in as a second message. Linking twice to the same ref changes nothing; another ref is refused.

**Also:** `boardUrl()` finds this machine's board as the command does (`MB_URL`, else the url file), or null; `actor(id, { kind, role })` records an agent or a person, `info()` gives the server version, the migrations
and the counts, `end()` closes the connections.

## The rules

- **Ready and blocked are computed when read** (the `task_blockers` and `ready` views). A task is blocked while it,
  or one of its parents at any depth, has a blocker that isn't done: the from of a `blocks` edge into it, or the to of
  a `waits_for` edge out of it. Ready
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
- **No loops.** A `blocks` or `waits_for` edge that would make a task wait on itself is refused (`cycle`), whichever
  kinds the loop goes through (a blocks b and a waits_for b is a loop). That
  includes loops through parents, since a block on a task also blocks its children. A parent that would make a loop
  is refused too.
- **Taking a claim back is recorded.** `move` and `assign` on a held task need a reason. They clear the claim, so the
  holder's token stops working (its next heartbeat, release or close is `claim-lost`), and record a
  `task.taken_back` event whose actor is who took it and whose payload names the holder and the reason.
- **The graph lock comes before row locks.** Every write that touches edges or parents (link, update with a parent, a
  move with blockedBy, an import) takes it first. A write that still crosses another one (a Postgres deadlock or
  serialization failure) is undone and refused with `busy`: try again.
- **Every write records an event in the same transaction**, then sends `NOTIFY mb_events, '<seq>'`. Event inserts take
  a lock until commit, so the order of the sequence numbers is the order of the commits, and a reader's cursor never
  skips one. A refused write records nothing.
- **Context reaches linked tasks.** `contextFor(task)` returns the task's own entries and those of every task linked
  to it by an edge, either way. `prime` shows them with each task the actor holds.

## The import from GitHub

`factory board import github [--closed] [--dry-run] [--repo owner/name]` (`src/github/import.ts`) reads a repo's issues
with the `gh` CLI (`gh api`, 100 a page; the repo's comments in bulk, `since` the last run when no new issue came in)
and prints how many calls it made. With `MB_GH_CALLS_FILE` set, it also appends each call's `gh` arguments to that file
(one JSON list a line), so a caller can count them: `factory board import` puts them in the factory's hourly GitHub call log
(#520), as `factory board mirror` does with its own calls. What an issue means is the software factory's convention, given as
`FACTORY_MAPPING` (a caller may pass its own); the adapter imports nothing from the factory and writes the few markers it
reads again, with a comment saying where the factory defines each.

- **Tasks:** open issues (`--closed`: closed ones too, as done, with GitHub's reason as the outcome), each with the ref
  `github:<owner>/<repo>#<n>` (owner and repo in lower case, as GitHub ignores case). Pull requests are left out. Label `epic` makes an epic, `bug` a bug; agent issues and the
  owner queue are notes (never claimed). **Only an issue the factory took as a task** (one of the mapping's labels:
  ready, in progress, in review, blocked, or `agent:<name>`, as in issues mode, where only a labelled issue is claimed)
  comes in as a task or bug; any other open issue (a channel, an untriaged report) comes in as a note, which is never
  ready and which the mirror never labels (#515). A task or bug already on the board is never demoted: it may be held or
  in progress, and the mirror takes the factory's labels off an issue it closes. The body is kept, with its `PRD:` and `Budget:` lines, and a `Milestone:` line
  is added.
- **Status:** ready or no label is open; in review is in review; closed is done. **In progress comes in open, with no
  holder,** and a context entry "was in progress on GitHub, claimed by <agent>": a holder needs a claim token, which only
  `claim` gives, so claims start fresh on the board (the agent claims it again). Blocked comes in open with the reason
  (the `**Blocked:**` comment) as a blocker entry: blocked on the board is computed from edges only.
- **Edges and parents:** `Depends on #n` lines become `blocks` edges (the import's own edges follow the lines on the next
  run; edges made on the board are kept); an epic's `- [ ] #n` lines set the parent.
- **GitHub is the source of truth for status,** unless the task is held on the board: a task done on the board but
  open on GitHub is reopened, and one held on the board keeps its status (the run lists it). Title, body and kind follow
  GitHub too. Comments deleted on GitHub stay on the board; an edited one is updated.
- **Unless the board is the record** (`--board-is-record`, which `factory board import github` passes when the
  project's `tasks.source` is `board`): then a task whose status the board changed since the last import keeps it, and
  an issue already on the board brings no notes from its labels. New issues, edited titles and bodies, edges and new
  comments still come in. With the mirror on, GitHub's labels follow the board anyway, so a later import agrees.
- **What the mirror wrote** (a comment carrying `<!-- factory-mirror ... -->`) is never brought back as a message: the
  board has it. Its markers still count, so a reply to a mirrored ask joins the board's ask.
- **Threads:** each comment is a message keyed by `github:<owner>/<repo>/comments/<id>`. The factory's markers set the kind
  and the tag: `factory-question` and `factory-answer`, owner asks and answers (an answer replies to its ask),
  `factory-po-reply`, `factory-manager-note`, the claim markers (statuses), `factory-approved`, `factory-mustfix` and
  `pr-watch` (verdicts), and the `factory-msg` envelope (its from, to and in-reply-to). A plain comment is a note tagged
  `comment`.

## The mirror to GitHub

`mirrorToGithub(board, { repo })` (`src/github/mirror.ts`, decision 0007 point 5) sends the board to GitHub one way.
The factory runs it as `factory board mirror` (its `board.mirror` setting turns it off).

- **Tasks:** a task whose ref is one of the repo's issues and whose state the board changed (the events `task.claimed`,
  `released`, `closed`, `moved`, `assigned`, `swept`, `taken_back`, and `task.updated` with its status) gets, per
  change, three calls: one read of the issue (its other labels, since a label call replaces them all), one call that sets the issue's labels (the mapping's state label, `agent:<holder>` while in progress; every
  other label is kept) and opens or closes it, and one short line under
  `<!-- factory-mirror v=1 task=<id> state=<s> line=<id of the line> -->`.
  A state that comes back to what was last sent sends nothing; a heartbeat is no change; a task with no issue is left
  alone, and so are epics, notes (the owner queue) and decisions. States: open is ready, in progress, in review, deferred is blocked (the line carries the reason as
  `**Blocked:** ...`), done closes the issue.
- **Asks and answers:** a message of kind `ask` to the mapping's `asksTo` (the owner), and an answer to one, on a task
  with an issue, is posted there once as it is, with `<!-- factory-mirror v=1 message=<id> -->` under it, and linked to
  that comment (`linkMessage`).
- **Answers read back:** under each open ask it mirrored, a `factory-owner-answer id=<ask>` comment, or a plain comment
  after the ask (from `trusted` logins when given), is imported once as the owner's answer, keyed by the comment's id
  (source `github:<owner>/<repo>/owner-answers`).
- **The first pass** for a place (none kept yet) reads the repo's open issues in pages of 100 and sends only to those
  whose labels differ from the board's state; every other task is taken as it is, so turning the mirror on doesn't flood
  the issues.
- **One pass at a time:** a pass holds a Postgres lock named after its place (`Board.exclusive`) for the whole pass, so a
  `--watch` and a run by hand, or two machines, never send twice; a pass that waited 15 s for it sends nothing and says
  so (`busy`). Before posting an ask or an answer it records the message as pending in its place; a pass that finds one
  pending and not linked first looks for a comment carrying that message's marker (one read of the issue's recent
  comments) and links it instead of posting again, so a crash between the post and the link sends nothing twice. A
  task's line is recorded the same way before it is posted (the state it sends and its line id; not on a first pass,
  which keeps no place until it is done), so a pass killed after posting it finds the line by its id and doesn't post it
  again (#513). Every line recorded and not yet saved is kept (the last 10 a task), and a pass looks for the last of
  them that is on the issue: when it is the state being sent, nothing is posted, so a state that comes back to the line
  GitHub shows isn't posted twice (#515).
- **Its place** is the value `mirror:github:<owner>/<repo>`: the last event read and the state sent per task. It reads
  the events after it, so it is safe to run twice and goes on after downtime; it moves its place only when it read
  something new, so its own write never wakes it again. A GitHub failure keeps the place (with the states it did send)
  and is thrown as a `GithubError` whose fix is to run it again: nothing is sent twice.

The factory runs a pass before each of the dev manager's passes, stopped after 300 seconds (`factory board mirror
--max-seconds 300`), then `factory board sweep --max-seconds 60` (#513), and `factory board mirror --watch` runs it all
the time (an agent's liveness and a claim's heartbeat start no pass).

## The MCP server

`factory board mcp --as <actor> [--session <id>] [--role owner|manager|builder]` serves the board to one agent as an MCP server over stdio (#495). It
speaks JSON-RPC 2.0, one message a line, to the handshake revisions of the Model Context Protocol up to
[2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) (`initialize` answers with the version asked for
when it has it, else 2025-11-25). It is written with Bun and Node built-ins only: no SDK, no package. It logs to stderr
only and exits, with the board's connections closed, when stdin closes.

**The actor is fixed when it starts.** Every write is recorded as `--as`, with `--session` on its events. No tool
takes a sender, and an input a tool doesn't list is refused, so an agent can't write as the dev manager (decision 0007
point 8).

**Tasks are named as people see them** (#515): a `task`, `parent`, `blockedBy` or link end takes `3` or `"#3"` (issue 3
of the project), `"b17"` (a task made on the board) or `"owner/name#3"`, and every result names tasks the same way: a
task's `id`, `parentId` and `blockedBy`, a message's or a context entry's `taskId`, an edge's ends, an event's subject.
Message ids stay numbers. The project's repo is `--repo owner/name`, else `GH_REPO` or the git remote `origin`; with
none, `3` is the task of any repo's issue 3 (refused when two repos have one). A board error names its tasks the same way:
the board writes each task it names as a token (`BoardError.template`, `taskOf`), rendered `#<id>` in `message` and
renamed by the server; any other `#n` in an error is left as written.

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

### Owner and manager tools

Started with `--role owner` or `--role manager` (#503), the server also offers the tools a person, or the person's own
Claude Code session, uses to run the board without the web UI. The default role is `builder`: a builder's server
neither lists these tools nor runs them (a call to one is an unknown tool, `-32602`). The actor stays fixed by `--as`.

| Tool | Inputs | What it does |
|---|---|---|
| `board_move` | `task`, `to`, `reason?`, `blockedBy?`, `outcome?` | A task to `ready`, `in_review`, `deferred`, `done` (outcome, default `done`) or `blocked` (by `blockedBy`, a list of task ids each given a `blocks` edge, or by a reason alone, which defers it). A held task is taken back from its holder: give the reason. `in_progress` comes only from a claim |
| `board_create` | `title`, `kind`, `body?`, `parent?`, `priority?` | A `task`, `bug`, `epic` or `note`, under a parent |
| `board_assign` | `task`, `to`, `reason?` | Hand a task to one actor: only they may claim it. A held task is taken back first (with the reason) |
| `board_link` | `from`, `to`, `kind` | "from blocks to" and the other edge kinds; a loop is refused with `cycle`; `{ linked }` |
| `board_unlink` | `from`, `to`, `kind` | Remove a link; `{ unlinked }` |
| `board_comment` | `task`, `body` | A note on the task's thread, as you |
| `board_signoff_add` | `id`, `task`, `check` | Put what only a person can check for a task on the project's sign-off and testing queue (the factory's `factory signoff`, #552); `conflict` when the id is taken |

Each move is a board event (`task.moved`, and `task.taken_back` for a held task), so the board's listeners, the web UI
among them, see it at once. The same input checks hold as for the other tools: no field a tool doesn't list, and the
same sizes.

**In your own Claude Code session**, from the project's folder:

```sh
claude mcp add board -- ./factory board mcp --as owner --role owner
```

or with the path to this folder, which needs no factory script:

```sh
claude mcp add board -- bun <path>/message-board/bin.ts mcp --as owner --role owner
```

Put your own name after `--as`: it is who the board says moved each card. The dev manager's session uses
`--role manager`. `factory board mcp --help` prints the same lines, with this folder's path filled in.

**An agent's session.** Add it for one agent:

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

The factory's own sessions get it by themselves when the board is on (`tasks.source` or `messaging.transport` is
`board`, or no transport is set on a machine with a board; #501): `factory loop`, `factory agent` and the dev manager's
and product owner's sessions start with only this server, named `board`, as their agent (`--role builder` for a coding
agent, `manager` for the others), with a session id of their own, and the project's `.mcp.json` servers are not
started. The agents' rules then allow each role only the tools it uses: a coding agent the builder's, the dev manager
all of them, the product owner all but `board_claim`, `board_heartbeat`, `board_release` and `board_close` (it never
builds). See the wiki's [agent loops page](../docs/wiki/agent-loops.md#when-the-board-is-on).

## Who can write as whom

The board knows its connections, not its people. Whoever has its URL (the url file, mode 600, or `MB_URL`) connects as
the board's user or a machine's login, and the actor of each write is a name the caller gives: `Board.open({ as })`,
`factory board mcp --as`, the CLI's own actors. So **any local process that can run the board's CLI, as the user who
owns the url file, can write as the actor `owner`** (`factory board mcp --as owner --role owner`, or `factory owner
answer`). More readers trust `owner` now: the owner queue's answers (`factory prd --stage` takes the owner's approvals
from them), the web UI's Inbox, and the mirror, which posts them to GitHub. What keeps an agent from doing that is the
agents' rules (`.claude/factory/settings.json`, which the factory passes to the sessions it starts) and the MCP server
each session gets, fixed to its own name and role; not the board. Keep the hub and the joined machines to people and
agents you trust, and remove a machine's login (`factory machine remove`) when it should no longer write.

## From synchronous code: the child

`src/child.ts` reads one JSON request on stdin (`{ url, as, session?, calls: [{ op, args }] }`), makes the calls as that actor, prints `{ ok, results }` or `{ ok: false, code, message, fix }` on one line and exits. Run it with `Bun.spawnSync`. Besides the methods above it has `find`, the events of a kind since a time whose payload matches, and `wait`, the first such event, waiting up to a number of seconds (`or` lists other kinds and matches that also end it).

The factory's ports (`TaskTracker`, `Messaging`, `Leases`, `Wakes`) are synchronous, so its board adapters
(`hooks/core/adapters/board/child.ts`) call the board this way: one short-lived process a call.

## Tests

`bun tools/run_tests.ts board_rules board_cli board_child board_logins board_mcp board_import board_restore`. The import's tests put a fake `gh` on PATH that serves JSON
fixtures. The restore's test puts a `docker` on PATH that runs each `pg_dump` and `psql` from `postgres:17-alpine` against the test database. The tests need a real Postgres:

- `MB_TEST_URL` is a server they may create databases on (CI sets it to its `postgres` service).
- Without it, they start a throwaway `postgres:17-alpine` container with Docker and remove it when they finish.
- Without either, they fail and say how to fix it.
