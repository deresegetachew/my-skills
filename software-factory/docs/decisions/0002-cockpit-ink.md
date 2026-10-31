# 0002: The cockpit's sidebar and views use Ink, bundled at release

Date: 31 Oct 2026. Status: accepted (the owner, in the session that runs the factory: "yes, let's go for it").
Amends decision 0001 (the cockpit on tmux) and PRD D1 and D13.

## Context

The cockpit (0001) is built from tmux plus a sidebar program that draws with terminal escape codes by hand. A first
live run on dev-pc (31 Oct) found bugs that a fake tmux couldn't show: wrong session states, names shown as
"down" that no machine runs, and `cockpit --prs` hanging off a terminal (#362). Most of the cockpit's code and most of
its bugs are in drawing lists, tables and layout and in reading keys. Its tests can only check that code through a
fake tmux or a real one.

Ink (React for terminals, used by Claude Code) gives layout, lists, input and redraw as components, and
`ink-testing-library` renders a component with fake data, sends keys and returns the screen as text in an ordinary
unit test, with no terminal and no tmux.

## Decision

1. **The sidebar and every view** (needs you, pull requests, tasks and PRD, CI, agents and machines, settings, health
   and releases, usage and lessons, and the command bar) are Ink components.
2. **tmux stays for what Ink can't do:** hosting each agent's live Claude Code session in a pane, switching to it, the
   cockpit's own server and prefix (`C-a`), and leaving with everything still running. A small number of real-tmux
   tests cover that part (#362).
3. **Ink, React and `ink-testing-library` are build-time dependencies only** (`software-factory/package.json`
   devDependencies, pinned: `ink` 8.0.0, `react` 19.3.1, `ink-testing-library` 4.0.0, `@types/react` 19.3.0). The
   release (`tools/build_release.ts`) bundles the cockpit UI with `bun build` into one JavaScript file in the
   archive. A project that installs the factory gets that file, no `node_modules` and nothing to install, so the
   runtime rule (Bun and Node built-ins only) holds for projects.
4. **Only the cockpit UI may import them.** `check_skills.ts` refuses an import of `ink` or `react` anywhere else.
   No other package is added this way without the owner.
5. **Views are tested with `ink-testing-library`:** each view renders from a fixed snapshot of factory data, at a
   narrow and a wide size, with and without colour. Keys are sent and the frame is checked.

## Consequences

- The PRD's D1 ("there is no new dependency") and D13 ("no npm package at runtime") get the exception above.
  CLAUDE.md says the same.
- Tasks, in order: the build and bundling (and the `check_skills` rule), the sidebar, the views, and #362 narrowed to
  real-tmux tests for the session part.
- The bundle must work offline and under `bun` alone, like the rest of the factory. `factory doctor` checks it's
  present and loads.
