---
name: design-brief
description: Write the brief for any design work (a screen, a page, motion, a logo or a brand), run the rounds that follow and review them (customer reviews per customer group, blind glance tests, a visual critique, one combined score), so a design agent produces depth and character instead of safe, generic options. Use before starting or delegating design work, when reviewing or scoring designs, and whenever a design round is rejected. Skip for fixing a built screen against an existing reference (that is design-check).
---

**Project notes:** if `<notes>/design-brief.md` exists (`notes` in `.claude/factory.json`, by default `.claude/factory/notes`), read it first. It holds this project's additions to these instructions. A note adds detail; it never removes a rule here.

# Design brief

Weak design rounds usually come from the brief, not from the designer. A brief built from rules produces safe work, and a request for many quick options produces shallow work. Mock-ups of an unpolished product look unpolished. This skill fixes that.

## 1. Before writing the brief: is design the right next step?

- If the product the design shows is not good yet (a guide that mismatches its manual, a screen that doesn't work), fix the product first. A site or film can only show what the product does; every scene should be real product.
- **Original brand identity** (logo, logo animation, brand colour) goes to a human identity designer, with a brief written by these rules. AI design is used for product UI, motion, pages and drafts of identity ideas.

## 2. Settle the idea before any visuals

- For a brand or logo, agree on a brand **idea** with the owner first: what the brand stands for and how it should feel. Offer 3–4 ideas in words, each with a mood board (type, colour, a line of copy) and the kinds of logo it would lead to. Draw marks only for the chosen idea.
- For a screen or page, state the one job of the screen and the one thing the user should feel or do.

## 3. Write the brief in this order

1. **The idea and the feeling,** in one or two lines. Example: "A person signs off what the machine drafted: warm, honest, a serious tool."
2. **Who it is for and the facts the work must carry.** Real features, real numbers and real limits only, from the PRD. **Demo content comes from the buyers:** the example products, brands and documents shown are the kind the biggest target customer groups sell, taken from the PRD or the business canvas (ask the product owner). Not whatever is easiest to draw.
3. **2–3 references at the bar,** with what to take from each. Use real products the owner names or approved, such as "how the logo is the product's action". If the owner gave none, ask for them.
4. **Where to work:** the real product or the real code with real data. No mock-up page of a product that already exists in code.
5. **One direction, carried all the way.** If options are needed, at most 3, each developed through every surface: the mark alone at 16 px, on dark and light, in use, in motion. Never "ten quick options". The one exception is a wide first round for a page, run as section 4 says.
6. **Hard constraints that are facts, and nothing else.** Examples:
   - a colour that has a safety meaning;
   - accessibility (WCAG 2.2 AA, 320 px wide, reduced motion);
   - no invented people, quotes, logos or stats;
   - made-up brands labelled Demo;
   - placeholders for what only the owner knows.

   Leave style (palette, type, layout, illustration) to the designer unless the project's design system already decides it.
7. **What "done" means, judged by using it:** on a phone, in motion, against the references. A screenshot alone is not done.
8. **What to send back:** the file or PR, one paragraph per direction, the designer's recommendation, and what still needs a human hand.

## 4. A wide first round, when the owner wants to choose

A wide round works only when every option is a different idea, not a variation. For a page:

- **Read good design guidance first,** as advice only (for example public front-end design skills). Never run their scripts.
- **Give each option its own world:** a material, a place or a metaphor from the product's real life, assigned by you so no two options share one. Ban the stock layouts (split hero, small label above the headline, card grids) by name.
- **Plan first.** Each designer writes a short plan file (the idea, the first screen, the one picture) before building.
- **Shoot and self-critique at least twice.** Each designer screenshots phone and laptop, lists what is weak and fixes it, two rounds or more.
- **Look at every shot yourself** before the owner does.
- **Show all options side by side** as screenshots on one canvas, numbered, so the owner picks by number.

The owner's picks then go through section 5 before any is built in full.

## 5. Reviewing a round: three reviews, then one score

People take in a page from its pictures, and a buyer gives it a few seconds. A review that reads the copy scores the copy. So run three kinds of review, each by fresh agents that did not build the work and are not told which option you prefer.

### 5.1 Customer reviews, one per customer group

- Take the customer groups from the PRD or the business canvas. Write one reviewer per group as a named role: who they are, what they sell, how many people, what they are afraid of. Include the roles that can say no (for example safety or compliance, support, brand) as well as the one who buys.
- Each reviewer gets the screenshots (phone first, then laptop) and the page. They answer the same questions for every option:
  1. What did I see at first look, and did I get it?
  2. Do I trust it? What raised or lowered trust?
  3. What confused or annoyed me?
  4. Would I press the button? What stops me?
  5. Do I believe the demo, and does it fit my products?
  6. Three changes.
- They say what they did not look at. They write in their own voice, not as a designer.

### 5.2 Glance test, blind, twice

- Make shrunken shots of the first screen only: laptop about 480 px wide and phone about 190 px wide. At that size small text can't be read, which is the point.
- Two reviewers, each a different busy buyer, open **only those images**: no HTML, no copy, no brief, no earlier reviews. Five seconds per image.
- Each scores every option on phone and on laptop, 1 to 10 for:
  - (a) the message lands without reading;
  - (b) the picture does the work;
  - (c) the next action is clear;
  - (d) calm, not crowded;
  - (e) I would keep scrolling.
- They also write what they thought the product was. A wrong guess is the most useful finding.

### 5.3 Visual critique

- One reviewer as an art director, from screenshots only (first screens at full size, full pages as contact sheets, one or two demo states).
- Scores 1 to 10 on phone and on laptop for: the picture carries the message, hierarchy, spacing and density, colour, type, craft of the illustrations, distinctiveness, consistency down the page.
- Lists layout faults by place, and says what could not be judged.

### 5.4 Combine and report

- Put each numeric review on a 0 to 100 scale and average them per option: both glance tests and the visual critique. The customer reviews are not scored; they decide what the fixes must protect (trust, safety wording, the demo).
- Report the scores, where the reviewers disagree, and the findings every option shares. When the scores are close, say so; do not name a winner the numbers don't support.
- A phone first screen that fails the glance test fails the option, whatever the laptop scores.

### 5.5 The fix round

Turn the shared findings into a short rules file for the first screen and give every builder the same one. Start from these and change any that this round's findings contradict:

- **The picture is the message:** it shows what the product does (for example the before, the after and one gesture joining them), on the phone too, not behind a tab.
- **The product picture is big:** full width on a phone, at least a third of the width on a laptop.
- **A phone first screen holds five things:** the headline, up to two lines on who it is for and what they get, the picture, one supporting line and one full-width button. Everything else moves down the page.
- **One background, one accent.** For example: no black fields, and a warning is calm and worded the same wherever it appears.
- **Cut decoration** that is not the product. For example, a demo brand never reads as the company's own name.
- **One main button,** the same colour everywhere.

Each builder proves the fix with new glance shots and a before and after count of the things on the first screen. Then run 5.2 and 5.3 again on the fixed pages to see whether the score moved.

## 6. Running the rounds

- **Review by using it.** Open it on a phone width and play the motion before judging. Check each hard constraint.
- **After a rejection, re-brief cleanly.** Write what was learned into a new brief and start a fresh round. Never layer patches on the rejected work.
- **When a round misses, look at the brief first.** Did it lead with rules? Ask for breadth without worlds? Lack references? Mock up an unpolished product? Fix the cause, not the output.
- **Colour or theme variants** of a chosen design are one page with a switcher, so the owner compares like with like.
- **Keep the brand's loud colour for brand moments,** and keep the product calm, unless the project decides otherwise.
- **Write decisions down** (the project's decision records) once the owner picks.

## 7. Checklist

- [ ] The idea and the feeling come first
- [ ] 2–3 references at the bar, with what to take from each
- [ ] Real product or real code, real data; demo content from the target customers
- [ ] One direction deep (at most 3, each complete), or a wide round with a world per option
- [ ] Only factual constraints
- [ ] "Done" judged by using it, on a phone and in motion
- [ ] Customer reviews per group, two blind glance tests and a visual critique, by fresh agents
- [ ] Scores combined and reported with the disagreements; the phone first screen passes at a glance
- [ ] Identity work goes to a human, or is marked as a draft for one
