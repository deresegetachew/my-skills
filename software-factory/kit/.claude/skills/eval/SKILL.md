---
name: eval
description: Run the project's evaluation set (golden examples with expected answers) and report quality and cost against the last baseline. Use after any change to prompts, models, AI agents, scoring or validators, before opening that pull request. Skip if the project has no eval yet.
---

# Eval

The project's CLAUDE.md names the eval command, the baseline file and the metrics that must never drop
(for example "warning recall stays 100%"). If it doesn't, say there is no eval yet and stop.

1. Run the eval on recorded model replies (live model calls only when asked; they cost money).
2. Read the report per example and in total. Every metric CLAUDE.md marks as must-not-drop that got worse is a
   must-fix and blocks the pull request.
3. Compare with the baseline. Call out every metric that got worse and explain why, or fix it. If the change
   is a real improvement, update the baseline in the same pull request and say so.
4. Paste the summary table into the pull request description.

Rules: never edit an example's expected answers to make a test pass; never weaken a check to pass the eval;
re-record model replies only when a prompt or model changed on purpose, and say so in the pull request.
