# Brief: security-reviewer

**Review:** <PR or branch>. Areas touched: <auth / payments / public endpoints / uploads / storage / secrets /
tenancy / untrusted input sent to a model>.
**Constraints:** <the human's words, verbatim> · **Decided:** <settled choices>
**Stop when:** each touched area is checked for its usual failures (missing authorization, cross-tenant reads,
injection, secrets in logs, unsafe defaults).
Post the verdict on the PR as `crew-reviewer` when your tools allow it; otherwise return it.
**Report:** `Status:` line; `Conflicts with the brief` if any; `Verdict:`; findings with file:line, the attack or failure, and the fix; `What I could not verify`.
