// The product-owner role's tools (#101): `factory prd` (progress against the PRD), the owner-queue asks tagged
// for=product, and the dry run that prints the digest.
//
// Runs the real factory and hooks in a throwaway project (roles_support.ts) with a fake `claude` and the stateful fake
// `gh` of fakegh.ts. The sign-off queue's own tests are in signoff.test.ts (#252).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStories, storyRefs } from "../hooks/factory_prd.ts";
import { ASK_RX } from "../hooks/factory_orchestrator.ts";
import { parseReads } from "../hooks/factory_roles.ts";
import { claudeCalls, factory, issue, poProject, posted, PRD } from "./roles_support.ts";
import { KIT } from "./support.ts";

// --- factory prd -----------------------------------------------------------------------------------------------------

test("a story id starts a heading or a list item and a task names its stories on one line", () => {
  const got = parseStories(PRD);
  expect(got.map(([n, t]) => [n, t])).toEqual([[1, "Upload a manual"], [2, "Review the draft guide"], [3, "Publish a guide"],
    [4, "Follow a guide offline"], [4, "Follow a guide on a phone"], [5, "Ask the builder helper"]]);
  expect(storyRefs("x\n- **PRD:** US-3, US-5 and US-3\n")).toEqual([3, 5]);
  expect(storyRefs("PRD: US-2")).toEqual([2]);
  expect(storyRefs("see US-2 in the PRD")).toEqual([]);
  expect(storyRefs("- **PRD:** \n- **Decisions:** US-7")).toEqual([]);
});

test("prd prints per story its tasks and state and how much remains", () => {
  const [d, work, env] = poProject();
  const p = factory(work, env, ["prd"]);
  expect(p.code, p.out).toBe(0);
  const out = p.stdout;
  expect(out).toContain("5 stories: 1 done, 1 in progress, 1 planned, 2 with no task. Tasks: 2 of 4 done.");
  expect(out).toContain("US-1   done");
  expect(out).not.toContain("#10 done, #11 done"); // a finished story hides its tasks in the list
  expect(out).toContain("US-2   in progress");
  expect(out).toContain("#12 in progress");
  expect(out).toContain("US-3   planned");
  expect(out).toContain("#13 ready");
  expect(out).toContain("US-5   no task"); // the closed-as-not-planned task counts for nothing
  expect(out).toContain("US-4 is used by 2 stories (lines 8, 9)");
  expect(out).toContain("Tasks #15 name US-9, which the PRD does not have.");
  expect(posted(d), "factory prd is read-only").toEqual([]);
});

test("prd open hides done stories and story shows one with all its tasks", () => {
  const [, work, env] = poProject();
  const out = factory(work, env, ["prd", "--open"]).stdout;
  expect(out).not.toContain("US-1 ");
  expect(out).toContain("US-2   in progress");
  const one = factory(work, env, ["prd", "--story", "1"]).stdout;
  expect(one).toContain("Upload a manual");
  expect(one).toContain("#10 done, #11 done");
  expect(one).not.toContain("US-2");
  const missing = factory(work, env, ["prd", "--story", "99"]).stdout;
  expect(missing).toContain("no story US-99");
});

test("prd json is the same data", () => {
  const [, work, env] = poProject();
  const data = JSON.parse(factory(work, env, ["prd", "--json"]).stdout) as Record<string, unknown>;
  expect(data.counts).toEqual({ done: 1, "in progress": 1, planned: 1, "no task": 2 });
  expect(data.duplicates).toEqual({ "4": [8, 9] });
  expect(data.unknown).toEqual({ "9": [15] });
  expect((data.stories as { story: number }[]).map((r) => r.story)).toEqual([1, 2, 3, 4, 5]);
});

test("prd without story ids or without a prd says what to do", () => {
  let [, work, env] = poProject({ prd: "# PRD\n\n1. Upload a manual\n" });
  let p = factory(work, env, ["prd"]);
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("US-<n>");
  expect(p.stderr).toContain("PRD: US-3");
  [, work, env] = poProject({ cfg: { prd: "docs/none.md" } });
  p = factory(work, env, ["prd"]);
  expect(p.code).not.toBe(0);
  expect(p.stderr).toContain("docs/none.md does not exist");
  expect(p.stderr).toContain("`prd`");
});

test("the task template has the prd line", () => {
  const text = readFileSync(join(KIT, ".github", "ISSUE_TEMPLATE", "factory-task.md"), "utf8");
  expect(text, "the template's PRD line shows the form the progress view reads").toContain("**PRD:** US-");
  expect(storyRefs(text.replace("US-<n>", "US-3"))).toEqual([3]);
});

// --- the owner queue, for=product ----------------------------------------------------------------------------------------

const QUEUE = issue(40, "Dev manager: needs the owner");

function ask(slug: string, tag = "", text = "this needs your yes: renumber the PRD stories?"): string {
  return `<!-- factory-owner-ask id=${slug}${tag ? " " + tag : ""} -->\n${text}`;
}

test("asks tagged for product are read by the dev manager side too", () => {
  // (factory_prs's side of this is in prs.test.ts, #252)
  const body = ask("renumber", "for=product");
  expect(ASK_RX.exec(body)?.[1]).toBe("renumber");
  expect(ASK_RX.exec("<!-- factory-owner-ask id=a -->x")?.[1]).toBe("a");
});

test("the work list has open product asks and the queue but not other asks or answered ones", () => {
  const db = { issues: [QUEUE], comments: { "40": [
    ask("renumber", "for=product"),
    ask("ci-queued", "", "CI is queued"),
    ask("freeze", "for=product", "this needs your yes: freeze phase 3?"),
    "Yes, freeze it.",
    ask("wording", "for=product", "this needs your yes: the warning heading"),
    "<!-- factory-owner-answer id=wording -->\nDone."] } };
  const [d, work, env] = poProject({ db });
  const p = factory(work, env, ["product-owner", "loop", "--once", "--dry-run"]);
  expect(p.code, p.out).toBe(0);
  const out = p.stdout;
  expect(out).toContain("[eleni] work: owner queue #40, ask renumber for product: this needs your yes: renumber the PRD stories?");
  expect(out).not.toContain("ask ci-queued");
  expect(out).not.toContain("ask freeze");
  expect(out).not.toContain("ask wording");
  expect(out).toContain('would run: claude -p "Follow the product-pass skill: read .claude/skills/product-pass/SKILL.md');
  expect(claudeCalls(env)).toEqual([]);
  expect(posted(d)).toEqual([]);
});

test("the dry run digest says where the role reads and what waits in the queue", () => {
  const db = { issues: [QUEUE, issue(41, "Sign-off and testing queue")], comments: { "41": [
    "<!-- factory-testplan id=checkout task=13 -->\n1. Open it.",
    "<!-- factory-testplan id=signup task=14 -->\n1. Sign up.",
    "<!-- factory-testplan-confirm id=signup by=boss -->",
    "<!-- factory-signoff id=arabic task=12 -->\nTo check: read it."] } };
  const [d, work, env] = poProject({ db });
  factory(work, env, ["init-roles"]);
  const out = factory(work, env, ["product-owner", "loop", "--once", "--dry-run"]).stdout;
  expect(out).toContain("[eleni] reads: .claude/factory/roles/product-owner/ (README.md, reads.md: ");
  expect(out).not.toContain("missing");
  expect(out).toContain("work: test plan checkout waits for the owner to confirm (queue #41)");
  expect(out).toContain("work: test plan signup is confirmed and not run yet (queue #41)");
  expect(out).toContain("work: 1 sign-off item waits for a person (queue #41)");
  expect(posted(d)).toEqual([]);
  expect(claudeCalls(env)).toEqual([]);
});

test("the default reads md lists the documents the project has", () => {
  const [, work, env] = poProject();
  factory(work, env, ["init-roles"]);
  const reads = readFileSync(join(work, ".claude", "factory", "roles", "product-owner", "reads.md"), "utf8");
  expect(reads).toContain("- docs/PRD.md - the PRD: user stories and decisions");
  expect(reads).toContain("- CLAUDE.md");
  expect(reads.split("\n").filter((l) => !l.startsWith("#")).join(""), "only documents that exist").not.toContain("design");
  expect(parseReads(reads).map(([p]) => p)).toEqual(["CLAUDE.md", "docs/PRD.md"]);
});

test("without a role folder the digest says how to add one", () => {
  const [, work, env] = poProject();
  const out = factory(work, env, ["product-owner", "loop", "--once", "--dry-run"]).stdout;
  expect(out).toContain("reads: no role folder at .claude/factory/roles/product-owner/");
  expect(out).toContain("factory init-roles");
});

// --- the skill and the dev manager's skill -------------------------------------------------------------------------------

test("the product pass skill exists and the dev manager skill sends product asks to it", () => {
  const skill = readFileSync(join(KIT, ".claude", "skills", "product-pass", "SKILL.md"), "utf8");
  expect(skill.startsWith("---\nname: product-pass\ndescription: ")).toBe(true);
  expect(skill).toContain("factory signoff confirm");
  expect(skill).toContain("never confirm on your own");
  expect(skill).toContain("for=product");
  const dm = readFileSync(join(KIT, ".claude", "skills", "manage-pass", "SKILL.md"), "utf8");
  expect(dm).toContain("<!-- factory-owner-ask id=<slug> for=product -->");
});

test("the product owner profile may run the prd and signoff commands", () => {
  const s = (JSON.parse(readFileSync(join(KIT, ".claude", "manager", "settings.json"), "utf8")) as { permissions: { allow: string[] } }).permissions.allow;
  for (const c of ["factory prd*", "factory signoff*", "./factory prd*", "./factory signoff*"]) expect(s, c).toContain(`Bash(${c})`);
});

// --- the watcher after the merge of main (it reads the old question markers through factory_wait) --------------------------

test("the watcher still sees an old style question on a pull request", () => {
  const pr = { number: 7, title: "x", draft: false, head: { sha: "a".repeat(40), ref: "task/5-x" }, user: { login: "me" }, labels: [] };
  const [, work, env] = poProject({ db: { pulls: [pr], issues: [{ ...issue(7, "x"), pull_request: {} }],
    comments: { "7": ["<!-- factory-question -->\nWhich colour?"] } } });
  const p = factory(work, env, ["watch", "--json"]);
  expect([0, 3], p.out).toContain(p.code);
  const kinds = (JSON.parse(p.stdout) as { kind: string; ref: string }[]).map((i) => [i.kind, i.ref]);
  expect(kinds).toContainEqual(["question", "question-7"]);
});

// --- the product owner's replies wait for the owner (#352) ---------------------------------------------------------------

const PO_REPLY = (slug: string, done = ""): string => `<!-- factory-po-reply ask=${slug}${done} -->\nI looked: here is my reply.`;

function workOf(comments: string[]): { out: string; code: number } {
  const [, work, env] = poProject({ db: { issues: [QUEUE], comments: { "40": comments } } });
  const p = factory(work, env, ["product-owner", "loop", "--once", "--dry-run"]);
  return { out: p.stdout, code: p.code };
}

test("an ask the product owner replied to waits for the owner and is not offered again (#352)", () => {
  const r = workOf([ask("a", "for=product"), PO_REPLY("a")]);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("ask a for product");
});

test("an owner answer after the po reply puts the ask back to the product owner, marked or not (#352)", () => {
  for (const answer of ["<!-- factory-owner-answer id=a -->\nUse the blue one.", "Use the blue one."]) {
    const r = workOf([ask("a", "for=product"), PO_REPLY("a"), answer]);
    expect(r.out, answer).toContain("ask a for product");
  }
});

test("an unmarked comment answers the newest ask or po reply before it (#352)", () => {
  // b was posted before the po reply to a, so the unmarked comment belongs to a's thread
  const r = workOf([ask("a", "for=product"), ask("b", "for=product", "this needs your yes: b?"), PO_REPLY("a"), "Fine, go on."]);
  expect(r.out).toContain("ask a for product");
  expect(r.out).toContain("ask b for product");
});

test("a po reply marked done closes the ask, and a later owner comment brings it back (#352)", () => {
  expect(workOf([ask("a", "for=product"), PO_REPLY("a", " done")]).out).not.toContain("ask a for product");
  expect(workOf([ask("a", "for=product"), PO_REPLY("a", " done"), "One more thing."]).out).toContain("ask a for product");
});

test("the product owner loop with only waiting asks exits at once with nothing to do (#352)", () => {
  const [, work, env] = poProject({ db: { issues: [QUEUE], comments: { "40": [
    ask("a", "for=product"), ask("b", "for=product", "this needs your yes: b?"), PO_REPLY("a"), PO_REPLY("b")] } } });
  const p = factory(work, env, ["product-owner", "loop", "3"]);
  expect(p.code, p.out).toBe(0);
  expect(p.out).toContain("Nothing to do");
  expect(p.out).not.toContain("came up 3 times");
  expect(claudeCalls(env)).toEqual([]);
});
