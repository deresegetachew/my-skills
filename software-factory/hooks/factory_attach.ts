#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory attach` (#637): files on a task, a pull request, a sign-off item or an epic, kept on the hub and shown in the
// web UI. Never in git. The store and its rules are message-board/src/attachments.ts; the web UI's side is
// factory_ui_attachments.ts.
//
//   factory attach <task|pr|signoff|epic> <id> <file>... [--note <text>] [--head <sha>] [--json]
//       attaches the files as this agent (FACTORY_AGENT, else owner). For a pull request they are for its head commit
//       (--head, else the head GitHub has), and the pull request gets one comment, once, with a link to its page in the
//       web UI (`ui.url`; never a token), so a reviewer knows where to look.
//   factory attach ls <task|pr|signoff|epic> <id> [--head <sha>] [--json]
//       what is attached, oldest first; for a pull request each says whether it is for the head (`head`) or an older
//       one (`old head`), and a JUnit report its passed, failed and skipped. The dev manager's screenshot rule is met
//       by an image for the head.
//   factory attach prune
//       drops what is past `attachments.retentionDays` now (each attach does it too).
//
// Only regular files inside this checkout are read (links followed to where they point), never a .env file or anything
// in .git or .claude, and each file's size is checked before it is read (attach_path_refused). The checkout is the folder
// the session runs in (CLAUDE_PROJECT_DIR, else where the command started); when git names another top folder (a forged
// .git file) it is refused. Hard links are refused, and the file read is the one checked (its device and inode). The limits and `ui.url`
// come from main's settings on GitHub, never the worktree's (attach_settings_unreadable when GitHub can't say).
// Limits: `attachments.maxFileMb` per file, `attachments.maxProjectMb` for all the project keeps. Errors are one JSON
// line {code, message, fix} on stderr, exit 1; nothing is written on a refusal.
import { basename, dirname } from "node:path";
import { boardRepo } from "./core/compose.ts";
import { type Config, load, loadFromMain } from "./factory_config.ts";
import { gh, ghAll } from "./factory_issues.ts";
import { junitSummary } from "./factory_junit.ts";
import { Exit, pyDumps, run, runMain } from "./factory_lib.ts";
import type { Attachment, Board } from "../message-board/src/index.ts";

const USAGE = `factory attach <task|pr|signoff|epic> <id> <file>... [--note <text>] [--head <sha>] [--json]
factory attach ls <task|pr|signoff|epic> <id> [--head <sha>] [--json]
factory attach prune`;

export const COMMENT_MARK = "<!-- factory-attachments -->";

/** The folder the command was started in. Loading the settings moves to what git says is the checkout, and a forged
 *  .git file could point that anywhere, so files are found from here (#637). */
const STARTED_IN = process.cwd();

class Refusal extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
  }
}

function refuse(code: string, message: string, fix: string): never {
  throw new Refusal(code, message, fix);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) refuse("attach_bad_input", `${name} needs a value.`, `Usage:\n${USAGE}`);
  args.splice(i, 2);
  return v;
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

type Mod = typeof import("../message-board/src/index.ts");

async function openBoard(m: Mod): Promise<Board> {
  const url = m.boardUrl();
  if (!url) {
    refuse("attach_no_board", "Attachments are kept with the message board, and this machine has none set up.",
      "Start it on the hub with `factory board up`, or join it from this machine with `factory machine join <code>`, then try again.");
  }
  return m.Board.open(url, { as: process.env.FACTORY_AGENT || "owner", session: `factory-attach-${process.pid}`, max: 2 });
}

function repoOf(m: Mod): string {
  const repo = boardRepo();
  try {
    return m.repoKey(repo);
  } catch {
    return refuse("attach_no_repo", "This project has no GitHub repo (no origin remote and no GH_REPO), and attachments are kept by repo.",
      "Add the GitHub remote as origin, or set GH_REPO=owner/name.");
  }
}

function limits(cfg: Config, m: Mod): ReturnType<Mod["limitsOf"]> {
  const a = (cfg as Record<string, unknown>).attachments;
  return m.limitsOf(typeof a === "object" && a !== null && !Array.isArray(a) ? (a as Record<string, unknown>) : {});
}

/** The pull request's head commit, as GitHub has it. */
function prHead(n: string): string {
  try {
    const pr = gh<{ head?: { sha?: string } } | null>("GET", `repos/{owner}/{repo}/pulls/${n}`, undefined, true);
    const sha = pr?.head?.sha;
    if (typeof sha === "string" && /^[0-9a-f]{7,64}$/.test(sha)) return sha;
  } catch {
    // said below
  }
  return refuse("attach_pr_unknown", `GitHub didn't give PR #${n}'s head commit.`, "Check the number, or pass --head <sha> (git rev-parse HEAD on its pushed branch).");
}

/** The project's id in the web UI (its folder's name, as factory_ui_data.ts makes it). */
function uiProjectId(): string {
  const g = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const name = g.code === 0 && g.stdout.trim() ? basename(dirname(g.stdout.trim())) : basename(process.cwd());
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "project";
}

/** Where the pull request's page is in the web UI: `ui.url` with the page's address, else how to find it. */
export function pageLink(cfg: Config, n: string): string {
  const ui = (cfg as Record<string, unknown>).ui;
  const base = typeof ui === "object" && ui !== null ? String((ui as Record<string, unknown>).url ?? "").trim() : "";
  const hash = `#/${encodeURIComponent(uiProjectId())}/pr:${n}`;
  if (/^https?:\/\/[^\s?#]+$/.test(base)) return `${base.replace(/\/+$/, "")}/${hash}`;
  return `the web UI (\`factory ui\` on the hub), Pull requests, #${n}, Attachments (its address there ends in ${hash})`;
}

/** One comment on the pull request, once: where its attachments are. A failure is said, not fatal: the files are kept. */
function commentOnce(cfg: Config, n: string): string {
  try {
    const comments = ghAll<{ body?: string }>(`repos/{owner}/{repo}/issues/${n}/comments`);
    if (comments.some((c) => (c.body ?? "").includes(COMMENT_MARK))) return "The pull request already links to them.";
    gh("POST", `repos/{owner}/{repo}/issues/${n}/comments`, { body: `${COMMENT_MARK}\nAttachments (screenshots, test results, logs) for this ` +
      `pull request are in the factory's web UI: ${pageLink(cfg, n)}. They are kept on the hub, not in the repo, and need the web UI's sign-in.` });
    return "Commented on the pull request with where to find them.";
  } catch (e) {
    return `Couldn't comment on the pull request (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}); the files are kept.`;
  }
}

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

/** The files, each a regular file inside this checkout and within the cap, checked before any is read. */
function readFiles(cfg: Config, m: Mod, paths: string[]): { name: string; bytes: Uint8Array }[] {
  return m.readConfined(paths, STARTED_IN, limits(cfg, m), (message, fix) => refuse("attach_path_refused", message, fix));
}

/** The settings as main has them on GitHub (#637): an agent's worktree can't raise its own caps or change the link. */
function mainSettings(): Config {
  try {
    return loadFromMain(load());
  } catch (e) {
    return refuse("attach_settings_unreadable", `Main's settings can't be read from GitHub: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
      "Check `gh auth status` and the network, then run it again.");
  }
}

async function add(cfg: Config, m: Mod, args: string[]): Promise<number> {
  const note = option(args, "--note");
  const headGiven = option(args, "--head");
  const json = flag(args, "--json");
  const [kind = "", id = "", ...paths] = args;
  if (paths.some((x) => x.startsWith("--"))) refuse("attach_bad_input", `${paths.find((x) => x.startsWith("--"))} isn't an option here.`, `Usage:\n${USAGE}`);
  if (!paths.length) refuse("attach_bad_input", "Name the files to attach.", `Usage:\n${USAGE}`);
  const target = m.targetOf(kind, id);
  const files = readFiles(cfg, m, paths);
  const repo = repoOf(m);
  const head = target.kind === "pr" ? (headGiven ?? prHead(target.id)) : headGiven ?? null;
  const b = await openBoard(m);
  let made: Attachment[];
  try {
    made = await m.attach(b, repo, { target, head, files, note }, limits(cfg, m));
  } finally {
    await b.end().catch(() => {});
  }
  const said = target.kind === "pr" ? commentOnce(cfg, target.id) : "";
  if (json) {
    console.log(pyDumps({ attachments: made, comment: said }));
    return 0;
  }
  const where = target.kind === "pr" ? `PR #${target.id} (head ${(head ?? "").slice(0, 7)})` : `${target.kind} ${target.id}`;
  console.log(`Attached ${made.length} file${made.length === 1 ? "" : "s"} to ${where}:`);
  for (const a of made) console.log(`  ${a.name}  ${a.kind}, ${size(a.size)}  (${a.id})`);
  if (said) console.log(said);
  return 0;
}

async function ls(cfg: Config, m: Mod, args: string[]): Promise<number> {
  const headGiven = option(args, "--head");
  const json = flag(args, "--json");
  const [kind = "", id = "", ...extra] = args;
  if (extra.length) refuse("attach_bad_input", `${extra[0]} isn't an option here.`, `Usage:\n${USAGE}`);
  const target = m.targetOf(kind, id);
  const repo = repoOf(m);
  const head = target.kind === "pr" ? (headGiven ?? prHead(target.id)) : null;
  const b = await openBoard(m);
  try {
    const list = await m.listAttachments(b, repo, target, limits(cfg, m).retentionDays);
    const rows = [];
    for (const a of list) {
      const current = head && a.head ? head.startsWith(a.head) || a.head.startsWith(head) : null;
      let summary = null;
      if (a.kind === "junit") {
        const bytes = await m.readBytes(b, a);
        summary = bytes ? junitSummary(new TextDecoder().decode(bytes)) : null;
      }
      rows.push({ ...a, current, summary });
    }
    if (json) {
      console.log(pyDumps({ target: `${target.kind}:${target.id}`, head, attachments: rows }));
      return 0;
    }
    const where = target.kind === "pr" ? `PR #${target.id}${head ? ` (head ${head.slice(0, 7)})` : ""}` : `${target.kind} ${target.id}`;
    if (!rows.length) {
      console.log(`Nothing is attached to ${where}.`);
      return 0;
    }
    console.log(`Attached to ${where}:`);
    for (const r of rows) {
      const when = r.current === null ? "" : r.current ? "  head" : `  old head ${String(r.head).slice(0, 7)}`;
      const s = r.summary ? r.summary.ok ? `  ${r.summary.passed} passed, ${r.summary.failed} failed, ${r.summary.skipped} skipped` : `  unreadable: ${r.summary.why}` : "";
      console.log(`  ${r.name}  ${r.kind}, ${size(r.size)}, by ${r.by} ${r.at.slice(0, 16).replace("T", " ")}${when}${s}${r.note ? `  - ${r.note}` : ""}`);
    }
    const images = rows.filter((r) => r.kind === "image" && r.current !== false).length;
    if (target.kind === "pr") console.log(images ? `${images} image${images === 1 ? "" : "s"} for the head.` : "No image for the head.");
    return 0;
  } finally {
    await b.end().catch(() => {});
  }
}

async function prune(cfg: Config, m: Mod): Promise<number> {
  const repo = repoOf(m);
  const b = await openBoard(m);
  try {
    const n = await m.pruneAttachments(b, repo, limits(cfg, m).retentionDays);
    console.log(n ? `Dropped ${n} attachment${n === 1 ? "" : "s"} past ${limits(cfg, m).retentionDays} days.` : "Nothing is past its retention.");
    return 0;
  } finally {
    await b.end().catch(() => {});
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  if (!args.length || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    return args.length ? 0 : 1;
  }
  let m: Mod;
  try {
    m = await import("../message-board/src/index.ts");
  } catch {
    process.stderr.write(pyDumps({ code: "attach_no_board", message: "This install has no message board, which keeps the attachments.",
      fix: "Run `factory update` to a release that ships it." }) + "\n");
    return 1;
  }
  try {
    const cfg = mainSettings();
    if (args[0] === "ls") return await ls(cfg, m, args.slice(1));
    if (args[0] === "prune") return await prune(cfg, m);
    return await add(cfg, m, args);
  } catch (e) {
    if (e instanceof Refusal || e instanceof m.BoardError) {
      process.stderr.write(pyDumps({ code: e.code, message: e.message, fix: e.fix }) + "\n");
      throw new Exit(1);
    }
    throw e;
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
