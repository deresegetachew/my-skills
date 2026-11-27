# Brief: reviewer

**Review:** <PR number or branch>, against <the issue / PRD section / design reference>.
**Focus:** <anything the orchestrator wants checked closely>
**Constraints:** <the human's words, verbatim> · **Decided:** <settled choices>
**Stop when:** every axis is covered (correctness, the repo's own conventions, spec alignment, security) or
marked not applicable. Post the verdict as a PR review if your tools allow it; otherwise return it.
**Report:** `Status:` line; `Conflicts with the brief` if any; `Verdict:`; findings ranked critical/high/medium/low/nit, each with file:line and the concrete failure;
`What I could not verify` (mandatory).
