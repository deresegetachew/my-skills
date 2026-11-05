// Claims over NATS (#411 review, answer, item and rework claims; #412 task claims and releases). With `claim` in
// messaging.kinds, the NATS key-value bucket decides who holds a thing: a loser writes nothing to GitHub, a GitHub
// marker with no NATS claim behind it holds nothing, and the winner still writes the GitHub marker (and a task's
// labels): the double send of decision 0004. Without `claim` in the kinds, the claims stay on GitHub. Real nats-server.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { HOOKS, runCode } from "../../../tests/support.ts";
import { createMessaging } from "../index.ts";
import { hook, type Project, project, state } from "./project.ts";
import { MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

setDefaultTimeout(90_000);
let server: Server | null = null;
beforeAll(async () => {
  if (NATS_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

const HEAD = "a".repeat(40);
const LATER = "2099-01-01T00:00:00Z";

function natsOf(name: string) {
  return createMessaging({ url: (server as Server).url, project: name.toLowerCase() });
}

/** A project with PR #5 (head HEAD) and its comments, issues #1 and #2 ready, and `kinds` on NATS. */
function claimsProject(name: string, kinds: string[], comments: Record<string, unknown[]> = {}): Project {
  const pr = { number: 5, title: "Fix", state: "open", draft: false, head: { sha: HEAD, ref: "task/1-fix" }, labels: [],
    user: { login: "me" } };
  const issue = (n: number) => ({ number: n, title: `Task ${n}`, body: "", state: "open", labels: [{ name: "factory:ready" }] });
  return project(name, { tasks: { source: "issues" }, agents: ["haile", "abebe"], roles: { "dev-manager": { names: ["dm-1", "dm-2"] } },
    messaging: { transport: "nats", url: (server as Server).url, kinds } },
  { pulls: [pr], issues: [issue(1), issue(2), { ...pr, pull_request: {}, labels: [] }], comments: { 5: [], ...comments } });
}

const posted = (p: Project, n: number): string[] =>
  (state(p).posted ?? []).filter((x) => x.kind === "comment" && x.issue === n).map((x) => String(x.body));

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  test("review: the first manager takes it on NATS and writes the GitHub marker; the second loses and writes nothing", () => {
    const p = claimsProject("Claims1", ["claim"]);
    let r = hook(p, "factory_manager_claims", ["review", "5", "--manager", "dm-1"]);
    expect(r.code, r.out).toBe(0);
    expect(natsOf("claims1").holder("review.5.aaaaaaa")).toBe("dm-1");
    expect(posted(p, 5).filter((b) => b.includes("factory-review-claim manager=dm-1"))).toHaveLength(1);
    r = hook(p, "factory_manager_claims", ["review", "5", "--manager", "dm-2"]);
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain("held by dm-1");
    expect(posted(p, 5)).toHaveLength(1);
    r = hook(p, "factory_manager_claims", ["release", "5", "--manager", "dm-1"]);
    expect(r.code, r.out).toBe(0);
    expect(natsOf("claims1").holder("review.5.aaaaaaa")).toBe("");
    expect(posted(p, 5).some((b) => b.includes("factory-claim-release manager=dm-1"))).toBe(true);
    expect(hook(p, "factory_manager_claims", ["review", "5", "--manager", "dm-2"]).code).toBe(0);
    expect(natsOf("claims1").holder("review.5.aaaaaaa")).toBe("dm-2");
  });

  test("review: a GitHub claim marker with no NATS claim behind it holds nothing", () => {
    const p = claimsProject("Claims2", ["claim"], { 5: [{ id: 50, body: `<!-- factory-review-claim manager=dm-9 sha=${HEAD} until=${LATER} -->`,
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), user: { login: "me" } }] });
    const r = hook(p, "factory_manager_claims", ["review", "5", "--manager", "dm-1"]);
    expect(r.code, r.out).toBe(0);
    expect(natsOf("claims2").holder("review.5.aaaaaaa")).toBe("dm-1");
  });

  test("answer: one manager claims a question on NATS; the other loses without a comment", () => {
    const q = { id: 61, body: "<!-- factory-question -->\nWhich one?", created_at: "2026-11-05T10:00:00Z", user: { login: "me" },
      issue_url: "https://api.github.com/repos/o/r/issues/6" };
    const p = claimsProject("Claims3", ["claim"], { 6: [q] });
    expect(hook(p, "factory_manager_claims", ["answer", "61", "--manager", "dm-1"]).code).toBe(0);
    expect(natsOf("claims3").holder("answer.61")).toBe("dm-1");
    const before = posted(p, 6).length;
    const r = hook(p, "factory_manager_claims", ["answer", "61", "--manager", "dm-2"]);
    expect(r.code, r.out).toBe(3);
    expect(posted(p, 6)).toHaveLength(before);
  });

  test("the orchestrator's item lease: taken on NATS, refused to another without a comment, and released", () => {
    const p = claimsProject("Claims4", ["claim"]);
    const code = `import * as lease from ${JSON.stringify(join(HOOKS, "factory_lease.ts"))};
      const a = lease.acquire(5, "item", "issue-9", "dm-1", 20);
      const b = lease.acquire(5, "item", "issue-9", "dm-2", 20);
      console.log(JSON.stringify({ a: a?.holder ?? null, b: b?.holder ?? null, held: lease.holder(5, "item", "issue-9") }));
      lease.release(a);
      console.log(JSON.stringify({ after: lease.holder(5, "item", "issue-9"), c: lease.acquire(5, "item", "issue-9", "dm-2", 20)?.holder ?? null }));`;
    const r = runCode(code, { cwd: p.dir, env: p.env });
    expect(r.code, r.out).toBe(0);
    const [first, second] = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(first).toEqual({ a: "dm-1", b: null, held: "dm-1" });
    expect(second).toEqual({ after: null, c: "dm-2" });
    expect(posted(p, 5).filter((b) => b.includes("factory-item-claim"))).toHaveLength(2); // dm-1's and dm-2's, never the loser's
    expect(natsOf("claims4").holder("item.5.issue-9")).toBe("dm-2");
  });

  test("rework: one agent holds a PR's rework on NATS; another is refused without a comment until it is released", () => {
    const p = claimsProject("Claims5", ["claim"]);
    const code = `import { claimRework, releaseRework } from ${JSON.stringify(join(HOOKS, "factory_claims.ts"))};
      import { load } from ${JSON.stringify(join(HOOKS, "factory_config.ts"))};
      const cfg = load();
      const out = [claimRework(cfg, 5, "${HEAD}", "haile"), claimRework(cfg, 5, "${HEAD}", "abebe")];
      out.push(releaseRework(cfg, 5, "haile"), claimRework(cfg, 5, "${HEAD}", "abebe"));
      console.log(JSON.stringify(out));`;
    const r = runCode(code, { cwd: p.dir, env: p.env });
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual([true, false, true, true]);
    const bodies = posted(p, 5);
    expect(bodies.filter((b) => b.includes("factory-rework-claim agent=haile"))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes("factory-rework-claim agent=abebe"))).toHaveLength(1); // after the release only
    expect(natsOf("claims5").holder("rework.5")).toMatch(/^abebe/);
  });

  test("tasks: a task another agent holds on NATS is skipped untouched; the one taken has its labels and claim comment", () => {
    const p = claimsProject("Claims6", ["claim"]);
    natsOf("claims6").claim("task.1", "abebe@m2", 600);
    const r = hook(p, "next_task", ["--claim", "haile", "--pid", String(process.pid)], "haile");
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain("issue-2");
    const s = state(p);
    expect((s.posted ?? []).filter((x) => x.issue === 1)).toHaveLength(0);
    expect(posted(p, 2).some((b) => b.includes("factory-claim agent=haile"))).toBe(true);
    expect(natsOf("claims6").holder("task.2")).toMatch(/^haile/);
    const back = hook(p, "factory_issues", ["release", "2"]);
    expect(back.code, back.out).toBe(0);
    expect(natsOf("claims6").holder("task.2")).toBe("");
  });

  test("without claim in messaging.kinds the claims stay on GitHub: nothing is written to the NATS bucket", () => {
    const p = claimsProject("Claims7", ["wake"]);
    expect(hook(p, "factory_manager_claims", ["review", "5", "--manager", "dm-1"]).code).toBe(0);
    expect(natsOf("claims7").holder("review.5.aaaaaaa")).toBe("");
    expect(posted(p, 5).filter((b) => b.includes("factory-review-claim manager=dm-1"))).toHaveLength(1);
  });

  test("claim on with NATS down: claims go over GitHub and say nats-unreachable once", () => {
    const p = project("Claims8", { messaging: { transport: "nats", url: "nats://127.0.0.1:9", kinds: ["claim"] } },
      { pulls: [{ number: 5, title: "Fix", state: "open", draft: false, head: { sha: HEAD, ref: "task/1-fix" }, labels: [] }],
        issues: [{ number: 5, title: "Fix", state: "open", labels: [], pull_request: {} }], comments: { 5: [] } });
    const r = hook(p, "factory_manager_claims", ["review", "5", "--manager", "dm-1"]);
    expect(r.code, r.out).toBe(0);
    expect(r.stderr.split("nats-unreachable").length - 1).toBe(1);
    expect(posted(p, 5).filter((b) => b.includes("factory-review-claim manager=dm-1"))).toHaveLength(1);
  });
}
