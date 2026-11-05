# Writing lesson prose

Rules for the words on a lesson page: the order of ideas, the sentences, and the final check. Read this before
drafting or rewriting any lesson section. The rules come from four places: the reader's feedback on these notes,
Matt Pocock's writing skills (grounding), Vercel's writing guidelines (sentences, second-read test), and
riekelt's technical-writer skills (banned constructions, rewrite checks).

The reader is learning the material for the first time and reads each page once, top to bottom. Every rule below
serves that reader.

## 1. Plan before writing

Write these down in your working notes before the first sentence:

- **Prerequisites:** the concepts the reader already has, from earlier lessons (link them) or general knowledge.
- **New concepts:** every concept this page introduces, in the order the page will introduce them.
- **The chain of questions:** one question per major section, where each section answers the question the
  previous one raised. If two sections can swap places without breaking anything, the chain is missing a link.

For a lesson with three or more major sections, the chain becomes the roadmap callout at the top of the page
("How this lesson builds up": a numbered list of the questions, each with a one-line answer).

## 2. Ground every concept before using it

A concept is **grounded** when the reader already knew it, or an earlier block on this page explained it. A
sentence that leans on an ungrounded concept loses the reader, even if it contains no jargon.

- Introduce the idea and its name together: say what it is, then name it. Never use a term first and define it
  later.
- Keep a running list of grounded concepts while drafting. Before each block, check that everything it uses is on
  the list.
- If a block needs a concept nothing has grounded, either add a grounding block before it, or make the concept a
  prerequisite and link the lesson that teaches it.
- Labels you invent (level ②, stage 3, "the swap test") are concepts too. Ground them before the first reference.
- When several concepts share words (prompt strategy, prompt augmentation, prompt chaining), place them in one
  hierarchy and add a "names that sound alike" table.

## 3. Connect the sections

- Open each major section with a sentence that carries the previous section's subject forward ("Every agent has the
  same five components. What sets agents apart is…"). Do not open with a recap ("Now that we've covered…").
- When the course jumps between ideas without linking them, add the link as a `mine`-badged bridge section, with a
  worked example. The best examples are things the reader has already built.
- Each paragraph must change what the next paragraph can say. Ask of every paragraph: what does it give the reader
  that the previous one didn't? If you cut it, what breaks?
- End a section on its last fact. No closing sentence that explains why the section mattered.

## 4. Sentences

- **One claim per sentence.** Aim for about 20 words; split anything over 30.
- **At most one colon per sentence.** Never chain clauses with colons or semicolons ("X: Y, so Z: W"). Write two
  sentences instead.
- **Active voice with a named actor:** "your code fetches the data", not "the data is fetched".
- **Keep the condition with its claim.** "If your code fetches the data before the call, it's augmentation", not
  three short sentences.
- **Avoid staccato.** Three or more short sentences in a row read as choppy; merge them.
- **Keep articles** ("the agent", not "agent"), and avoid noun stacks longer than three words.
- **Second-read test:** read each sentence once at speaking pace. If you have to read it again, rewrite it by
  naming who does what, and what happens.
- **Read-aloud test:** read each paragraph aloud and rewrite what you wouldn't say to a colleague.

## 5. Words

- **One term per concept,** for the whole page and the whole module. Don't rotate synonyms. Use the course's term
  when it has one.
- Plain words: "is", "uses", "has", not "serves as", "leverages", "comprises".
- Spell out acronyms on first use: "retrieval-augmented generation (RAG)".
- A number or a named example beats an adjective: "4 tools", not "several tools"; "the weather API", not "external
  data sources".
- Don't use these patterns:

| Pattern | Example | Instead |
|---|---|---|
| Filler | "essentially", "basically", "note that", "in practice", "just", "really", "very" | Delete |
| Inflated adjectives | crucial, robust, fundamental, seamless, powerful | A number, a named property, or nothing |
| LLM vocabulary | delve, leverage, unlock, pivotal, nuanced, landscape, realm | The plain word |
| Importance announcement | "The key point is", "What matters is", "It's worth noting" | State the point |
| Not-X-but-Y | "This isn't a technical choice, it's an organizational one" | State the positive claim |
| Meaning sentence at the end | "That distinction matters." | Delete; end on the last fact |
| Recap opener or closer | "Now that we've seen…", "Overall…", "In short…" | Carry the subject forward, or end on the last fact |
| Trailing participle | "…, highlighting the need for X" | Delete the tail, or make X its own sentence |
| Easy/simple | "simply call", "it's easy to" | Describe what to do |

## 6. Headings

- A heading names the content as a noun phrase: "Two definitions of agent", "The agent-type spectrum".
- Question headings only for genuine questions the section answers in its first sentence (FAQ-style collapsibles,
  "Does agent-centric mean no flowchart?"). The roadmap and quizzes may use questions.
- The first sentence under a heading does not repeat the heading.

## 7. Format follows the content

- **Prose** carries an argument or explanation. **Lists** carry three or more parallel items. **Numbered lists**
  carry ordered steps.
- **Tables** only when items have two or more properties the reader compares across. A two-column table of prose
  is a list.
- **Diagrams** get one sentence before them saying what to look at ("Solid arrows are fixed; dashed arrows are
  what the agent may choose").
- **Callouts** only for an aside that would derail the main line if it were inline, or for the one rule the reader
  must remember from a section. More than one callout per section usually means the prose is weak.
- **Bold** marks the one phrase the reader must catch in a paragraph, never decoration. Bold-lead bullets
  ("**Term:** description") are fine when the terms are parallel.
- Emoji belong in diagram nodes only, not in prose or as bullet markers.

## 8. Examples and comparisons

- Prefer examples the reader has built (earlier exercises, the course project) over invented ones.
- When comparing approaches, give every variant the same goal, inputs and available actions, and say what differs.
- Keep course content and own notes apart with `SourceBadge`. When rewriting course material, don't add or drop a
  fact.

## 9. Final check

Run this on every page before calling it done:

1. Every concept is grounded before its first use, including invented labels.
2. The sections form a chain; the roadmap matches it.
3. Each sentence passes the second-read test; no sentence chains two colons.
4. None of the banned patterns from section 5 remain.
5. Which sentence still sounds like a language model? Rewrite it.
6. When rewriting course material, compare against the source: no fact added or lost.
