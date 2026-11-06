// The web UI's designs and artifacts page (#454, design docs/design/web-ui/Artifacts.dc.html), served by
// factory_ui_server.ts. Everything goes through `factory artifacts` (factory_artifacts.ts, #104):
//
//   GET  /api/projects/:p/artifacts       {artifacts, fetch, problems}: each copy in the manifest with how it stands
//                                         (`factory artifacts status --json`), and `review`, the open pull request with
//                                         its new copy (a branch `artifacts/<id>/...` in the cockpit's cache), else null;
//                                         `fetch` says whether this project can fetch an artifact (artifacts.fetch is set)
//   POST /api/projects/:p/artifacts/pull  {artifact, dest?, confirm: true}: `factory artifacts pull <artifact> [dest] --pr`,
//                                         the new copy on its own branch and pull request; this checkout is not changed
//
// Bad input is refused (400 artifacts_bad_input) and a pull without a confirm asks for one (400 confirm_needed), before
// anything runs.
import { join } from "node:path";
import { type ActionResult, envFor, factoryScript, type Obj, type Problem, readJson, spawn, stateDirOf, type UiProject } from "./factory_ui_data.ts";

const READ_MS = 120_000;
const PULL_MS = 5 * 60_000;
const ARTIFACT = /^[A-Za-z0-9][^\s]{0,299}$/;
const DEST = /^[A-Za-z0-9_][\w./-]{0,199}$/;

export interface ArtifactRow {
  id: string;
  url: string;
  title: string;
  dest: string;
  pulledAt: string;
  pulledBy: string;
  state: string;
  detail: string;
  review: { number: number; url: string } | null;
}

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function problem(status: number, code: string, message: string, fix: string): ActionResult {
  return { status, body: { code, message, fix } };
}

/** The open pull requests of `p` by branch, from the cockpit's cache. */
function pullsOf(p: UiProject): Obj[] {
  const pulls = obj(readJson(join(stateDirOf(p), "cockpit.json"))).pulls;
  return Array.isArray(pulls) ? pulls.map(obj) : [];
}

/** Every copy in project `p`'s manifest, with how it stands and its open review. */
export async function artifactsOf(p: UiProject): Promise<{ artifacts: ArtifactRow[]; fetch: boolean; problems: Problem[] }> {
  const fetch = Boolean(str(obj(p.config?.artifacts).fetch).trim());
  if (p.problem) return { artifacts: [], fetch, problems: [p.problem] };
  const r = await spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "factory_artifacts.ts"), "status", "--json"],
    p.path, envFor(p), READ_MS);
  let rows: unknown = null;
  try {
    rows = JSON.parse(r.stdout) as unknown;
  } catch {
    // said below
  }
  if (r.code !== 0 || !Array.isArray(rows)) {
    let own: Obj = {};
    try {
      own = obj(JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "") as unknown);
    } catch {
      // not one of ours
    }
    const why = str(own.message) || (r.stderr.trim().split("\n").at(-1) ?? "").slice(0, 200) || `exit ${r.code}`;
    return { artifacts: [], fetch, problems: [{ code: "ui_artifacts_unreadable", message: `The list of copies can't be read: ${why}`,
      fix: "Fix the list of copies in the repo (docs/artifacts.json by default), then reload the page." }] };
  }
  const pulls = pullsOf(p);
  const artifacts = rows.map(obj).map((x): ArtifactRow => {
    const id = str(x.id);
    const pr = pulls.find((q) => str(q.branch).startsWith(`artifacts/${id}/`));
    return { id, url: str(x.url), title: str(x.title), dest: str(x.dest), pulledAt: str(x.pulledAt), pulledBy: str(x.pulledBy),
      state: str(x.state), detail: str(x.detail), review: pr ? { number: Number(pr.number), url: str(pr.url) } : null };
  });
  return { artifacts, fetch, problems: [] };
}

async function bodyOf(req: Request): Promise<Obj> {
  try {
    return obj((await req.json()) as unknown);
  } catch {
    return {};
  }
}

/** Runs `factory artifacts pull <artifact> [dest] --pr` in project `p`: 200 with its output, else 500 in plain words. */
async function pull(p: UiProject, artifact: string, dest: string): Promise<ActionResult> {
  const args = ["pull", artifact, ...(dest ? [dest] : []), "--pr"];
  const command = `factory artifacts ${args.join(" ")}`;
  const r = await spawn(["bash", factoryScript(p), "artifacts", ...args], p.path, envFor(p), PULL_MS);
  const output = (r.stdout + r.stderr).trim();
  if (r.code === 0) return { status: 200, body: { ok: true, command, output } };
  let own: Obj = {};
  try {
    own = obj(JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "") as unknown);
  } catch {
    // not one of ours
  }
  const why = str(own.message) || (r.stderr.trim().split("\n").at(-1) ?? "").slice(0, 200) || `exit ${r.code}`;
  return { status: 500, body: { ok: false, command, code: str(own.code) || "ui_artifacts_failed", message: `No pull request was opened: ${why}`,
    fix: "Nothing changed in the repo. Fix what it says on the machine that serves this page, then try again.", output } };
}

/** The answer to `/api/projects/:p/artifacts[/pull]` (`rest` starts with "artifacts"). */
export async function artifactsApi(req: Request, p: UiProject, rest: string[]): Promise<ActionResult> {
  if (rest.length === 1) {
    if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
    return { status: 200, body: { project: p.id, ...(await artifactsOf(p)) } };
  }
  if (rest.length !== 2 || rest[1] !== "pull") return problem(404, "not_found", `There is no /artifacts/${rest.slice(1).join("/")}.`, "Use /artifacts/pull.");
  if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST with {\"confirm\": true}.");
  const b = await bodyOf(req);
  const artifact = str(b.artifact).trim();
  const dest = str(b.dest).trim();
  if (!ARTIFACT.test(artifact)) {
    return problem(400, "artifacts_bad_input", "That isn't an artifact's link or id.", "Paste the artifact's link (https://claude.ai/artifact/…) or its id.");
  }
  if (dest && (!DEST.test(dest) || dest.split("/").includes(".."))) {
    return problem(400, "artifacts_bad_input", `'${dest.slice(0, 80)}' isn't a folder inside the project.`, "Leave it empty, or give a folder such as docs/design/home.");
  }
  if (b.confirm !== true) {
    return problem(400, "confirm_needed", "Pulling a new copy opens a pull request, so it needs a confirm.", 'Send {"confirm": true} (the page asks you first).');
  }
  return pull(p, artifact, dest);
}
