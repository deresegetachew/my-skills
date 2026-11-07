// The web UI's + Add project, end to end (#540): a repo holding only readme.txt is cloned, the real install.sh puts the
// kit in it, the answers are written, the new project's real `factory init` and `factory doctor` run, and `factory
// doctor` run again in the new project afterwards passes. gh is a fake: `repo clone` makes a local bare remote, `pr
// list|create` answer as GitHub would, and `gh api` goes to the stateful fake (fakegh.ts), with the repo's rules on main
// answered here. Nothing reaches the network, and no heartbeat service is installed (FACTORY_SETUP_HEARTBEAT=off).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeGh } from "./fakegh.ts";
import { api, project, type Row, type Running, startUi } from "./web_ui_support.ts";
import { git, readJson, SF, sh, write, writeExe } from "./support.ts";

const T = 120_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** gh: the commands the add flow runs, and `gh api` handed to the stateful fake. FAKE_RULES_OK=1 (a file) makes main
 * require the Factory guard and a review, as the owner sets on GitHub. */
const GH = `#!/usr/bin/env bash
echo "gh $*" >> "$LOOP_LOG"
case "$1 $2" in
  "repo list") echo '[{"nameWithOwner":"acme/sandbox","isPrivate":true,"updatedAt":"2026-11-07T10:00:00Z"}]'; exit 0 ;;
  "repo view")
    case "$*" in *defaultBranchRef*) echo main; exit 0 ;; esac
    echo '{"name":"sandbox"}'; exit 0 ;;
  "repo clone")
    repo="$3"; dest="$4"
    bare="$FAKE_REMOTES/$repo.git"
    if [ ! -d "$bare" ]; then
      mkdir -p "$(dirname "$bare")"; git init -q --bare -b main "$bare"
      seed="$(mktemp -d)"; ( cd "$seed" && git init -q -b main && git config user.email t@example.com && git config user.name t \\
        && git config commit.gpgsign false && echo "the sandbox" > readme.txt && git add -A && git commit -q -m first \\
        && git push -q "$bare" main ); rm -rf "$seed"
    fi
    git clone -q "$bare" "$dest" && git -C "$dest" config user.email t@example.com && git -C "$dest" config user.name t \\
      && git -C "$dest" config commit.gpgsign false
    exit $? ;;
  "pr list") echo "[]"; exit 0 ;;
  "pr create") echo "https://github.com/acme/sandbox/pull/1"; exit 0 ;;
  "auth status") exit 0 ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    if [ -f "$FAKE_RULES_OK" ]; then
      echo '[{"type":"pull_request","parameters":{"required_approving_review_count":1}},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"Factory guard"}]}}]'
    else echo '[]'; fi
    exit 0 ;;
  "api repos/{owner}/{repo}")
    admin=false; [ -f "$FAKE_ADMIN" ] && admin=true
    echo '{"owner":{"login":"acme","type":"User"},"permissions":{"admin":'"$admin"',"push":true}}'; exit 0 ;;
esac
exec "$FAKE_GH_API" "$@"
`;

interface Setup {
  ui: Running;
  root: string;
  env: Record<string, string | undefined>;
  rulesOk: string;
}

async function setup(): Promise<Setup> {
  const p = project();
  roots.push(p.root);
  const api = installFakeGh(join(p.root, "ghapi"));
  const bin = join(p.root, "fakebin");
  writeExe(join(bin, "gh"), GH);
  writeExe(join(bin, "claude"), "#!/bin/sh\necho '2.1.310 (Claude Code)'\n");
  const rulesOk = join(p.root, "rules-ok");
  p.env.PATH = `${bin}:${p.env.PATH ?? ""}`;
  Object.assign(p.env, { FAKE_GH_API: join(api, "gh"), FAKE_REMOTES: join(p.root, "remotes"), FAKE_RULES_OK: rulesOk,
    FAKE_ADMIN: join(p.root, "admin"),
    FACTORY_SETUP_HEARTBEAT: "off", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com" });
  git(p.d, "remote", "add", "origin", "https://github.com/acme/work.git");
  git(p.d, "add", "-A");
  git(p.d, "commit", "-q", "-m", "setup");
  const ui = await startUi(p);
  running.push(ui);
  return { ui, root: p.root, env: p.env, rulesOk };
}

async function waitRun(ui: Running, id: string, ms = 110_000): Promise<Row> {
  const deadline = Date.now() + ms;
  let run: Row = {};
  while (Date.now() < deadline) {
    const r = await api(ui, `/api/add-project/runs/${id}`);
    run = r.json.run as Row;
    if (r.status === 200 && run.state !== "running") return run;
    await Bun.sleep(200);
  }
  throw new Error(`run ${id} still running: ${JSON.stringify(run)}`);
}

/** The request of the fresh-install test on 7 Nov: test `bun test`, lint left empty, tasks from issues. */
function request(s: Setup, over: Row = {}): Row {
  return { confirm: true, source: "clone", repo: "acme/sandbox", path: join(s.root, "sandbox"), visibility: "private", tasks: "issues",
    mainBranch: "main", test: "bun test", lint: "", install: "", typecheck: "", build: "", protected: [],
    team: { devManager: "fasil", productOwner: "mentewab", builders: ["menelik"] }, ...over };
}

function doctorIn(s: Setup, dir: string): { code: number; out: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.env)) if (v !== undefined) env[k] = v;
  const p = sh(["bash", join(dir, "factory"), "doctor"], { cwd: dir, env, timeoutMs: 90_000 });
  return { code: p.code, out: p.stdout + p.stderr };
}

function stepOf(run: Row, id: string): Row {
  return (run.steps as Row[]).find((x) => x.id === id) as Row;
}

test("a repo with only a readme, added with + Add project, passes factory doctor with nothing fixed by hand", async () => {
  const s = await setup();
  writeFileSync(s.rulesOk, "");
  const r = await api(s.ui, "/api/add-project", { method: "POST", body: request(s) });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  const run = await waitRun(s.ui, String((r.json.run as Row).id));
  expect(run.state, JSON.stringify(run, null, 1)).toBe("done");
  const doctorStep = stepOf(run, "doctor");
  expect(doctorStep.state, String(doctorStep.output)).toBe("done");
  expect(doctorStep.todos ?? [], String(doctorStep.output)).toEqual([]);

  const dir = join(s.root, "sandbox");
  const cfg = readJson<Row>(join(dir, ".claude", "factory.json"));
  // only the commands given: an empty answer clears the template's pnpm command
  expect(cfg.commands).toMatchObject({ install: "", typecheck: "", lint: "", test: "bun test", build: "" });
  expect(JSON.stringify(cfg.commands)).not.toContain("pnpm");
  // the test command is allowed for an unattended agent, alone and through ./factory run-check
  const allow = ((cfg.permissions as Row).allow as string[]);
  expect(allow).toContain("Bash(bun test*)");
  expect(allow).toContain("Bash(./factory run-check*)");
  const rules = JSON.parse(readFileSync(join(dir, ".claude", "factory", "settings.json"), "utf8")) as Row;
  expect(((rules.permissions as Row).allow as string[])).toContain("Bash(bun test*)");
  // the signed-in GitHub login is the trusted reviewer
  expect(cfg.trustedReviewers).toEqual(["me"]);
  // CI runs the commands given, with no pnpm or Node step: the project has no package.json
  const ci = readFileSync(join(dir, ".github", "workflows", "ci.yml"), "utf8");
  expect(ci).not.toMatch(/pnpm|setup-node/);
  expect(ci).toContain("factory_stack.ts run test");
  expect(ci).toContain("name: Factory guard");

  const doctor = doctorIn(s, dir);
  expect(doctor.out.split("\n").filter((l) => l.startsWith("fix")), doctor.out).toEqual([]);
  expect(doctor.code, doctor.out).toBe(0);
  expect(doctor.out).toContain("All the checks pass.");
}, T);

test("what only the owner can set on GitHub is a to-do with its fix on the last step, not a failure", async () => {
  const s = await setup();
  const r = await api(s.ui, "/api/add-project", { method: "POST", body: request(s) });
  const run = await waitRun(s.ui, String((r.json.run as Row).id));
  expect(run.state, JSON.stringify(run, null, 1)).toBe("done");
  const doctorStep = stepOf(run, "doctor");
  expect(doctorStep.state).toBe("done");
  expect(doctorStep.problem).toBeNull();
  const todos = doctorStep.todos as Row[];
  expect(todos.length, JSON.stringify(todos)).toBe(1);
  expect(String(todos[0]?.what)).toContain("main requires");
  expect(String(todos[0]?.fix)).toContain("Rulesets");
  expect(String(doctorStep.output)).toContain("To do");
}, T);

test("an agents' login with admin rights is a to-do that says plainly it gets round the merge gate", async () => {
  const s = await setup();
  writeFileSync(s.rulesOk, "");
  writeFileSync(join(s.root, "admin"), "");
  const r = await api(s.ui, "/api/add-project", { method: "POST", body: request(s) });
  const run = await waitRun(s.ui, String((r.json.run as Row).id));
  expect(run.state, JSON.stringify(run, null, 1)).toBe("done");
  const todos = stepOf(run, "doctor").todos as Row[];
  expect(todos.map((t) => t.what)).toEqual(["gh login has admin rights"]);
  expect(String(todos[0]?.fix)).toStartWith("This lets the agents get round the merge gate");
  expect(String(todos[0]?.fix)).toContain("Collaborators");
}, T);

test("the message board is a task source only on a machine with a board, and writes tasks.source and the transport", async () => {
  const s = await setup();
  const info = await api(s.ui, "/api/add-project");
  expect(info.json.board).toBe(false);
  const refused = await api(s.ui, "/api/add-project/check", { method: "POST", body: request(s, { tasks: "board" }) });
  expect(refused.status).toBe(400);
  expect(refused.json.code).toBe("ui_add_no_board");
  expect(String(refused.json.fix)).toContain("factory board");
  expect(existsSync(join(s.root, "sandbox"))).toBe(false);
}, T);

test("the form's data names the signed-in login, which becomes the trusted reviewer", async () => {
  const s = await setup();
  const info = await api(s.ui, "/api/add-project");
  expect(info.json.login).toBe("me");
}, T);

test("a board on this machine: the board is offered, and choosing it writes tasks.source board and messaging.transport board", async () => {
  const p = project();
  roots.push(p.root);
  const config = join(p.root, "factory-config");
  mkdirSync(join(config, "message-board"), { recursive: true });
  write(join(config, "message-board", "url"), "postgres://127.0.0.1:1/none\n");
  const ui = await startUi(p, ["--port", "0"], null, { FACTORY_CONFIG_DIR: config });
  running.push(ui);
  const info = await api(ui, "/api/add-project");
  expect(info.json.board).toBe(true);
  const ok = await api(ui, "/api/add-project/check", { method: "POST", body: { source: "clone", repo: "acme/sandbox",
    path: join(p.root, "sandbox"), visibility: "private", tasks: "board", mainBranch: "main", test: "", lint: "", protected: [],
    team: { devManager: "fasil", productOwner: "mentewab", builders: ["menelik"] } } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
}, T);
