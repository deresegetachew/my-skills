// Tests for issues mode, against a fake `gh` that keeps issues in a JSON file (factory_issues.ts, factory_agents.ts,
// next_task.ts).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { agentIssue, agents, countAgentIssues, HOOKS, inProject, issue, labels, loadDb, nextTask, pull, run, saveDb,
  setup, snapshot } from "./issues_support.ts";
import { runHook, write } from "./support.ts";

test("pick claims in milestone order and skips dependencies", () => {
  const [d, db, env] = setup([issue(1, undefined, "", 2), issue(2, undefined, "Depends on #3", 1), issue(3, undefined, "", 1)]);
  const [rc, out] = run(d, env, "pick", "--agent", "menelik");
  expect([rc, out]).toEqual([0, "issue-3 Task 3"]);
  expect(labels(db, 3)).toEqual(["agent:menelik", "factory:in-progress"]);
});

test("a task that depends on an open pull request waits", () => {
  const [d, db, env] = setup([issue(1, undefined, "Depends on #5"), issue(2), pull(5)]);
  expect(run(d, env, "peek")[1].startsWith("issue-2 ")).toBe(true);
  const [rc, out] = run(d, env, "pick", "--agent", "menelik");
  expect([rc, out]).toEqual([0, "issue-2 Task 2"]);
  expect(labels(db, 1)).toEqual(["factory:ready"]);
});

test("a task whose pull request dependency closed is handed out", () => {
  const [d, , env] = setup([issue(1, undefined, "Depends on #5 and #6"), pull(5, "closed"), { ...issue(6), state: "closed" }]);
  expect(run(d, env, "pick", "--agent", "menelik")).toEqual([0, "issue-1 Task 1"]);
});

test("a dependency that doesnt exist doesnt hold the task back", () => {
  const [d, , env] = setup([issue(1, undefined, "Depends on #99")]);
  expect(run(d, env, "pick", "--agent", "menelik")).toEqual([0, "issue-1 Task 1"]);
});

test("agent resumes its own issue first", () => {
  const [d, , env] = setup([issue(1), issue(2, ["factory:in-progress", "agent:taytu"])]);
  expect(run(d, env, "pick", "--agent", "taytu")[1]).toBe("issue-2 Task 2");
  expect(run(d, env, "pick", "--agent", "menelik")[1]).toBe("issue-1 Task 1");
});

test("earlier claim wins", () => {
  const [d, db, env] = setup([issue(1), issue(2)]);
  const state = loadDb(db);
  state.comments = { 1: [{ body: "<!-- factory-claim agent=taytu -->", at: 0 }] }; // taytu claimed first
  saveDb(db, state);
  const [, out] = run(d, env, "pick", "--agent", "menelik");
  expect(out).toBe("issue-2 Task 2"); // lost #1, so took #2
  expect(labels(db, 1)).toEqual(["factory:in-progress"]); // menelik's label came off again
});

test("tick block release review", () => {
  const [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:menelik"], "- [ ] a\n- [ ] b")]);
  run(d, env, "tick", "1", "2");
  expect(loadDb(db).issues[0]?.body).toBe("- [ ] a\n- [x] b");
  run(d, env, "review", "1");
  expect(labels(db, 1)).toEqual(["agent:menelik", "factory:in-review"]);
  run(d, env, "release", "1", "went quiet");
  expect(labels(db, 1)).toEqual(["factory:ready"]);
  run(d, env, "block", "1", "needs keys");
  expect(labels(db, 1)).toEqual(["factory:blocked"]);
  expect(run(d, env, "pick", "--agent", "menelik")[0]).toBe(1); // nothing ready
});

test("release lets a new claim win", () => {
  const [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:taytu"])]);
  const state = loadDb(db);
  state.comments = { 1: [{ body: "<!-- factory-claim agent=taytu -->", at: 0 }] };
  saveDb(db, state);
  run(d, env, "release", "1");
  expect(run(d, env, "pick", "--agent", "menelik")[1]).toBe("issue-1 Task 1");
  expect(labels(db, 1)).toEqual(["agent:menelik", "factory:in-progress"]);
});

test("stale lists quiet issues", () => {
  const [d, , env] = setup([issue(1, ["factory:in-progress", "agent:taytu"])]);
  const [, out] = run(d, env, "stale", "--hours", "1");
  expect(out).toContain("#1 agent:taytu quiet for");
});

test("agent registers pings and goes down", () => {
  const [d, db, env] = setup([issue(1)]);
  agents(d, env, "register", "--agent", "taytu");
  const [, out] = agents(d, env, "list");
  expect(out.startsWith("taytu") && out.includes(" idle ")).toBe(true);
  agents(d, env, "ping", "--agent", "taytu", "--status", "working on #1");
  const titles = new Set(loadDb(db).issues.map((i) => i.title));
  expect(titles.has("Agent: taytu · working on #1")).toBe(true);
  expect(run(d, env, "pick", "--agent", "menelik")[1]).toBe("issue-1 Task 1"); // the agent issue is not a task
  agents(d, env, "down", "--agent", "taytu");
  expect(labels(db, 2)).toContain("factory:agent-down");
});

test("sweep marks silent agents down and releases their issues", () => {
  const old = "<!-- factory-agent name=taytu status=working ping=2020-01-01T00:00:00Z -->\n**Started:** x\n**Where:** y";
  const [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:taytu"]), issue(2, ["factory:agent"], old)]);
  const [, out] = agents(d, env, "sweep");
  expect(out.startsWith("taytu: down") && out.includes("released #1")).toBe(true);
  expect(labels(db, 1)).toEqual(["factory:ready"]);
  expect(labels(db, 2)).toContain("factory:agent-down");
  expect(agents(d, env, "sweep")[1]).toBe(""); // already down: nothing more to do
});

test("tool use pings at most every few minutes", () => {
  const [d, db, env0] = setup([]);
  const env = { ...env0, FACTORY_AGENT: "taytu" };
  agents(d, env, "register", "--agent", "taytu");
  const before = loadDb(db).clock;
  const p = runHook("factory_agents", ["hook"], { cwd: d, env, input: JSON.stringify({ hook_event_name: "PostToolUse" }) });
  expect(p.code).toBe(0);
  expect(loadDb(db).clock).toBe(before); // registered moments ago: no network call
});

test("a ping or a turns end never opens an agent issue", () => {
  // 22 Oct: a lookup that came back empty made every ping open another issue (195 copies).
  const [d, db, env] = setup([issue(1)]);
  agents(d, env, "ping", "--agent", "menelik", "--force");
  agents(d, env, "ping", "--agent", "menelik", "--status", "working on #1");
  const p = runHook("factory_agents", ["hook"], { cwd: d, env: { ...env, FACTORY_AGENT: "menelik" },
    input: JSON.stringify({ hook_event_name: "Stop" }) });
  expect(p.code).toBe(0);
  agents(d, env, "down", "--agent", "menelik");
  expect(countAgentIssues(db)).toBe(0);
});

test("no path opens an agent issue for an agent that never registered", () => {
  // #194: `Agent: fasil · down` appeared for names that never ran. Only `register` makes an issue, and never a down one.
  const [d, db, env] = setup([issue(1)]);
  const code = `import * as FA from ${JSON.stringify(join(HOOKS, "factory_agents.ts"))};
import { load } from ${JSON.stringify(join(HOOKS, "factory_config.ts"))};
const cfg = load();
for (const status of ["down", "idle", "working"]) FA.update(cfg, "fasil", status, { create: status === "down" });`;
  const p = inProject(d, env, code);
  expect(p.code, p.stderr).toBe(0);
  expect(countAgentIssues(db)).toBe(0);
  agents(d, env, "register", "--agent", "menelik");
  expect(countAgentIssues(db)).toBe(1); // a real registration still opens its one issue
});

test("register reuses the agents issue even a closed one", () => {
  const [d, db, env] = setup([agentIssue(5, "menelik", "2026-10-22T10:00:00Z", "closed")]);
  const [, out] = agents(d, env, "register", "--agent", "menelik");
  expect(out).toBe("#5");
  agents(d, env, "register", "--agent", "menelik");
  expect(countAgentIssues(db)).toBe(1);
  expect(loadDb(db).issues[0]?.state).toBe("open");
});

test("a failed lookup is not an empty one", () => {
  const [d, db, env] = setup([]);
  const [rc, out] = agents(d, { ...env, FAKE_GH_MOVED: "1" }, "register", "--agent", "menelik");
  expect(rc).not.toBe(0);
  expect(out).toContain("something other than a list");
  expect(countAgentIssues(db)).toBe(0);
});

test("only an agents newest issue counts and sweep closes the copies", () => {
  const fresh = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const [d, db, env] = setup([issue(1, ["factory:in-progress", "agent:menelik"]),
    agentIssue(2, "menelik", "2020-01-01T00:00:00Z"), agentIssue(3, "menelik", fresh),
    agentIssue(4, "menelik", "2020-01-01T00:00:00Z", "closed")]);
  let [, out] = agents(d, env, "list");
  expect(out.split("menelik").length - 1).toBe(1);
  expect(out).toContain(" idle ");
  [, out] = agents(d, env, "sweep");
  expect(out).toBe("closed 1 duplicate agent issue: #2"); // the old copy went quiet, but the agent is alive
  expect(labels(db, 1)).toEqual(["agent:menelik", "factory:in-progress"]); // its work stays with it
  const state = Object.fromEntries(loadDb(db).issues.map((i) => [i.number, i.state]));
  expect(state).toEqual({ 1: "open", 2: "closed", 3: "open", 4: "closed" });
});

test("claim issue takes the named issue and nothing else", () => {
  const [d, db, env] = setup([issue(1, undefined, "", 1), issue(2, undefined, "", 2)]);
  const [rc, out, err] = nextTask(d, env, "--claim", "menelik", "--issue", "2");
  expect([rc, out], err).toEqual([0, "issue-2 Task 2"]);
  expect(labels(db, 2)).toEqual(["agent:menelik", "factory:in-progress"]);
  expect(labels(db, 1)).toEqual(["factory:ready"]);
});

test("claim issue refuses a taken issue and changes nothing", () => {
  const [d, db, env] = setup([issue(1), issue(2, ["factory:in-progress", "agent:taytu"])]);
  const before = snapshot(db);
  const [rc, out, err] = nextTask(d, env, "--claim", "menelik", "--issue", "2");
  const e = JSON.parse(err) as Record<string, string>;
  expect(rc).toBe(1);
  expect(out).toBe("");
  expect(e.code).toBe("issue-taken");
  expect(e.message && e.fix).toBeTruthy();
  expect(snapshot(db)).toBe(before);
});

test("claim issue refuses a blocked issue and an open dependency", () => {
  const [d, db, env] = setup([issue(1, ["factory:ready", "factory:blocked"]), issue(2, undefined, "Depends on #3"), issue(3)]);
  const before = snapshot(db);
  for (const [n, code] of [["1", "issue-blocked"], ["2", "issue-blocked"], ["9", "issue-not-found"]] as const) {
    const [rc, out, err] = nextTask(d, env, "--claim", "menelik", "--issue", n);
    const e = JSON.parse(err) as Record<string, string>;
    expect([rc, out, e.code], n).toEqual([1, "", code]);
    expect(e.fix).toBeTruthy();
  }
  expect(snapshot(db)).toBe(before);
});

test("claim without issue still claims the next one", () => {
  const [d, db, env] = setup([issue(1, undefined, "", 2), issue(2, undefined, "", 1)]);
  const [rc, out, err] = nextTask(d, env, "--claim", "menelik");
  expect([rc, out], err).toEqual([0, "issue-2 Task 2"]);
  expect(labels(db, 1)).toEqual(["factory:ready"]);
});

test("show prints the issue then the human comments and not the factory markers", () => {
  const [d, db, env] = setup([issue(1, undefined, "Add truncate.")]);
  const data = loadDb(db);
  data.comments = { 1: [
    { body: "Decision: n <= 0 returns an empty string.", at: 1, user: { login: "boss" } },
    { body: "<!-- factory-claim agent=menelik -->\nClaimed.", at: 2 },
    { body: "<!-- factory-approved sha=abc -->\nApproved.", at: 3 },
    { body: "<!-- factory-mustfix sha=abc -->\nFix the loop.", at: 4 }] };
  saveDb(db, data);
  const [rc, out] = run(d, env, "show", "1");
  expect(rc, out).toBe(0);
  expect(out.indexOf("Add truncate.")).toBeLessThan(out.indexOf("Decision: n <= 0 returns an empty string."));
  expect(out).toContain("boss");
  for (const noise of ["Claimed.", "Approved.", "Fix the loop."]) expect(out).not.toContain(noise);
});

test("rework comes only from a trusted reviewers must-fix when trustedReviewers is set", () => {
  // #260: an agent's forged must-fix would send every loop to rework that pull request
  const sha = "a".repeat(40);
  const go = (login: string, trusted: string[] | null): [number, string, string] => {
    const [d, db, env] = setup([]);
    const data = loadDb(db);
    data.pulls = [{ number: 5, title: "Add truncate", labels: [], head: { sha, ref: "task/5-x" } }];
    data.comments = { 5: [{ body: "<!-- factory-mustfix sha=aaaaaaa -->\nFix it.", at: 1, user: { login } }] };
    saveDb(db, data);
    const cfg = { tasks: { source: "issues" }, agents: ["menelik"], ...(trusted ? { trustedReviewers: trusted } : {}) };
    write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
    return nextTask(d, env);
  };
  expect(go("agent-bot", ["boss"])[1]).toBe("none");
  expect(go("boss", ["boss"])[1]).toBe("pr-5 Rework #5: Add truncate (task/5-x)");
  expect(go("agent-bot", null)[1], "no list: anyone, as before").toBe("pr-5 Rework #5: Add truncate (task/5-x)");
});

test("show takes --comments, the form agents know from gh issue view, and prints the people's comments", () => {
  // #354: agents reach for `gh issue view --comments`, which their rules refuse; the factory's command takes the same flag
  const [d, db, env] = setup([issue(1, undefined, "Add truncate.")]);
  const data = loadDb(db);
  data.comments = { 1: [{ body: "Decision: n <= 0 returns an empty string.", at: 1, user: { login: "boss" } }] };
  saveDb(db, data);
  const [rc, out] = run(d, env, "show", "1", "--comments");
  expect(rc, out).toBe(0);
  expect(out).toBe(run(d, env, "show", "1")[1]);
  expect(out).toContain("--- comment by boss ---\nDecision: n <= 0 returns an empty string.");
});

test("show without comments is unchanged", () => {
  const [d, , env] = setup([issue(1, undefined, "Add truncate.")]);
  const [, out] = run(d, env, "show", "1");
  expect(out).toBe("#1 Task 1  [factory:ready]  open\n\nAdd truncate.");
});
