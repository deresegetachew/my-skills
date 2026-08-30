# Capture inbox — Chrome extension

Lets you capture a text selection or a full readable page from any site and
drop it into a module's `captures/` folder while its dev server is running.
See `SKILL.md` for whether to include this in a given module, and for the
"check the inbox" instructions (how pending captures actually become lesson
content).

---

## Architecture

- **Dev-only Vite middleware**, registered by the `capture-inbox` Astro
  integration (`assets/integrations/capture-inbox.mjs` → copied to the site
  root as `capture-inbox.mjs`, wired into `astro.config.mjs`'s `integrations`).
  Runs only while `astro dev` is running; `astro build` never sees it, so
  nothing capture-related reaches the deployed static site.
- **Chrome MV3 extension** (`assets/chrome-extension/`), loaded unpacked. Talks
  to the dev server over `http://localhost:<port>` (configurable in the popup
  — `astro dev` ports can shift; default `4321`).
- **Storage**: plain `.jsonl` files under `captures/`, a directory at the
  *module root*, sibling to `site/` — not inside `src/`, so it's never part of
  the Astro build or routing. In a multi-module repo (npm workspaces, one
  Astro project per module) each module that opts in gets its own
  `<module>/captures/`, scoped by whichever module's dev server happens to be
  running.

**Deliberately has no concept of lessons or chapters.** Early drafts of this
tried to have the extension pick a specific lesson to append to while
capturing — that asks the browser to know something it can't know well (a
module's chapter structure, and where a given snippet from an article
actually belongs) while you're mid-page, not mid-authoring. Capture stays
dumb and fast: everything lands in one queue per module. Sorting it into the
right place happens later, as a conversation with Claude.

---

## Endpoints (dev middleware only)

| Method & path | Purpose |
|---|---|
| `GET /api/capture/health` | Liveness check. |
| `POST /api/capture` | Body `{ type: 'selection'\|'page', url, pageTitle, text, html? }`. Appends to `captures/inbox.jsonl` and `captures/pending.jsonl`. |
| `GET /api/capture/status` | `{ count }` — pending (non-archived) entry count, for the extension badge. |
| `GET /api/capture/pending` | Full pending entries, for the review page. |
| `DELETE /api/capture/pending/:id` | Discards one pending entry (removed from `pending.jsonl` only; `inbox.jsonl` is untouched). |
| `GET /__capture-review` | Standalone HTML review/discard page (not an Astro page — see below). |

CORS is wide open (`Access-Control-Allow-Origin` reflects the request origin)
so `chrome-extension://<id>` can call it — safe only because this middleware
never ships in production.

---

## `captures/` file layout

```
captures/
  inbox.jsonl    # append-only, permanent, every capture ever made
  pending.jsonl  # working queue — not yet reviewed/folded into notes
  archive.jsonl  # entries Claude has already turned into content
```

Each line is one JSON object: `{ id, timestamp, type, url, pageTitle, text, html? }`.

Add `captures/` to `.gitignore` in the module — it's scratch material, not
source of truth (the notes themselves are).

---

## Why the review page isn't an Astro page

`output: 'static'` bakes everything under `src/pages` into the production
build. A page listing raw captured (possibly unfinished, private) notes must
never end up in the deployed site, so `/__capture-review` is served as a
plain HTML string straight from the same dev middleware as the JSON endpoints
— dev-only by construction, same as everything else here.

---

## Surfacing pending captures

Nothing forces you to deal with captures immediately, so there are three
independent nudges:

1. **Dev server console** — logs `[captures] N pending — see /__capture-review
   or ask Claude to check the inbox` on server start and after every new
   capture.
2. **Extension badge** — the toolbar icon shows the pending count for whatever
   `baseUrl` is configured, refreshed when the popup opens and on a
   `chrome.alarms` tick (~every 10 min) so it stays current without opening
   the popup.
3. **Popup** — shows the pending count next to the connection status, plus a
   "Review pending captures →" link to `/__capture-review`.

---

## Turning captures into notes

Deliberately manual and conversational, not automated:

1. Open `/__capture-review` (from the popup, or directly) to skim entries and
   discard anything not worth keeping.
2. Ask Claude to check the inbox for that module (or the review page has a
   "Copy 'check inbox' prompt" button for a ready-made phrasing).
3. Claude reads `captures/pending.jsonl`, asks where each entry belongs (which
   chapter/file — this is intentionally a question, not a guess), drafts the
   content following the module's existing conventions, and moves consumed
   entries to `captures/archive.jsonl`.

There's no direct channel from a webpage into a running Claude Code session —
this hand-off (via the popup/review page, into a chat) is the intentional
trigger point, not a missing feature.

---

## Extension setup

1. `chrome://extensions` → enable Developer Mode → **Load unpacked** →
   select the `chrome-extension/` folder copied into the project (or the
   skill's `assets/chrome-extension/` directly, for development).
2. Open the popup, set the dev server URL if it's not on the default port —
   e.g. if you're running two modules' dev servers at once, only one popup
   config can point at a time, so switch it (or run one module's dev server
   at a time while capturing for it).
3. Right-click any selected text → "Capture selection to Study Notes", or
   right-click a page → "Capture full page to Study Notes".

**v1 limitation**: no offline queue. If the dev server isn't running when you
capture, the attempt just fails (shown in the popup's Recent list) — capture
again once `npm run dev` is up.
