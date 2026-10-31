# 0003: The factory's core as ports and adapters; GitHub is one adapter

Date: 31 Oct 2026. Status: proposed (#374); the owner approves it. The owner's direction: "if you're going to build
things as plugins you need to use hexagonal and DDD; IoC is important. The source of issues can be Jira tomorrow, not
GitHub: think big."

## Context

The factory talks to GitHub from everywhere. About 30 of the 89 files in `hooks/` call `gh` themselves, through the
shared `gh`/`ghAll` in `factory_issues.ts` or one of 13 private copies that each handle errors their own way. The
choice between a plan file and GitHub issues is not an interface: `taskSource(cfg) === "issues"` is checked in 17
files. A new tracker (Jira, Linear) would add another branch to each of them.

The factory's concepts are spread across comment markers (`<!-- factory-claim -->`, `factory-mustfix`,
`factory-owner-ask` and about 15 more), each written in one place and parsed in several. Only two parts already look
like a domain:
- `factory_messages.ts`, a versioned message envelope modelled on A2A (#107);
- `factory_lease.ts`, leases.

What it costs today:
- **The GitHub call limit (#371).** Every role re-reads the same comments, because nothing owns "what's new since I
  last looked".
- **No second vendor.** A different tracker, code host or message bus means editing every role.

## Decision

### 1. Domain

These are plain TypeScript types and functions. They import no adapter, no `gh` and no file system:

- **Task**, with its state (ready, in progress, in review, blocked, done) and its claim. A task is claimed by one agent
  at a time; a claim expires; a blocked task says why.
- **ChangeRequest**: a pull request or merge request, with its head commit, files, protected paths and size.
- **Review** and **Verdict** (pass, must-fix, hold, approved), always for one head commit. A must-fix blocks a merge
  until a later verdict on a newer commit.
- **CiState**: pending, green, red (with the failing jobs) or not started.
- **Message**: the `factory_messages.ts` envelope (question, answer, must-fix, approval, status), with its states.
- **Lease**: a review or answer claim with an end time.
- **OwnerAsk** and **OwnerAnswer**: an ask is answered once; `for=product` routes it to the product owner.
- **Agent**: name, role, machine, last seen, state.

The rules live with the types (`domain/`), are unit-tested without any fake, and are what the roles use.

### 2. Ports

| Port | Owns | Adapters now | Later |
|---|---|---|---|
| `TaskTracker` | list, read, claim, release, block, close tasks; labels or states; dependencies | GitHub Issues; the plan file | Jira, Linear |
| `CodeHost` | branches, change requests, their files and events, merges | GitHub | GitLab, Bitbucket |
| `Ci` | runs, jobs, logs, reruns, runners | GitHub Actions | GitLab CI, Buildkite |
| `Messaging` | send a message; read the messages since a cursor; leases | GitHub comments | NATS (#373) |
| `OwnerInbox` | the owner's queue: asks, answers, the sign-off queue | the owner-queue issue | Slack, the cockpit |
| `GateRecord` | what the gates trust: reviewer passes, verdicts, holds, for one commit | GitHub (comments by a trusted login, plus the review-pass store) | the same code host as `CodeHost`, always |
| `AgentRegistry` | who is alive, on which machine, doing what | the agent issues | NATS, a file on each machine |
| `RepoConfig` | the account, the owner, the main branch, and `factory.json` as read from main | GitHub | GitLab |
| `Notifier` | tell the owner something needs them | push | Slack, email |

`Clock`, `Processes` and `Files` are ports too, so that tests can inject time, child processes and the disk.

Each port reads "since a cursor" where it can, and an adapter may answer from a cache or with a conditional request.
This is where the #371 saving lives: the roles ask for "what's new", and the adapter decides how to get it cheaply.

### 3. Trust (the part that must not go wrong)

The PR gate and `manager_gate.ts` decide merges from `GateRecord` and `RepoConfig`, never from `Messaging`:

- **GateRecord is held where the merge happens.** It uses the same vendor and the same authentication as `CodeHost`,
  so a record on GitHub is only believed when a trusted login wrote it, for the head commit. A message bus never
  carries a gate fact. On NATS, an agent could publish "approved"; the gate would not read it.
- **The gates read `factory.json` from main**, not from the branch (as today, `loadFromMain`).
- **The gates fail closed.** A missing or unreachable adapter refuses the merge, with `{code, message, fix}`.
- **Agents can't change the wiring.** The composition root, the port interfaces and the GitHub `GateRecord` adapter
  are protected paths, like the gate is today.

### 4. Inversion of control

- **One composition root** (`hooks/factory_wiring.ts`) reads `factory.json` (for example `"tasks": {"tracker":
  "github"}`, `"messaging": {"transport": "github"}`) and builds the adapters.
- Every command's `main` calls it once and passes the ports down.
- Roles and domain functions receive ports as parameters and never import an adapter.
- There is no DI framework: plain functions and objects, built-ins only.

### 5. Plugins

An adapter that needs an npm package (the NATS client, a Jira client) is a **plugin**: its own folder
(`software-factory/plugins/<name>/`, with its own `package.json`), bundled at release into one JavaScript file with
`bun build`, as the Ink cockpit is (0002). A project installs nothing.

- **Turning it on:** `factory.json` names it, and the composition root loads it.
- **Missing or failing to load:** the command stops with `{code, message, fix}`. For `Messaging` only, it may fall
  back to GitHub when `fallback: "github"` is set.
- **No imports across the line:** `check_skills.ts` refuses a core import of a plugin's packages, and a plugin
  importing anything but the port interfaces and the domain.
- The Ink cockpit moves under this mechanism once it exists.

### 6. Layout and style

```
hooks/domain/          types and rules, no I/O
hooks/ports/           the interfaces, one file each
hooks/adapters/github/ the GitHub adapters, over one shared transport (get, getAll, send; one error policy)
hooks/adapters/plan/   the plan-file TaskTracker
hooks/adapters/memory/ in-memory fakes of every port, for tests
hooks/factory_wiring.ts
hooks/factory_*.ts     the commands, thin: parse arguments, wire, call the role
```

- **Installing:** `install.sh` already copies `hooks/` with its subfolders. The test that checks the repo's links
  (`self_hosting.test.ts`) learns subfolders.
- **Style:** the `nestjs-clean-code-ddd-hexagonal` skill is the reference for layering and naming. Its rules apply
  without NestJS: the domain has no framework or I/O, use cases depend on ports, and adapters depend inward. An owner
  change adds it as a `styles` entry for `software-factory/hooks/{domain,ports,adapters}/**`, so the
  architecture reviewer checks new code against it.

### 7. Tests

- **Domain rules:** plain unit tests.
- **Ports:** each port has one **contract suite** (`tests/contract/<port>.ts`). Every adapter passes it: the in-memory
  fake, the GitHub adapter against the fake `gh`, and later NATS against a real `nats-server` in Docker.
- **Roles:** tests use the in-memory adapters, which is faster and needs no fake `gh`.
- **The existing tests stay** and keep passing. They are what proves each migration step changed no behaviour.

### 8. Migration, one port at a time

Each step is one small PR with no change in behaviour, and every test is green after it. Nothing is rewritten.

1. **One GitHub transport.** Move the 13 private wrappers onto one module (`get`, `getAll`, `send`), keeping each
   caller's error behaviour. The commands sent to `gh` stay byte for byte the same.
2. **`OwnerInbox`.** The two copies of `ownerQueue` (`factory_orchestrator.ts`, `factory_manager_claims.ts`) and its
   six readers go behind the port. The queue is then read once per cycle.
3. **`Messaging`.** The envelope becomes the domain type, leases join it, and "since a cursor" is the read. This is
   #371's fix. NATS (#373, decision 0004) is its second adapter.
4. **`TaskTracker`.** The 17 `taskSource` branches become the GitHub and plan adapters.
5. **`CodeHost` and `GateRecord`,** with the gates last and reviewed by the owner.
6. **`Ci`, `AgentRegistry`, `RepoConfig`, `Notifier`.**

New code written in the meantime uses the ports that exist and adds no direct `gh` call to a role.

## Consequences

- **More files and one level of indirection.** In return, a vendor change is an adapter and a setting, not an edit
  across the roles.
- **Tests split:** fast tests through in-memory ports, the existing command tests through the fake `gh`, and
  contract suites that keep both honest.
- **The gates move last** and only behind `GateRecord` on the code host, so a new transport can never weaken what
  decides a merge.
- **Out of scope:** the order of the vendor adapters after GitHub (Jira, GitLab, Slack). Each is its own task, when
  a project needs it.
