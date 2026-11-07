// The web UI's sign-off and testing page (#454, design docs/design/web-ui/Signoff.dc.html and SignoffItem.dc.html),
// served by factory_ui_server.ts. Everything goes through `factory signoff` (factory_signoff.ts, #101):
//
//   GET  /api/projects/:p/signoff                       {queue, items, problems}: every item, finished ones too, as
//                                                       `factory signoff ls --all --json` has it (who, when, its history)
//   POST /api/projects/:p/signoff {id, task, check}     `factory signoff add <id> --task <task> --check <text>`; the task
//                                                       is 12, #12 or b12 (a task made on the message board, #552)
//   POST /api/projects/:p/signoff/:id/confirm           `factory signoff confirm <id>`: the owner says the plan is what
//                                                       gets tested
//   POST /api/projects/:p/signoff/:id/result {outcome, note?}
//                                                       `factory signoff result <id> pass|fail|blocked [--note <note>]`
//
// Bad input is refused (400 signoff_bad_input) before anything runs; a refused command is a 500 with its own message and
// fix (#552). Run as a script in a project's folder (`bun factory_ui_signoff.ts read`), this file prints {queue, source,
// items}: the server reads the queue (the GitHub issue, or the board with `tasks.source` board) in a child process, so a
// slow GitHub never holds up the page.
import { join } from "node:path";
import { type ActionResult, envFor, factoryScript, type Obj, type Problem, spawn, type UiProject } from "./factory_ui_data.ts";

const ID = /^[A-Za-z0-9][\w.-]{0,63}$/; // factory_signoff.ts's own
const OUTCOMES = ["pass", "fail", "blocked"];
const TEXT_MAX = 4000;
const READ_MS = 60_000;
const ACTION_MS = 120_000;

export interface SignoffList {
  queue: number | null;
  items: Obj[];
  problems: Problem[];
}

function problem(status: number, code: string, message: string, fix: string): ActionResult {
  return { status, body: { code, message, fix } };
}

function bad(message: string): ActionResult {
  return problem(400, "signoff_bad_input", message, "Change what you typed and send it again.");
}

/** The queue of project `p`, read by this file run as a script in its folder. */
export async function signoffOf(p: UiProject): Promise<SignoffList> {
  if (p.problem) return { queue: null, items: [], problems: [p.problem] };
  const r = await spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "factory_ui_signoff.ts"), "read"],
    p.path, envFor(p), READ_MS);
  try {
    const data = JSON.parse(r.stdout) as { queue?: unknown; items?: unknown };
    if (r.code === 0 && Array.isArray(data.items)) {
      return { queue: typeof data.queue === "number" ? data.queue : null, items: data.items as Obj[], problems: [] };
    }
  } catch {
    // said below
  }
  const last = (r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? "";
  const board = onBoard(p);
  return { queue: null, items: [], problems: [{ code: "ui_signoff_unreadable",
    message: `The sign-off queue of ${p.name} can't be read from ${board ? "the message board" : "GitHub"} (${last.slice(0, 200) || `exit ${r.code}`}).`,
    fix: board ? "Check that this machine reaches the message board (`factory board status`, or the Machines page), then reload the page."
      : "Check that this machine is signed in to GitHub (the Machines page shows it), then reload the page." }] };
}

function onBoard(p: UiProject): boolean {
  const t = p.config?.tasks;
  return typeof t === "object" && t !== null && (t as Obj).source === "board";
}

/** Runs `factory signoff <args>` in project `p`: 200 with its output, else 500 with what went wrong and the command's own
 * fix (its `fix:` line), in plain words. */
async function signoff(p: UiProject, args: string[]): Promise<ActionResult> {
  const command = `factory signoff ${args.join(" ")}`;
  const r = await spawn(["bash", factoryScript(p), "signoff", ...args], p.path, envFor(p), ACTION_MS);
  const output = (r.stdout + r.stderr).trim();
  if (r.code === 0) return { status: 200, body: { ok: true, command, output } };
  const lines = r.stderr.trim().split("\n").map((l) => l.trim());
  const why = (lines.find((l) => l.startsWith("factory signoff: ")) ?? lines.find((l) => l && !l.startsWith("usage:")) ?? "")
    .replace(/^factory signoff: /, "").replace(/`/g, "").replace(/\.$/, "").trim();
  const own = (lines.find((l) => l.startsWith("fix: ")) ?? "").replace(/^fix: /, "").replace(/`/g, "").trim();
  const fix = own ? `${own.charAt(0).toUpperCase()}${own.slice(1)}${/[.!?]$/.test(own) ? "" : "."}`
    : `Reload the page to see the queue as it is now. If ${onBoard(p) ? "the message board" : "GitHub"} refused the write, check ` +
      "this machine on the Machines page, then try again.";
  return { status: 500, body: { ok: false, command, code: "ui_signoff_failed",
    message: `The sign-off queue wasn't changed${why ? `: ${why.slice(0, 300)}` : ""}.`, fix, output } };
}

function text(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : null;
}

/** A task as the API takes it: 12, "12", "#12" (an issue's) or "b12" (a task made on the board), as `factory signoff` takes
 * it ("12" or "b12"); null when it is none. */
function taskOf(v: unknown): string | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? String(v) : null;
  const m = typeof v === "string" ? /^(?:#?([1-9]\d*)|[bB]([1-9]\d*))$/.exec(v.trim()) : null;
  if (!m) return null;
  return m[1] ? m[1] : `b${m[2]}`;
}

async function bodyOf(req: Request): Promise<Obj> {
  try {
    const b = (await req.json()) as unknown;
    return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Obj) : {};
  } catch {
    return {};
  }
}

/** The answer to `/api/projects/:p/signoff[/...]` (`rest` starts with "signoff"). */
export async function signoffApi(req: Request, p: UiProject, rest: string[]): Promise<ActionResult> {
  if (rest.length === 1 && req.method === "GET") return { status: 200, body: { project: p.id, ...(await signoffOf(p)) } };
  if (rest.length === 1 && req.method === "POST") {
    const b = await bodyOf(req);
    const id = text(b.id) ?? "";
    const task = taskOf(b.task);
    const check = text(b.check) ?? "";
    if (!ID.test(id)) return bad("An id is letters, digits, dots and dashes, starting with a letter or digit, for example login-flow-2.");
    if (task === null) return bad("Say which task it is for: 12 or #12 for issue 12, b12 for a task made on the board.");
    if (!check || check.length > TEXT_MAX) return bad(`Say how a person checks it, in at most ${TEXT_MAX} characters.`);
    return signoff(p, ["add", id, "--task", task, "--check", check]);
  }
  if (rest.length === 1) return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET, or POST to add an item.");
  const verb = rest[2];
  if (rest.length !== 3 || (verb !== "confirm" && verb !== "result")) {
    return problem(404, "not_found", `There is no /signoff/${rest.slice(1).join("/")}.`, "An item has confirm and result.");
  }
  if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST.");
  const id = rest[1] ?? "";
  if (!ID.test(id)) return bad(`'${id.slice(0, 64)}' is not an item's id.`);
  if (verb === "confirm") return signoff(p, ["confirm", id]);
  const b = await bodyOf(req);
  const outcome = text(b.outcome) ?? "";
  if (!OUTCOMES.includes(outcome)) return bad("A result is pass, fail or blocked.");
  const note = text(b.note) ?? "";
  if (note.length > TEXT_MAX) return bad(`A note is at most ${TEXT_MAX} characters.`);
  return signoff(p, ["result", id, outcome, ...(note ? ["--note", note] : [])]);
}

if (import.meta.main) {
  const { readQueue } = await import("./factory_signoff.ts");
  const { runMain } = await import("./factory_lib.ts");
  await runMain(async () => {
    if (process.argv[2] !== "read") throw new Error("usage: factory_ui_signoff.ts read");
    console.log(JSON.stringify(await readQueue()));
  });
}
