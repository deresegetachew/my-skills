---
name: eval
description: Run the project's evaluation set (golden examples with expected answers) and report quality and cost against the last baseline. Use after any change to prompts, models, AI agents, scoring or validators, before opening that pull request. Skip if the project has no eval yet.
---

**Project notes:** if `<notes>/eval.md` exists (`notes` in `.claude/factory.json`, by default `.claude/factory/notes`), read it first. It holds this project's additions to these instructions. A note adds checks or detail; it never removes a rule here.

# Eval

The settings are `eval` in `.claude/factory.json`: `command`, `baseline` (the file with the last accepted scores),
`metrics` (what to report) and `mustNotDrop` (for example `"warning recall stays 100%"`). If there's no `command`,
look in CLAUDE.md; if neither names one, say there is no eval yet and stop.

1. Run `command` on recorded model replies (live model calls only when asked; they cost money).
2. Read the report per example and in total, for each of `metrics`. Every `mustNotDrop` metric that got worse is a
   must-fix and blocks the pull request.
3. Compare with `baseline`. Call out every metric that got worse and explain why, or fix it. If the change
   is a real improvement, update the baseline in the same pull request and say so.
4. Paste the summary table into the pull request description.

The score that counts is the one CI computes (add the eval to CI as soon as it exists); the number you report
is a preview. Rules: never edit an example's expected answers to make a test pass; never weaken a check to pass the eval;
re-record model replies only when a prompt or model changed on purpose, and say so in the pull request.
