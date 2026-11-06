// Pull requests and CI over NATS (the `pr` kind): one watcher reads GitHub and keeps a snapshot in the hub's bucket,
// publishing one event per change; the dev manager's pass, `factory wait slot` and `ci`, and the rework check read the
// snapshot instead of GitHub. Against a real nats-server, in a project with the stateful fake gh of the orchestrator's
// tests (every gh call is logged, so "no GitHub call" is what the log says).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { runHook, sh } from "../../../tests/support.ts";
import { type Env, log } from "../../../tests/roles_support.ts";
import { comment, H, H2, iso, pr, put, world } from "../../../tests/orchestrator_support.ts";
import { createMessaging } from "../index.ts";
import { MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

setDefaultTimeout(120_000);
let server: Server | null = null;
beforeAll(async () => {
  if (NATS_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

const H3 = "c".repeat(40);
const pending = { id: 3, name: "tests", status: "in_progress", conclusion: null };
const green = { id: 4, name: "tests", status: "completed", conclusion: "success" };

let n = 0;
/** A project whose NATS name is unique to the test, with `messaging` on NATS for `kinds`. */
function hub(db: Record<string, unknown>, extra: Record<string, unknown> = {}, kinds = ["pr"]): { d: string; work: string; env: Env; name: string } {
  n += 1;
  const name = `prfeed-${process.pid}-${n}`;
  const [d, work, env] = world({ db, cfg: { messaging: { transport: "nats", url: (server as Server).url, kinds, ...extra } } });
  sh(["git", "-C", work, "remote", "set-url", "origin", `git@github.com:o/${name}.git`]);
  return { d, work, env: { ...env, FACTORY_WAIT_START: "1" }, name };
}

function run(work: string, env: Env, script: string, args: string[], agent = "lead") {
  return runHook(script, args, { cwd: work, env: { ...env, FACTORY_AGENT: agent }, timeoutMs: 90_000 });
}

/** The gh calls since the log was last cleared, and clear it. */
function calls(env: Env): string[] {
  const got = log(env).filter((l) => l.startsWith("gh "));
  writeFileSync(env.LOOP_LOG as string, "");
  return got;
}

/** A gh call about a pull request: its list, itself, its commits and CI, its comments or events. */
const aboutPrs = (lines: string[]): string[] =>
  lines.filter((l) => /\/pulls\b|\/commits\/|check-runs|\/status\b|\/issues\/(5|6)\/(comments|events)/.test(l));

// Two reviewed pull requests: #5 approved with CI still running, #6 with a must-fix younger than staleMinutes.
const IDLE = {
  pulls: [{ ...pr(5), updated_at: iso(30) }, { ...pr(6, { sha: H2 }), updated_at: iso(30) }],
  commits: { [H]: iso(60), [H2]: iso(60), [H3]: iso(60) },
  checks: { [H]: [pending], [H2]: [pending] },
  comments: { "5": [comment(1, `<!-- factory-approved sha=${H} -->`, 20)], "6": [comment(2, `<!-- factory-mustfix sha=${H2} -->`, 3)] },
};

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  test("an idle dev-manager pass over two unchanged pull requests asks GitHub nothing about them", () => {
    const p = hub(IDLE);
    const looked = run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    expect(looked.code, looked.out).toBe(0);
    expect(looked.stdout).toContain("2 open pull request(s); 0 change(s)");
    const warm = run(p.work, p.env, "factory_orchestrator", ["cycle", "--name", "lead", "--dry-run"]);
    expect(warm.code, warm.out).toBe(3);
    calls(p.env);
    const idle = run(p.work, p.env, "factory_orchestrator", ["cycle", "--name", "lead", "--dry-run"]);
    expect(idle.code, idle.out).toBe(3);
    expect(idle.stdout).toContain("nothing to do");
    expect(aboutPrs(calls(p.env))).toEqual([]);
  });

  test("without pr in messaging.kinds the same pass reads the pull requests and their CI from GitHub, as before", () => {
    const p = hub(IDLE, {}, ["wake"]);
    run(p.work, p.env, "factory_orchestrator", ["cycle", "--name", "lead", "--dry-run"]);
    calls(p.env);
    const idle = run(p.work, p.env, "factory_orchestrator", ["cycle", "--name", "lead", "--dry-run"]);
    expect(idle.code, idle.out).toBe(3);
    const got = calls(p.env);
    expect(got.some((l) => l.startsWith("gh GET repos/{owner}/{repo}/pulls?state=open"))).toBe(true);
    expect(got.some((l) => l.includes(`commits/${H}/check-runs`))).toBe(true);
  });

  test("a head that moves is one event, and the dev manager's next pass reviews the new head", () => {
    const p = hub(IDLE);
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    run(p.work, p.env, "factory_orchestrator", ["cycle", "--name", "lead", "--dry-run"]);
    const since = Date.now() - 1000;
    put(p.d, { pulls: [{ ...pr(5, { sha: H3 }), updated_at: iso(2) }, { ...pr(6, { sha: H2 }), updated_at: iso(30) }] });
    const looked = run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    expect(looked.stdout).toContain("1 change(s)\npr#5 head");
    const events = createMessaging({ url: (server as Server).url, project: p.name }).prEvents({ since, seconds: 2 });
    expect(events.map((e) => [e.pr, e.change, e.head, e.from])).toEqual([[5, "head", H3, "lead"]]);
    const again = run(p.work, p.env, "factory_orchestrator", ["cycle", "--name", "lead", "--dry-run"]);
    expect(again.stdout).toContain("would start a sub-manager for pr-5");
    expect(again.stdout).toContain(`commit ${H3.slice(0, 7)} not reviewed yet`);
  });

  test("one watcher per project: a second dev manager's look reads nothing while the first holds the claim", () => {
    const p = hub(IDLE);
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    calls(p.env);
    const second = run(p.work, p.env, "factory_pr_feed", ["look", "--name", "second"], "second");
    expect(second.code, second.out).toBe(0);
    expect(second.stdout).toContain("lead watches the pull requests; nothing read");
    expect(calls(p.env)).toEqual([]);
  });

  test("the slot check answers from the snapshot, and a pull request that closes frees the slot without GitHub", async () => {
    const p = hub(IDLE, {}, ["pr"]);
    writeFileSync(`${p.work}/.claude/factory.json`, JSON.stringify({ ...JSON.parse(await Bun.file(`${p.work}/.claude/factory.json`).text()),
      maxOpenPRs: 2 }));
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    calls(p.env);
    const full = run(p.work, p.env, "factory_wait", ["slot", "0.05"], "menelik");
    expect(full.code, full.out).toBe(2);
    expect(full.stdout).toContain("still 2 of 2 PRs open");
    expect(calls(p.env)).toEqual([]);
    // a builder waits for the slot; the watcher sees #6 closed and says so; the wait ends without asking GitHub
    const waiting = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/../../../hooks/factory_wait.ts`, "slot", "1"],
      { cwd: p.work, env: { ...p.env, FACTORY_AGENT: "menelik" }, stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(3000);
    put(p.d, { pulls: [{ ...pr(5), updated_at: iso(30) }, { ...pr(6, { sha: H2, state: "closed" }), updated_at: iso(1) }] });
    const started = Date.now();
    const looked = run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    expect(looked.stdout).toContain("pr#6 closed");
    calls(p.env);
    expect(await waiting.exited).toBe(0);
    expect(await new Response(waiting.stdout).text()).toContain("a PR slot is free (1 of 2 open)");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(calls(p.env)).toEqual([]);
  });

  test("factory wait ci answers from the snapshot once the watcher saw CI finish", () => {
    const p = hub(IDLE);
    put(p.d, { checks: { [H]: [green], [H2]: [pending] } });
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    calls(p.env);
    const r = run(p.work, p.env, "factory_wait", ["ci", "5", "1"], "menelik");
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain(`PR #5: CI green (1 checks) on ${H.slice(0, 7)}`);
    expect(calls(p.env)).toEqual([]);
  });

  test("the rework check reads unchanged pull requests from the snapshot and checks a rework once on GitHub", () => {
    const p = hub({ ...IDLE, comments: { ...IDLE.comments, "6": [comment(2, `<!-- factory-mustfix sha=${H2} -->`, 30)] } });
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    const first = run(p.work, p.env, "next_task", ["--no-claim"], "menelik");
    expect(first.stdout, first.out).toContain("pr-6 Rework #6");
    calls(p.env);
    const second = run(p.work, p.env, "next_task", ["--no-claim"], "menelik");
    expect(second.stdout, second.out).toContain("pr-6 Rework #6");
    expect(aboutPrs(calls(p.env))).toEqual(["gh GET repos/{owner}/{repo}/pulls/6"]);
  });

  test("the dev manager's precheck over two unchanged pull requests asks GitHub nothing about them", () => {
    const p = hub(IDLE);
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    run(p.work, p.env, "factory_wait", ["precheck"]);
    calls(p.env);
    const r = run(p.work, p.env, "factory_wait", ["precheck"]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout.trim()).toBe("nothing to do");
    expect(aboutPrs(calls(p.env))).toEqual([]);
  });

  test("an idle builder waits messaging.pollMinutes, and a merged or closed pull request wakes it; a CI result doesn't", async () => {
    const p = hub(IDLE);
    expect(run(p.work, p.env, "factory_wake", ["minutes", "1"], "menelik").stdout.trim()).toBe("15");
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    const since = String(Math.floor(Date.now() / 1000));
    const wait = (): Bun.Subprocess<"ignore", "pipe", "pipe"> => Bun.spawn([process.execPath, "--no-env-file",
      `${import.meta.dir}/../../../hooks/factory_wake.ts`, "wait", "--seconds", "40", "--since", since],
    { cwd: p.work, env: { ...p.env, FACTORY_AGENT: "menelik", FACTORY_ROLE: "coding-agent" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    put(p.d, { checks: { [H]: [green], [H2]: [pending] } });
    expect(run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]).stdout).toContain("pr#5 checks");
    const quiet = run(p.work, p.env, "factory_wake", ["wait", "--seconds", "2", "--since", since], "menelik");
    expect(quiet.code, quiet.out).toBe(2);
    const waiting = wait();
    await Bun.sleep(2000);
    put(p.d, { pulls: [{ ...pr(5), updated_at: iso(30) }, { ...pr(6, { sha: H2, state: "closed" }), updated_at: iso(1) }] });
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    expect(await waiting.exited).toBe(0);
    expect(await new Response(waiting.stdout).text()).toContain("woken by lead: pull request closed (pr#6)");
  });

  test("a snapshot older than messaging.pollMinutes isn't trusted: the slot check asks GitHub", () => {
    const p = hub(IDLE, { pollMinutes: 0.0001 });
    run(p.work, p.env, "factory_pr_feed", ["look", "--name", "lead"]);
    calls(p.env);
    const r = run(p.work, p.env, "factory_wait", ["slot", "0.02"], "menelik");
    expect(r.code, r.out).toBe(0);
    expect(calls(p.env).some((l) => l.startsWith("gh GET repos/{owner}/{repo}/pulls?state=open"))).toBe(true);
  });
}
