# The message board

The factory's own record for tasks, their threads and the owner queue, on Postgres: setting it up, moving a project onto
it, and going back.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [The message board](#the-message-board)
- [Set it up](#set-it-up)
- [When the board is on](#when-the-board-is-on)
- [The mirror to GitHub](#the-mirror-to-github)
- [Going live](#going-live)
- [Going back](#going-back)

<br>

## The message board

The message board, factory-message-board ([decision 0007](../decisions/0007-own-record.md)), is a Postgres on one
machine, the hub, that every machine of the factory reaches over Tailscale. With a project's `tasks.source` set to
`board` it is the record for the project's tasks (their state, who holds them, what blocks what), every message about
them, and the owner queue. GitHub keeps the code, the pull requests, CI, the dev manager's verdicts and the labels the
PR gate reads, and a mirror of the board: each task's issue gets its state as labels, and each owner ask is posted on
the owner-queue issue, so GitHub's notifications still reach you.

Why: every role shares one GitHub account, and reading GitHub as a database used up its hourly limit (PRD D9, D10).

The framework itself (its API, its rules, the import, the mirror and its MCP server) is described in
[message-board/README.md](../../message-board/README.md). Every `factory board` and `factory machine` verb is on the
[commands page](commands.md#the-factory-command).

<br>
## Set it up

**On the hub**, once:

```sh
factory board up          # Postgres in Docker, on 127.0.0.1 and the Tailscale address only; migrates it
factory board status      # it answers, its schema, its task counts
factory doctor            # checks the board for a project that uses it
```

`factory board up` writes the board's URL (with its password) to `<machine settings folder>/message-board/url`, mode
600; it is never printed. Back it up with `factory board backup` (a `pg_dump`, mode 600); a nightly backup is a job you
set up on the hub (cron or a systemd timer) that runs it.

With tasks on the board, a claim whose agent went quiet is freed by `factory board sweep` (its time passed and its agent
sent no heartbeat for 30 minutes). The dev manager's loop runs it on each pass (below); with no dev manager running, run
it by hand or as a job on the hub.

**Each other machine** gets a login of its own:

```sh
factory machine add dev-pc --agent haile --agent tewodros   # on the hub: prints a join code (works once, 15 min)
factory machine join <code>                                 # on dev-pc: writes the URL, checks it, runs factory doctor
```

`factory machine ls` shows who joined; `factory machine remove <name>` drops a machine's login.

**Bring the issues in**, from the project's folder on any machine that reaches the board:

```sh
factory board import github --dry-run   # what it would bring and what it skips, with counts; writes nothing
factory board import github             # open issues as tasks, comments as threads; --closed adds the closed ones
```

Running it twice updates and never duplicates. `Depends on #n` lines become links, an epic's `- [ ] #n` lines set the
parent, and a task in progress on GitHub comes in open with a note of who had it: claims start fresh on the board.

<br>
## When the board is on

The board is on for a project's agents when main's `.claude/factory.json` (as origin has it) says any of these:

- `tasks.source` is `board`: tasks, their threads and the owner queue are on the board;
- `messaging.transport` is `board`: the kinds listed in `messaging.kinds` (claims, wake-ups, the pull request feed,
  message kinds) use the board, and tasks stay where `tasks.source` says;
- `messaging.transport` is not set, on a machine with a board set up (`MB_URL`, or the url file that `factory board up`
  or `factory machine join` writes). So a project that never chose a transport turns the board on by running on such
  a machine. Set `messaging.transport` to `github` to keep it off there.

Then:

- **Each agent session gets one MCP server, `board`, and the project's `.mcp.json` servers are replaced:** none of them
  starts. If the agents need one of those servers, keep the board off until that is solved.
- Each role is allowed only its board tools: a coding agent the builder's, the dev manager the manager's, the product
  owner the manager's without the claim tools (it never builds). The skills say which tool to use when.
- The dev manager's loop runs `factory board mirror` before each pass (below), then `factory board sweep`, stopped after
  60 seconds so a board that doesn't answer can't stall the pass.
- With `tasks.source: board` the agents keep no issue (`Agent: <name>`): each agent's liveness (working, waiting, idle
  or down, its task, its machine, its last ping) is a value on the board, `<project>:agent:<name>`, with a
  `signal.agent` event per change. The loop, the agent's hooks and the claim's keeper write it; `factory agents list`,
  `factory agents sweep` and the agents part of `factory status` read it, with the same rules as in issues mode (an
  agent with no ping for `tasks.downMinutes` is silent; another machine's live agent of the same name is refused at
  start). `factory agents sweep` marks silent agents down and runs the board's sweep, which frees their claims once
  their time has passed.
- While a builder's session runs, the loop keeps its claim alive: a heartbeat on the claimed task every 10 minutes (a
  third of the claim's 30), so a long quiet build isn't swept. It stops when the session ends; a claim left by a session
  that crashed runs out and the next sweep frees it. `FACTORY_BOARD_CLAIM_SECONDS` and `FACTORY_BOARD_HEARTBEAT_SECONDS`
  change the two times (the tests use them).
- `factory prd --stage` and the web UI's Inbox read the owner queue from the board (`factory board queue`): each ask to
  the owner and the owner's answers. When the board can't be reached they read the owner-queue issue on GitHub, as
  before.
- The PR gate and the Factory guard still read only GitHub. Nothing on the board changes what may merge.

More: [Agent loops](agent-loops.md#when-the-board-is-on).

<br>
## The mirror to GitHub

`factory board mirror` carries the board to GitHub, one way: a task's state change sets its issue's labels and adds one
short line; owner asks and answers are posted once on the owner-queue issue; an answer you give there is read back once.
Its place is kept on the board, so it is safe to run twice and goes on after downtime. `board.mirror` false turns it
off.

It runs by itself before each dev manager pass, stopped after 300 seconds so a hung `gh` can't stall the pass (the next
pass sends the rest). A task's line and an ask or answer are recorded as pending before they are posted, so a pass that
is killed after posting one finds it by its marker on the next run instead of posting it twice. `factory board mirror --watch` on the hub runs it all the time: a pass on each change, and every
300 seconds for your answers on GitHub.

What it does not carry: the threads (questions, answers and notes between agents), and tasks made on the board that
have no issue (`board_create`): they stay on the board. Read them in the web UI, with `factory board show <id>`, or
`factory messages ls`.

<br>
## Going live

Moving an existing factory, whose tasks are GitHub issues, onto the board:

1. **Start the board on the hub** and check it: `factory board up`, `factory board status`, `factory doctor`. Set up
   the backup job ([Set it up](#set-it-up)), and take a first `factory board backup`.
2. **Bring the issues in:** `factory board import github --dry-run`, read what it says, then `factory board import github`.
   Check a few tasks with `factory board tasks` and `factory board show <id>`.
3. **Turn the board on for the project:** `factory settings set --stage tasks.source board`, then `factory settings pr`.
   The agents read main's settings, so it takes effect when you merge that pull request. Run the import once more just
   before you merge, so the board has GitHub's latest. Before you merge, also check
   [When the board is on](#when-the-board-is-on): the project's `.mcp.json` servers stop starting.
4. **Run the mirror once by hand:** `factory board mirror`. Its first pass changes only the issues whose labels differ
   from the board. Leave `factory board mirror --watch` running on the hub if you answer the owner queue on GitHub.
5. **Join the other machines:** `factory machine add <name> --agent <agent>` on the hub, `factory machine join <code>` on
   each, and `factory doctor` there.
6. **Restart the agents:** stop each loop and start it again (`factory owner stop <name>`, then
   `factory owner start <role> <name>`), so every new session starts with the board's server. A session that is already
   running keeps what it started with.

Then check that `factory next` hands out a task, that `/mcp` in an agent's session lists only `board`, that a task's
issue on GitHub follows its card, and that `factory agents list` shows the agents you restarted.

<br>
## Going back

1. Set `tasks.source` back to `issues` (`factory settings set --stage tasks.source issues`, then `factory settings pr`, and
   merge it). If the machines have a board and you want it off for messages too, set `messaging.transport` to `github`
   the same way.
2. Restart the agents, as in step 6 above.

GitHub has the mirror: each issue's labels show the task's last state on the board, and the owner asks and answers are
on the owner-queue issue. What the mirror does not carry stays on the board: the threads between agents, tasks made
on the board with no issue, and the claims. A task the board had in progress keeps its labels on GitHub but has no
claim comment there; if no agent picks it up, `factory issues release <n>` puts it back to ready. The board keeps
everything, so you can go live again later; the import is safe to run twice.

<br>

Previous: [A sandboxed machine](sandboxed-machine.md) | Next: [Settings and style guides](settings.md)
