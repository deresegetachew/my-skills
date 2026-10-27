#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The curated lessons file (#72): a short list of one-line rules the builder and the reviewers read first, so the
// same must-fix, review finding or CI failure does not come back task after task.
//
//   factory lessons show               the lessons, one per line (what the builder and the reviewers read)
//   factory lessons check              the file is within the cap and each lesson is one line with an example or a link
//   factory lessons suggest [--last N] [--min K] [--json]
//                                      candidates from the last N task pull requests (default 20): must-fix comments and
//                                      CI failures that came back on at least K of them (default 2), plus this machine's
//                                      reviewer findings; read-only, and it skips what a lesson already says
//   factory lessons add "<rule>"       append one lesson (dev manager)
//   factory lessons prune [--apply]    lessons a hook, lint rule or check enforces now (dev manager); --apply removes them
//
// The file is `lessons` in .claude/factory.json (default .claude/factory/lessons.md), at most `lessonsCap` lessons
// (default 40). A lesson is one line that starts with "- " and holds an example or a link: a `code span`, a URL, an
// issue or PR number such as #123, or "e.g.". When a tool now enforces a lesson, say where with a tag at the end,
// `[enforced: path/to/check]`; `prune` then proposes removing it. Agents cannot edit `.claude/`: `add` and `prune` refuse
// inside an agent session, so the dev manager approves every change. Reads only through `gh api`.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { branchTask, type Config, load } from "./factory_config.ts";
import { die, pyDumps, pyInt, run, runMain, splitLines } from "./factory_lib.ts";

export const MAX_LINE = 240;
export const HEADER = `# Lessons

Short rules the builder and the reviewers read before they start. One line each, at most \`lessonsCap\` lines (40).
Each one has an example or a link. When a hook, lint rule or check enforces a rule now, tag it
\`[enforced: path/to/check]\` and \`factory lessons prune\` proposes dropping it. The dev manager changes this file:
\`factory lessons suggest\` proposes lessons, \`factory lessons add "<rule>"\` adds one.

`;
const EXAMPLE = /`[^`]+`|https?:\/\/\S+|#\d+|\be\.g\./;
const ENFORCED = /\s*\[enforced:\s*([^\]]+?)\s*\]/;
const ENFORCED_ALL = new RegExp(ENFORCED.source, "g");
const MUSTFIX = /<!--\s*factory-mustfix\b[^>]*-->/;
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)/;
const STOP = new Set(("the and for with that this are was not but from has have its into than then when what use must fix need " +
  "needs should would could add too also any all one out can").split(" "));

type Row = Record<string, unknown>;

function agentSession(): boolean {
  return ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"].some((v) => process.env[v]);
}

function fail(msg: string): number {
  process.stderr.write(`factory lessons: ${msg}\n`);
  return 1;
}

function settings(cfg: Config): [string, number] {
  const cap = pyInt(cfg.lessonsCap ?? 40) ?? 40;
  return [cfg.lessons || ".claude/factory/lessons.md", Math.max(cap, 1)];
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function lessonLines(text: string): string[] {
  return splitLines(text).filter((ln) => ln.startsWith("- "));
}

function unenforced(line: string): string {
  return line.replace(ENFORCED_ALL, "");
}

/** [line number, what is wrong] for a lessons file's text. */
export function problems(text: string): [number, string][] {
  const out: [number, string][] = [];
  let prevBullet = false;
  splitLines(text).forEach((ln, i) => {
    const n = i + 1;
    if (ln.startsWith("- ")) {
      prevBullet = true;
      if (ln.length > MAX_LINE) out.push([n, `longer than ${MAX_LINE} characters; keep a lesson to one short line`]);
      if (!EXAMPLE.test(unenforced(ln))) out.push([n, "no example or link; add a `code span`, a URL, #123 or e.g."]);
    } else if (ln.trim() && " \t".includes(ln[0] as string) && prevBullet) {
      out.push([n, "continues the lesson above; a lesson is one line"]);
    } else {
      prevBullet = false;
    }
  });
  return out;
}

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_.-]{2,}/g)) {
    let w = m[0].replace(/^[.-]+|[.-]+$/g, "");
    if (w.length > 4 && w.endsWith("s")) w = w.slice(0, -1);
    if (w.length >= 3 && !STOP.has(w) && !/^[0-9a-f]{7,}$/.test(w)) out.add(w);
  }
  return out;
}

function inter(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]).size;
  return union ? inter(a, b) / union : 0.0;
}

/** Does an existing lesson already say most of what this candidate says? */
export function covered(cand: string, known: Set<string>[]): boolean {
  const t = tokens(cand);
  return t.size > 0 && known.some((k) => inter(t, k) / t.size >= 0.6);
}

function enforcement(line: string): string | null {
  const m = ENFORCED.exec(line);
  return m ? (m[1] as string) : null;
}

/** Python's casefold for the comparison of two lessons (lowercase, ß as ss). */
function casefold(s: string): string {
  return s.toLowerCase().replace(/ß/g, "ss");
}

// ---- show, check, add, prune -------------------------------------------------------------------------------------

function cmdShow(cfg: Config): number {
  const [path] = settings(cfg);
  for (const ln of lessonLines(read(path))) process.stdout.write(ln + "\n");
  return 0;
}

function cmdCheck(cfg: Config): number {
  const [path, cap] = settings(cfg);
  const text = read(path);
  if (!text) {
    process.stdout.write(`No lessons file at ${path}: nothing to check.\n`);
    return 0;
  }
  const ls = lessonLines(text);
  let bad = 0;
  for (const [n, why] of problems(text)) {
    process.stderr.write(`factory lessons: ${path} line ${n}: ${why}\n`);
    bad += 1;
  }
  if (ls.length > cap) {
    process.stderr.write(`factory lessons: ${ls.length} lessons, over the cap of ${cap}. Fix: drop the ones a hook or check ` +
      "enforces now (factory lessons prune), or merge similar ones.\n");
    bad += 1;
  }
  process.stdout.write(`${ls.length} of ${cap} lessons (${path})\n`);
  for (const ln of ls) {
    const target = enforcement(ln);
    const short = Array.from(unenforced(ln)).slice(2, 70).join("");
    if (target && existsSync(target)) {
      process.stdout.write(`  enforced by ${target} now, so it can go (factory lessons prune): ${short}\n`);
    } else if (target) {
      process.stdout.write(`  says it is enforced by ${target}, which does not exist: ${short}\n`);
    }
  }
  return bad ? 1 : 0;
}

function write(path: string, text: string): void {
  writeFileSync(path + ".tmp", text);
  renameSync(path + ".tmp", path);
}

function cmdAdd(cfg: Config, ruleArg: string): number {
  if (agentSession()) {
    return fail("add changes .claude/, which only the dev manager does. Fix: put the lesson in a " +
      "`<!-- factory-question -->` comment on your pull request and the dev manager decides.");
  }
  const [path, cap] = settings(cfg);
  let rule = ruleArg.split(/\s+/).filter(Boolean).join(" ");
  rule = rule.startsWith("- ") ? rule.slice(2) : rule;
  const line = "- " + rule;
  let text = read(path);
  const found = problems(line);
  if (found.length) return fail(`not added: ${(found[0] as [number, string])[1]}.`);
  const existing = lessonLines(text);
  if (existing.length >= cap) {
    return fail(`not added: the file already has ${existing.length} lessons, the cap (lessonsCap) is ${cap}. ` +
      "Fix: run `factory lessons prune` or merge two lessons first.");
  }
  const fresh = tokens(unenforced(line));
  for (const ex of existing) {
    if (casefold(unenforced(ex)) === casefold(unenforced(line)) || jaccard(fresh, tokens(unenforced(ex))) >= 0.8) {
      return fail(`not added: a lesson like it is already there: ${Array.from(ex).slice(0, 100).join("")}`);
    }
  }
  if (!text) {
    text = HEADER;
    mkdirSync(dirname(path) || ".", { recursive: true });
  } else if (!text.endsWith("\n")) {
    text += "\n";
  }
  write(path, text + line + "\n");
  process.stdout.write(`Added lesson ${existing.length + 1} of ${cap}: ${line}\n`);
  return 0;
}

function cmdPrune(cfg: Config, apply: boolean): number {
  const [path] = settings(cfg);
  const text = read(path);
  const gone = lessonLines(text).filter((ln) => {
    const e = enforcement(ln);
    return e !== null && existsSync(e);
  });
  if (!gone.length) {
    process.stdout.write("Nothing to prune: no lesson names an enforcement that exists.\n");
    return 0;
  }
  for (const ln of gone) process.stdout.write(`${apply ? "removing" : "prune"}: ${ln}\n`);
  if (!apply) {
    process.stdout.write("Run `factory lessons prune --apply` (dev manager) to remove them, then commit the file in a pull request.\n");
    return 0;
  }
  if (agentSession()) return fail("prune --apply changes .claude/, which only the dev manager does.");
  write(path, splitLines(text).filter((ln) => !gone.includes(ln)).map((ln) => ln + "\n").join(""));
  return 0;
}

// ---- suggest -------------------------------------------------------------------------------------------------------

function gh(path: string): unknown {
  const p = run(["gh", "api", path]);
  if (p.code !== 0) {
    die(`factory lessons: gh api ${path.split("?")[0]} failed: ${(p.stderr || p.stdout).trim().slice(0, 200)}. ` +
      "Fix: run `gh auth status`.");
  }
  return p.stdout.trim() ? (JSON.parse(p.stdout) as unknown) : null;
}

function rows(v: unknown): Row[] {
  return Array.isArray(v) ? (v as Row[]) : [];
}

function field(v: unknown, key: string): unknown {
  return v && typeof v === "object" ? (v as Row)[key] : undefined;
}

function headRef(p: Row): string {
  return String(field(p.head, "ref") ?? "");
}

function taskPulls(last: number): Row[] {
  let out: Row[] = [];
  let page = 1;
  while (out.length < last) {
    const chunk = rows(gh(`repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`));
    out = out.concat(chunk.filter((p) => branchTask(headRef(p))));
    if (chunk.length < 100) break;
    page += 1;
  }
  return out.slice(0, Math.max(last, 0));
}

/** The separate must-fixes in a comment: its list items, or else its first line. */
export function items(body: string | null | undefined): string[] {
  const text = (body || "").replace(new RegExp(MUSTFIX.source, "g"), "").trim();
  const lines = splitLines(text);
  let found = lines.flatMap((ln) => {
    const m = ITEM.exec(ln);
    return m ? [m[1] as string] : [];
  });
  if (!found.length) found = lines.map((ln) => ln.trim()).filter(Boolean).slice(0, 1);
  return found.filter((x) => x.trim())
    .map((x) => Array.from(x.replace(/[*_]{2}|^must-fix:\s*/gi, "")).slice(0, 160).join("").trim());
}

type Facts = [ref: string, mustfix: string[], causes: string[]];

function pullFacts(p: Row): Facts {
  const n = Number(p.number);
  const branch = headRef(p);
  const mustfix: string[] = [];
  for (const c of rows(gh(`repos/{owner}/{repo}/issues/${n}/comments?per_page=100`))) {
    const body = typeof c.body === "string" ? c.body : "";
    if (MUSTFIX.test(body)) mustfix.push(...items(body));
  }
  const runs = rows(field(gh(`repos/{owner}/{repo}/actions/runs?branch=${branch.replace(/\//g, "%2F")}&per_page=100`), "workflow_runs"));
  const causes = new Set<string>();
  for (const r of runs.filter((r) => r.conclusion === "failure").slice(0, 10)) {
    for (const job of rows(field(gh(`repos/{owner}/{repo}/actions/runs/${r.id}/jobs?per_page=100`), "jobs"))) {
      if (job.conclusion !== "failure") continue;
      const steps = rows(job.steps).filter((s) => s.conclusion === "failure").map((s) => String(s.name));
      causes.add(steps.length ? `${job.name} / ${steps[0]}` : String(job.name));
    }
  }
  return [`#${n}`, mustfix, [...causes].sort()];
}

/** [branch, finding] from this machine's review records: a failing round's findings (rereview records). */
function reviewerFacts(cfg: Config): [string, string][] {
  const out: [string, string][] = [];
  const d = cfg.reviewMarkers ?? "tmp/reviews";
  let names: string[];
  try {
    names = readdirSync(d).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".reviews.json")) continue;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(d, name), "utf8"));
    } catch {
      continue;
    }
    const branch = name.slice(0, -".reviews.json".length).replace("_", "/");
    const all = data && typeof data === "object" && !Array.isArray(data) ? Object.values(data) : [];
    for (const rounds of all) {
      for (const r of Array.isArray(rounds) ? rounds : []) {
        if (r && typeof r === "object" && (r as Row).result === "fail") {
          const f = (r as Row).findings;
          for (const t of items(typeof f === "string" ? f : "")) out.push([branch, t]);
        }
      }
    }
  }
  return out;
}

interface Group {
  text: string;
  tokens: Set<string>;
  refs: string[];
}

/** [ref, text] pairs -> groups of similar texts (the first text stands for its group). */
function cluster(pairs: [string, string][]): Group[] {
  const groups: Group[] = [];
  for (const [ref, text] of pairs) {
    const t = tokens(text);
    const g = groups.find((g) => jaccard(t, g.tokens) >= 0.5);
    if (g) {
      if (!g.refs.includes(ref)) g.refs.push(ref);
    } else groups.push({ text, tokens: t, refs: [ref] });
  }
  return groups;
}

export interface Candidate {
  source: string;
  text: string;
  refs: string[];
  count: number;
  line: string;
}

function candidates(facts: Facts[], reviewer: [string, string][], known: Set<string>[], minimum: number): Candidate[] {
  const out: { source: string; text: string; refs: string[] }[] = [];
  const must: [string, string][] = facts.flatMap(([ref, mf]) => mf.map((t): [string, string] => [ref, t]));
  for (const g of cluster(must)) out.push({ source: "mustfix", text: g.text, refs: g.refs });
  const ci = new Map<string, string[]>();
  for (const [ref, , causes] of facts) {
    for (const c of causes) ci.set(c, [...(ci.get(c) ?? []), ref]);
  }
  for (const [c, refs] of ci) out.push({ source: "ci", text: `CI fails at ${c}`, refs });
  for (const g of cluster(reviewer)) out.push({ source: "reviewer", text: g.text, refs: g.refs });
  const res: Candidate[] = [];
  for (const c of out) {
    const count = c.refs.length;
    if (count < minimum || covered(c.text, known)) continue;
    const ref = c.refs[0] as string;
    const line = c.source === "ci"
      ? `- CI step \`${c.text.slice("CI fails at ".length)}\` failed on ${count} recent PRs: say what to run before pushing (e.g. ${ref})`
      : `- ${c.text.replace(/\.+$/, "")} (e.g. ${ref})`;
    res.push({ ...c, count, line });
  }
  return res.sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

function cmdSuggest(cfg: Config, last: number, minimum: number, json: boolean): number {
  const [path] = settings(cfg);
  const known = lessonLines(read(path)).map((ln) => tokens(unenforced(ln)));
  const pulls = taskPulls(last);
  const facts = pulls.map(pullFacts);
  const found = candidates(facts, reviewerFacts(cfg), known, minimum);
  if (json) {
    process.stdout.write(pyDumps({ pulls: pulls.length, min: minimum, candidates: found }, { indent: 2 }) + "\n");
    return 0;
  }
  if (!found.length) {
    process.stdout.write(`No repeated causes in the last ${pulls.length} task pull requests (a cause must come back on ${minimum}+). ` +
      "Nothing to add.\n");
    return 0;
  }
  process.stdout.write(`Candidate lessons from the last ${pulls.length} task pull requests (read-only; nothing is added until you run add):\n`);
  for (const c of found) {
    process.stdout.write(`\n${c.count}x  ${c.text}\n     ${c.source}: ${c.refs.join(", ")}\n`);
    process.stdout.write(`     factory lessons add "${c.line.slice(2)}"\n`);
  }
  process.stdout.write("\nEdit the wording first: one line, imperative, with the example. Then commit the file in a pull request.\n");
  return 0;
}

// ---- arguments (argparse with subcommands, by hand) -------------------------------------------------------------

const PROG = "factory lessons";
const USAGE = `usage: ${PROG} [-h] {show,check,suggest,add,prune} ...`;
const SUB_USAGE: Record<string, string> = {
  show: `usage: ${PROG} show [-h]`,
  check: `usage: ${PROG} check [-h]`,
  suggest: `usage: ${PROG} suggest [-h] [--last LAST] [--min MIN] [--json]`,
  add: `usage: ${PROG} add [-h] rule`,
  prune: `usage: ${PROG} prune [-h] [--apply]`,
};

function usageError(usage: string, msg: string): never {
  process.stderr.write(`${usage}\n${PROG}: error: ${msg}\n`);
  die(2);
}

interface Parsed {
  cmd: string;
  last: number;
  min: number;
  json: boolean;
  rule: string;
  apply: boolean;
}

function parse(argv: string[]): Parsed {
  const out: Parsed = { cmd: "", last: 20, min: 2, json: false, rule: "", apply: false };
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help") {
    process.stdout.write(`${USAGE}\n\nThe curated lessons file.\n`);
    die(0);
  }
  if (cmd === undefined) usageError(USAGE, "the following arguments are required: cmd");
  if (!(cmd in SUB_USAGE)) {
    usageError(USAGE, `argument cmd: invalid choice: '${cmd}' (choose from 'show', 'check', 'suggest', 'add', 'prune')`);
  }
  out.cmd = cmd;
  const usage = SUB_USAGE[cmd] as string;
  const extra: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "-h" || a === "--help") {
      process.stdout.write(usage + "\n");
      die(0);
    }
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (cmd === "suggest" && (flag === "--last" || flag === "--min")) {
      const v = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : rest[++i];
      if (v === undefined) usageError(usage, `argument ${flag}: expected one argument`);
      const n = pyInt(v);
      if (n === null || typeof v !== "string" || /^\s*$/.test(v)) usageError(usage, `argument ${flag}: invalid int value: '${v}'`);
      if (flag === "--last") out.last = n;
      else out.min = n;
    } else if (cmd === "suggest" && a === "--json") out.json = true;
    else if (cmd === "prune" && a === "--apply") out.apply = true;
    else if (a.startsWith("-") && a !== "-" && !(a.includes(" ") && !a.startsWith("--"))) extra.push(a);
    else positional.push(a);
  }
  if (cmd === "add") {
    if (!positional.length) usageError(usage, "the following arguments are required: rule");
    out.rule = positional.shift() as string;
  }
  extra.push(...positional);
  if (extra.length) usageError(USAGE, `unrecognized arguments: ${extra.join(" ")}`);
  return out;
}

export function main(argv: string[]): number {
  const a = parse(argv);
  const cfg = load();
  if (a.cmd === "show") return cmdShow(cfg);
  if (a.cmd === "check") return cmdCheck(cfg);
  if (a.cmd === "suggest") return cmdSuggest(cfg, a.last, a.min, a.json);
  if (a.cmd === "add") return cmdAdd(cfg, a.rule);
  return cmdPrune(cfg, a.apply);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
