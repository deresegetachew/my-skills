// The interactive `factory settings` (#49): a plain-terminal menu to browse, understand and change settings.
//
// Only line input and printing, so it works over SSH, in a plain TTY and from a script that feeds stdin. Changes are
// held in memory until `s` reviews them (a unified diff) and saves; quitting, or the input ending, writes nothing.
//
//   main menu      a number opens a section, /text searches names and descriptions, s saves, q quits
//   a section      a number opens a setting, b goes back
//   a setting      c change, r reset to default, ? help, b back
//   lists, objects add / edit / remove one item at a time; regex lists can be tested against example paths
import { existsSync, readSync } from "node:fs";
import { load } from "./factory_config.ts";
import { Exit, pyRepr } from "./factory_lib.ts";
import { checkedNames } from "./factory_machine.ts";
import { openPr } from "./factory_settings_save.ts";
import {
  asText, checkValue, DEFAULT_REVIEW, DEFAULTS, hint, lookup, MACHINE, MISSING, type Missing, NEEDS, parse, pyEqual,
  SECTION_TITLE, SECTIONS, type Setting, SettingError, SETTINGS, validateAll,
} from "./factory_settings_schema.ts";
import * as store from "./factory_settings_store.ts";

class Quit extends Error {}

type Data = store.Data;

function clone<T>(v: T): T {
  return structuredClone(v);
}

class State {
  project: Data = {};
  indent: store.Indent = 2;
  machine: Data = {};
  origProject: Data = {};
  origMachine: Data = {};

  constructor() {
    this.reload();
  }

  reload(): void {
    [this.project, this.indent] = store.readProject();
    this.machine = store.readMachine();
    this.origProject = clone(this.project);
    this.origMachine = clone(this.machine);
  }

  data(scope: string): Data {
    return scope === "machine" ? this.machine : this.project;
  }

  dirty(): boolean {
    return !pyEqual(this.project, this.origProject) || !pyEqual(this.machine, this.origMachine);
  }
}

// --- reading lines (Python's input()) -----------------------------------------------------------------------------

let pending = Buffer.alloc(0);
let ended = false;

/** One line from stdin without its newline, or null at the end of the input. */
function readLine(): string | null {
  for (;;) {
    const nl = pending.indexOf(10);
    if (nl >= 0) {
      const line = pending.subarray(0, nl).toString("utf8");
      pending = pending.subarray(nl + 1);
      return line.replace(/\r$/, "");
    }
    if (ended) {
      if (!pending.length) return null;
      const line = pending.toString("utf8");
      pending = Buffer.alloc(0);
      return line;
    }
    const chunk = Buffer.alloc(4096);
    let n = 0;
    try {
      n = readSync(0, chunk, 0, chunk.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Bun.sleepSync(20);
        continue;
      }
      if (code === "EOF") n = 0;
      else throw e;
    }
    if (n === 0) ended = true;
    else pending = Buffer.concat([pending, chunk.subarray(0, n)]);
  }
}

function ask(prompt: string): string {
  process.stdout.write(prompt);
  const line = readLine();
  if (line === null) {
    console.log();
    throw new Quit();
  }
  return line.trim();
}

function isDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

function valueOf(st: State, s: Setting): unknown | Missing {
  return s.scope === "project" ? lookup(st.data(s.scope), s.key) : (s.key in st.machine ? st.machine[s.key] : MISSING);
}

function shortValue(value: unknown): string {
  const text = asText(value);
  return [...text].length <= 60 ? text : [...text].slice(0, 57).join("") + "...";
}

function status(st: State, s: Setting): [string, string] {
  const here = valueOf(st, s);
  if (here === MISSING) return [shortValue(s.default), "(default)"];
  if (pyEqual(here, s.default)) return [shortValue(here), "(same as the default)"];
  return [shortValue(here), `(default ${shortValue(s.default)}, overridden)`];
}

function describe(st: State, s: Setting, n: number | null = null): void {
  const [shown, flag] = status(st, s);
  const head = n ? `${String(n).padStart(3)}  ` : "";
  console.log(`${head}${s.key.padEnd(32)} ${shown}  ${flag}`);
  console.log(`${" ".repeat(n ? 5 : 0)}${" ".repeat(32)} ${s.short}`);
}

function search(text: string): Setting[] {
  const needle = text.trim().toLowerCase();
  const found: Setting[] = [];
  for (const table of [SETTINGS, MACHINE]) {
    for (const s of Object.values(table)) {
      if (needle && (s.key.toLowerCase().includes(needle) || s.short.toLowerCase().includes(needle))) found.push(s);
    }
  }
  return found;
}

/** Runs `action`; when it stops (an Exit), prints its message and returns true. */
function sayRefusal(action: () => void): boolean {
  try {
    action();
    return false;
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    console.log(e.text ?? "");
    return true;
  }
}

function projectAgents(st: State): string[] {
  const names = st.project.agents;
  return Array.isArray(names) ? (names as string[]) : DEFAULTS.agents;
}

// --- help -------------------------------------------------------------------------------------------------------

export function helpText(s: Setting, current: unknown | Missing = MISSING): string {
  const lines = [s.key + (s.scope === "machine" ? "  (this machine only)" : ""), `  ${s.short}`];
  if (s.long) lines.push("", "  " + s.long);
  lines.push("", `  Type: ${s.kind}` + (s.options ? ` (${s.options.join(", ")})` : "") + `; takes ${hint(s)}.`,
    `  Default: ${asText(s.default)}`);
  if (current !== MISSING) lines.push(`  Here: ${asText(current)}`);
  lines.push(`  Section: ${SECTION_TITLE[s.section]}`);
  lines.push(`  Read by: ${s.readBy}.`);
  if (s.scope === "project") lines.push(`  A change needs: ${s.needs ? s.needs + ". Also: " : ""}${DEFAULT_REVIEW}`);
  else lines.push(`  A change needs: ${s.needs}.`);
  const dflt = s.default;
  const examples = s.examples.length ? s.examples
    : (s.scope === "project" && !emptyLike(dflt) ? [`factory settings set ${s.key} ${asText(dflt)}`] : []);
  for (const ex of examples) lines.push(`  Example: ${ex}`);
  return lines.join("\n");
}

/** Python's `default in (None, "", [], {})`. */
function emptyLike(dflt: unknown): boolean {
  return dflt === null || dflt === undefined || dflt === "" || (Array.isArray(dflt) && !dflt.length) ||
    (typeof dflt === "object" && dflt !== null && !Array.isArray(dflt) && !Object.keys(dflt).length);
}

// --- changing a value -----------------------------------------------------------------------------------------

function noteIfMissingPath(s: Setting, value: unknown): void {
  if (["prd", "plan", "blocked", "decisions"].includes(s.key) && value && !existsSync(value as string)) {
    console.log(`  Note: ${String(value)} doesn't exist here.`);
  }
}

function commitValue(st: State, s: Setting, value: unknown): boolean {
  try {
    checkValue(s, value, s.scope === "machine" ? projectAgents(st) : null);
  } catch (e) {
    if (!(e instanceof SettingError)) throw e;
    console.log(`  ${s.key}: ${e.message}`);
    return false;
  }
  if (s.scope === "machine") st.machine[s.key] = value;
  else store.assign(st.project, s.key, value);
  console.log(`  ${s.key} is now ${shortValue(value)} (not saved yet; s saves).`);
  return true;
}

/** True when the person is done with this setting (changed it or left an editor); false when they cancelled. */
function change(st: State, s: Setting): boolean {
  if (sayRefusal(store.refuseInAgentSession)) return false;
  if (s.kind === "list") return editList(st, s);
  if (s.kind === "dict") return editDict(st, s);
  for (;;) {
    const raw = ask(`New value for ${s.key} (${hint(s)}; blank cancels) > `);
    if (raw === "") return false;
    let value: unknown;
    try {
      value = parse(s, raw);
    } catch (e) {
      if (!(e instanceof SettingError)) throw e;
      console.log(`  ${s.key} ${e.message}`);
      continue;
    }
    noteIfMissingPath(s, value);
    if (commitValue(st, s, value)) return true;
  }
}

function currentValue(st: State, s: Setting): unknown {
  const here = valueOf(st, s);
  return clone(here === MISSING ? s.default : here);
}

function parseItem(s: Setting, raw: string): unknown {
  if (s.items === "json") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new SettingError(`takes a JSON value, e.g. {"paths": [...]}; got ${pyRepr(raw)}.`);
    }
  }
  return raw;
}

function showItems(items: unknown[]): void {
  if (!items.length) console.log("  (empty)");
  items.forEach((item, i) => console.log(`  ${String(i + 1).padStart(2)}  ${typeof item === "string" ? item : asText(item)}`));
}

function testRegexes(items: unknown[]): void {
  console.log("  Type example paths, separated by spaces; blank stops.");
  for (;;) {
    const line = ask("Paths to test > ");
    if (!line) return;
    for (const path of line.split(/\s+/).filter(Boolean)) {
      const hits: number[] = [];
      items.forEach((rx, i) => {
        if (typeof rx === "string" && new RegExp(rx).test(path)) hits.push(i + 1);
      });
      if (hits.length) console.log(`  ${path}  matches ` + hits.map((i) => `${i} (${String(items[i - 1])})`).join(", "));
      else console.log(`  ${path}  no match`);
    }
  }
}

function itemNumber(items: unknown[], prompt: string): number | null {
  const raw = ask(prompt);
  if (isDigits(raw) && Number(raw) >= 1 && Number(raw) <= items.length) return Number(raw) - 1;
  if (raw) console.log(`  Choose a number from 1 to ${items.length}.`);
  return null;
}

function editList(st: State, s: Setting): boolean {
  let items = currentValue(st, s) as unknown[];
  for (;;) {
    console.log(`${s.key} (${items.length} items)`);
    showItems(items);
    const menu = "[a]dd, [e]dit N, [r]emove N, [w] replace all (JSON)" + (s.regex ? ", [t]est paths" : "") + ", [b]ack > ";
    const c = ask(menu).toLowerCase();
    let next: unknown[] | null = null;
    if (c === "b" || c === "") return true;
    else if (c === "a") {
      const raw = ask("Item to add (blank cancels) > ");
      if (raw) {
        try {
          next = [...items, parseItem(s, raw)];
        } catch (e) {
          if (!(e instanceof SettingError)) throw e;
          console.log(`  ${e.message}`);
        }
      }
    } else if (c === "e" && items.length) {
      const i = itemNumber(items, "Item number to edit > ");
      if (i !== null) {
        const raw = ask("New value (blank cancels) > ");
        if (raw) {
          try {
            next = [...items.slice(0, i), parseItem(s, raw), ...items.slice(i + 1)];
          } catch (e) {
            if (!(e instanceof SettingError)) throw e;
            console.log(`  ${e.message}`);
          }
        }
      }
    } else if (c === "r" && items.length) {
      const i = itemNumber(items, "Item number to remove > ");
      if (i !== null) next = [...items.slice(0, i), ...items.slice(i + 1)];
    } else if (c === "w") {
      const raw = ask("New list as JSON (blank cancels) > ");
      if (raw) {
        try {
          next = parse(s, raw, s.scope === "machine" ? projectAgents(st) : null) as unknown[];
        } catch (e) {
          if (!(e instanceof SettingError)) throw e;
          console.log(`  ${s.key} ${e.message}`);
        }
      }
    } else if (c === "t" && s.regex) testRegexes(items);
    else console.log("  Not a choice here.");
    if (next !== null && commitValue(st, s, next)) items = next;
  }
}

function editDict(st: State, s: Setting): boolean {
  let obj = currentValue(st, s) as Record<string, unknown>;
  for (;;) {
    console.log(`${s.key} (${Object.keys(obj).length} entries)`);
    for (const [k, v] of Object.entries(obj)) console.log(`  ${k}: ${typeof v === "string" ? v : asText(v)}`);
    if (!Object.keys(obj).length) console.log("  (empty)");
    const c = ask("[a]dd or change a key, [r]emove a key, [w] replace all (JSON), [b]ack > ").toLowerCase();
    let next: Record<string, unknown> | null = null;
    if (c === "b" || c === "") return true;
    else if (c === "a") {
      const key = ask("Key (blank cancels) > ");
      const raw = key ? ask(`Value for ${key} > `) : "";
      if (key && raw) {
        next = { ...obj, [key]: raw };
        try {
          checkValue(s, next);
        } catch (e) {
          if (!(e instanceof SettingError)) throw e;
          try {
            next[key] = JSON.parse(raw); // an object or number: models take objects
          } catch {
            // keep the text
          }
        }
      }
    } else if (c === "r" && Object.keys(obj).length) {
      const key = ask("Key to remove > ");
      if (key in obj) next = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
      else if (key) console.log(`  There is no key ${key}.`);
    } else if (c === "w") {
      const raw = ask("New object as JSON (blank cancels) > ");
      if (raw) {
        try {
          next = parse(s, raw) as Record<string, unknown>;
        } catch (e) {
          if (!(e instanceof SettingError)) throw e;
          console.log(`  ${s.key} ${e.message}`);
        }
      }
    } else console.log("  Not a choice here.");
    if (next !== null && commitValue(st, s, next)) obj = next;
  }
}

function reset(st: State, s: Setting): boolean {
  if (sayRefusal(store.refuseInAgentSession)) return false;
  if (s.scope === "machine") delete st.machine[s.key];
  else store.remove(st.project, s.key);
  console.log(`  ${s.key} is back to its default, ${shortValue(s.default)} (not saved yet; s saves).`);
  return true;
}

// --- menus --------------------------------------------------------------------------------------------------------

function quitOk(st: State): boolean {
  if (!st.dirty()) return true;
  return ["y", "yes"].includes(ask("You have unsaved changes. Discard them and quit? [y/N] ").toLowerCase());
}

function settingMenu(st: State, s: Setting): void {
  for (;;) {
    console.log();
    describe(st, s);
    const c = ask("[c]hange, [r]eset to default, [?] help, [b]ack > ").toLowerCase();
    if (c === "b" || c === "") return;
    if (c === "c") {
      if (change(st, s)) return;
    } else if (c === "r") {
      if (reset(st, s)) return;
    } else if (c === "?") {
      console.log();
      console.log(helpText(s, valueOf(st, s)));
    } else if (c === "s") save(st);
    else if (c === "q") {
      if (quitOk(st)) throw new Quit();
    } else console.log("  Not a choice here: c, r, ?, b.");
  }
}

function listing(st: State, entries: Setting[], heading: string): void {
  for (;;) {
    console.log();
    console.log(heading);
    entries.forEach((s, i) => describe(st, s, i + 1));
    const c = ask("Number to open, /text to search, s to save, b to go back, q to quit > ");
    const low = c.toLowerCase();
    if (low === "b" || low === "") return;
    if (low === "q") {
      if (quitOk(st)) throw new Quit();
    } else if (low === "s") save(st);
    else if (c.startsWith("/")) {
      const found = search(c.slice(1));
      if (found.length) listing(st, found, `Matches for ${pyRepr(c.slice(1).trim())}:`);
      else console.log(`  No setting matches ${pyRepr(c.slice(1).trim())}.`);
    } else if (isDigits(c) && Number(c) >= 1 && Number(c) <= entries.length) settingMenu(st, entries[Number(c) - 1] as Setting);
    else console.log(`  Choose a number from 1 to ${entries.length}.`);
  }
}

function sectionEntries(slug: string): Setting[] {
  return [...Object.values(SETTINGS), ...Object.values(MACHINE)].filter((s) => s.section === slug);
}

function mainMenu(st: State): void {
  for (;;) {
    console.log();
    console.log(`Factory settings (${store.PATH}; this machine: ${store.machinePath()})`);
    SECTIONS.forEach(([slug, title], i) => console.log(`  ${String(i + 1).padStart(2)}  ${title}  (${sectionEntries(slug).length})`));
    const c = ask("Choose a number, /text to search, s to review and save, q to quit > ");
    const low = c.toLowerCase();
    if (low === "q") {
      if (quitOk(st)) return;
    } else if (low === "s") save(st);
    else if (c.startsWith("/")) {
      const found = search(c.slice(1));
      if (found.length) listing(st, found, `Matches for ${pyRepr(c.slice(1).trim())}:`);
      else console.log(`  No setting matches ${pyRepr(c.slice(1).trim())}.`);
    } else if (isDigits(c) && Number(c) >= 1 && Number(c) <= SECTIONS.length) {
      const [slug, title] = SECTIONS[Number(c) - 1] as [string, string, string];
      listing(st, sectionEntries(slug), title);
    } else if (c) console.log(`  Choose a number from 1 to ${SECTIONS.length}, or / to search, s to save, q to quit.`);
  }
}

// --- saving -------------------------------------------------------------------------------------------------------

function save(st: State): void {
  if (sayRefusal(store.refuseInAgentSession)) return;
  const projectChanged = !pyEqual(st.project, st.origProject);
  const machineChanged = !pyEqual(st.machine, st.origMachine);
  if (!(projectChanged || machineChanged)) {
    console.log("  Nothing to save.");
    return;
  }
  if (projectChanged) {
    const [errors] = validateAll(st.project);
    const old = store.dump(st.origProject, st.indent);
    const now = store.dump(st.project, st.indent);
    console.log();
    console.log(store.unifiedDiff(old, now, store.PATH).replace(/\n+$/, ""));
    const flagged = store.changes(st.origProject, st.project).filter(([k]) => k in NEEDS);
    if (flagged.length) {
      console.log("\nThese changes need a review:");
      for (const [key] of flagged) console.log(`  ${key}: ${NEEDS[key]}`);
    }
    console.log(`\n${DEFAULT_REVIEW}`);
    if (errors.length) {
      console.log("\nThese would not pass `factory settings validate`:");
      for (const e of errors) console.log(`  ${e}`);
      if (!["y", "yes"].includes(ask("Save anyway? [y/N] ").toLowerCase())) return;
    }
  }
  if (machineChanged) {
    console.log(`\nThis machine's file ${store.machinePath()} (not committed):`);
    console.log(store.unifiedDiff(store.dump(st.origMachine), store.dump(st.machine), "machine.json").replace(/\n+$/, ""));
    if ("agents" in st.machine && !pyEqual(st.machine.agents, st.origMachine.agents)) {
      try {
        checkedNames(load(), (st.machine.agents as string[]).join(","), "factory settings --local set agents");
      } catch (e) {
        if (!(e instanceof Exit)) throw e;
        console.log("  Not saved: fix the agent names first.");
        return;
      }
    }
  }
  const c = projectChanged
    ? ask("\nSave how? [w] write the file only, [b] branch and pull request, [c] cancel > ").toLowerCase()
    : ask("\nSave to this machine's file? [w] yes, [c] cancel > ").toLowerCase();
  if (c === "w") {
    writeAll(st, projectChanged, machineChanged);
    console.log("Saved." + (projectChanged ? ` Commit ${store.PATH} on a branch and merge it in a pull request (\`factory settings pr\` does it; the owner merges it).` : ""));
    st.origProject = clone(st.project);
    st.origMachine = clone(st.machine);
  } else if (c === "b" && projectChanged) {
    const kind = ask("Open the pull request as a [d]raft or [r]eady? [D/r] > ").toLowerCase();
    writeAll(st, true, machineChanged);
    try {
      openPr(!["r", "ready"].includes(kind));
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      console.log(e.text ?? "");
      console.log(`  ${store.PATH} is written here; fix the problem and run \`factory settings pr\`.`);
      return;
    }
    st.reload();
  } else console.log("  Not saved.");
}

function writeAll(st: State, project: boolean, machine: boolean): void {
  if (project) store.writeProject(st.project, st.indent);
  if (machine) store.writeMachine(st.machine);
}

export function run(): void {
  const st = new State();
  console.log("Browse, explain and change the factory's settings. Nothing is written until you save (s).");
  try {
    mainMenu(st);
  } catch (e) {
    if (!(e instanceof Quit)) throw e;
  }
  if (st.dirty()) console.log("Unsaved changes were discarded.");
}
