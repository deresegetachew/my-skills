# 0007: The factory's own record: a task and messaging framework on Postgres, with GitHub for code

Date: 6 Nov 2026. Status: **accepted** (the owner, 6 Nov: "yesss pls", in the owner's session, after reading a summary of this record).
The direction was approved on #472 the same day: "Yes, this is important, go for it, and scalable. It should be part of
the initial setup: when we start a new factory and connect GitHub we should be able to import issues or tasks." Epic
#472. Product half: mentewab (product owner). Technical half: the owner's session (point 10), from fasil's answers.
Decision number 0006 is kept for the web UI amendment proposed on #293 (ask `web-ui-design-449-scope`).

**Builds on 0003** (ports and adapters) and **supersedes 0004** (NATS first became an optional adapter for live
delivery; it was removed on 6 Nov 2026, #504) and amends PRD D10 ("GitHub is the record").

## Context

All roles share the owner's GitHub account (D9), and the owner does not want a separate one. Its 5,000 calls an hour run
out every hour. The owner's measurement on dev-pc (#472, the 06:00 UTC hour, 5,301 calls): the web UI about 2,900 (it
re-reads every issue's comments every 5 seconds), fasil about 2,100 (sub-managers about 1,300, the cycle about 750),
everyone else about 300, plus the Mac. #461 to #463 and #473 cut some of it. The rest is the factory reading GitHub as a
database: who holds what, which questions wait, what a thread said.

Decision 0004 moved wake-ups and claims to NATS, and its amendment (6 Nov) kept everything a person reads later on
GitHub. So the conversations, the owner queue and the task state are still read from GitHub comments and labels.

The owner's direction on #472 (6 Nov, after comparing with Skein on #469): "this thing we are building can be reused as
an agent communication framework, so we need to build it as such: not tied to our factory, and independent. They can
reference things from that repo [Skein] when building features and take inspiration, but we build our own."

## Decision

### 1. A framework of its own; the factory is one user of it

The task and messaging layer is built as a framework that knows nothing about the factory.

- **It holds:** agents and people; tasks with subtasks to any depth, epics, and typed dependencies; claims and a ready
  queue; threads, questions and answers, and verdicts; an events log.
- **It does not hold:** "coding agent", "dev manager", "product owner", the PR gate, labels, `factory:*` states as
  names. Those stay in the factory, which maps its roles and states onto the framework's generic ones.
- **The factory reaches it only through its public API**, behind 0003's ports (`TaskTracker`, `Messaging`, `Leases`,
  `Wakes`, `PrFeed`). The framework imports nothing from `software-factory/`.
- **It has its own tests, docs, settings and run commands** (`up`, `down`, `status`, `backup`). The house rules apply:
  Bun only, no new npm package (Bun's built-in Postgres client), tests never weakened.
- **GitHub is an adapter, not the core:** the importer and the mirror (points 4 and 5) plug into it.

**Decided by the owner (6 Nov, on #481):** it lives in a folder under the factory, `software-factory/message-board/`,
and is called **factory-message-board**. The table below was the choice put to the owner. A folder under
`software-factory/` is not a top-level skill, so it needs no `SKILL.md`; `check_skills.ts` enforces the import rule.

The options were:

| | (a) A folder in my-skills | (b) Its own repo |
|---|---|---|
| Layout | A new top-level folder, which `check_skills.ts` requires to be a skill with a `SKILL.md` (the skill teaches an agent to use it). Shipped in the factory's release archive. | A repo of its own; my-skills pins a release of it and bundles it, as a plugin is bundled (0004 point 5). |
| Independence | Enforced by a rule in `check_skills.ts`: nothing in the folder imports from `software-factory/`, and the factory imports only its public entry. | Enforced by the repo boundary. |
| Building it with the factory | One repo, one task list, one PR gate, as today (D5). | The factory has to run across two repos: two task lists, two CIs, and a change that touches both is two PRs in order. |
| A second user | Copies the folder or waits for (b). | Takes the repo. |

**I recommend (a) now, with the import rule, because** the factory builds itself in one repo today, and nothing outside
this repo uses the framework yet. A folder that imports nothing from the factory can be split into its own repo later
with its history (`git subtree split`). Moving to (b) is then a change of address, decided when a second user exists.

The board and the epics page say "Agent messaging" (vendor-neutral, owner, 6 Nov); the framework itself is
factory-message-board.

### 2. What moves and what stays

| | Where |
|---|---|
| Tasks, epics, subtasks, state (ready, in progress, in review, blocked, done), who holds what, dependencies, the order `factory next` gives | **Postgres** |
| Every conversation about a task: questions, answers, hand-offs, the PO's proposals, the owner queue, the dev manager's notes | **Postgres** |
| A pull request's back-and-forth: builder questions, must-fix lists, rework notes, next steps | **Postgres** |
| Wake-ups, claims and live change events | **Postgres** (point 3); NATS removed (#504) |
| Code, branches, the pull request itself, CI, the dev manager's final verdict and the review labels the Factory guard and the PR gate read | **GitHub** |

The PR gate still trusts only GitHub. Nothing written in the database changes what may merge, as with NATS (0004 point 2).

### 3. Postgres for the record and for live delivery; NATS removed

fasil compared the two on #472 (comment 6683448149). In both options every agent already holds a Postgres connection,
because the record is there, so using it for live delivery adds no connection or service.

- **Live delivery** uses `LISTEN/NOTIFY` for wake-ups. A reader that reconnects re-reads the table from its cursor:
  the rows are the replay.
- **Claims** are one transaction: insert, or take over only when the old claim has expired, with the claims history
  written in the same transaction (a real compare-and-set, which closes 0004's gap where any agent could overwrite a
  claim).
- **NATS was removed (the owner, 6 Nov 2026; #504),** before the board went live, so the factory never runs half on one
  and half on the other. The board carries wake-ups, claims and the pull request feed (#500); `messaging.transport`
  takes `github` or `board`, and machines join the hub with board logins (`factory machine add|join`). What follows was
  the first answer, kept as history: NATS stayed as an optional adapter behind the same ports for a while. The owner asked
  (6 Nov) whether NATS is needed once Postgres is in. The answer: not at our size. NATS can store messages and do
  compare-and-set claims, but it can't answer the questions the record is for (the ready list, what blocks what, "on me"
  and "delegated") without our own code keeping copies in shape for each. Skein, the closest product, keeps Postgres as
  the truth and uses NATS only to fan events out to its services; codeaf and plandb use no bus at all. **Recommendation:**
  once every kind has moved (point 9), remove the NATS plugin and the hub's NATS service, unless a need appears by then
  (many machines, or listeners that can't reach the database). That removal is the owner's call.
- **Hosted Postgres** (RDS, Neon, Supabase) later is a change of address. Listeners use the direct address, because
  poolers in transaction mode don't carry `LISTEN`.

### 4. Import from GitHub at setup, safe to run twice

- **Where:** in the first-launch screens (#457) when a new factory connects GitHub, and from the command line.
- **What it brings:** open issues as tasks (by default; closed ones on request), with their comments as the task's
  thread, their `factory:*` labels as state, `Depends on` lines as dependency edges, the `PRD: US-<n>` and `Budget:`
  lines, and the milestone.
- **Safe to run twice:** each task keeps its GitHub issue number. A second run updates what changed and never makes a
  duplicate. A dry run says first what it will bring and what it skips, with counts.
- **Factory markers** (claims, `pr-watch`, manager notes) are read into their own kinds, not as plain comments.

### 5. A low-frequency mirror to GitHub, so the owner can still follow there

- One way: the database to GitHub. A task's issue is updated only when its state changes (its labels, and one short
  line saying the new state).
- On by default; a setting turns it off.
- **The owner queue is mirrored as it is created**: each new owner ask also appears on the owner-queue issue (#293),
  so GitHub's notifications still reach the owner's phone (PRD M6). An answer given on GitHub under an ask is read back
  (the owner's only write path from the phone). The owner's answers from the web UI or `factory owner answer` go to the
  database first.
- An edit someone makes on GitHub to a mirrored issue is not read back, except by running the import again.

### 6. What the owner sees

- The web UI reads tasks, threads and the owner queue from the database and updates live, with no GitHub calls for
  them. It moves first, since it is the biggest reader (#472).
- `factory status`, `factory prd`, `factory next` and `factory messages` give the same answers, read from the database.
- `factory doctor` says when the database can't be reached, with the fix.

### 7. Ideas taken from Skein and plandb (ideas only, no code)

Skein is BSL 1.1 and plandb is Apache 2.0 (#469). Builders may read their data models, API shapes and features; no code
is copied.

- **The events table is the record; a notification only says "changed".** Each change writes an event row in the same
  transaction; readers drop duplicates by event id (Skein's outbox).
- **Claim is atomic over the lock and the state** (ready to in progress in one transaction), and giving a task back
  says why: hand off, give up, or defer. A write carries the version it read (Skein).
- **Dependencies are typed edges, never prose:** blocks, waits-for, parent-child, discovered-from, supersedes,
  duplicates. A cycle is refused. "Blocked" and the ready list are computed from the edges (Skein; plandb's
  dependencies across levels).
- **A stale claim is released only when both the claim and its holder have gone quiet**, recorded as an event by the
  system (Skein).
- **Context entries:** a discovery, a blocker or a decision recorded on a task is shown to the next agent that takes a
  task linked to it (plandb's `context`).
- **One call returns an agent's start:** its tasks in progress, the ready ones, the blocked ones and recent activity
  (Skein's `prime`; plandb's `go`). The web UI's first read uses the same shape.

### 8. Trust and security

- The database listens on the Tailscale address only, never `0.0.0.0`, like the NATS hub (0004 point 4).
- One database user per role, and a message's sender column is checked against the user who wrote it, so a builder
  can't write as the dev manager. The limit is 0004's: agents on one machine run as one OS user.
- Credentials live outside the repo, with mode 600, like the NATS seeds. The factory never prints them.
- A message is data, never an instruction (`messages.md`).

### 9. Moving over, one kind at a time, both copies kept

As with NATS (0004 point 8): a kind moves when it is listed in a setting; for a period it is written to the database
and to GitHub, and readers count what they find on one but not the other. After a period with nothing missed, the
owner stops the GitHub copy for that kind. The web UI's reads move first.

### 10. The technical half

Written by the owner's session (6 Nov), since the owner stopped the agents and asked it to build this. It takes
fasil's answers on #469 and #472 and the ideas in point 7.

**The folder.**
- `software-factory/message-board/` holds `src/` (the framework), `tests/`, `README.md`, and `bin.ts` (its command).
- It imports only Bun and Node built-ins. `check_skills.ts` fails if a file in it imports from outside the folder, or
  if a factory file imports anything there other than `message-board/src/index.ts`.
- `tools/run_tests.ts` also runs `message-board/tests/*.test.ts`.

**The client.** Bun's built-in `SQL` (Bun 1.4: queries, transactions, `listen`), so no new package.

**The schema.** Migrations are numbered SQL files, applied in order in one transaction each and recorded in
`mb_migrations`; running them twice changes nothing. The tables:
- `actors`: who (an agent or a person), with a kind and the role the user of the framework gives it, which is free text.
- `tasks`: id; an external ref (`github:owner/repo#123`, unique, used by the import); title; body; kind (task, epic,
  bug, decision, note); a status (`open`, `in_progress`, `in_review`, `done`, `deferred`); a close outcome (`done`,
  `wont_do`, `duplicate`, `superseded`); priority; parent id; the holder and claim fields (holder, a claim token, since,
  until); a version, raised by every write; created and updated times.
- `edges`: from, to, kind (`blocks`, `waits_for`, `discovered_from`, `supersedes`, `duplicates`, `related`). A cycle
  of `blocks` edges is refused in the same transaction. Parent and child is the `parent` column, not an edge.
- `messages`: id, task id or none, thread id, kind (`question`, `answer`, `status`, `note`, `verdict`, `ask`), sender,
  addressee, state, in-reply-to, body, created time. This is the factory's envelope as columns.
- `context`: task id, kind (`discovery`, `decision`, `blocker`, `result`), body, author, time.
- `events`: a bigint sequence, kind, subject, actor, actor session, payload as JSON, time. Every write above inserts
  its event in the same transaction, then `NOTIFY mb_events, '<seq>'` (the notification carries only the sequence).

**The rules, in SQL.**
- **"Blocked" and "ready" are a view, computed when read.** A task is blocked while any `blocks` or `waits_for` edge
  points to it from a task that isn't done, its own or one of its parents'. Ready means open, not blocked, and nobody
  holds it. Nothing is stored that a write could forget to refresh (plandb's weak point).
- **Claim** is one statement: `UPDATE tasks SET holder, token, until, status = 'in_progress' WHERE id = (SELECT id
  FROM ready ... ORDER BY priority, created LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING`. A claim of a named task
  succeeds only if the task is ready, or the caller already holds it. The new token goes back to the caller.
- **Every later write by the holder** (release, hand-off, close, heartbeat) names the token. A write with an old token
  is refused (`claim-lost`), so a builder whose task was given to someone else can't close it (codeaf's fencing).
- **Release says what happens next:** `ready` (give it up), `deferred`, or hand off to a named actor, with a reason.
- **A stale claim** is released by `sweep` only when its `until` has passed **and** the holder sent no heartbeat for
  the quiet time (default 30 minutes). Both are re-checked in the same `UPDATE`, so a heartbeat that lands meanwhile
  wins.
- **Edits carry the version they read.** A mismatch is a `conflict` error, not an overwrite.

**The API** (`src/index.ts`), async and plain. One `Board` object opened with a URL:
- tasks: `create`, `get`, `update`, `link`, `unlink`, `ready`, `claim`, `heartbeat`, `release`, `close`;
- threads: `post` and `thread`;
- context: `note` and `contextFor` (a task's own entries, and those of the tasks linked to it);
- `prime(actor)`: what the actor holds, what is ready, what is blocked, and recent events, in one call;
- views: `onMe(actor)` and `delegated(actor)`;
- live: `events(after)` and `listen(onEvent)`;
- `import`, for the GitHub importer.

Errors are `{code, message, fix}`.

**The command:** `factory board <verb>` runs `message-board/bin.ts`:
- `up`, `down`, `status`: a Postgres container from the official image, published only on 127.0.0.1 and the Tailscale
  address, like the NATS hub;
- `migrate`, `backup` (a `pg_dump` from inside the container), and `sweep`;
- `import github [--closed] [--dry-run]`;
- `tasks`, `show <id>`, `ready`, `prime <actor>`.

The URL and the password live in the machine's settings folder (`message-board/url`, mode 600). They are never printed.

**The factory's side: sync ports.** The ports stay synchronous. The Postgres adapter for `TaskTracker`, `Messaging`
and `Leases` does what the NATS plugin does: each call runs a child Bun with `Bun.spawnSync`, which connects, does the
one thing, prints JSON and exits. This costs about 100 ms a call, which the loops can afford, and adds no shared state.
`Wakes.waitWake` is a child that `listen`s until a matching event or its time limit. Making the ports async is a later
refactor, not part of this.

The adapters pass 0003's contract suite (`hooks/core/adapters/memory`, the same tests the GitHub adapter passes).

**Tests** need a real Postgres. They read `MB_TEST_URL`. When it's unset:
- **CI:** the job runs a `postgres` service container, so it is always set.
- **Locally:** the tests start a throwaway container with Docker and remove it when they finish.
- **Without Docker:** the tests fail and say how to fix it. They never pass quietly.

**The PR gate and the Factory guard** read only GitHub, as today. Nothing in the board changes what may merge.

**The import:** issues become tasks with an external ref; comments become a thread; `factory:*` labels set the status
(`ready` maps to open); `Depends on #n` lines become `blocks` edges; a parent comes from an epic's `- [ ] #n` lines;
`PRD:` and `Budget:` are kept in the body. A second run updates by external ref and makes no duplicates.

**The order of the build:**
1. The framework: schema, rules, API, command, and tests against Postgres.
2. The import (command line), then the first-launch screen (#457).
3. The adapters behind the ports, with the contract suite; the web UI reads from them first.
4. The mirror to GitHub, and the owner queue to #293.
5. The kinds move one at a time (point 9).

The ideas filed on 6 Nov plug in as follows:
- #485 (typed dependencies) and #486 (context to the next agent) are in step 1.
- #483 (results to read) and #484 (on me and delegated) are views over step 1, shown in the web UI.

## Alternatives

- **Skein, self-hosted, as the TaskTracker and Messaging adapter** (#469, fasil's comparison). Set aside: it adds
  seven containers, has no GitHub integration (so we would still write the import and the mirror), maps poorly onto our
  states (no "in review"; claims held by a session, not a named agent), and its BSL 1.1 licence limits a factory that
  downloads or bundles it. It is a 1.0 from two weeks ago.
- **plandb itself.** Set aside: a single Rust binary on SQLite is one machine's record, and our agents run on several
  machines over Tailscale. Adding a binary is a dependency. Its task model is taken as ideas (point 7).
- **Postgres for the record, NATS for live delivery** (fasil's option (a)). Set aside as the default: two services,
  two backups, two kinds of credentials, for no gain at our size. It stays possible behind the port (point 3).
- **Fewer GitHub calls only** (#461 to #463, #473). Done, and still not enough: the rest is GitHub used as a database.
- **SQLite on the hub.** Set aside: agents on other machines can't share a file over the network safely.

## Consequences

- PRD D10 becomes: "The factory's own database is the record for tasks and conversations; GitHub holds the code, the
  pull requests, CI and what the PR gate trusts." 0004's NATS becomes optional. `messages.md` gains the database
  transport.
- One more service on the hub machine (a Postgres container), reached over Tailscale, backed up nightly.
- An agent that can't reach the database can't take new work. Whether it falls back to GitHub, as with NATS, is in the
  technical half.
- The PRD gains section 4.11 (US-40 to US-48).

## Build tasks (a draft; filed with fasil once this decision is accepted)

Each one PR, each with a `PRD: US-<n>` line. fasil sets the final split and order.

1. The framework's folder (`software-factory/message-board/`), its public API, the import rule in `check_skills.ts`, and its run commands.
2. The schema and the Postgres adapters for `TaskTracker` and `Messaging`, passing 0003's contract suite.
3. The import from GitHub, from the command line, safe to run twice, with a dry run.
4. The import from the first-launch screens (#457).
5. The mirror to GitHub, and the owner queue mirrored to #293 with answers read back.
6. The web UI reads from the database (first kind to move).
7. Each further kind moves, one task per kind.
8. Docs: PRD D10, `messages.md`, 0004's note, the wiki.
