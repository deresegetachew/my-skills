---
name: study-notes
description: Bootstrap a new Astro-based study-notes/lesson site (component library, dark-mode theme, optional Gemini AI-tutor chat sidebar) and author individual lesson pages in it. Use when the user wants to start a note-taking/lesson app "like my other one", create a new study site, or add a lesson/note page to an existing one built with this system.
---

# study-notes

Bootstraps and extends a static Astro site for long-form study notes: one Astro
component per content shape (heading, code block, callout, quiz, diagram,
checklist, deep-dive), a JS-class dark/light theme, and an optional Gemini-powered
chat sidebar ("Rocket 🦝") that reads the current lesson as context.

## Bootstrap a new site

1. `npm create astro@latest <name> -- --template minimal --no-install` (or add to an
   existing Astro project).
2. Copy this skill's `assets/` into the target `site/src/`:
   - `assets/components/*.astro` → `src/components/`
   - `assets/layouts/LessonLayout.astro` → `src/layouts/`
   - `assets/styles/global.css` → `src/styles/`
   - `assets/data/lessons.ts.template` → `src/data/lessons.ts` (rename, edit entries)
   - `assets/astro.config.mjs`, `assets/tsconfig.json` → project root (merge if files
     already exist — key bits: `output: 'static'`, `@/*` path alias to `./src/*`)
   - `assets/package.json.template` → merge `"astro"` dependency + `dev`/`build`/`preview`
     scripts into the project's `package.json`
3. `AiTutor` needs no server/env vars — it calls the Gemini API directly from the
   browser and stores the user's API key in `localStorage`. Skip copying
   `AiTutor.astro` (and its `<AiTutor />` usage in `LessonLayout.astro`) if the new
   site doesn't want a chat sidebar. See `AI-TUTOR.md` before touching it.
4. Optional capture inbox (Chrome extension for saving web snippets into a
   module's `captures/` folder while browsing):
   - `assets/integrations/capture-inbox.mjs` → project root, as `capture-inbox.mjs`
     (sibling to `astro.config.mjs`, not under `src/`).
   - Add `import captureInbox from './capture-inbox.mjs';` and
     `integrations: [captureInbox()]` to `astro.config.mjs`.
   - Add `captures/` to `.gitignore`.
   - `assets/chrome-extension/` is loaded unpacked via `chrome://extensions`
     — not copied anywhere in particular, just point Chrome at it (or copy it
     alongside the project if the user wants their own copy to customize).
   - Skip all of this if the site doesn't want the capture workflow. See
     `CAPTURE.md` before touching any of it.
5. `npm install && npm run dev`.

## Add a lesson page

```astro
---
import LessonLayout    from '@/layouts/LessonLayout.astro';
import LessonHeader    from '@/components/LessonHeader.astro';
import LessonCallout   from '@/components/LessonCallout.astro';
import CodeBlock       from '@/components/CodeBlock.astro';
import LessonDiagram   from '@/components/LessonDiagram.astro';
import LessonChecklist from '@/components/LessonChecklist.astro';
import LessonQuiz      from '@/components/LessonQuiz.astro';
import DeepDive        from '@/components/DeepDive.astro';
import LessonMindMap   from '@/components/LessonMindMap.astro';
import SourceBadge     from '@/components/SourceBadge.astro'; // if the module mixes sources
import LessonCollapsible from '@/components/LessonCollapsible.astro'; // inline optional detail
import LessonToc       from '@/components/LessonToc.astro';       // long lessons: contents box at the top

// Large code strings go here, NOT inline in JSX (Astro brace-count bug on nested {}).
const myCode = `...`.trim();
const mindMap = `
# Title
## Section
### Point
`.trim();
---

<LessonLayout title="LN — Title">
  <LessonHeader num="LN" title="Title" subtitle="One-line hook." />
  <div class="lesson-content">
    <!-- content sections here -->

    <h2 class="lesson-heading">Checklist</h2>
    <LessonChecklist title="..." items={[ ... ]} />

    <h2 class="lesson-heading">Quick-check quiz</h2>
    <LessonQuiz questions={[ ... ]} />
  </div>

  <DeepDive sources="..." tensions={[ ... ]} questions={[ ... ]} pitfalls={[ ... ]} />

  <LessonMindMap content={mindMap} />
</LessonLayout>
```

## Required sections — every lesson, no exceptions

Every lesson page ends with all four of these, in this order, even short ones
and even when extending an existing lesson that lacks them (add the missing
ones while you're there):

1. **`LessonChecklist`** under an `<h2>` — actionable items drawn from the lesson.
2. **`LessonQuiz`** under `<h2 class="lesson-heading">Quick-check quiz</h2>` — 2–4
   questions testing the lesson's own content.
3. **`DeepDive`** — after the closing `lesson-content` div. `LessonHeader`'s
   breadcrumb always renders a "↓ deep dive" link, so a page without one has a
   dead link. Tensions, 1–3 hard questions with answers, and pitfalls.
4. **`LessonMindMap`** — just before `</LessonLayout>`, built from the lesson's
   headings.

Don't copy the shape of existing lessons blindly — older pages may predate this
rule. Check the finished page against this list before calling it done.

## Source badges (modules that mix sources)

When a module combines material from different places (e.g. course content and
your own notes), mark each section with `SourceBadge` inside its heading:

```astro
<h2 class="lesson-heading">Title <SourceBadge source="course" /></h2>
```

`source` is `course` | `mine` | `book`; edit the labels in `SourceBadge.astro`
per module (e.g. which book). Ask which source a section came from rather than
guessing. Single-source modules can skip badges.

- Save as `src/pages/lessons/NNNN-kebab-title.astro` → route `/lessons/NNNN-kebab-title`.
- Add the new entry to `src/data/lessons.ts` (`LESSONS` array) in the right position —
  `LessonLayout` derives prev/next nav from this list automatically. Don't add
  `LessonNav`, `ThemeHead`, `ThemeToggle`, or `AiTutor` manually; the layout renders
  them.
- Long lessons (roughly 6+ sections): put `<LessonToc />` first inside `.lesson-content`.
  `LessonLayout` already renders the floating quick-nav (`FloatingToc`) on every page.
- **Sharing components across modules:** each module keeps its own copy of the
  components (copied from `assets/` when the module was created). After adding or
  changing a component here, copy it into existing modules — in a repo with
  `scripts/sync-components.mjs`, run `npm run sync-components` (adds missing files,
  reports differing ones; `--force` overwrites).
- Full component prop reference (CodeBlock, LessonDiagram, LessonCallout,
  LessonChecklist, LessonQuiz, DeepDive, LessonMindMap, LessonCollapsible, SourceBadge):
  see `REFERENCE.md`.

## Course recap page — when a course (or module) ends

Write one recap page as the course's last entry (`num: '★'`), built as a hierarchy
of what was learned, not a list of lessons. Sections, in order:

1. **The one-sentence version**: the whole course in a sentence.
2. **In the course's words** (`course` badge): the course's own skills/goals → the lessons
   that teach them (table).
3. **Skill scorecard**: the course's skill areas, each with its lessons and a self-rating column.
4. **Knowledge map** (`<h2 id="knowledge-map">`): `<LessonMindMap content={map} inline height="600px" />`.
   Root = course, `##` = skill areas, `###` = concepts, `-` = one-line takeaways.
5. **How it all connects**: a `LessonDiagram` read bottom to top (building blocks → techniques →
   patterns), plus a table saying what each pattern is built from.
6. **One task through every step / principles**: one example carried through the whole stack,
   then the ideas that recur across lessons.
6b. **Choosing a design** (when the course offers alternative designs, e.g. prompt chain vs. workflow vs. agent):
   the side-by-side diagram, the questions that tell them apart, a compact table of running cost,
   cost of change (edit + verify) and testability, and the decision flowchart; link the full guide.
7. **Practice: every notebook**: an `OpenInColab` button per notebook in the course.
8. **What's next**, then the four required sections (checklist, quiz, DeepDive, modal mind map).

Keep the recap last in the course, and link to it from the start: put a "★ Course map" line linking to
`#knowledge-map` under the course on the contents page. In study-notes, the Udacity index adds
it automatically for any course with a `★` entry. The
course's first lesson gets an `info` callout, "Where this course is going", with the same link.
See it before you start, read it properly at the end.

## Runnable code: notebooks shown in lessons, opened in Colab

Code that readers should run or edit lives in **committed Jupyter notebooks**, not in
code strings inside lesson pages:

```
<module>/code/
├── run_notebooks.py       re-executes notebooks in place so saved outputs are real
├── requirements.txt       runtime + tooling (nbclient, nbmake, pytest)
└── course-1/4.4-…/x.ipynb one notebook per topic; code cells tagged for lessons
```

- **Show it whole, in one place:** `NotebookView` renders the notebook at build time, with its
  saved outputs, highlighted like `CodeBlock`. Import the notebook with `?raw`. Put it in one
  "run it yourself" section with a short numbered list of what the notebook contains; the
  notebook's own Markdown headings guide the reader. **Don't slice one program into cells
  scattered across a lesson**: readers found that confusing. (`cells={[...]}` exists for a
  rare single-cell excerpt; an unknown tag fails the build.)
- **Run it:** `OpenInColab` (also built into `NotebookView` via `path`) opens the
  committed notebook in Colab, which works on phones too. Colab can't be embedded
  (`x-frame-options: DENY`), so it's always a new tab.
- **Notebook setup cell** (first code cell, tags `setup` + `needs-llm`): use Colab's built-in
  models directly, no API key and no helper file:
  ```python
  from google.colab import ai
  print("Available models:", ", ".join(ai.list_models()))

  MODEL = None                              # Colab's default; uncomment a line below to choose
  # MODEL = "google/gemini-2.5-flash"
  # MODEL = "google/gemini-2.5-pro"

  def get_completion(messages):
      prompt = "\n\n".join(f"{m['role'].upper()}:\n{m['content']}" for m in messages) + "\n\nASSISTANT:\n"
      return ai.generate_text(prompt, model_name=MODEL) if MODEL else ai.generate_text(prompt)
  ```
- **Cells that need Colab** (the setup cell, and every cell that calls a model) carry the
  `needs-llm` tag. Models only exist in Colab, so
  `run_notebooks.py` skips these cells and keeps their saved outputs: results from a Colab run
  saved back to GitHub are what the lesson shows. Everything else (models, gates, routing,
  gate tests) must run without an LLM.
- **No scripted/fake LLM replies.** Demonstrate gate behavior by calling the gates directly
  with bad outputs; demonstrate the chain with a real model.
- **"Open in Colab" only on runnable notebook code** (`NotebookView` with `path`). Prompt
  templates, pseudocode, partial snippets, sample outputs and shell commands stay
  `CodeBlock` without a button: in Colab they'd be broken or meaningless.
- **Keep outputs honest:** after editing a notebook, run
  `code/.venv/bin/python code/run_notebooks.py` before committing.
- **`CodeBlock` stays** for short snippets that aren't meant to be run.
- **Site config:** `src/data/site.ts` holds the GitHub repo, branch and module folder
  (`assets/data/site.ts.template`); Colab links are built from it.
- **Requirements:** the `notebookjs` npm package and Node ≥ 22 (it `require()`s an ES
  module). Pin Node with an `.nvmrc` and use it in CI (`node-version-file`).
- Course-provided notebooks (third-party, may contain keys) never go here; keep them
  in a gitignored folder.

## Style exhaustion rule — follow before writing any CSS

In this order, before adding a class or `<style>` block:
1. Headings — `<h2 class="lesson-heading">` / `<h3 class="lesson-heading">`.
2. Prose — `<p>`, `<ul>`, `<ol>`, `<strong>`, `<em>`, `<code>`.
3. Tables — `<div class="lesson-table"><table>…</table></div>`.
4. The components above.
5. Existing global classes in `global.css` (`lesson-content`, `callout-*`, etc.).

Only then add a scoped `<style>` block, at the bottom of the file, classes prefixed
by the lesson number (`.l25-phase-def`, not `.phase-def`). Never inline `style=`
except for data-driven dynamic values (e.g. `style={`width:${pct}%`}`). If a new
style is reusable across lessons, put it in `global.css` instead.

## Curly braces in JSX

Any `{...}` in the template — even inside `<code>`/`<li>`/`<p>` — is parsed as a JS
expression. Use `&#123;` / `&#125;` for literal `{` / `}`.

## Theme

Dark/light is a `.dark` class on `<html>`, persisted to `localStorage('ai-theme')`,
toggled by `ThemeToggle`. CSS overrides use `:root.dark .selector` in `global.css` —
never `@media (prefers-color-scheme: dark)`. Any standalone page (own `<html>`, not
via `LessonLayout`) needs `<ThemeHead />` in `<head>` and `<ThemeToggle />` before
`</body>`.

## AI tutor sidebar (optional)

See `AI-TUTOR.md` for the Gemini chat sidebar: architecture, props, localStorage
keys, the `ai-sensei:focus` custom event for wiring new "ask AI" shortcuts, and the
modal-visibility bug to avoid (never `hidden` attribute on `#ai-key-modal` — use the
`.is-open` class).

## Capture inbox + Chrome extension (optional)

See `CAPTURE.md` for the web-capture workflow: the dev-only Vite middleware
that receives captures, the `captures/` file layout (`inbox.jsonl` +
`pending.jsonl` + `archive.jsonl`), and the Chrome extension itself. The
extension has no notion of lessons/chapters — it just drops selections/pages
into `captures/pending.jsonl` for whichever module's dev server is running.

**When working in a module that has a capture inbox** (its `astro.config.mjs`
registers `captureInbox()`), check `captures/pending.jsonl` for that module —
proactively when starting a nontrivial authoring session there, and always
when explicitly asked ("check the inbox", "check captures"). If it has
entries: summarize what's pending (source, snippet) and ask where each one
belongs before writing anything — a module's content structure (which
chapter, which file) isn't something to guess. For whatever the user says to
keep, draft the corresponding content using the existing component set and
this file's conventions (curly-brace escaping, style-exhaustion rule), then
move consumed entries to `captures/archive.jsonl` (leave discarded ones out of
both `pending.jsonl` and `archive.jsonl` — just drop them). `inbox.jsonl` is a
permanent log and is never edited.
