// The web UI's first launch (#457): Join my factory, on a machine joining a factory that runs on another one (the hub).
//
//   POST /api/setup/join/preview   {code}: what the code connects to (the hub's address, this machine's name, its agents
//                                  and their roles, when it expires), never the board's password; runs nothing
//   POST /api/setup/join           {code, confirm: true}: runs `factory machine join <code>` in the serving project
//
// The code is the secret (factory_machine_join.ts): it is never sent back, nor written in an error. Errors are
// {code, message, fix}; a failed join answers with the command's own.
import { parseCode } from "./factory_join_code.ts";
import { type ActionResult, envFor, factoryScript, type Obj, resultOf, spawn, type UiProject } from "./factory_ui_data.ts";

/** A join checks Tailscale, redeems the code on the board and runs the doctor: give it longer than other actions. */
const JOIN_TIMEOUT_MS = 3 * 60_000;
/** How the command is named in answers, without the code. */
const JOIN_COMMAND = "factory machine join <code>";

function problem(status: number, code: string, message: string, fix: string): ActionResult {
  return { status, body: { code, message, fix } };
}

async function bodyOf(req: Request): Promise<Obj> {
  try {
    const b = (await req.json()) as unknown;
    return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Obj) : {};
  } catch {
    return {};
  }
}

const NOT_A_CODE = problem(400, "ui_join_code", "That isn't a join code.",
  "On the hub, open Machines › Add machine, and paste the whole code it shows (it starts with FM1-).");

/** The code in the body, checked: its content, or the problem to answer. */
function codeOf(b: Obj, now = Date.now()): { code: string; payload: NonNullable<ReturnType<typeof parseCode>> } | ActionResult {
  const code = typeof b.code === "string" ? b.code.trim() : "";
  const payload = parseCode(code);
  if (!payload) return NOT_A_CODE;
  if (payload.exp * 1000 <= now) {
    return problem(400, "ui_join_expired", `The join code for ${payload.name} has expired.`,
      "On the hub, open Machines, remove this machine and add it again for a new code, then paste that one.");
  }
  return { code, payload };
}

/** The answer for /api/setup/..., or null when the path isn't one of these. `p` is the project the server runs in. */
export async function setupApi(req: Request, parts: string[], p: UiProject): Promise<ActionResult | null> {
  if (parts[0] !== "join" || parts.length > 2 || (parts.length === 2 && parts[1] !== "preview")) return null;
  if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST with {\"code\": ...}.");
  const b = await bodyOf(req);
  const c = codeOf(b);
  if ("status" in c) return c;
  if (parts[1] === "preview") {
    const where = new URL(c.payload.url);
    return { status: 200, body: { machine: c.payload.name, hub: `${where.hostname}:${where.port || "5432"}`,
      agents: c.payload.agents.map((a) => ({ name: a.name, role: a.role })), expiresAt: c.payload.exp } };
  }
  if (b.confirm !== true) {
    return problem(400, "confirm_needed", "Joining changes this machine's settings (the board it talks to), so it needs a confirm.",
      'Send {"confirm": true} (the page asks you first).');
  }
  const r = await spawn(["bash", factoryScript(p), "machine", "join", c.code], p.path, envFor(p), JOIN_TIMEOUT_MS);
  const hide = (t: string): string => t.split(c.code).join("<code>");
  const out = resultOf(p, JOIN_COMMAND, { ...r, stdout: hide(r.stdout), stderr: hide(r.stderr) }, hide((r.stdout + r.stderr).trim()));
  return out;
}
