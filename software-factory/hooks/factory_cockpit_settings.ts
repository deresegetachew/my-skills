// `factory cockpit --settings [--color]` (#340, PRD US-13): the cockpit's Settings view, towards its board
// (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VSettings.dc.html). View 6 runs it in a popup through `less -R`.
//
// The settings as a table: setting, value, from (main, your change, this machine, default), what it does. Project
// settings by section under PROJECT (via PR), this machine's own under THIS MACHINE (direct). A ◆ marks a setting whose
// change is the owner's decision. Staged project changes (#306) show as "(pending)" in the table and together in a box,
// as the one pull request `factory settings pr` opens. The keys line names the commands that edit: the view itself only
// reads. Plain text unless `--color` (and no NO_COLOR); a terminal narrower than the table gets two lines per setting.
// Agents can't open it: it refuses in an agent session, as `factory settings` refuses their changes.
import { hostname } from "node:os";
import { plain } from "./factory_cockpit_ui.ts";
import { refuse, repoKey } from "./factory_machine.ts";
import { asText, lookup, MACHINE, MISSING, SECTIONS, SETTINGS, type Setting } from "./factory_settings_schema.ts";
import { loadStaged, type Staged } from "./factory_settings_staged.ts";
import * as store from "./factory_settings_store.ts";

interface Paint {
  amber: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  grey: (s: string) => string;
  bold: (s: string) => string;
}

function paint(on: boolean): Paint {
  const c = (code: string) => (s: string) => (on && s ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { amber: c("33"), red: c("31"), green: c("32"), grey: c("90"), bold: c("1") };
}

const ANSI = /\x1b\[[0-9;]*m/g;

function width(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

/** Plain text cut to `n` characters, with … when cut. */
function cut(s: string, n: number): string {
  const chars = [...s];
  if (n <= 0) return "";
  return chars.length <= n ? s : `${chars.slice(0, n - 1).join("")}…`;
}

function pad(s: string, n: number): string {
  return cut(s, n) + " ".repeat(Math.max(n - [...cut(s, n)].length, 0));
}

/** Words wrapped to `n` columns, each line starting with `lead`. */
function wrap(text: string, n: number, lead = ""): string[] {
  const out: string[] = [];
  let line = lead;
  for (const w of text.split(" ")) {
    const next = line === lead ? lead + w : `${line} ${w}`;
    if ([...next].length <= n || line === lead) line = next;
    else {
      out.push(line);
      line = lead + w;
    }
  }
  out.push(line);
  return out.map((l) => cut(l, n));
}

/** The terminal's width: COLUMNS, the terminal on stdout, the one on stdin (a popup pipes stdout to less), else 100. */
function columns(): number {
  const given = Number(process.env.COLUMNS);
  if (given > 0) return given;
  if (process.stdout.columns) return process.stdout.columns;
  if (process.stdin.isTTY) {
    const p = Bun.spawnSync(["stty", "size"], { stdin: "inherit", stdout: "pipe", stderr: "ignore" });
    const n = Number(p.stdout.toString().trim().split(/\s+/)[1]);
    if (n > 0) return n;
  }
  return 100;
}

interface Row {
  key: string;
  owner: boolean;
  value: string;
  from: string;
  pending: boolean;
  help: string;
}

function projectRow(data: store.Data, staged: Staged, s: Setting): Row {
  const here = lookup(data, s.key);
  const change = Object.hasOwn(staged, s.key) ? staged[s.key] : undefined;
  const base = { key: s.key, owner: Boolean(s.needs), help: plain(s.short) };
  if (change) {
    const v = "value" in change ? change.value : s.default;
    return { ...base, value: plain(asText(v)), from: "your change", pending: true };
  }
  return { ...base, value: plain(asText(here === MISSING ? s.default : here)), from: here === MISSING ? "default" : "main",
    pending: false };
}

function machineRow(data: store.Data, s: Setting): Row {
  const set = Object.hasOwn(data, s.key);
  return { key: s.key, owner: Boolean(s.needs), help: plain(s.short), value: plain(asText(set ? data[s.key] : s.default)),
    from: set ? "this machine" : "default", pending: false };
}

const KEY_W = 34;
const VALUE_W = 20;
const FROM_W = 13;
const WIDE = KEY_W + VALUE_W + FROM_W + 23; // the table needs this much to keep a useful "what it does"

/** The value in `n` columns; a pending one keeps its "(pending)" however much of the value is cut. */
function valueText(r: Row, n: number): string {
  return r.pending ? `${cut(r.value, Math.max(n - 10, 1))} (pending)` : cut(r.value, n);
}

function tableLines(rows: Row[], cols: number, c: Paint): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const mark = r.owner ? " ◆" : "";
    const value = r.pending ? c.amber : (s: string) => s;
    if (cols >= WIDE) {
      const key = pad(cut(r.key, KEY_W - 2 - mark.length) + mark, KEY_W - 2);
      const keyShown = r.owner ? key.replace(" ◆", c.amber(" ◆")) : key;
      const help = cut(r.help, cols - KEY_W - VALUE_W - FROM_W - 2);
      out.push(`  ${keyShown}${value(pad(valueText(r, VALUE_W - 2), VALUE_W - 1))} ${pad(r.from, FROM_W - 1)} ${c.grey(help)}`);
    } else {
      out.push(cut(`  ${r.key}${mark}`, cols).replace(" ◆", c.amber(" ◆")));
      out.push(`    ${value(valueText(r, Math.max(cols - 4 - [...r.from].length - 3, 12)))} · ${c.grey(cut(r.from, cols - 4))}`);
      for (const l of wrap(r.help, cols, "    ").slice(0, 2)) out.push(c.grey(l));
    }
  }
  return out.map((l) => (width(l) > cols ? cut(l.replace(ANSI, ""), cols) : l));
}

/** The box of staged changes: what `factory settings pr` would open. */
function box(staged: Staged | null, problem: string, data: store.Data, cols: number, c: Paint): string[] {
  const inner = Math.max(cols - 4, 10);
  const body: string[] = [];
  if (problem) {
    body.push(...wrap(`The staged changes can't be read (${plain(problem)}).`, inner));
    body.push(...wrap("Run `factory settings unstage` to drop them, then stage again with `factory settings set --stage <key> <value>`.", inner).map(c.grey));
  } else if (!staged || !Object.keys(staged).length) {
    body.push(...wrap("No project changes waiting.", inner));
    body.push(...wrap("`factory settings set --stage <key> <value>` stages one; they go to main together as one pull request.", inner).map(c.grey));
  } else {
    const keys = Object.keys(staged);
    body.push(...wrap(`${keys.length} project change${keys.length === 1 ? "" : "s"} waiting · they go to main as one pull request`, inner).map(c.bold));
    for (const key of keys) {
      const change = staged[key] as Staged[string];
      const was = lookup(data, key);
      if (was !== MISSING) body.push(...wrap(`- ${JSON.stringify(key)}: ${plain(JSON.stringify(was))}`, inner).map(c.red));
      if ("value" in change) body.push(...wrap(`+ ${JSON.stringify(key)}: ${plain(JSON.stringify(change.value))}`, inner).map(c.green));
      else if (was === MISSING) body.push(...wrap(`  ${JSON.stringify(key)}: back to its default`, inner).map(c.grey));
    }
    body.push(...wrap("`factory settings pr` opens the PR · `factory settings unstage [<key>]` discards · " +
      "`factory settings validate` checks · .claude/factory.json is protected: you merge it", inner).map(c.grey));
  }
  const edge = c.amber;
  const line = "─".repeat(Math.max(cols - 2, 0));
  return [edge(`┌${line}┐`), ...body.map((b) => `${edge("│")} ${b}${" ".repeat(Math.max(inner - width(b), 0))} ${edge("│")}`),
    edge(`└${line}┘`)];
}

const KEYS = "edit: `factory settings set --stage <key> <value>` · full help: `factory settings help <key>` · " +
  "back to default: `factory settings unset --stage <key>` · search: / here · open the PR: `factory settings pr` · " +
  "this machine: `factory settings --local set <key> <value>`, saved at once · agents can't open this view";

/** The view as lines, each at most `cols` wide. */
export function render(cols: number, color: boolean): string[] {
  const c = paint(color);
  const [data] = store.readProject();
  const machine = store.readMachine();
  const found = loadStaged();
  const staged = "changes" in found ? found.changes : {};
  const problem = "problem" in found ? found.problem : "";
  const repo = plain(repoKey());
  const title = `${c.amber(c.bold("factory"))} ${c.grey(`${repo} · Settings`)}`;
  const source = "factory settings · values from main, this machine's file, defaults";
  const out: string[] = [];
  if (cols >= width(title) + source.length + 4) out.push(title + " ".repeat(cols - width(title) - source.length) + c.grey(source));
  else out.push(title, ...wrap(source, cols).map(c.grey));
  out.push(...wrap("◆ a change to it is the owner's decision · (pending) staged, not on main yet", cols).map(c.grey), "");
  if (cols >= WIDE) {
    out.push(c.grey(`  ${pad("setting", KEY_W - 2)}${pad("value", VALUE_W - 1)} ${pad("from", FROM_W - 1)} what it does`));
  }
  out.push(c.bold("PROJECT (via PR)"));
  for (const [slug, name] of SECTIONS) {
    const rows = Object.values(SETTINGS).filter((s) => s.section === slug).map((s) => projectRow(data, staged, s));
    if (!rows.length) continue;
    out.push(c.amber(cut(`── ${name} `.padEnd(Math.min(cols, 60), "─"), cols)), ...tableLines(rows, cols, c));
  }
  out.push("", c.bold(cut(`THIS MACHINE (direct) · ${plain(hostname())} · ${repo}`, cols)));
  out.push(...tableLines(Object.values(MACHINE).map((s) => machineRow(machine, s)), cols, c), "");
  out.push(...box(problem ? null : staged, problem, data, cols, c), "");
  out.push(...wrap(KEYS, cols).map(c.grey));
  return out;
}

export function settingsView(args: string[]): number {
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    if (name in process.env) {
      refuse("cockpit_agent_session", `The Settings view is the owner's, and ${name} is set, so this looks like an agent session.`,
        "Open it from the cockpit in your own terminal (`factory cockpit`, then 6), or run `factory cockpit --settings` there.");
    }
  }
  const color = args.includes("--color") && !("NO_COLOR" in process.env);
  console.log(render(columns(), color).join("\n"));
  return 0;
}
