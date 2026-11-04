// The Settings view (#340, #367), towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VSettings.dc.html). The
// settings as a table: setting, value, from (main, your change, this machine, default), what it does. Project settings
// by section under PROJECT (via PR), this machine's own under THIS MACHINE (direct). A ◆ marks a setting whose change
// needs a sign-off. Staged project changes (#306) show as "(pending)" in the table and together in a box, as the one
// pull request `factory settings pr` opens. The hook (factory_cockpit_ui.ts) reads the settings, the schema and the
// staged changes; this only draws them, and only reads: the keys line names the commands that edit. A terminal
// narrower than the table puts each setting over several lines.
import { type Line, list, obj, type Obj, plain, seg, type Style } from "./lines.tsx";
import { clip, heading, padStr, para, wrapText } from "./doc.tsx";
import type { Got } from "./read.ts";

const KEY_W = 34;
const VALUE_W = 20;
const FROM_W = 13;
const WIDE = KEY_W + VALUE_W + FROM_W + 23; // the table needs this much to keep a useful "what it does"

/** The value in `n` columns; a pending one keeps its "(pending)" however much of the value is cut. */
function valueText(r: Obj, n: number): string {
  return r.pending === true ? `${clip(plain(r.value), Math.max(n - 10, 1))} (pending)` : clip(plain(r.value), n);
}

function table(rows: Obj[], cols: number): Line[] {
  const out: Line[] = [];
  for (const r of rows) {
    const key = plain(r.key);
    const mark = r.owner === true ? " ◆" : "";
    const vs: Style | undefined = r.pending === true ? "amber" : undefined;
    const from = plain(r.from);
    const help = plain(r.help);
    if (cols >= WIDE) {
      const k = clip(key, KEY_W - 2 - mark.length);
      out.push([seg(`  ${k}`), seg(mark, "amber"), seg(" ".repeat(Math.max(KEY_W - 2 - [...k].length - mark.length, 0))),
        seg(padStr(valueText(r, VALUE_W - 2), VALUE_W - 1), vs), seg(` ${padStr(from, FROM_W - 1)} `),
        seg(clip(help, cols - KEY_W - VALUE_W - FROM_W - 2), "dim")]);
    } else {
      const k = clip(`  ${key}${mark}`, cols);
      out.push(mark && k.endsWith(mark) ? [seg(k.slice(0, -mark.length)), seg(mark, "amber")] : [seg(k)]);
      out.push([seg("    "), seg(valueText(r, Math.max(cols - 4 - [...from].length - 3, 12)), vs), seg(" · "),
        seg(clip(from, cols - 4), "dim")]);
      out.push(...wrapText(help, cols - 4).slice(0, 2).map((l): Line => [seg(`    ${l}`, "dim")]));
    }
  }
  return out;
}

/** The box of staged changes: what `factory settings pr` would open. */
function stagedBox(staged: Obj, cols: number): Line[] {
  const inner = Math.max(cols - 4, 10);
  const body: Line[] = [];
  const problem = plain(staged.problem);
  const changes = list(staged.changes);
  if (problem) {
    body.push(...para(`The staged changes can't be read (${problem}).`, inner));
    body.push(...para("Run `factory settings unstage` to drop them, then stage again with `factory settings set --stage <key> <value>`.", inner, "dim"));
  } else if (!changes.length) {
    body.push(...para("No project changes waiting.", inner));
    body.push(...para("`factory settings set --stage <key> <value>` stages one; they go to main together as one pull request.", inner, "dim"));
  } else {
    body.push(...para(`${changes.length} project change${changes.length === 1 ? "" : "s"} waiting · they go to main as one pull request`, inner, "bold"));
    for (const c of changes) {
      const key = plain(c.key);
      if (typeof c.was === "string") body.push(...para(`- ${key}: ${plain(c.was)}`, inner, "red"));
      if (typeof c.now === "string") body.push(...para(`+ ${key}: ${plain(c.now)}`, inner, "green"));
      else if (typeof c.was !== "string") body.push(...para(`  ${key}: back to its default`, inner, "dim"));
    }
    body.push(...para("`factory settings pr` opens the PR · `factory settings unstage [<key>]` discards · " +
      "`factory settings validate` checks · .claude/factory.json is protected: you merge it", inner, "dim"));
  }
  const rule = "─".repeat(Math.max(cols - 2, 0));
  const width = (l: Line) => l.reduce((n, s) => n + [...s.text].length, 0);
  return [[seg(`┌${rule}┐`, "amber")],
    ...body.map((b): Line => [seg("│", "amber"), seg(" "), ...b, seg(" ".repeat(Math.max(inner - width(b), 0))), seg(" "), seg("│", "amber")]),
    [seg(`└${rule}┘`, "amber")]];
}

const KEYS = "edit: `factory settings set --stage <key> <value>` · full help: `factory settings help <key>` · " +
  "back to default: `factory settings unset --stage <key>` · search: / here · open the PR: `factory settings pr` · " +
  "this machine: `factory settings --local set <key> <value>`, saved at once · agents can't open this view";

/** Every line of the Settings view (undefined: still reading), each at most `cols` wide. */
export function settingsLines(data: Got | undefined, cols: number): Line[] {
  if (data === undefined) return [[seg("Reading the settings…")]];
  if (data === null || data === "late") return para("The settings can't be read: run `factory settings list` to see why.", cols);
  const repo = plain(data.repo);
  const out: Line[] = [...heading([seg("factory", "amber"), seg(` ${repo} · Settings`, "dim")],
    "factory settings · values from main, this machine's file, defaults", cols)];
  out.push(...para("◆ a change to it needs a sign-off: the owner's, or a dev manager's label (`factory settings help <key>`) · " +
    "(pending) staged, not on main yet", cols, "dim"), []);
  if (cols >= WIDE) {
    out.push([seg(`  ${padStr("setting", KEY_W - 2)}${padStr("value", VALUE_W - 1)} ${padStr("from", FROM_W - 1)} what it does`, "dim")]);
  }
  out.push([seg("PROJECT (via PR)", "bold")]);
  for (const s of list(data.sections)) {
    const rows = list(s.rows);
    if (!rows.length) continue;
    out.push([seg(clip(`── ${plain(s.name)} `.padEnd(Math.min(cols, 60), "─"), cols), "amber")], ...table(rows, cols));
  }
  out.push([], [seg(clip(`THIS MACHINE (direct) · ${plain(data.host)} · ${repo}`, cols), "bold")]);
  out.push(...table(list(data.machine), cols), []);
  out.push(...stagedBox(obj(data.staged), cols), []);
  out.push(...para(KEYS, cols, "dim"));
  return out;
}
