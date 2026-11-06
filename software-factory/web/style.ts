// The web app's look: one stylesheet, light and dark from the system setting. Kept as a string the app puts in the page,
// so the bundle stays one file.
export const CSS = String.raw`
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --bg-soft: #f7f7fa;
  --rail: #eceef5;
  --side: #f4f5f9;
  --line: #e3e5ec;
  --text: #1c1d22;
  --muted: #646875;
  --faint: #9a9ead;
  --accent: #4f46e5;
  --accent-soft: #eceafd;
  --accent-text: #3f37c9;
  --good: #16a34a;
  --warn: #d97706;
  --bad: #dc2626;
  --quiet: #9ca3af;
  --code-bg: #f3f4f8;
  --shadow: 0 1px 2px rgba(16, 18, 27, .06), 0 8px 24px rgba(16, 18, 27, .06);
  --radius: 10px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161b;
    --bg-soft: #1b1c22;
    --rail: #0e0f13;
    --side: #18191f;
    --line: #2a2c35;
    --text: #e8e9ee;
    --muted: #a0a4b1;
    --faint: #6d7180;
    --accent: #8b85ff;
    --accent-soft: #26244a;
    --accent-text: #bcb8ff;
    --good: #34d399;
    --warn: #fbbf24;
    --bad: #f87171;
    --quiet: #6b7280;
    --code-bg: #101116;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .3);
  }
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; }
code, pre { font-family: var(--mono); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.app { display: grid; grid-template-columns: 64px 260px 1fr; height: 100%; }

/* the projects, like workspaces */
.rail { background: var(--rail); border-right: 1px solid var(--line); display: flex; flex-direction: column; align-items: center;
  gap: 10px; padding: 14px 0; overflow-y: auto; }
.rail button { width: 40px; height: 40px; border-radius: 10px; border: 0; cursor: pointer; font-weight: 700; font-size: 15px;
  background: var(--bg); color: var(--muted); box-shadow: inset 0 0 0 1px var(--line); position: relative; }
.rail button:hover { color: var(--text); }
.rail button[aria-current="true"] { background: var(--accent); color: #fff; box-shadow: none; }
.rail button .flag { position: absolute; right: -3px; top: -3px; width: 10px; height: 10px; border-radius: 50%;
  background: var(--warn); border: 2px solid var(--rail); }

/* the channels of the selected project */
.side { background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-width: 0; }
.side-head { padding: 16px 16px 10px; }
.side-head h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-head p { margin: 2px 0 0; color: var(--faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search { margin: 0 12px 8px; position: relative; }
.search input { width: 100%; border: 1px solid var(--line); background: var(--bg); color: var(--text); border-radius: 8px;
  padding: 7px 10px 7px 30px; font: inherit; font-size: 13px; }
.search input::placeholder { color: var(--faint); }
.search svg { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--faint); }
.search kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font: 11px var(--mono); color: var(--faint);
  border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.channels { flex: 1; overflow-y: auto; padding: 4px 8px 12px; }
.section { margin-top: 12px; }
.section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin: 0 8px 4px; font-weight: 600; }
.chan { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: none; cursor: pointer;
  padding: 6px 8px; border-radius: 6px; color: var(--muted); }
.chan:hover { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.chan[aria-current="true"] { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.chan .hash { color: var(--faint); width: 12px; text-align: center; flex: none; }
.chan .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chan .meta { font-size: 11px; color: var(--faint); white-space: nowrap; max-width: 96px; overflow: hidden; text-overflow: ellipsis; }
.chan .sub { display: block; font-size: 11px; color: var(--faint); font-weight: 400; }
.side-foot { border-top: 1px solid var(--line); padding: 10px 16px; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px; }

.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--quiet); }
.dot.good { background: var(--good); box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 20%, transparent); }
.dot.warn { background: var(--warn); }
.dot.bad { background: var(--bad); }
.dot.quiet { background: transparent; box-shadow: inset 0 0 0 1.5px var(--quiet); }

/* the channel */
.main { display: flex; flex-direction: column; min-width: 0; height: 100%; }
.main-head { display: flex; align-items: center; gap: 12px; padding: 12px 24px; border-bottom: 1px solid var(--line); min-height: 60px; }
.main-head h2 { margin: 0; font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 6px; min-width: 0; }
.main-head h2 .hash { color: var(--faint); font-weight: 400; }
.main-head .subtitle { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main-head .grow { flex: 1; min-width: 0; }
.menu { display: none; border: 0; background: none; cursor: pointer; padding: 6px; border-radius: 6px; color: var(--muted); }
.body { flex: 1; overflow-y: auto; padding: 20px 24px 32px; }
.body > * + * { margin-top: 16px; }

.btn { border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 6px 14px; cursor: pointer; font-weight: 600;
  font-size: 13px; }
.btn:hover { background: var(--bg-soft); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.danger { background: var(--bad); border-color: var(--bad); color: #fff; }
.btn:disabled { opacity: .5; cursor: default; }

.join-form { display: flex; flex-direction: column; gap: 10px; }
.join-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
.join-form input { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--bg); color: var(--text); font: inherit; }
.join-form .actions, .join-made .actions { display: flex; gap: 8px; flex-wrap: wrap; }
.join-code { display: block; font: 600 20px var(--mono); letter-spacing: .04em; background: var(--bg-soft); border-radius: 10px; padding: 12px 14px;
  overflow-wrap: anywhere; user-select: all; }
.join-code.small { font-size: 12px; font-weight: 400; letter-spacing: 0; }
.card { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
.card h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: var(--muted); display: flex; align-items: center; gap: 8px; }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px 20px; margin: 0; }
.facts dt { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--faint); margin-bottom: 2px; }
.facts dd { margin: 0; display: flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
.state-big { font-size: 15px; font-weight: 600; }
.tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text);
  font-weight: 600; }
.tag.quiet { background: var(--bg-soft); color: var(--muted); box-shadow: inset 0 0 0 1px var(--line); }

pre.log { margin: 0; background: var(--code-bg); border-radius: 8px; padding: 12px 14px; font-size: 12.5px; line-height: 1.55;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow-y: auto; }
.empty { color: var(--muted); }
.empty code, .notice code, .card code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }

.notice { border-radius: var(--radius); padding: 12px 14px; border: 1px solid; display: flex; gap: 10px; align-items: flex-start; }
.notice.warn { border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 9%, var(--bg)); }
.notice.bad { border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: color-mix(in srgb, var(--bad) 8%, var(--bg)); }
.notice strong { display: block; }
.notice p { margin: 2px 0 0; color: var(--muted); }

.machines { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); }
.rows li:first-child { border-top: 0; padding-top: 0; }
.rows .name { font-weight: 600; }
.rows .detail { color: var(--muted); font-size: 13px; margin-left: auto; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rows button.link { border: 0; background: none; padding: 0; cursor: pointer; font-weight: 600; }
.rows button.link:hover { color: var(--accent-text); text-decoration: underline; }

.composer { border-top: 1px solid var(--line); padding: 12px 24px 16px; }
.composer div { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; color: var(--faint); background: var(--bg-soft); }

.placeholder { max-width: 520px; margin: 48px auto; text-align: center; color: var(--muted); }
.placeholder .big { font-size: 34px; margin-bottom: 8px; }
.placeholder h3 { color: var(--text); margin: 0 0 6px; font-size: 17px; }

.overlay { position: fixed; inset: 0; background: rgba(10, 11, 15, .45); display: grid; place-items: center; padding: 16px; z-index: 20; }
.dialog { background: var(--bg); border-radius: 14px; box-shadow: var(--shadow); padding: 22px; width: min(440px, 100%); border: 1px solid var(--line); }
.dialog h3 { margin: 0 0 8px; font-size: 17px; }
.dialog p { margin: 0 0 6px; color: var(--muted); }
.dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

.toast { position: fixed; bottom: 20px; right: 20px; max-width: min(460px, calc(100% - 40px)); background: var(--bg); border: 1px solid var(--line);
  border-radius: 12px; box-shadow: var(--shadow); padding: 12px 14px; z-index: 30; display: flex; gap: 10px; align-items: flex-start; }
.toast pre { margin: 6px 0 0; font-size: 12px; white-space: pre-wrap; color: var(--muted); max-height: 160px; overflow: auto; }
.toast button { border: 0; background: none; cursor: pointer; color: var(--faint); margin-left: auto; }

.backdrop { display: none; }
.gate { max-width: 420px; margin: 12vh auto; padding: 0 16px; }
.gate h1 { font-size: 22px; margin: 0 0 8px; }
.gate p { color: var(--muted); }
.gate form { display: flex; gap: 8px; margin-top: 16px; }
.gate input { flex: 1; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--bg); color: var(--text); font: 13px var(--mono); }

@media (max-width: 760px) {
  .app { grid-template-columns: 1fr; }
  .rail, .side { display: none; }
  .app.open .rail { display: flex; position: fixed; left: 0; top: 0; bottom: 0; width: 64px; z-index: 11; }
  .app.open .side { display: flex; position: fixed; left: 64px; top: 0; bottom: 0; width: min(280px, calc(100% - 64px)); z-index: 11; box-shadow: var(--shadow); }
  .backdrop { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 10; border: 0; }
  .menu { display: inline-flex; }
  .main-head, .body, .composer { padding-left: 16px; padding-right: 16px; }
}
`;
