// The web app's look (#450): the owner's design (docs/design/web-ui/RULES.md). Plain white and flat, colour only where it
// means something; every colour is a variable of theme.ts (theme.css), so light and dark both work. Kept as a string the
// app puts in the page, so the bundle stays one file.
export const CSS = String.raw`
:root {
  --radius: 14px;
  --font: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --title-font: "Space Grotesk", Inter, ui-sans-serif, system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; }
code, pre { font-family: var(--mono); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.muted { color: var(--text-2); }

.app { display: grid; grid-template-columns: 64px 248px minmax(0, 1fr); height: 100%; background: var(--bg); color: var(--text); }

/* the projects */
.rail { background: var(--bg-subtle); border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center;
  gap: 12px; padding: 16px 0; overflow-y: auto; }
.rail .proj { width: 40px; height: 40px; border-radius: 12px; border: 0; cursor: pointer; font-weight: 700; font-size: 13px; position: relative;
  display: flex; align-items: center; justify-content: center; flex: none; }
.rail .proj[aria-current="true"] { outline: 2px solid var(--text); outline-offset: 2px; }
.rail .proj .flag { position: absolute; right: -3px; top: -3px; width: 10px; height: 10px; border-radius: 50%; background: var(--red-dot);
  border: 2px solid var(--bg-subtle); }
.rail .grow { flex: 1; }
.rail .icon { width: 40px; height: 40px; border-radius: 12px; border: 0; background: none; cursor: pointer; color: var(--text-2);
  display: flex; align-items: center; justify-content: center; flex: none; }
.rail .icon:hover, .rail .icon[aria-current="true"] { background: var(--bg-active); color: var(--text); }

/* the sidebar */
.side { background: var(--bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; min-width: 0;
  padding: 18px 14px; overflow-y: auto; }
.side-head { display: flex; flex-direction: column; gap: 2px; padding: 0 6px; }
.side-head h1 { font: 700 18px/1.3 var(--title-font); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-head p { margin: 0; color: var(--text-2); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.search { position: relative; }
.search input { width: 100%; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); border-radius: 10px;
  height: 40px; padding: 0 34px 0 34px; font: inherit; }
.search input::placeholder { color: var(--text-2); }
.search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text-2); }
.search kbd { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); font: 11px var(--font); color: var(--text-2);
  border: 1px solid var(--border-strong); border-radius: 6px; padding: 0 6px; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav h2 { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); margin: 0; padding: 4px 10px; }
.nav-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left; border: 0; background: none;
  cursor: pointer; padding: 8px 10px; border-radius: 9px; color: var(--text); min-height: 36px; }
.nav-item:hover { background: var(--bg-subtle); }
.nav-item[aria-current="page"] { background: var(--bg-active); font-weight: 600; }
.nav-item .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-item .sub { display: block; font-size: 11px; color: var(--text-3); font-weight: 600; line-height: 1.2; }
.nav-item .hash { color: var(--text-3); width: 12px; text-align: center; flex: none; }
.badge { min-width: 20px; height: 20px; border-radius: 999px; color: #FFFFFF; font-size: 11px; font-weight: 700; display: inline-flex;
  align-items: center; justify-content: center; padding: 0 6px; }
.badge.blue { background: var(--badge); }
.badge.red { background: var(--red-dot); }
.mate { padding: 5px 8px; }
.mate .name { line-height: 1.2; }
.side-foot { margin-top: auto; padding: 0 6px; font-size: 12px; color: var(--text-2); }

.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: var(--idle); }
.dot.good { background: var(--working); }
.dot.warn { background: var(--waiting); }
.dot.bad { background: var(--down); }

/* the page */
.main { display: flex; flex-direction: column; min-width: 0; height: 100%; overflow-y: auto; }
.page-head { display: flex; align-items: flex-start; gap: 16px; padding: 32px 44px 8px; max-width: 1188px; width: 100%; }
.page-head .grow { flex: 1; min-width: 0; }
.page-head h1 { font: 700 34px/1.15 var(--title-font); margin: 0; display: flex; align-items: center; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.page-head p { margin: 6px 0 0; color: var(--text-2); }
.page-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.menu { display: none; border: 0; background: none; cursor: pointer; padding: 10px; margin: -6px 0 0 -10px; border-radius: 10px; color: var(--text-2); }
.body { flex: 1; padding: 16px 44px 40px; max-width: 1188px; width: 100%; display: flex; flex-direction: column; gap: 20px; }

.btn { height: 44px; padding: 0 18px; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
  cursor: pointer; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap; }
.btn:hover { background: var(--bg-subtle); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); font-weight: 600; }
.btn.danger { background: var(--red-fill); border-color: var(--red-fill); color: var(--red-ink); font-weight: 600; }
.btn.plain { background: none; border-color: transparent; color: var(--text-2); }
.btn.small { height: 32px; padding: 0 12px; font-size: 13px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }

.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
.card h3 { margin: 0 0 12px; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px 20px; margin: 0; }
.facts dt { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); margin-bottom: 2px; }
.facts dd { margin: 0; display: flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
.state-big { font-size: 15px; font-weight: 600; }
.tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--grey-fill); color: var(--text-2); font-weight: 500; }
.tag.quiet { background: none; border: 1px solid var(--border); }

pre.log { margin: 0; background: var(--bg-subtle); border-radius: 10px; padding: 12px 14px; font-size: 12.5px; line-height: 1.55;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow-y: auto; }
.empty { color: var(--text-2); }
.empty code, .notice code, .card code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }

.notice { border-radius: var(--radius); padding: 12px 16px; border: 1px solid var(--border); background: var(--surface); display: flex; gap: 10px;
  align-items: baseline; }
.notice strong { display: block; font-weight: 600; }
.notice p { margin: 2px 0 0; color: var(--text-2); }

.machines { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
.rows li:first-child { border-top: 0; padding-top: 0; }
.rows .name { font-weight: 600; }
.rows .detail { color: var(--text-2); font-size: 13px; margin-left: auto; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rows button.link { border: 0; background: none; padding: 0; cursor: pointer; font-weight: 600; }
.rows button.link:hover { text-decoration: underline; }

/* Add machine (issue 445): a name, the agents it will run, then the one command to run on the new machine */
.add-machine .card-text { margin: 0 0 14px; }
.add-machine .card-note { margin: 12px 0 0; font-size: 13px; }
.add-machine .actions { display: flex; flex-wrap: wrap; gap: 10px; }
.join-form { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.join-form .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-2); border: 0; margin: 0; padding: 0; min-width: 0; }
.join-form legend { padding: 0; margin-bottom: 2px; }
.join-form input[type="text"], .join-form input:not([type]) { height: 44px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 0 12px;
  background: var(--surface); color: var(--text); font: inherit; min-width: 0; }
.join-form .lrow { padding: 10px 2px; }
.join-form .lrow:last-child { border-bottom: 0; }
.join-form .pick { width: 20px; height: 20px; accent-color: var(--primary); cursor: pointer; }
.join-cmd { display: block; font: 13px/1.5 var(--mono); background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; margin: 0 0 14px; overflow-wrap: anywhere; word-break: break-all; user-select: all; max-height: 160px; overflow-y: auto; }

.composer { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--border); padding: 12px 44px 16px; max-width: 1188px; width: 100%; }

.placeholder { max-width: 560px; padding: 24px 0; color: var(--text-2); }
.placeholder h2 { color: var(--text); margin: 0 0 6px; font-size: 22px; font-weight: 600; }
.placeholder .links { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }

.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--text) 40%, transparent); display: grid; place-items: center; padding: 16px; z-index: 20; }
.dialog { background: var(--surface); border-radius: 16px; padding: 24px; width: min(560px, 100%); border: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 16px; max-height: calc(100vh - 32px); overflow-y: auto; }
.dialog h2, .dialog h3 { margin: 0; font-size: 20px; font-weight: 600; }
.dialog p { margin: 0; }
.dialog .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }

.toast { position: fixed; bottom: 20px; right: 20px; max-width: min(460px, calc(100% - 40px)); background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: 12px; padding: 12px 14px; z-index: 30; display: flex; gap: 10px; align-items: baseline; }
.toast pre { margin: 6px 0 0; font-size: 12px; white-space: pre-wrap; color: var(--text-2); max-height: 160px; overflow: auto; }
.toast button { border: 0; background: none; cursor: pointer; color: var(--text-3); margin-left: auto; min-width: 32px; min-height: 32px; }

.backdrop { display: none; }
.gate { max-width: 440px; margin: 12vh auto; padding: 0 16px; }
.gate h1 { font: 700 34px/1.15 var(--title-font); margin: 0 0 8px; }
.gate p { color: var(--text-2); }
.gate form { display: flex; gap: 8px; margin-top: 16px; }
.gate input { flex: 1; border: 1px solid var(--border-strong); border-radius: 10px; height: 44px; padding: 0 12px; background: var(--surface); color: var(--text);
  font: 13px var(--mono); }

@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .rail, .side { display: none; }
  .app.open .rail { display: flex; position: fixed; left: 0; top: 0; bottom: 0; width: 64px; z-index: 11; }
  .app.open .side { display: flex; position: fixed; left: 64px; top: 0; bottom: 0; width: min(280px, calc(100% - 64px)); z-index: 11; }
  .backdrop { display: block; position: fixed; inset: 0; background: color-mix(in srgb, var(--text) 35%, transparent); z-index: 10; border: 0; }
  .menu { display: inline-flex; }
  .page-head { padding: 20px 16px 4px; flex-wrap: wrap; }
  .page-head .grow { flex: 1 1 220px; }
  .page-actions { width: 100%; }
  .page-head h1 { font-size: 26px; }
  .body { padding: 12px 16px 32px; }
  .composer { padding: 12px 16px 16px; }
}
`;
