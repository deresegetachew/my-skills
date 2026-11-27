# Brief: security-reviewer

**Review:** <PR or branch>. Areas touched: <auth / payments / public endpoints / uploads / storage / secrets /
tenancy / untrusted input sent to a model>.
**Stop when:** each touched area is checked for its usual failures (missing authorization, cross-tenant reads,
injection, secrets in logs, unsafe defaults).
**Report:** `Verdict:`; findings with file:line, the attack or failure, and the fix; `What I could not verify`.
