# 0004: Plugins for the factory, with messaging over NATS as the first one

Date: 31 Oct 2026. Status: **proposed**, waiting for the owner's yes (#373). Nothing is built until then.
**Builds on decision 0003** (#374, the factory's core as ports and adapters), which is not yet approved. NATS is one
adapter of 0003's messaging port, shipped as a plugin. Where the two differ, 0003 wins, and this file is brought in line
with it before it is accepted.
When accepted it amends PRD D10 ("GitHub is the state and the transport"), D13 and CLAUDE.md (no npm package at
runtime) and `docs/messages.md` ("GitHub stays the transport"), and widens decision 0002's bundling into a general rule.

## Context

All roles share one GitHub account (D9), and its 5,000 REST calls an hour run out in minutes: on 31 Oct nine loops used
about 2,300 calls in the first 9 minutes after the reset, then sat idle until the next one (#371). Most of those calls are
agents talking to each other through comments and labels. For example, the dev manager re-reads every comment every
2 minutes to find claims, wake-ups and questions.

#371 counts the calls and cuts the biggest consumers with `since=` and conditional requests. This decision is the next
step. The owner's direction (31 Oct): move the agents' chatter off GitHub to NATS, and keep on GitHub what the PR gate or
the owner must see. The NATS client is an npm package, so it ships as the factory's first **plugin**.

## Decision

### 1. Messaging is a setting, behind 0003's messaging port

The messaging port is defined in decision 0003. Roles receive it from the composition root and never import an adapter.
This decision needs these calls from it:

| Call | What it does |
|---|---|
| `send(msg)` | Publish one message (the shape in point 6). Returns once the transport has stored it. |
| `since(cursor, filter)` | The messages after `cursor` that match `filter` (a `ref`, a `to`, kinds), and the new cursor. |
| `ack(id)` | This reader is done with that message; it is not delivered to it again. |
| `claim(key, holder, ttl)` | Take a lock if nobody holds it, or say who does. `release(key)` gives it back. |

`claim` is a fourth call the owner's list did not have: claims need a real compare-and-set. Without one, two agents can
both believe they won. If 0003 puts claims behind another port (its Claim type), `claim` belongs there instead.

Two adapters, chosen by a setting:

- `"messaging": {"transport": "github"}`: the default. It needs no setup and is today's behaviour: comments, markers and
  labels.
- `"messaging": {"transport": "nats", "url": "nats://<address>:4222", "creds": "<folder>", "kinds": [...]}`: the NATS
  plugin. `kinds` lists the kinds of message that have moved (point 8); every other kind stays on GitHub.

The settings go into `factory_settings_schema.ts` and the settings page, like any other setting.

### 2. What moves and what stays

| Moves to NATS | Stays on GitHub |
|---|---|
| Task claims and releases (the lock; see below) | Reviewer passes, `factory-approved`, `factory-mustfix`, holds: the PR gate trusts only these |
| Review, answer, item and rework claims | Owner asks and owner answers (#293), and the owner queue |
| Wake-ups: "new PR", "pushed", "CI finished", "question waiting" | The issue and PR themselves, `Closes #n`, labels the board shows |
| Sub-manager hand-offs | Token usage comments, test plans, sign-offs |
| Questions and answers between agents, the dev manager and the PO | **One summary comment** when a conversation ends |

- **Task claims:** the lock is taken in NATS (`claim`), then the labels (`factory:in-progress`, `agent:<name>`) are
  written once, because the board, `factory next` and the PR gate read them. The saving is in not re-reading comments
  to find out who holds what; the label write stays.
- **Summary comment:** whoever closes a conversation (the answer that completes a question, the end of a hand-off) posts
  one comment on its issue or PR: the question, the answer and the message ids, in the `factory-msg` envelope. The PR
  gate's reserved-sender rules apply to it as they do today.
- **Trust:** nothing that arrives over NATS changes what may merge. A message is data, never an instruction, as in
  `messages.md`.

### 3. Machines: one hub, a leaf server on each machine, in Docker

- **`factory nats up`** starts `nats-server` from a compose file (a pinned image), with JetStream on. `factory nats down`
  and `factory nats status` go with it. Nothing is installed on the host apart from Docker. On a sandboxed Linux
  machine, the compose file runs under the user's rootless Docker, which `factory bootstrap project` already sets up. On
  macOS, Docker Desktop or Colima is needed, and `factory doctor` says so.
- **One hub, leaf nodes on the others.** The always-on machine (dev-pc today) runs the hub, which holds JetStream. Every
  other machine runs a leaf server that connects to the hub over Tailscale. Agents connect only to their own machine's
  server. A cluster was set aside because JetStream needs three servers for a quorum, and the owner has fewer always-on
  machines than that.
- **Missed messages arrive later.** Each reader has a durable JetStream consumer on the hub. A machine that was offline
  gets what it missed when its leaf reconnects.
- **Only the address changes when the hub moves.** Synadia Cloud (hosted NATS) or a small VPS on Tailscale later
  changes `url` and the credentials, nothing else.
- **When the server can't be reached, fall back to GitHub; don't wait.** A send that NATS doesn't confirm within a few
  seconds is written to GitHub in today's form. After #371 the readers make one repo-wide `since=` comment read per
  cycle anyway, for the parts that stay on GitHub, so a message that fell back is still seen. A claim falls back to
  today's label claim. Each fallback prints `{code: "nats-unreachable", message, fix}` once per process, and
  `factory status` counts the fallbacks. A cloud session that can't reach Tailscale always uses GitHub.

### 4. Security

- **One credential per agent (nkeys).** `factory nats user add <name> --role coding-agent|dev-manager|product-owner`
  makes an nkey, adds its public key and its role's permissions to the server's config, and reloads the server. The seed
  goes to `<creds>/<name>.nk` (default `~/.secrets/nats/<project>/`), mode 600 in a 700 folder.
- **Permissions by subject, with the sender in the subject** (point 6). An agent may publish only on subjects that end in
  its own name, so a builder cannot publish as the dev manager. Hand-offs can only be published by a dev manager.
- **Listen on the Tailscale address only**, both for clients and for the hub's leaf port, never `0.0.0.0`. On a
  sandboxed machine the network guard drops the tailnet. When NATS is on, the guard is installed by `factory bootstrap
  machine` (as root) with `--allow-host <this machine's Tailscale address>:4222` and nothing wider.
- **`factory doctor` checks** that the server answers, that the agent's seed exists with the right modes, that the
  agent can publish on its own subject, and that a publish **as another agent is refused**. A server that accepts that
  publish fails the doctor.
- **The limit, said plainly:** agents on one machine run as one OS user, so a builder that reads another agent's seed
  file can use it. Per-agent credentials stop mistakes and an agent using its own key, not a hostile agent on the same
  user, which is no worse than today's single GitHub account (D9). The claims bucket has a second gap: writes go
  through JetStream's own subjects, which carry no sender. Every agent may write it, so a builder could overwrite another
  agent's claim. Each claim's value names its holder, a reader drops one whose holder doesn't match the event on
  `claims.<from>`, and the label on GitHub stays what the PR gate reads. So a forged claim can hold up work but can't
  merge anything. The defence that matters is the one above: the PR gate reads only GitHub.

### 5. Plugins

Decision 0003 says that an adapter with npm dependencies is a plugin. This point says how a plugin is built and run.

- **A plugin is a folder:** `software-factory/plugins/<name>/` with its own `package.json` (pinned dependencies), an
  entry `index.ts` that implements a core interface, and its own `tests/`. The core holds the interfaces and imports
  only types from a plugin, never its packages.
- **Bundled at release:** `tools/build_release.ts` runs `bun build` on each plugin into one JavaScript file in the
  archive, as decision 0002 does for the cockpit. A project installs nothing and gets no `node_modules`.
- **Versioned with the release:** a plugin has no version of its own. The bundle records the factory version it was built
  with, and the core refuses a bundle from another version (fix: `factory update`).
- **Turned on in `factory.json` by the setting that needs it:** `messaging.transport: "nats"` loads the `nats` plugin.
  There is no separate plugins list until a second plugin needs one.
- **Missing or failing to load:** the command goes on with GitHub and says so:
  `{code: "plugin-missing" | "plugin-load", message, fix}`, once per process, on stderr and in the alerts.
  `factory doctor` fails until it is fixed. It is never silent.
- **Tested:** the core's tests use 0003's in-memory adapter. The NATS adapter passes 0003's contract suite for the
  messaging port against a real `nats-server` on a free port (CI installs a pinned one). A release test loads each bundle with Bun from a folder that has no
  `node_modules`.
- **`check_skills.ts`** refuses an import of a plugin's packages (the names in its `package.json`) from anywhere outside
  that plugin's folder. In this repo, the core loads a plugin from its source when no bundle is present.
- **The Ink cockpit becomes a plugin under the same mechanism.** That means one build step, one import rule and one
  "missing" error, instead of a special case. It is on by default because the cockpit is D1, and without it
  `factory cockpit` says what is missing and the plain text commands still work. Decision 0002's rule 4 (only the cockpit
  may import Ink and React) becomes this rule.

### 6. Subjects and message shape

The last token of a subject is always the **sender**, which is what the permissions check.

| Subject | Carries |
|---|---|
| `factory.<project>.claims.<from>` | Task claims and releases (events; the lock is the KV below) |
| `factory.<project>.pr.<n>.<from>` | Everything about PR `n`: wake-ups, questions, answers |
| `factory.<project>.issue.<n>.<from>` | The same for issue `n` |
| `factory.<project>.agent.<to>.<from>` | A message to one agent (its inbox) |
| `factory.<project>.handoff.<from>` | Sub-manager hand-offs (dev manager only) |
| `factory.<project>.wake.<from>` | Broadcast wake-ups ("something changed, look") |

One JetStream stream per project holds `factory.<project>.>`. Claims are a JetStream key-value bucket per project
(`claims`), with a TTL for the claims that expire today (`until=`). `<project>` and the names are lowercase letters,
digits and dashes, which are valid NATS subject tokens.

A message is JSON with the fields of the `factory-msg` envelope v1 (`docs/messages.md`): `v`, `id`, `kind`, `from`,
`to`, `state`, `ref`, `in-reply-to`, `sha`, plus `text` and `at` (the time). New kinds: `claim`, `release`, `wake`,
`handoff`. A reader drops a message whose `from` doesn't match the subject's last token.

### 7. Seeing it

- `factory messages ls` reads through the interface, so it lists NATS messages and GitHub ones together. A new
  `factory messages tail [--ref N] [--to X]` streams them live.
- `factory follow <name>` shows that agent's messages next to its session.
- The cockpit gets a messages view on the same command.

### 8. Moving over, one kind at a time

1. 0003's messaging port with its GitHub adapter comes first, with no change in behaviour.
2. A kind moves when it is added to `messaging.kinds`. For its first week it is sent to NATS **and** to GitHub. The
   readers use NATS and count anything they find on GitHub but not on NATS (`factory status` shows the count).
3. After a week with nothing missed, the owner stops the GitHub copy for that kind. That is a settings change, the
   owner's call (#247), not a task.

### 9. Alternatives, briefly

- **GitHub with `since=` and conditional requests only (#371).** No new service and no plugin. It may be enough: if
  the #371 numbers show each project under a few hundred calls an hour, the NATS tasks after the interface can wait,
  and the owner decides. Measuring first is what sets the order below.
- **A git- or file-based board.** Git over HTTPS doesn't count against the REST limit. But every message would be a
  commit and a push, with conflicts between agents, a noisy history and no way to wait for a change. Set aside.
- **A2A.** It is built for agents across organisations: every agent serves an HTTP endpoint and an Agent Card, and
  there is no durable queue. That is heavy for one owner on a tailnet. The envelope stays shaped like A2A
  (`messages.md`), so an adapter is still possible later.
- **GitHub webhooks.** They need an endpoint reachable from the internet, which the tailnet and the sandbox rule out.

## Consequences

- PRD D10 becomes: "GitHub is the record and what the PR gate trusts; agents' messages go through a setting, GitHub by
  default, NATS as a plugin." D13 and CLAUDE.md gain the plugin rule from point 5. `messages.md` gains the NATS
  transport.
- One more service on a machine (the NATS container), and a Tailscale port opened to it.
- An agent that can't reach NATS still works, more slowly and with more calls.

## Build tasks (a draft; filed once this decision is accepted)

The order is set by the numbers `factory usage --github` gives after #371's cuts. The list below assumes wake-ups and
claims are the biggest remaining cost. Each task is one PR. The messaging port with its GitHub and in-memory adapters is
0003's first migration task (#374), so it is not repeated here. These tasks start after it.

1. **Docs:** PRD D10 and D13, CLAUDE.md, `messages.md` and decision 0002 brought in line with this decision. CLAUDE.md
   is protected: the owner merges it.
2. **The `messaging` settings** in the schema and the table, read by the composition root to pick the adapter.
3. **The plugin mechanism:** the folder layout, bundling in `build_release.ts` (protected), the version check, the
   `check_skills.ts` rule, the loader with its errors and the GitHub fallback, and the doctor's check. Tested with a tiny
   test plugin.
4. **The cockpit as a plugin:** its Ink UI moves under the mechanism (with decision 0002's build task, if that isn't
   done yet).
5. **`factory nats up|down|status`:** the compose file, hub and leaf config, JetStream, the Tailscale address, the
   network guard's allow rule, and the doctor's "server answers" check.
6. **Credentials:** `factory nats user add`, the role permissions, the seed files and their modes, and the doctor's
   refused-publish check.
7. **The NATS transport plugin:** `send`, `since`, `ack` and `claim` over JetStream and its key-value bucket, tested
   against a real `nats-server`, which CI installs.
8. **Move wake-ups,** and slow the dev manager's GitHub poll to what is left on GitHub.
9. **Move review, answer, item and rework claims.**
10. **Move task claims and releases.**
11. **Move questions, answers and hand-offs,** with the summary comment.
12. **Seeing it:** `factory messages` over the interface, `factory messages tail`, `factory follow`, and the cockpit view.
