// The dev manager's standing rules, settings profile and merge gate (#96).
//
// The gate runs as Claude Code runs a PreToolUse hook (the tool call as JSON on stdin; exit 2 blocks) against a fake `gh`
// that reads one JSON file. The profile and the skill are read as files.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { judge } from "../hooks/factory_ci_judge.ts";
import { comment, gate, HEAD, PROFILE, runOk, SKILL, world, type Env } from "./manager_support.ts";
import { git, HOOKS, KIT, SF, sh, tmp } from "./support.ts";

const MERGE = (sha: string): string => `gh api -X PUT repos/{owner}/{repo}/pulls/7/merge -f merge_method=merge -f sha=${sha}`;

function refused(d: string, env: Env, command: string, ...words: string[]): string {
  const [rc, err] = gate(d, env, command);
  expect(rc, `${command} ${err}`).toBe(2);
  for (const w of words) expect(err.toLowerCase(), w).toContain(w.toLowerCase());
  expect(["owner-queue ask", "must-fix", "Wait", "Run gh", "unbalanced"].some((x) => err.includes(x)), err).toBe(true);
  return err;
}

function allowed(d: string, env: Env, command: string): void {
  const [rc, err] = gate(d, env, command);
  expect(rc, `${command} ${err}`).toBe(0);
}

// --- merges -----------------------------------------------------------------------------------------------------------

test("a merge of an approved head with green ci is allowed", () => {
  const [d, env] = world();
  allowed(d, env, MERGE(HEAD));
  allowed(d, env, MERGE(HEAD.slice(0, 12))); // a short sha that is the head's prefix
  allowed(d, env, `gh pr merge 7 --merge --match-head-commit ${HEAD}`);
});

test("a merge pinned to another sha is refused", () => {
  const [d, env] = world();
  refused(d, env, MERGE("b".repeat(40)), "moved on", HEAD.slice(0, 12));
});

test("a merge that is not pinned is refused", () => {
  const [d, env] = world();
  refused(d, env, "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge -f merge_method=merge", "pin the merge");
  refused(d, env, "gh pr merge 7 --merge", "pin the merge");
});

test("an unapproved pr is refused", () => {
  let [d, env] = world({ comments: [comment("Looks fine to me")] });
  refused(d, env, MERGE(HEAD), "no `<!-- factory-approved");
  [d, env] = world({ comments: [] });
  refused(d, env, MERGE(HEAD), "no `<!-- factory-approved");
});

test("an approval for an older commit is refused", () => {
  const [d, env] = world({ comments: [comment("<!-- factory-approved sha=" + "c".repeat(12) + " -->")] });
  refused(d, env, MERGE(HEAD), "approval is for " + "c".repeat(12));
});

test("a must fix after the approval holds the merge and an approval after it releases it", () => {
  const ok = `<!-- factory-approved sha=${HEAD.slice(0, 12)} -->`;
  let [d, env] = world({ comments: [comment(ok), comment("<!-- factory-mustfix sha=" + HEAD.slice(0, 12) + " -->\nfix x")] });
  refused(d, env, MERGE(HEAD), "latest marker is a must-fix");
  [d, env] = world({ comments: [comment("<!-- factory-mustfix sha=" + "c".repeat(12) + " -->"), comment(ok)] });
  allowed(d, env, MERGE(HEAD));
});

test("the managers own pr is refused by its branch or its marker", () => {
  let [d, env] = world({ pr: { head: { sha: HEAD, ref: "manager/fasil-fix-ci" } } });
  refused(d, env, MERGE(HEAD), "opened", "owner");
  [d, env] = world({ pr: { body: "Fix.\n<!-- factory-role role=dev-manager name=fasil -->" } });
  refused(d, env, MERGE(HEAD), "opened");
});

test("only trusted logins approvals count when main names them", () => {
  const mark = `<!-- factory-approved sha=${HEAD.slice(0, 12)} -->`;
  let [d, env] = world({ cfg: { trustedReviewers: ["owner"] }, comments: [comment(mark, "intruder")] });
  refused(d, env, MERGE(HEAD), "no `<!-- factory-approved");
  [d, env] = world({ cfg: { trustedReviewers: ["owner"] }, comments: [comment(mark, "intruder"), comment(mark, "owner")] });
  allowed(d, env, MERGE(HEAD));
});

test("ci is judged by the newest non skipped run per job", () => {
  const runs = [runOk("test", { started: "2026-10-25T09:00:00Z", conclusion: "failure", id: 1 }),
    runOk("test", { started: "2026-10-25T09:10:00Z", conclusion: "success", id: 2 }), // the re-run passed
    runOk("lint", { started: "2026-10-25T09:00:00Z", conclusion: "success", id: 3 }),
    runOk("lint", { started: "2026-10-25T09:20:00Z", conclusion: "skipped", id: 4 }), // a skipped run counts for nothing
    runOk("deploy", { conclusion: "skipped", id: 5 })];
  const [d, env] = world({ runs });
  allowed(d, env, MERGE(HEAD));
});

test("failed pending and missing ci are not green", () => {
  let [d, env] = world({ runs: [runOk("test", { conclusion: "failure" }), runOk("lint")] });
  refused(d, env, MERGE(HEAD), "CI failed", "test");
  [d, env] = world({ runs: [runOk("test", { status: "in_progress", conclusion: null }), runOk("lint")] });
  refused(d, env, MERGE(HEAD), "still running", "factory wait ci 7");
  [d, env] = world({ runs: [] });
  refused(d, env, MERGE(HEAD), "no CI runs");
  [d, env] = world({ runs: [runOk("test")], statuses: [{ id: 1, context: "ci/legacy", state: "failure" }] });
  refused(d, env, MERGE(HEAD), "ci/legacy");
});

test("a merge of a closed pr is left to github", () => {
  const [d, env] = world({ pr: { state: "closed" }, comments: [] });
  allowed(d, env, MERGE(HEAD));
});

test("when github cannot be read the merge is refused", () => {
  const [d, env] = world({ down: true });
  refused(d, env, MERGE(HEAD), "could not read");
});

test("a merge sha the shell would expand is refused", () => {
  const [d, env] = world();
  refused(d, env, "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge -f sha=$(git rev-parse HEAD)", "plain text");
  refused(d, env, "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge --input body.json", "plain text");
});

// --- refs, history, protected places ------------------------------------------------------------------------------------

test("force pushes and ref deletions are refused", () => {
  const [d, env] = world();
  for (const [cmd, word] of [["git push --force origin fix", "force"], ["git push -f origin fix", "force"],
    ["git push --force-with-lease origin fix", "force"], ["git push origin +fix:fix", "force"],
    ["git push origin :old-branch", "delete"], ["git push origin --delete old-branch", "delete"],
    ["git push -d origin old-branch", "delete"], ["git branch -D old", "delete"],
    ["git tag -d v1", "delete"], ["git update-ref -d refs/heads/x", "delete"],
    ["git push origin HEAD:main", "main branch"], ["git push origin main", "main branch"],
    ["git -C /tmp/x push --force origin fix", "force"],
    ["gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/old", "refs"],
    ["gh api -X PATCH repos/{owner}/{repo}/git/refs/heads/x -f sha=1 -F force=true", "refs"]] as const) {
    refused(d, env, cmd, word);
  }
});

test("github content and branch protection cannot be written but can be read", () => {
  const [d, env] = world();
  for (const [cmd, word] of [["gh api -X PUT repos/{owner}/{repo}/contents/.github/workflows/ci.yml -f message=x", ".github"],
    ["gh api repos/{owner}/{repo}/contents/.github/CODEOWNERS -f message=x -f content=eA==", ".github"],
    ["gh api -X DELETE repos/{owner}/{repo}/contents/.github/CODEOWNERS", ".github"],
    ["gh api -X PUT repos/{owner}/{repo}/branches/main/protection --input p.json", "branch protection"],
    ["gh api -X DELETE repos/{owner}/{repo}/branches/main/protection", "branch protection"],
    ["gh api -X POST repos/{owner}/{repo}/rulesets --input r.json", "rulesets"],
    ["gh api -X PUT repos/{owner}/{repo}/actions/secrets/KEY -f encrypted_value=x", "secrets"]] as const) {
    refused(d, env, cmd, word);
  }
  allowed(d, env, "gh api repos/{owner}/{repo}/contents/.github/CODEOWNERS");
  allowed(d, env, "gh api repos/{owner}/{repo}/branches/main/protection");
});

test("ordinary manager commands pass", () => {
  const [d, env] = world();
  for (const cmd of ["gh api repos/{owner}/{repo}/pulls?state=open", "git log --oneline -5", "git fetch origin",
    "gh api -X POST repos/{owner}/{repo}/issues/7/comments -f body=hello",
    "gh api -X POST repos/{owner}/{repo}/git/refs -f ref=refs/heads/manager/x -f sha=1",
    "gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f base=main", "factory precheck",
    "bun --no-env-file .claude/hooks/factory_wait.ts ci 7",
    "git push origin manager/fasil-note"]) {
    allowed(d, env, cmd);
  }
});

test("gh hidden in a wrapper or unreadable is refused", () => {
  const [d, env] = world();
  refused(d, env, "bash -c 'gh api -X PUT repos/{owner}/{repo}/pulls/7/merge -f sha=" + HEAD + "'", "run gh and git directly");
  refused(d, env, "eval \"git push --force origin x\"", "run gh and git directly");
  refused(d, env, "gh api 'repos/x", "cannot read");
});

test("secrets files are not read by a shell command", () => {
  const [d, env] = world();
  for (const cmd of ["cat .env", "cat .env.local", "head -3 secrets/dev.yaml", "cat ~/.ssh/id_rsa", "grep KEY apps/api/.env.production"]) {
    refused(d, env, cmd, "secrets");
  }
  allowed(d, env, "cat .env.example");
});

test("a chained command is checked part by part", () => {
  const [d, env] = world({ comments: [] });
  refused(d, env, "git fetch origin && " + MERGE(HEAD), "factory-approved");
});

test("judge takes the newest non skipped run per job", () => {
  expect(judge([runOk("a", { started: "2026-10-25T09:00:00Z", conclusion: "failure", id: 1 }),
    runOk("a", { started: "2026-10-25T09:05:00Z", id: 2 })])).toEqual(["green", ["a"]]);
  expect(judge([runOk("a", { started: "2026-10-25T09:00:00Z", id: 1 }),
    runOk("a", { started: "2026-10-25T09:05:00Z", conclusion: "failure", id: 2 })])).toEqual(["failed", ["a"]]);
  expect(judge([runOk("a", { conclusion: "skipped" })])).toEqual(["none", []]);
  expect(judge([runOk("a", { id: 1 }), runOk("b", { status: "queued", conclusion: null, id: 2 })])).toEqual(["pending", ["b"]]);
  expect(judge([runOk("a", { conclusion: "cancelled" })])).toEqual(["failed", ["a"]]);
});

// --- the settings profile ---------------------------------------------------------------------------------------------

interface Hook { command: string }
interface Profile {
  permissions: { allow: string[]; deny: string[] };
  hooks: Record<string, { matcher?: string; hooks: Hook[] }[]>;
}

function loadProfile(): Profile {
  return JSON.parse(readFileSync(PROFILE, "utf8")) as Profile;
}

test("the profile allows gh api and read only git and the tools a review needs", () => {
  const allow = loadProfile().permissions.allow;
  for (const need of ["Bash(gh api *)", "Read", "Grep", "Glob", "Agent", "Bash(git log*)", "Bash(git show*)", "Bash(git diff*)"]) {
    expect(allow).toContain(need);
  }
  expect(allow.filter((a) => ["Bash(git push", "Bash(git commit", "Bash(git checkout", "Bash(git add"].some((p) => a.startsWith(p)))).toEqual([]);
});

test("the profile denies what the manager never does", () => {
  const deny = loadProfile().permissions.deny;
  for (const need of ["Bash(git push --force*)", "Bash(git push origin main*)", "Bash(git push * --delete*)",
    "Edit(./.claude/**)", "Edit(./vendor/**)", "Edit(./CLAUDE.md)", "Edit(./docs/PRD.md)",
    "Edit(./.mcp.json)", "Edit(//**/factory-reviews/**)", "Read(./.env)", "Read(./.env.local)", "Read(./secrets/**)",
    "Bash(gh pr merge*)"]) {
    expect(deny).toContain(need);
  }
});

test("no profile has a Write(path) rule: Claude Code never matches one and warns at every start, Edit(path) covers writes", () => {
  for (const rel of [[".claude", "factory", "settings.json"], [".claude", "manager", "settings.json"]]) {
    const perms = (JSON.parse(readFileSync(join(KIT, ...rel), "utf8")) as Profile).permissions;
    const all = [...perms.deny, ...(perms.allow ?? [])];
    expect(all.filter((r) => r.startsWith("Write(")), rel.join("/")).toEqual([]);
    for (const path of ["./.claude/**", "./vendor/**", "./CLAUDE.md", "./docs/PRD.md", "./.mcp.json", "//**/factory-reviews/**"]) {
      expect(perms.deny, `${rel.join("/")} protects ${path}`).toContain(`Edit(${path})`);
    }
  }
});

test("the profile keeps every factory protecting deny of the shared settings except the gh api one", () => {
  const shared = (JSON.parse(readFileSync(join(KIT, ".claude", "factory", "settings.json"), "utf8")) as Profile).permissions;
  expect(shared.deny).toContain("Bash(gh api *)"); // the reason the manager needs its own profile
  const mine = new Set(loadProfile().permissions.deny);
  const left = shared.deny.filter((d) => d !== "Bash(gh api *)" && !mine.has(d) && !d.startsWith("Bash(gh pr ")
    && !d.startsWith("Bash(git push") && !d.startsWith("Bash(git branch") && !d.includes("manager-claims") && !d.includes("manager_claims"));
  expect(left).toEqual([]);
  // a builder may not run the claim commands (#99), but the dev manager is the one who does
  const claims = shared.deny.filter((d) => d.includes("manager-claims") || d.includes("manager_claims"));
  expect(claims.length).toBeGreaterThan(0);
  expect(claims.filter((d) => mine.has(d))).toEqual([]);
  expect(loadProfile().permissions.allow).toContain("Bash(factory manager-claims*)");
  for (const d of shared.deny) {
    if (d.startsWith("Bash(git push") || d.startsWith("Bash(git branch")) expect(mine.has(d), d).toBe(true);
  }
});

test("the profile wires the merge gate on bash", () => {
  const hooks = loadProfile().hooks.PreToolUse ?? [];
  expect(hooks.some((h) => h.matcher === "Bash" && h.hooks.some((x) => x.command.includes("manager_gate.ts")))).toBe(true);
  // every hook command the profile runs exists in the factory's hooks folder
  for (const event of Object.values(loadProfile().hooks)) {
    for (const h of event) {
      for (const x of h.hooks) {
        const name = /\/hooks\/([\w.-]+\.(?:py|ts))/.exec(x.command)?.[1];
        expect(name, x.command).toBeTruthy();
        expect(existsSync(join(HOOKS, name as string)) && statSync(join(HOOKS, name as string)).isFile(), name).toBe(true);
      }
    }
  }
});

test("a link install links the skill the profile and the gate into a project", () => {
  const d = tmp();
  mkdirSync(join(d, "vendor"));
  const c = sh(["cp", "-a", dirname(SF), join(d, "vendor", "my-skills")]);
  expect(c.code, c.out).toBe(0);
  git(d, "init", "-q");
  const p = sh(["bash", join(d, "vendor", "my-skills", "software-factory", "install.sh"), ".", "--link"], { cwd: d });
  expect(p.code, p.stderr).toBe(0);
  for (const rel of [".claude/skills/manage-pass/SKILL.md", ".claude/manager/settings.json", ".claude/hooks/manager_gate.ts",
    ".claude/hooks/factory_ci_judge.ts"]) {
    const path = join(d, rel);
    expect(lstatSync(path).isSymbolicLink() && statSync(path).isFile(), rel).toBe(true);
  }
});

// --- the skill and the playbook ---------------------------------------------------------------------------------------

function skillText(): string {
  return readFileSync(SKILL, "utf8");
}

test("the skill is well formed and holds the rules", () => {
  const s = skillText();
  const m = /^---\nname: manage-pass\ndescription: (.+?)\n---\n/s.exec(s);
  expect(m && (m[1] as string).length > 40, s.slice(0, 200)).toBe(true);
  for (const need of ["factory-question", "factory-answer", "factory-mustfix sha=<head>", "factory-approved sha=<head>",
    "pr-watch sha=<head>", "factory-owner-ask id=<slug>", "factory-hold", "PUT repos/{owner}/{repo}/pulls/<n>/merge",
    "sha=<head>", "tests-reviewed", "deps-reviewed", "newest run that is not `skipped`", "rerun-failed-jobs",
    "@copilot", "does not exist", "quiet pass", "--dry-run", "owner-queue ask", "<roles.dir>/dev-manager/README.md",
    "<notes>/manager.md", "Review in a subagent", "pass order"]) {
    expect(s.toLowerCase().includes(need.toLowerCase()) || s.includes(need), need).toBe(true);
  }
  expect(s.includes("-X PUT") || s.includes("PUT repos")).toBe(true);
});

test("the what you may change table has one source the skill and the playbook links to it", () => {
  const dm = readFileSync(join(SF, "DEV-MANAGER.md"), "utf8");
  const s = skillText();
  const rows = ["Review the coding agents' PRs; approve and merge those that pass", "**Any change to the factory:**",
    "**Your own working rhythm:**", "**Merging your own PRs,** whatever they change",
    "**Scope and order:**", "**Anything on the owner's computer,**", "**History:** force-pushing"];
  for (const row of rows) {
    expect(s).toContain(row);
    expect(dm, "the playbook must link to the table, not copy it: " + row).not.toContain(row);
  }
  expect(s).toContain("| You do it on your own | You ask the owner first |");
  expect(dm).toContain("kit/.claude/skills/manage-pass/SKILL.md");
});

test("the skill text of the table is what the playbook said on 21 oct", () => {
  // the owner's rule is kept word for word: these cells are copied from the playbook before the move
  const s = skillText();
  for (const cell of ["Post must-fixes, answer the agents' questions, add `tests-reviewed` / `deps-reviewed` after reading the change",
    "Keep main's CI green: fix a broken build on a branch and merge it",
    "**History:** force-pushing, deleting branches you didn't make, rewriting anything already pushed"]) {
    expect(s).toContain(cell);
  }
});
