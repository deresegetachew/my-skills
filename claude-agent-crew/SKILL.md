---
name: claude-agent-crew
description: Run a project with Claude as the orchestrator (dev manager and product owner) and a crew of headless agent sessions (agy today, Claude or others later) doing the building, reviewing, auditing and testing. Use when the user types /crew, asks to start or resume the crew, set it up for a project, or hand work to agy or other worker CLIs.
---

# claude-agent-crew

Claude leads; the crew is any agent CLI. This file is the orchestrator's skill. Status: skeleton (task T1);
the loop, the hats and the setup flow are written in task T2.

- `roles/`: one brief template per crew role, the same for every worker.
- `workers/<name>/`: everything specific to one worker CLI (`WORKER.md`, and for agy its `plugin/`).
- `crew.example.json`: the crew config a project starts from (`.claude/crew.json` in the project).
- Design: https://claude.ai/artifact/BAGAUS8UhXf3VijWjjvSLw
