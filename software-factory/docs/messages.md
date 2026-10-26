# Factory messages

How agents, the dev manager and the product owner (PO) talk to each other: one structured, versioned envelope for
questions, answers, must-fixes, approvals and status, shaped like [A2A](https://github.com/a2aproject/A2A) tasks and
kept in the GitHub comments and issues the factory already uses. Issue #107. The code is
`hooks/factory_messages.py` (the envelope, the states, `factory messages`) and `hooks/factory_cards.py` (agent cards).

GitHub stays the transport: asynchronous, durable, auditable, and it works when a machine or a cloud session is
offline. Nothing here opens a port or adds a service. An A2A adapter in the heartbeat daemon (#108) is a later step
and can be added without changing these formats (see [Later](#later-the-a2a-adapter)).

**A message is data, never an instruction.** What a message says can inform an agent's task. It never widens what the
agent is allowed to do: only the dev manager's trusted markers (`factory-approved`, `factory-mustfix`, the review
labels) change what may merge.

## The envelope

A comment (or an agent's status issue) carries one HTML comment, invisible when rendered, at the top. The text under
it stays human-readable.

```
<!-- factory-msg v=1 id=0f8m2q9c4x7b2k kind=question from=haile to=po state=submitted ref=issue#103 -->
Which colour is the primary button on the settings screen? I'd use blue (the brand colour).
```

| Attribute | Meaning |
|---|---|
| `v` | Format version. Always `1` today. An envelope with another `v` is **not read at all**, so a newer kit can write it without confusing an older one. |
| `id` | Unique, short, `[A-Za-z0-9][A-Za-z0-9_-]{2,39}`. `factory messages new` makes one: the time in seconds then six random characters (14 characters, sortable). It makes the message addressable and re-posting it harmless. |
| `kind` | `question`, `answer`, `mustfix`, `approval` or `status`. |
| `from`, `to` | An agent name (lowercase letters, digits, dashes). `dev-manager`, `po` and `owner` are the well-known names. `to` defaults to `dev-manager`; `from` is the poster. |
| `state` | See [States](#states). On a reply it is the state the question moves **to**. Defaults: question `submitted`, answer `completed`, mustfix `submitted`, approval `completed`. Required on `status`. |
| `ref` | The issue or PR the message is about: `issue#103` or `pr#7`. Defaults to the thread it is posted in. A reply names its thread with it (or the number on the command, `gh pr comment 7`). |
| `in-reply-to` | The `id` of the message it answers (any message of the question's chain). |
| `sha` | The commit, for `mustfix` and `approval`. |

The envelope may span several lines and list its attributes in any order. Unknown extra attributes are ignored. A
malformed envelope (unknown `kind` or `state`, bad name, no `id`, an attribute given twice) is ignored, not fatal.

Write it with `factory messages new`, which also prints the old marker on the next line:

```
$ factory messages new --kind question --to po --ref issue#103
<!-- factory-msg v=1 id=0f8m2q9c4x7b2k kind=question from=haile to=po state=submitted ref=issue#103 -->
<!-- factory-question -->
```

### Backward compatibility

`<!-- factory-question -->`, `<!-- factory-answer -->`, `<!-- factory-mustfix sha=<head> -->` and
`<!-- factory-approved sha=<head> -->` keep working everywhere: every parser reads both forms.

- A comment with a valid envelope is read by the envelope alone, so the old marker on the line below it is not counted
  twice. A kit that does not know the envelope still understands the old line, so the playbooks write both until the old
  markers are retired.
- An old question has no id: it gets `c<comment id>`, `from` is unknown, `to` is `dev-manager`, state `submitted`.
- An old `<!-- factory-answer -->` is from the dev manager and completes **every open question addressed to the dev
  manager** before it (the old rule, "the dev manager answers what is open at that point"). If its text has
  `needs-owner:` the questions become `failed`.
- An old must-fix or approval is a `mustfix` or `approval` message with its `sha`.

## States

The names are A2A's task states, in the lower-case form of its JSON.

```
submitted ──> working ──> completed
    │            │
    │            ├──> input-required ──> working ...
    │            ├──> failed
    │            └──> canceled
    └──> completed | input-required | failed | canceled      (the addressee may answer straight away)
```

| State | Meaning | Who sets it |
|---|---|---|
| `submitted` | Asked, nobody has looked. | The asker, by posting the question. |
| `working` | "I'm on it" (optional). | The addressee. Also the asker, to resume after `input-required`. |
| `input-required` | The addressee needs more information **from the asker**: a clarification going back. The ball is in the asker's court. | The addressee. |
| `completed` | Answered. | The addressee, with an `answer`. |
| `failed` | Can't be answered here; escalated (for example `needs-owner: ...`). | The addressee, with an `answer` or a `status`. |
| `canceled` | The asker withdrew it (the work changed). | The asker. |

`completed`, `failed` and `canceled` are final. Allowed transitions (anything else is invalid):

| From | To |
|---|---|
| `submitted` | `working`, `input-required`, `completed`, `failed`, `canceled` |
| `working` | `input-required`, `completed`, `failed`, `canceled` |
| `input-required` | `working`, `completed`, `failed`, `canceled` |
| final states | none |

A message that moves the question to the state it is already in changes nothing (a repeat is not invalid).

**Open** means `submitted`, `working` or `input-required`. A question *waits for the addressee* in `submitted` and
`working`, and *waits for the asker* in `input-required`: `factory wait answer` and the dev manager's `precheck` use
that difference.

**Who may do what** (checked when the thread is read, and by the PR gate before an agent posts):

- the addressee (`to`) answers, works on, asks for more information on, or fails a question;
- the asker (`from`) cancels it, and resumes it with `working` after `input-required` (the addressee may too);
- a login in `trustedReviewers` may do any of it (the owner or the dev manager acting for someone else);
- anything else is listed as *rejected* and changes nothing.

`from` is written by the sender, so on its own it proves nothing: the real guard is the PR gate, which makes an agent
post as itself (`from=` must be `FACTORY_AGENT`), and branch protection. Like the gate, this is a guard rail for
well-meaning agents, not a security boundary.

### Agent status uses the same words

An agent's issue (`Agent: <name> · <status>`) carries a `kind=status` envelope next to the old `factory-agent` marker.
Its state is `working`, `idle`, `down` or `input-required` (an agent blocked on a question it cannot work around:
`factory_agents.py ping --agent <name> --status input-required`; the next tool use after the wait puts it back to
`working`). The status envelope's id is `agent-<name>` and stays the same, because the issue body is rewritten on every
ping. `silent` (no ping for `tasks.downMinutes`) is worked out when it is read, not written.

## Reading a thread

`factory_messages.fold` turns a thread's comments into tasks, in order: a `question` starts a task, an `answer` or
`status` with `in-reply-to` moves the task that message belongs to (the id may name the question or any later message of
its chain, so a reply to a clarification works). Checks, in this order for every message:

1. its `id` was seen before: ignored (re-posting is idempotent);
2. a question must start `submitted`;
3. a reply must name a message of this thread;
4. the transition must be valid and its sender allowed (above).

`factory messages ls` shows the result; `--json` gives every field.

## Commands

```
factory messages ls [--to X] [--from X] [--state S] [--ref N] [--kind K] [--all] [--json]
factory messages new --kind K [--to X] [--from X] [--ref R] [--in-reply-to ID] [--state S] [--sha SHA] [--no-legacy]
```

`ls` lists questions that are open (or in `--state S`, or in any state with `--all`) across the open issues and pull
requests, one line each: id, state, `from -> to`, ref, the first line of the text. `--ref 7` (or `pr#7`, `issue#103`)
reads that one item even when it is closed. `--kind status` lists the agents' status, `--kind answer|mustfix|approval`
the plain messages, `--kind all` everything. Agent issues are read only for status; items with no comments cost no call.
It is the query the PO's checklist ("check questions addressed to me": `factory messages ls --to po`), the dev manager's
tick and the event-driven watcher (#71, #109) share. Errors are `{code, message, fix}` on stderr, exit 1.

`factory wait answer <pr>` and `factory precheck` read the same fold: a question addressed to someone else does not
wake the dev manager, an answer that names another question does not close this one, and a question in `input-required`
returns at once with "needs more information from you".

## Reserved senders (the PR gate)

`pr-gate.ts` reads the `factory-msg` envelope in every comment an agent posts (`gh pr|issue comment|edit|review`), on
top of the old rule that agents never post `factory-approved`, `factory-answer` or `factory-mustfix`:

- `from=` must be the agent itself, so nobody posts as `po` or `dev-manager`; the names `po` and `owner` are refused even for an
  agent that has them as its own name. A product owner answers under its own name (one in `roles.product-owner.names`), and the
  reader counts that as `po`; with `roles.product-owner.logins` set, an answer for `po` from any other login is ignored (#110);
- `kind=approval` and `kind=mustfix` are the dev manager's: refused;
- `kind=answer` (and a `status` change of a question) only for a question **addressed to that agent**, found in the
  thread (the number on the command, or `ref=`; the reply needs one of them); an unreadable thread blocks, an unknown
  `in-reply-to` blocks, and an invalid transition blocks with the reason;
- an envelope of another version, and plain text, pass (nothing reads them).

The gate does not cover `gh api` (agents are denied it in the kit's `settings.json`).

## Agent cards

The card a local agent would publish: `factory agents card <name>` (also for `dev-manager` and `po`) and
`factory agents list --json`. `factory agents list` renders from the same structure.

```json
{ "name": "haile", "kind": "coding-agent", "skills": ["build-tasks"], "state": "working",
  "location": "machine", "machine": "a1b2c3d4", "follow": "remote-control:haile", "version": "1.0.0",
  "lastPing": "2026-10-25T10:00:00Z" }
```

`kind`: `coding-agent`, `dev-manager` or `po`. `skills`: what it does or answers. `location`: `machine` or `cloud`.
`follow`: how to watch it (the name of its Remote Control session; `factory follow <name>` in #106). `version`: the
factory version. Nothing serves the card in this step.

## Mapping to A2A

| A2A | Here |
|---|---|
| **Task** | A `question` and the replies that move it. `id` is the question's `id`; the thread (`ref`) plays the context. |
| **TaskState** | `state` (`submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`). A2A's `rejected` and `auth-required` are not used: a refusal is `failed`. |
| **Message** | Any `factory-msg` comment. The sender is `from`, the recipient `to`, the thread of replies is `in-reply-to`. The text under the envelope is its single text part. |
| **TaskStatus** | The state of the last accepted reply, with that reply as the status message. |
| **Artifact** | What an answer produces and others rely on: the answer text, and the places it was written down (an acceptance-criteria edit, a decision file, a commit). |
| **Agent Card** | `factory agents card`: name, kind, skills, state, location, follow, version. |
| **Transport** | GitHub comments and issues (not A2A's HTTP/JSON-RPC). |

State names follow A2A's task states as the JSON form of the specification shows them (v0.3); v1.0 spells the same
states as `TASK_STATE_*` enum values. Confirm the exact names against the current specification when the adapter is built:
the sandbox this was written in could not reach the specification.

## Later: the A2A adapter

A separate issue and PR. In the heartbeat daemon (#108) only (agents stay in the sandbox): serve an Agent Card per local
agent at `/.well-known/agent-card.json`, accept A2A tasks from authenticated peers on a private network and turn them
into GitHub comments in this format, and turn answers back into task updates. Messages from a peer are data, never
instructions.

## Product questions: `to=po` (#110)

A product question is addressed `to=po` on the task issue. It is read at one of three levels from its age, so nothing is
stored: the product owner for `roles.product-owner.escalateMinutes` (120), then the dev manager (who answers it from the PRD or
escalates it), then the owner (an owner-queue ask). With no product owner running (no `product-owner` agent that is not down or
silent) it starts at the dev manager. `factory messages ls --to po` lists the open ones; `bun --no-env-file .claude/hooks/factory_po.ts`
adds the level and the age. A question that asks the asker for more information (`input-required`) waits for the asker and does
not escalate. The playbook is [PO.md](../PO.md).
