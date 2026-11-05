# Reviewer agents for lesson pages

Two subagents check a lesson from the reader's side, before the user has to. Spawn each one with the Agent tool
(`subagent_type: general-purpose`). Paste the prompt below and fill in the `{…}` fields. Give it file paths to read,
not your summary of them: a reviewer that is handed your conclusions tends to confirm them.

Run the framing questioner **before drafting** and the first-time reader **after drafting**. The authoring process
in `WRITING.md` section 0 says when.

---

## 1. Framing questioner

Its job is to stress-test the mental model before any page exists, so structural problems get fixed while they
are cheap.

```
You are helping design a lesson page for a learner's study notes. You do not write the page. Your job is to ask
the framing questions that expose weak structure before anyone writes it.

Read these:
- The source material: {paths to captures / transcript / course page text}
- The learner's earlier lessons it builds on: {paths to prerequisite lesson files}
- The draft mental model (the chain of ideas the page will follow):
{paste the numbered mental model, one line per step, each with its "because"}

Then work through these questions and answer each one concretely, quoting the source where you can:

1. Driving question: in one sentence, what single question does this lesson answer? Does every step of the draft
   mental model serve it? Name any step that doesn't.
2. Hidden argument: where does the source move from one topic to the next WITHOUT saying why? For each jump, what is
   the real relation (cause, enabler, replacement, problem → solution)? Quote the source's transition words where
   they exist ("here the focus shifts", "for agentic workflows, instead…").
3. Missing "because": for each link in the draft mental model, can you finish "step N leads to step N+1 because…"
   from the source or from the earlier lessons? Mark every link you can't finish.
4. Steps of the same kind: is every step an action the reader takes, or is one of them really a conclusion that
   should be the link between two steps?
5. Claims that need evidence: which steps claim that something breaks, stops working, or follows? For each one,
   propose a concrete example (ideally using a system the learner has already built) that shows it happening.
6. Overloaded words and labels: which words cover two different things (for example "agent" as worker and as
   decider; "step" used for two numbered lists)? Which counts or shorthand ("the seven steps") would a first-time
   reader not understand at the point they appear?
7. Misreadings the source invites: which phrases will a careful learner take the wrong way ("replace each step with
   an agent", "generalize")? What does each actually mean?
8. Fair comparisons: if the lesson compares approaches, do they get the same goal, inputs and actions?
9. One running example: which single example could run through every step, and what does it look like at each step?

Finish with:
- The three weakest points of the draft mental model, most serious first.
- A revised mental model (numbered steps, each with its "because") if the draft needs one.

Be direct and specific. Don't praise the draft. Don't write lesson prose.
```

---

## 2. First-time reader

Its job is to read the finished draft exactly as the learner will: once, top to bottom, knowing only the earlier
lessons. It reports what it understood and where it got lost.

```
You are a learner reading a lesson page in your study notes for the first time. You know only what these earlier
lessons taught: {list of prerequisite lesson titles}. You have NOT seen the source material, and you don't know what
the author intended.

Read the page: {path to the built page, e.g. <module>/site/dist/lessons/<slug>/index.html, or the .astro source;
in the .astro file ignore imports, CSS and component markup and read only what a reader would see}.

Read it once, top to bottom, the way a learner would. Do not jump ahead to resolve confusion: note it where it
happens, then continue.

Report, in this order:

1. Explain-back. In 5–8 numbered sentences, explain the lesson's chain of ideas as you understood it, each step
   with the "because" that links it to the next. If you can't find a link, write "(no link found)" there.
2. Lost points. Every place you had to stop, re-read, or guess, with the exact sentence and why:
   - a term, label, count or abbreviation used before it was explained (quote it, and say where it was explained
     later, if anywhere)
   - a claim that something breaks, follows or matters, with no example showing it
   - a word or number that seemed to mean two different things
   - a section that seemed to come from nowhere, or that could swap places with a neighbour without anything breaking
   - a diagram or table you couldn't read without help
   - a sentence you had to read twice
3. Contradictions: places where the page says two things that don't fit together.
4. The three most confusing spots, most serious first, each with a one-line suggested fix.

Be literal and honest. If something was clear, don't mention it. Don't praise the page. Don't rewrite it.
```

---

## Using the results

- Compare the first-time reader's explain-back with the intended mental model. Every difference is a defect in the
  page, not in the reader.
- Fix structural problems (missing links, sections in the wrong order) by restructuring, then re-run the tests in
  `WRITING.md` section 1 on the whole page. Don't patch with a new callout.
- If the fixes were large, run the first-time reader again on the new version.
