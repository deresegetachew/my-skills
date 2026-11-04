// The GitHub Issues TaskTracker adapter (decision 0003, #377): it passes the port's contract against the fake `gh` the
// issues-mode tests use (issues_support.ts), and keeps what `factory issues` always did: labels carry the state, a
// claim is a comment, and the earliest claim comment since the last release wins.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { GithubTaskTracker } from "../hooks/core/adapters/github/task_tracker.ts";
import type { Config } from "../hooks/factory_config.ts";
import { taskTrackerContract } from "./contracts/task_tracker.ts";
import { FAKE_GH, type IssueRow, issue, labels, loadDb, saveDb } from "./issues_support.ts";
import { tmp, write, writeExe } from "./support.ts";

const dirs: string[] = [];
const PATH = process.env.PATH;
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const cfg = { tasks: { source: "issues" }, mainBranch: "main" } as unknown as Config;

/** A fake GitHub holding `issues`; the adapter's gh is it. Returns the db file. */
function world(issues: IssueRow[]): string {
  const d = tmp();
  dirs.push(d);
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const db = write(join(d, "db.json"), JSON.stringify({ issues }));
  Object.assign(process.env, { PATH: `${d}/bin:${PATH}`, FAKE_GH_DB: db, FACTORY_CLAIM_SETTLE_SECONDS: "0" });
  return db;
}

/** A claim comment that landed on issue `n` before anyone's labels did. */
function claimComment(db: string, n: number, agent: string, machine: string): void {
  const data = loadDb(db);
  ((data.comments ??= {})[String(n)] ??= []).push({ body: `<!-- factory-claim agent=${agent} machine=${machine} -->`, at: 0 });
  saveDb(db, data);
}

taskTrackerContract("github", (specs) => {
  const rows = specs.map((s, k) => {
    const deps = s.dependsOn?.length ? `Depends on ${s.dependsOn.map((d) => `#${d + 1}`).join(", ")}\n\n` : "";
    const todos = Array.from({ length: s.todos ?? 0 }, (_, j) => `- [ ] todo ${j + 1}`).join("\n");
    const row = issue(k + 1, [s.state === "blocked" ? "factory:blocked" : "factory:ready"], deps + todos);
    return { ...row, title: s.title ?? row.title, state: s.state === "done" ? "closed" : "open" };
  });
  const db = world(rows);
  return { port: new GithubTaskTracker(cfg), ids: specs.map((_, k) => String(k + 1)), missing: "99", foreign: "1.3",
    rival: (id, who) => claimComment(db, Number(id), who.agent, who.machine) };
});

test("github: the same agent name on two machines: the second machine's claim is refused", () => {
  const db = world([issue(5)]);
  const port = new GithubTaskTracker(cfg);
  port.claim("5", { agent: "haile", machine: "m1" });
  let code = "";
  try {
    port.claim("5", { agent: "haile", machine: "m2" });
  } catch (e) {
    code = (e as { code: string }).code;
  }
  expect(code).toBe("issue-taken");
  expect(port.pick({ agent: "haile", machine: "m2" }).task).toBeNull(); // not its to carry on with
  expect(port.pick({ agent: "haile", machine: "m1" }).task?.id).toBe("5");
  expect(labels(db, 5)).toEqual(["agent:haile", "factory:in-progress"]);
});

test("github: Depends on #12, #14 with #12 closed and #14 open waits for #14 only", () => {
  world([issue(3, ["factory:ready"], "Depends on #12, #14"), { ...issue(12, []), state: "closed" }, issue(14, [])]);
  const port = new GithubTaskTracker(cfg);
  let message = "";
  try {
    port.claim("3", { agent: "haile", machine: "m1" });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toBe("#3 waits for #14.");
  expect(port.next()).toBeNull();
});

test("github: a refusal is the same {code, message, fix} the claim by number always gave", () => {
  world([issue(4, ["factory:in-progress", "agent:taytu"])]);
  let got: unknown = null;
  try {
    new GithubTaskTracker(cfg).claim("4", { agent: "haile", machine: "m1" });
  } catch (e) {
    got = (e as { toJSON(): unknown }).toJSON();
  }
  expect(got).toEqual({ code: "issue-taken", message: "#4 is already taken by taytu.",
    fix: "Pick another issue, or ask the dev manager to release it with `factory issues release`." });
});
