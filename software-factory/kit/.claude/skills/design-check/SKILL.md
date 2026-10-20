---
name: design-check
description: Compare a built screen with its design reference by taking Playwright screenshots at phone and desktop sizes, listing the differences and fixing them. Use for any task that builds or changes UI, when the project has design references (see CLAUDE.md).
---

# Design check

Arguments: `$ARGUMENTS`: the screen(s) to check.

1. **Find the reference** the project's CLAUDE.md points to (for example `design/screens/<Name>.html` and a
   rendered PNG). If there is none, say so and skip to step 6.
2. **Run the built screen** (the project's dev server or preview) with the same data as the reference.
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
