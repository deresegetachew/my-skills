# Role briefs

One template per crew role. Copy it, fill the blanks, save it to a temp file and pass it to `crew start --brief`.
The worker's own rules come from the project's CLAUDE.md (through AGENTS.md) and, for agy, the crew plugin; the
brief carries only the task.

Every brief has: **Task** (the outcome and how it is checked), **Constraints** (the human's words, verbatim),
**Decided** (settled choices; open ones marked open), **Stop when** (what done looks like, and when to stop and
report instead), **Report** (`Status:` line first, then the role's report).
