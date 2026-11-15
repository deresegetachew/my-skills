# Builder round brief

Send this to the same builder agent every round, by resuming it rather than starting a new one. Keep it short: list what changes and why, and leave how to the builder.

---

Round `<N>` of `<page>`. Back up both pages as `*.r<N-1>.html`. Build from that backup with `tools/<page>-r<N>.py` and its check `tools/<page>-r<N>-check.mjs`, and put shots in `shots<N>`.

Last round: `<scores per role, average>` (or: "no review this round; owner comments only").

This round covers `<the owner's page comments | the (a) items from reviews<N>/*.md>`:
1. **`<What, where>`**. `<Who asked: owner comment or role>`. `<The change wanted. If wording is given, give it exactly.>`
2. …

Facts:
- Use only `<docs folder>` and these owner facts: `<list, each with its date>`.
- Where the docs are silent, keep a placeholder, and only on the details page.
- Report a claim → source list for every new claim.

Rules, unchanged every round:
- The home page stays at `<1,200>` visible words or fewer, counted as rendered.
- Never use these words: `<banned words>`.
- These phrases must appear exactly as counted: `<phrase>: <count>`.
- No invented numbers, people, quotes or legal facts.
- The scan stays clean.
- The check passes on every theme at 320, 390, 768, 1024 and 1440.
- The first screen fits on a phone.

Before reporting, look at your own 390 and 1440 shots.

Report briefly:
- item → fix;
- claim → source;
- the placeholders left;
- word count and page heights;
- the check result;
- anything you chose differently from this brief, and why.

Do not commit or publish.
