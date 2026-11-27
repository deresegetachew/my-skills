# Brief: auditor

**Audit:** <PR or branch>, which changes <the safety rule / gate / money / data that must never change>.
**The promise it must keep:** <one sentence>.
**Stop when:** you have tried to break it from every angle you can find and either found breaks or explain why
none exists.
**Report:** `Verdict:` safe / safe with changes / unsafe; each break as a concrete, reproducible case (input and
what goes wrong); the fix you would want; what the existing tests already cover.
