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
import LessonMindMap   from '@/components/LessonMindMap.astro'; // optional

// Large code strings go here, NOT inline in JSX (Astro brace-count bug on nested {}).
const myCode = `...`.trim();
---

<LessonLayout title="LN — Title">
  <LessonHeader num="LN" title="Title" subtitle="One-line hook." />
  <div class="lesson-content">
    <!-- sections here -->
  </div>
</LessonLayout>
```

- Save as `src/pages/lessons/NNNN-kebab-title.astro` → route `/lessons/NNNN-kebab-title`.
- Add the new entry to `src/data/lessons.ts` (`LESSONS` array) in the right position —
  `LessonLayout` derives prev/next nav from this list automatically. Don't add
  `LessonNav`, `ThemeHead`, `ThemeToggle`, or `AiTutor` manually; the layout renders
  them.
- Full component prop reference (CodeBlock, LessonDiagram, LessonCallout,
  LessonChecklist, LessonQuiz, DeepDive, LessonMindMap): see `REFERENCE.md`.

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
