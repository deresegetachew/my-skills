# Lessons

Short rules the builder and the reviewers read before they start. One line each, at most `lessonsCap` lines (40).
Each one has an example or a link. When a hook, lint rule or check enforces a rule now, tag it
`[enforced: path/to/check]` and `factory lessons prune` proposes dropping it. The dev manager changes this file:
`factory lessons suggest` proposes lessons, `factory lessons add "<rule>"` adds one.

