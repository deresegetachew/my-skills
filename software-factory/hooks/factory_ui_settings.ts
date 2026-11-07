// The web UI's Factory settings (#456, design docs/design/web-ui/Settings.dc.html, Releases.dc.html and
// Maintenance.dc.html), served by factory_ui_server.ts. Every change runs a factory command in the project's folder on
// this machine and answers at once:
//
//   GET  /api/projects/:p/settings                 the team, every project setting (factory_settings_schema.ts) with
//                                                  its plain name, help and where its value comes from, this machine's
//                                                  settings, what is staged, the open settings pull request, the pin
//   POST /api/projects/:p/settings/stage {key, value | unset: true}
//                                                  `factory settings set --stage <key> <value>` (or `unset --stage <key>`)
//   POST /api/projects/:p/settings/unstage {key?}  `factory settings unstage [<key>]`
//   POST /api/projects/:p/settings/pr {confirm}    `factory settings pr --ready`: the staged changes as one pull request
//   POST /api/projects/:p/settings/machine {key, value | unset: true}
//                                                  `factory settings --local set|unset ...`: saved at once, never staged
//   POST /api/projects/:p/settings/team {name}     add a coding agent: stages `agents` with the name at the end
//   POST /api/projects/:p/settings/team/:name/remove {confirm}
//                                                  stages `agents` (or the role's names) without it; refused while it
//                                                  runs (409 ui_agent_running) or holds a task (409 ui_agent_holds_task)
//   GET  /api/projects/:p/settings/release         `factory version --json`: what runs here, the newest, a running update
//   POST /api/projects/:p/settings/update {confirm} starts `factory update` (202); the release read says how it went
//   POST /api/projects/:p/settings/maintenance/:id {confirm}, .../:id/preview
//                                                  clean (`factory clean`), ci-clean (`factory ci clean [--apply]`) and
//                                                  reset-run (`factory reset-run [--apply]`)
//
// Bad input is refused (400, {code, message, fix}) before anything runs. The board's address is never sent: only that
// one is set. Run as a script in a project's folder (`bun factory_ui_settings.ts read`), this file prints what GET reads.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGENDS } from "./factory_ui_add.ts";
import { type ActionResult, type Agent, envFor, factoryScript, type Obj, resultOf, spawn, type UiProject } from "./factory_ui_data.ts";
import { compareTags } from "./factory_release.ts";
import { MACHINE, parse, type Setting, SettingError, SETTINGS } from "./factory_settings_schema.ts";

/** The settings shown first, under "The main ones". */
export const MAIN_KEYS = ["mainBranch", "commands.test", "commands.lint", "tasks.source", "protected", "tasks.staleHours", "manager.claimMinutes"];
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ROLES = ["dev-manager", "product-owner"];
const READ_MS = 60_000;
const ACTION_MS = 120_000;
const UPDATE_MS = 30 * 60_000;
const VALUE_MAX = 8000;

/** What the server gives this file: the project's agents as they run now. */
export interface SettingsHost {
  agents: () => Promise<Agent[]>;
  /** Something changed: read the live state again. */
  changed: () => void;
}

interface Team {
  agents: { name: string; role: string }[];
  /** The names once the staged changes are in (what an add or a remove builds on). */
  next: Record<string, string[]>;
}

interface Read {
  team: Team;
  problems: Obj[];
  [k: string]: unknown;
}

interface Update {
  state: "running" | "done" | "failed";
  startedAt: string;
  output: string;
}

const updates = new Map<string, Update>();

function problem(status: number, code: string, message: string, fix: string): ActionResult {
  return { status, body: { code, message, fix } };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function bodyOf(req: Request): Promise<Obj> {
  try {
    const b = (await req.json()) as unknown;
    return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Obj) : {};
  } catch {
    return {};
  }
}

const CONFIRM_FIX = 'Send {"confirm": true} (the page asks you first).';

/** Runs `factory <args>` in project `p`: 200 with its output, else 500 with what went wrong. */
async function factory(p: UiProject, args: string[], ms = ACTION_MS): Promise<ActionResult> {
  const r = await spawn(["bash", factoryScript(p), ...args], p.path, envFor(p), ms);
  return resultOf(p, `factory ${args.join(" ")}`, r, (r.stdout + r.stderr).trim());
}

/** What GET reads, by this file run as a script in the project's folder (so the git and machine paths are its own). */
async function readOf(p: UiProject): Promise<Read | ActionResult> {
  const r = await spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "factory_ui_settings.ts"), "read"],
    p.path, envFor(p), READ_MS);
  try {
    const data = JSON.parse(r.stdout) as Read;
    if (r.code === 0 && data.team) return data;
  } catch {
    // said below
  }
  const last = (r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? "";
  return problem(500, "ui_settings_unreadable", `The settings of ${p.name} can't be read (${last.slice(0, 200) || `exit ${r.code}`}).`,
    `Check that ${p.path}/.claude/factory.json is valid JSON, then reload the page.`);
}

function isRead(x: Read | ActionResult): x is Read {
  return "team" in x;
}

/** The raw text a person typed for setting `s`, checked; or the 400 to answer. */
function checked(s: Setting, value: unknown, agents: string[] | null): string | ActionResult {
  const raw = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  if (raw === null || raw.length > VALUE_MAX) {
    return problem(400, "settings_bad_value", `${s.label} needs a value.`, "Type a value, or use Back to the default.");
  }
  if (raw.startsWith("--")) {
    return problem(400, "settings_bad_value", `${s.label} can't start with two dashes.`, "Change the value so it doesn't start with --.");
  }
  try {
    parse(s, raw, agents);
  } catch (e) {
    if (!(e instanceof SettingError)) throw e;
    return problem(400, "settings_bad_value", `${s.label} ${e.message}`, "Change the value and try again; the setting's help says what it takes.");
  }
  return raw;
}

function setting(table: Record<string, Setting>, key: unknown, machine: boolean): Setting | ActionResult {
  const k = str(key);
  if (k && Object.hasOwn(table, k)) return table[k] as Setting;
  return problem(400, "settings_unknown_key", `${k || "That"} isn't ${machine ? "one of this machine's settings" : "a project setting"}.`,
    machine ? "Pick a setting from This machine." : "Pick a setting the page lists; this machine's own are under This machine.");
}

function isResult(x: unknown): x is ActionResult {
  return typeof x === "object" && x !== null && "status" in x && "body" in x;
}

async function stage(req: Request, p: UiProject): Promise<ActionResult> {
  const b = await bodyOf(req);
  const s = setting(SETTINGS, b.key, false);
  if (isResult(s)) return s;
  if (b.unset === true) return factory(p, ["settings", "unset", "--stage", s.key]);
  const raw = checked(s, b.value, null);
  if (typeof raw !== "string") return raw;
  return factory(p, ["settings", "set", "--stage", s.key, raw]);
}

async function machine(req: Request, p: UiProject): Promise<ActionResult> {
  const b = await bodyOf(req);
  const s = setting(MACHINE, b.key, true);
  if (isResult(s)) return s;
  if (b.unset === true) return factory(p, ["settings", "--local", "unset", s.key]);
  const agents = Array.isArray(p.config?.agents) ? p.config.agents.filter((n): n is string => typeof n === "string") : [];
  const raw = checked(s, b.value, agents);
  if (typeof raw !== "string") return raw;
  return factory(p, ["settings", "--local", "set", s.key, raw]);
}

function everyone(team: Team): string[] {
  return [...new Set([...team.agents.map((a) => a.name), ...Object.values(team.next).flat()])];
}

async function addAgent(req: Request, p: UiProject): Promise<ActionResult> {
  const name = str((await bodyOf(req)).name).trim();
  if (!AGENT_NAME.test(name)) {
    return problem(400, "ui_bad_agent_name", `${name ? `"${name.slice(0, 50)}"` : "An empty name"} isn't a valid agent name.`,
      "Use lowercase letters, digits and dashes, starting with a letter or digit, at most 40 characters; or pick a free name.");
  }
  const read = await readOf(p);
  if (!isRead(read)) return read;
  if (everyone(read.team).includes(name)) {
    return problem(400, "ui_agent_taken", `${name} is already on ${p.name}'s team.`, "Pick another name; the free ones are listed.");
  }
  return factory(p, ["settings", "set", "--stage", "agents", JSON.stringify([...(read.team.next["coding-agent"] ?? []), name])]);
}

async function removeAgent(req: Request, p: UiProject, name: string, host: SettingsHost): Promise<ActionResult> {
  const read = await readOf(p);
  if (!isRead(read)) return read;
  const role = Object.keys(read.team.next).find((r) => (read.team.next[r] ?? []).includes(name));
  if (!role || !AGENT_NAME.test(name)) {
    return problem(404, "ui_agent_unknown", `${name.slice(0, 50)} isn't on ${p.name}'s team.`, "Your team lists the agents.");
  }
  if ((await bodyOf(req)).confirm !== true) {
    return problem(400, "confirm_needed", `Removing ${name} changes the team, so it needs a confirm.`, CONFIRM_FIX);
  }
  const names = read.team.next[role] ?? [];
  if (role !== "coding-agent" && names.length <= 1) {
    return problem(400, "ui_last_of_role", `${name} is ${p.name}'s only ${role === "dev-manager" ? "dev manager" : "product owner"}.`,
      "Add another name for the role first, then remove this one.");
  }
  const agent = (await host.agents()).find((a) => a.name === name);
  if (agent && agent.state !== "down") {
    return problem(409, "ui_agent_running", `${name} is running${agent.machineName ? ` on ${agent.machineName}` : ""}.`,
      `Stop ${name} first (its page has Stop), then remove it.`);
  }
  if (agent?.task) {
    return problem(409, "ui_agent_holds_task", `${name} still holds #${agent.task}.`,
      `Release #${agent.task} first, so it goes back to Ready for another agent, then remove ${name}.`);
  }
  const key = role === "coding-agent" ? "agents" : `roles.${role}.names`;
  return factory(p, ["settings", "set", "--stage", key, JSON.stringify(names.filter((n) => n !== name))]);
}

function tagOf(v: unknown): string | null {
  const t = typeof v === "object" && v !== null ? (v as Obj).tag : null;
  return typeof t === "string" ? t : null;
}

async function release(p: UiProject): Promise<ActionResult> {
  const r = await spawn(["bash", factoryScript(p), "version", "--json"], p.path, envFor(p), READ_MS);
  const update = updates.get(p.id) ?? null;
  let info: Obj | null = null;
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    if (typeof parsed === "object" && parsed !== null) info = parsed as Obj;
  } catch {
    // said below
  }
  if (!info) {
    const last = (r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? "";
    return { status: 200, body: { project: p.id, installed: null, pinned: null, newest: null, newer: false, update,
      problems: [{ code: "ui_release_unreadable", message: `The versions can't be read (${last.slice(0, 200) || `exit ${r.code}`}).`,
        fix: "Check that this machine can reach GitHub (the Machines page shows it), then reload the page." }] } };
  }
  const installed = tagOf(info.installed);
  const newest = tagOf(info.newest);
  let newer = false;
  try {
    newer = installed !== null && newest !== null && compareTags(newest, installed) > 0;
  } catch {
    newer = false;
  }
  return { status: 200, body: { project: p.id, installed, pinned: tagOf(info.pinned), newest, prerelease: tagOf(info.prerelease),
    newer, update, problems: [] } };
}

function startUpdate(p: UiProject): ActionResult {
  if (updates.get(p.id)?.state === "running") {
    return problem(409, "ui_update_running", "An update of this project is already running.", "Wait for it to end; this page shows how it went.");
  }
  const run: Update = { state: "running", startedAt: new Date().toISOString(), output: "" };
  updates.set(p.id, run);
  void spawn(["bash", factoryScript(p), "update"], p.path, envFor(p), UPDATE_MS).then((r) => {
    run.output = (r.stdout + r.stderr).trim().slice(-20_000);
    run.state = r.code === 0 ? "done" : "failed";
  });
  return { status: 202, body: { ok: true, command: "factory update", update: run } };
}

/** The clean-ups (Maintenance): what runs, and what lists without changing (null: it has no preview). */
const CLEANUPS: Record<string, { apply: string[]; preview: string[] | null }> = {
  clean: { apply: ["clean"], preview: null },
  "ci-clean": { apply: ["ci", "clean", "--apply"], preview: ["ci", "clean"] },
  "reset-run": { apply: ["reset-run", "--apply"], preview: ["reset-run"] },
};

async function maintenance(req: Request, p: UiProject, id: string, preview: boolean): Promise<ActionResult> {
  const c = Object.hasOwn(CLEANUPS, id) ? CLEANUPS[id] : undefined;
  if (!c || (preview && !c.preview)) {
    return problem(404, "not_found", preview ? `${id.slice(0, 40)} has no preview.` : `There is no clean-up ${id.slice(0, 40)}.`,
      `The clean-ups: ${Object.keys(CLEANUPS).join(", ")}; ci-clean and reset-run have a preview.`);
  }
  if (preview) return factory(p, c.preview as string[]);
  if ((await bodyOf(req)).confirm !== true) return problem(400, "confirm_needed", "A clean-up removes things, so it needs a confirm.", CONFIRM_FIX);
  return factory(p, c.apply);
}

/** The answer to `/api/projects/:p/settings[/...]` (`rest` starts with "settings"). */
export async function settingsApi(req: Request, p: UiProject, rest: string[], host: SettingsHost): Promise<ActionResult> {
  const [, what = "", name = "", verb = ""] = rest;
  const get = req.method === "GET";
  if (rest.length === 1 && get) {
    const read = await readOf(p);
    if (!isRead(read)) return read;
    const used = everyone(read.team);
    return { status: 200, body: { project: p.id, ...read, team: { ...read.team, free: LEGENDS.filter((n) => !used.includes(n)) } } };
  }
  if (rest.length === 2 && what === "release" && get) return release(p);
  if (get) return problem(405, "method_not_allowed", "GET isn't used here.", "Use POST.");
  if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET or POST.");
  let out: ActionResult | null = null;
  if (rest.length === 2 && what === "stage") out = await stage(req, p);
  else if (rest.length === 2 && what === "machine") out = await machine(req, p);
  else if (rest.length === 2 && what === "unstage") {
    const key = (await bodyOf(req)).key;
    if (key === undefined) out = await factory(p, ["settings", "unstage"]);
    else {
      const s = setting(SETTINGS, key, false);
      out = isResult(s) ? s : await factory(p, ["settings", "unstage", s.key]);
    }
  } else if (rest.length === 2 && what === "pr") {
    out = (await bodyOf(req)).confirm !== true
      ? problem(400, "confirm_needed", "Proposing the staged changes opens a pull request, so it needs a confirm.", CONFIRM_FIX)
      : await factory(p, ["settings", "pr", "--ready"], 180_000);
  } else if (rest.length === 2 && what === "team") out = await addAgent(req, p);
  else if (rest.length === 4 && what === "team" && verb === "remove") out = await removeAgent(req, p, name, host);
  else if (rest.length === 2 && what === "update") {
    out = (await bodyOf(req)).confirm !== true
      ? problem(400, "confirm_needed", "Updating changes the factory's files in this project, so it needs a confirm.", CONFIRM_FIX)
      : startUpdate(p);
  } else if ((rest.length === 3 || (rest.length === 4 && verb === "preview")) && what === "maintenance") {
    out = await maintenance(req, p, name, rest.length === 4);
  }
  if (!out) return problem(404, "not_found", `There is no /settings/${rest.slice(1).join("/")}.`, "See factory_ui_settings.ts for the settings API.");
  if (out.status < 300) host.changed();
  return out;
}

// --- the read, run in the project's folder -------------------------------------------------------------------------------

async function readHere(): Promise<Read> {
  const schema = await import("./factory_settings_schema.ts");
  const store = await import("./factory_settings_store.ts");
  const staged = await import("./factory_settings_staged.ts");
  const fm = await import("./factory_machine.ts");
  const { run } = await import("./factory_lib.ts");
  const problems: Obj[] = [];
  const [data] = store.readProject();
  const found = staged.loadStaged();
  const changes = "changes" in found ? found.changes : {};
  if ("problem" in found) {
    problems.push({ code: "ui_settings_staged_damaged", message: `The staged changes can't be read: ${found.problem}.`,
      fix: "Drop the staged changes (Drop all), then stage them again." });
  }
  const valueOf = (key: string): unknown => {
    const here = schema.lookup(data, key);
    return here === schema.MISSING ? (schema.SETTINGS[key] as Setting).default : here;
  };
  const rowOf = (s: Setting): Obj => {
    const here = schema.lookup(data, s.key);
    const st = Object.hasOwn(changes, s.key) ? changes[s.key] : undefined;
    return { key: s.key, name: s.label, help: s.short, kind: s.kind, options: s.options, value: here === schema.MISSING ? s.default : here,
      default: s.default, from: st ? "staged" : here === schema.MISSING ? "default" : "main", staged: st ?? null, needs: s.needs,
      main: MAIN_KEYS.includes(s.key) };
  };
  const all = Object.values(schema.SETTINGS);
  const sections = schema.SECTIONS.map(([id, title]) => ({ id, title, rows: all.filter((s) => s.section === id).map(rowOf) }))
    .filter((s) => s.rows.length);

  // the team: as main has it, and once the staged changes are in
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && AGENT_NAME.test(n)) : []);
  const now: Record<string, string[]> = { "coding-agent": names(valueOf("agents")) };
  for (const role of ROLES) now[role] = names(valueOf(`roles.${role}.names`));
  const next: Record<string, string[]> = {};
  for (const [role, list] of Object.entries(now)) {
    const key = role === "coding-agent" ? "agents" : `roles.${role}.names`;
    const st = Object.hasOwn(changes, key) ? changes[key] : undefined;
    next[role] = st ? ("value" in st ? names(st.value) : names((schema.SETTINGS[key] as Setting).default)) : list;
  }
  const agents = [...ROLES, "coding-agent"].flatMap((role) => (now[role] ?? []).map((name) => ({ name, role })));

  // this machine: never the board's address, only whether one is set
  const own = fm.machineSettings();
  const env = (process.env.FACTORY_AGENTS ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  const fromFile = Array.isArray(own.agents) && own.agents.length > 0;
  const machineRows = Object.values(schema.MACHINE).map((s) => ({ key: s.key, name: s.label, help: s.short, kind: s.kind, options: s.options,
    value: s.key in own ? own[s.key] : s.default, default: s.default, from: s.key in own ? "machine" : "default", staged: null, needs: "", main: false }));
  const board = Boolean(process.env.MB_URL) || existsSync(join(fm.configDir(), "message-board", "url"));

  const pin = (() => {
    try {
      const raw = JSON.parse(readFileSync(join(".claude", "factory", "release.json"), "utf8")) as Obj;
      return typeof raw.tag === "string" ? raw.tag : null;
    } catch {
      return null;
    }
  })();
  const dirty = run(["git", "status", "--porcelain"]).stdout.trim() !== "";

  // the open settings pull request (`factory settings pr` names its branches settings/...)
  let pr: Obj | null = null;
  const gh = run(["gh", "api", "repos/{owner}/{repo}/pulls?state=open&per_page=100"]);
  try {
    const pulls = JSON.parse(gh.stdout) as Obj[];
    if (gh.code !== 0 || !Array.isArray(pulls)) throw new Error(gh.stderr);
    const mine = pulls.find((x) => str((x.head as Obj | undefined)?.ref).startsWith("settings/"));
    if (mine) pr = { number: mine.number, url: str(mine.html_url), title: str(mine.title) };
  } catch {
    problems.push({ code: "ui_settings_pr_unknown", message: "Whether a settings pull request is open can't be read from GitHub.",
      fix: "Check that this machine is signed in to GitHub (the Machines page shows it), then reload the page." });
  }

  return {
    team: { agents, next },
    sections,
    staged: { changes: Object.entries(changes).map(([key, c]) => ({ key, name: schema.SETTINGS[key]?.label ?? key,
      ...("value" in c ? { value: c.value } : { unset: true }) })), problem: "problem" in found ? found.problem : null },
    machine: { agents: env.length ? env : fromFile ? fm.machineNames() : [], from: env.length ? "env" : fromFile ? "machine" : "project", board,
      rows: machineRows },
    release: { pinned: pin },
    dirty,
    pr,
    problems,
  };
}

if (import.meta.main) {
  const { runMain } = await import("./factory_lib.ts");
  await runMain(async () => {
    if (process.argv[2] !== "read") throw new Error("usage: factory_ui_settings.ts read");
    console.log(JSON.stringify(await readHere()));
  });
}
