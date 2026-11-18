// The CI steward (#675): the `ci-steward` agent and its `ci-pass` skill, its two settings, and the dev manager's profile
// and gate it runs under. The agent and the skill are instructions, so they are read as files (as the manage-pass test
// reads its skill); the settings and the gate are run as commands.
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { gate, world } from "./manager_support.ts";
import { HOOKS, KIT, read, readJson, runBun, sh, SF, tmp, WIKI, write } from "./support.ts";

const AGENT = join(KIT, ".claude", "agents", "ci-steward.md");
const SKILL = join(KIT, ".claude", "skills", "ci-pass", "SKILL.md");
const PROFILE = join(KIT, ".claude", "manager", "settings.json");
const SETTINGS = join(HOOKS, "factory_settings.ts");

function frontmatter(path: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(read(path));
  if (!m) throw new Error(`${path} has no frontmatter`);
  const meta: Record<string, string> = {};
  for (const l of (m[1] as string).split("\n")) {
    const i = l.indexOf(":");
    if (i >= 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return meta;
}

/** The text with its line breaks folded, so a phrase split over two lines is still found. */
function flat(path: string): string {
  return read(path).split(/\s+/).join(" ");
}

function person(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) delete env[name];
  return env;
}

function project(cfg: unknown): string {
  const d = tmp();
  sh(["git", "init", "-q", d]);
  mkdirSync(join(d, ".claude"));
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  return d;
}

test("the agent is well formed and runs the ci-pass skill", () => {
  const meta = frontmatter(AGENT);
  expect(meta.name).toBe("ci-steward");
  expect((meta.description ?? "").length).toBeGreaterThan(40);
  expect(["sonnet", "opus", "haiku", "inherit"]).toContain(meta.model as string);
  expect(meta.tools).toContain("Bash");
  expect(meta.tools).not.toContain("Edit"); // it changes no code: it writes only its tmp/manager-* bodies
  expect(flat(AGENT)).toContain(".claude/skills/ci-pass/SKILL.md");
  expect(frontmatter(SKILL).name).toBe("ci-pass");
});

test("the skill keeps the re-run cap and counts re-runs in flight first", () => {
  const s = flat(SKILL);
  for (const need of ["ci.steward.maxReruns", "ci.steward.rerunsPerRun", "manager.flakes", "run_attempt",
    "Never start more than the free places", "rerun-failed-jobs", "status=in_progress", "status=queued",
    "lower your cap by one", "never above `ci.steward.maxReruns`"]) {
    expect(s, need).toContain(need);
  }
});

test("the skill sorts red jobs and sends only a real failure to the author once per head", () => {
  const s = flat(SKILL);
  for (const need of ["**Infrastructure**", "**Flaky**", "**Real**", "has exceeded the maximum execution time",
    "<!-- factory-ci-steward sha=<head> -->", "once per head commit", "When you can't tell flaky from real, it is real"]) {
    expect(s, need).toContain(need);
  }
});

test("the steward never merges, approves, adds a guard label or skips a test", () => {
  const agent = flat(AGENT);
  for (const need of ["**Never merge or approve.**", "**Never add a label the guard reads** (`tests-reviewed`",
    "Never skip, delete or weaken a test, and never add a retry"]) {
    expect(agent, need).toContain(need);
  }
  const s = flat(SKILL);
  expect(s).toContain("| Merge, approve, post `factory-approved` or `factory-mustfix` |");
  expect(s).toContain("You do not merge (decided in #675)");
  expect(s).toContain("never add the label yourself");
  expect(s).toContain("Do not skip it or add a retry");
});

test("runner trouble is a proposal to the owner, with numbers, never a change", () => {
  const s = flat(SKILL);
  for (const need of ["factory-owner-ask id=<id>", "factory board ask", "factory ci status --json", "uptime",
    "factory ci runners <n>", "timeout-minutes", "you only propose", "this needs your yes: ", "manager.notify"]) {
    expect(s, need).toContain(need);
  }
});

test("slow jobs are measured per step first, and setup time is fixed before capacity", () => {
  const s = flat(SKILL);
  for (const need of ["**Measure first.**", "started_at", "completed_at", "per-step table",
    "Never propose more runners or a higher limit before that table exists", "**Setup is waste to remove.**",
    "more than about a minute", "baked into the runner image", "git mirror", "pulled ahead of time", "keyed on the lockfile"]) {
    expect(s, need).toContain(need);
  }
  const wiki = flat(join(WIKI, "ci.md"));
  expect(wiki).toContain("**Measure first.**");
  expect(wiki).toContain("**Setup is waste to remove.**");
});

test("the skill names no project", () => {
  for (const path of [SKILL, AGENT]) expect(read(path).toLowerCase(), path).not.toContain("remanual");
});

test("the two settings have help, defaults and limits", () => {
  const d = project({});
  let p = runBun(SETTINGS, ["help", "ci.steward.maxReruns"], { cwd: d, env: person() });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Default: 2");
  expect(p.stdout).toContain("at least 1");
  expect(p.stdout).toContain("ci-pass");
  p = runBun(SETTINGS, ["help", "ci.steward.rerunsPerRun"], { cwd: d, env: person() });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Default: 2");
  expect(p.stdout).toContain("at least 0");

  const ok = project({ ci: { steward: { maxReruns: 4, rerunsPerRun: 0 } } });
  p = runBun(SETTINGS, ["validate"], { cwd: ok, env: person() });
  expect(p.code, p.out).toBe(0);
  const bad = project({ ci: { steward: { maxReruns: 0 } } });
  p = runBun(SETTINGS, ["validate"], { cwd: bad, env: person() });
  expect(p.code).toBe(1);
  expect(p.out).toContain("ci.steward.maxReruns");
});

test("the settings page lists both settings", () => {
  const page = read(join(WIKI, "settings.md"));
  expect(page).toContain("| `ci.steward.maxReruns` | int | `2` |");
  expect(page).toContain("| `ci.steward.rerunsPerRun` | int | `2` |");
});

test("the dev manager's profile lets the steward read the runners and still denies merging with gh pr merge", () => {
  const perms = readJson<{ permissions: { allow: string[]; deny: string[] } }>(PROFILE).permissions;
  for (const r of ["Bash(factory ci status*)", "Bash(factory ci log *)", "Bash(uptime)", "Bash(gh api *)",
    "Bash(gh run view*)", "Bash(gh issue list*)", "Edit(tmp/manager-*)"]) {
    expect(perms.allow, r).toContain(r);
  }
  expect(perms.deny).toContain("Bash(gh pr merge*)");
  expect(perms.allow.some((a) => a.startsWith("Bash(factory ci") && !/^Bash\(factory ci (status|log )/.test(a))).toBe(false);
});

test("the gate lets the steward re-run, comment and write its status, and refuses a workflow change", () => {
  const [d, env] = world();
  for (const command of [
    "gh api -X POST repos/{owner}/{repo}/actions/runs/123/rerun-failed-jobs",
    "gh api -X POST repos/{owner}/{repo}/issues -f title=\"Flaky test: login works\" -f body=seen",
    "gh api -X PATCH repos/{owner}/{repo}/issues/9 -f body=status",
  ]) {
    const [rc, err] = gate(d, env, command);
    expect(rc, `${command} ${err}`).toBe(0);
  }
  const [rc, err] = gate(d, env, "gh api -X PUT repos/{owner}/{repo}/contents/.github/workflows/ci.yml -f content=x");
  expect(rc, err).toBe(2);
});

test("manage-pass and the playbook hand red CI to the steward", () => {
  const pass = flat(join(KIT, ".claude", "skills", "manage-pass", "SKILL.md"));
  expect(pass).toContain("start the `ci-steward` agent");
  expect(pass).toContain("/ci-pass");
  expect(flat(join(SF, "DEV-MANAGER.md"))).toContain("start the `ci-steward` agent with `/ci-pass`");
  expect(flat(join(WIKI, "ci.md"))).toContain("## The CI steward");
});
