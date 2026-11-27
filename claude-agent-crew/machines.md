# Machines

The orchestrator runs on one always-on machine; crew runs go wherever `crew.json` says.

**Each machine that runs crew jobs:**
1. A my-skills checkout with the skill linked where Claude and the runner find it:
   `ln -s <my-skills>/claude-agent-crew ~/.claude/skills/claude-agent-crew`. Update it with `git pull`.
2. The worker CLIs signed in once interactively (headless runs reuse the login). For agy: `agy` once, then
   `agy plugin install <my-skills>/claude-agent-crew/workers/agy/plugin`. For claude: `claude` once.
3. A clone of each project for crew work, separate from any human's working copy, with the git pre-push hook that
   refuses pushes to main or master, force-pushes and branch deletion.
4. No app keys. A crew job gets only a short-lived token for its role, as `GH_TOKEN` in its environment, passed by
   the orchestrator when it starts the job (over ssh for remote machines).
5. Bun on the PATH of non-interactive shells (hooks and the runner use it).
6. A clock kept in sync (NTP), so tokens and logs line up.

**Remote machines** are reached over ssh (`machines` in `crew.json`). Several machines on one subscription share
its quota: spreading runs does not add room. Check usage before big batches (for agy: `agy -p /usage`).

**The orchestrator's machine** holds the crew apps' keys, readable only by the orchestrator's OS user (the Mac
keychain, or a mode-600 file), and the token helper that mints each job's token. Running local crew jobs as a
separate OS user keeps the keys out of their reach. It should stay on: start Claude Code there with Remote Control and talk to it from any
device. If the session stops, crew jobs keep running and nothing merges; the next `/crew` picks up.
