# Writing lesson prose

Rules for the words on a lesson page: the order of ideas, the sentences, and the final check. Read this before
drafting or rewriting any lesson section. The rules come from four places: the reader's feedback on these notes,
Matt Pocock's writing skills (grounding), Vercel's writing guidelines (sentences, second-read test), and
riekelt's technical-writer skills (banned constructions, rewrite checks).

The reader is learning the material for the first time and reads each page once, top to bottom. They come to these
notes to build a **mental model**: a set of ideas where each one rests on the ones before it. Every rule below
serves that reader, and section 1 is the one that matters most.

## 1. Map the mental model first (the core rule)

Before writing anything else, work out the chain of ideas the reader has to climb, step by step. Then put that
chain at the top of the page and build the page in exactly that order.

### Work out the chain yourself

Sources often present topics side by side without saying how they connect. A course may list two modeling methods,
or agent types followed by workflow patterns, as if they were separate. Finding the connection is your job, not the
reader's:

- **Find the relation between each pair of neighboring ideas.** Does one cause the next, enable it, replace it,
  or solve a problem the other creates? "Generalizing the workflow is why the modeling method has to change" is a
  relation. "Next, modeling methods" is not.
- **Write the link as a "because" sentence.** Step N leads to step N+1 because… If you can't finish the sentence,
  the chain has a gap. Find the missing idea, and add it as a `mine`-badged section if the source skipped it.
- **Show every break, shift or "therefore" with an example.** When a step says that something stops working, or
  that something follows, show it happening on a concrete case. "A flowchart can't capture run-time choices" is a
  claim. Three questions that take three different paths through the same assistant is the evidence. The reader
  needs the evidence.
- **Correct misreadings the source invites.** If the source's wording suggests the wrong model ("replace each step
  with an agent", "generalize"), say what it actually means and what it doesn't.
- **Prefer one example that runs through the whole chain.** Use the same system at every step, ideally one the
  reader has built, so each step visibly changes something the reader already knows.

### Put the map on the page

Every lesson starts with a section titled **Mental model**:

- A numbered list of the steps. Each step is one line: the idea, then the "because" that leads to the next step.
- A one-line short version ("known process → model it → build it → generalize it → the model breaks → model the
  agents → draw it").
- A diagram of the journey when the steps form a path or a hierarchy.

The rest of the page follows the map. Each major section matches one step, in the same order, and opens by naming
its step. The lesson's mind map has the same shape as the map.

### Test the chain before writing

- **Swap test:** if two sections could swap places without breaking anything, they aren't linked. Find the link,
  or admit that one of them is an aside and move it into a collapsible.
- **Forward-reference test:** if a section uses an idea that a later section introduces, reorder.
- **Interruption test:** an aside placed between two linked steps hides their link. Move it after the link, or into
  a collapsible.

### Plan the rest in your working notes

- **Prerequisites:** the concepts the reader already has, from earlier lessons (link them) or general knowledge.
- **New concepts:** every concept the page introduces, in the order the map introduces them.

The same rule applies to explanations in chat: lead with the map, then fill in the steps.

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
  "Does agent-centric mean no flowchart?"). The mental model and quizzes may use questions.
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
2. The page opens with a Mental model section; every link has a "because", every claimed break has an example,
   and the sections follow the map in order (swap, forward-reference and interruption tests pass).
3. Each sentence passes the second-read test; no sentence chains two colons.
4. None of the banned patterns from section 5 remain.
5. Which sentence still sounds like a language model? Rewrite it.
6. When rewriting course material, compare against the source: no fact added or lost.
