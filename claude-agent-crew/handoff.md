# Handoff note

Write one at the end of a working session, before a known stop (usage limit, reboot), and on `/crew handoff`.
Save it as `.crew/handoff.md` in the project (git-excluded) and keep it under one screen. The next orchestrator
reads it first, then checks it against live state: notes go stale; `crew status`, `gh pr list` and the issues win.

1. **In flight:** each crew job (id, role, branch, state) and each open PR (number, state, what it waits for).
2. **Decided today:** the human's decisions, word for word where it matters, with where they are recorded.
3. **Waiting on the human:** open questions, one line each, with your recommendation.
4. **Known problems:** failing checks, flaky tests, quota or limit states, with their reset times.
5. **Next:** the next two or three tasks in order.
6. **Where things are:** design docs, review artifacts, logs.
