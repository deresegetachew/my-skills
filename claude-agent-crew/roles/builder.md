# Brief: builder

**Task:** <the change, and the check that proves it: the test or journey that must pass>
**Branch:** <branch>. Work only in your worktree.
**Read:** <the exact files to change, the design screen, and any earlier commit or `git diff` to start from>. Read
these, not the whole repo: every file a builder opens is re-read on each later step, which is what drains quotas.
**Constraints:** <the human's words, verbatim>
**Decided:** <settled names, interfaces, approach> · **Open:** <what you may choose; say what you chose>
**Stop when:** the change and its tests are in, the project's checks pass, the branch is pushed and the PR is open
(`gh pr create`, authenticated as `crew-writer` through `GH_TOKEN`) with a body that says: what changed, the checks run with counts, choices you
made where the brief left them open, and risks. Stop and report BLOCKED if the brief's premise is false or the change needs a decision.
**Report:** `Status:` line; `Conflicts with the brief` if any; files changed (one line each); checks run with counts.
