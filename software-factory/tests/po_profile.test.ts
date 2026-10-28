// The product owner's settings profile. The factory starts a product owner's sessions on `roles.product-owner.profile`
// (default `.claude/product-owner/settings.json`) with `--setting-sources user`, so without that file an unattended pass
// had no allow rule at all and every command its skill names was refused. The kit ships the file, an update and a link
// install put it in place as the factory's own, `factory doctor` replays the product-pass skill's commands against it,
// and the PR gate it wires in lets the product owner write the owner-queue asks its skill tells it to.
import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allowedBy, type Permissions } from "./manager_support.ts";
import { doctor, lines, machine, project as doctorProject } from "./doctor_support.ts";
import { runGate, type Env as GateEnv } from "./pr_gate_support.ts";
import { commit, fac, pin, world } from "./release_support.ts";
import { claudeCalls, factory, project } from "./roles_support.ts";
import { git, HOOKS, KIT, SF, sh, tmp, write, writeExe } from "./support.ts";

const REL = ".claude/product-owner/settings.json";
const PROFILE = join(KIT, REL);
const SKILL = join(KIT, ".claude", "skills", "product-pass", "SKILL.md");

interface Hook { command: string }
interface Profile { permissions: Permissions; hooks: Record<string, { matcher?: string; hooks: Hook[] }[]> }

const load = (): Profile => JSON.parse(readFileSync(PROFILE, "utf8")) as Profile;

/** The commands the product-pass skill names in backticks, as `factory doctor` reads them: not on a line that says
 * "never", not the role loops (the loop starts them), and not a pipeline or a substitution. */
function skillCommands(): string[] {
  const found: string[] = [];
  for (const line of readFileSync(SKILL, "utf8").split("\n")) {
    if (/\bnever\b/i.test(line)) continue;
    for (const m of line.matchAll(/`((?:gh|git|factory|\.\/factory) [^`]+)`/g)) {
      const cmd = m[1] as string;
      if (/^(\.\/)?factory (loop|dev-manager|product-owner|coding-agent)\b/.test(cmd) || /[;|&]|\$\(/.test(cmd)) continue;
      if (!found.includes(cmd)) found.push(cmd);
    }
  }
  return found;
}

// --- the profile ------------------------------------------------------------------------------------------------------

test("the kit ships the product owner profile at the default path", () => {
  const p = load();
  expect(Array.isArray(p.permissions.allow) && Array.isArray(p.permissions.deny)).toBe(true);
});

test("every command the product pass skill names is allowed without a prompt", () => {
  const cmds = skillCommands();
  expect(cmds.length, "the skill names its commands").toBeGreaterThan(5);
  const perms = load().permissions;
  for (const named of cmds) {
    const cmd = named.replace(/<[^>]*>/g, "x"); // a placeholder (`<id>`) is a value, not a redirection
    // `gh api` in prose stands for `gh api <path>`
    expect(allowedBy(perms, cmd) || allowedBy(perms, cmd + " x"), named).toBe(true);
  }
});

test("the profile allows what the product owner does in a pass", () => {
  const perms = load().permissions;
  for (const cmd of [
    "bun --no-env-file --config=/dev/null .claude/hooks/factory_roles.ts work product-owner",
    "gh api repos/acme/app/issues/293/comments", "gh issue list --label factory:needs-product", "gh issue view 7",
    "gh pr list", "gh pr view 7", "gh pr diff 7", "gh issue comment 7 --body-file tmp/a.md", "gh pr comment 7 --body x",
    "gh issue create --title x --body-file tmp/a.md", "gh issue edit 7 --body-file tmp/a.md",
    "gh pr create --draft --body-file tmp/prd.md", "git checkout -b po/prd-us-4", "git add docs/PRD.md",
    "git commit -m prd", "git push -u origin po/prd-us-4", "git fetch origin", "git status", "git diff",
    "factory prd", "factory prd --stage", "factory messages ls --to po", "factory issues list", "factory issues show 7",
    "factory issues new --title x --body-file tmp/a.md", "factory signoff ls", "factory artifacts status",
    "factory artifacts list", "factory artifacts pull https://claude.ai/artifact/x design/x.html", "factory usage --by task",
    "factory report", "./factory prd", "./factory messages ls --to po",
  ]) expect(allowedBy(perms, cmd), cmd).toBe(true);
});

test("the profile denies what the product owner never does", () => {
  const perms = load().permissions;
  for (const cmd of ["gh pr merge 7 --merge", "gh pr merge 7 --admin", "gh pr review 7 --approve", "git push origin main",
    "git push -f origin po/x", "git push origin --delete po/x", "factory settings set prd x", "factory update",
    "factory manager-claims claim 7", "gh alias set m 'pr merge'"]) {
    expect(allowedBy(perms, cmd), cmd).toBe(false);
  }
  for (const rule of ["Edit(./.claude/**)", "Edit(./CLAUDE.md)", "Edit(./.mcp.json)", "Edit(./.github/**)",
    "Edit(//**/factory-reviews/**)", "Read(./.env)", "Read(./secrets/**)", "Artifact", "DesignSync"]) {
    expect(perms.deny, rule).toContain(rule);
  }
  // the PRD is the product owner's to change, through a pull request a person merges
  expect(perms.deny).not.toContain("Edit(./docs/PRD.md)");
  expect([...perms.allow, ...perms.deny].filter((r) => r.startsWith("Write(")), "Edit(path) covers writes").toEqual([]);
});

test("the profile keeps every protecting deny of the agents rules except the gh api and prd ones", () => {
  const shared = (JSON.parse(readFileSync(join(KIT, ".claude", "factory", "settings.json"), "utf8")) as Profile).permissions;
  const mine = new Set(load().permissions.deny);
  // gh api is how the product owner reads GitHub; the PRD is its to change, in a pull request a person merges
  expect(shared.deny.filter((d) => !["Bash(gh api *)", "Edit(./docs/PRD.md)"].includes(d) && !mine.has(d))).toEqual([]);
});

test("the profile wires the pr gate on bash and the agents heartbeat, and every hook it runs exists", () => {
  const hooks = load().hooks;
  const pre = (hooks.PreToolUse ?? []).filter((h) => h.matcher === "Bash").flatMap((h) => h.hooks.map((x) => x.command));
  expect(pre.some((c) => c.includes("/.claude/hooks/pr-gate.ts") && c.endsWith("|| exit 2")), pre.join("\n")).toBe(true);
  expect(JSON.stringify(hooks.PostToolUse)).toContain("factory_agents.ts hook");
  for (const event of Object.values(hooks)) {
    for (const h of event) {
      for (const x of h.hooks) {
        const name = /\/hooks\/([\w.-]+\.ts)/.exec(x.command)?.[1] as string;
        expect(name && statSync(join(HOOKS, name)).isFile(), x.command).toBe(true);
      }
    }
  }
});

// --- the product owner's sessions -------------------------------------------------------------------------------------

function settingsOf(argv: string[]): Profile {
  const i = argv.indexOf("--settings");
  expect(i, argv.join(" ")).toBeGreaterThanOrEqual(0);
  return JSON.parse(argv[i + 1] as string) as Profile;
}

test("a product owner pass started with the default settings runs on the shipped profile", () => {
  const work = { issues: [{ number: 7, title: "Pick the palette", labels: [{ name: "factory:needs-product" }] }] };
  const [, w, env] = project({ db: work, files: { [REL]: readFileSync(PROFILE, "utf8") } });
  const p = factory(w, env, ["product-owner", "eleni", "loop", "--once"]);
  expect(p.code, p.out).toBe(0);
  const calls = claudeCalls(env);
  expect(calls.length, p.out).toBe(1);
  const line = calls[0] as string;
  expect(line, "the session reads only the user's settings and the profile").toContain("--setting-sources user --settings {");
  expect(line, "the product owner's own rules").toContain('"Bash(gh pr create*)"');
  // the same flags, one per line, as the loop reads them
  const f = sh([process.execPath, "--no-env-file", "--config=/dev/null", join(".claude", "hooks", "factory_roles.ts"),
    "claude-flags", "product-owner"], { cwd: w, env });
  expect(f.code, f.out).toBe(0);
  const s = settingsOf(f.stdout.split("\n").filter(Boolean));
  expect(s.permissions.allow).toContain("Bash(gh api *)");
  expect(allowedBy(s.permissions, "bun --no-env-file --config=/dev/null .claude/hooks/factory_roles.ts work product-owner")).toBe(true);
  for (const t of ["Artifact", "DesignSync"]) expect(s.permissions.deny, "off by default (#104)").toContain(t);
});

test("with roles.product-owner.artifacts on main the shipped profile's artifact deny is dropped", () => {
  const [, w, env] = project({ files: { [REL]: readFileSync(PROFILE, "utf8") }, cfg: { roles: {
    "dev-manager": { names: ["lead"] }, "product-owner": { names: ["eleni"], busyMinutes: 0, idleMinutes: 0, artifacts: true } } } });
  const p = sh([process.execPath, "--no-env-file", "--config=/dev/null", join(".claude", "hooks", "factory_roles.ts"),
    "claude-flags", "product-owner"], { cwd: w, env });
  expect(p.code, p.out).toBe(0);
  const s = settingsOf(p.stdout.split("\n").filter(Boolean));
  for (const t of ["Artifact", "DesignSync"]) expect(s.permissions.deny).not.toContain(t);
  expect(s.permissions.deny).toContain("Bash(gh pr merge*)");
  expect(s.permissions.allow).toContain("Bash(gh api *)");
});

// --- install and update -----------------------------------------------------------------------------------------------

test("a link install links the profile into a project", () => {
  const d = tmp();
  mkdirSync(join(d, "vendor"));
  const c = sh(["cp", "-a", dirname(SF), join(d, "vendor", "my-skills")]);
  expect(c.code, c.out).toBe(0);
  git(d, "init", "-q");
  const p = sh(["bash", join(d, "vendor", "my-skills", "software-factory", "install.sh"), ".", "--link"], { cwd: d });
  expect(p.code, p.stderr).toBe(0);
  const path = join(d, REL);
  expect(lstatSync(path).isSymbolicLink() && statSync(path).isFile(), REL).toBe(true);
});

test("an update gives the profile to a project with its own factory json and the next release updates it", async () => {
  const [gh, d, env] = await world();
  gh.add("1.0.0", { files: { [`kit/${REL}`]: '{"profile": "1.0.0"}\n' }, date: "2026-10-01T10:00:00Z" });
  gh.add("1.1.0", { files: { [`kit/${REL}`]: '{"profile": "1.1.0"}\n' }, date: "2026-11-01T10:00:00Z" });
  const own = join(d, ".claude", "factory.json");
  mkdirSync(dirname(own), { recursive: true });
  writeFileSync(own, '{"mainBranch": "trunk"}\n'); // templates are not given to a project that has its own config
  commit(d);
  let [rc, out] = await fac(d, env, "update", "1.0.0");
  expect(rc, out).toBe(0);
  expect(readFileSync(join(d, REL), "utf8")).toBe('{"profile": "1.0.0"}\n');
  expect(Object.keys(pin(d).files)).toContain(REL);
  commit(d);
  [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(readFileSync(join(d, REL), "utf8")).toBe('{"profile": "1.1.0"}\n');
});

// --- factory doctor -----------------------------------------------------------------------------------------------------

function poDoctorProject(allow: string[] | null = null, withProfile = true): string {
  const d = doctorProject({}, { agents: ["taytu"] });
  const prof = load();
  if (allow !== null) prof.permissions.allow = allow;
  if (withProfile) write(join(d, REL), JSON.stringify(prof));
  write(join(d, ".claude", "skills", "product-pass", "SKILL.md"), readFileSync(SKILL, "utf8"));
  return d;
}

test("doctor says the product owner profile resolves and allows every command the skill names", () => {
  const p = doctor(poDoctorProject(), { ...machine(), FACTORY_AGENTS: "taytu" });
  const ok = lines(p, "ok").filter((l) => l.includes("product owner profile"));
  expect(ok.some((l) => l.includes("resolves")), p.stdout).toBe(true);
  expect(ok.some((l) => l.includes("product-pass")), p.stdout).toBe(true);
  expect(lines(p, "fix").filter((l) => l.includes("product")), p.stdout).toEqual([]);
});

test("doctor fixes a product owner profile that would prompt for a command the skill names", () => {
  const allow = load().permissions.allow.filter((r) => !r.includes("factory prd"));
  const p = doctor(poDoctorProject(allow), { ...machine(), FACTORY_AGENTS: "taytu" });
  const fixes = lines(p, "fix").filter((l) => l.includes("factory prd") && l.includes("product-pass"));
  expect(fixes.length, p.stdout).toBeGreaterThan(0);
  expect(fixes[0]).toContain("factory update");
  expect(p.code).toBe(1);
});

test("doctor notes a missing product owner profile and says how to get it", () => {
  const p = doctor(poDoctorProject(null, false), { ...machine(), FACTORY_AGENTS: "taytu" });
  const notes = lines(p, "note").filter((l) => l.includes("product owner profile"));
  expect(notes.length, p.stdout).toBe(1);
  expect(notes[0]).toContain("factory update");
  expect(notes[0]).toContain("roles.product-owner.profile");
});

// --- the PR gate the profile wires in -----------------------------------------------------------------------------------

const GATE_GH = String.raw`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
if (a[0] === "api" && a.join(" ").includes("/contents/.claude/factory.json")) { console.log("{}"); process.exit(0); }
if (a[0] === "api" && a.join(" ").includes("/comments")) { console.log("[]"); process.exit(0); }
console.error("fake gh: no answer for " + a.join(" ")); process.exit(1);
`;

function gateWorld(role: string): [string, GateEnv] {
  const d = tmp();
  writeExe(join(d, "bin", "gh"), GATE_GH);
  write(join(d, ".claude", "factory.json"), "{}");
  sh(["git", "init", "-q", d]);
  const env: GateEnv = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, FACTORY_ROLE: role, FACTORY_AGENT: "eleni" };
  delete env.CLAUDE_PROJECT_DIR;
  return [d, env];
}

const ASK = "gh issue comment 40 --body '<!-- factory-owner-ask id=palette for=product -->\nWhich palette? I recommend A.'";

test("the product owner may write an owner-queue ask and a coding agent may not", () => {
  let [d, env] = gateWorld("product-owner");
  expect(runGate(d, env, ASK)).toEqual([0, ""]);
  [d, env] = gateWorld("coding-agent");
  const [code, err] = runGate(d, env, ASK);
  expect(code, err).toBe(2);
  expect(err).toContain("owner-ask");
});

test("the product owner may not post the dev manager's other markers or add the review labels", () => {
  const [d, env] = gateWorld("product-owner");
  for (const cmd of ["gh pr comment 7 --body '<!-- factory-approved sha=abc -->'", "gh issue comment 7 --body '<!-- factory-mustfix sha=abc -->'",
    "gh pr edit 7 --add-label tests-reviewed", "gh pr edit 7 --add-label deps-reviewed",
    "gh issue comment 7 --body '<!-- factory-owner-ask id=x -->\n<!-- factory-approved sha=abc -->'"]) {
    const [code, err] = runGate(d, env, cmd);
    expect(code, `${cmd} ${err}`).toBe(2);
  }
});
