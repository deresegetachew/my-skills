---
name: design-iterate
description: Take one chosen design (a home page, a landing page, a key screen) to a target score with a panel of buyer agents, the owner's comments on the live page and a builder agent that keeps working round after round. Starts by settling the business the page describes (a real customer story, a signed fact sheet, a panel by segment plus the end customer, pricing tested with costs, how the design reaches the real product). Covers the interviews to run before building, slogan tests, the skim review that stops the page filling with text, the round loop, reading the owner's page comments, noise and stop rules, and the page rules that held. Use after a direction is picked with design-brief, whenever the owner asks to "iterate until the reviewers score it above N", or when a design keeps getting reworked without the score moving. Skip for a first round of options (design-brief) or for checking a built screen against its reference (design-check).
---

**Project notes:** if `<notes>/design-iterate.md` exists (`notes` in `.claude/factory.json`, by default `.claude/factory/notes`), read it first. It holds this project's additions. A note adds detail; it never removes a rule here.

# Design iterate

`design-brief` gets you to a chosen direction. This skill takes that one direction to "done": buyers say they would start, and the owner is happy with it on their own phone.

It comes from a home page that took 25 rounds. Most of those rounds were lost to four mistakes:

- **Reviewers who read every word.** They rewarded text, so the page grew from 2,500 to 4,600 words while the score sat at 65.
- **Facts asked for too late.** The buyers' biggest questions needed facts that only the owner had, but they were only asked after 10 rounds.
- **Missed comments.** The owner's comments on the live page went unread, because page comments do not notify.
- **Noise read as signal.** One buyer's score swings by up to 8 points between two identical rounds, and small moves were treated as wins or losses.

After round 25 the page was rebuilt again, because the business under it changed:
- **The product grew.** It went from "assembly guide" to selling, building and after-sales.
- **The price changed four times:** plans, per product, traffic tiers, then one price.
- **Claims didn't match the PRD.** "Not built yet" items read as a roadmap, and auto-replies to comments promised features nobody had planned.
- **The page drifted from the real site.** The design page and the real site were edited separately, so every change was made twice.

That second half took as long as the first. Section A below would have prevented most of it.

## A. Settle the business before the page (do this first)

Design can't converge while what it describes keeps moving. Before round 1:

1. **One real story from the owner.** Ask: "Show me one real case where this went wrong for a customer: an email thread, a review, a return." One real thread (a broken part and ten emails over six weeks) reshaped the product more than ten review rounds. Keep it as the page's reference case.
2. **A one-page fact sheet, signed by the owner** (`references/business-fact-sheet.md`):
   - the value across the customer's whole journey, not only the first use;
   - the price model;
   - what is built, what is planned (PRD story) and what is not planned;
   - the data and privacy rules;
   - the promises: guarantees, liability, what happens if the customer stops paying or the company closes;
   - the headline.

   Every page claim must trace to this sheet or to a PRD story. If it can't, it doesn't go on the page.
3. **A panel by segment, not only by role.** Cover the main kinds of customer company (for example furniture, baby gear, fitness, appliances, marketplace sellers), plus **the end customer**. Roles inside one segment agree too easily; other segments and the end customer bring the asks that change the product: their helpdesk, the version per box, safety triage, "no app".
4. **Price it with the panel before the page** (`references/pricing-interview.md`):
   - Put 2–3 of the *simplest* models to the panel and ask for their real numbers: catalogue size, traffic, what they would pay, what makes them say no.
   - Work out the **cost per unit** (hosting per open, model calls per draft) before any limit goes on the price card. A worry about traffic cost can vanish with the right host, or kill the margin with the wrong one.
   - Expect buyers to reject meters and tiers they can't predict. The page shows one number when it can.
5. **Decide how the design reaches the real product.** Either the design page is the source and is ported into the app as a task, or the design is done in the app. Never edit both by hand.

Only then start the rounds. Doing A first, then the order below, would have finished in about 10 rounds instead of 30-odd and a week of rework.

## 0. Set up once

- **One page, one live link.** Publish every round to the same URL, so the owner's comments and history stay in one place.
- **One builder agent for the whole job.** Resume the same agent each round with a short brief (section 4) instead of starting a fresh one. It keeps the page's structure and the reasons behind it in its head.
- **Keep every round.** Each round backs up the page as `index.rN.html`, has a build script that rebuilds it from the previous backup, and has a check script (section 6). Each round also takes a shots folder: first screens at 1440 and 390, full pages, and contact sheets.
- **Store work outside scratch.** Commit each round to a branch in the project's repo. Scratch folders can be wiped by a restart; that cost one full round once.
- **Agree the target and the stop rule with the owner.** For example: average 90 or more; stop and report after 3 rounds that move the average by less than 3 points. If the owner says "keep going, don't ask", keep going, but still report the plateau each time.

## 1. The buyer panel

- Take five roles from the PRD's customer groups: the one who pays, plus the roles that can say no. For a B2B tool that is, for example, the owner, support lead, e-commerce manager, the person who makes the content, and operations. Keep the same five roles every round. For interviews (section 2) and pricing, add the other segments and the end customer from section A.3.
- **They skim; they do not read.** Use `references/skim-review-brief.md`:
  - they give the page about a minute: headlines and pictures first;
  - they open the details page only if something made them want to, and say why.

  A reviewer who reads every word asks for more words, and the page turns into a document. Real buyers skim.
- **One score:** "This page convinces me to start" out of 100, where 90 means "I'd start today". Below that, each reviewer lists what keeps them under 90 with its points, and marks each item (a) design or wording, or (b) needs a fact from the company.
- **Read the panel's average, never one score.** One reviewer moves by up to 8 points between identical rounds. Treat a change in the average as real only if it is over 3 points, or holds for two rounds.
- **Tell the panel what is settled.** When the owner confirms something that will exist at launch (company details, a contact), say so in the brief, so reviewers don't mark down its absence on a pre-launch page.
- **Fix the review method when it misleads.** For example, a full-page screenshot cannot show a section that pins while you scroll, so every reviewer saw an "empty block". Render that section as a static list for review shots only.

## 2. Interview before you build (round 0)

These interviews find, in one hour, the facts that design can't supply. Run them before the first build round. Use fresh agents in the same five roles, with no screenshots: they answer from the product description.

1. **Risk interview** (`references/interview-risk.md`). For each topic, ask what they need to hear to start, what would make them start today, and what is a dealbreaker. Topics: company, data use, liability, what happens if the company closes, proof, integrations. Also ask what score they would give if every answer went their way. If that score is below 90, the gap is the product, not the page.
2. **Value interview** (`references/interview-value.md`). Ask:
   - their top three outcomes;
   - what claim or picture would make them believe it without customer numbers;
   - the headline they would want.

   Ask about value in its own interview: a list of risk questions makes buyers talk only about risk.
3. **"Why" follow-ups.** When an ask surprises the owner (for example "why do they care about AI training?"), ask the panel why in one line each before arguing about it.

Turn the answers into **one fact list for the owner**, asked in a single batch. For each item, give:

- the question in plain words;
- a one-line example of what it means (owners misread "pilot offer" and "translated warnings" when they were given bare);
- the points it is worth.

Record each answer as a fact, with "owner, date" as its source. Some answers will be "no, and don't ask again". Write those down and move on.

## 3. Page rules that held

Start from these. Change one only when the owner or the panel contradicts it twice.

**Text**

- At most **1,200 visible words** on the home page, counted as rendered, including text inside demo devices.
- Everything else goes on a linked **details page**: every fact, limit, "not built yet" item and placeholder. **Never put a placeholder on the home page.**
- Each section gets a headline of 8 words or fewer, at most one line of 20 words or fewer, and a picture that carries the meaning. Think slides, not paragraphs.
- Benefits, not technology. "Interactive 3D, works on any screen", not "an iframe" or the hosting provider's name.
- An outcome with no proof is an aim: "Built to cut returns", never "Fewer returns".
- Limits are said once, in one "not built yet" list, not scattered across the page. Scattered limits make the page read as unfinished.
- Do not narrow the audience in the first screen (for example "for furniture brands") unless the owner chose that audience.
- A headline must be about what the buyer cares about. If the owner asks "do they really care about that?", the interviews in section 2 answer it.

**Structure**

- One "What you get" grid of equal cards: icon, a 3–5 word title and one line each. This works better than separate team blocks plus a promise strip.
- A story told in moments says who each moment is for, for example "You" and "Your customer".
- A demo is the product working:
  - an animation of the product doing its job;
  - a device that plays itself while it is in view;
  - languages cycling.
- Use a vertical list of demos with filter pills that scroll sideways, and a device of fixed size beside it.
- Secondary modes (for example a parts check) are a tab or step inside the device, not a toggle below it.
- No forms or calculators the buyer must fill in on a home page. An owner rejected one as "makes no sense".

**Phone.** The owner will look at it on their own phone, so design the phone first.

- The first screen is calm: headline, a short line, ticks, then the picture. Move buttons into the top bar if the screen is crowded.
- Warnings in a demo device are a one-line note over the picture that opens on tap, not a block that hides the product.
- A section that pins while scrolling becomes a carousel with Previous and Next buttons on phones.
- The picture is centred, and no gap between sections is taller than 160 px.

**Words: test them small**

- **Headlines and slogans: a two-round skim test** (`references/slogan-test.md`), not a full review round.
  - Round 1: 5–6 candidates, each scored out of 10. Each person says what the unclear word means to them and offers their own rewrite.
  - Round 2: the winners and the panel's rewrites, plus a sub-line.
  - Ten minutes, and the owner still picks.
- **Small wording goes through the owner's page comments:** change, publish, reply and resolve in one step. Don't bundle it into a round.
- If an auto-reply on a comment proposes wording, check it against the fact sheet before applying it. Auto-replies have promised unbuilt features.

**Honesty**

- Every claim maps to the fact sheet (section A) or a PRD story; anything else is marked "coming later" or cut. A "not built yet" list is not a roadmap: show only what the PRD plans, as "coming later", on the details page.
- No invented numbers, people, quotes, results or legal facts. A claim about laws or markets needs a source.
- Keep a claim → source list each round.
- Never raise a score by making the reviewers easier or the claims bigger.

## 4. The round loop

1. **Read the owner's page comments first.** They don't notify. Read every thread, including the ones a size cap hides (page through with the cursor).
   - If a comment is pinned to the whole page, ask which section it means.
   - The owner's comments outrank the panel.
2. **Brief the builder** with `references/builder-round-brief.md`:
   - what to change and where each comes from;
   - which sources to use for facts;
   - the word budget and the rules;
   - "look at your own phone shots before reporting".

   One round should take one set of comments or one review; don't mix in old items.
3. **Scan before publishing** with `references/pre-publish-scan.md`:
   - allowed hosts only;
   - no network calls, storage or forms;
   - banned words;
   - exact counts of required phrases.

   Then look at the 390 and 1440 first screens yourself.
4. **Commit, publish to the same link** (with the details page), then reply on each comment thread you acted on and resolve it.
5. **Review** with the five skim reviewers (fresh agents, in parallel).
6. **Sum up for the owner** in 2–5 lines:
   - a table of scores by round;
   - what you change next, from the (a) items;
   - what you need from them, from the (b) items, added to the fact list.
7. **A round that drops by more than the noise:** restore the best round as the base, and carry over only the changes that clearly added something.

## 5. When the score stops moving

- **A plateau means the design is done.** The points left are facts, product features or real proof. Say so plainly, with the fact list and the points each item is worth, and stop spending rounds on wording.
- **Check the method before the page.** Look for reading rather than skimming, screenshots that hide motion or pinning, and reviewers who weren't told what is settled.
- **Expect the ceiling.** A pre-launch page with honest limits and no customers lands in the mid-70s to high-70s with these panels. The interviews predicted the low-80s for a page that answers every fact. A real customer result is what moves it towards 90.

## 6. The check script

Each round's check runs the page in Playwright on every theme, at 320, 390, 768, 1024 and 1440. It asserts:

- what the owner asked for this round (exact wording, the order of sections, things removed stay removed);
- the word budget and phrase counts;
- the first screen fits at 390 and 1440;
- no gap between sections over 160 px;
- devices keep a fixed size between steps;
- animations run only while on screen, and stay still with reduced motion;
- carousels and tabs work by keyboard and touch;
- text contrast passes;
- no script errors and no requests to other hosts.

The check is only ever extended. When the owner changes a decision, change the assertion that guarded the old one.

## 6b. Keep the machine and the loop light

- The design loop (the page, its check, the review agents) runs alone. Don't run the product's factory, CI or builders on the same laptop at the same time. Load from those made test timeouts look like failures and slowed every round.
- Heavy builds and tests run on a server from the start, never "for now" on the laptop.

## 7. Checklist

- [ ] Section A first: the real story, a signed fact sheet, a panel by segment plus the end customer, pricing tested with costs worked out, and the route from design to the real product
- [ ] One page, one live link, one builder agent resumed every round, each round committed
- [ ] Target and stop rule agreed with the owner
- [ ] Five buyer roles from the PRD, the same every round, skimming rather than reading
- [ ] Risk and value interviews done before the first build; one fact list to the owner, with examples
- [ ] Home page at 1,200 words or fewer, details page for the rest, no placeholders on home
- [ ] Owner's page comments read in full every round; threads answered and resolved
- [ ] Scan and own look at the phone and laptop first screens before every publish
- [ ] Changes judged on the panel average, never on one reviewer
- [ ] A plateau reported as facts needed, not more rounds of wording
- [ ] Headlines by a two-round slogan test; small wording through page comments
- [ ] Every claim traced to the fact sheet or a PRD story
