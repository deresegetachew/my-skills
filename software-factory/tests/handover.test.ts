// The manager handover (#100): `factory handover snapshot` reads the state a manager hands over from GitHub, and the
// runbook and the rewritten playbook say what the owner runs.
//
// Runs the real factory in a throwaway project (roles_support.ts) with the stateful fake `gh` of fakegh.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, factory, issue, poProject, posted, SF } from "./roles_support.ts";
import { sh } from "./support.ts";

const PR = { number: 21, title: "Add the login form", draft: false, head: { sha: "a".repeat(40), ref: "task/12-login" },
  user: { login: "agent-bot" }, labels: [] };
const DB = { pulls: [PR],
  issues: [issue(12, "Login form", "", ["factory:in-progress"]), issue(13, "Billing", "", ["factory:blocked"]),
    issue(14, "Profile page", "", ["factory:ready"]), issue(15, "Search", "", ["factory:ready"]), issue(40, "Dev manager: needs the owner")],
  comments: { "40": ["<!-- factory-owner-ask id=renumber for=product -->\nthis needs your yes: renumber the stories?",
    "<!-- factory-owner-ask id=ci-queued -->\nCI is queued",
    "<!-- factory-owner-answer id=ci-queued -->\nok"] } };
const FILES = { "docs/decisions/0001-start.md": "x", "docs/decisions/0007-colours.md": "x", "docs/decisions/README.md": "x" };

function snapshot(work: string, env: Env, ...args: string[]) {
  return factory(work, env, ["handover", "snapshot", ...args]);
}

test("the snapshot lists what a manager hands over from github", () => {
  const [d, work, env] = poProject({ db: DB, files: FILES });
  const p = snapshot(work, env);
  expect(p.code, p.out).toBe(0);
  const out = p.stdout;
  expect(out.startsWith("## Manager handover snapshot (")).toBe(true);
  expect(out).toContain("**Open pull requests (1)**");
  expect(out).toContain("- #21 Add the login form (by agent-bot, head aaaaaaa)");
  expect(out).toContain("**Tasks in progress (1)**\n- #12 Login form");
  expect(out).toContain("**Tasks blocked (1)**\n- #13 Billing");
  expect(out).toContain("**Tasks ready (2)**");
  expect(out).toContain("- #14 Profile page");
  expect(out).toContain("- #15 Search");
  expect(out).toContain("**Open owner-queue asks (1)**, issue #40");
  expect(out).toContain("- `renumber`: this needs your yes: renumber the stories?");
  expect(out, "an answered ask is not open").not.toContain("ci-queued");
  expect(out).toContain("**Needs a manager right now (1)**");
  expect(out).toContain("PR #21: commit aaaaaaa not reviewed yet");
  expect(out).toContain("- docs/decisions: 7");
  expect(posted(d), "the snapshot wrote to GitHub").toEqual([]);
});

test("the snapshot is read only and has a json form", () => {
  const [d, work, env] = poProject({ db: DB, files: FILES });
  const data = JSON.parse(snapshot(work, env, "--json").stdout) as Record<string, unknown>;
  expect((data.pullRequests as { number: number }[]).map((p) => p.number)).toEqual([21]);
  expect(data.ownerQueue).toBe(40);
  expect(data.ownerAsks).toEqual([{ id: "renumber", line: "this needs your yes: renumber the stories?" }]);
  expect(data.numbers).toEqual({ "docs/decisions": 7 });
  expect(posted(d), "the snapshot wrote to GitHub").toEqual([]);
});

test("a quiet project says so and has no queue issue yet", () => {
  const [d, work, env] = poProject({ db: {}, files: FILES });
  const out = snapshot(work, env).stdout;
  expect(out).toContain("**Open pull requests (0)**\n- none");
  expect(out).toContain("no queue issue yet");
  expect(out).toContain("- nothing");
  expect(posted(d), "no queue issue is made by a read").toEqual([]);
});

function factoryHelp(): string {
  return sh(["bash", join(SF, "factory"), "help"]).stdout;
}

test("the runbook has the steps with exact commands", () => {
  const text = readFileSync(join(SF, "docs", "manager-handover.md"), "utf8");
  for (const step of ["## 1. Capture the state in GitHub", "## 2. Dry run (owner)", "## 3. Shadow (owner)",
    "## 4. Cutover (owner)", "## 5. Rollback", "## 6. Done when"]) expect(text, step).toContain(step);
  for (const cmd of ["factory handover snapshot", "factory dev-manager loop --once --dry-run", "factory dev-manager lead loop -i",
    "factory autostart install", "factory usage --by role", "trig_01LeAQFva2b4Vvg8yqN6qyb2", "factory artifacts status"]) {
    expect(text, cmd).toContain(cmd);
  }
  const commands = new Set([...text.matchAll(/^\s*(factory [a-z-]+)/gm)].map((m) => m[1] as string));
  const known = new Set(["factory version", "factory doctor", "factory init-roles", "factory handover", "factory dev-manager",
    "factory autostart", "factory usage", "factory prs", "factory follow", "factory artifacts", "factory watch"]);
  expect([...commands].filter((c) => !known.has(c))).toEqual([]);
  const help = factoryHelp();
  for (const c of commands) expect(help, c).toContain(c.split(" ")[1] as string); // every command the runbook runs is one `factory help` lists
});

test("the playbook is rewritten around the orchestrator and keeps the owner's rule", () => {
  const dm = readFileSync(join(SF, "DEV-MANAGER.md"), "utf8");
  for (const s of ["orchestrator", "one-item sub-manager", "factory dev-manager loop -i", "Remote Control", "There is no web console",
    "small, short sessions", "factory usage --by role", "come from reusing a prompt cache", "docs/manager-handover.md",
    "If you run a manager in a cloud session"]) expect(dm, s).toContain(s);
  for (const gone of ["[Dev manager tick]", "hourly scheduled task as a backup"]) expect(dm, gone).not.toContain(gone);
  for (const line of dm.split("\n").filter((l) => l.includes("send_later"))) { // only as history or a warning, never an instruction
    expect(line.includes("woke itself") || line.includes("do not also run"), line).toBe(true);
  }
  expect(dm).toContain("The rule (owner, 21 Oct 2026)");
  expect(dm).toContain("kit/.claude/skills/manage-pass/SKILL.md");
  expect(dm).toContain("factory_lessons.ts suggest");
});
