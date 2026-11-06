# Factory web UI — screen brief for designers

The owner wants every feature of the factory (today a CLI, `factory help` in `../factory-help.txt`) usable from a web
UI, designed from step 0 (first launch) to every feature, so implementation is easy. You write artboards for a
Design canvas: each screen is ONE file `project/<Name>.dc.html`. Do not write `project/canvas.json` (the lead does).
Read these first, then copy their structure exactly:
- `project/Main.dc.html` (a full page with the look), `project/Sidebar.dc.html` (the shared sidebar component),
  `project/Avatar.dc.html` (avatar component).
- The format rules below. They fail silently when broken.

## Product in one paragraph
"The factory": AI agents build a software project task by task. Roles: the **product owner** (mentewab, keeps the PRD,
epics, asks the owner), the **dev manager** (fasil, reviews and merges PRs), **builders** (haile, taytu, menelik:
claim a task, write failing tests first, open a PR). The **owner** (the human user) approves what only a person may:
merging protected files, product decisions, releases. Messages and claims go over the message board (Postgres) on a machine called
dev-pc (Tailscale 100.99.7.67); other machines (the owner's Mac) join it. Each project is a GitHub repo
(my-skills, remanual). Tasks are GitHub issues with labels factory:ready / in-progress / in-review / blocked.

## Look (keep it identical across screens) — read project/theme.css and project/Palette.dc.html first
The owner's reference is a modern SaaS app: a plain WHITE, FLAT app, full-bleed (NO page gradient, NO outer margin,
NO window shadow, no rounded outer frame). Calm white surfaces; colour only where it means something.
- Use ONLY the CSS variables from `theme.css` for colour (`var(--text)`, `var(--pink-fill)` …); never a hex, except
  #FFFFFF for text on a solid dot-coloured badge. This is what makes dark mode work. Link it in <head> right after
  the support.js line: `<link rel="stylesheet" href="theme.css">`.
- Dark mode: every screen's root element has `data-theme="{{theme}}"`, with a `theme` prop in data-props:
  `"theme":{"editor":"enum","options":["light","dark"],"default":"light"}` and `theme: this.props.theme ?? 'light'`
  in renderVals. Root `background: var(--bg); color: var(--text);`. Helmet body: `body{margin:0}` only.
- Fonts: Inter (body 14px), Space Grotesk (page titles 700). Helmet font links exactly as in Main.dc.html.
- Categories (fill / dot / ink): pink, green, violet, blue, yellow, red, grey. Roles: product = pink, dev manager
  = violet, builders = green. States: --working --waiting --idle --down (dots).
- Reference patterns to reuse (see Palette.dc.html, both modes):
  - Tabs: underline tabs (selected = 2px var(--text) underline, weight 600).
  - Filter chips: the selected one is a solid black pill (var(--primary)/var(--on-primary)); the others are white
    pills with 1px var(--border-strong) and a 9px dot in their category colour.
  - Cards/items: small pastel-filled rounded rectangles (radius 10px, var(--X-fill)), title 13px semibold, a secondary
    line, an uppercase 10px tag in var(--X-ink) on the right. A "needs you / live" card gets a 1.5px var(--red-dot)
    border and a small red pill label.
  - Plain white cards with 1px var(--border), radius 14px, for panels.
  - Sidebar: selected item has var(--bg-active) fill; counts are small blue badges var(--badge).
  - Buttons: primary var(--primary) bg, var(--on-primary) text, radius 10px, height 44px; secondary
    var(--surface) with 1px var(--border-strong); a role action uses the role's fill + ink; destructive uses red fill + ink.
- Icons: inline stroke SVG (24 viewBox, stroke-width 2, stroke="currentColor", aria-hidden). No emoji.
- Copy: plain, short, sentence case, says what happened and what to do next. Errors: what went wrong + the exact
  button/step that fixes it. Real names and numbers from this brief; unknowns as [PLACEHOLDER].

## Page skeleton (every app screen)
```
<div data-theme="{{theme}}" style="min-height: 1100px; display: flex; flex-wrap: wrap; background: var(--bg); color: var(--text); font-family: Inter, system-ui, sans-serif; font-size: 14px;">
<dc-import name="Sidebar" active="board" height="1100" hint-size="312px,1100px"></dc-import>
<main style="flex: 999 1 560px; min-width: 0; padding: 32px 44px; box-sizing: border-box; display: flex; flex-direction: column; gap: 24px;">
  header: H1 (Space Grotesk 34px), one-line purpose in var(--text-2), actions on the right; underline tabs if the page has views
  ...content...
</main>
</div>
```
`active` is one of: home inbox board epics prs docs signoff activity ci machines health usage releases maintenance
integrations settings mentewab fasil haile taytu menelik. Set `height` to your root's min-height.
Onboarding screens (before a project exists) do NOT use the Sidebar: centred content on var(--bg-subtle) with a white
card, a stepper on top. Phone screens: fixed root 390×844, no sidebar, a bottom tab bar.

## Format rules (the canvas runtime; each breaks silently)
- File shape exactly like Main.dc.html: doctype, `<script src="./support.js"></script>` head line unchanged, `<x-dc>`
  with `<helmet>` (fonts + `body{...}`), markup, then `<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":1440,"height":H}}'>`
  with `class Component extends DCLogic { renderVals() { return {...}; } }` (classic JS, no imports).
- `{{hole}}` is a dotted lookup ONLY, never an expression. Compute in renderVals.
- Repeats: `<sc-for list="{{items}}" as="it" hint-placeholder-count="3">…{{it.x}}…</sc-for>`; branches:
  `<sc-if value="{{flag}}" hint-placeholder-val="{{ true }}">`. Precompute per-item styles/flags in renderVals.
- Child components: `<dc-import name="Avatar" agent="haile" size="32" hint-size="32px,32px"></dc-import>`; never
  self-close, never capitalised tags. `agent` may be a hole: `agent="{{t.agent}}"`.
- Close every element, quote every attribute. Inline `style="…"` for everything; `<helmet><style>` only for body and
  `a{}`/`a:hover{}`. Real `<button>`, `<a href>`, `<input>` with `<label>`/aria-label; no div onClick.
- Links between screens: `<a href="Board.dc.html">` (style the `<a>` as the button).
- Contrast: text ≥4.5:1 (use the role INK colours for text, never the dot colours). Touch targets ≥44px.
- Fluid page: no fixed px width on the root; wide tables in `overflow-x: auto`.
- `data-props`: `$preview` and the `theme` enum only.
- Write each file directly with the Write tool. Do NOT render, screenshot, or read back to verify.

## Real data to use
Agents: mentewab (Product owner, dev-pc, idle until PR #402 merges), fasil (Dev manager, dev-pc, reviewing #402),
haile (builder, dev-pc, #437 An avatar for every agent), taytu (builder, dev-pc, #425 Retire the tmux cockpit),
menelik (builder, the owner's Mac, #438 The PRD and decisions one click away).
Machines: dev-pc (Linux, Tailscale 100.99.7.67, hub: the message board, 3 CI runners + light lane, Docker 29),
Mac (macOS, joined via tunnel; menelik). Projects: my-skills (active), remanual (paused by the owner).
Open PRs: #402 Product owner: try what was built (protected .claude/, needs owner), #434 [PLACEHOLDER title].
Epics: Web UI: the one window #420 (Building, 3 of 14), Epics above tasks #440 (Investigating), Agent messaging
(decision 0004, Building 9 of 12), Machines join #445.
Ready tasks: #439 board, #441 integrations, #443 network guard, #444 roles separate, #445 machine add/join, #446 UI
parity, #447 add project. Decisions: 0002 cockpit (replaced), 0003 ports and adapters, 0004 NATS, 0005 web UI.
Release: factory v[X.Y.Z] installed; remanual pins a release. Settings keys examples: tasks.source, agents,
messaging.transport, messaging.kinds, messaging.pollMinutes, ci.runners, manager.maxSubManagers,
views.cacheSeconds, ui.port, ui.projects, waitMinutes, protected (paths), commands.test.

## Screens (name → what it is → the CLI it replaces). Design each with real content, all its states that matter
(empty, loading text, error with fix) shown as a small secondary panel where useful.
See the list in your task. Each screen: header with H1 + one-line purpose; the primary content; the actions as real
buttons with a confirm wording for anything that changes things ("Merge PR #402?" dialog shown inline when relevant).

## Owner feedback (applies to every screen)
- NO box-shadow anywhere, and no coloured outer edges on cards (no coloured top or left borders): a card is a flat pastel fill, or flat white with a 1px var(--border) hairline.
  The one exception is the Board (owner, 6 Nov: "all white with no shadows, hard to tell the swim lanes", then "the color on the rows seems a bit too much, maybe the swim lane can be represented based on the cards"): a lane stays plain (a small dot in its colour by its title, a hairline between lanes); each card is white with the hairline, a 4px left edge in its lane's colour (by agent: its epic's colour, grey with none) and `box-shadow: var(--card-shadow)`, the only shadow; each column header is a `--bg-subtle` tile with a 3px top edge in its dot colour.
- Never show `factory` commands, flags or setting keys in the UI: plain words and buttons only. The one exception is a one-time admin step that must be typed in a terminal with sudo.
- Agents: 12 ready-made legends (menelik, taytu, haile, tewodros, yohannes, zewditu, lalibela, ezana, alula, abebe, fasil, mentewab); the owner picks how many and which at setup, can rename them and change their picture.

## Calm (owner feedback on the PRs page: "too many colours, crowded; overall use of colour is questionable")
The reference is PRs.dc.html as rewritten: copy its restraint.
- Neutral by default: text, greys, hairlines, white. Colour appears ONLY as:
  1. a small 8px status dot next to plain grey text ("Checks running");
  2. the agent's avatar (which already carries its role colour); a role name in text is grey, not coloured;
  3. ONE red accent for the single thing that needs the owner (a dot or a small red pill), never a red row or card fill;
  4. category dots in filter chips and the pastel item cards on the Board/Epics/calendar-like grids only.
- No coloured tags/pills per field (no APPROVED / MUST-FIX / FOR FASIL pills), no coloured column text, no coloured
  section headers, no coloured buttons except the black primary. Secondary buttons are white with a grey line.
- Fewer things per row: a list row shows avatar, title, one grey sub-line, one status, one action. Everything else
  (head sha, claims, markers, paths, timings) lives on the detail page.
- One primary action per screen region; fewer panels; generous whitespace; max content width ~1100px.
- Underline tabs instead of many filter chips when they are states.
- Every action that removes, stops or merges something shows its preconditions as a short checklist (the button stays off until they are met, each unmet one with its own fix button) and says in plain words what will happen and what will NOT; serious ones are confirmed by typing the name.
- Every item page (task, PR, epic, decision, sign-off item) has a "Talk about this" box: To: the product owner / the dev manager, one line, Send; the answer appears on the page and in the Inbox.
