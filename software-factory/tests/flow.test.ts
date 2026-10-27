// The end-to-end flow (#103): from an idea in an empty folder to a reviewed first milestone, then a change of direction,
// using only the role commands. A scripted test with fakes: the product owner's `-i` session is a fake `claude` that runs a
// short script (what the skill tells the real one to do), the owner's yes is a comment added to the fake GitHub, and the
// fake `gh` (fakegh.ts) keeps the issues, labels and comments. Nothing real runs: no model, no network.
//
// What it checks is that the hand-offs work through GitHub and the repository alone: a role started on a fresh clone finds
// everything it needs. The part that needs a real model (the interview itself, the quality of the PRD) is not tested here;
// the owner runs it once for real (docs in README, "From an idea to a first milestone").
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PR_TEXT } from "../hooks/factory_init.ts";
import { GH as FAKE_GH } from "./fakegh.ts";
import { type Env, factory, git, log, project, type Row, SF } from "./roles_support.ts";
import { KIT, sh, writeExe } from "./support.ts";

const PRELUDE = String.raw`
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
function fx(...a: string[]) {
  const p = Bun.spawnSync(["bash", "./factory", ...a], { stdout: "pipe", stderr: "pipe" });
  const r = { args: a, rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  appendFileSync(process.env.FLOW_OUT as string, JSON.stringify(r) + "\n");
  return r;
}
function run(...cmd: string[]) { const p = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" }); if (p.exitCode !== 0) throw new Error(cmd.join(" ")); }
function push(msg: string) {
  run("git", "add", "-A");
  run("git", "commit", "-qm", msg);
  run("git", "push", "-q", "origin", "HEAD:main"); // the owner merges the pull request
}
void readFileSync; void rmSync; void mkdirSync; void writeFileSync;
`;

function flowProject(): [string, string, Env] {
  const [d, work, env] = project({ cfg: { tasks: { source: "issues" } }, db: {} });
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  env.FLOW_OUT = join(d, "flow.jsonl");
  writeFileSync(env.FLOW_OUT, "");
  return [d, work, env];
}

function db(d: string): Row {
  return JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as Row;
}

function save(d: string, data: Row): void {
  writeFileSync(join(d, "db.json"), JSON.stringify(data));
}

/** The product owner's `-i` session: `factory product-owner eleni loop -i --once` with nothing queued, so the loop
 * starts a discovery session; the fake claude runs `script` in the session's own checkout. */
function session(d: string, work: string, env: Env, script: string) {
  const body = join(d, "session.ts");
  writeFileSync(body, PRELUDE + script);
  const hook = join(d, "hook.sh");
  writeFileSync(hook, `bun --no-env-file "${body}"\n`);
  const p = factory(work, { ...env, FAKE_CLAUDE_HOOK: hook }, ["product-owner", "eleni", "loop", "-i", "--once"], 150_000);
  expect(p.code, p.out).toBe(0);
  return p;
}

interface Ran {
  args: string[];
  rc: number;
  out: string;
  err: string;
}

function ran(env: Env): Ran[] {
  return readFileSync(env.FLOW_OUT as string, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ran);
}

function ownerSays(d: string, text: string, queue = 101): void {
  const data = db(d);
  const comments = (data.comments ??= {}) as Record<string, unknown[]>;
  (comments[String(queue)] ??= []).push({ body: text, created_at: "2026-10-25T12:00:00Z" });
  save(d, data);
}

function stage(work: string, env: Env, ...args: string[]) {
  return factory(work, env, ["prd", "--stage", ...args]);
}

function rows(work: string, env: Env): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const r of JSON.parse(stage(work, env, "--json").stdout) as Row[]) out[r.stage as string] = r;
  return out;
}

function pull(work: string): void {
  sh(["git", "pull", "-q", "origin", "main"], { cwd: work });
}

// --- stage 0: the scaffold -------------------------------------------------------------------------------------------

test("init makes the scaffold and a second run adds and posts nothing", () => {
  const [d, work, env] = flowProject();
  const p = factory(work, env, ["init"]);
  expect(p.code, p.out).toBe(0);
  for (const want of ["added    .claude/factory/roles/product-owner/README.md", "created  11 labels", "made     owner queue #101",
    "added    docs/PRD.md", "added    .github/PULL_REQUEST_TEMPLATE/prd-change.md", "factory product-owner loop -i"]) {
    expect(p.stdout, want).toContain(want);
  }
  const data = db(d);
  const labels = new Set((data.labels as Row[]).map((x) => x.name as string));
  for (const l of ["factory:ready", "factory:in-progress", "factory:blocked"]) expect(labels.has(l), l).toBe(true);
  expect((data.issues as Row[]).map((i) => i.title)).toEqual(["Dev manager: needs the owner"]);
  const n = (data.posted as Row[]).length;
  const again = factory(work, env, ["init"]);
  expect(again.code, again.out).toBe(0);
  const head = again.stdout.split("Next,")[0] as string;
  expect(head).not.toContain("added");
  expect(head).not.toContain("made");
  expect(again.stdout).toContain("exists   owner queue #101");
  expect((db(d).posted as Row[]).length, "a second run posted something").toBe(n);
});

test("a dry run changes nothing", () => {
  const [d, work, env] = flowProject();
  const p = factory(work, env, ["init", "--dry-run"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("would add docs/PRD.md");
  expect(p.stdout).toContain("would make the owner queue issue");
  expect(existsSync(join(work, "docs", "PRD.md"))).toBe(false);
  expect(db(d).posted, "a dry run wrote something").toBeUndefined();
});

test("the prd change template in the kit is the one init writes", () => {
  const kit = readFileSync(join(KIT, ".github", "PULL_REQUEST_TEMPLATE", "prd-change.md"), "utf8");
  expect(kit).toBe(PR_TEXT);
  for (const part of ["## Stories this touches", "## Tasks that move", "## Decision record", "## Owner's yes"]) expect(kit, part).toContain(part);
});

// --- stage 1 to 4, and the pivot -------------------------------------------------------------------------------------

const VISION = String.raw`
mkdirSync("docs", { recursive: true });
writeFileSync("docs/PRD.md",
  "# Product requirements\n\n## Vision\n\nBuilders follow a guide on any screen.\n\n## User stories\n\n" +
  "- US-1: Follow a guide step by step\n- US-2: Open a guide offline\n\n## Rules that must never break\n\nWarnings are never reworded.\n");
push("PRD: vision and stories");
fx("prd", "--stage", "--ask", "design"); // too early: nothing approved yet
fx("prd", "--stage", "--ask", "vision");
`;

const DESIGN = String.raw`
mkdirSync("design/screens", { recursive: true });
writeFileSync("design/STYLE.md", "# Style\n\nCalm and practical.\n");
writeFileSync("design/screens/step.html", "<h1>Step</h1>\n");
push("design references");
fx("prd", "--stage", "--ask", "design");
`;

const PLAN = String.raw`
const body = (n: number) => "## What we're building\n\nThe step screen.\n\n## Brief: read these, not more\n\n- **PRD:** US-" + n + "\n\n" +
  "## Acceptance criteria\n\n- A builder sees one instruction per step\n";
for (const [n, title] of [[1, "Step screen"], [2, "Offline cache"]] as const) {
  writeFileSync("task.md", body(n));
  fx("issues", "new", "--title", title, "--body-file", "task.md", "--milestone", "First milestone");
}
rmSync("task.md");
fx("prd", "--stage", "--ask", "plan");
`;

const PIVOT = String.raw`
const text = readFileSync("docs/PRD.md", "utf8").replace("\n## Rules", "- US-3: Search the parts list\n\n## Rules");
writeFileSync("docs/PRD.md", text);
mkdirSync("docs/decisions", { recursive: true });
writeFileSync("docs/decisions/0001-add-parts-search.md", "# 1. Add a parts search\n\nBuilders look for a screw by its number.\n");
writeFileSync("task.md", "## Brief: read these, not more\n\n- **PRD:** US-3\n\n## Acceptance criteria\n\n- A builder finds a part by its number\n");
fx("issues", "new", "--title", "Parts search", "--body-file", "task.md", "--milestone", "First milestone");
rmSync("task.md");
writeFileSync("pr-body.md", readFileSync(".github/PULL_REQUEST_TEMPLATE/prd-change.md", "utf8"));
push("PRD change: parts search");
`;

test("an idea in an empty folder reaches the hand over through the three gates and a pivot follows", () => {
  const [d, work, env] = flowProject();
  expect(factory(work, env, ["init"]).code).toBe(0);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "init");
  git(work, "push", "-q", "origin", "HEAD:main");

  // Stage 1: vision. With nothing queued, -i starts a discovery session; nothing is ready before it.
  expect(rows(work, env).vision?.done).toBe(false);
  expect(rows(work, env).vision?.line).toContain("no stories with a title");
  const p = session(d, work, env, VISION);
  expect(p.stdout).toContain("nothing queued: a discovery session");
  const claude = log(env).filter((l) => l.startsWith("claude "));
  expect(claude.length, claude.join("\n")).toBe(1);
  expect(claude[0]).toContain("/product-pass discover");
  expect(claude[0]).toContain("factory-role role=product-owner name=eleni");
  const first = ran(env);
  expect(first[0]?.args[first[0].args.length - 1]).toBe("design");
  expect(first[0]?.rc).not.toBe(0);
  expect(first[0]?.err).toContain('"code": "not-ready"');
  expect(first[1]?.rc, JSON.stringify(first[1])).toBe(0);
  expect(first[1]?.out).toContain("asked in the owner queue (#101)");
  pull(work); // the PRD reached main
  let r = rows(work, env);
  expect(r.vision?.done).toBe(true);
  expect(r.vision?.approval).toBe("asked");
  expect(r.design?.approval).toBe("not ready");
  expect(stage(work, env).stdout).toContain("wait for the owner's yes on stage-vision");
  const asks = ((db(d).comments as Record<string, (string | Row)[]>)["101"] ?? [])
    .filter((c) => (typeof c === "string" ? c : c.body as string).includes("factory-owner-ask id=stage-vision"));
  expect(asks.length).toBe(1);

  // The owner's reply is the gate. A question is not a yes.
  ownerSays(d, "Why two stories and not three?");
  expect(rows(work, env).vision?.approval).toBe("answered");
  ownerSays(d, "Yes, that is the scope.");
  expect(rows(work, env).vision?.approval).toBe("approved");

  // Stage 2: design (gated by the vision), approved with the answer marker.
  session(d, work, env, DESIGN);
  pull(work);
  expect(rows(work, env).design?.approval).toBe("asked");
  ownerSays(d, "<!-- factory-owner-answer id=stage-design -->\nlooks right");
  expect(rows(work, env).design?.approval).toBe("approved");

  // Stage 3: plan. Task issues name their stories and have a "Done when"; the plan is done when no story lacks a task.
  session(d, work, env, PLAN);
  r = rows(work, env);
  expect(r.plan?.done, JSON.stringify(r.plan)).toBe(true);
  expect(r.plan?.line).toContain("2 tasks name a story");
  expect(r.plan?.approval).toBe("asked");
  const issues = (db(d).issues as Row[]).filter((i) => i.title === "Step screen" || i.title === "Offline cache");
  expect(issues.length).toBe(2);
  expect(issues.every((i) => (i.milestone as Row).title === "First milestone")).toBe(true);
  const prd = factory(work, env, ["prd"]).stdout;
  expect(prd).toContain("US-1");
  expect(prd).toContain("2 stories");

  // Stage 4: hand over. The three approvals open the door; a coding agent finds a task, the dev manager reads the queue.
  expect(rows(work, env)["hand over"]?.done).toBe(false);
  ownerSays(d, "Approved, go ahead");
  r = rows(work, env);
  expect(r["hand over"]?.done).toBe(true);
  expect(r["hand over"]?.line).toContain("2 ready tasks");
  expect(stage(work, env).stdout).toContain("Next: start the coding agents.");
  const dry = factory(work, env, ["coding-agent", "menelik", "loop", "--dry-run"]);
  expect(dry.stdout).toContain("next task: issue-");
  expect([0, 3]).toContain(factory(work, env, ["dev-manager", "lead", "loop", "--once", "--dry-run"]).code);

  // Stage 7: a change of direction is a pull request from the template, a decision record and a task, and the story
  // count and the task list change with it.
  session(d, work, env, PIVOT);
  pull(work);
  const out = factory(work, env, ["prd"]).stdout;
  expect(out).toContain("3 stories");
  expect(out).toContain("US-3");
  expect(existsSync(join(work, "docs", "decisions", "0001-add-parts-search.md"))).toBe(true);
  expect(factory(work, env, ["issues", "list"]).stdout, "the running agents pick the new task from GitHub").toContain("Parts search");
  expect(rows(work, env).plan?.done, "the new task has its Done when").toBe(true);

  // Everything a role needs is findable from the repository: a fresh clone (another machine) sees the same stages.
  const other = join(d, "other");
  git(d, "clone", "-q", join(d, "origin.git"), other);
  let q = sh(["bash", "./factory", "prd", "--stage"], { cwd: other, env });
  expect(q.code, q.out).toBe(0);
  expect(q.stdout).toContain("hand over");
  expect(q.stdout).toContain("approved");
  q = sh(["bash", "./factory", "product-owner", "eleni", "loop", "--dry-run"], { cwd: other, env });
  expect(q.code, q.out).toBe(0);
  expect(q.stdout).not.toContain("missing");
}, 600_000);

test("a stage that is not done cannot be asked and an unknown stage is refused", () => {
  const [, work, env] = flowProject();
  factory(work, env, ["init"]);
  let p = stage(work, env, "--ask", "plan");
  expect(p.code, p.out).toBe(1);
  let err = JSON.parse(p.stderr) as Record<string, string>;
  expect(err.code).toBe("not-ready");
  expect(err.fix).toBeTruthy();
  p = stage(work, env, "--ask", "launch");
  expect(p.code, p.out).toBe(1);
  err = JSON.parse(p.stderr) as Record<string, string>;
  expect(err.code).toBe("unknown-stage");
});

test("a product owner without i and nothing queued still has nothing to do", () => {
  const [, work, env] = flowProject();
  factory(work, env, ["init"]);
  factory(work, env, ["product-owner", "eleni", "loop", "--once"]);
  expect(log(env).filter((l) => l.startsWith("claude ")), "no session starts without -i").toEqual([]);
  const d2 = factory(work, env, ["product-owner", "eleni", "loop", "-i", "--dry-run"]);
  expect(d2.stdout).toContain("discovery session");
});

void SF;
