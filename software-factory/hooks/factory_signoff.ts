#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The sign-off and testing queue (#101): what only a person can check, and the tests of the running app.
//
// One issue, "Sign-off and testing queue" (pin it), holds one comment per item (on the board: one message, see below). The
// state of an item is read from the comments after it, so nothing is edited and a second run changes nothing.
//
//   factory signoff ls [--all] [--json]       open items (--all: finished ones too), one line each; --json gives each
//                                             with who started it and when (by, at) and its story (history), for the web UI
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
// Read and written through the GitHub REST API (`gh api`), or, with `tasks.source` board, on the message board (#552):
// there the queue is a note task of the project and each comment is a message on it (message-board/src/signoff.ts), and
// no GitHub call is made.
//
// A task is named as people see it (#552): 12 or #12 for issue 12, b17 for a task made on the board (board only). On the
// board the task must be there; a refusal says how to find its number.
import { readFileSync } from "node:fs";
import { boardRepo } from "./core/compose.ts";
import { type Config, load, roleNames, taskSource } from "./factory_config.ts";
import * as fi from "./factory_issues.ts";
import { Exit, die, parseArgs, pyDumps, runMain } from "./factory_lib.ts";

export const TITLE = "Sign-off and testing queue";
const ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
const MARK = /<!--\s*factory-(signoff-result|signoff|testplan-confirm|testplan|testresult)\b([^>]*?)-->/;
const ATTR = /([A-Za-z][\w-]*)=(\S+)/g;
export const RESULTS = ["pass", "fail", "blocked"] as const;
const WORD: Record<string, string> = { pass: "passed", fail: "failed", blocked: "blocked" };

export type Result = [result: string, by: string, note: string];

/** One step of an item's story, oldest first: added (a sign-off item), proposed (a test plan, again when revised),
 * confirmed, or a result. */
export interface Event {
  what: "added" | "proposed" | "confirmed" | "result";
  by: string;
  at: string;
  result?: string;
  note?: string;
}

export interface Item {
  kind: "signoff" | "testplan";
  id: string;
  task: string | null;
  text: string;
  confirmed: boolean;
  results: Result[];
  state: string;
  /** Who posted the item's first comment, and when ("" when GitHub didn't say). */
  by: string;
  at: string;
  history: Event[];
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
    const at = c.created_at ?? "";
    if (what === "signoff" || what === "testplan") {
      if (what === "signoff" && items.has(i)) continue; // the first entry stands
      // a revised test plan replaces the old one: it has to be confirmed again and its results start over; who started
      // it and its story stay
      const was = items.get(i);
      const by = c.user?.login ?? "";
      const history: Event[] = [...(was?.history ?? []), { what: what === "signoff" ? "added" : "proposed", by, at }];
      items.set(i, { kind: what, id: i, task: attrs.task ?? null, text, confirmed: false, results: [], state: "",
        by: was?.by ?? by, at: was?.at ?? at, history });
    } else if (items.has(i)) {
      const it = items.get(i) as Item;
      if (what === "testplan-confirm" && it.kind === "testplan") {
        it.confirmed = true;
        it.history.push({ what: "confirmed", by: attrs.by ?? "", at });
      } else if ((what === "signoff-result" || what === "testresult") && (RESULTS as readonly string[]).includes(attrs.result ?? "")) {
        if (it.kind === "testplan" && !it.confirmed) continue; // a result for a plan nobody confirmed counts for nothing
        it.results.push([attrs.result as string, attrs.by ?? "", text]);
        it.history.push({ what: "result", by: attrs.by ?? "", at, result: attrs.result as string, note: text });
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

/** A task as people see it: "#12" for an issue's, "b12" for a task made on the board. */
export function taskLabel(task: string): string {
  return /^\d+$/.test(task) ? `#${task}` : task;
}

export function line(it: Item): string {
  const first = (it.text.split(/\r?\n/)[0] ?? "").slice(0, 90);
  const task = it.task ? ` task ${taskLabel(it.task)}` : "";
  const kind = it.kind === "signoff" ? "sign-off" : "test plan";
  return `${it.id}: ${kind} ${it.state}${task}: ${first}`;
}

// --- where the queue is: the GitHub issue, or the message board (#552) ----------------------------------------------

const TASK = /^(?:#?([1-9]\d*)|b([1-9]\d*))$/i;
const TASK_FIX = "name the task by its number: 12 or #12 for issue 12, b12 for a task made on the message board";

/** The queue the project's settings choose: its entries, a writer, and how a task is named in it. */
export interface Store {
  /** Where it is, for a line: "queue #50" or "on the message board" ("" when there is no queue yet). */
  where(): string;
  /** The issue's number (null on the board, or with no queue yet). */
  number(): number | null;
  comments(): Promise<fi.Comment[]>;
  /** Write one entry: a confirmation or a result is a verdict on the board. */
  post(body: string, verdict: boolean): Promise<void>;
  /** The task `input` names, as the queue writes it ("12", "b12"); refused with a fix when it names none. */
  task(input: string): Promise<string>;
  who(by: string | undefined): string;
  end(): Promise<void>;
}

function githubStore(): Store {
  let n: number | null | undefined;
  const number = (): number | null => (n === undefined ? (n = queue()) : n);
  return {
    where: () => (number() ? `queue #${number()}` : ""),
    number,
    comments: async () => (number() ? fi.ghAll<fi.Comment>(`repos/{owner}/{repo}/issues/${number()}/comments`) : []),
    post: async (body) => {
      n = queue(true) as number;
      fi.comment(n, body);
      console.log(`posted to the sign-off and testing queue (#${n}).`);
    },
    task: async (input) => {
      const m = TASK.exec(input.trim());
      if (m?.[2]) {
        failWith(`'${input}' is a task on the message board, but this project's tasks are GitHub issues (tasks.source).`,
          "name the task by its issue number, for example --task 12");
      }
      if (!m) failWith(`'${input}' isn't a task's number.`, TASK_FIX);
      return m[1] as string;
    },
    who: (by) => (by || process.env.FACTORY_AGENT || fi.gh<{ login?: string } | null>("GET", "user")?.login || "unknown").replace(/[^\w.-]/g, ""),
    end: async () => {},
  };
}

/** Who may write what on the board's queue (#552 review): a builder can post on any task, so an entry counts only from
 * someone allowed to write it. An item or a plan comes from the owner, the product owner or the dev manager; a
 * confirmation only from the owner, and a result from the owner or the product owner, each as a verdict (an MCP
 * builder can't post one). The `by=` in a marker is a label, never who it was. */
export function trustedEntry(m: { kind: string; from: string; body: string }, cfg: Config): boolean {
  const builders = new Set(roleNames(cfg, "coding-agent"));
  const po = roleNames(cfg, "product-owner").filter((n) => n && !builders.has(n));
  const dm = roleNames(cfg, "dev-manager").filter((n) => n && !builders.has(n));
  const what = MARK.exec(m.body)?.[1];
  if (what === "signoff" || what === "testplan") return m.kind === "note" && ["owner", ...po, ...dm].includes(m.from);
  if (what === "testplan-confirm") return m.kind === "verdict" && m.from === "owner";
  if (what === "signoff-result" || what === "testresult") return m.kind === "verdict" && ["owner", ...po].includes(m.from);
  return false;
}

async function boardStore(cfg: Config): Promise<Store> {
  // loaded here, not at the top: an install without the board (tasks on GitHub) never needs it
  const { Board, boardUrl, Numbers, postSignoff, signoffEntries, signoffTask } = await import("../message-board/src/index.ts");
  const url = boardUrl();
  if (!url) {
    failWith("this project's tasks are on the message board, and this machine has none (MB_URL is unset and there is no url file).",
      "start one with `factory board up`, or join one with `factory machine join <code>`; or use GitHub: `factory settings set tasks.source issues`");
  }
  const repo = boardRepo() || null;
  const numbers = new Numbers(repo);
  const board = await Board.open(url, { as: process.env.FACTORY_AGENT || "owner", session: `factory-signoff-${process.pid}`, max: 2 });
  return {
    where: () => "on the message board",
    number: () => null,
    comments: async () => (await signoffEntries(board, repo)).filter((m) => trustedEntry(m, cfg)).map((m) => ({ id: m.id, body: m.body, user: { login: m.from },
      created_at: m.createdAt.toISOString() })),
    post: async (body, verdict) => {
      await postSignoff(board, repo, body, verdict);
      console.log("posted to the sign-off and testing queue on the message board.");
    },
    task: async (input) => {
      if (!TASK.test(input.trim())) failWith(`'${input}' isn't a task's number.`, TASK_FIX);
      return signoffTask(board, numbers, input.trim());
    },
    who: (by) => (by || process.env.FACTORY_AGENT || "owner").replace(/[^\w.-]/g, ""),
    end: () => board.end().catch(() => {}),
  };
}

/** The queue for `cfg` (default: the project's settings): on the board with `tasks.source` board, else the GitHub issue. */
export async function storeFor(cfg?: Config): Promise<Store> {
  const c = cfg ?? load();
  return taskSource(c) === "board" ? boardStore(c) : githubStore();
}

/** A board refusal ({code, message, fix}), told without loading the board's module. */
function isBoardError(e: unknown): e is Error & { code: string; fix: string } {
  return e instanceof Error && e.name !== "Exit" && typeof (e as { code?: unknown }).code === "string" &&
    typeof (e as { fix?: unknown }).fix === "string";
}

/** Runs `fn` with the store, ended after; a board refusal is told as this command's own, with its fix. */
async function withStore<T>(cfg: Config | undefined, fn: (s: Store) => Promise<T>): Promise<T> {
  let s: Store | null = null;
  try {
    s = await storeFor(cfg);
    return await fn(s);
  } catch (e) {
    if (isBoardError(e)) failWith(e.message.replace(/\.$/, ""), e.fix.replace(/\.$/, ""));
    throw e;
  } finally {
    await s?.end();
  }
}

/** The queue's items and where it is (the issue's number, null on the board), for the web UI. */
export async function readQueue(cfg?: Config): Promise<{ queue: number | null; source: "issues" | "board"; items: Item[] }> {
  return withStore(cfg, async (s) => {
    const items = [...read(await s.comments()).values()];
    return { queue: s.number(), source: taskSource(cfg ?? load()) === "board" ? "board" : "issues", items };
  });
}

/** Lines for the product owner's work list: what waits on the owner or on a test run. A board that can't be had is one
 * line saying so, not a failed list. */
export async function digest(cfg?: Config): Promise<string[]> {
  if (taskSource(cfg ?? load()) === "board") {
    try {
      return await digestOf(cfg);
    } catch (e) {
      if (!(e instanceof Exit) || !e.text) throw e;
      return [`the sign-off queue can't be read: ${(e.text.split("\n")[0] ?? "").replace(/^factory signoff: /, "")}`];
    }
  }
  return digestOf(cfg);
}

async function digestOf(cfg?: Config): Promise<string[]> {
  return withStore(cfg, async (s) => {
    const items = read(await s.comments());
    const where = s.where();
    const out: string[] = [];
    for (const it of openItems(items)) {
      if (it.kind === "testplan" && it.state === "proposed") out.push(`test plan ${it.id} waits for the owner to confirm (${where})`);
      else if (it.kind === "testplan") out.push(`test plan ${it.id} is confirmed and not run yet (${where})`);
    }
    const signoffs = openItems(items).filter((it) => it.kind === "signoff");
    if (signoffs.length) {
      const one = signoffs.length === 1;
      out.push(`${signoffs.length} sign-off item${one ? "" : "s"} ${one ? "waits" : "wait"} for a person (${where})`);
    }
    return out;
  });
}

async function post(s: Store, dryRun: boolean, marker: string, text = "", verdict = false): Promise<void> {
  const body = `${marker}\n${text}`.trimEnd() + "\n";
  if (dryRun) {
    console.log("would post to the sign-off and testing queue:\n" + body);
    return;
  }
  await s.post(body, verdict);
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

export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const cmds = ["ls", "add", "plan", "confirm", "result"];
  if (cmd === undefined) usageError(USAGE, `${PROG}: error: the following arguments are required: cmd`);
  if (!cmds.includes(cmd)) {
    usageError(USAGE, `${PROG}: error: argument cmd: invalid choice: '${cmd}' (choose from ${cmds.map((c) => `'${c}'`).join(", ")})`);
  }
  const rest = argv.slice(1);
  if (cmd === "ls") {
    const a = parseArgs(rest, { flags: ["--all", "--json"] }, `${PROG} ls`, `usage: ${PROG} ls [-h] [--all] [--json]`);
    const items = await withStore(undefined, async (s) => read(await s.comments()));
    const shown = a.all ? [...items.values()] : openItems(items);
    if (a.json) {
      console.log(pyDumps(shown.map((it) => ({ kind: it.kind, id: it.id, task: it.task, text: it.text, confirmed: it.confirmed,
        results: it.results, state: it.state, by: it.by, at: it.at, history: it.history })), { indent: 2 }));
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
  if (cmd === "result" && !(RESULTS as readonly string[]).includes(String(a.outcome))) {
    usageError(spec.usage, `${prog}: error: argument outcome: invalid choice: '${String(a.outcome)}' (choose from 'pass', 'fail', 'blocked')`);
  }
  if (!ID.test(id)) failWith(`'${id}' is not an id.`, "use letters, digits, dots and dashes, for example login-flow-2");
  await withStore(undefined, (s) => write(s, cmd as "add" | "plan" | "confirm" | "result", id, a));
}

/** add, plan, confirm or result `id` in queue `s`, with the parsed options `a`. */
async function write(s: Store, cmd: "add" | "plan" | "confirm" | "result", id: string, a: Record<string, unknown>): Promise<void> {
  const dryRun = Boolean(a["dry-run"]);
  const by = a.by as string | undefined;
  const task = a.task === undefined ? undefined : await s.task(String(a.task));
  const it = read(await s.comments()).get(id);
  if (cmd === "add") {
    if (it) failWith(`'${id}' is already in the queue (${it.state}).`, "pick another id, or record a result for it");
    await post(s, dryRun, `<!-- factory-signoff id=${id} task=${task} -->`, `To check: ${String(a.check)}`);
  } else if (cmd === "plan") {
    const text = a.file ? readFileSync(a.file as string, "utf8") : (a.text as string | undefined);
    if (!text) failWith("a plan needs its steps.", "pass --file PLAN.md or --text \"...\"");
    if (it && it.kind === "signoff") failWith(`'${id}' is a sign-off item, not a test plan.`, "pick another id");
    const taskAttr = task ? ` task=${task}` : it && it.task ? ` task=${it.task}` : "";
    await post(s, dryRun, `<!-- factory-testplan id=${id}${taskAttr} -->`, text.trim());
  } else if (cmd === "confirm") {
    if (!it || it.kind !== "testplan") failWith(`there is no test plan '${id}'.`, "see `factory signoff ls`");
    if (it.confirmed && !it.results.length) {
      console.log(`${id} is already confirmed.`);
      return;
    }
    const who = s.who(by);
    await post(s, dryRun, `<!-- factory-testplan-confirm id=${id} by=${who} -->`, `Confirmed by ${who}: this is what gets tested.`, true);
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
    await post(s, dryRun, `<!-- factory-${marker} id=${id} result=${outcome} by=${s.who(by)}${at} -->`, (a.note as string | undefined) ?? "", true);
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
