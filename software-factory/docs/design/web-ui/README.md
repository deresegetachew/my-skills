# The web UI: the reference design

The owner's design for the factory's web UI (epic #420), reviewed with the owner on 6 Nov. The live canvas is
https://claude.ai/artifact/4kFxv7Lx746tHoDicoKFMC (the owner's; agents read this copy).

Read in this order:
1. `RULES.md`: the look, the palette rules, "calm", no commands on screen, preconditions for anything that removes or
   merges, the "Talk about this" box, the 12 legends.
2. `theme.css`: every colour as a variable, light and dark. The app uses these names exactly.
3. `Palette.dc.html`: the components (tabs, chips, buttons, cards, list rows, status dots) in both modes.
4. The screen for your task. Each `*.dc.html` file is one screen: HTML with inline styles, `{{holes}}` filled from the
   `renderVals()` at its bottom (sample data). `Sidebar.dc.html`, `Avatar.dc.html` and `HowItRuns.dc.html` are
   components the screens import with `<dc-import name="…">`.
5. `CommandMap.dc.html`: every `factory` command and the screen that covers it (for builders; not shown in the app).
   `PARITY.md` is the checked list (#446): one row per command in `factory help`, built, planned (with its task), or
   why it stays with the agents or the terminal. A new command gets its row, and a screen that ships turns its rows
   `built`; a test fails otherwise.

`canvas.json` places the screens on the canvas in rows: first launch, project setup, every day, talking and planning,
tasks and pull requests, product, running the factory, maintain and configure, phone.

What is sample data: names of PRs and tasks, counts, times, and anything written [PLACEHOLDER]. What is the design:
layout, wording, which actions exist, their confirms and preconditions, and the colour rules.
