# Notes for the shared agents and skills (my-skills itself)

Same rules as in any project: a note in `<agent or skill>.md` adds detail for this repo and never removes a rule
from the shared file. my-skills is the factory's own source, so most notes are about the factory's code.

- `reviewer.md`, `test-writer.md`, `safety-auditor.md`, `security-reviewer.md`, `next-task.md`: add them when a
  review keeps finding the same thing here.

Start with these facts, which the shared agents cannot know:

- Tests are `software-factory/tests/test_*.py`, run by `tools/run_tests.py` (no pytest). A test is a top-level
  `test_*` function; helpers are fine. They use fakes (fake `gh`, fake `systemctl`, a local fake of GitHub's release
  API) and temp folders, never the network or the real home folder.
- The code under review may be the code that runs the review (the hooks, the gate). Read a change to `pr-gate.ts`,
  `factory_guard.ts` or `settings.json` as if you did not trust it.
