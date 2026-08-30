# AI Tutor — Rocket 🦝

Gemini-powered chat sidebar embedded in every lesson. Mascot: Rocket Raccoon (🦝).

---

## Architecture

- **Static site** (`output: 'static'`) — no SSR, no server. Browser calls Gemini directly.
- **API**: `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
- **Auth**: `x-goog-api-key` request header. Key stored in `localStorage`.
- **Streaming**: `fetch` + `ReadableStream` + `TextDecoder`. SSE lines parsed as `candidates[0].content.parts[0].text`.
- **Markdown**: `marked.js` (CDN). Applied on stream completion, not mid-stream.

---

## Components

| Component | File | Purpose |
|---|---|---|
| `AiTutor` | `site/src/components/AiTutor.astro` | Full chat sidebar + popover + modal |
| `ThemeHead` | `site/src/components/ThemeHead.astro` | Anti-FOUC dark-mode init, goes in `<head>` |
| `ThemeToggle` | `site/src/components/ThemeToggle.astro` | Moon/sun toggle button, goes before `</body>` |

All three are already imported and rendered by `LessonLayout.astro`. **Do not add them again to lesson pages.**

---

## Where to add on new pages

Any page that has its own `<html>/<head>` (not via `LessonLayout`) needs:

```astro
---
import ThemeHead from '@/components/ThemeHead.astro';
import ThemeToggle from '@/components/ThemeToggle.astro';
---
<html lang="en">
<head>
  ...
  <ThemeHead />
</head>
<body>
  ...
  <ThemeToggle />
</body>
```

`AiTutor` is optional on non-lesson pages — only add it if chat is needed there.

---

## AiTutor props / defaults

```typescript
interface Props {
  storageKey?:   string;  // 'ai-tutor-key'
  model?:        string;  // 'gemini-2.0-flash'
  maxTokens?:    number;  // 1024
  historyLimit?: number;  // 20
  timeoutMs?:    number;  // 30000
  systemPrompt?: string;  // built-in tutor prompt
}
```

Props are serialised into a `<script type="application/json" id="ai-sensei-config">` bridge element because `define:vars` is incompatible with `is:inline`. The JS reads it with `JSON.parse(document.getElementById('ai-sensei-config').textContent)`.

---

## localStorage keys

| Key | Contents |
|---|---|
| `ai-tutor-key` | Google AI API key (plaintext) |
| `ai-tutor-key-config` | JSON: `{ model, maxTokens, historyLimit, timeoutMs, systemPrompt }` |
| `ai-theme` | `'dark'` or `'light'` |

Config key is `storageKey + '-config'` (so it follows any custom `storageKey` prop).

---

## Runtime behaviour

- **Lesson context**: on first send, `buildLessonSystem()` scrapes `.lesson-article` `innerText` (≤8000 chars), wraps in `<lesson_content>` XML tag, prepends to system prompt. Cached for the session; cleared when settings are saved.
- **History cap**: after each assistant reply, `history` is sliced to the last `HISTORY_LIMIT` messages.
- **Key validation**: `400`/`403` response clears the stored key and shows a prompt.
- **Timeout**: `AbortController` fires after `TIMEOUT_MS` ms.

---

## Custom event: `ai-sensei:focus`

Any component can open the chat panel and pre-fill the input:

```javascript
document.dispatchEvent(new CustomEvent('ai-sensei:focus', {
  detail: { text: 'Your pre-fill text here.' }
}));
```

`AiTutor` listens on `document` and handles it. Used by `DeepDive` and `LessonQuiz` for their 🦝 shortcut buttons.

---

## Key DOM IDs / classes

| ID / class | Element |
|---|---|
| `#ai-toggle` | 🦝 open-panel button (fixed, bottom-right) |
| `#ai-panel` | Sidebar (`aside`). Open = `is-open` class. |
| `#ai-messages` | Scrollable message list |
| `#ai-form` / `#ai-input` | Chat form / textarea |
| `#ai-key-modal` | Settings modal |
| `#ai-key-overlay` | Backdrop |
| `body.ai-panel-open` | Added when panel is open; shifts `.lesson-article` left |
| `.ai-msg--user` / `.ai-msg--assistant` | Message bubbles |
| `.ai-streaming` | Assistant bubble while stream is in-flight |
| `.rocket-mascot` | Ghost 🦝 (25% opacity, fades when panel open) |

---

## Modal visibility pattern

**Never use the `hidden` attribute on `#ai-key-modal`.** ID selector specificity (1,0,0) beats `[hidden]` attribute selector (0,1,0) in browser UA stylesheet (no `!important`), so `display: flex` set by the ID rule wins and the element never hides.

**Correct pattern (already in `global.css`):**
```css
#ai-key-modal { display: none; }
#ai-key-modal.is-open { display: flex; }
```

JS uses `modal.classList.add('is-open')` / `modal.classList.remove('is-open')`.

Same pattern applies to `#ai-key-overlay`.

---

## Dark mode

- JS-driven: `.dark` class on `<html>`.
- Init in `<head>` via `ThemeHead` to prevent FOUC.
- CSS overrides: `:root.dark .selector` in `global.css`.
- **Never** use `@media (prefers-color-scheme: dark)` — the JS class is the single source of truth.
- OS preference is the fallback only if no `ai-theme` value is saved.

---

## Layout shift when panel opens

```css
/* global.css */
.lesson-article {
  transition: max-width .22s cubic-bezier(.4,0,.2,1), margin .22s ...;
}
body.ai-panel-open .lesson-article {
  margin: 0;
  max-width: calc(50vw - 3rem);
}
#ai-panel {
  width: 50vw;
  min-width: 320px;
}
```

Article slides left; panel occupies the right 50vw. Toggle button hidden while panel is open (`#ai-toggle.is-hidden { display: none }`).
