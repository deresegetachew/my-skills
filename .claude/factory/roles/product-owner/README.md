# Product owner: this project's instructions

The factory's `product-pass` skill says how a pass runs. This file is what is specific to this project: the product,
who it is for, the voice, what the owner decides alone, and where the PRD and the designs live (see `reads.md`).

- The product in one paragraph: the software factory (`software-factory/`): coding agents build a project task by task,
  a dev manager reviews and merges, a product owner keeps the PRD and the task list in order, and a project takes the
  factory as a numbered release. Its users are one owner running several agents on a few machines. This repo builds
  itself with its own factory (#112).
- The owner decides alone: scope and order (the PRD and #114), anything that changes what governs the agents (the PR
  gate, the guard, the agents' rules, `.claude/`), releases and tags, new dependencies (CLAUDE.md says none).
- Voice and wording rules: CLAUDE.md, "Writing for people": plain and short, sentence case, errors as
  `{code, message, fix}`, names that match the commands. No invented numbers.
- Where open product questions are asked (the owner queue): the issue "Dev manager: needs the owner" (#293), as an ask
  tagged `for=product`.
- Designs: the cockpit designs are a Claude Design canvas, linked from the issue that asks for them; the repo holds the
  reviewed text (PRD stories), not the pictures.
