# Proposal for #397 (PR #402): text for protected skill files

Agents may not edit `software-factory/kit/.claude/skills/`, so the text is here, on the branch, for the owner to paste.
Apply it, run `bun tools/run_tests.ts product_owner`, then delete this folder in the same commit.

This covers the owner's added scope (comment on #397): items 1 to 4 below. It does **not** repeat the earlier
proactive-review text (product review step, notes rule, `ask=<slug> done`, the `status:` line); that is still in haile's
worktree on dev-pc (`tmp/product-pass.patch`, asked in #293 `pr-402-product-pass-skill`), and the first skill test in
`product_owner.test.ts` stays red until it lands.

Files covered: `software-factory/kit/.claude/skills/product-pass/SKILL.md` (A, B, D) and
`software-factory/kit/.claude/skills/manage-pass/SKILL.md` (C).

## A. product-pass: new section before "## Artifacts and designs"

```markdown
## Acceptance and user testing

A feature or design is not "done" in the progress report until you have used it.

- **When it runs.** The last task of a feature or design has closed (`factory prd --story <n>` shows no open task).
- **What you do.** Start the app locally (the way the project's role folder says), use it at phone and desktop sizes,
  and compare it with the design reference. Take screenshots at both sizes.
- **Report.** Tell the owner what you saw, with the screenshots and the reference beside them, and file a task per gap
  (`PRD: US-<n>`, "Done when" a test can check). Until then the feature is not "done" in the progress report: say
  "built, not accepted".
- **Whole-page task.** Cut every split design so its last task is "the page as a whole matches the reference": a test
  that the page's sections are exactly the reference's, plus side-by-side screenshots at phone and desktop sizes.
  Check that task exists in step 4 of the pass.
- **Daily pass.** Once a day, on main, walk the main user paths (the ones the PRD stories name) and report what is
  broken, one line each, with a task filed per break.
```

## B. product-pass: add to pass step 4 ("Keep things consistent"), one more sentence

```markdown
   Every split design has a last task "the page as a whole matches the reference"; if it is missing, file it.
```

## C. manage-pass: add to "## Never" (and, if the owner wants it earlier, to step 4 of the pass)

```markdown
- Never merge a UI pull request without screenshots: one that changes what a user sees (a screen, a page, a component, a
  style) attaches phone and desktop screenshots, with the reference beside them when the project has one. None attached:
  post a must-fix that asks for them.
```

## D. product-pass: add to "The pass order" as the last numbered step before "Tell the owner"

```markdown
   **Acceptance.** For every feature whose last task closed since the last pass, do "Acceptance and user testing" above.
   Once a day, also do the daily pass.
```

## Not in code

The screenshot rule is a skill rule only. The dev manager merges through the REST API, not through a command the
factory owns, so there is nothing for a code test to refuse; the skill test checks the text. If the owner wants a hard
refusal (a gate that reads the PR body or its files for images), that is a protected-file change and a new task.
