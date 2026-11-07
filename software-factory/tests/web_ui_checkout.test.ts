// A settings change merged from the web UI takes effect on this machine (#566). After the UI merges a pull request
// into main, the project's checkout is brought up to date when that is safe (on main, or detached on a commit main has,
// as the loop leaves it; clean apart from ignored files; able to fast-forward), and left alone otherwise, with the
// answer saying why. Factory settings has the same move (GET and POST /api/projects/:p/settings/checkout). Driven
// through the real server with a fake `gh`, a fake `factory` whose `owner merge` pushes the merged commit to a bare
// origin, and real git.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aLoop, baseEnv } from "./claims_support.ts";
import { git, runHook, write } from "./support.ts";
import { api, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { PR_CONFIG, prProject } from "./web_ui_pr_support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// `owner merge` stands in for GitHub's merge: the commit prepared in the upstream clone lands on origin's main.
const FAKE = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
case "$1 $2" in
  "owner merge") git -C "$FAKE_UPSTREAM" push -q origin HEAD:main && echo "Merged #$3." ;;
  *) echo "fake factory: $*" ;;
esac
`;

interface Setup {
  p: Project;
  ui: Running;
  /** The clone that holds the merged change (haile joins the team) until `owner merge` pushes it. */
  upstream: string;
  /** main before the merge. */
  before: string;
}

/** A project with an origin, its checkout on main and clean, and a merged change waiting upstream. `prepare` changes the
 * checkout before the server starts; `pushed`: the change is already on GitHub (merged elsewhere). */
async function started(prepare: (p: Project) => void = () => undefined, pushed = false): Promise<Setup> {
  const p = project(PR_CONFIG);
  roots.push(p.root);
  write(join(p.d, "factory"), FAKE, 0o755);
  write(join(p.d, ".gitignore"), "node_modules/\n");
  write(join(p.d, "README.md"), "# work\n");
  git(p.d, "add", "-A");
  git(p.d, "commit", "-qm", "the project");
  const origin = join(p.root, "origin.git");
  git(p.root, "clone", "-q", "--bare", p.d, origin);
  git(p.d, "remote", "add", "origin", origin);
  git(p.d, "fetch", "-q", "origin");
  git(p.d, "branch", "-q", "--set-upstream-to=origin/main", "main");
  const upstream = join(p.root, "upstream");
  git(p.root, "clone", "-q", origin, upstream);
  git(upstream, "config", "user.email", "t@example.com");
  git(upstream, "config", "user.name", "t");
  git(upstream, "config", "commit.gpgsign", "false");
  write(join(upstream, ".claude", "factory.json"), JSON.stringify({ ...PR_CONFIG, agents: ["menelik", "taytu", "haile"] }));
  git(upstream, "commit", "-qam", "Factory settings: haile joins the team (#52)");
  if (pushed) git(upstream, "push", "-q", "origin", "HEAD:main");
  prProject(p);
  const before = head(p.d);
  prepare(p);
  const ui = await startUi(p, ["--port", "0"], null, { FAKE_UPSTREAM: upstream });
  running.push(ui);
  return { p, ui, upstream, before };
}

function head(dir: string): string {
  return git(dir, "rev-parse", "HEAD").trim();
}

function agentsIn(dir: string): unknown {
  return (JSON.parse(readFileSync(join(dir, ".claude", "factory.json"), "utf8")) as Row).agents;
}

const merge = (ui: Running) => api(ui, "/api/projects/work/pull-requests/22/actions/merge", { method: "POST", body: { confirm: true } });

async function teamNames(ui: Running): Promise<string[]> {
  const r = await api(ui, "/api/projects/work/settings");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return ((r.json.team as Row).agents as Row[]).map((a) => String(a.name));
}

// --- after a merge from the pull request's page ------------------------------------------------------------------------

test("a merge with a clean checkout on main fast-forwards it, and Your team shows the new agent at once", async () => {
  const { p, ui, upstream } = await started();
  expect(await teamNames(ui)).not.toContain("haile");
  const r = await merge(ui);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.checkout).toMatchObject({ updated: true, branch: "main", behind: 0, problem: null });
  expect(String(r.json.output)).toContain("up to date with main");
  expect(head(p.d)).toBe(head(upstream));
  expect(git(p.d, "log", "-1", "--format=%s").trim()).toBe("Factory settings: haile joins the team (#52)");
  expect(agentsIn(p.d)).toEqual(["menelik", "taytu", "haile"]);
  expect(git(p.d, "symbolic-ref", "--short", "HEAD").trim()).toBe("main"); // still on main, not detached
  expect(await teamNames(ui)).toContain("haile");
  const ch = await api(ui, "/api/projects/work/channels");
  expect((ch.json.channels as Row[]).map((c) => c.id)).toContain("agent:haile"); // so it can be started from its page
}, T);

test("after the merge the new agent can be started: its loop's checkout (what Start runs) makes its worktree", async () => {
  const { p, ui } = await started();
  const take = () => {
    const loop = aLoop();
    const env = { ...baseEnv(), XDG_STATE_HOME: p.env.XDG_STATE_HOME, XDG_CONFIG_HOME: p.env.XDG_CONFIG_HOME, HOME: p.env.HOME };
    const r = runHook("factory_claims", ["checkout", "--pid", String(loop.pid), "--name", "haile"], { cwd: p.d, env });
    loop.kill();
    return r;
  };
  const early = take();
  expect(early.code).not.toBe(0); // not merged here yet: this machine doesn't know haile
  expect(early.out).toContain("isn't a coding agent");
  expect((await merge(ui)).status).toBe(200);
  const r = take();
  expect(r.code, r.out).toBe(0);
  const wt = join(p.root, "work-agents", "haile");
  expect(r.stdout.trim().split("\n").at(-1)).toBe(`haile ${realpathSync(p.root)}/work-agents/haile`);
  expect(agentsIn(wt)).toEqual(["menelik", "taytu", "haile"]); // cut from main as GitHub has it
}, T);

test("a checkout detached on an older main (the first agent's folder between tasks) moves forward too", async () => {
  const { p, ui, upstream } = await started((x) => git(x.d, "checkout", "-q", "--detach", "HEAD"));
  const r = await merge(ui);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.checkout).toMatchObject({ updated: true, branch: null });
  expect(head(p.d)).toBe(head(upstream));
}, T);

test("a dirty checkout is left as it is, and the answer says why and what to do", async () => {
  const { p, ui, before } = await started((x) => writeFileSync(join(x.d, "README.md"), "# work, half edited\n"));
  const r = await merge(ui);
  expect(r.status, JSON.stringify(r.json)).toBe(200); // the merge itself went through
  const co = r.json.checkout as Row;
  expect(co).toMatchObject({ updated: false, clean: false, changed: ["README.md"] });
  expect(co.problem).toMatchObject({ code: "checkout_dirty" });
  expect(String((co.problem as Row).fix)).toContain("Bring this machine up to date");
  expect(String(r.json.output)).toContain("uncommitted changes");
  expect(head(p.d)).toBe(before);
  expect(readFileSync(join(p.d, "README.md"), "utf8")).toBe("# work, half edited\n");
  expect(agentsIn(p.d)).toEqual(["menelik", "taytu"]);
}, T);

test("an untracked file counts as a change; an ignored one doesn't", async () => {
  const { ui } = await started((x) => {
    write(join(x.d, "node_modules", "x.js"), "ignored\n");
    write(join(x.d, "notes.txt"), "mine\n");
  });
  const r = await merge(ui);
  expect((r.json.checkout as Row).problem).toMatchObject({ code: "checkout_dirty" });
  expect((r.json.checkout as Row).changed).toEqual(["notes.txt"]);
}, T);

test("a checkout on another branch (a builder at work) is left as it is, and the answer says why", async () => {
  const { p, ui, before } = await started((x) => git(x.d, "switch", "-q", "-c", "task/9-login"));
  const r = await merge(ui);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const co = r.json.checkout as Row;
  expect(co).toMatchObject({ updated: false, branch: "task/9-login", onMain: false });
  expect(co.problem).toMatchObject({ code: "checkout_not_on_main" });
  expect(String((co.problem as Row).message)).toContain("task/9-login");
  expect(head(p.d)).toBe(before);
  expect(git(p.d, "symbolic-ref", "--short", "HEAD").trim()).toBe("task/9-login");
}, T);

test("a checkout with commits of its own can't fast-forward and is left as it is", async () => {
  const { p, ui } = await started((x) => {
    write(join(x.d, "local.txt"), "local\n");
    git(x.d, "add", "local.txt");
    git(x.d, "commit", "-qm", "a local commit");
  });
  const mine = head(p.d);
  const r = await merge(ui);
  expect((r.json.checkout as Row).problem).toMatchObject({ code: "checkout_diverged" });
  expect(head(p.d)).toBe(mine);
}, T);

// --- Factory settings: Bring this machine up to date -------------------------------------------------------------------

const CHECKOUT = "/api/projects/work/settings/checkout";

test("settings: the checkout shows how far behind main it is, and Bring this machine up to date moves it", async () => {
  const { p, ui, upstream } = await started(() => undefined, true);
  const s = await api(ui, CHECKOUT);
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  expect(s.json).toMatchObject({ project: "work", main: "main", branch: "main", behind: 1, ahead: 0, onMain: true, clean: true, canUpdate: true,
    problem: null, path: realpathSync(p.d) });
  const no = await api(ui, CHECKOUT, { method: "POST", body: {} });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("confirm_needed");
  expect(agentsIn(p.d)).toEqual(["menelik", "taytu"]);
  const r = await api(ui, CHECKOUT, { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toMatchObject({ ok: true, checkout: { updated: true } });
  expect(head(p.d)).toBe(head(upstream));
  expect(await teamNames(ui)).toContain("haile");
  const again = await api(ui, CHECKOUT, { method: "POST", body: { confirm: true } });
  expect(again.status).toBe(200);
  expect(again.json).toMatchObject({ ok: true, checkout: { updated: false, problem: null } });
  expect(String(again.json.output)).toContain("is up to date with main");
}, T);

test("an agent's own worktree is left alone: its loop brings it up to date itself", async () => {
  const { p } = await started(() => undefined, true);
  const wt = join(p.root, "work-agents", "taytu");
  git(p.d, "worktree", "add", "-q", "--detach", wt, "main");
  const before = head(wt);
  const ui = await startUi({ ...p, d: wt });
  running.push(ui);
  const list = await api(ui, "/api/projects");
  const id = String(((list.json.projects as Row[])[0] as Row).id);
  const r = await api(ui, `/api/projects/${id}/settings/checkout`, { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(409);
  expect(r.json.code).toBe("checkout_agent_worktree");
  expect(head(wt)).toBe(before);
}, T);

test("settings: a dirty checkout or one on another branch is refused, untouched, with its fix", async () => {
  const dirty = await started((x) => writeFileSync(join(x.d, "README.md"), "changed\n"), true);
  const a = await api(dirty.ui, CHECKOUT);
  expect(a.json).toMatchObject({ canUpdate: false, behind: 1, clean: false, problem: { code: "checkout_dirty" } });
  const r = await api(dirty.ui, CHECKOUT, { method: "POST", body: { confirm: true } });
  expect(r.status).toBe(409);
  expect(r.json).toMatchObject({ code: "checkout_dirty", checkout: { updated: false } });
  expect(String(r.json.fix)).not.toBe("");
  expect(head(dirty.p.d)).toBe(dirty.before);

  const other = await started((x) => git(x.d, "switch", "-q", "-c", "task/9-login"), true);
  const b = await api(other.ui, CHECKOUT, { method: "POST", body: { confirm: true } });
  expect(b.status).toBe(409);
  expect(b.json.code).toBe("checkout_not_on_main");
  expect(head(other.p.d)).toBe(other.before);
}, T);
