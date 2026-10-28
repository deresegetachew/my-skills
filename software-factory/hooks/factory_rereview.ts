#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Incremental re-review (#70): a reviewer's second round checks only what changed since its last pass.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_rereview.ts plan   --kind reviewer     full or delta, and why (JSON)
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_rereview.ts prompt --kind reviewer     the instructions for this round
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_rereview.ts record --kind reviewer --result pass|fail --findings "..."
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_rereview.ts reply  --kind reviewer --text "what was changed for each finding"
//
// `--kind` names the reviewer: reviewer, arch (the architecture reviewer), safety, security. Each has its own history
// in <reviewMarkers>/<branch>.reviews.json: the commit it reviewed, whether it passed, its findings, the files and
// line count of the branch diff then, and the author's reply. The pass marker the PR gate reads (<branch>.ok, holding
// HEAD's id, in the git folder's factory-reviews/ since #260) is a separate file and is never touched here: a delta review still ends with the reviewer's pass for HEAD.
//
// The next round is a delta (`git diff <last reviewed commit>..HEAD`, with the earlier findings and the reply) unless:
// there is no earlier round, `reReviewPercent` is 0, the earlier commit isn't in HEAD's history any more (rebase), the
// branch's base moved (main merged in), the change touches a file the branch diff didn't have before, or it is more
// than `reReviewPercent` (default 30) percent of the branch diff's changed lines. Then it is a full review.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, load } from "./factory_config.ts";
import { die, git as gitRun, pyDumps, pyInt, runMain, splitLines } from "./factory_lib.ts";

export const KINDS = ["reviewer", "arch", "safety", "security"] as const;
/** Rounds remembered per reviewer. */
export const KEEP = 10;
/** A findings summary or reply, in characters. */
export const MAX_TEXT = 6000;
/** The delta shown in a prompt, in characters. */
export const MAX_DIFF = 120000;

export interface Snapshot {
  sha: string;
  base: string;
  files: string[];
  lines: number;
}

export interface Round extends Snapshot {
  result: string;
  findings: string;
  ts: number;
  reply?: string;
}

type State = Record<string, Round[]>;

export interface Plan {
  kind: string;
  branch: string;
  head: string;
  mode: "full" | "delta" | "unchanged";
  reason: string;
  last: { sha: string | null; result: string | null; ts: number | null } | null;
  delta: { files: string[]; lines: number; branchLines: number; percent: number } | null;
  dirty: boolean;
}

function git(...a: string[]): [number, string] {
  const p = gitRun(a);
  return [p.code, p.stdout.trim()];
}

/** Python's str.isdigit for git's numstat columns. */
function digits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** {file: changed lines} for a git range such as `a..b` or `base...HEAD`. */
export function numstat(spec: string): Map<string, number> {
  const [rc, out] = git("diff", "--numstat", spec);
  const res = new Map<string, number>();
  for (const line of rc === 0 ? splitLines(out) : []) {
    const parts = line.split("\t");
    const [add, rem, name] = [parts[0] ?? "", parts[1] ?? "", parts.slice(2).join("\t")];
    res.set(name, (digits(add) ? Number(add) : 0) + (digits(rem) ? Number(rem) : 0));
  }
  return res;
}

function stateFile(cfg: Config, branch: string): string {
  return join(cfg.reviewMarkers, branch.replace(/\//g, "_") + ".reviews.json");
}

export function readState(cfg: Config, branch: string): State {
  try {
    const data = JSON.parse(readFileSync(stateFile(cfg, branch), "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as State) : {};
  } catch {
    return {};
  }
}

function writeState(cfg: Config, branch: string, data: State): void {
  mkdirSync(cfg.reviewMarkers, { recursive: true });
  const path = stateFile(cfg, branch);
  writeFileSync(path + ".tmp", pyDumps(data, { indent: 1 }));
  renameSync(path + ".tmp", path);
}

export function percentLimit(cfg: Config): number {
  const n = pyInt(cfg.reReviewPercent ?? 30);
  return n === null ? 30 : Math.max(n, 0);
}

/** What the branch looks like now: HEAD, the merge base with `base`, and the branch diff's files and lines. */
export function snapshot(base: string): Snapshot {
  const head = git("rev-parse", "HEAD")[1];
  const mb = git("merge-base", base, "HEAD")[1];
  const files = numstat(`${base}...HEAD`);
  return { sha: head, base: mb, files: [...files.keys()].sort(), lines: [...files.values()].reduce((x, y) => x + y, 0) };
}

/** Python's round(x, 1) for the percent (half to even on the decimal value, close enough for display). */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** A number as Python prints a float: 12.0, not 12. */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

export function plan(cfg: Config, branch: string, kind: string, base: string): Plan {
  const now = snapshot(base);
  const entries = readState(cfg, branch)[kind] ?? [];
  const out: Plan = {
    kind, branch, head: now.sha, mode: "full", reason: "", last: null, delta: null,
    dirty: Boolean(git("status", "--porcelain")[1]),
  };
  if (percentLimit(cfg) === 0) {
    out.reason = "re-review by delta is off (reReviewPercent is 0)";
    return out;
  }
  if (!entries.length) {
    out.reason = "first review of this branch by this reviewer";
    return out;
  }
  const last = entries[entries.length - 1] as Round;
  out.last = { sha: last.sha ?? null, result: last.result ?? null, ts: last.ts ?? null };
  if (last.sha === now.sha) {
    out.mode = "unchanged";
    out.reason = "no commit since this reviewer's last round";
    return out;
  }
  if (git("merge-base", "--is-ancestor", last.sha, now.sha)[0] !== 0) {
    out.reason = "the commit last reviewed is not in the branch's history any more (rebased or reset)";
    return out;
  }
  if (last.base !== now.base) {
    out.reason = "the branch's base moved (main was merged in or the branch was rebased)";
    return out;
  }
  const delta = numstat(`${last.sha}..${now.sha}`);
  const lines = [...delta.values()].reduce((x, y) => x + y, 0);
  const pct = round1((lines * 100) / Math.max(now.lines, 1));
  const files = [...delta.keys()].sort();
  out.delta = { files, lines, branchLines: now.lines, percent: pct };
  const seen = new Set(last.files ?? []);
  const fresh = files.filter((f) => !seen.has(f));
  if (fresh.length) {
    out.reason = "the change touches files the earlier round did not see: " + fresh.slice(0, 5).join(", ");
  } else if (pct > percentLimit(cfg)) {
    out.reason = `the change is ${pyFloat(pct)}% of the branch diff, over the ${percentLimit(cfg)}% limit`;
  } else {
    out.mode = "delta";
    out.reason = `${pyFloat(pct)}% of the branch diff, in files the earlier round saw`;
  }
  return out;
}

function earlier(cfg: Config, branch: string, kind: string): Round | null {
  const entries = readState(cfg, branch)[kind] ?? [];
  return entries.length ? (entries[entries.length - 1] as Round) : null;
}

/** The plan as JSON text, with the percent written as Python wrote a float. */
function planJson(p: Plan): string {
  const text = pyDumps(p, { indent: 2 });
  if (!p.delta) return text;
  return text.replace(/("percent": )(-?\d+)(\n|,)/, (_m, a: string, n: string, e: string) => `${a}${n}.0${e}`);
}

export function prompt(cfg: Config, branch: string, kind: string, base: string): string {
  const p = plan(cfg, branch, kind, base);
  const last = earlier(cfg, branch, kind);
  const L: string[] = [];
  const lastSha = p.last ? String(p.last.sha) : "";
  if (p.mode === "delta" && p.delta && p.last) {
    L.push(`## Re-review of ${branch} (${kind}): only the changes since your last round`,
      `You reviewed ${lastSha.slice(0, 12)} earlier and the result was: ${p.last.result}. Check only the ` +
      `delta below (${p.delta.files.length} files, ${p.delta.lines} changed lines, ` +
      `${pyFloat(p.delta.percent)}% of the branch diff). Do not read the rest of the branch diff again.`, "");
  } else if (p.mode === "unchanged" && p.last) {
    L.push(`## Nothing new for ${branch} (${kind})`,
      `HEAD is ${p.head.slice(0, 12)}, the commit you already reviewed (${p.last.result}). There is no delta. ` +
      "Re-check only your earlier findings below.", "");
  } else {
    L.push(`## Full review of ${branch} (${kind})`, `Read the whole branch diff (\`git diff ${base}...HEAD\`): ` +
      `${p.reason}.`, "");
  }
  if (last) {
    L.push(`### Your earlier findings (round at ${String(last.sha).slice(0, 12)}, ${last.result})`,
      last.findings || "(none recorded)", "");
    if (last.reply) L.push("### The author's reply to them", last.reply, "");
  }
  if (p.mode === "delta" || p.mode === "unchanged") {
    L.push("### What to do",
      "1. For each earlier must-fix, check that the delta fixes it and say how.",
      "2. Check the new changes in the delta are fine (the same checks as a first review, on these lines only).",
      "3. Run the project's checks as usual. Read a file outside the delta only when a changed line depends on it.",
      `4. Record your result for HEAD (${p.head.slice(0, 12)}): \`factory_rereview.ts record\`, then the pass marker if there ` +
      "is no must-fix. The pass names HEAD, not the delta.", "");
  } else {
    L.push("After the review, record your result with `factory_rereview.ts record`, then the pass marker if there is " +
      "no must-fix.", "");
  }
  if (p.dirty) {
    L.push("Note: the working tree has uncommitted changes. They are not part of this review; ask for them to be committed.", "");
  }
  if (p.mode === "delta") {
    let diff = git("diff", `${lastSha}..${p.head}`)[1];
    if (diff.length > MAX_DIFF) {
      diff = diff.slice(0, MAX_DIFF) + `\n[delta cut at ${MAX_DIFF} characters; read the rest with git diff ${lastSha.slice(0, 12)}..HEAD]`;
    }
    L.push(`BEGIN DELTA (${lastSha.slice(0, 12)}..${p.head.slice(0, 12)})`, diff, "END DELTA");
  }
  return L.join("\n").trimEnd() + "\n";
}

export function record(cfg: Config, branch: string, kind: string, base: string, result: string, findings: string): Round {
  const data = readState(cfg, branch);
  const entry: Round = { ...snapshot(base), result, findings: findings.slice(0, MAX_TEXT), ts: Math.floor(Date.now() / 1000) };
  data[kind] = [...(data[kind] ?? []), entry].slice(-KEEP);
  writeState(cfg, branch, data);
  return entry;
}

export function reply(cfg: Config, branch: string, kind: string, text: string): boolean {
  const data = readState(cfg, branch);
  const rounds = data[kind];
  if (!rounds || !rounds.length) return false;
  (rounds[rounds.length - 1] as Round).reply = text.slice(0, MAX_TEXT);
  writeState(cfg, branch, data);
  return true;
}

const USAGE = "usage: factory_rereview.ts [-h] [--kind {reviewer,arch,safety,security}] [--base BASE] [--branch BRANCH]\n" +
  "                           [--result {pass,fail}] [--findings FINDINGS] [--findings-file FINDINGS_FILE]\n" +
  "                           [--text TEXT] [--text-file TEXT_FILE]\n" +
  "                           {plan,prompt,record,reply}";

interface Args {
  command: string;
  kind: string;
  base?: string;
  branch?: string;
  result?: string;
  findings?: string;
  findings_file?: string;
  text?: string;
  text_file?: string;
}

const FLAGS: Record<string, keyof Args> = {
  "--kind": "kind", "--base": "base", "--branch": "branch", "--result": "result", "--findings": "findings",
  "--findings-file": "findings_file", "--text": "text", "--text-file": "text_file",
};
const CHOICES: Partial<Record<keyof Args, readonly string[]>> = {
  command: ["plan", "prompt", "record", "reply"], kind: KINDS, result: ["pass", "fail"],
};

/** argparse takes a word as an option's value unless it looks like an option: "-" alone, a negative number and a
 * word with a space in it are values. */
function looksLikeValue(w: string): boolean {
  return !w.startsWith("-") || w === "-" || /^-\d+$|^-\d*\.\d+$/.test(w) || (w.includes(" ") && !w.startsWith("--"));
}

/** The argparse parser by hand: the same flags, choices, and `usage:` with exit 2 on a mistake. */
function parse(argv: string[]): Args {
  const bad = (msg: string): never => {
    process.stderr.write(`${USAGE}\nfactory_rereview.ts: error: ${msg}\n`);
    die(2);
  };
  const a: Partial<Args> = { kind: "reviewer" };
  const check = (key: keyof Args, value: string, shown: string): void => {
    const ok = CHOICES[key];
    if (ok && !ok.includes(value)) {
      bad(`argument ${shown}: invalid choice: '${value}' (choose from ${ok.map((c) => `'${c}'`).join(", ")})`);
    }
    a[key] = value;
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE + "\n\nIncremental re-review (#70): a reviewer's second round checks only what changed since its last pass.\n");
      die(0);
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flag = eq < 0 ? arg : arg.slice(0, eq);
      const names = Object.keys(FLAGS);
      const hits = names.filter((n) => n.startsWith(flag));
      const name = names.includes(flag) ? flag : hits.length === 1 ? (hits[0] as string) : null;
      if (!name) bad(hits.length > 1 ? `ambiguous option: ${flag} could match ${hits.join(", ")}` : `unrecognized arguments: ${arg}`);
      const key = FLAGS[name as string] as keyof Args;
      let value: string;
      if (eq >= 0) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length && looksLikeValue(argv[i + 1] as string)) value = argv[++i] as string;
      else return bad(`argument ${name}: expected one argument`);
      check(key, value, `${name}`);
    } else rest.push(arg);
  }
  if (!rest.length) bad("the following arguments are required: command");
  check("command", rest[0] as string, "command");
  if (rest.length > 1) bad(`unrecognized arguments: ${rest.slice(1).join(" ")}`);
  return a as Args;
}

function textArg(args: Args, name: "findings" | "text"): string | undefined {
  const path = args[`${name}_file`];
  if (path) return readFileSync(path, "utf8");
  return args[name];
}

export function main(argv: string[]): number {
  const args = parse(argv);
  const cfg = load();
  const branch = args.branch || git("branch", "--show-current")[1];
  if (!branch) {
    process.stderr.write("factory rereview: not on a branch. Check out the task branch first.\n");
    return 1;
  }
  const base = args.base || `origin/${cfg.mainBranch}`;
  if (git("rev-parse", "--verify", "-q", base)[0] !== 0) {
    process.stderr.write(`factory rereview: ${base} not found. Run \`git fetch origin\` or pass --base.\n`);
    return 1;
  }
  if (args.command === "plan") {
    process.stdout.write(planJson(plan(cfg, branch, args.kind, base)) + "\n");
  } else if (args.command === "prompt") {
    process.stdout.write(prompt(cfg, branch, args.kind, base));
  } else if (args.command === "record") {
    const findings = textArg(args, "findings");
    if (!args.result || !findings) {
      process.stderr.write("factory rereview: record needs --result pass|fail and --findings (a short summary; " +
        "'no must-fix' for a clean pass).\n");
      return 1;
    }
    const e = record(cfg, branch, args.kind, base, args.result, findings);
    process.stdout.write(`factory rereview: recorded ${args.kind} ${args.result} for ${e.sha.slice(0, 12)}.\n`);
  } else {
    const text = textArg(args, "text");
    if (!text) {
      process.stderr.write("factory rereview: reply needs --text (what you changed for each finding).\n");
      return 1;
    }
    if (!reply(cfg, branch, args.kind, text)) {
      process.stderr.write(`factory rereview: no earlier ${args.kind} round on ${branch}, so the reply has nothing to attach to; ` +
        "the next review is a full one.\n");
      return 1;
    }
    process.stdout.write(`factory rereview: reply saved for the next ${args.kind} round.\n`);
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
