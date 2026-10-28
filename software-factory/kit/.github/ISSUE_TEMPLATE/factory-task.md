---
name: Factory task
about: One task for a coding agent. The dev manager writes these.
labels: ["factory:ready"]
---

<!-- Put every decision in this text. The agent also reads later comments by people (`factory issues show`),
     but the text is the one place that is always read first. -->

## What we're building

<!-- One short paragraph: what, for whom, and why now. Link the PRD story, design reference and decisions. -->

## Brief: read these, not more

<!-- What the agent opens first, so it doesn't explore: the PRD stories or sections by heading, the decisions,
     the design reference, the files and modules it will change, and what's out of scope.
     The PRD line names the stories this task serves, as `PRD: US-3, US-5` (one line): `factory prd` reads it to show
     progress per story. A task that serves no story says `PRD: none`.
     The Budget line is optional: the task's token budget, counting fresh input (input + cache writes) + output as
     `factory usage` reports them (for example 300k or 1.2m). Without it, `budget.builder` in factory.json applies, or
     none. It is advice, never a stop; the claim records it, and a coding agent may not change it. -->

- **PRD:** US-<n>
- **Budget:** 
- **Decisions:** 
- **Design reference:** 
- **Code:** 
- **Out of scope:** 

## Goals

- 

## Acceptance criteria

<!-- What a user, a test or CI can observe when it's done. This is the "Done when". -->

- 

## Edge cases

<!-- The inputs the reviewers and the safety auditor will try: other languages and scripts, punctuation,
     empty and huge input, page or line breaks, a second machine or agent. The test-writer covers these first,
     so the task passes review in one round. Leave empty if none. -->

- 

## Todos

- [ ] Failing tests first (test-writer)
- [ ] 
- [ ] Reviews: reviewer, plus whatever `factory reviews` lists

## Depends on

<!-- "Depends on #12, #14": agents skip this issue until those are closed. Leave empty if none. -->
