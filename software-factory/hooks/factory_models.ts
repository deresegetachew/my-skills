#!/usr/bin/env -S bun --no-env-file
// The `models` setting: which model (and effort) each factory role runs on (#94).
//
//   "models": {"builder": {"model": "opus", "effort": "high"}, "manager": {"model": "sonnet"},
//              "product-owner": {"model": "opus"},
//              "reviewer": {"model": "sonnet", "escalateTo": "opus"}, "test-writer": {"model": "haiku"}}
//
// No entry for a role = today's behaviour: a subagent keeps the `model:` in its agent file, and the builder and the
// manager keep Claude Code's own default. Nothing changes until a project sets a value.
//
// How a value reaches Claude Code (the spike, #94):
//   - builder, manager, product-owner: `claude --model <m> --effort <e>`. They are the coding agent, the dev manager and
//     the product owner (`factory <role> loop`, #102).
//   - subagents: `claude --agents <json>` redefines the agent of that name for the session, and beats the project's
//     `.claude/agents/<name>.md` (a symlink into the kit, which stays untouched). It replaces the whole definition, so the
//     JSON carries the file's own prompt, tools and description with only `model` changed. The env var
//     CLAUDE_CODE_SUBAGENT_MODEL does not do it: it loses to the file's `model:`, and with
//     CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 it forces ONE model on every subagent, not one per role.
//
//   bun --no-env-file .claude/hooks/factory_models.ts flags <role>   one argument per line, for factory-loop.sh and `factory agent`
//   bun --no-env-file .claude/hooks/factory_models.ts escalate       the model the reviewer is asked again on (models.reviewer.escalateTo, else opus)
//   bun --no-env-file .claude/hooks/factory_models.ts table          the effective model per role and what set it (factory doctor)
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { load } from "./factory_config.ts";
import { pyRepr, runMain } from "./factory_lib.ts";

export const SUBAGENTS = ["test-writer", "reviewer", "architecture-reviewer", "safety-auditor", "security-reviewer"] as const;
/** The sessions the loops start; the rest are their subagents. */
export const SESSION_ROLES = ["builder", "manager", "product-owner"] as const;
export const ROLES: readonly string[] = [...SESSION_ROLES, ...SUBAGENTS];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** An alias or a full id; never an option-looking word. */
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:\[\]@/-]*$/;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The kit's agent files: <hooks>/../agents in a project, or ../kit/.claude/agents run from software-factory/hooks (#112). */
export function agentsDir(): string {
  const base = dirname(import.meta.dir);
  const near = join(base, "agents");
  return isDir(near) ? near : join(base, "kit", ".claude", "agents");
}

/** One role's entry in the `models` setting. */
export interface ModelEntry {
  model?: string;
  effort?: string;
  escalateTo?: string;
}
export type Models = { [role: string]: ModelEntry };

/** A bad `models` value (Python's ValueError): the message says what is wrong and what to do. */
export class ModelsError extends Error {}

function shown(value: unknown): string {
  if (typeof value === "string") return pyRepr(value);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkName(role: string, field: string, value: unknown): void {
  if (typeof value !== "string" || !WORD.test(value)) {
    throw new ModelsError(`models.${role}.${field} must be a model name such as sonnet, opus or a full model id; got ${shown(value)}.`);
  }
}

/** The setting's value, or ModelsError saying what is wrong and what to do. */
export function validate(models: unknown): Models {
  if (!isObject(models)) throw new ModelsError('models takes an object: {"builder": {"model": "opus"}}.');
  for (const [role, entry] of Object.entries(models)) {
    if (!ROLES.includes(role)) throw new ModelsError(`models.${role}: not a role. Roles: ${ROLES.join(", ")}.`);
    if (!isObject(entry)) throw new ModelsError(`models.${role} takes an object, e.g. {"model": "sonnet"}.`);
    let allowed = (SESSION_ROLES as readonly string[]).includes(role) ? ["model", "effort"] : ["model"];
    if (role === "reviewer") allowed = ["model", "escalateTo"];
    for (const field of Object.keys(entry)) {
      if (!allowed.includes(field)) {
        throw new ModelsError(`models.${role}.${field}: not a field of ${role}. Fields: ${[...allowed].sort().join(", ")}.`);
      }
    }
    if (Object.keys(entry).length && !("model" in entry) && !("escalateTo" in entry)) throw new ModelsError(`models.${role} needs a model.`);
    if ("model" in entry) checkName(role, "model", entry.model);
    if ("escalateTo" in entry) checkName(role, "escalateTo", entry.escalateTo);
    if ("effort" in entry && !(EFFORTS as readonly unknown[]).includes(entry.effort)) {
      throw new ModelsError(`models.${role}.effort takes one of ${EFFORTS.join(", ")}; got ${shown(entry.effort)}.`);
    }
  }
  return models as Models;
}

/** The project's `models` setting, checked. */
export function configured(): Models {
  const cfg = load();
  return validate(cfg.models === undefined ? {} : cfg.models);
}

/** [fields, body] of a kit agent file, or null when the project has no such file. */
export function frontmatter(role: string): [Record<string, string>, string] | null {
  let text: string;
  try {
    text = readFileSync(join(agentsDir(), `${role}.md`), "utf8");
  } catch {
    return null;
  }
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)/.exec(text);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const l of (m[1] as string).split(/\r\n|\r|\n/)) {
    const i = l.indexOf(":");
    if (i >= 0) fields[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return [fields, m[2] as string];
}

function entryOf(models: Models, role: string): ModelEntry {
  return models[role] ?? {};
}

/** `--agents <json>`: the agents whose model the project sets, with their own prompt, tools and description. */
export function agentFlags(models: Models): string[] {
  const out: Record<string, { description: string; prompt: string; model: string; tools?: string[] }> = {};
  for (const role of SUBAGENTS) {
    const model = entryOf(models, role).model;
    const parsed = model ? frontmatter(role) : null;
    if (!parsed || !model) continue;
    const [fields, body] = parsed;
    const agent: { description: string; prompt: string; model: string; tools?: string[] } =
      { description: fields.description ?? "", prompt: body.replace(/^\n+/, ""), model };
    if (fields.tools) agent.tools = fields.tools.split(",").map((t) => t.trim()).filter(Boolean);
    out[role] = agent;
  }
  return Object.keys(out).length ? ["--agents", JSON.stringify(out)] : [];
}

/** The `claude` arguments for a session of this role. Empty when the project sets nothing. */
export function flags(role: string, models: Models): string[] {
  const entry = (SESSION_ROLES as readonly string[]).includes(role) ? entryOf(models, role) : {};
  const args: string[] = [];
  if (entry.model) args.push("--model", entry.model);
  if (entry.effort) args.push("--effort", entry.effort);
  // Subagents are started by the loops' sessions, so these carry the subagent settings.
  return [...args, ...agentFlags(models)];
}

/** [model, where it came from] as Claude Code would pick it without a call, or null when nothing readable says.
 * Order: ANTHROPIC_MODEL, then the `model` key of the project's .claude/settings.local.json and settings.json, then
 * the user's ~/.claude/settings.json. Reads only that key and never prints another. */
export function resolvedDefault(projectDir = "."): [string, string] | null {
  const env = (process.env.ANTHROPIC_MODEL ?? "").trim();
  if (env) return [env, "ANTHROPIC_MODEL in the environment"];
  const home = process.env.HOME || homedir();
  const files: [string, string][] = [
    [join(projectDir, ".claude", "settings.local.json"), ".claude/settings.local.json"],
    [join(projectDir, ".claude", "settings.json"), ".claude/settings.json"],
    [join(home, ".claude", "settings.json"), "~/.claude/settings.json"],
  ];
  for (const [path, where] of files) {
    let value: unknown;
    try {
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isObject(data)) continue;
      value = data.model;
    } catch {
      continue;
    }
    if (typeof value === "string" && value.trim()) return [value.trim(), `\`model\` in ${where}`];
  }
  return null;
}

/** [role, model, source] per role. */
export function table(models: Models): [string, string, string][] {
  const rows: [string, string, string][] = [];
  for (const role of ROLES) {
    const model = entryOf(models, role).model;
    if (role === "product-owner" && !model) continue; // shown once a project gives the product owner a model
    if (model) rows.push([role, model, "setting `models` in .claude/factory.json"]);
    else if ((SUBAGENTS as readonly string[]).includes(role)) {
      const parsed = frontmatter(role);
      const fm = parsed ? parsed[0].model : undefined;
      rows.push([role, fm || "(no model:)", fm ? "agent file" : "Claude Code default"]);
    } else rows.push([role, "Claude Code default", "Claude Code default"]);
  }
  return rows;
}

export function main(argv: string[]): number {
  let models: Models;
  try {
    models = configured();
  } catch (e) {
    if (!(e instanceof ModelsError) && !(e instanceof SyntaxError)) throw e;
    process.stderr.write(`factory: ${e.message} Fix it with \`factory settings set models '<json>'\`.\n`);
    return 1;
  }
  if (argv[0] === "flags" && argv.length === 2 && (SESSION_ROLES as readonly string[]).includes(argv[1] as string)) {
    const args = flags(argv[1] as string, models);
    if (args.length) process.stdout.write(args.join("\n") + "\n");
    return 0;
  }
  if (argv[0] === "escalate") {
    // the model the reviewer is asked again on, after a must-fix or an unsure item
    process.stdout.write((entryOf(models, "reviewer").escalateTo || "opus") + "\n");
    return 0;
  }
  if (argv[0] === "table") {
    for (const [role, model, source] of table(models)) process.stdout.write(`${role.padEnd(22)} ${model.padEnd(22)} ${source}\n`);
    return 0;
  }
  process.stderr.write("usage: factory_models.ts flags builder|manager|product-owner | escalate | table\n");
  return 2;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
