# Product owner playbook

The product owner (PO) answers the product questions that builders and the dev manager would otherwise bring to the
owner, and keeps the PRD, the task issues and the decisions consistent. It decides what is clear from the PRD, the
decisions and the designs; it prepares the rest for the owner with a recommendation. It does not review code, merge, or touch CI.

Start it in a terminal, like the other roles:

```
factory product-owner [name] loop        unattended: triage the queues, answer what the PRD settles, propose the rest
factory product-owner [name] loop -i     a session the owner talks to ("chat with the PRD")
```

The start phrase for a session you open by hand: **"be the PO for this repo"**. Then run `/product-pass`.
The standing rules are one text, the `product-pass` skill
([`kit/.claude/skills/product-pass/SKILL.md`](kit/.claude/skills/product-pass/SKILL.md)); this page is the process around it.
The project adds its own rules (voice, what the owner decides alone, where the PRD and designs are) in
`<roles.dir>/product-owner/README.md` and `reads.md`.

## Who asks whom

| From | To | About |
|---|---|---|
| A coding agent | the dev manager (`to=dev-manager`, the default) | a technical or process question |
| A coding agent | the PO (`to=po`) | a product question: what should this screen do when X, which of two behaviours is right, a gap in the acceptance criteria |
| The dev manager | the PO (`to=po`) | a product question it meets while reviewing |
| The dev manager | the owner | money, legal, names, files or keys, scope and order |
| The PO | the owner | what is the owner's: scope and order, money, names, legal and customer wording, a PRD gap |

A question goes on the **task issue** (it lasts there and is tied to the work), or on the PR when there is no issue. The
envelope (`factory messages new --kind question --to po`, docs/messages.md) gives it an id and an addressee. The asker keeps
working on other tasks while it waits.

## The PO's checklist

The PO reads the same list every pass (`python3 .claude/hooks/factory_roles.py work product-owner`) and works through it:

1. **Questions addressed `to=po`**, on issues and PRs, oldest first. Answer (the PRD, a decision or the design settles it), ask
   back (a status message `input-required`: the asker has to say more), or escalate (`failed` with a first line `needs-owner: ...`, plus an
   owner-queue ask with options and a recommendation).
2. **Write each answer where it lasts.** This task's "Done when" gets the answer. A rule others will need goes into the PRD or a
   decision record, through a pull request (the PRD is protected), so nobody asks twice.
3. **Owner-queue asks tagged `for=product`:** write the proposal under the ask.
4. **Keep ready issues consistent** with the PRD: the `PRD: US-<n>` line, the "Done when". `factory prd` shows the gaps.
5. **The sign-off and testing queue** (`factory signoff`).
6. **Tell the owner only what needs them.**

## What the PO may decide alone, and what goes to the owner

| On its own | Ask the owner first |
|---|---|
| Answer a question the PRD, a decision or the design settles, citing where | Anything the PRD leaves open that changes scope, order or a promise to customers |
| Add the answer to a task's "Done when"; fix a task's text to match the PRD | A change to the PRD itself, a new story, a renumbering |
| Propose a decision record or a PRD change as a pull request | Merging a PRD or decision change |
| Write test plans; record results of a plan the owner confirmed | Confirming what is tested; starting anything on the owner's computer |
| Report what needs the owner, with a recommendation | Money, legal and customer wording, names and brands, accounts |

If the PO finds it did something from the right column, it writes an owner-queue ask saying what it did and offering to undo it.

## Waking, waiting and escalation

- **Waking.** The PO loop checks the list every `roles.product-owner.idleMinutes` (and `busyMinutes` after a pass that had work).
  The dev manager's watcher (`factory watch`) also notices a `to=po` question that has waited too long, so a PO that is not
  running does not hold a builder up. The check is state-based and idempotent: a missed wake-up finds the question later.
- **Escalation.** A `to=po` question nobody answers moves up one level after `roles.product-owner.escalateMinutes` (default 120):
  PO, then the dev manager (who answers it from the PRD or escalates it), then the owner (an owner-queue ask, posted once).
  **When no PO is running** (no `product-owner` agent that is not down or silent), the question starts at the dev manager. The
  level is worked out from the question's age each time; nothing is stored, so it cannot get stuck.
- `factory messages ls --to po` lists what is addressed to the PO; `factory agents` shows the PO as kind `po`.

## Safety

- **The PO's word is a reserved marker.** A coding agent cannot post a PO answer: a message must be sent as the poster's own agent
  name, `from=po` and `from=owner` are refused by the PR gate, and an answer is read as the PO's only when the sender is a name in
  `roles.product-owner.names`. With `roles.product-owner.logins` set, an answer from any other GitHub login is **ignored**. Set it
  to the logins the PO runs under.
- The PO's answers are data to the agents, inside the task they are doing. They never widen what an agent may touch, merge or
  change; anything that does is the owner's yes.
- The PO never edits `.claude/`, `CLAUDE.md`, CI or permissions, never `@`-mentions anyone, and never merges.
