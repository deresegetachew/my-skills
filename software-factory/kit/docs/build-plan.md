# Build plan

Each task is sized for one pull request. "Done when" is the acceptance check, written so a reviewer can run
it. The PRD section in brackets is the source. Work top to bottom; don't start a phase before the previous
phase's "Done when" checks pass, unless the phase says it can overlap.

## Phase 0: the repo

- [ ] **0.1 Scaffold.** <Workspace, shared config, strict types, lint, format, test runner.> Done when
  `<install> && <build> && <test>` passes on a clean clone.
- [ ] **0.2 CI.** Install, typecheck, lint, test and build on every pull request and on pushes to the main
  branch. Done when a pull request shows the checks.
- [ ] **0.3 Local stack.** <Databases and services in Docker Compose, `.env.example`, one command to start
  everything.> Done when <the health check answers>.

## Phase 1: <the core thing the product does> [PRD §…]

- [ ] **1.1 <Task>.** <What to build, in one or two sentences.> Done when <an observable check>.
- [ ] **1.2 <Task>.** … Done when …

## Phase 2: <…>

- [ ] **2.1 <Task>.** … Done when …

## Before launch (not code)

<Things only a person can do: names, contracts, accounts, legal review.>
