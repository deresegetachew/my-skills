// `factory doctor` checks the machine and the project, one line each, and says how to fix what's missing (#63).
// Runs with a PATH of stub tools, so it doesn't depend on what this machine has installed.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { doctor, hookLine, lines, machine, project } from "./doctor_support.ts";
import { HOOKS, readmeAndWiki, runBun, SF, tmp, write } from "./support.ts";

test("a good machine is all ok", () => {
  const d = project({ "package.json": '{"packageManager": "pnpm@9.0.0"}', ".nvmrc": "22\n" });
  const p = doctor(d, { ...machine({ extra: ["pnpm", "factory"] }), FACTORY_AGENTS: "taytu" });
  expect(p.code, p.out).toBe(0);
  expect(lines(p, "fix"), p.stdout).toEqual([]);
  for (const what of ["git", "bun", "Claude Code", "gh is signed in", "Node v22", "pnpm", ".claude/factory/settings.json", "taytu"]) {
    expect(lines(p, "ok").some((l) => l.includes(what)), `${what}\n${p.stdout}`).toBe(true);
  }
  expect(p.stdout).toContain("All the checks pass.");
  expect(p.stdout.toLowerCase(), "the factory needs Bun, not Python").not.toContain("python");
});

test("a workflow that calls a removed python hook or runs bun without setting it up is a fix", () => {
  // #254: after the update to Bun a Python project's ci.yml still called python3 .claude/hooks/*.py
  const ci = ["name: CI", "on: [pull_request]", "jobs:",
    "  guard:", "    runs-on: ubuntu-latest", "    steps:",
    "      - run: python3 .claude/hooks/factory_guard.py --base main",
    "  check:", "    runs-on: ubuntu-latest", "    steps:",
    "      - run: bun --no-env-file .claude/hooks/style_checks.ts",
    "      - run: bun --no-env-file .claude/hooks/no_such_hook.ts", ""].join("\n");
  const d = project({ ".github/workflows/ci.yml": ci });
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(p.code, p.stdout).toBe(1);
  const fixes = lines(p, "fix").join("\n");
  expect(fixes).toContain(".github/workflows/ci.yml: .claude/hooks/factory_guard.py");
  expect(fixes).toContain("run `factory update` (it rewrites the step to `bun --no-env-file --config=/dev/null .claude/hooks/factory_guard.ts`)");
  expect(fixes).toContain(".github/workflows/ci.yml: .claude/hooks/no_such_hook.ts");
  expect(fixes).toContain(".github/workflows/ci.yml: job check: it runs Bun but has no `- uses: oven-sh/setup-bun@v2` step");
  expect(fixes, "style_checks.ts is there").not.toContain("style_checks.ts");
});

test("the kits own workflows pass the workflow check", () => {
  const d = project({
    ".github/workflows/ci.yml": readFileSync(join(SF, "kit/.github/workflows/ci.yml"), "utf8"),
    ".github/workflows/ci-python.yml": readFileSync(join(SF, "kit/.github/workflows/ci-python.yml.template"), "utf8"),
  });
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "fix").filter((l) => l.includes(".github/workflows")), p.stdout).toEqual([]);
  expect(lines(p, "ok").some((l) => l.includes("CI workflows")), p.stdout).toBe(true);
});

test("gh auth status failing is no fix when the api works", () => {
  // GH_TOKEN set: `gh auth status` complains, every `gh api` call works (#157)
  const d = project();
  const gh = "[ \"$1 $2\" = 'auth status' ] && { echo 'token scopes missing' >&2; exit 1; }; echo '{}'; exit 0";
  const p = doctor(d, { ...machine({ gh }), FACTORY_AGENTS: "taytu" });
  expect(p.code, p.stdout).toBe(0);
  expect(lines(p, "fix"), p.stdout).toEqual([]);
  expect(lines(p, "ok").some((l) => l.includes("gh")), p.stdout).toBe(true);
  expect(p.stdout).toContain("All the checks pass.");
});

test("a failing gh api names the reason", () => {
  for (const [err, reason] of [["gh: To use GitHub CLI, set GH_TOKEN or run gh auth login", "no token"],
    ["gh: Bad credentials (HTTP 401)", "token was refused"],
    ["dial tcp: lookup api.github.com: no such host", "can't reach github.com"]] as const) {
    const d = project();
    const p = doctor(d, { ...machine({ gh: `echo '${err}' >&2; exit 1` }), FACTORY_AGENTS: "taytu" });
    expect(p.code, p.stdout).toBe(1);
    expect(lines(p, "fix").some((l) => l.includes("GitHub CLI") && l.includes(reason)), `${reason}\n${p.stdout}`).toBe(true);
  }
});

test("each problem gets a one line fix", () => {
  const d = project({ "package.json": '{"packageManager": "pnpm@9.0.0"}', ".nvmrc": "22\n", ".sops.yaml": "creation_rules: []\n" });
  unlinkSync(join(d, ".claude", "factory", "settings.json"));
  const p = doctor(d, { ...machine({ ghSignedIn: false, node: "v18.19.0" }), FACTORY_AGENTS: "ada" });
  expect(p.code, p.out).toBe(1);
  const fixes = lines(p, "fix").join("\n");
  for (const [what, how] of [["GitHub CLI", "gh auth login"], ["Node", "nvm install"], ["pnpm", "corepack enable"],
    ["sops", "install sops"], [".claude/factory/settings.json", "git submodule update --init"], ["FACTORY_AGENTS", "ada"]] as const) {
    expect(lines(p, "fix").some((l) => l.includes(what) && l.includes(how)), `${what}\n${fixes}`).toBe(true);
  }
  expect(p.stdout).toContain(`${lines(p, "fix").length} to fix.`);
});

test("a machine without bun is told how to install it", () => {
  // bun missing: the `factory` command itself says so ({code, message, fix}), and the doctor started by path says it too
  const d = project();
  const env = { ...machine({ noBun: true }), FACTORY_AGENTS: "taytu" };
  const p = doctor(d, env);
  expect(p.code, p.out).not.toBe(0);
  const err = JSON.parse(p.stderr.trim().split("\n").pop() as string) as Record<string, string>;
  expect(err.code).toBe("bun_missing");
  expect(err.fix).toContain("curl -fsSL https://bun.sh/install | bash");
  const q = runBun(join(HOOKS, "factory_doctor.ts"), [], { cwd: d, env });
  expect(q.code, q.out).toBe(1);
  const fix = lines(q, "fix").filter((l) => l.includes("bun_missing"));
  expect(fix.length === 1 && fix[0]!.includes("curl -fsSL https://bun.sh/install | bash") && fix[0]!.includes("Fix:"), q.stdout).toBe(true);
});

test("the hook lines in settings.json must run the Bun hooks", () => {
  const d = project();
  const settings = (commands: string[]) => write(join(d, ".claude", "factory", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: commands.map((command) => ({ type: "command", command })) }] },
  }));
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  settings([hookLine("pr-gate"), hookLine("factory_session")]);
  let p = doctor(d, env);
  expect(lines(p, "ok").some((l) => l.includes("hooks in .claude/factory/settings.json run with Bun")), p.stdout).toBe(true);
  expect(lines(p, "fix").filter((l) => l.includes("hook")), p.stdout).toEqual([]);
  settings(["python3 \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/pr-gate.py"]);
  p = doctor(d, env);
  expect(p.code).toBe(1);
  expect(lines(p, "fix").some((l) => l.includes(".claude/hooks/pr-gate.py") && l.includes("factory update") && l.includes("Bun")), p.stdout).toBe(true);
  settings([hookLine("no_such_hook")]);
  p = doctor(d, env);
  expect(lines(p, "fix").some((l) => l.includes(".claude/hooks/no_such_hook.ts") && l.includes("missing")), p.stdout).toBe(true);
  settings(["bun \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/pr-gate.ts"]);
  p = doctor(d, env);
  expect(lines(p, "fix").some((l) => l.includes("--no-env-file") && l.includes("factory update")), p.stdout).toBe(true);
});

/** Give the project a release pin for one installed file (a project on releases, #113). */
function pinned(d: string, content = "export const one = 1;\n", changed = false): void {
  const rel = ".claude/hooks/factory_demo.ts";
  write(join(d, rel), content + (changed ? "// edited\n" : ""));
  const pin = { schema: "factory-pin/1", repo: "acme/factory", tag: "v1.2.0", version: "1.2.0", sha256: "0".repeat(64), previous: null,
    executable: [], files: { [rel]: createHash("sha256").update(content).digest("hex") } };
  write(join(d, ".claude", "factory", "release.json"), JSON.stringify(pin));
}

test("a project on releases is ok when its files match the pin", () => {
  const d = project();
  pinned(d);
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "ok").some((l) => l.includes("factory v1.2.0") && l.includes("match the pin")), p.stdout).toBe(true);
  expect(lines(p, "fix"), p.stdout).toEqual([]);
});

test("a project on releases gets a fix when a file differs from the pin", () => {
  const d = project();
  pinned(d, undefined, true);
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(p.code, p.stdout).toBe(1);
  expect(lines(p, "fix").some((l) => l.includes("factory_demo.ts differs from v1.2.0") && l.includes("factory update")), p.stdout).toBe(true);
});

test("doctor says to update when factory json allows a rule settings json lacks and is quiet once it has it", () => {
  const d = project({}, { agents: ["taytu"], permissions: { allow: ["Edit(tmp/**)"] } });
  pinned(d);
  let p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "fix").some((l) => l.includes("Edit(tmp/**)") && l.includes("factory update")), p.stdout).toBe(true);
  write(join(d, ".claude", "factory", "settings.json"), JSON.stringify({ permissions: { allow: ["Edit(tmp/**)"] } }));
  p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "fix").filter((l) => l.includes("Edit(tmp")), p.stdout).toEqual([]);
});

test("checks that dont apply are left out", () => {
  const d = project(); // no package.json, no compose file, no .sops.yaml
  const p = doctor(d, machine({ node: null }));
  expect(p.code, p.out).toBe(0);
  for (const w of ["Node", "Docker", "sops"]) expect(p.stdout).not.toContain(w);
});

test("it never prints a secret", () => {
  const d = project({ ".sops.yaml": "creation_rules: []\n" });
  const key = write(join(tmp(), "age.txt"), "AGE-SECRET-KEY-1SHOULDNEVERSHOW\n");
  const p = doctor(d, { ...machine({ extra: ["sops"] }), SOPS_AGE_KEY_FILE: key });
  expect(lines(p, "ok").some((l) => l.includes("sops and its age key")), p.stdout).toBe(true);
  expect(p.stdout + p.stderr).not.toContain("AGE-SECRET-KEY");
});

/** A gh stub that answers `gh repo view` with GitHub's default branch and succeeds on everything else. */
function defaultBranchGh(name: string): string {
  return `case "$1" in repo) echo ${name};; esac; exit 0`;
}

test("a main branch that differs from githubs default is a fix", () => {
  const d = project({}, { agents: ["taytu"], mainBranch: "alpha-test" });
  const p = doctor(d, { ...machine({ gh: defaultBranchGh("main") }), FACTORY_AGENTS: "taytu" });
  expect(p.code, p.stdout).toBe(1);
  expect(lines(p, "fix").some((l) => l.includes("main-branch-differs") && l.includes("alpha-test") && l.includes("main") &&
    l.includes("default branch") && l.includes("factory settings set mainBranch main")), p.stdout).toBe(true);
});

test("a main branch that matches githubs default is ok", () => {
  const d = project({}, { agents: ["taytu"], mainBranch: "alpha-test" });
  const p = doctor(d, { ...machine({ gh: defaultBranchGh("alpha-test") }), FACTORY_AGENTS: "taytu" });
  expect(p.code, p.stdout).toBe(0);
  expect(lines(p, "ok").some((l) => l.includes("mainBranch") && l.includes("alpha-test")), p.stdout).toBe(true);
});

test("an unset main branch is judged as main", () => {
  const d = project({}, { agents: ["taytu"] });
  const p = doctor(d, { ...machine({ gh: defaultBranchGh("trunk") }), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "fix").some((l) => l.includes("main-branch-differs")), p.stdout).toBe(true);
});

test("a default branch gh cannot tell is no fix", () => {
  const d = project({}, { agents: ["taytu"], mainBranch: "alpha-test" });
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" }); // gh prints nothing
  expect(lines(p, "fix").some((l) => l.includes("main-branch")), p.stdout).toBe(false);
});

const NOINIT = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n";

test("a test command that runs no tests is a fix", () => {
  const d = project({ "tests/test_a.py": NOINIT }, { agents: ["taytu"], commands: { test: "python3 -m unittest discover" } });
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  const fixes = lines(p, "fix").filter((l) => l.includes("no-tests-ran"));
  expect(p.code === 1 && fixes.length > 0, p.stdout).toBe(true);
  expect(fixes[0]!.includes("NO TESTS RAN") && fixes[0]!.includes("commands.test") && fixes[0]!.includes("Fix:"), fixes.join("\n")).toBe(true);
});

test("a test command that runs a test is ok", () => {
  const d = project({ "tests/test_a.py": NOINIT }, { agents: ["taytu"], commands: { test: "python3 -m unittest discover -s tests" } });
  const p = doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(lines(p, "fix").some((l) => l.includes("no-tests-ran")), p.stdout).toBe(false);
  expect(lines(p, "ok").some((l) => l.includes("commands.test")), p.stdout).toBe(true);
});

test("a test command that is not python is not run", () => {
  const d = project({}, { agents: ["taytu"], commands: { test: "touch ran.txt" } });
  doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
  expect(existsSync(join(d, "ran.txt"))).toBe(false);
});

// #249: an unattended agent must be able to run commands.test, alone and through `./factory run-check`.
function factorySettings(d: string, allow: string[]): void {
  write(join(d, ".claude", "factory", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookLine("pr-gate") }] }] },
    permissions: { allow: ["Bash(git fetch*)", "Bash(git add*)", "Bash(git commit*)", "Bash(git push*)", "Bash(gh pr *)", ...allow] },
  }));
}

test("a test command an unattended agent would be asked about is a fix that names the rules", () => {
  const cmd = "python3 -m unittest discover -s tests";
  const d = project({ "tests/test_a.py": NOINIT }, { agents: ["taytu"], commands: { test: cmd } });
  factorySettings(d, []);
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  let p = doctor(d, env);
  const fixes = lines(p, "fix").filter((l) => l.includes("test-command-prompts"));
  expect(p.code === 1 && fixes.length === 1, p.stdout).toBe(true);
  for (const want of [`\`${cmd}\``, `\`./factory run-check ${cmd}\``,
    `factory settings set permissions.allow '["Bash(python3 -m unittest*)","Bash(./factory run-check*)"]'`, "factory update"]) {
    expect(fixes[0]!, want).toContain(want);
  }
  // allowed alone but not through run-check: still a fix, naming only run-check
  factorySettings(d, ["Bash(python3 -m unittest*)"]);
  p = doctor(d, env);
  const only = lines(p, "fix").filter((l) => l.includes("test-command-prompts"));
  expect(only.length === 1 && only[0]!.includes("./factory run-check") && !only[0]!.includes(`run \`${cmd}\` or`), p.stdout).toBe(true);
  // the rules in factory.json count too, and then all is well
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu"], commands: { test: cmd },
    permissions: { allow: ["Bash(python3 -m unittest*)", "Bash(./factory run-check*)"] } }));
  p = doctor(d, env);
  expect(lines(p, "fix").filter((l) => l.includes("test-command-prompts")), p.stdout).toEqual([]);
  expect(lines(p, "ok").some((l) => l.includes("unattended agent can run commands.test")), p.stdout).toBe(true);
});

test("the readme says doctor runs a python test command once and checks it is allowed", () => {
  const text = readmeAndWiki().replace(/\s+/g, " ");
  expect(text).toContain("`factory doctor` runs a Python `commands.test` once and fails with `no-tests-ran` when it ran 0 tests (#244)");
  expect(text).toContain("a git worktree of a trusted main working tree counts as trusted, and the line says so");
  expect(text).toContain("whether an unattended agent can run `commands.test` alone and through `./factory run-check` (#249");
});

test("doctor in issues mode with no trusted reviewers is a fix", () => {
  // #260: with the list empty, anyone's must-fix sends the loops to rework and anyone's approval counts
  const check = (cfg: Record<string, unknown>): string[] => {
    const p = doctor(project({}, { agents: ["taytu"], ...cfg }), { ...machine(), FACTORY_AGENTS: "taytu" });
    return lines(p, "fix").filter((l) => l.includes("trustedReviewers"));
  };
  const fixes = check({ tasks: { source: "issues" } });
  expect(fixes.length, fixes.join("\n")).toBe(1);
  expect(fixes[0]).toContain("factory settings set trustedReviewers '[\"<your-login>\"]'");
  expect(check({ tasks: { source: "issues" }, trustedReviewers: ["boss"] })).toEqual([]);
  expect(check({}), "plan mode is unchanged").toEqual([]);
});

test("doctor outside a git repo says where to run it", () => {
  const d = tmp();
  const env = { ...machine(), GIT_CEILING_DIRECTORIES: d };
  const p = runBun(join(HOOKS, "factory_doctor.ts"), [], { cwd: d, env });
  expect(p.code).toBe(1);
  expect(p.stderr).toContain("factory doctor: run it inside the project's git repo.");
  rmSync(d, { recursive: true, force: true });
});
