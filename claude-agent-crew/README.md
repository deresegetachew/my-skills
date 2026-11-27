# claude-agent-crew

Claude, in one long-running Claude Code session per project, is the orchestrator: it decides, briefs, checks,
merges and talks to the human. A crew of separate headless agent sessions does the work, one role each, on
whichever worker and machine the project's crew config names. Only the orchestrator decides scope and merges.

```
claude-agent-crew/
├── SKILL.md              # the orchestrator: the loop, /crew and /crew setup
├── hats/                 # dev manager and product owner
├── roles/                # brief templates, the same for any worker
├── handoff.md            # what a handoff note holds
├── project-setup.md      # GitHub apps, the rule on main, AGENTS.md, crew.json
├── machines.md           # what each machine needs
├── crew.example.json     # the crew config a project starts from
└── workers/
    ├── agy/
    │   ├── WORKER.md     # how to run agy headless, read its result, its limits
    │   └── plugin/       # installed on each machine with: agy plugin install <path>
    └── claude/
        └── WORKER.md     # how to run claude -p headless with its own permissions
```

The full design, with diagrams, is at https://claude.ai/artifact/BAGAUS8UhXf3VijWjjvSLw.
