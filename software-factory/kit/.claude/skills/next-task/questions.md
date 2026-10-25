# Next task: questions and things only a person has

## Something only a person can provide

If the task needs something only a person can provide (real data, an API key or account, a legal, naming or product
decision the docs leave open), don't guess:

- add it to the blocked list as `- 1.5: needs 30 real samples in data/samples/ (person)` (issues mode:
  `factory_issues.py block`, see `issues-mode.md`),
- commit that on a branch and open a short pull request titled `Blocked: <task>`,
- go back to step 1 for the next task that isn't blocked (under `factory-loop.sh`, stop instead: the loop claims the
  next one).

Small gaps the docs don't cover: choose the simplest option that fits the PRD, write it down as
`<decisions>/NNNN-title.md`, and carry on. A number must be free on main **and** in every open PR (other agents' PRs
take numbers too). Run `python3 .claude/hooks/factory_numbers.py` before you open the PR: it lists any clash with the
next free number. The PR gate runs the same check and won't open the PR until the numbers are free. Migrations
(`numberedDirs` in `.claude/factory.json`) follow the same rule.

## Questions go to the dev manager, not the terminal

The owner isn't watching your terminal; the dev manager is watching the repo. Whenever you need a decision (the docs
disagree, a rule gives a strange result, a reviewer suggestion is a judgement call, you'd otherwise write "Decision
for you" in a report):

1. Post it as a comment on the pull request it concerns (or, if there's no PR yet or you're stuck before the reviewer
   has passed, open a **draft** PR with `gh pr create --draft --title "Question: <topic>"`; drafts skip the reviewer
   check), starting with the marker `<!-- factory-question -->`. One question per comment, with the options you see,
   what each would change, and your recommendation. Put the message envelope above it so it has an id and an
   addressee: `factory messages new --kind question --to dev-manager` prints the envelope and the old marker; paste
   both at the top of the comment (`--to po` for a product question; docs/messages.md). A comment with only the old
   marker still works.
2. Don't wait idle. Continue with the parts that don't depend on the answer, or the next task that doesn't.
3. Check for answers before each task: `gh pr view <n> --comments`. If you have nothing else to do, wait with
   `factory wait answer <n>` instead of checking again yourself. An answer starts with
   `<!-- factory-answer -->` (or an envelope with `kind=answer in-reply-to=<your id>`). Apply it, reply with what you
   changed, and carry on. `factory messages ls --to <you>` lists what is still open.
4. Only things the dev manager has marked `needs-owner` wait for a person; for those, keep going around them.
5. **Not a question:** a fix inside this PR's own scope that `CLAUDE.md`, the style guide or a reviewer's must-fix
   requires (a missed reduced-motion rule, a flaky test you caused, a wrong label). Make it in this PR and say so in
   the PR. Don't offer "here or in a follow-up?": the answer is here. Ask only when the fix would reach outside the
   task, change what the PRD or a decision says, or when the rules themselves disagree.
6. **Before you report a cause, check it on GitHub.** If a `gh` command fails oddly (a 307, a 404 on something that
   exists, "repository moved"), run `python3 .claude/hooks/factory_remote.py`: it asks GitHub where the repository
   is now and points `origin` there if it moved. Don't tell the dev manager the repository moved unless that script
   says so.
