// Adding a project from the web UI (#447): bring a GitHub repo (clone one, make a new one, or a folder already on this
// machine), install the factory in it, save the owner's answers in its .claude/factory.json, make its labels, owner queue
// and starter PRD (`factory init`), open a pull request with the setup, list it in the page, make sure the heartbeat daemon
// runs on this machine (`factory heartbeat ensure`; where it can't, the step is skipped with why and the fix) and run
// `factory doctor` there. The page shows each step as it goes; a failed step stops the run, and Retry goes
// on from that step. Each step looks first, so running one again adds nothing twice.
//
//   GET  /api/add-project                   the owner's repos (gh repo list), the folder new ones go in, the legends
//   POST /api/add-project/check             is this request good: the steps it would take, or {code, message, fix}
//   POST /api/add-project                   {confirm: true, ...request}: start a run (one at a time)
//   GET  /api/add-project/runs/:id          the run, step by step
//   POST /api/add-project/runs/:id/retry    {confirm: true}: go on from the failed step
//
// Every change is pushed to the page as {type: "add-project", run}; {type: "projects"} once the new project is listed.
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { addedFile, addedPaths, envFor, factoryScript, type Obj, type Problem, projectAt, readJson, type Ran, spawn,
  type UiProject } from "./factory_ui_data.ts";
import { messagingSettings } from "./core/compose.ts";
import { archiveName, cacheFolder, DEFAULT_REPO, type Pin, readPin, sha256File } from "./factory_release.ts";
import type { Config } from "./factory_config.ts";

const HOOKS = import.meta.dir;
const STEP_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CHARS = 4000;
const SETUP_BRANCH = "factory/setup";
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const INSTALLER = resolve(HOOKS, "..", "install.sh");
// A project installed from a release has no install.sh: its own release client puts the same release in the new folder (#537).
const SERVING_ROOT = resolve(HOOKS, "..", "..");
const RELEASE_CLIENT = join(HOOKS, "factory_release.ts");

/** The pin of the release that serves the page, or null (a my-skills checkout, or no readable pin). */
function servingPin(): Pin | null {
  try {
    return readPin(SERVING_ROOT);
  } catch {
    return null;
  }
}

/** The `protected` regex for a path the owner typed: anchored at the start, its dots and brackets taken as they are, and
 * a file (no / at the end) matched whole: "factory" protects ^factory$, not every path with factory in it. */
export function protectedRegex(path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}${path.endsWith("/") ? "" : "$"}`;
}

/** The 12 ready-made agents the owner picks from (the design's RULES.md). */
export const LEGENDS = ["menelik", "taytu", "haile", "tewodros", "yohannes", "zewditu", "lalibela", "ezana", "alula", "abebe",
  "fasil", "mentewab"];

export type Source = "clone" | "folder" | "new";

export interface AddRequest {
  source: Source;
  repo: string;
  path: string;
  visibility: "private" | "public";
  tasks: "issues" | "plan";
  mainBranch: string;
  test: string;
  lint: string;
  protected: string[];
  team: { devManager: string; productOwner: string; builders: string[] };
}

export type StepState = "waiting" | "running" | "done" | "skipped" | "failed";

export interface AddStep {
  id: string;
  title: string;
  detail: string;
  state: StepState;
  command: string;
  output: string;
  problem: Problem | null;
}

export interface AddRun {
  id: string;
  name: string;
  path: string;
  state: "running" | "done" | "failed";
  project: string | null;
  steps: AddStep[];
}

export interface AddHost {
  /** The project that serves the page. */
  serving: UiProject;
  /** The projects the page lists now. */
  projects: () => UiProject[];
  /** Lists `p` in the page (and tells it). */
  list: (p: UiProject) => void;
  publish: (m: Obj) => void;
}

export interface Answer {
  status: number;
  body: Obj;
}

function problem(code: string, message: string, fix: string): Problem {
  return { code, message, fix };
}

function isProblem(x: unknown): x is Problem {
  return typeof x === "object" && x !== null && typeof (x as Problem).code === "string" && typeof (x as Problem).fix === "string";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The serving project's messaging transport: board or github (core/compose.ts; unset, board on a machine with a board). */
function messagingOf(p: UiProject): "github" | "board" {
  return messagingSettings((p.config ?? {}) as Config).transport === "board" ? "board" : "github";
}

/** Whether the serving project's file names the board itself (a new project then names it too). */
function namesBoard(p: UiProject): boolean {
  const m = p.config?.messaging;
  return typeof m === "object" && m !== null && (m as Obj).transport === "board";
}

/** The repo's name, the part after the owner. */
function repoBase(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function git(path: string, args: string[]): Promise<Ran> {
  return spawn(["git", "-C", path, ...args], path, gitEnv(), 60_000);
}

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** The origin of the checkout at `path` ends with `repo` (owner/name, .git or not). */
async function isCheckoutOf(path: string, repo: string): Promise<boolean> {
  if (!isDir(path)) return false;
  const r = await git(path, ["remote", "get-url", "origin"]);
  const url = r.stdout.trim().replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  return r.code === 0 && (url.endsWith(`/${repo.toLowerCase()}`) || url.endsWith(`:${repo.toLowerCase()}`));
}

// --- the request -------------------------------------------------------------------------------------------------------

/** The request in `body`, checked against the disk and the projects listed, or what is wrong with it. Reads only. */
export async function validate(body: unknown, host: AddHost): Promise<AddRequest | Problem> {
  const b: Obj = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Obj) : {};
  const source = b.source;
  if (source !== "clone" && source !== "folder" && source !== "new") {
    return problem("ui_add_source", "Say where the project comes from.", "Pick Clone from GitHub, A folder on this machine or Create a new repo.");
  }
  const repo = str(b.repo);
  if (source !== "folder" && !REPO.test(repo)) {
    return problem("ui_add_repo", `${repo ? `"${repo}"` : "No repo"} isn't a GitHub repo name.`, "Pick a repo from the list, or type it as owner/name.");
  }
  const given = str(b.path);
  if (!given || !isAbsolute(given)) {
    return problem("ui_add_path", `${given ? `"${given}"` : "No folder"} isn't a full path.`, "Type the folder from the top, for example /home/you/dev/shop.");
  }
  const path = resolve(given);
  if (source === "folder") {
    if (!isDir(path)) return problem("ui_add_path", `${path} isn't there.`, "Pick a folder that exists on this machine, or clone the repo instead.");
    const top = await git(path, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return problem("ui_add_not_git", `${path} isn't a git repo.`, "Pick the folder of a git checkout of the project, or clone it from GitHub instead.");
    const root = top.stdout.trim();
    if (realpathSync(root) !== realpathSync(path)) {
      return problem("ui_add_not_top", `${path} is inside the checkout ${root}, not its top folder.`, `Pick ${root} instead.`);
    }
  } else if (existsSync(path) && !(await isCheckoutOf(path, repo))) {
    return problem("ui_add_path_taken", `${path} is already there and isn't a checkout of ${repo}.`, "Pick another folder to clone into.");
  }
  // the setup commits everything in the folder, so a checkout already there must have nothing uncommitted (an untracked .env too)
  if (existsSync(path) && (await git(path, ["status", "--porcelain"])).stdout.trim()) {
    return problem("ui_add_dirty", `${path} has changes that aren't committed.`, "Commit or put them aside in that folder, then press Continue again.");
  }
  // the same folder by another name (a symlink, or macOS's /var and /private/var) is the same project
  const known = host.projects().find((p) => samePath(p.path, path));
  if (known) return problem("ui_add_known", `${path} is already in this factory, as ${known.name}.`, `Open ${known.name} on the left instead.`);
  if (source === "folder") {
    // the setup fetches main from origin and opens its pull request there, so a folder with no origin would stop half way (#546)
    const origin = await git(path, ["remote", "get-url", "origin"]);
    if (origin.code !== 0 || !origin.stdout.trim()) {
      return problem("ui_add_no_remote", `${path} has no remote called origin, so its setup pull request would have nowhere to go.`,
        `Add the project's GitHub repo as its origin (in that folder: git remote add origin https://github.com/<owner>/<name>.git, then git push -u origin main), or pick Create a new repo instead.`);
    }
  }
  const tasks = b.tasks;
  if (tasks !== "issues" && tasks !== "plan") return problem("ui_add_tasks", "Say where tasks come from.", "Pick GitHub issues or A build plan file.");
  const mainBranch = str(b.mainBranch);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(mainBranch) || mainBranch === SETUP_BRANCH) {
    return problem("ui_add_branch", `${!mainBranch ? "No main branch" : mainBranch === SETUP_BRANCH
      ? `"${SETUP_BRANCH}" is the branch the setup goes on, so it` : `"${mainBranch}"`} isn't a main branch name.`,
      "Type the branch pull requests go into, usually main. It starts with a letter or digit.");
  }
  const t: Obj = typeof b.team === "object" && b.team !== null ? (b.team as Obj) : {};
  const team = { devManager: str(t.devManager), productOwner: str(t.productOwner),
    builders: Array.isArray(t.builders) ? t.builders.map(str) : [] };
  const names = [team.devManager, team.productOwner, ...team.builders];
  const bad = names.find((n) => !AGENT_NAME.test(n));
  if (!team.builders.length || bad !== undefined || new Set(names).size !== names.length) {
    return problem("ui_add_team", !team.builders.length ? "The team has no builder." : bad !== undefined
      ? `"${bad}" isn't an agent name.` : "Two agents have the same name.",
      "Pick at least one builder, and give every agent its own name: lowercase letters, digits and dashes.");
  }
  const prot = Array.isArray(b.protected) ? b.protected.map(str).filter(Boolean) : [];
  const odd = prot.find((p) => /[\u0000-\u001f\u007f]/.test(p) || p.startsWith("/"));
  if (odd !== undefined) {
    return problem("ui_add_protected", `"${odd}" isn't a path in the repo.`, "Type each protected path from the repo's top, without a leading /, for example migrations/.");
  }
  if (!existsSync(INSTALLER) && !servingPin()) {
    return problem("ui_add_no_installer", "This factory has no installer beside it and no release pin, so it can't install itself into another project.",
      "Install the factory here from a release (`factory update`), or start the web UI from a my-skills checkout, then add the project again.");
  }
  return { source, repo: source === "folder" ? "" : repo, path, visibility: b.visibility === "public" ? "public" : "private", tasks,
    mainBranch, test: str(b.test), lint: str(b.lint), protected: [...new Set(prot)], team };
}

/** The steps a request takes, in order, each with what it does in plain words. */
export function plan(req: AddRequest, host: AddHost): { id: string; title: string; detail: string }[] {
  const name = req.repo || basename(req.path);
  return [
    { id: "repo", title: req.source === "clone" ? "Clone the repo" : req.source === "new" ? "Create the repo" : "Check the folder",
      detail: req.source === "clone" ? `${req.repo} into ${req.path}` : req.source === "new"
        ? `A ${req.visibility} repo ${req.repo} on GitHub, cloned into ${req.path}` : `${req.path} is a git checkout with no changes` },
    { id: "kit", title: "Install the factory", detail: "The agents, their rules, the hooks and the templates; a file already there is kept" },
    { id: "answers", title: "Save your answers", detail: "Task source, main branch, commands, protected paths and the team, in the project's settings" },
    { id: "init", title: "Labels, owner queue and PRD", detail: `${req.tasks === "issues" ? "The task labels, " : ""}the owner queue issue, a starter PRD and the role folders` },
    { id: "commit", title: "Open the setup pull request", detail: `Everything above on the branch ${SETUP_BRANCH}, for you to merge into ${req.mainBranch}` },
    { id: "list", title: "Show it in the sidebar", detail: `${name} joins the projects on the left` },
    { id: "heartbeat", title: "Watch its agents", detail: "The heartbeat daemon on this machine, so each agent shows as running, waiting or down" },
    { id: "doctor", title: "Check the project", detail: "Each check the factory needs, with what to do for any that fails" },
  ];
}

// --- the steps ---------------------------------------------------------------------------------------------------------

interface Done {
  state: "done" | "skipped";
  output: string;
}

class StepFailed extends Error {
  constructor(readonly problem: Problem, readonly output: string) {
    super(problem.message);
  }
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > OUTPUT_CHARS ? `…${t.slice(-OUTPUT_CHARS)}` : t;
}

/** Runs `cmd` in `cwd`, adding it to `log`; a non-zero exit fails the step with `fix`. */
async function must(step: AddStep, cmd: string[], cwd: string, env: Record<string, string>, fix: string): Promise<string> {
  const shown = cmd.map((x) => (/^[\w./:@=-]+$/.test(x) ? x : JSON.stringify(x))).join(" ");
  step.command = step.command ? `${step.command}\n${shown}` : shown;
  const r = await spawn(cmd, cwd, env, STEP_TIMEOUT_MS);
  const out = tail(`${r.stdout}\n${r.stderr}`);
  if (r.code !== 0) {
    const last = r.stderr.trim().split("\n").at(-1) ?? "";
    let own: Obj = {};
    try {
      own = JSON.parse(last) as Obj;
    } catch {
      // not one of ours
    }
    throw new StepFailed(isProblem(own) ? own : problem("ui_add_step_failed", `${step.title} didn't work (${(last || `exit ${r.code}`).slice(0, 200)}).`, fix), out);
  }
  return out;
}

/** The new project as a UiProject (its factory.json as it is now). */
function newProject(req: AddRequest, host: AddHost): UiProject {
  return projectAt(host.projects(), req.path);
}

async function stepRepo(req: AddRequest, step: AddStep): Promise<Done> {
  if (req.source === "folder") return { state: "done", output: `${req.path} is a git checkout.` };
  if (await isCheckoutOf(req.path, req.repo)) return { state: "skipped", output: `${req.path} is already a checkout of ${req.repo}.` };
  const parent = dirname(req.path);
  mkdirSync(parent, { recursive: true });
  const env = gitEnv();
  const outs: string[] = [];
  if (req.source === "new") {
    const seen = await spawn(["gh", "repo", "view", req.repo, "--json", "name"], parent, env, 60_000);
    if (seen.code === 0) outs.push(`${req.repo} is already on GitHub: cloning it.`);
    else {
      outs.push(await must(step, ["gh", "repo", "create", req.repo, `--${req.visibility}`, "--add-readme"], parent, env,
        "Check that GitHub is signed in on this machine and that the name is free, then press Retry."));
    }
  }
  outs.push(await must(step, ["gh", "repo", "clone", req.repo, req.path], parent, env,
    "Check that GitHub is signed in on this machine and that you can read the repo, then press Retry."));
  return { state: "done", output: outs.filter(Boolean).join("\n") };
}

async function stepKit(req: AddRequest, step: AddStep): Promise<Done> {
  if (existsSync(INSTALLER)) {
    return { state: "done", output: await must(step, ["bash", INSTALLER, req.path], req.path, gitEnv(), "Read what it printed, fix it, then press Retry.") };
  }
  return releaseKit(req, step);
}

/** Installs the release that serves the page into the new folder with its own release client: from the download cache
 * when it holds that exact archive, else by downloading the tag; then the new pin must name that same archive (#537). */
async function releaseKit(req: AddRequest, step: AddStep): Promise<Done> {
  const pin = servingPin();
  const tag = pin?.tag ?? "";
  const repo = pin?.repo || DEFAULT_REPO;
  const folder = cacheFolder(repo, tag);
  const archive = join(folder, archiveName(tag));
  const fix = `Get the archive of ${tag} (software-factory-${tag.replace(/^v/, "")}.tar.gz and its SHA256SUMS), then in ${req.path} run ` +
    `\`factory update --archive <archive> --sums <SHA256SUMS>\` and press Retry.`;
  if (!pin) throw new StepFailed(problem("ui_add_no_installer", "The release that serves this page has no pin any more.", fix), "");
  const cached = existsSync(archive) && sha256File(archive) === pin.sha256;
  const args = cached ? ["update", "--archive", archive, "--sums", join(folder, "SHA256SUMS")] : ["update", tag];
  // the page is the owner's (factory ui refuses FACTORY_AGENT and FACTORY_LOOP), so the owner's own Claude Code session
  // (CLAUDECODE) is not an agent here; the agent variables are kept, and the client still refuses them
  const env: Record<string, string> = { ...gitEnv(), FACTORY_RELEASE_REPO: repo };
  delete env.CLAUDECODE;
  const out = await must(step, [process.execPath, "--no-env-file", "--config=/dev/null", RELEASE_CLIENT, ...args], req.path, env, fix);
  let got: Pin | null = null;
  try {
    got = readPin(req.path);
  } catch {
    got = null;
  }
  if (!got || got.sha256 !== pin.sha256) {
    throw new StepFailed(problem("ui_add_release_differs", `${req.path} didn't get the same ${tag} as this page runs ` +
      `(${got ? `its archive is ${got.sha256.slice(0, 12)}…, this page's is ${pin.sha256.slice(0, 12)}…` : "no pin was written"}).`, fix), out);
  }
  return { state: "done", output: out };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function objAt(o: Obj, key: string): Obj {
  const v = o[key];
  const made = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
  o[key] = made;
  return made;
}

function stepAnswers(req: AddRequest, step: AddStep, host: AddHost): Done {
  const file = join(req.path, ".claude", "factory.json");
  step.command = `write ${file}`;
  let cfg: Obj = {};
  if (existsSync(file)) {
    const raw = readJson(file);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new StepFailed(problem("ui_add_settings_unreadable", `${file} isn't a JSON object, so your answers can't be added to it.`,
        "Fix the file (or delete it to start from the template with Retry), then press Retry."), "");
    }
    cfg = raw as Obj;
  }
  objAt(cfg, "tasks").source = req.tasks;
  cfg.mainBranch = req.mainBranch;
  const commands = objAt(cfg, "commands");
  if (req.test) commands.test = req.test;
  if (req.lint) commands.lint = req.lint;
  const had = Array.isArray(cfg.protected) ? cfg.protected.filter((p): p is string => typeof p === "string") : [];
  cfg.protected = [...new Set([...had, ...req.protected.map(protectedRegex)])];
  cfg.agents = req.team.builders;
  const roles = objAt(cfg, "roles");
  objAt(roles, "dev-manager").names = [req.team.devManager];
  objAt(roles, "product-owner").names = [req.team.productOwner];
  if (namesBoard(host.serving)) objAt(cfg, "messaging").transport = "board";
  writeJson(file, cfg);
  return { state: "done", output: `Saved in ${file}.` };
}

async function stepInit(req: AddRequest, step: AddStep, host: AddHost): Promise<Done> {
  const p = newProject(req, host);
  return { state: "done", output: await must(step, ["bash", join(req.path, "factory"), "init"], req.path, envFor(p),
    "Read what it printed (GitHub must be signed in on this machine), fix it, then press Retry.") };
}

async function stepCommit(req: AddRequest, step: AddStep): Promise<Done> {
  const env = gitEnv();
  const fix = "Read what it printed, fix it in the project's folder, then press Retry.";
  const outs: string[] = [];
  const changed = (await git(req.path, ["status", "--porcelain"])).stdout.trim() !== "";
  const branch = (await git(req.path, ["branch", "--show-current"])).stdout.trim();
  if (!changed && branch !== SETUP_BRANCH) return { state: "skipped", output: "Nothing changed in the repo: it already runs the factory." };
  if (branch !== SETUP_BRANCH) {
    // from the main branch as GitHub has it, so the pull request holds the setup and nothing else; the changes come along
    const fetched = await git(req.path, ["fetch", "-q", "origin", req.mainBranch]);
    if (fetched.code !== 0) {
      throw new StepFailed(problem("ui_add_fetch", `${req.mainBranch} couldn't be fetched from the repo's origin, so the setup branch has nothing to start from.`,
        `Check that ${req.mainBranch} is on GitHub and that you can read the repo from this machine, then press Retry.`), tail(fetched.stderr));
    }
    outs.push(await must(step, ["git", "-C", req.path, "checkout", "-B", SETUP_BRANCH, `origin/${req.mainBranch}`], req.path, env,
      `A file the setup changed differs between the branch checked out in ${req.path} and ${req.mainBranch} (what it printed names it). ` +
      `In that folder, put the setup's changes aside, check out ${req.mainBranch}, then add the project again.`));
  }
  if (changed) {
    outs.push(await must(step, ["git", "-C", req.path, "add", "-A"], req.path, env, fix));
    outs.push(await must(step, ["git", "-C", req.path, "commit", "-m", "Set up the factory"], req.path, env, fix));
  }
  outs.push(await must(step, ["git", "-C", req.path, "push", "-u", "origin", SETUP_BRANCH], req.path, env,
    "Check that you can push to the repo from this machine, then press Retry."));
  const open = await spawn(["gh", "pr", "list", "--head", SETUP_BRANCH, "--state", "open", "--json", "number,url"], req.path, env, 60_000);
  let prs: unknown = [];
  try {
    prs = JSON.parse(open.stdout || "[]");
  } catch {
    // read as none
  }
  if (open.code === 0 && Array.isArray(prs) && prs.length) {
    outs.push(`The setup pull request is already open: ${String((prs[0] as Obj).url ?? "")}`);
  } else {
    outs.push(await must(step, ["gh", "pr", "create", "--base", req.mainBranch, "--head", SETUP_BRANCH, "--title", "Set up the factory",
      "--body", "The factory's kit and the answers given when the project was added from the web UI. Merge it to start the agents."],
      req.path, env, "Check that GitHub is signed in on this machine, then press Retry."));
  }
  return { state: "done", output: outs.filter(Boolean).join("\n") };
}

function stepList(req: AddRequest, step: AddStep, host: AddHost, run: AddRun): Done {
  const file = addedFile(host.serving.path);
  step.command = `write ${file}`;
  const kept = addedPaths(host.serving.path);
  if (!kept.includes(req.path)) writeJson(file, [...kept, req.path]);
  const listed = host.projects().find((p) => resolve(p.path) === req.path);
  const p = listed ?? newProject(req, host);
  if (!listed) host.list(p);
  run.project = p.id;
  return { state: listed ? "skipped" : "done", output: `${p.name} is on the left.` };
}

/** `factory heartbeat ensure` in the new project: installed if missing, started if stopped, nothing if it runs. A machine
 *  where it can't run (no systemd user manager) doesn't stop the setup: the step says why and what to do, and the agents'
 *  state is then worked out each time it is asked. */
async function stepHeartbeat(req: AddRequest, step: AddStep, host: AddHost): Promise<Done> {
  const p = newProject(req, host);
  try {
    return { state: "done", output: await must(step, ["bash", join(req.path, "factory"), "heartbeat", "ensure"], req.path, envFor(p),
      "Run `factory heartbeat install` in the project.") };
  } catch (e) {
    if (!(e instanceof StepFailed)) throw e;
    return { state: "skipped", output: `The heartbeat daemon couldn't be started here: ${e.problem.message} Fix: ${e.problem.fix}` };
  }
}

async function stepDoctor(req: AddRequest, step: AddStep, host: AddHost): Promise<Done> {
  const p = newProject(req, host);
  return { state: "done", output: await must(step, ["bash", join(req.path, "factory"), "doctor"], req.path, envFor(p),
    "Fix what it says (each failed check has its own fix), then press Retry.") };
}

// --- the runs ----------------------------------------------------------------------------------------------------------

export class AddRuns {
  private readonly runs = new Map<string, { run: AddRun; req: AddRequest }>();
  private n = 0;

  constructor(private readonly host: AddHost) {}

  /** What the Add a project screen starts from. */
  async info(): Promise<Obj> {
    const env = gitEnv();
    const r = await spawn(["gh", "repo", "list", "--json", "nameWithOwner,isPrivate,updatedAt", "--limit", "100"], this.host.serving.path, env, 60_000);
    const problems: Problem[] = [];
    let rows: Obj[] = [];
    try {
      const raw = r.code === 0 ? JSON.parse(r.stdout) as unknown : null;
      if (Array.isArray(raw)) rows = raw.filter((x): x is Obj => typeof x === "object" && x !== null);
    } catch {
      // treated as a failure below
    }
    if (r.code !== 0) {
      problems.push(problem("ui_add_github", "Your repos can't be read from GitHub on this machine.",
        "Sign in to GitHub on this machine (gh auth login), then open this page again. A folder on this machine works without it."));
    }
    const origins = await Promise.all(this.host.projects().map(async (p) => ({ p, url: (await git(p.path, ["remote", "get-url", "origin"])).stdout.trim() })));
    const inFactory = (repo: string): string | null => {
      const want = repo.toLowerCase();
      const hit = origins.find(({ url }) => {
        const u = url.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
        return u.endsWith(`/${want}`) || u.endsWith(`:${want}`);
      });
      return hit ? hit.p.name : null;
    };
    const repos = rows.map((x) => ({ name: str(x.nameWithOwner), private: x.isPrivate === true, updatedAt: str(x.updatedAt) }))
      .filter((x) => x.name).map((x) => ({ ...x, inFactory: inFactory(x.name) }));
    return { repos, folder: dirname(resolve(this.host.serving.path)), projects: this.host.projects().map((p) => ({ id: p.id, name: p.name, path: p.path })),
      messaging: messagingOf(this.host.serving), legends: LEGENDS, problems };
  }

  get(id: string): AddRun | null {
    return this.runs.get(id)?.run ?? null;
  }

  private busy(): boolean {
    return [...this.runs.values()].some((r) => r.run.state === "running");
  }

  /** Starts a run of `req` and answers at once; the steps go on in the background. */
  start(req: AddRequest): Answer {
    if (this.busy()) return { status: 409, body: { ...problem("ui_add_busy", "A project is being added already.", "Wait until it is done or stops, then try again.") } };
    const id = String(++this.n);
    const run: AddRun = { id, name: req.repo ? repoBase(req.repo) : basename(req.path), path: req.path, state: "running", project: null,
      steps: plan(req, this.host).map((s) => ({ ...s, state: "waiting", command: "", output: "", problem: null })) };
    this.runs.set(id, { run, req });
    void this.go(run, req);
    return { status: 202, body: { run } };
  }

  retry(id: string): Answer {
    const kept = this.runs.get(id);
    if (!kept) return { status: 404, body: { ...problem("ui_add_run_unknown", `There is no run ${id}.`, "Start adding the project again.") } };
    if (kept.run.state !== "failed") {
      return { status: 409, body: { ...problem("ui_add_not_failed", `That run is ${kept.run.state}, so there is nothing to retry.`, "Retry is for a run that stopped at a step.") } };
    }
    if (this.busy()) return { status: 409, body: { ...problem("ui_add_busy", "A project is being added already.", "Wait until it is done or stops, then try again.") } };
    kept.run.state = "running";
    void this.go(kept.run, kept.req);
    return { status: 202, body: { run: kept.run } };
  }

  private send(run: AddRun): void {
    this.host.publish({ type: "add-project", run });
  }

  private async go(run: AddRun, req: AddRequest): Promise<void> {
    for (const step of run.steps) {
      if (step.state === "done" || step.state === "skipped") continue;
      step.state = "running";
      step.command = "";
      step.output = "";
      step.problem = null;
      this.send(run);
      try {
        const r = await this.one(step, req, run);
        step.state = r.state;
        step.output = r.output;
      } catch (e) {
        step.state = "failed";
        step.problem = e instanceof StepFailed ? e.problem
          : problem("ui_add_step_failed", `${step.title} didn't work (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}).`, "Press Retry; if it fails again, run factory doctor in the project.");
        step.output = e instanceof StepFailed ? e.output : "";
        run.state = "failed";
        this.send(run);
        return;
      }
      this.send(run);
    }
    run.state = "done";
    this.send(run);
  }

  private one(step: AddStep, req: AddRequest, run: AddRun): Promise<Done> | Done {
    switch (step.id) {
      case "repo": return stepRepo(req, step);
      case "kit": return stepKit(req, step);
      case "answers": return stepAnswers(req, step, this.host);
      case "init": return stepInit(req, step, this.host);
      case "commit": return stepCommit(req, step);
      case "list": return stepList(req, step, this.host, run);
      case "heartbeat": return stepHeartbeat(req, step, this.host);
      default: return stepDoctor(req, step, this.host);
    }
  }

  /** The API under /api/add-project (`rest` is what follows it); null when it isn't one of these. */
  async api(req: Request, rest: string[]): Promise<Answer | null> {
    const body = async (): Promise<unknown> => req.json().catch(() => null);
    const confirmed = (b: unknown): boolean => typeof b === "object" && b !== null && (b as Obj).confirm === true;
    const needConfirm: Answer = { status: 400, body: { ...problem("confirm_needed", "Adding a project changes GitHub and this machine, so it needs a confirm.",
      'Send {"confirm": true} (the page asks you first).') } };
    if (rest.length === 0) {
      if (req.method === "GET") return { status: 200, body: await this.info() };
      if (req.method !== "POST") return null;
      const b = await body();
      if (!confirmed(b)) return needConfirm;
      const r = await validate(b, this.host);
      return isProblem(r) ? { status: 400, body: { ...r } } : this.start(r);
    }
    if (rest.length === 1 && rest[0] === "check" && req.method === "POST") {
      const r = await validate(await body(), this.host);
      return isProblem(r) ? { status: 400, body: { ...r } } : { status: 200, body: { ok: true, steps: plan(r, this.host) } };
    }
    if (rest[0] === "runs" && rest.length === 2 && req.method === "GET") {
      const run = this.get(rest[1] as string);
      return run ? { status: 200, body: { run } } : { status: 404, body: { ...problem("ui_add_run_unknown", `There is no run ${rest[1]}.`, "Start adding the project again.") } };
    }
    if (rest[0] === "runs" && rest.length === 3 && rest[2] === "retry" && req.method === "POST") {
      if (!confirmed(await body())) return needConfirm;
      return this.retry(rest[1] as string);
    }
    return null;
  }
}

/** Whether two paths name the same folder once symlinks are followed (a path that doesn't exist is taken as it is). */
function samePath(a: string, b: string): boolean {
  const real = (x: string): string => {
    try {
      return realpathSync(resolve(x));
    } catch {
      return resolve(x);
    }
  };
  return real(a) === real(b);
}
