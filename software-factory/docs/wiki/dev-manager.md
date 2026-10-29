# The dev manager

What the dev manager does in a pass, how its queue is built and how several managers share the work.

Back to the [wiki home](../../README.md#wiki)

On this page:

- [The dev manager](#the-dev-manager)

<br>

## The dev manager

A role you run in a terminal, on any machine, that runs the process the owner agreed (`factory dev-manager loop`, see
[Run a manager](#run-a-manager)). An orchestrator with no model watches GitHub and starts a one-item sub-manager (a
Claude session) for each thing that needs one. A sub-manager reviews a PR (protected ones included), merges, fixes small
leftovers, answers a question, sweeps dead agents, writes issues in issues mode, and tells you only what needs you. It
can't type into an agent's terminal. Its levers are PRs, comments, labels, the plan and the blocked list. Changing the
factory, the scope or its own rhythm needs your yes.

It talks to the agents through markers in PR comments:

| Marker | Written by | Meaning |
|---|---|---|
| `<!-- factory-question -->` | An agent | A decision it needs. It keeps working around it |
| `<!-- factory-answer -->` | Dev manager | The answer, or `needs-owner: ...` when it's yours |
| `<!-- factory-mustfix sha=<head> -->` | Dev manager | Must-fixes for that commit. Makes the PR rework and holds its merge |
| `<!-- factory-approved sha=<head> -->` | Dev manager | That commit is approved. Clears a must-fix for that commit only |
| `factory-hold` label | Dev manager | It's reviewing. Agents skip the PR and can't merge it |

### Several managers at once

Two or more managers (any machine) can work one repository without reviewing, answering, merging or asking the same
thing twice, and a manager that dies mid-review does not block a PR. The protocol is a few comments on GitHub, so it
needs no server. `factory manager-claims` (`hooks/factory_manager_claims.ts`) implements it; every command needs the
manager's name, `--manager dm-1`.

| Marker | Written by | Meaning |
|---|---|---|
| `<!-- factory-review-claim manager=<name> sha=<head> until=<ISO time> -->` | A manager | "I am reviewing this head until then." A lease |
| `<!-- factory-answer-claim manager=<name> question=<comment id> until=<ISO time> -->` | A manager | The same for a `factory-question` |
| `<!-- factory-claim-release manager=<name> sha=<head> -->` (or `question=<id>`) | A manager | "I gave this up before the lease ran out" |
| `<!-- factory-owner-ask id=<slug> -->` | A manager | One ask on the owner-queue issue, "Dev manager: needs the owner" |
| `<!-- factory-po-reply ask=<slug> -->` (`done` may follow) | The product owner | Its reply to an ask tagged `for=product`: the ask waits for the owner; `done` closes it |

How a review is claimed (`factory manager-claims review <pr>`, or `next` for every free PR and question):

1. A PR whose head has no marker (`factory-approved`, `factory-mustfix`, `pr-watch`) and no unexpired claim by another
   manager is free. The manager posts a claim with `until` = now + `manager.claimMinutes` (default 20).
2. It re-reads the comments. The earliest unexpired claim for that head wins, in the order GitHub lists the comments.
   If it lost, it does nothing more (exit code 3) and moves on.
3. The winner puts `factory-hold` on, reviews, ends with the usual marker and takes the hold off
   (`factory manager-claims release <pr>`). A new head commit changes the sha, so the old claim means nothing.
4. If the manager dies, `until` passes. The next `next` (or `sweep`) takes `factory-hold` off a PR that has had a
   claim and has none running, and the PR can be claimed again. A hold on a PR nobody ever claimed is the owner's and
   is left alone. A lease never counts for more than two hours after its comment, whatever `until` says.

A question is claimed the same way (`answer <comment id>`); the `factory-answer` comment ends it. A claim is not an
answer: `factory wait answer` and `factory precheck` ignore `factory-answer-claim`.

`merge <pr>` merges only a head with `factory-approved sha=<head>` and passes that sha to GitHub, so a second
manager's merge of an already merged or changed PR is refused by GitHub. The command reads that refusal as "done by
someone else" (or "the head moved; it needs a new review") and exits 0, not as an error.

`ask --id <slug> --text "..."` posts an ask on the owner-queue issue (created if missing; pin it by hand, the REST API
cannot) only if no comment there carries that id. If two managers post at once, the earliest stays and the other
removes its own.

`factory manager-claims list [--json]` and `factory status` show every claim. `claimMinutes` is the setting
`manager.claimMinutes`. All managers and builders use one GitHub account, so the name lives inside the comment, and
`trustedReviewers` cannot tell managers apart: nothing here relies on it. Builders cannot post the claim markers
(PR gate) or run the command (the agents' settings).
**The standing rules are a skill, not a memory (#96).** `/manage-pass` (`kit/.claude/skills/manage-pass/SKILL.md`, installed in
a project like the other skills) holds everything a fresh session needs: the two-column table of what the manager does
alone and what it asks the owner first (the one copy; the playbook links to it), the pass order, the exact markers, the hold
label, the sha-pinned REST merge (`PUT .../pulls/<n>/merge` with `sha`), the CI rule, and the "never" list. The project's own
additions go in `<roles.dir>/dev-manager/README.md` (or, without a role folder, `<notes>/manager.md`); the skill says to
read them first. `claude -p "/manage-pass --dry-run"` reads, prints what it would do and writes nothing.

### Run a manager

```
factory dev-manager [name] loop            the orchestrator, unattended; keep it running (tmux, a VM, factory autostart)
factory dev-manager [name] loop --once     one cycle, then exit (cron or a systemd timer can run this)
factory dev-manager [name] loop --dry-run  read GitHub, print what a cycle would do, write nothing
factory dev-manager [name] loop -i         one item in a session you can type into, with Remote Control (cap 1)
factory watch [--json]                     the seven checks on their own: one line per item and who it is for
```

**The orchestrator has no model (#97).** `factory dev-manager loop` is a loop script. Each cycle it runs the seven checks
(`factory_watch.ts`; `factory precheck` is its checks 1, 2 and the quiet agents and issues), reads labels and comments as
the only truth, and starts a fresh one-item sub-manager for each item that needs a manager: `claude -p "/manage-pass pr-417"`
on the manager settings profile, with the item's fact sheet and its thread note in the prompt. A sub-manager does its one item
and exits. The orchestrator never starts a builder, and it never merges or reviews itself.

| # | Check | Goes to | Fires when |
|---|---|---|---|
| 1 | an unreviewed head commit | a sub-manager | the PR has no verdict or `pr-watch` for its head, and the commit is older than `manager.quietMinutes` (5) |
| 2 | an open question | a sub-manager | a `factory-question` (or `factory-msg kind=question to=dev-manager`) has no later answer |
| 3 | must-fix, red CI, a conflict | a sub-manager | the head was reviewed and the problem is older than `manager.staleMinutes` (15) |
| 4 | approved and green | a sub-manager to merge; the owner if the manager opened the PR | the verdict names the head and CI is green by the manager's rule |
| 5 | an owner wait | the owner queue | a PR has had `roles.product-owner.workLabel` or `factory:needs-owner` for `manager.ownerWaitMinutes` (120) |
| 6 | agents | a sub-manager (silent agent); the owner queue (down, or idle) | a coding agent is silent, down, or idle for `manager.agentIdleMinutes` (45) while tasks are ready |
| 7 | queued CI | the owner queue | Actions runs queued for `manager.ciQueuedMinutes` (10), with "no runner online" when it can see that |

**Leases.** A sub-manager takes a lease on its item first (a comment: `factory-review-claim manager= sha= until=`,
`factory-answer-claim`, or `factory-item-claim`) and ends it when it exits. The earliest unexpired claim wins; a claim
that is not renewed expires after `manager.claimMinutes` (20). Two orchestrators (two machines) therefore never start the
same item. A new head is a new key. The cap is `manager.maxSubManagers` (2) sub-managers at once, counting the ones this
orchestrator started and the items other managers hold; the rest wait for the next cycle. `-i` runs one at a time.
`manager.subManagerMinutes` (30) stops a sub-manager that runs too long. The marker formats are the ones #99 defines;
`factory_lease.ts` is the small module behind them, to be replaced by #99's.

**Thread notes.** The memory of a sub-manager is a comment on the task issue (on the PR when there is no issue):
`<!-- factory-manager-note thread=issue-20 status=open -->`. The orchestrator opens it when an issue gets
`factory:in-progress` and marks it `closed` when the issue closes, with no model. The sub-manager reads it from its prompt and
edits it (`PATCH .../issues/comments/<id>`) before it exits. It is a memory, not a source of truth.

**A pull request the manager did not review.** When a sub-manager takes a review or fix item for a pull request and ends with no
comment of its own, the orchestrator leaves one (no model): `<!-- factory-manager-skip sha=<head> -->`, *Dev manager NAME looked
at this pull request and did not review it*, the reason (a draft, a merge conflict, red CI with the failed jobs, CI not finished,
or no reason given) and the next step. Once per head commit. Claims, releases and the thread note do not count as a comment.
When the reason is "no reason given" (the session ended with nothing a person or CI will change), the comment also carries
`<!-- factory-review-failed sha=<head> -->` and the orchestrator asks the owner once (`id=review-failed-<pr>-<sha>`): that
head is not started again, so later pull requests are not starved; a new commit is reviewed as usual. When more pull requests
need a manager than there are places (`manager.maxSubManagers`), the ones whose CI is green go first.

**What a sub-manager may run.** It runs headless on `.claude/manager/settings.json`, so anything the profile does not allow
stops it. The verdict goes through `gh api -X POST repos/{owner}/{repo}/issues/<n>/comments` (a longer body from
`tmp/manager-<n>.md`, the one file it may write, with `-F body=@tmp/manager-<n>.md`); `gh pr comment` and `gh pr review`
stay unavailable. It may also run `gh run view`, `git merge-base`, `git merge-tree`, `git ls-tree` and `git cat-file`, one
command per call. `factory doctor` replays every command the skill names against the profile and says `fix` for one that
would prompt.

**Closing a pull request.** A superseded or obsolete pull request that a factory agent opened (a `task/...` branch in this
repository, or the manager's own branch) is closed by the dev manager: a comment with the reason and the commit that
supersedes it, then `gh api -X PATCH repos/{owner}/{repo}/pulls/<n> -f state=closed`. One opened by the owner or anyone
else, or from a fork, is an owner-queue ask. `manager_gate.ts` refuses the close of any other pull request and says to write
the ask; it never allows a merge by this path, and `gh pr close` stays unavailable.

**Telling the owner.** The channel is GitHub: one comment on the issue "Dev manager: needs the owner", mentioning
`manager.notify` (a login) or, when that is empty, the repository's owner if that is a person. GitHub's own notifications
reach the phone. An ask has an `id` and is posted once. Items for the owner: the queued CI, a down or idle agent, a PR
waiting on the product owner, the manager's own approved PR, and the dead-man's switch.

**The dead-man's switch.** If work that needs a manager has waited `manager.deadManMinutes` (30) and no dev manager has
acted in that time (a verdict, an answer, a watch, an owner ask, a merge, or a "working" ping; taking a lease does not
count), the orchestrator posts one ask naming the items, so a dead manager is not silent. The same check runs when
something else runs the cycle: `factory dev-manager loop --once` from cron or a systemd timer works if no machine stays
logged in:

```
*/10 * * * * cd /path/to/project && factory dev-manager lead loop --once >> .git/factory-manager/cron.log 2>&1
```

A scheduled GitHub Actions workflow could run the same check without a machine, but `.github/` is protected, so adding it
is an owner step; `factory watch --json` is what it would call.

Logs: `.git/factory-manager/<name>.log` (the cycle) and `.git/factory-manager/<name>.d/<item>.out` (a sub-manager's output).
`factory doctor` checks that `gh` is signed in, the manager profile resolves and its hook scripts exist. If `.claude/manager/settings.json` is missing and the installed release does not carry it, the note says so and points at `factory releases` for a newer one (a plain `factory update` would answer "nothing to install").

**A settings profile and a gate keep it inside the rules.** The builders' settings (`.claude/factory/settings.json`) deny `Bash(gh api *)`, so builders
cannot be reused for a manager. The manager runs on its own profile, `.claude/manager/settings.json` (pass it with
`claude --setting-sources user --settings .claude/manager/settings.json`; `factory dev-manager loop` does; that also leaves out
the project's skills, so the prompt says to read `.claude/skills/manage-pass/SKILL.md` instead of typing `/manage-pass`): it allows `gh api`,
read-only git, `Read`/`Grep`/`Glob` and subagents, and denies pushing to main, force-push, editing `.claude/**`, `vendor/**`,
`CLAUDE.md` and `docs/PRD.md`, `gh pr merge` and reading secrets files. Its PreToolUse hook `manager_gate.ts` refuses, and says
to write an owner-queue ask instead: a merge unless the PR's latest approval marker is `factory-approved sha=<the head being
merged>`, no must-fix came after it, the merge is pinned to that head and CI is judged green (newest non-skipped run per job
name, `factory_ci_judge.ts`); a merge of a PR the manager opened (a `manager/` branch, or a body with
`<!-- factory-role role=dev-manager ... -->`: its own PRs wait for the owner); deleting refs, force-pushing and pushing to
main; `gh api` writes to `.github/` content, branch protection, rulesets, Actions secrets and variables, webhooks and deploy
keys; and shell commands that read secrets files. Like `pr-gate.ts` it is a guard rail, not a lock: keep branch protection
and required CI on GitHub.

The full playbook is [DEV-MANAGER.md](../../DEV-MANAGER.md). To start it, run `factory dev-manager loop` (or `-i`) on a machine with the factory installed; the handover from a
cloud-session manager is [docs/manager-handover.md](../manager-handover.md), and `factory handover snapshot` prints the
state to hand over from GitHub.

### The list a manager starts from: `factory prs`

`factory prs` is read-only and uses the REST API only (`gh api`; no `gh pr`, no GraphQL, so it works where `gh pr` is
blocked). A pass reads it first instead of paginating comments and check runs.

```
Open pull requests (2)
#12 review: Task 7
    task/7-x | cccccc1 (14 min) | agent:taytu
    CI green | no marker for the head (older: factory-approved 0000000) | no claim
#13 waiting for agent: Task 9
    task/9-y | dddddd2 (3 h) | draft
    CI red (lint) | factory-mustfix | no claim
Questions
  pr #13 waiting 40 min: https://github.com/o/r/pull/13#issuecomment-1
Owner asks
  none waiting
Agents
  all agents answering
```

**CI, judged by one rule.** For each job name, the newest run that was not skipped decides: a re-run replaces a
failure, and a skipped run decides nothing. The PR gets one state: `red` (a job failed, was cancelled or timed out),
else `running`, else `queued`, else `green`. `none` means GitHub shows no runs yet; `unknown` means they could not be
read (the other PRs still show). `notGreen` names the jobs that are not green. `runs` counts every check run; `jobs` counts the
job names the rule judged, so a re-run or a skipped run is not counted again. `factory status` uses the same rule
and the same reading of the markers (both come from `factory_prs.ts`).

**Markers per commit.** `markers` holds the newest `factory-approved`, `factory-mustfix` or `pr-watch` for each
commit, oldest first, and `namesHead` says whether it names the current head. Only the head's marker decides:
an approval of an older commit does not count. Approvals follow the merge gate's rule (only a login in main's
`trustedReviewers`, when that is set), and a must-fix holds the merge until an approval of the head comes after it.

**Review claim.** A `<!-- factory-review-claim manager=<name> sha=<head> until=<ISO time> -->` comment for the
current head that has not expired; the earliest one wins. A claim for another commit, or past its `until`, is ignored.
(The protocol, with releases and the lease cap, is `factory manager-claims`, which this reads through the same code.)

**Next action**, the first rule that fits:

| Order | When | Next action |
|---|---|---|
| 1 | `factory-hold` is on, and a live claim or no claim exists (an expired claim and no marker for the head makes it a stale hold: it falls through) | `held by <manager>` (the claimant, else `manager`) |
| 2 | Draft | `waiting for agent` |
| 3 | CI could not be read | `none`, with an error |
| 4 | Not an agent PR (the manager's own, or a person's): red, then waiting, then green | `none`; `wait CI`; `owner merges (own PR)` |
| 5 | A must-fix names the head, or holds the merge | `waiting for agent` |
| 6 | CI red: every red job is in `manager.flakes` and has run once on this commit | `rerun flake`; otherwise `waiting for agent` |
| 7 | No marker for the head | `review` (even while CI runs) |
| 8 | `pr-watch` for the head (reviewed, not approved) | `none` |
| 9 | Approved, CI not finished | `wait CI` |
| 10 | Approved, green, protected path changed or the body says "a person merges this one" | `owner merges (protected)` |
| 11 | Approved, green | `merge` |

An agent PR is one on a `task/<n>-...` branch or with an `agent:<name>` label. All roles share one GitHub account, so
this is the only way to tell the manager's own PRs from the agents'.

**Below the PRs.** `questions`: open `factory-question` comments with no later `factory-answer`, on open PRs and on
open issues (issues are searched `--since-days` back, default 14). `ownerAsks`: asks in the open issue titled
`Dev manager: needs the owner` (comments starting `<!-- factory-owner-ask id=<slug> -->`) that no comment answers; an ask
is answered by any comment after it and before the next ask, or by `<!-- factory-owner-answer id=<slug> -->`. The
product owner replies to an ask tagged `for=product` with `<!-- factory-po-reply ask=<slug> -->` (#352): the ask then
waits for the owner (`state` `owner`, "waiting ... for the owner (the product owner replied)"), and is not the
product owner's work again until the owner answers after that reply, marked or not (`state` `product`). A plain comment
answers the newest ask or product owner reply before it. `<!-- factory-po-reply ask=<slug> done -->` closes the ask.
An ask tagged `for=product` that nobody answered is `state` `open`, "waiting ... for the product owner". `agents`:
agents that are `silent` or `down`, and `staleTasks`: in-progress tasks quiet for `tasks.staleHours` (issues mode only).

**`--json`**, stable for scripts. A part GitHub could not answer is `{"error": "..."}` in its place.

```
{
  "generatedAt": "2026-10-25T12:00:00Z",
  "pulls": [ {
      "number": 12, "title": "...", "url": "https://github.com/o/r/pull/12", "branch": "task/7-x", "draft": false,
      "head": {"sha": "<40 hex>", "ageMinutes": 14},                  // age of the head commit
      "labels": ["factory-hold", "agent:taytu"],
      "agent": "taytu" | null, "agentPr": true,
      "ci": {"state": "green|red|running|queued|none|unknown", "notGreen": [{"name": "lint", "state": "red"}], "runs": 3, "jobs": 2},
      "markers": [{"kind": "factory-approved|factory-mustfix|pr-watch", "sha": "<hex>" | null, "at": "<ISO>", "namesHead": true}],
      "headMarker": "factory-approved|factory-mustfix|pr-watch" | null,
      "gate": "approved|approval stale|must-fix|must-fix (older commit)" | null,   // the merge gate's reading
      "claim": {"manager": "ana", "until": "<ISO>", "expired": false} | null,
      "staleHold": false,
      "protected": true | false | null,                               // null: not looked at (only for a PR that could merge)
      "next": {"action": "review|merge|wait-ci|rerun-flake|waiting-for-agent|owner-merges|held|none",
               "text": "review", "reason": "protected|not-agent-pr", "by": "ana", "jobs": ["e2e"], "error": "..."}
  } ],                                                                 // "reason", "by", "jobs", "error": only when they apply
  "questions": [{"kind": "pr|issue", "number": 13, "title": "...", "url": "...", "ageMinutes": 40}],
  "ownerAsks": [{"id": "slug", "issue": 60, "url": "...", "ageMinutes": 300, "forProduct": false, "state": "open|owner|product"}],
  "agents": [{"name": "taytu", "status": "silent|down", "minutesAgo": 95}],
  "staleTasks": [{"number": 7, "title": "...", "quietHours": 4.2}],
  "note": "..."                                                        // only outside issues mode
}
```

<br>

Previous: [Reviews and gates](reviews-and-gates.md) | Next: [CI and the build cache](ci.md)
