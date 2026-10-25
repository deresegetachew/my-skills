# Handover: from the cloud-session dev manager to terminal managers

A runbook for moving the dev manager from one long cloud session (woken by `send_later` ticks and an hourly scheduled task) to
terminal managers (`factory dev-manager loop`), **without a gap and without losing state**. Steps 2 to 5 are the owner's: they run
on the owner's computer and change the owner's schedule. Steps 1 and 6 can be prepared by anyone. Every command below is run in
the project's folder on the machine that will run the manager.

What the new manager is: an orchestrator with no model that starts one-item sub-managers (DEV-MANAGER.md, "How it runs"). The
owner reaches an item with `factory dev-manager loop -i` on any machine with the factory installed, or from the Claude app
through Remote Control. There is no web console.

## 0. Before you start

```
factory version                  # the factory on this machine; `factory update` if the project pins a newer release
factory doctor                   # gh signed in, the manager profile resolves, role folders and reads.md paths exist
factory init-roles               # creates <roles.dir>/dev-manager/ and product-owner/ when missing (never overwrites)
```

## 1. Capture the state in GitHub

Nothing important stays only in a tick message or a session's memory.

1. **Print the snapshot from GitHub** (open PRs, tasks in progress and blocked, open owner asks, what needs a manager now, the
   agents, the numbers in use):

   ```
   factory handover snapshot > /tmp/handover.md
   ```

2. **Stable facts and rules** go in the role folder, so every manager reads them at the start of an item:
   `<roles.dir>/dev-manager/README.md` (or `<notes>/manager.md`): known flaky CI jobs, protected paths, decision and migration
   number rules, who the owner is (the login for owner-queue asks), the merge policy, and the rules learned the hard way
   (judge CI by the newest non-skipped run per job; re-run only a known flake or a timeout under load; merge with `sha=`;
   merge main into a branch but never rebase or force-push; decision and migration numbers clash across agents, so check main
   and the open task branches). Commit it in a pull request; the owner merges it (it is under `.claude/` or protected).
3. **Open asks the old manager made** (unanswered owner questions, the "don't re-ask" list) go to the owner queue, one comment
   each, starting `<!-- factory-owner-ask id=<slug> -->` (add `for=product` for scope, order and PRD questions). The id keeps it
   from being posted twice. The snapshot lists what is open now; compare it with the old manager's own list and add what is
   missing.
4. **Product context** that the old session held (the PRD discussion and its open numbering question, design canvases and their
   comments, decisions made in chat) moves to the project or the owner queue: see the product owner role (PO.md) and
   `<roles.dir>/product-owner/`. Make a checklist from the old session's history on the day; do not rely on memory.
5. **Artifacts**: for each artifact the roles need, check that the repo has a current copy (`factory artifacts status`); if not,
   pull it (`factory artifacts pull <url> <dest>`, or export by hand and `--from <folder>`) and review it. List its path in the
   role's `reads.md`.
6. **Check nothing is only in the old session**: its last tick message's state notes should now each be in one of the places above.

## 2. Dry run (owner)

While the cloud manager still works:

```
factory dev-manager loop --once --dry-run
```

It reads GitHub, prints what a cycle would do (items for sub-managers, items for the owner) and writes nothing. Compare it with
what the cloud manager does in its next tick: the same PRs, the same questions, the same owner items. Differences are bugs in the
checks or in the notes from step 1: fix them before going on. `factory watch` prints the same checks without the loop.

## 3. Shadow (owner)

One real manager next to the cloud manager, for a few passes the owner watches:

```
factory dev-manager lead loop -i      # one item at a time, in a session you can type into (Remote Control on)
```

The leases keep the two from taking the same item: a sub-manager takes a `factory-review-claim` / `factory-answer-claim` /
`factory-item-claim` first, and the earliest unexpired claim wins. While shadowing, the cloud manager must honour claims
(`/manage-pass` does). Watch it with `factory follow lead` or in the Claude app. Check `factory prs` and the owner queue after
each pass.

## 4. Cutover (owner)

Start the managers wanted, then, **with the owner's yes for each** (each changes the manager's own rhythm or the owner's
scheduled tasks):

1. Start the terminal managers: `factory dev-manager lead loop` in tmux or a service, and a second one on another machine if
   the PR queue is long (`factory dev-manager 2 loop`). To bring them back after a reboot: `factory autostart install` on each
   machine (it records which agents to start in that machine's own file; `factory autostart status` shows what it would do).
2. **Stop the cloud manager's `send_later` chain** (end that session's ticks).
3. **The hourly backup scheduled task** (`trig_01LeAQFva2b4Vvg8yqN6qyb2`): disable it, or keep it as a safety net the owner
   chooses. If kept, it must run `factory dev-manager loop --once`, not a manager session of its own.
4. The nightly security audit stays paused until the owner says otherwise.
5. The cloud session **stops managing**: it becomes the place to maintain my-skills and build factory features.

After the cutover, check after ten minutes: `factory agents` shows the manager, `factory prs` shows no PR waiting without a
reason, and `factory usage --by role` shows the manager's sessions and what they cost (`models` sets the model per role).

## 5. Rollback

Stop the terminal managers (Ctrl-C, or end their tmux sessions; `factory autostart uninstall` if boot start was turned on) and
re-enable the old schedule. The markers are the same for both, so nothing needs undoing: a review marker, an answer, an owner
ask or a lease written by a terminal manager is read by the cloud one, and a lease that is not renewed expires after
`manager.claimMinutes` (20).

## 6. Done when

The old session no longer ticks, the owner queue has every open ask once, the role folder holds the stable facts, and
`factory dev-manager loop --once --dry-run` prints `nothing to do` on a quiet repository. Record the result (what the owner ran,
what differed in the dry run, what the shadow passes did) in the pull request that closes #100.
