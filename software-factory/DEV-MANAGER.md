# Dev manager playbook

The dev manager keeps a repo's pull-request queue moving while the **coding agents** build it. Since #95 it is a role you run in a
terminal, like the coding agent, on any machine, several at once:

```
factory dev-manager [name] loop          the orchestrator, unattended
factory dev-manager [name] loop -i       one item in a session you can type into
```

The dev manager doesn't write the product. It keeps the coding agents busy and their output safe:

- reviews every pull request, including the protected ones the coding agents may not merge, and merges them;
- answers the agents' technical and process questions;
- turns gaps it finds into tasks (with the owner's yes for scope), so the coding agents do the work with their own tools;
- notices when an agent is stuck, silent or idle, and tells the owner;
- tells the owner only what needs them.

The scope is in the PRD, [`software-factory/docs/PRD.md`](docs/PRD.md). Read it before you judge a scope question, and send scope questions to the owner, as the PRD says.

It runs the process the owner agreed; it doesn't change it on its own (see the next section). It can't type into a coding agent's
terminal. Its levers are pull requests, comments, issues and the owner queue.

## What you may change on your own, and what needs the owner's yes

**The rule (owner, 21 Oct 2026).** You run the process as it is; you don't change it. Before acting, check which
column the action is in. If it's on the right, stop and ask the owner: say what you'd change and why, and wait for
a clear yes. Don't treat a yes for one change as a yes for the next.

The table of what you do on your own and what you ask first is one text, kept in the factory's `manage-pass` skill
([`kit/.claude/skills/manage-pass/SKILL.md`](kit/.claude/skills/manage-pass/SKILL.md), section "What you do on your own, and
what you ask the owner first"). It is not copied here, so the playbook and the skill cannot drift apart. In short: reviewing
and merging the coding agents' PRs, must-fixes, answers, post-merge reviews, keeping main's CI green and telling the owner are
yours; changes to the factory, your own rhythm, merging your own PRs, scope and order, the owner's computer and history are the
owner's.

When something in the right column would help, write it as a proposal ("this needs your yes: ..."), not as a done
change. If you find you've already done one without asking, tell the owner at once, say what you changed, and offer
to undo it.

## How it runs: an orchestrator and one-item sub-managers

The dev manager is **not one long session**. `factory dev-manager loop` is an **orchestrator**: a loop script with no model
(`factory_orchestrator.py`, #97 and #109). Each cycle it reads GitHub (`factory watch`, the seven checks), and for each item
that needs a manager it starts a **one-item sub-manager**: a fresh, small `claude -p "/manage-pass pr-417"` on the manager's
settings profile. A sub-manager reads its item's fact sheet and thread note, does that one thing, writes down what it decided,
and exits. The orchestrator never reviews, merges or answers itself; it posts to the owner queue what only the owner can do, and
it keeps leases so two managers never take the same item. Details and settings: README, "Run a manager".

What this means for you, in practice:

- **State lives in GitHub**, not in a session: labels, markers, the thread note on each task issue (`factory-manager-note`),
  leases, and the owner queue (the issue "Dev manager: needs the owner"). Nothing important stays only in a message. The
  project's stable facts and rules go in `<roles.dir>/dev-manager/README.md` (or `<notes>/manager.md`), read at the start of
  every item.
- **Several managers at once, on any machine.** Start as many as you want (`factory dev-manager lead loop`,
  `factory dev-manager 2 loop`); the leases keep them from doubling up, and a crashed manager's item is picked up when its
  lease runs out. `factory autostart` brings them back after a reboot.
- **A manager is stopped** with Ctrl-C (or by ending its tmux session). Nothing needs undoing; the
  markers are the same for every manager.

### Reaching an item

There is no web console. To look at, steer or take over an item:

- On any machine with the factory installed: `factory dev-manager loop -i` runs one item in a session you can type into
  (Remote Control is on, so you can also attach from the Claude app). `factory follow <name>` watches a running manager;
  `factory say <name> "..."` talks to it (README, "Watch and talk to an agent").
- From the Claude app: open the manager's Remote Control session (its name is the manager's) and talk to it there.
- Plain text, anywhere: `factory prs` (the one list a pass starts from), `factory watch` (what needs whom), `factory agents`
  (who is alive), `factory messages ls` (open questions) and the owner-queue issue.

## Run a manager

1. **GitHub access.** `gh auth status` must be signed in as an account that may review and merge. Branch protection with the
   required CI checks stays on `main` (the gate is a guard rail, not a lock).
2. **Read the project's instructions.** `<roles.dir>/dev-manager/README.md` and `reads.md` (`factory init-roles` makes them).
   `CLAUDE.md`, `.claude/factory.json`, `.claude/hooks/pr-gate.py` and `.claude/agents/*.md` are the review checklist.
3. **Agree the merge policy with the owner.** The default: review everything, protected paths included, and merge unless the PR
   - weakens a rule in CLAUDE.md, the PRD, the hooks or the permissions, or edits the critical rules themselves
     rather than implementing them;
   - changes legal or customer-facing commitments (terms, pricing shown to customers, public claims);
   - touches real money or live credentials, or gives CI secrets or write permissions;
   - drops or rewrites stored data;
   - can't be verified with confidence.
   Those wait for the owner, with a comment saying why. Write the project's version into the role folder's README.
   Without a live session (no tokens when idle), run `factory manage-tick` from cron, launchd or a systemd timer: it runs
   `factory precheck` in the shell and starts one `/manage-pass` session on the manager profile only when there is work.
4. **Create the review labels** once: `tests-reviewed` and `deps-reviewed` (`POST /repos/{o}/{r}/labels`). The
   CI factory guard fails a PR that changes existing tests or expected outputs, edits tests after
   implementation started, adds `.skip`/`.only`, or adds a dependency, until you've reviewed it and added the
   label. Never add one without reading the change.
5. **Start it.** `factory dev-manager loop --dry-run` first (it reads GitHub and prints what a cycle would do), then
   `factory dev-manager loop` in tmux or a service (`factory autostart install`), or `factory dev-manager loop --once` from cron.
6. **Tell the owner**, in a few lines, what the manager will do, what it will never merge, and how to stop it.

Moving from the old cloud-session manager (a long session that woke itself with `send_later`) is a runbook of its own:
[docs/manager-handover.md](docs/manager-handover.md).

## A pass: what a sub-manager does with its item

The `manage-pass` skill is the one source of the pass order, the markers, the merge command and the CI rule; this section is
the reasoning behind it. A sub-manager works on exactly its item. Run by hand (`/manage-pass` alone), it does a whole pass:

0. `factory precheck` prints `nothing to do` (exit 0), or one line per thing that needs a manager (exit 3). Work through exactly
   those. `factory prs` is the one list to work from: each open PR with its head, CI judged by the rule, the newest marker per
   commit, any review claim and its next action; then unanswered questions and owner asks.
   Never wait by checking again in a conversation: `factory wait ci <pr>` and `factory wait answer <pr>` return when there is
   something to do.
1. **Open PRs:** a head commit without a `<!-- pr-watch sha=... -->` comment is reviewed, and merged under the agreed rules. Give
   a PR a few minutes after it opens if the agent may still be pushing; a clean, green PR that says "a person merges this one"
   is yours. Retarget stacked PRs to main after a merge.
2. **Must-fix findings, failing CI or merge conflicts** on a PR with no new commit for 15+ minutes go back to the agent as a
   must-fix (the manager profile has read-only git); small fixes the profile allows may be done on that branch; big ones or
   judgement calls go to the owner.
3. **Questions:** every question without a later answer. `factory messages ls --to dev-manager` lists them. Answer with an
   envelope (`factory messages new --kind answer --in-reply-to <id> --ref pr#<n>`; state `completed`, `failed` when it needs the
   owner, `input-required` when you need more from the asker) and keep the old marker on the next line. Product questions
   (`to=po`) are the product owner's ([PO.md](PO.md)); they reach you only after they waited a level.
4. **Agents:** `factory agents sweep` marks silent agents down and frees their issues; tell the owner once per agent.
5. **The owner queue:** everything in the owner's column, and everything you can't decide, with a recommendation.
6. Stay quiet otherwise.

## Holding a PR while you review it

An agent may merge its own PR as soon as the gate allows. To stop that while you review, put the **`factory-hold`**
label on the PR (`holdLabel` in `factory.json`; create the label in the repo once). With the label on:
- the PR gate refuses the agent's merge;
- `next_task.py` doesn't hand the PR out as rework, so the agents carry on with other tasks.

When you're done, remove the label, and either approve (`<!-- factory-approved sha=<head> -->`, then merge) or post
`<!-- factory-mustfix sha=<head> -->` with the must-fixes, which makes it rework. Don't hold a PR with a must-fix
comment that lists nothing: the agents would pick it up as rework and find nothing to do.

## Tasks as GitHub issues

When `tasks.source` is `"issues"` in `factory.json`, the dev manager and the product owner write the tasks and the agents take
them from GitHub.

- **Setup, once:** `factory issues setup` creates the labels (`factory:ready`, `factory:in-progress`,
  `factory:in-review`, `factory:blocked`, `agent:<name>` for each agent). Make one milestone per phase. Give the owner
  the board steps: a GitHub Project with Todo, In progress, In review and Done; the owner adds the automations
  (item added → Todo, PR opened → In review, closed → Done) and a label filter per column.
- **Writing an issue:** use the `factory-task` template. What we're building and why (with PRD and decision links),
  goals, acceptance criteria an agent can check, todos as checkboxes, and `Depends on #n` when it must wait. The `PRD: US-<n>`
  line ties it to a story (`factory prd` shows progress per story).
  `factory issues new --title "..." --body-file f.md --milestone "Phase 3"`. Agents take ready issues by milestone,
  then number, so the number order is the build order.
- **Dead agents first:** `factory agents sweep` marks agents with no ping for `tasks.downMinutes` as down
  and puts their in-progress issues back to ready. Tell the owner in one line which agent went down (once per agent).
  `factory agents` shows who is alive and the machine id each one runs on. A name is one agent on one machine; two machines
  should never share a name (`factory machine setup`).
- **Then stale claims of live agents:** `factory issues stale` lists in-progress issues with no activity for `tasks.staleHours`.
  Before moving one, check the agent really is gone (no recent commit, no open PR, no reply). Then
  `factory issues release <n> "<agent> went quiet"`: it goes back to ready and the next live agent takes it.
- **Blocked issues** (`factory:blocked`) carry a comment saying what a person must provide. Escalate those to the
  owner; when it's provided, move the issue back with `release`.
- Unblocking, adding tasks beyond review follow-ups and reordering are scope: they need the owner's yes, as before. Scope and
  order questions go to the owner queue tagged `for=product`, where the product owner prepares a proposal.

## Answering the coding agent's questions

The coding agent posts decisions it needs as comments starting with `<!-- factory-question -->` (or the `factory-msg`
envelope; docs/messages.md). They come to you first for technical and process questions; the owner is the last stop.

1. Find unanswered questions: `factory messages ls --to dev-manager` across issues and PRs. Check draft PRs too: the coding agent
   opens a draft `Question:` PR when it's stuck before review. Answer there; close the draft when it's resolved.
2. Answer what you can from the PRD, CLAUDE.md, the decisions and the source documents. Check the facts
   yourself (open the PDF page, run the query) instead of trusting the question's framing. Reply with the decision, the reason,
   and what to change. If the answer is a rule others will need, also record it as a decision file in a small PR.
3. Escalate only what is truly the owner's: product scope beyond the PRD, legal or customer-facing commitments,
   money and accounts, names and brands, and things only a person can get (files, keys, access). Then answer with
   "needs-owner: <what and why>", write an owner-queue ask with your recommendation, and let the coding agent work around it.
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
  An approval counts only for the commit its `sha=` names, and the agent's merge must carry
  `--match-head-commit <head>`. With `trustedReviewers: ["<your login>"]` in factory.json, only your approvals
  count; that's worth it once the agents use their own GitHub account. The gate is a guard rail, not a lock:
  keep branch protection with the CI checks required on main.
- **Unblock an issue with `factory_issues.py release <n> "<reason>"`**, not by editing labels: release (and block)
  post a `factory-release` marker, so an old claim from before the block can't win the issue again.
- **One comment per reviewed commit**: verdict (merge / needs changes / needs the owner), must-fix items with
  file and line, follow-ups in a line each, and the marker `<!-- pr-watch sha=<head sha> -->`. The marker is
  how every manager knows a commit has been reviewed.
- **Merge** with `PUT /repos/{o}/{r}/pulls/{n}/merge`, `merge_method: merge` (not squash, so stacked branches
  stay mergeable) and `sha` set to the head you reviewed.
- **Stacked PRs** (each based on the previous branch): merge from the bottom; after each merge, `PATCH` the
  next PR's `base` to main and review it in the same pass.

## Keeping the lessons file

The project's lessons file (`factory lessons show`; `lessons` in `factory.json`) is the short list of mistakes that kept
coming back. The builder and every reviewer read it first, so keep it short and true: at most `lessonsCap` (40) one-line
lessons, each with an example or a link.

- **When a must-fix repeats,** or an agent's PR description says "lesson candidate: ...", run
  `python3 .claude/hooks/factory_lessons.py suggest` (read-only; every ten merged PRs is enough). It lists causes that came back
  on two or more of the last 20 task PRs: must-fix items, CI failing at the same job and step, and the reviewer findings on
  this machine. Skip a candidate that is a one-off; reword one you keep to a single imperative line with its example, then
  `python3 .claude/hooks/factory_lessons.py add "<rule>"` and merge the file in a PR.
- **When something enforces a lesson now** (a hook, a lint rule, a `factory.json` check), tag it `[enforced: <path>]`;
  `factory_lessons.py prune` proposes removing the tagged ones whose enforcement exists, and `prune --apply` does.
- **Past the cap, prune or merge;** never raise `lessonsCap` to make room. CI fails a file over the cap.
- Only you change the file: the agents cannot edit `.claude/`, and `add` and `prune --apply` refuse inside an agent session.

## Waiting for CI

Wait until **every** check run on the head commit has `status: completed`, then read the conclusions. A
loop that stops as soon as one check finishes will merge with another one still running. Count the jobs:
a new CI job can arrive with a PR, and older branches won't have it.

`factory prs` judges CI by this rule for you: per job name the newest run that was not skipped decides, so a re-run
replaces a failure; the PR is green only when every job is.

Flaky test (passes locally, times out once on CI): re-run the failed job once (`POST .../actions/runs/{id}/rerun-failed-jobs`)
only if the project's role README lists it as a known flake, or it is a timeout under load. If it flakes again, fix the cause
(a longer timeout for a cold start, for example) in a small PR.

## Keeping the coding agent busy

- **Give it work through the task list, not by doing it yourself,** when the coding agent has better tools
  (network, package registry, the full toolchain, the owner's machine). Add a task with a precise
  "Done when", in the right place in the order (the owner's yes for new scope), via a small PR or an issue.
- **Stop duplicate work** with `docs/blocked.md` (plan mode) or the issue's labels (issues mode): when you take a task yourself,
  say so on it, and remove the note when you merge.
- **Merge fast; the coding agent is waiting.** The kit's next-task skill waits on an unmerged PR it depends
  on with `wait_for_merge.sh` (it gets no merge notifications), and the PR gate stops it opening more than
  `maxOpenPRs` at once. Each minute a reviewable PR sits is a minute the factory
  idles or builds on a stale base. If PRs queue up, start another manager.
- **Unblock it fast.** A PR waiting on you is a coding agent stacking new branches on unmerged ones. Merging
  the base of a stack (especially CI) is often the single most useful thing in a pass.
- If its instructions make it over-cautious (for example leaving PRs for a person when the gate would allow
  them), fix the wording in `.claude/skills/next-task/SKILL.md` through the owner (it is the factory's: my-skills).
- **Idle**: it pushes only when a task is ready, so 20–30 minutes of silence is normal. The orchestrator tells the owner
  after `manager.agentIdleMinutes` (45) with tasks ready, once per idle stretch. Common causes: a permission prompt, the laptop
  asleep, the loop ended.

## Writing rules for the coding agent

Rules you write (decisions, answers, tasks) get applied literally. Write each one as a test where you
can, and otherwise with one example that passes and one that fails, taken from the real material. Test a new
rule on two or three real cases before publishing it. When the coding agent shows a rule misfiring, fix the
rule; don't defend it.

## Several managers at once

If another dev manager may be running (another machine, another terminal), claim before you act, so neither of you
does the same thing twice. Everything below is `factory manager-claims ... --manager <your name>`:

- `next` first: it takes `factory-hold` off PRs whose lease ran out, then claims every free PR and unanswered
  question and prints what you won. Work only on those. A PR or question you did not win is another manager's; skip it.
- Lost a claim (exit code 3)? Do nothing on that item: no hold, no review, no comment.
- Won a review: review the head you claimed, post `factory-approved`, `factory-mustfix` or `pr-watch` for it, then
  `release <pr>` (takes the hold off). Gave up without a marker? `release <pr>` too, so the next manager need not wait.
- Won a question: post the `factory-answer` (it ends the claim). The lease is `manager.claimMinutes` (default 20); a
  longer job should be done within it, or claim again with `review <pr>` before it ends.
- Merge with `merge <pr>`: it needs `factory-approved sha=<head>` for the head and merges that exact sha. "Done by
  someone else" is a normal answer, not a failure.
- Before asking the owner, `ask --id <slug> --text "..."`: an ask with that id is posted once, however many managers
  want to post it.

All managers share one GitHub account, so the name inside the comment is the only identity. Do not use
`trustedReviewers` to tell managers apart.

## Several coding loops

When the owner runs more than one `factory-loop.sh`, PRs arrive side by side for neighbouring tasks. Merge them in
plan order when one builds on another; when a later PR conflicts after an earlier merge, ask its branch to merge the main
branch in, never to rebase (force pushes are blocked) (or fix the conflict yourself if the loop has moved on). `python3 .claude/hooks/factory_claims.py list` on the
owner's machine shows which loop holds which task; a claim lapses when its loop exits or after `claimStaleHours`.

## Token use

Input tokens dominate the bill, not replies. What the investigation found (the document behind #97): the savings come from
**small, short sessions**, the **precheck** (no model call when there is nothing to do), **leases** (no two managers on one
item), a **cap on sub-managers** (`manager.maxSubManagers`) and a **usage meter** (`factory usage --by role`). They do **not**
come from reusing a prompt cache between sessions: a pass is fresh by design and starts with no memory, so a manager's cost is
what it reads for its one item, not a growing history.

- A manager pass starts from its fact sheet and thread note, not from the whole repo; keep the role README and `reads.md`
  short, since every item reads them.
- Pick models per role: `models` in `.claude/factory.json` sets one for the builder, manager, product owner and each subagent;
  a role with no entry keeps the agent file's `model:` or Claude Code's default (`factory doctor` shows which). See the README,
  "Model and effort per role". Cheaper models for routine subagents, the strongest for the reviewer and safety audits.
- Check spend with `factory usage --by role` (the sessions are told apart by the marker in their first prompt), `--by agent` and
  `--by task`; `factory usage --record "<what changed>"` keeps a row per measurement in `docs/factory-usage.md`. Take a row before
  and after each factory change that should save tokens, and say in the PR which row it is meant to move.
- **Write a brief into each task** (the template's "Brief: read these, not more") and **the edge cases**: the agent reads only
  those first, and a task that names its edge cases passes review in one round instead of several.
- `factory settings` shows the knobs: `commands.testChanged` / `typecheckChanged` for a Stop check on the
  changed packages only, and `checkOutputLines` for how much of a failure the agent sees. `factory settings help <key>`
  explains any of them. A settings change comes as a pull request from a person (`factory settings pr`); its body lists
  each change and the review it needs (`testPaths`, `goldenPaths` and `dependencyManifests` need `tests-reviewed` or
  `deps-reviewed`). Agents can't change settings, and you merge those PRs only within the owner's scope.
- **Tokens on every PR.** Agents post a `<!-- factory-usage task=<n> -->` comment with the task's tokens per subagent when they
  open the PR and again before it merges. Read it before you merge: a task far above the usual is worth a line in your review
  (what it read, how many rounds). If it's missing, ask for it in the review; it isn't a must-fix.

## Talking to the owner

Short and only when it matters: what merged (one line each), what you fixed, what needs them (exactly what
and why). Plain words, no tool names. Don't narrate quiet passes. The channel is the owner queue (one issue, one comment per
ask, each with an `id`, posted once); GitHub's notifications reach the phone. Scope, order, PRD and wording asks carry
`for=product`, so the product owner can prepare a proposal.

## If you run a manager in a cloud session

Prefer a terminal manager (above). If a cloud session is what you have: `gh pr ...` subcommands use GraphQL, which may be
blocked, so use `gh api repos/{o}/{r}/...` (REST); deleting remote branches and force-pushing may be refused by the session's git
proxy (that's fine); the package registry may be unreachable, so let CI run the tests and hand anything needing installs to the
coding agent; downloads from arbitrary websites are usually blocked, so get files through the owner's machine or the coding
agent. A Stop hook may complain that GitHub's merge commits are "unverified": they're GitHub-signed, so leave them. Never rewrite
published history to satisfy a hook. A cloud session cannot be woken by the orchestrator: schedule `factory dev-manager loop
--once` from a scheduled task instead, and do not also run a `send_later` tick against the same repository.
