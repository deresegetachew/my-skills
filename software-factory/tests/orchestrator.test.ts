// The dev manager as an orchestrator (#97, #109): `factory dev-manager loop` reads GitHub with no model, runs the seven
// watcher checks, keeps thread notes, asks the owner for what only he can do, and starts one-item sub-managers.
//
// Runs the real hooks and loop script in a throwaway project with a fake `claude` (logs its prompt and flags) and a
// stateful fake `gh` (a JSON file that POST and PATCH change, so claims, notes and owner asks can be read back).
// The lease tests are in lease.test.ts; the doctor's check of the manager profile stays in test_orchestrator.py until
// factory_doctor is ported (#252).
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT, readmeAndWiki, writeExe } from "./support.ts";
import { type Env, factory, log, project, type Row } from "./roles_support.ts";
import { agentIssue, badRun, comment, cycle, dbOf, GH, H, H2, hook, iso, okRun, posted, postedC, pr, prompts, put, runSub,
  SF, skipComments, UNREVIEWED, watch, world, writes } from "./orchestrator_support.ts";

// --- the seven checks ------------------------------------------------------------------------------------------------

test("check 1 an unreviewed head is a manager item once the agent has stopped pushing", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5)], commits: { [H]: iso(60) } } });
  const got = watch(work, env);
  expect(got["pr-5"]?.to).toBe("manager");
  expect(got["pr-5"]?.kind).toBe("review");
  expect(got["pr-5"]?.line).toContain("not reviewed");
  put(d, { commits: { [H]: iso(1) } }); // pushed a minute ago: the agent may still be pushing
  expect("pr-5" in watch(work, env)).toBe(false);
});

test("check 1 clears when a verdict names the head and returns on a new head", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5)], commits: { [H]: iso(60), [H2]: iso(30) }, checks: { [H]: [okRun()] },
    comments: { "5": [comment(1, `<!-- factory-approved sha=${H.slice(0, 12)} -->`, 50)] } } });
  const first = watch(work, env);
  expect(!("pr-5" in first) || first["pr-5"]?.kind !== "review").toBe(true);
  put(d, { pulls: [pr(5, { sha: H2 })] });
  expect(watch(work, env)["pr-5"]?.kind).toBe("review");
});

test("a draft pull request is not waiting for review", () => {
  const [, work, env] = world({ db: { pulls: [pr(5, { draft: true })], commits: { [H]: iso(60) } } });
  expect(watch(work, env)).toEqual({});
});

test("check 2 an open question is a manager item until it is answered", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5)], commits: { [H]: iso(60) }, checks: { [H]: [okRun()] },
    comments: { "5": [comment(1, `<!-- pr-watch sha=${H} -->`, 59), comment(2, "<!-- factory-question -->\nWhich colour?", 20)] } } });
  const got = watch(work, env);
  expect(got["question-5"]?.kind).toBe("question");
  expect(got["question-5"]?.to).toBe("manager");
  put(d, { comments: { "5": [comment(1, `<!-- pr-watch sha=${H} -->`, 59), comment(2, "<!-- factory-question -->\nWhich colour?", 20),
    comment(3, "<!-- factory-answer -->\nBlue.", 5)] } });
  expect("question-5" in watch(work, env)).toBe(false);
});

test("two open questions on one pull request are one manager item, not the same ref twice", () => {
  const [, work, env] = world({ db: { pulls: [pr(5)], commits: { [H]: iso(60) }, checks: { [H]: [okRun()] },
    comments: { "5": [comment(1, `<!-- pr-watch sha=${H} -->`, 59), comment(2, "<!-- factory-question -->\nWhich colour?", 20),
      comment(3, "<!-- factory-question -->\nWhich font?", 15)] } } });
  const p = hook(work, env, "factory_watch.ts", "--json");
  const refs = (JSON.parse(p.stdout) as Row[]).map((i) => i.ref as string);
  expect(refs.filter((r) => r === "question-5"), refs.join(", ")).toEqual(["question-5"]);
  expect(watch(work, env)["question-5"]?.line).toContain("2 questions wait");
});

test("check 2 also reads the message envelope addressed to the dev manager", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5)], commits: { [H]: iso(60) },
    comments: { "5": [comment(1, `<!-- pr-watch sha=${H} -->`, 59),
      comment(2, "<!-- factory-msg v=1 id=q1abc kind=question from=menelik to=dev-manager state=submitted -->\nWhy?", 20)] } } });
  expect("question-5" in watch(work, env)).toBe(true);
  put(d, { comments: { "5": [comment(1, `<!-- pr-watch sha=${H} -->`, 59),
    comment(2, "<!-- factory-msg v=1 id=q1abc kind=question from=menelik to=po state=submitted -->\nWhy?", 20)] } });
  expect("question-5" in watch(work, env)).toBe(false);
});

test("check 3 must fix failed ci and a conflict each wait for staleMinutes then fire", () => {
  const marker = { "5": [comment(1, `<!-- factory-mustfix sha=${H} -->`, 40)] };
  const [d, work, env] = world({ db: { pulls: [pr(5)], commits: { [H]: iso(60) }, checks: { [H]: [okRun()] }, comments: marker } });
  expect(watch(work, env)["pr-5"]?.line).toContain("must-fix");
  put(d, { comments: { "5": [comment(1, `<!-- factory-mustfix sha=${H} -->`, 3)] } });
  expect("pr-5" in watch(work, env), "a must-fix younger than staleMinutes is still the agent's to fix").toBe(false);
  put(d, { comments: { "5": [comment(1, `<!-- factory-approved sha=${H} -->`, 40)] }, checks: { [H]: [badRun("lint")] } });
  const line = watch(work, env)["pr-5"]?.line as string;
  expect(line).toContain("CI failed");
  expect(line).toContain("lint");
  put(d, { checks: { [H]: [okRun()] }, pulls: [pr(5, { mergeable_state: "dirty" })] });
  expect(watch(work, env)["pr-5"]?.line).toContain("merge conflict");
});

test("check 4 approved and green is a merge item but the manager's own pr goes to the owner", () => {
  const ok = { commits: { [H]: iso(60) }, checks: { [H]: [okRun()] }, comments: { "5": [comment(1, `<!-- factory-approved sha=${H} -->`, 30)] } };
  const [d, work, env] = world({ db: { pulls: [pr(5)], ...ok } });
  let got = watch(work, env);
  expect(got["pr-5"]?.kind).toBe("merge");
  expect(got["pr-5"]?.to).toBe("manager");
  put(d, { pulls: [pr(5, { ref: "manager/fix-thing" })] });
  got = watch(work, env);
  expect(got["own-5"]?.to).toBe("owner");
  expect("pr-5" in got).toBe(false);
  put(d, { pulls: [pr(5, { body: "<!-- factory-role role=dev-manager name=lead -->" })] });
  expect("own-5" in watch(work, env)).toBe(true);
  put(d, { checks: { [H]: [okRun(), { id: 3, name: "e2e", status: "in_progress", conclusion: null }] }, pulls: [pr(5)] });
  expect("pr-5" in watch(work, env), "CI still running is not green").toBe(false);
});

test("check 5 a pull request that waited long for the product owner goes to the owner", () => {
  const cfg = { roles: { "product-owner": { workLabel: "factory:needs-product" } } };
  const [d, work, env] = world({ cfg, db: { pulls: [pr(5, { draft: true, labels: ["factory:needs-product"] })], commits: { [H]: iso(600) },
    events: { "5": [{ event: "labeled", created_at: iso(300), label: { name: "factory:needs-product" } }] } } });
  const got = watch(work, env);
  const key = Object.keys(got).find((k) => k.startsWith("wait-5")) as string;
  expect(got[key]?.to).toBe("owner");
  expect(got[key]?.line).toContain("product owner");
  put(d, { events: { "5": [{ event: "labeled", created_at: iso(10), label: { name: "factory:needs-product" } }] } });
  expect(Object.keys(watch(work, env)).filter((k) => k.startsWith("wait-")), "ownerWaitMinutes has not passed yet").toEqual([]);
});

test("check 6 a down agent and an idle agent with ready work go to the owner", () => {
  const ready = { number: 40, state: "open", title: "Ready task", body: "", labels: [{ name: "factory:ready" }] };
  const [d, work, env] = world({ db: { issues: [agentIssue(11, "menelik", "down", 500), agentIssue(12, "taytu", "idle", 2, "coding-agent", 120), ready] } });
  const got = watch(work, env);
  const down = Object.entries(got).find(([k]) => k.startsWith("agent-down-menelik"))?.[1] as Row;
  const idle = Object.entries(got).find(([k]) => k.startsWith("agent-idle-taytu"))?.[1] as Row;
  expect(down.to).toBe("owner");
  expect(idle.to).toBe("owner");
  expect(idle.line).toContain("1 task(s) are ready");
  put(d, { issues: [agentIssue(12, "taytu", "idle", 2, "coding-agent", 120)] });
  expect(Object.keys(watch(work, env)).filter((k) => k.startsWith("agent-idle")), "an idle agent with nothing ready is fine").toEqual([]);
});

test("check 6 a silent coding agent is a manager item but a sleeping manager is not", () => {
  const [, work, env] = world({ db: { issues: [agentIssue(11, "menelik", "working", 400), agentIssue(13, "lead", "idle", 400, "dev-manager")] } });
  const got = watch(work, env);
  expect(got["agent-menelik"]?.to).toBe("manager");
  expect("agent-lead" in got).toBe(false);
});

test("check 7 queued ci goes to the owner and a fresh queue does not", () => {
  const [d, work, env] = world({ db: { actions_runs: [{ name: "ci", created_at: iso(30) }], runners: [] } });
  const got = watch(work, env);
  expect(got["ci-queue"]?.to).toBe("owner");
  expect(got["ci-queue"]?.line).toContain("queued");
  expect(got["ci-queue"]?.line).toContain("no self-hosted runner");
  put(d, { actions_runs: [{ name: "ci", created_at: iso(2) }] });
  expect("ci-queue" in watch(work, env)).toBe(false);
});

test("a check that cannot be read does not stop the others", () => {
  const [, work, env] = world({ db: UNREVIEWED });
  // the fake has a route for actions/runs; make the CI-judge read fail by not having check-runs for an unknown sha
  expect("pr-5" in watch(work, env)).toBe(true);
});

// --- the cycle: sub-managers ------------------------------------------------------------------------------------------

function orderOf(work: string, env: Env): string[] {
  const p = hook(work, env, "factory_watch.ts", "--json");
  return (JSON.parse(p.stdout) as Row[]).map((i) => i.ref as string);
}

test("a task pr with green ci comes before older docs prs", () => {
  // #201: docs PRs #5 and #15 came first, so task PR #23 waited: "waiting for a free place".
  const H3 = "c".repeat(40);
  const [, work, env] = world({ db: {
    pulls: [pr(5, { sha: H, ref: "docs/readme" }), pr(15, { sha: H2, ref: "docs/guide" }), pr(23, { sha: H3, ref: "task/2-thing" })],
    commits: { [H]: iso(70), [H2]: iso(60), [H3]: iso(40) }, checks: { [H]: [okRun()], [H2]: [okRun()], [H3]: [okRun()] } } });
  expect(orderOf(work, env)).toEqual(["pr-23", "pr-5", "pr-15"]);
});

test("a task pr with red ci does not jump the queue", () => {
  const H3 = "c".repeat(40);
  const [, work, env] = world({ db: { pulls: [pr(5, { sha: H, ref: "docs/readme" }), pr(23, { sha: H3, ref: "task/2-thing" })],
    commits: { [H]: iso(120), [H3]: iso(40) }, checks: { [H]: [okRun()], [H3]: [badRun()] } } });
  expect(orderOf(work, env)).toEqual(["pr-5", "pr-23"]);
});

test("a docs pr that waited four times deadManMinutes is not starved by task prs", () => {
  const H3 = "c".repeat(40);
  const [, work, env] = world({ db: { pulls: [pr(5, { sha: H, ref: "docs/readme" }), pr(23, { sha: H3, ref: "task/2-thing" })],
    commits: { [H]: iso(300), [H3]: iso(40) }, checks: { [H]: [okRun()], [H3]: [okRun()] } } });
  expect(orderOf(work, env)).toEqual(["pr-5", "pr-23"]);
});

test("a cycle starts one sub manager per item with the profile the item and the role marker", () => {
  const [, work, env] = world({ db: UNREVIEWED });
  const p = cycle(work, env, "--wait");
  expect(p.code, p.out).toBe(0);
  const calls = prompts(env);
  expect(calls.length, calls.join("\n")).toBe(1);
  const line = calls[0] as string;
  // --setting-sources user drops the project skills, so the prompt names the skill file, not a /manage-pass command
  expect(line).toContain("--setting-sources user");
  expect(line).not.toContain("-p /manage-pass");
  expect(line).toContain("-p Follow the manage-pass skill for pr-5: read .claude/skills/manage-pass/SKILL.md");
  expect(line).toContain("/manage-pass pr-5");
  expect(line).toContain("disableClaudeAiConnectors");
  expect(line).toContain("manager_gate.ts");
  expect(line).toContain("--strict-mcp-config");
  expect(line).toContain("<!-- factory-role role=dev-manager name=lead -->");
  expect(line).toContain("PR #5: commit aaaaaaa not reviewed yet");
  expect(line).toContain("Thread note");
  expect(line).toContain("Your lease:");
  expect(line).toContain("manager=lead");
});

test("the sub manager holds a lease while it runs and releases it when it exits", () => {
  const [d, work, env] = world({ db: UNREVIEWED });
  const h = join(d, "hook.sh");
  writeFileSync(h, `cp "$FAKE_DB" "${d}/db-during.json"\nexit 0\n`);
  env.FAKE_CLAUDE_HOOK = h;
  expect(cycle(work, env, "--wait").code).toBe(0);
  const during = JSON.parse(readFileSync(join(d, "db-during.json"), "utf8")) as { comments: Record<string, Row[]> };
  const live = (during.comments["5"] ?? []).map((c) => c.body as string).filter((b) => b.includes("-claim manager=lead sha="));
  expect(live.length, live.join("\n")).toBe(1);
  expect(live[0]).toContain("until=");
  const after = postedC(d, 5).map((c) => c.body as string).filter((b) => b.includes("-claim manager=lead"));
  const until = (/until=(\S+)/.exec(after[after.length - 1] as string) as RegExpExecArray)[1] as string;
  expect(until < iso(0), "the lease must have been ended on exit: " + after[after.length - 1]).toBe(true);
  const dir = join(work, ".git", "factory-manager", "lead.d");
  expect(!readdirSync(dir).length || readdirSync(dir).every((f) => !f.endsWith(".pid"))).toBe(true);
});

test("the cap is maxSubManagers and the rest wait for the next cycle", () => {
  const [, work, env] = world({ db: { pulls: [pr(1, { sha: "1".repeat(40) }), pr(2, { sha: "2".repeat(40) }), pr(3, { sha: "3".repeat(40) })],
    commits: { ["1".repeat(40)]: iso(60), ["2".repeat(40)]: iso(50), ["3".repeat(40)]: iso(40) } } });
  const p = cycle(work, env, "--wait");
  expect(p.code, p.out).toBe(0);
  expect(prompts(env).length, prompts(env).join("\n")).toBe(2);
  expect(p.stdout).toContain("waiting for a free place");
  expect(p.stdout).toContain("pr-3");
  expect(prompts(env).some((l) => l.includes(" -p ") && l.includes("/manage-pass pr-1"))).toBe(true);
});

test("the cap can be set to one", () => {
  const [, work, env] = world({ cfg: { manager: { maxSubManagers: 1 } },
    db: { pulls: [pr(1, { sha: "1".repeat(40) }), pr(2, { sha: "2".repeat(40) })], commits: { ["1".repeat(40)]: iso(60), ["2".repeat(40)]: iso(50) } } });
  cycle(work, env, "--wait");
  expect(prompts(env).length, prompts(env).join("\n")).toBe(1);
});

test("an item another manager holds is left alone and counts against the cap", () => {
  const claim = `<!-- factory-review-claim manager=other sha=${H} until=${iso(-15)} -->`;
  const [, work, env] = world({ db: { ...UNREVIEWED, comments: { "5": [comment(1, claim, 2)] } } });
  const p = cycle(work, env, "--wait");
  expect(prompts(env)).toEqual([]);
  expect(p.stdout).toContain("other holds the lease");
  // the item is still work: the cycle reports it
  expect(p.code).toBe(0);
});

test("an expired claim does not block the item", () => {
  const claim = `<!-- factory-review-claim manager=other sha=${H} until=${iso(3)} -->`;
  const [, work, env] = world({ db: { ...UNREVIEWED, comments: { "5": [comment(1, claim, 30)] } } });
  cycle(work, env, "--wait");
  expect(prompts(env).length, prompts(env).join("\n")).toBe(1);
});

test("two orchestrators do not start the same item twice", () => {
  const [d, work, env] = world({ db: UNREVIEWED });
  const h = join(d, "hook.sh");
  // while the first sub-manager runs, a second orchestrator (another name) cycles
  writeFileSync(h, `cd "${work}" && bun --no-env-file .claude/hooks/factory_orchestrator.ts cycle --name second --wait ` +
    `> "${d}/second.out" 2>&1\nexit 0\n`);
  env.FAKE_CLAUDE_HOOK = h;
  expect(cycle(work, env, "--wait").code).toBe(0);
  expect(prompts(env).length, prompts(env).join("\n")).toBe(1);
  expect(readFileSync(join(d, "second.out"), "utf8")).toContain("lead holds the lease");
});

test("a pass that finds the item gone starts nothing", () => {
  const [d, work, env] = world({ db: UNREVIEWED });
  put(d, { comments: { "5": [comment(1, `<!-- factory-approved sha=${H} -->`, 1)] }, checks: { [H]: [badRun()] } });
  const p = runSub(work, env, "pr-99");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("nothing needs a manager any more");
  expect(prompts(env)).toEqual([]);
});

test("a sub manager that leaves a conflicting pr without a verdict gets one comment with the reason and next step", () => {
  // #195: PR took a review claim, released it, wrote a note: nothing a person could read on the PR.
  const [d, work, env] = world({ db: { pulls: [pr(5, { mergeable_state: "dirty" })], commits: { [H]: iso(60) } } });
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(0);
  const skips = skipComments(d, 5);
  expect(skips.length, posted(d, 5).join("\n---\n")).toBe(1);
  const text = skips[0] as string;
  expect(text).toContain(`sha=${H}`);
  expect(text).toContain("did not review");
  expect(text).toContain("merge conflict");
  expect(text).toContain("Next step");
  expect(text.toLowerCase()).toContain("merge main");
});

test("the skip comment is not repeated for the same head", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5, { mergeable_state: "dirty" })], commits: { [H]: iso(60) } } });
  runSub(work, env);
  runSub(work, env);
  expect(skipComments(d, 5).length, posted(d, 5).join("\n---\n")).toBe(1);
});

test("no skip comment when the sub manager posted its own verdict", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5, { mergeable_state: "dirty" })], commits: { [H]: iso(60) } } });
  const h = join(d, "hook.sh");
  writeFileSync(h, `bun --no-env-file -e 'const fs = require("node:fs"); const f = process.env.FAKE_DB; ` +
    `const db = JSON.parse(fs.readFileSync(f, "utf8")); (db.comments["5"] ??= []).push({ id: 7001, body: "Must-fix: conflict.", ` +
    `created_at: "2026-10-26T10:00:00Z" }); fs.writeFileSync(f, JSON.stringify(db));'\n`);
  env.FAKE_CLAUDE_HOOK = h;
  runSub(work, env);
  expect(skipComments(d, 5), posted(d, 5).join("\n---\n")).toEqual([]);
});

test("a red ci skip names the failed jobs", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5)], commits: { [H]: iso(60) }, checks: { [H]: [badRun("tests")] } } });
  runSub(work, env);
  const text = skipComments(d, 5)[0] ?? "";
  expect(text, posted(d, 5).join("\n---\n")).toContain("CI");
  expect(text).toContain("tests");
  expect(text).toContain("factory ci log");
});

test("a failed sub manager leaves the pid file removed and the lease released", () => {
  const [d, work, env] = world({ db: UNREVIEWED });
  const h = join(d, "hook.sh");
  writeFileSync(h, "exit 1\n");
  env.FAKE_CLAUDE_HOOK = h;
  const p = runSub(work, env);
  expect(p.code, p.out).toBe(1);
  expect(p.stdout).toContain("exit 1");
  expect(postedC(d, 5).some((c) => (c.body as string).includes("-claim manager=lead"))).toBe(true);
  expect(readdirSync(join(work, ".git", "factory-manager", "lead.d")).filter((f) => f.endsWith(".pid"))).toEqual([]);
});

test("the orchestrator never starts a builder", () => {
  const [, work, env] = world({ db: { ...UNREVIEWED, issues: [{ number: 40, state: "open", title: "Ready", body: "",
    labels: [{ name: "factory:ready" }] }] } });
  cycle(work, env, "--wait");
  expect(prompts(env).every((l) => !l.includes("/next-task"))).toBe(true);
});

// --- thread notes ------------------------------------------------------------------------------------------------------

test("a note opens on an issue that went in progress without a model and only once", () => {
  const task = { number: 20, state: "open", title: "Task", body: "", labels: [{ name: "factory:in-progress" }] };
  const [d, work, env] = world({ db: { issues: [task] } });
  const p = cycle(work, env);
  expect(p.code, p.out).toBe(0);
  const notes = posted(d, 20).filter((b) => b.includes("factory-manager-note thread=issue-20 status=open"));
  expect(notes.length).toBe(1);
  expect(prompts(env)).toEqual([]);
  cycle(work, env);
  expect(posted(d, 20).filter((b) => b.includes("factory-manager-note")).length).toBe(1);
});

test("a note is marked closed when its issue closes", () => {
  const note = "<!-- factory-manager-note thread=issue-20 status=open -->\nNote.\n- opened";
  const task = { number: 20, state: "closed", title: "Task", body: "", labels: [{ name: "factory:in-review" }] };
  const [d, work, env] = world({ db: { issues: [task], comments: { "20": [comment(7, note, 100)] } } });
  cycle(work, env);
  const body = posted(d, 20)[0] as string;
  expect(body).toContain("status=closed");
  expect(body).not.toContain("status=open");
  expect(body).toContain("issue was closed");
  cycle(work, env);
  expect((posted(d, 20)[0] as string).split("issue was closed").length - 1, "closing twice would append twice").toBe(1);
});

test("the sub manager gets the existing note and its comment id", () => {
  const note = "<!-- factory-manager-note thread=pr-5 status=open -->\nThe agent chose blue; do not ask again.";
  const [, work, env] = world({ db: { ...UNREVIEWED, comments: { "5": [comment(77, note, 100)] } } });
  cycle(work, env, "--wait");
  const line = prompts(env)[0] as string;
  expect(line).toContain("The agent chose blue; do not ask again.");
  expect(line).toContain("comment 77");
});

// --- the owner queue -------------------------------------------------------------------------------------------------

const QUEUE = "Dev manager: needs the owner";

function ownerComments(d: string): [number, string[]] {
  const q = (dbOf(d).issues as Row[]).find((i) => i.title === QUEUE) as Row;
  return [q.number as number, posted(d, q.number as number)];
}

function queues(d: string): Row[] {
  return (dbOf(d).issues as Row[]).filter((i) => i.title === QUEUE);
}

test("an owner item is posted once to the queue and mentions the repo owner by default", () => {
  const [d, work, env] = world({ db: { actions_runs: [{ name: "ci", created_at: iso(30) }] } });
  const p = cycle(work, env);
  expect(p.code, p.out).toBe(0);
  const [, bodies] = ownerComments(d);
  expect(bodies.length).toBe(1);
  expect(bodies[0]).toContain("<!-- factory-owner-ask id=ci-queue -->");
  expect(bodies[0]).toContain("@boss ");
  cycle(work, env);
  cycle(work, env);
  expect(ownerComments(d)[1].length, "the same ask must not be posted again").toBe(1);
  expect(queues(d).length, "one queue issue, not one per cycle").toBe(1);
});

test("manager notify chooses who is mentioned and an org owner means nobody is", () => {
  let [d, work, env] = world({ cfg: { manager: { notify: "@dere" } }, db: { actions_runs: [{ name: "ci", created_at: iso(30) }] } });
  cycle(work, env);
  expect(ownerComments(d)[1][0]).toContain("@dere ");
  expect(ownerComments(d)[1][0]).not.toContain("@@");
  [d, work, env] = world({ db: { actions_runs: [{ name: "ci", created_at: iso(30) }], repo: { owner: { login: "acme", type: "Organization" } } } });
  cycle(work, env);
  expect(ownerComments(d)[1][0]).not.toContain("@acme");
});

test("a changed situation is a new ask and a solved one is not repeated", () => {
  const [d, work, env] = world({ db: { issues: [agentIssue(11, "menelik", "down", 500)] } });
  cycle(work, env);
  expect(ownerComments(d)[1].length).toBe(1);
  cycle(work, env);
  expect(ownerComments(d)[1].length).toBe(1);
});

test("dry run prints the plan and writes nothing", () => {
  const [, work, env] = world({ db: { ...UNREVIEWED, actions_runs: [{ name: "ci", created_at: iso(30) }],
    issues: [{ number: 20, state: "open", title: "T", body: "", labels: [{ name: "factory:in-progress" }] }] } });
  const p = cycle(work, env, "--dry-run");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("would start a sub-manager for pr-5");
  expect(p.stdout).toContain('would run: claude -p "/manage-pass pr-5"');
  expect(p.stdout).toContain("would post to the owner queue (id ci-queue)");
  expect(p.stdout).toContain("would open the thread note on issue #20");
  expect(writes(env)).toEqual([]);
  expect(prompts(env)).toEqual([]);
  expect(existsSync(join(work, ".git", "factory-manager", "lead.log")), "a dry run writes no log").toBe(false);
});

test("nothing to do exits 3 and says so", () => {
  const [, work, env] = world();
  const p = cycle(work, env);
  expect(p.code, p.out).toBe(3);
  expect(p.stdout).toContain("nothing to do");
  expect(writes(env)).toEqual([]);
});

// --- the dead-man's switch -------------------------------------------------------------------------------------------

test("dead man's switch reports work that waited with no manager activity", () => {
  const [d, work, env] = world({ db: { pulls: [pr(5)], commits: { [H]: iso(120) } } });
  cycle(work, env, "--wait");
  const bodies = ownerComments(d)[1];
  const dead = bodies.filter((b) => b.includes("factory-owner-ask id=dead-man-"));
  expect(dead.length, bodies.join("\n---\n")).toBe(1);
  expect(dead[0]).toContain("pr-5");
  expect(dead[0]).toContain("@boss");
  cycle(work, env, "--wait");
  expect(ownerComments(d)[1].filter((b) => b.includes("id=dead-man-")).length, "the same stuck set is reported once").toBe(1);
});

test("dead man's switch stays quiet when a manager acted recently", () => {
  const other = { pulls: [pr(5), pr(6, { sha: H2 })], commits: { [H]: iso(120), [H2]: iso(120) },
    comments: { "6": [comment(1, `<!-- factory-approved sha=${H2} -->`, 5)] }, checks: { [H2]: [badRun()] } };
  const [d, work, env] = world({ db: other });
  cycle(work, env, "--wait");
  expect(queues(d), "a verdict five minutes ago means a manager is alive").toEqual([]);
});

test("dead man's switch does not count a claim as activity", () => {
  const claim = `<!-- factory-review-claim manager=other sha=${H} until=${iso(-10)} -->`;
  const [d, work, env] = world({ db: { pulls: [pr(5), pr(6, { sha: H2 })], commits: { [H]: iso(120), [H2]: iso(120) },
    comments: { "6": [comment(1, claim, 2)] } } });
  cycle(work, env, "--wait");
  expect(ownerComments(d)[1].some((b) => b.includes("id=dead-man-")), "taking a lease is not progress").toBe(true);
});

test("dead man's switch counts a merge as activity", () => {
  const merged = pr(9, { state: "closed" });
  merged.merged_at = iso(4);
  const [d, work, env] = world({ db: { pulls: [pr(5), merged], commits: { [H]: iso(120) } } });
  cycle(work, env, "--wait");
  expect(queues(d)).toEqual([]);
});

// --- the loop: --once, -i, failures ------------------------------------------------------------------------------------

function loop(work: string, env: Env, ...args: string[]) {
  return factory(work, env, ["dev-manager", "lead", "loop", ...args]);
}

function projectForLoop(db: Row = {}, cfg: Row = {}): [string, string, Env] {
  const [d, work, env] = project({ cfg: { tasks: { source: "issues" }, ...cfg }, db: { pulls: [], issues: [], comments: {}, ...db } });
  writeExe(join(d, "bin", "gh"), GH);
  writeFileSync(join(d, "db.json"), JSON.stringify({ pulls: [], issues: [], comments: {}, events: {}, commits: {}, checks: {}, ...db }));
  return [d, work, env];
}

test("loop once runs one cycle and exits without a model for the orchestrator itself", async () => {
  const [, work, env] = projectForLoop({ pulls: [pr(5)], commits: { [H]: iso(60) } });
  const p = loop(work, env, "--once");
  expect(p.code, p.out).toBe(0);
  for (let i = 0; i < 50 && !prompts(env).length; i++) await Bun.sleep(200);
  expect(prompts(env).length, p.stdout).toBe(1);
  expect(prompts(env)[0]).toContain(" -p ");
  expect(prompts(env)[0]).toContain("/manage-pass pr-5");
  expect(p.stdout).toContain("[lead]");
  expect(prompts(env).some((l) => l.includes("/manage-pass") && !l.includes(" -p "))).toBe(false);
}, 120_000);

test("loop once with nothing to do exits 0 and starts nothing", () => {
  const [, work, env] = projectForLoop();
  const p = loop(work, env, "--once");
  expect(p.code, p.out).toBe(0);
  expect(prompts(env)).toEqual([]);
});

test("loop dry run is the orchestrator's dry run", () => {
  const [, work, env] = projectForLoop({ pulls: [pr(5)], commits: { [H]: iso(60) } });
  const p = loop(work, env, "--once", "--dry-run");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("would start a sub-manager for pr-5");
  expect(prompts(env)).toEqual([]);
  expect(writes(env)).toEqual([]);
});

test("loop interactive runs the first item in a session you can type into", () => {
  const [, work, env] = projectForLoop({ pulls: [pr(5), pr(6, { sha: H2 })], commits: { [H]: iso(60), [H2]: iso(50) } });
  env.FACTORY_REMOTE_CONTROL = "1";
  const p = loop(work, env, "-i", "--once");
  expect(p.code, p.out).toBe(0);
  const calls = prompts(env);
  expect(calls.length, calls.join("\n")).toBe(1);
  expect(calls[0]).not.toContain(" -p ");
  expect(calls[0]).toContain("--remote-control=lead pr-5");
  expect(calls[0]).toContain("/manage-pass pr-5");
  expect(calls[0]).toContain("--setting-sources user");
  expect(calls[0]).toContain(".claude/skills/manage-pass/SKILL.md"); // a typed /manage-pass is unknown without project skills
});

test("three failed cycles in a row stop the loop", () => {
  const [d, work, env] = projectForLoop();
  writeExe(join(d, "bin", "gh"), "#!/usr/bin/env bash\necho boom >&2\nexit 1\n"); // every gh call now fails
  const p = loop(work, env);
  expect(p.code, p.out).toBe(1);
  expect(p.stdout).toContain("3 passes failed in a row");
});

test("the orchestrator registers as a live agent while it loops", () => {
  const [, work, env] = projectForLoop();
  loop(work, env, "--once");
  const pings = log(env).filter((l) => l.startsWith("gh") && l.includes("issues"));
  expect(pings.length, "the loop registers the dev manager as an agent (idle pings keep it from being marked down)").toBeGreaterThan(0);
});

// --- settings, CLI, docs, forwarders ---------------------------------------------------------------------------------

test("settings list the orchestrator settings with their defaults", () => {
  const [, work, env] = world();
  const p = factory(work, env, ["settings", "list"]);
  for (const key of ["manager.maxSubManagers", "manager.claimMinutes", "manager.deadManMinutes", "manager.notify",
    "manager.quietMinutes", "manager.staleMinutes", "manager.ownerWaitMinutes", "manager.agentIdleMinutes",
    "manager.ciQueuedMinutes", "manager.subManagerMinutes"]) {
    expect(p.stdout, key).toContain(key);
  }
  const cfg = JSON.parse(readFileSync(join(work, ".claude", "factory.json"), "utf8")) as { manager?: Row };
  expect("maxSubManagers" in (cfg.manager ?? {}), "defaults are not written into the project's file").toBe(false);
});

test("factory watch prints one line per item and exits 3", () => {
  let [, work, env] = world({ db: UNREVIEWED });
  let p = factory(work, env, ["watch"]);
  expect(p.code, p.out).toBe(3);
  expect(p.stdout).toContain("pr-5");
  expect(p.stdout).toContain("manager");
  [, work, env] = world();
  p = factory(work, env, ["watch"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("nothing to do");
});

test("the new hooks are bun scripts with no forwarder and the profile allows factory watch", () => {
  // #252: a Bun script gets no forwarder in kit/.claude/hooks (projects link hooks/ directly)
  for (const f of ["factory_watch", "factory_orchestrator"]) {
    expect(existsSync(join(SF, "hooks", `${f}.ts`)), f).toBe(true);
    for (const ext of [".py", ".ts"]) {
      const link = join(KIT, ".claude", "hooks", f + ext);
      let there = false;
      try {
        there = lstatSync(link).isSymbolicLink() || true;
      } catch {
        there = false;
      }
      expect(there, link).toBe(false);
    }
  }
  const allow = (JSON.parse(readFileSync(join(KIT, ".claude", "manager", "settings.json"), "utf8")) as { permissions: { allow: string[] } }).permissions.allow;
  expect(allow).toContain("Bash(factory watch*)");
});

test("the orchestrator is listed in the loop script's header and the readme", () => {
  const readme = readmeAndWiki();
  expect(readme).toContain("Run a manager");
  expect(readme).toContain("factory dev-manager");
  expect(readme.toLowerCase()).toContain("dead-man");
  expect(readFileSync(join(KIT, ".claude", "skills", "manage-pass", "SKILL.md"), "utf8")).toContain("manage-pass");
});


test("doctor checks the manager profile and its hooks", () => {
  const [, work, env] = world({ files: { ".claude/manager/settings.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [
    { type: "command", command: 'bun --no-env-file "$CLAUDE_PROJECT_DIR"/.claude/hooks/not_there.ts' }] }] } }) } });
  const p = hook(work, env, "factory_doctor.ts");
  expect(p.stdout).toContain("not_there.ts");
  expect(p.stdout).toContain("fix");
});
