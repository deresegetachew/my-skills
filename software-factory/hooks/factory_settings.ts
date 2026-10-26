#!/usr/bin/env -S bun --no-env-file
// `factory settings`: browse, understand and change the factory's settings (.claude/factory.json) without editing JSON.
//
//   factory settings                       the interactive menu in a terminal; elsewhere (a pipe, a script) the list
//   factory settings interactive           the menu, even when stdin is a pipe (a scripted session)
//   factory settings list [--section S] [--json]
//                                          every setting: value, default, whether it is overridden, what it does
//   factory settings get <key>             just the value, as JSON (dotted keys: tasks.source, commands.test)
//   factory settings set <key> <value>     change it; checked against the setting's type and limits (JSON for lists/objects)
//   factory settings unset <key>           back to the default (the key leaves the file)
//   factory settings help [<key>]          the long help for one setting, or the list of sections
//   factory settings diff                  what the project file sets differently from the defaults
//   factory settings validate              exit 1 with clear messages when a value is wrong (usable in CI)
//   factory settings pr [--ready]          propose the edited .claude/factory.json as a pull request (a draft by default)
//   factory settings docs [--check|--write] [--file F]
//                                          the settings page's tables (docs/wiki/settings.md), generated from the metadata table
//   factory settings --local ...           the same commands for this machine's own settings (outside the repo)
//
// The table that describes every setting is factory_settings_schema.ts; the list, help, validate, the menu and the
// settings page all come from it. `set`, `unset`, `pr` and saving in the menu only write files: `.claude/` is
// protected, so a project change goes to main through a pull request, which the owner merges (#247). Only people change
// settings: inside an agent session (FACTORY_AGENT, FACTORY_LOOP or CLAUDECODE set) they refuse, because the PR gate
// itself reads these settings.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { load } from "./factory_config.ts";
import { die as stop, Exit, pyDumps, runMain } from "./factory_lib.ts";
import { checkedNames } from "./factory_machine.ts";
import * as schema from "./factory_settings_schema.ts";
import { asText, MISSING, type Missing, pyEqual, type Setting, SettingError } from "./factory_settings_schema.ts";
import * as store from "./factory_settings_store.ts";

export const PATH = store.PATH;
/** The table of project settings, for callers of the older module (key -> Setting). */
export const SETTINGS = schema.SETTINGS;

/** The default of a project setting, as `factory_config.ts` has it. */
export function defaultOf(key: string): unknown {
  return (schema.SETTINGS[key] as Setting).default;
}

const VALUE_FLAGS = ["--section", "--file"];
export const USAGE = "usage: factory settings [--local] [list [--section S] [--json] | get <key> | set <key> <value> | unset <key> | " +
  "help [<key>] | diff | validate | interactive | pr [--ready] | docs [--check|--write]]";

function die(message: string): never {
  stop(`factory settings: ${message}`);
}

function parseArgs(argv: string[]): [Set<string>, Record<string, string>, string[]] {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (VALUE_FLAGS.includes(a)) {
      if (i + 1 >= argv.length) die(`${a} needs a value. ${USAGE}`);
      values[a] = argv[++i] as string;
    } else if (a.startsWith("--") && a.includes("=") && VALUE_FLAGS.includes(a.split("=")[0] as string)) {
      values[a.split("=")[0] as string] = a.slice(a.indexOf("=") + 1);
    } else if (["--local", "--json", "--draft", "--ready", "--check", "--write", "-i"].includes(a)) flags.add(a);
    else rest.push(a);
  }
  return [flags, values, rest];
}

function known(key: string, local: boolean): Setting {
  const table = schema.tableOf(local);
  const found = table[key];
  if (!found) {
    const head = key.split(".")[0];
    const near = Object.keys(table).filter((k) => head === k.split(".")[0]);
    const hint = near.length && near.length < 15 ? ` Settings under \`${head}\`: ${near.join(", ")}.` : "";
    const scope = !local && key in schema.MACHINE ? "a machine setting (--local)"
      : local && key in schema.SETTINGS ? "a project setting (leave out --local)" : "a setting";
    die(`\`${key}\` isn't ${scope}.${hint} \`factory settings${local ? " --local" : ""}\` lists them all.`);
  }
  return found;
}

/** [data, indent] of the scope's file. */
function readScope(local: boolean): [store.Data, store.Indent] {
  return local ? [store.readMachine(), 2] : store.readProject();
}

function valueIn(data: store.Data, s: Setting): unknown | Missing {
  return s.scope === "machine" ? (s.key in data ? data[s.key] : MISSING) : schema.lookup(data, s.key);
}

interface Row {
  key: string;
  section: string;
  scope: string;
  type: string;
  value: unknown;
  default: unknown;
  overridden: boolean;
  set: boolean;
  description: string;
  needs: string;
}

function row(data: store.Data, s: Setting): Row {
  const here = valueIn(data, s);
  const dflt = s.default;
  return { key: s.key, section: s.section, scope: s.scope, type: s.kind, value: here === MISSING ? dflt : here, default: dflt,
    overridden: here !== MISSING && !pyEqual(here, dflt), set: here !== MISSING,
    description: s.short + (s.options ? ` Options: ${s.options.join(", ")}.` : ""), needs: s.needs };
}

function flagOf(r: Row): string {
  if (r.overridden) return `(default ${asText(r.default)}, overridden)`;
  return r.set ? "(same as the default)" : "(default)";
}

function otherKeys(data: store.Data): string[] {
  return Object.keys(data).filter((k) => !k.startsWith("_") &&
    !Object.keys(schema.SETTINGS).some((s) => s === k || s.startsWith(k + ".")));
}

function cmdList(data: store.Data, local: boolean, section: string | undefined, asJson: boolean): void {
  let slug: string | null = null;
  if (section) {
    slug = schema.sectionOf(section);
    if (!slug) die(`\`${section}\` isn't a section. Sections: ` + schema.SECTIONS.map(([s, t]) => `${s} (${t})`).join(", ") + ".");
  }
  const rows = Object.values(schema.tableOf(local)).filter((s) => !slug || s.section === slug).map((s) => row(data, s));
  if (asJson) {
    console.log(pyDumps(rows, { indent: 2, ensureAscii: false }));
    return;
  }
  const where = local ? store.machinePath() : PATH;
  console.log(`Factory settings (${where}). \`factory settings help <key>\` for one in full.\n`);
  for (const r of rows) {
    let shown = asText(r.value);
    if ([...shown].length > 70) shown = [...shown].slice(0, 67).join("") + "...";
    console.log(`${r.key.padEnd(34)} ${shown}  ${flagOf(r)}`);
    console.log(`${"".padEnd(34)} ${r.description}`);
  }
  if (!local) {
    const other = otherKeys(data);
    if (other.length) console.log(`\nOther keys in ${PATH}, kept as they are: ${other.join(", ")}`);
    if (!slug) console.log("\nThis machine's own settings (" + Object.keys(schema.MACHINE).join(", ") + "): `factory settings --local`.");
  }
}

async function cmdHelp(local: boolean, key: string | undefined): Promise<void> {
  if (!key) {
    console.log("Sections (`factory settings list --section <name>`; `factory settings help <key>` for one setting):\n");
    for (const [slug, title] of schema.SECTIONS) {
      const n = [...Object.values(schema.SETTINGS), ...Object.values(schema.MACHINE)].filter((s) => s.section === slug).length;
      console.log(`  ${slug.padEnd(9)} ${title}  (${n} settings)`);
    }
    return;
  }
  const s = local || !(key in schema.MACHINE) || key in schema.SETTINGS ? known(key, local) : known(key, true);
  const { helpText } = await import("./factory_settings_interactive.ts");
  const [data] = readScope(s.scope === "machine");
  console.log(helpText(s, valueIn(data, s)));
}

function cmdShow(data: store.Data, local: boolean, key: string): void {
  const s = known(key, local);
  const here = valueIn(data, s);
  console.log(s.key);
  console.log(`  ${s.short}`);
  console.log(`  type: ${s.kind}` + (s.options ? ` (${s.options.join(", ")})` : ""));
  console.log(`  default: ${asText(s.default)}`);
  console.log(`  here: ${here === MISSING ? "(default)" : asText(here)}`);
  console.log(`  More: factory settings help ${s.key}`);
}

function cmdGet(data: store.Data, local: boolean, key: string): void {
  const s = known(key, local);
  const here = valueIn(data, s);
  console.log(asText(here === MISSING ? s.default : here));
}

function projectAgents(): string[] {
  const [data] = store.readProject();
  return Array.isArray(data.agents) ? (data.agents as string[]) : schema.DEFAULTS.agents;
}

function cmdSet(data: store.Data, indent: store.Indent, local: boolean, key: string, raw: string): void {
  const s = known(key, local);
  store.refuseInAgentSession();
  let value: unknown;
  try {
    value = schema.parse(s, raw, local ? projectAgents() : null);
  } catch (e) {
    if (!(e instanceof SettingError)) throw e;
    die(`\`${key}\` ${e.message}`);
  }
  if (local) {
    if (key === "agents") checkedNames(load(), (value as string[]).join(","), "factory settings --local set agents");
    data[key] = value;
    const path = store.writeMachine(data);
    console.log(`${key} = ${asText(value)} in ${path} (this machine only, not committed).`);
    return;
  }
  store.assign(data, key, value);
  store.writeProject(data, indent);
  console.log(`${key} = ${asText(value)} in ${PATH}. Commit it on a branch and merge it in a pull request ` +
    "(`factory settings pr` does that; the owner merges it).");
  if (key === "permissions.allow") {
    // #251: the agents obey .claude/settings.json, so say when the rule takes effect.
    console.log("The agents read their allow rules from .claude/settings.json, not from here: `factory settings pr` also " +
      "writes these rules there, in the same pull request, so they apply once the owner merges it.");
  }
}

function cmdUnset(data: store.Data, indent: store.Indent, local: boolean, key: string): void {
  const s = known(key, local);
  store.refuseInAgentSession();
  if (local) {
    if (key in data) {
      delete data[key];
      store.writeMachine(data);
    }
  } else if (store.remove(data, key)) store.writeProject(data, indent);
  console.log(`${key} is back to its default (${asText(s.default)}).`);
}

function cmdDiff(data: store.Data, local: boolean): void {
  const rows = Object.values(schema.tableOf(local)).map((s) => row(data, s)).filter((r) => r.overridden);
  const other = local ? [] : otherKeys(data);
  if (!rows.length && !other.length) {
    console.log("No differences: every setting has its default value.");
    return;
  }
  for (const r of rows) console.log(`${r.key}: ${asText(r.value)}  (default ${asText(r.default)})`);
  for (const k of other) console.log(`${k}: ${asText(data[k])}  (not a factory setting; kept as it is)`);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

function cmdValidate(data: store.Data, local: boolean): void {
  let errors: string[] = [];
  let warnings: string[] = [];
  if (local) {
    for (const [key, value] of Object.entries(data)) {
      const s = schema.MACHINE[key];
      if (!s) {
        warnings.push(`${key}: not a machine setting.`);
        continue;
      }
      try {
        schema.checkValue(s, value, projectAgents());
      } catch (e) {
        if (!(e instanceof SettingError)) throw e;
        errors.push(`${key}: ${e.message}`);
      }
    }
  } else [errors, warnings] = schema.validateAll(data);
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  const where = local ? store.machinePath() : PATH;
  if (errors.length) {
    process.stderr.write(`${plural(errors.length, "problem")} in ${where}. Fix each value, or \`factory settings unset <key>\` for the default.\n`);
    throw new Exit(1);
  }
  console.log(`ok: ${where} is valid` + (warnings.length ? ` (${plural(warnings.length, "warning")})` : "") + ".");
}

function cmdDocs(flags: Set<string>, values: Record<string, string>): void {
  const path = values["--file"] || join(dirname(realpathSync(import.meta.path)), "..", "docs", "wiki", "settings.md");
  const block = `${schema.README_BEGIN}\n${schema.markdown()}\n${schema.README_END}`;
  if (!(flags.has("--check") || flags.has("--write"))) {
    console.log(block);
    return;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    die(`can't read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!text.includes(schema.README_BEGIN) || !text.includes(schema.README_END)) {
    die(`${path} has no ${schema.README_BEGIN} ... ${schema.README_END} block to fill.`);
  }
  const at = text.indexOf(schema.README_BEGIN);
  const head = text.slice(0, at);
  const rest = text.slice(at + schema.README_BEGIN.length);
  const tail = rest.slice(rest.indexOf(schema.README_END) + schema.README_END.length);
  const fresh = head + block + tail;
  if (flags.has("--check")) {
    if (fresh !== text) {
      process.stderr.write(`${path}: the settings tables are out of date. Run \`factory settings docs --write --file ${path}\`.\n`);
      throw new Exit(1);
    }
    console.log(`ok: ${path} matches the settings table.`);
    return;
  }
  store.refuseInAgentSession();
  store.writeAtomic(path, fresh);
  console.log(`Wrote the settings tables into ${path}.`);
}

export async function main(argv: string[]): Promise<void> {
  const [flags, values, rest] = parseArgs(argv);
  const local = flags.has("--local");
  let cmd: string | undefined = flags.has("-i") ? "interactive" : rest[0];
  const args = rest.length && !flags.has("-i") ? rest.slice(1) : rest;
  if (cmd === undefined) cmd = process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "list";
  if (cmd === "interactive") {
    const { run } = await import("./factory_settings_interactive.ts");
    return run();
  }
  if (cmd === "docs") return cmdDocs(flags, values);
  if (cmd === "pr") {
    store.refuseInAgentSession();
    const { openPr } = await import("./factory_settings_save.ts");
    return openPr(!flags.has("--ready"));
  }
  const [data, indent] = readScope(local);
  if ((cmd === "list" || cmd === "ls") && !args.length) return cmdList(data, local, values["--section"], flags.has("--json"));
  if (cmd === "help") return cmdHelp(local, args[0]);
  if ((cmd === "show" || cmd === "options") && args.length === 1) return cmdShow(data, local, args[0] as string);
  if (cmd === "get" && args.length === 1) return cmdGet(data, local, args[0] as string);
  if (cmd === "set" && args.length === 2) return cmdSet(data, indent, local, args[0] as string, args[1] as string);
  if (cmd === "unset" && args.length === 1) return cmdUnset(data, indent, local, args[0] as string);
  if (cmd === "diff" && !args.length) return cmdDiff(data, local);
  if (cmd === "validate" && !args.length) return cmdValidate(data, local);
  stop(USAGE);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
