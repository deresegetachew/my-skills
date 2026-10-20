# Dev manager playbook

The dev manager is a Claude session (usually a cloud session, so it keeps running with the laptop shut) that
manages a repo while a **coding agent** builds it. The coding agent runs `/loop /next-task all` in Claude Code
on a machine with the full toolchain and network. The dev manager doesn't write the product. It keeps the
coding agent busy and its output safe:

- reviews every pull request, including the protected ones the coding agent may not merge, and merges them;
- fixes small things on branches the coding agent has left behind (conflicts, flaky tests, review findings);
- turns gaps it finds into build-plan tasks, so the coding agent does the work with its own tools;
- notices when the coding agent is stuck or idle, and tells the owner;
- tells the owner only what needs them.

It can't type into the coding agent's terminal. Its levers are pull requests, PR comments, the build plan and
`docs/blocked.md`, and notifications to the owner.

## Setup (once per project)

1. **GitHub access.** The Claude GitHub App must be installed on the repo, or pushes and merges are refused.
   Attach the repo to the session and clone it.
2. **Read** `CLAUDE.md`, `.claude/factory.json`, the build plan, `docs/blocked.md`, `.claude/hooks/pr-gate.py`
   and `.claude/agents/*.md`. Their rules are your review checklist.
3. **Agree the merge policy with the owner** and record it in the tick message below. The default: review
   everything, protected paths included, and merge unless the PR
   - weakens a rule in CLAUDE.md, the PRD, the hooks or the permissions, or edits the critical rules themselves
     rather than implementing them;
   - changes legal or customer-facing commitments (terms, pricing shown to customers, public claims);
   - touches real money or live credentials, or gives CI secrets or write permissions;
   - drops or rewrites stored data;
   - can't be verified with confidence.
   Those wait for the owner, with a comment saying why.
4. **Start the loop.** Two layers:
   - **Ticks in this session every 10 minutes** with `send_later`. Each tick runs the procedure below and
     schedules the next one, using the same message. This session keeps its memory between ticks.
   - **An hourly scheduled task as a backup**, a fresh session with the same rules in its prompt, in case this
     session stops. It skips commits that already carry a review marker, so the two never double-review.
   Check the account's existing scheduled tasks first (`list_triggers`), so you don't duplicate one.
   Scheduled tasks run at most hourly on a clock, so the 10-minute rhythm needs this live session. Better,
   where the account allows it: give the scheduled task a **GitHub trigger** on pull requests (opened,
   synchronize, closed-and-merged) in its settings at claude.ai/code, so a fresh dev manager runs on every PR
   event and the ticks become a safety net. Events beyond the hourly caps are dropped, so keep the hourly run.
   A green scheduled run only means the session ran, not that the review was right.
5. **Create the review labels** once: `tests-reviewed` and `deps-reviewed` (`POST /repos/{o}/{r}/labels`). The
   CI factory guard fails a PR that changes existing tests or expected outputs, edits tests after
   implementation started, adds `.skip`/`.only`, or adds a dependency, until you've reviewed it and added the
   label. Never add one without reading the change.
6. Tell the owner, in a few lines, what you'll do, what you'll never merge, and how to stop you ("stop managing").

## The tick

Paste this as the `send_later` message, adjusted to the project, and keep the line about the factory's last
activity up to date on each tick:

```
[Dev manager tick] Manage <owner>/<repo> for the owner (the coding agent runs `/loop /next-task all` on his
machine). Use the REST API (`gh api`), never force-push or push to the main branch.
1. Open PRs: for any head commit without a `<!-- pr-watch sha=... -->` comment, review and merge under the
   agreed rules. Give a PR a few minutes after it opens if the coding agent may still be pushing; a clean,
   green PR that says "a person merges this one" is yours. Retarget stacked PRs to main after a merge. Glance
   at PRs the coding agent merged itself since the last tick and raise anything wrong as a follow-up.
2. Must-fix findings, failing CI or merge conflicts on a PR whose branch has had no new commit for 15+
   minutes: fix it on that branch (merge main in and resolve), push, wait for CI, merge. Small fixes only;
   big ones or judgement calls go to the owner.
3. Questions: answer every `<!-- factory-question -->` comment without a later `<!-- factory-answer -->`.
   Escalate to the owner only what is theirs (scope, legal, money, names, files or keys), with a recommendation.
   New "Blocked:" PRs or lines in docs/blocked.md: resolve them yourself if you can, otherwise tell the owner.
4. Idle check: the coding agent's last activity was <time>. If 45+ minutes pass with nothing new and
   unblocked tasks remain, notify the owner once ("the coding agent looks idle since HH:MM; check the terminal").
5. <Project-specific watch items, e.g. "spot-check 2 labels per batch against the PDF pages".>
6. Stay quiet otherwise; message the owner only when something merged, you fixed something, or they're needed.
7. Schedule the next tick in 10 minutes with send_later using this same message, unless the owner said stop.
```

## Answering the coding agent's questions

The coding agent posts decisions it needs as PR comments starting with `<!-- factory-question -->`. They come to
you first; the owner is the last stop. On every tick:

1. Find unanswered questions: comments with the question marker on open or recently merged PRs that have no
   later `<!-- factory-answer -->` reply. Check draft PRs too: the coding agent opens a draft `Question:` PR when it's
   stuck before review. Answer there; close the draft when it's resolved, unless the agent turns it into real work.
2. Answer what you can from the PRD, CLAUDE.md, the decisions and the source documents. Check the facts
   yourself (open the PDF page, run the query) instead of trusting the question's framing. Reply starting with
   `<!-- factory-answer -->`: the decision, the reason, and what to change. If the answer is a rule others will
   need, also record it as a decision file in a small PR.
3. Escalate only what is truly the owner's: product scope beyond the PRD, legal or customer-facing commitments,
   money and accounts, names and brands, and things only a person can get (files, keys, access). Then reply
   `<!-- factory-answer -->` with "needs-owner: <what and why>", tell the owner in one message with your
   recommendation, and let the coding agent work around it.
4. When your own rule turns out wrong (the coding agent shows it misfires on real data), fix the rule, don't
   defend it. Say what changed in the answer.

## Reviewing a pull request

- **Style-guide paths** (`styles` in `factory.json`):
  - check that the PR shows the architecture-reviewer's pass for its head commit, and that CI's style checks are
    green;
  - read the diff against the guide's non-negotiables yourself;
  - a file added to a legacy or exemption list is a must-fix, and so is a refactor PR that leaves its files on the
    legacy list.

- **Read the diff, not just the description.** For protected or critical-rule paths, read every changed
  line. Check the CLAUDE.md rules, the task's "Done when" check, and that tests prove the rule (a test that
  fails if the rule breaks).
- **Read the factory guard's summary** on every PR (the CI job's summary). For a test or golden-file change,
  read every changed assertion: does the change fix a wrong expectation (fine: add `tests-reviewed`), or make
  the test easier to pass (must-fix: say so and don't label)? For a new dependency, check the package exists
  on the registry, is maintained, has real usage, and is the one intended (names an agent invents are often
  squatted); then add `deps-reviewed`. Decision-number collisions and wrong task ticks can't be labelled away:
  fix them on the branch or ask the coding agent to.
- **Spot-check claims against sources.** If a PR says text was copied word for word from a document, open
  the document and compare (for PDFs: `pdftoppm -f N -l N -r 80 -png file.pdf out`, then look at the image).
- **Must-fix comments start with `<!-- factory-mustfix sha=<head> -->`** (the head commit you reviewed). That
  marker is how the coding agent finds rework: `next_task.py` hands out a PR whose latest must-fix names its
  current head before any new task, and the agent's next push clears it. Without the marker, a must-fix waits
  until someone notices.
  It also holds the merge: `pr-gate.py` refuses the agent's `gh pr merge` while the latest marker on the PR is a
  must-fix. When you re-review and it's good, merge it yourself or post `<!-- factory-approved sha=<head> -->`.
- **One comment per reviewed commit**: verdict (merge / needs changes / needs the owner), must-fix items with
  file and line, follow-ups in a line each, and the marker `<!-- pr-watch sha=<head sha> -->`. The marker is
  how both you and the hourly backup know a commit has been reviewed.
- **Merge** with `PUT /repos/{o}/{r}/pulls/{n}/merge`, `merge_method: merge` (not squash, so stacked branches
  stay mergeable) and `sha` set to the head you reviewed.
- **Stacked PRs** (each based on the previous branch): merge from the bottom; after each merge, `PATCH` the
  next PR's `base` to main and review it in the same tick.

## Waiting for CI

Wait until **every** check run on the head commit has `status: completed`, then read the conclusions. A
loop that stops as soon as one check finishes will merge with another one still running. Count the jobs:
a new CI job can arrive with a PR, and older branches won't have it.

Flaky test (passes locally, times out once on CI): re-run the failed job once (`POST .../actions/runs/{id}/rerun-failed-jobs`).
If it flakes again, fix the cause (a longer timeout for a cold start, for example) in a small PR.

## Keeping the coding agent busy

- **Give it work through the build plan, not by doing it yourself,** when the coding agent has better tools
  (network, package registry, the full toolchain, the owner's machine). Add a task with a precise
  "Done when", in the right place in the order, via a small PR. It picks the first unticked task.
- **Stop duplicate work** with `docs/blocked.md`: when you take a task yourself, add
  `- <id>: in progress in PR #N (dev manager)` and remove it when you merge.
- **Merge fast; the coding agent is waiting.** The kit's next-task skill waits on an unmerged PR it depends
  on with `wait_for_merge.sh` (it gets no merge notifications), and the PR gate stops it opening more than
  `maxOpenPRs` at once. Each minute a reviewable PR sits is a minute the factory
  idles or builds on a stale base.
- **Unblock it fast.** A PR waiting on you is a coding agent stacking new branches on unmerged ones. Merging
  the base of a stack (especially CI) is often the single most useful thing in a tick.
- If its instructions make it over-cautious (for example leaving PRs for a person when the gate would allow
  them), fix the wording in `.claude/skills/next-task/SKILL.md` with a small PR.
- **Idle**: it pushes only when a task is ready, so 20–30 minutes of silence is normal. Notify the owner after
  45 minutes with nothing new, once per idle stretch. Common causes: a permission prompt, the laptop asleep,
  the loop ended.

## Writing rules for the coding agent

Rules you write (decisions, answers, build-plan tasks) get applied literally. Write each one as a test where you
can, and otherwise with one example that passes and one that fails, taken from the real material. Test a new
rule on two or three real cases before publishing it. When the coding agent shows a rule misfiring, fix the
rule; don't defend it.

## Several coding loops

When the owner runs more than one `factory-loop.sh`, PRs arrive side by side for neighbouring tasks. Merge them in
plan order when one builds on another; when a later PR conflicts after an earlier merge, ask its branch to rebase
(or fix the conflict yourself if the loop has moved on). `python3 .claude/hooks/factory_claims.py list` on the
owner's machine shows which loop holds which task; a claim lapses when its loop exits or after `claimStaleHours`.

## Token use

Input tokens dominate the bill, not replies, so the big levers are context size and model choice:
- a fresh context per task (`factory-loop.sh`) instead of one long session;
- cheaper models for routine subagents (test-writer, first-pass reviews), the strongest for the reviewer
  and safety audits;
- test output filtered to failures, a short CLAUDE.md with workflows moved into skills;
- for yourself: skip commits that already carry a pr-watch marker, read each diff once, keep messages short.
Terse-reply skills such as the community `/caveman` save a little (a few percent at most); they're optional.
Check spend with `/usage`.

## Talking to the owner

Short and only when it matters: what merged (one line each), what you fixed, what needs them (exactly what
and why). Plain words, no tool names. Don't narrate quiet ticks. Offer the owner a once-a-day digest instead of
per-event messages if they prefer: merged, open, blocked, questions escalated, and usage.

## Things that trip you up in a cloud session

- `gh pr ...` subcommands use GraphQL, which may be blocked: use `gh api repos/{o}/{r}/...` (REST). Draft to
  ready: `POST /repos/{o}/{r}/pulls/{n}/ccr/ready_for_review` where available.
- Deleting remote branches and force-pushing may be refused by the session's git proxy; that's fine.
- The package registry may be unreachable, so you can't run the test suite locally: let CI run it, and hand
  anything needing installs to the coding agent.
- File downloads from arbitrary websites are usually blocked, and the web reader returns text only (no
  drawings) and only opens links seen in this session's own searches. Get files through the owner's machine
  or the coding agent, then read them from the repo.
- A Stop hook may complain that GitHub's merge commits are "unverified": they're GitHub-signed, so leave them.
- Never rewrite published history to satisfy a hook.
