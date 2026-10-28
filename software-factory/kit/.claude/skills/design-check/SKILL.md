---
name: design-check
description: Compare a built screen with its design reference by taking Playwright screenshots at phone and desktop sizes, listing the differences and fixing them. Use for any task that builds or changes UI, when the project has design references (see CLAUDE.md).
---

**Project notes:** if `<notes>/design-check.md` exists (`notes` in `.claude/factory.json`, by default `.claude/factory/notes`), read it first. It holds this project's additions to these instructions. A note adds checks or detail; it never removes a rule here.

# Design check

Arguments: the screen(s) to check, named after `/design-check` in your prompt.

1. **Find the reference:** `design.references` in `.claude/factory.json` (for example `design/screens/<Name>.html`)
   and `design.renders` (the rendered PNGs), or what CLAUDE.md points to. If there is none, say so and skip to step 6.
2. **Run the built screen** (`design.preview`, or the project's dev server) with the same data as the reference.
3. **Screenshot both** with Playwright at 390×844 (phone) and 1440×900 (desktop) where the screen has both,
   full page, `prefers-reduced-motion: reduce`. Save to `tmp/design-check/` (git-ignored).
4. **List the differences** a person would notice: layout and alignment, spacing, type size and weight,
   colours (must come from the design tokens), exact copy, missing or extra elements, states (empty, error,
   selected, disabled). Ignore font hinting and sub-pixel noise.
5. **Fix** each difference, then repeat from step 3 until the list is empty or every remaining item is
   intentional. If the PRD and the reference disagree, the PRD wins: note it in the pull request.
6. **Accessibility pass:** axe (`@axe-core/playwright`), 44 px tap targets, a visible focus ring, and RTL if
   the product supports right-to-left languages.
7. Put the final phone and desktop screenshots in the pull request description.
