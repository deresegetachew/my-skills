#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The sign-off and testing queue (#101): what only a person can check, and the tests of the running app.
//
// One issue, "Sign-off and testing queue" (pin it), holds one comment per item. The state of an item is read from the
// comments after it, so nothing is edited and a second run changes nothing.
//
//   factory signoff ls [--all] [--json]       open items (--all: finished ones too), one line each
//   factory signoff add <id> --task N --check "how to check it"
//                                             a task's "Done when" needs a person: say how they check it
//   factory signoff plan <id> [--task N] (--file PLAN.md | --text "...")
//                                             the product owner's test plan for the running app; proposed until confirmed
//   factory signoff confirm <id> [--by NAME]  the owner says this is what gets tested (a revised plan needs it again)
//   factory signoff result <id> pass|fail|blocked [--note "..."] [--build REF] [--by NAME]
//                                             record a result; a test plan takes one only once it is confirmed
//   add other options: --dry-run prints the comment and posts nothing
//
// States: a sign-off item is open, passed or failed. A test plan is proposed (waits for the owner), confirmed (waits for a
// run), passed, failed or blocked. Whether a plan is run by a scripted browser or by Claude driving a browser is not
// decided; this file only keeps the plans, the confirmations and the results, whoever or whatever produced them.
// Read and written through the GitHub REST API (`gh api`).
import { readFileSync } from "node:fs";
import type { Config } from "./factory_config.ts";
import * as fi from "./factory_issues.ts";
import { Exit, die, parseArgs, pyDumps, pyInt, runMain } from "./factory_lib.ts";

export const TITLE = "Sign-off and testing queue";
const ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
const MARK = /<!--\s*factory-(signoff-result|signoff|testplan-confirm|testplan|testresult)\b([^>]*?)-->/;
const ATTR = /([A-Za-z][\w-]*)=(\S+)/g;
export const RESULTS = ["pass", "fail", "blocked"] as const;
const WORD: Record<string, string> = { pass: "passed", fail: "failed", blocked: "blocked" };

export type Result = [result: string, by: string, note: string];

export interface Item {
  kind: "signoff" | "testplan";
  id: string;
  task: string | null;
  text: string;
  confirmed: boolean;
  results: Result[];
  state: string;
}

/** The number of the open queue issue (made on demand when `create`), else null. */
export function queue(create = false): number | null {
  for (const i of fi.ghAll<fi.Issue>("repos/{owner}/{repo}/issues?state=open")) {
    if (i.title === TITLE && !("pull_request" in i)) return i.number;
  }
  if (!create) return null;
  const made = fi.gh<{ number: number }>("POST", "repos/{owner}/{repo}/issues", {
    title: TITLE,
    body: "Things only a person can check, and the tests of the running app. One comment per item " +
      "(`factory signoff add|plan|confirm|result`). Pin this issue. The state of an item is read from the " +
      "comments after it; nothing is edited." });
  return made.number;
}

/** {id: item} from the queue's comments, in the order the items first appeared. */
export function read(comments: fi.Comment[]): Map<string, Item> {
  const items = new Map<string, Item>();
  for (const c of comments) {
    const body = c.body || "";
    const m = MARK.exec(body);
    if (!m) continue;
    const what = m[1] as string;
    const attrs: Record<string, string> = {};
    for (const a of (m[2] as string).matchAll(ATTR)) attrs[a[1] as string] = a[2] as string;
    const i = attrs.id;
    if (!i) continue;
    const text = body.replace(new RegExp(MARK.source, "g"), "").trim();
    if (what === "signoff" || what === "testplan") {
      if (what === "signoff" && items.has(i)) continue; // the first entry stands
      // a revised test plan replaces the old one: it has to be confirmed again and its results start over
      items.set(i, { kind: what, id: i, task: attrs.task ?? null, text, confirmed: false, results: [], state: "" });
    } else if (items.has(i)) {
      const it = items.get(i) as Item;
      if (what === "testplan-confirm" && it.kind === "testplan") it.confirmed = true;
      else if ((what === "signoff-result" || what === "testresult") && (RESULTS as readonly string[]).includes(attrs.result ?? "")) {
        if (it.kind === "testplan" && !it.confirmed) continue; // a result for a plan nobody confirmed counts for nothing
        it.results.push([attrs.result as string, attrs.by ?? "", text]);
      }
    }
  }
  for (const it of items.values()) {
    const last = it.results.length ? (it.results[it.results.length - 1] as Result)[0] : null;
    if (it.kind === "signoff") it.state = last === "pass" || last === "fail" ? (WORD[last] as string) : "open";
    else it.state = last ? (WORD[last] as string) : it.confirmed ? "confirmed" : "proposed";
  }
  return items;
}

export function openItems(items: Map<string, Item>): Item[] {
  return [...items.values()].filter((it) => ["open", "proposed", "confirmed"].includes(it.state));
}

export function line(it: Item): string {
  const first = (it.text.split(/\r?\n/)[0] ?? "").slice(0, 90);
  const task = it.task ? ` task #${it.task}` : "";
  const kind = it.kind === "signoff" ? "sign-off" : "test plan";
  return `${it.id}: ${kind} ${it.state}${task}: ${first}`;
}

/** Lines for the product owner's work list: what waits on the owner or on a test run. Reads GitHub only. */
export function digest(_cfg?: Config): string[] {
  const n = queue();
  if (!n) return [];
  const items = read(fi.ghAll<fi.Comment>(`repos/{owner}/{repo}/issues/${n}/comments`));
  const out: string[] = [];
  for (const it of openItems(items)) {
    if (it.kind === "testplan" && it.state === "proposed") out.push(`test plan ${it.id} waits for the owner to confirm (queue #${n})`);
    else if (it.kind === "testplan") out.push(`test plan ${it.id} is confirmed and not run yet (queue #${n})`);
  }
  const signoffs = openItems(items).filter((it) => it.kind === "signoff");
  if (signoffs.length) {
    const one = signoffs.length === 1;
    out.push(`${signoffs.length} sign-off item${one ? "" : "s"} ${one ? "waits" : "wait"} for a person (queue #${n})`);
  }
  return out;
}

function who(by: string | undefined): string {
  const given = by || process.env.FACTORY_AGENT;
  return (given || fi.gh<{ login?: string } | null>("GET", "user")?.login || "unknown").replace(/[^\w.-]/g, "");
}

function post(dryRun: boolean, marker: string, text = ""): void {
  const body = `${marker}\n${text}`.trimEnd() + "\n";
  if (dryRun) {
    console.log("would post to the sign-off and testing queue:\n" + body);
    return;
  }
  const n = queue(true) as number;
  fi.comment(n, body);
  console.log(`posted to the sign-off and testing queue (#${n}).`);
}

function failWith(msg: string, fix: string): never {
  die(`factory signoff: ${msg}\n  fix: ${fix}`);
}

const PROG = "factory signoff";
const USAGE = "usage: factory signoff [-h] {ls,add,plan,confirm,result} ...";

function usageError(usage: string, text: string): never {
  process.stderr.write(`${usage}\n${text}\n`);
  throw new Exit(2);
}

function intArg(usage: string, prog: string, name: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v) ? pyInt(v) : null;
  if (n === null) usageError(usage, `${prog}: error: argument ${name}: invalid int value: '${String(v)}'`);
  return n;
}

export function main(argv: string[]): void {
  const cmd = argv[0];
  const cmds = ["ls", "add", "plan", "confirm", "result"];
  if (cmd === undefined) usageError(USAGE, `${PROG}: error: the following arguments are required: cmd`);
  if (!cmds.includes(cmd)) {
    usageError(USAGE, `${PROG}: error: argument cmd: invalid choice: '${cmd}' (choose from ${cmds.map((c) => `'${c}'`).join(", ")})`);
  }
  const rest = argv.slice(1);
  if (cmd === "ls") {
    const a = parseArgs(rest, { flags: ["--all", "--json"] }, `${PROG} ls`, `usage: ${PROG} ls [-h] [--all] [--json]`);
    const n = queue();
    const items = n ? read(fi.ghAll<fi.Comment>(`repos/{owner}/{repo}/issues/${n}/comments`)) : new Map<string, Item>();
    const shown = a.all ? [...items.values()] : openItems(items);
    if (a.json) {
      console.log(pyDumps(shown.map((it) => ({ kind: it.kind, id: it.id, task: it.task, text: it.text, confirmed: it.confirmed,
        results: it.results, state: it.state })), { indent: 2 }));
    } else {
      console.log(shown.map(line).join("\n") || "nothing waits in the sign-off and testing queue");
    }
    return;
  }
  const prog = `${PROG} ${cmd}`;
  const spec = {
    add: { valued: ["--by", "--task", "--check"], flags: ["--dry-run"], positionals: ["id"], required: ["--task", "--check"],
      usage: `usage: ${prog} [-h] [--dry-run] [--by BY] --task TASK --check CHECK id` },
    plan: { valued: ["--by", "--task", "--file", "--text"], flags: ["--dry-run"], positionals: ["id"],
      usage: `usage: ${prog} [-h] [--dry-run] [--by BY] [--task TASK] [--file FILE] [--text TEXT] id` },
    confirm: { valued: ["--by"], flags: ["--dry-run"], positionals: ["id"], usage: `usage: ${prog} [-h] [--dry-run] [--by BY] id` },
    result: { valued: ["--by", "--note", "--build"], flags: ["--dry-run"], positionals: ["id", "outcome"],
      usage: `usage: ${prog} [-h] [--dry-run] [--by BY] [--note NOTE] [--build BUILD] id {pass,fail,blocked}` },
  }[cmd as "add" | "plan" | "confirm" | "result"];
  const a = parseArgs(rest, spec, prog, spec.usage);
  const id = String(a.id);
  const task = intArg(spec.usage, prog, "--task", a.task);
  if (cmd === "result" && !(RESULTS as readonly string[]).includes(String(a.outcome))) {
    usageError(spec.usage, `${prog}: error: argument outcome: invalid choice: '${String(a.outcome)}' (choose from 'pass', 'fail', 'blocked')`);
  }
  const dryRun = Boolean(a["dry-run"]);
  const by = a.by as string | undefined;
  if (!ID.test(id)) failWith(`'${id}' is not an id.`, "use letters, digits, dots and dashes, for example login-flow-2");
  const n = queue();
  const items = n ? read(fi.ghAll<fi.Comment>(`repos/{owner}/{repo}/issues/${n}/comments`)) : new Map<string, Item>();
  const it = items.get(id);
  if (cmd === "add") {
    if (it) failWith(`'${id}' is already in the queue (${it.state}).`, "pick another id, or record a result for it");
    post(dryRun, `<!-- factory-signoff id=${id} task=${task} -->`, `To check: ${String(a.check)}`);
  } else if (cmd === "plan") {
    const text = a.file ? readFileSync(a.file as string, "utf8") : (a.text as string | undefined);
    if (!text) failWith("a plan needs its steps.", "pass --file PLAN.md or --text \"...\"");
    if (it && it.kind === "signoff") failWith(`'${id}' is a sign-off item, not a test plan.`, "pick another id");
    const taskAttr = task ? ` task=${task}` : it && it.task ? ` task=${it.task}` : "";
    post(dryRun, `<!-- factory-testplan id=${id}${taskAttr} -->`, text.trim());
  } else if (cmd === "confirm") {
    if (!it || it.kind !== "testplan") failWith(`there is no test plan '${id}'.`, "see `factory signoff ls`");
    if (it.confirmed && !it.results.length) {
      console.log(`${id} is already confirmed.`);
      return;
    }
    post(dryRun, `<!-- factory-testplan-confirm id=${id} by=${who(by)} -->`, `Confirmed by ${who(by)}: this is what gets tested.`);
  } else {
    if (!it) failWith(`there is no item '${id}'.`, "see `factory signoff ls`");
    if (it.kind === "testplan" && !it.confirmed) {
      failWith(`test plan '${id}' is not confirmed, so a result for it counts for nothing.`,
        `the owner confirms it first: factory signoff confirm ${id}`);
    }
    const marker = it.kind === "testplan" ? "testresult" : "signoff-result";
    const outcome = String(a.outcome);
    if (it.kind === "signoff" && outcome === "blocked") failWith("a sign-off item is passed or failed.", "use pass or fail");
    const build = a.build ? String(a.build).replace(/[^\w.-]/g, "") : "";
    const at = a.build ? ` build=${build}` : "";
    post(dryRun, `<!-- factory-${marker} id=${id} result=${outcome} by=${who(by)}${at} -->`, (a.note as string | undefined) ?? "");
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
