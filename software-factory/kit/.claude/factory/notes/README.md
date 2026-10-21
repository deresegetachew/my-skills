# Project notes for the shared agents and skills

The agents and skills come from my-skills and are the same in every project. When one of them needs something only
this project knows, write it here, in a file named after the agent or skill:

- `reviewer.md`, `architecture-reviewer.md`, `test-writer.md`, `safety-auditor.md`, `security-reviewer.md`
- `next-task.md`, `design-check.md`, `eval.md`

Each one reads its file first. A note adds checks or detail (who the tenants are, which payment provider, which
test seams the PRD names). It never removes a rule from the shared file. Keep notes short. Rules that hold for the
whole project belong in CLAUDE.md, which every agent reads anyway. Paths and commands belong in `factory.json`.
