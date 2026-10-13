# Component Reference

Full prop reference for the components in `assets/components/`. See `SKILL.md` for
the page skeleton and bootstrap steps.

## Component reference

### `LessonHeader`
Page header with breadcrumb (Blueprint → Lessons) and deep-dive anchor link.

```astro
<LessonHeader num="L3" title="Tool Design" subtitle="One sentence." />
```

Props: `num` (string), `title` (string), `subtitle?` (string).
Do **not** pass `sourceLabel`/`sourceHref` — removed.

---

### `CodeBlock`
Shiki-highlighted code block with macOS chrome and copy button.

```astro
<CodeBlock lang="typescript" label="my-file.ts" code={myCode} />
```

Props: `lang?` (default `"text"`), `label?` (default = lang), `code` (string).

**Token rule:** If the code string contains deeply nested `{}` objects (e.g. Anthropic tool schemas), define it as a `const` in the frontmatter and reference by name. Inline template literals with 3+ nesting levels of `{}` trigger an Astro brace-counting parser bug.

Supported langs: `javascript`, `typescript`, `bash`, `text`, `json`, and any Shiki-supported language.

---

### `LessonDiagram`
Mermaid diagram, rendered via CDN. Use `classDef` for coloured nodes.

```astro
<LessonDiagram definition={`
flowchart LR
  A["Step A"]:::step --> B["Decision"]:::decision --> C["Done"]:::done

  classDef step     fill:#dbeafe,color:#1e3a8a,stroke:#2563eb,stroke-width:2px
  classDef decision fill:#ede9fe,color:#4c1d95,stroke:#7c3aed,stroke-width:2px
  classDef done     fill:#dcfce7,color:#14532d,stroke:#16a34a,stroke-width:2px
  classDef warn     fill:#fee2e2,color:#7f1d1d,stroke:#dc2626,stroke-width:2px
`} />
```

Props: `definition` (string — raw Mermaid syntax, not HTML-escaped).

**Zoom viewer, built in:** every diagram gets a ⤢ button (clicking the diagram works
too) that opens it full screen with wheel/pinch zoom, drag to pan, Fit / double-click
to reset, and Esc to close. Nothing to configure. Still prefer readable inline
diagrams: long chains read better as `flowchart TB`, and decision nodes with long
labels stay compact as hexagons `{{"..."}}` rather than diamonds `{"..."}`.

---

### `LessonCallout`
Callout box. Four variants:

```astro
<LessonCallout variant="tip"  title="Optional heading"><p>...</p></LessonCallout>
<LessonCallout variant="warn" title="Watch out"><p>...</p></LessonCallout>
<LessonCallout variant="info" title="Context"><p>...</p></LessonCallout>
<LessonCallout variant="key"  title="Key idea"><p>...</p></LessonCallout>
```

Props: `variant` (`tip | warn | info | key`), `title?` (string). Body via `<slot />`.

---

### `LessonChecklist`
Interactive checklist (click to cross off). Items support inline HTML.

```astro
<LessonChecklist
  title="What you built"
  items={[
    'Stateful agent with file-based persistence',
    'Thread trimming — keeps last <code>N</code> turns',
    'Swap-ready storage layer for Postgres/Redis',
  ]}
/>
```

Props: `title?` (string), `items` (string[] — each item may contain HTML tags).

---

### `LessonQuiz`
4-option multiple-choice quiz (click to reveal answer + explanation).

Each question renders a 🦝 button. Clicking it dispatches `ai-sensei:focus` with the question + all options pre-formatted as the chat input. No extra props needed — built-in.

```astro
<LessonQuiz questions={[
  {
    q:       'Question text?',
    options: ['A', 'B', 'C', 'D'],
    answer:  0,        // 0-indexed correct option
    explain: 'Why A is correct.',
  },
]} />
```

Props: `questions` (array). Each question: `q`, `options` (4 strings), `answer` (0–3), `explain`.

**Options are shuffled at build time**, seeded by the question text (stable across
builds, different per question), and `answer` is remapped automatically — so write
options in any order, and never refer to an option by its letter in `q` or `explain`.

**Token rule:** Do not include `{}` in the `q` string — Astro parser misreads braces in JSX string attributes. Rephrase to avoid curly braces in question text.

---

### `DeepDive`
Collapsible senior/staff section. Renders tensions, questions with reveal, and pitfalls.

Each `DeepDive` renders a 🦝 button in its `<summary>` bar. Clicking it dispatches `ai-sensei:focus` with the section's tensions, questions, and pitfalls pre-formatted as the chat input. No extra props needed — built-in.

```astro
<DeepDive
  sources="l1_1.9"
  tensions={[
    { a: 'Supervisor clarity', b: 'Bottleneck risk' },
  ]}
  questions={[
    {
      q:      'Hard open-ended question?',
      hint:   'Steering prompt for the reader.',
      answer: '<p>HTML answer string. Use &#123; &#125; for curly braces.</p>',
    },
  ]}
  pitfalls={[
    'One-line pitfall description.',
  ]}
/>
```

Props: `sources?` (string), `tensions?` (`{a,b}[]`), `questions?` (`{q, hint?, answer}[]`), `pitfalls?` (string[]).

**Token rule:** `answer` is an HTML string rendered via `set:html`. Use `&#123;` / `&#125;` for `{` / `}` and `&lt;` / `&gt;` for angle brackets inside answers.

**JSX curly-brace rule (applies everywhere in the template, not just DeepDive):** Any `{...}` inside JSX — even inside `<code>`, `<li>`, `<p>` — is parsed as a JavaScript expression. To display a literal curly brace, always use `&#123;` for `{` and `&#125;` for `}`. This applies to inline text like `<code>&#123; key, value &#125;</code>` and to HTML strings passed as props.

---

### `LessonMindMap`
Modal mind-map overlay rendered from a markdown outline, via `markmap-autoloader`
(CDN, already wired into `LessonLayout.astro` — no per-lesson setup needed).
Injects a "◈ mind map" trigger button into the breadcrumb on mount.

```astro
const mindMap = `
# Tool Design & Structured Output
## Why It Matters
### LLM sees only name, description, schema
### Description = LLM contract
## Input Schema
### Per-property descriptions
### enum over open string
`.trim();
```
```astro
<LessonMindMap content={mindMap} />
```

Props: `content` (string — markdown hierarchy; **first line must be `# Title`**,
then `##`/`###` for nested levels). Define as a frontmatter `const`, same as
`CodeBlock`'s code strings — keeps the template body free of a large inline
literal.

Place the `<LessonMindMap />` call anywhere in the template (commonly right
before `</LessonLayout>`) — it renders as a fixed overlay, not inline content.
One per lesson page.

**Inline mode** — `<LessonMindMap content={md} inline height="600px" />` renders
the map in the page flow (foldable nodes, zoom, pan) instead of as a modal; use it
for a summary/recap page's knowledge map, in place of a Mermaid `mindmap`. It adds no
breadcrumb button and can sit alongside the page's modal map. Optional
`expandLevel` (default `-1` = all levels open) works in both modes.

Don't pass markmap options in a `<script type="application/json">` block — with
autoloader 0.17 that blanks the root label. The component writes them as markmap
frontmatter for you; `content` must not have its own frontmatter.

---

### `LessonCollapsible`
Collapsed-by-default block for optional detail — a line-by-line code explanation,
a derivation, a long example — so it doesn't interrupt the main flow. Native
`<details>`, no JS. Any content (prose, `CodeBlock`, tables) goes in the slot.

```astro
<LessonCollapsible title="What does this line do?">
  <p>…</p>
  <CodeBlock lang="python" code={explained} />
</LessonCollapsible>
```

Props: `title` (string), `label?` (small tag before the title, default `"Explained"`),
`open?` (boolean, default `false`). Not a replacement for `DeepDive` (the end-of-page
senior section) — use it inline, next to the thing it explains.

---

### `LessonToc`
Inline "On this page" contents box for long lessons — place it first inside
`.lesson-content`. Built in the browser from the page's own `h2`/`h3.lesson-heading`
elements (badges stripped, ids added automatically), so it never drifts from the
headings. Adds a "Deep dive" entry that opens the DeepDive.

```astro
<LessonToc />                 <!-- h2 + nested h3 -->
<LessonToc depth={2} />       <!-- h2 only -->
```

Props: `title?` (default `"On this page"`), `depth?` (`2 | 3`, default `3`).

---

### `FloatingToc`
Quick-navigation for the current page, **rendered by `LessonLayout` on every lesson**
— don't add it to pages. Lists the h2 sections and highlights the one in view: a
slim sidebar in the left margin on wide screens (≥1240px), a "☰ Sections" button
bottom-left on narrow screens or while the AI panel is open. Hidden on pages with
fewer than `minSections` (default 4) sections.

Both TOC components share `toc-headings.ts` (copy it along with them) and carry
their own styles inside the component file, so copying the files is all a module
needs.

---

### `NotebookView`
Renders a committed Jupyter notebook (or selected cells) with its saved outputs, at build
time (notebookjs + Shiki, no JS shipped). Optional "Open in Colab" button.

```astro
---
import NotebookView from '@/components/NotebookView.astro';
import nb from '../../../../code/course-1/4.4-claim-triage/claim_triage.ipynb?raw';
---
<NotebookView notebook={nb} path="code/course-1/4.4-claim-triage/claim_triage.ipynb" />
```

Show a lesson's notebook **whole, once** (see SKILL.md). `cells={['tag']}` renders only the cells
with those tags: keep it for a rare single-cell excerpt, never to scatter one program across a page.

Props: `notebook` (raw .ipynb string), `cells?` (notebook cell tags to show; unknown tag =
build error), `path?` (module-relative path; adds the Colab button), `title?`. Tag cells in
Jupyter/Colab via the cell's metadata `"tags": [...]`.

---

### `OpenInColab`
Button that opens a committed notebook in Google Colab (new tab).

```astro
<OpenInColab path="code/course-1/4.4-claim-triage/claim_triage.ipynb" />
```

Props: `path` (relative to the module folder), `label?` (default "Open in Colab").
Repo, branch and module folder come from `src/data/site.ts`.

---

### `SourceBadge`
Small pill inside a section heading marking where the content came from.

```astro
<h2 class="lesson-heading">Title <SourceBadge source="course" /></h2>
```

Props: `source` (`course | mine | book`). Labels live in `SourceBadge.astro` —
edit per module (e.g. `'📘 Book · <title>'`). For a lesson with no headings,
`<p><SourceBadge source="course" /></p>` at the top works too.

---

## Page structure conventions

- One `<h2 class="lesson-heading">` per major section.
- Every page ends with the four required sections (checklist, quiz, DeepDive,
  mind map) — see `SKILL.md`.
- `<h3 class="lesson-heading">` for sub-sections.
- Use `<p>`, `<ul>`, `<ol>` for prose — no raw `<div>` wrappers for text.
- `<div class="lesson-table"><table>…</table></div>` for comparison tables.
- The only acceptable inline `style=` uses are for **dynamic values from data** (e.g.
  `style={`width:${pct}%`}`). See `SKILL.md`'s style exhaustion rule for everything
  else.

## Page URL → file naming

`/lessons/000N-slug` → `src/pages/lessons/000N-slug.astro`, and add a matching entry
to `src/data/lessons.ts` (`LESSONS` array) in sequence order — `LessonLayout` derives
prev/next nav from that list, so a page not listed there gets no nav links.
