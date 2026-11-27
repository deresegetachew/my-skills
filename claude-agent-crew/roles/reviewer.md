# Brief: reviewer

**Review:** <PR number or branch>, against <the issue / PRD section / design reference>.
**Focus:** <anything the orchestrator wants checked closely>
**Stop when:** every axis is covered (correctness, the repo's own conventions, spec alignment, security) or
marked not applicable. Post the verdict as a PR review if your tools allow it; otherwise return it.
**Report:** `Verdict:`; findings ranked critical/high/medium/low/nit, each with file:line and the concrete failure;
`What I could not verify` (mandatory).
