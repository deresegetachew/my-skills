// The sign-off and testing queue (`factory signoff`, #101), against the stateful fake `gh` of fakegh.ts. (From the
// sign-off section of test_product_owner.py, #252; its digest test stays there until factory_roles is ported.)
import { expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { installFakeGh } from "./fakegh.ts";
import { envWith, gitRepo, HOOKS, SF, sh, tmp, write, type Proc } from "./support.ts";

type Env = Record<string, string | undefined>;
type Posted = { kind: string; title?: string; body?: string };

function project(): [string, string, Env] {
  const d = tmp();
  const work = join(d, "work");
  sh(["mkdir", "-p", work]);
  gitRepo(work);
  write(join(work, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" } }));
  symlinkSync(HOOKS, join(work, ".claude", "hooks"));
  symlinkSync(join(SF, "factory"), join(work, "factory"));
  const bin = installFakeGh(d);
  write(join(d, "db.json"), "{}");
  const env = envWith(bin, { FAKE_DB: join(d, "db.json"), LOOP_LOG: join(d, "log"), FACTORY_AGENT: undefined,
    CLAUDE_PROJECT_DIR: undefined });
  return [d, work, env];
}

function posted(d: string): Posted[] {
  return ((JSON.parse(readFileSync(join(d, "db.json"), "utf8")) as { posted?: Posted[] }).posted ?? []);
}

function signoff(work: string, env: Env, ...args: string[]): Proc {
  return sh(["bash", join(work, "factory"), "signoff", ...args], { cwd: work, env });
}

test("an item that needs a person is added listed and signed off", () => {
  const [d, work, env] = project();
  expect(signoff(work, env, "ls").stdout).toContain("nothing waits");
  const p = signoff(work, env, "add", "arabic-label", "--task", "12", "--check", "Open the guide in Arabic; read the warning.");
  expect(p.code, p.out).toBe(0);
  expect(posted(d).map((x) => x.kind)).toEqual(["issue", "comment"]); // the queue is made on demand, once
  expect(posted(d)[0]?.title).toBe("Sign-off and testing queue");
  const ls = signoff(work, env, "ls").stdout;
  expect(ls).toContain("arabic-label: sign-off open task #12: To check: Open the guide in Arabic");
  expect(signoff(work, env, "add", "arabic-label", "--task", "12", "--check", "x").code).not.toBe(0); // no second entry
  const r = signoff(work, env, "result", "arabic-label", "pass", "--note", "Read it with Sabla.", "--by", "boss");
  expect(r.code, r.stderr).toBe(0);
  expect(signoff(work, env, "ls").stdout).toContain("nothing waits");
  expect(signoff(work, env, "ls", "--all").stdout).toContain("sign-off passed");
  expect(posted(d).filter((x) => x.kind === "issue").length, "the queue issue is not made twice").toBe(1);
  expect(signoff(work, env, "result", "arabic-label", "blocked").code).not.toBe(0); // a sign-off passes or fails
});

test("a test plan is proposed then confirmed by the owner then gets results", () => {
  const [d, work, env] = project();
  expect(signoff(work, env, "plan", "login-flow", "--task", "13", "--text", "1. Open the link.\n2. Tap Start.").code).toBe(0);
  expect(signoff(work, env, "ls").stdout).toContain("login-flow: test plan proposed task #13: 1. Open the link.");
  const early = signoff(work, env, "result", "login-flow", "pass");
  expect(early.code).not.toBe(0);
  expect(early.stderr).toContain("not confirmed");
  expect(early.stderr).toContain("factory signoff confirm login-flow");
  expect(posted(d).length, "the refused result wrote nothing").toBe(2); // the queue issue and the plan
  expect(signoff(work, env, "confirm", "login-flow", "--by", "boss").code).toBe(0);
  expect(signoff(work, env, "ls").stdout).toContain("test plan confirmed");
  expect(signoff(work, env, "confirm", "login-flow").stdout).toContain("already confirmed");
  expect(signoff(work, env, "result", "login-flow", "fail", "--note", "Start did nothing.", "--build", "abc1234").code).toBe(0);
  const ls = signoff(work, env, "ls", "--all").stdout;
  expect(ls).toContain("login-flow: test plan failed task #13");
  const items = JSON.parse(signoff(work, env, "ls", "--all", "--json").stdout) as { results: string[][] }[];
  expect(items[0]?.results[0]?.[0]).toBe("fail");
  expect(items[0]?.results[0]?.[1]).toBe("me");
  const last = posted(d).at(-1)?.body ?? "";
  expect(last).toContain("factory-testresult id=login-flow result=fail by=me build=abc1234");
  expect(last).toContain("Start did nothing.");
});

test("a revised plan has to be confirmed again and its old results do not count", () => {
  const [, work, env] = project();
  signoff(work, env, "plan", "p1", "--task", "13", "--text", "v1");
  signoff(work, env, "confirm", "p1");
  signoff(work, env, "result", "p1", "pass");
  expect(signoff(work, env, "ls", "--all").stdout).toContain("p1: test plan passed");
  signoff(work, env, "plan", "p1", "--text", "v2 with another step");
  const ls = signoff(work, env, "ls").stdout;
  expect(ls).toContain("p1: test plan proposed task #13: v2"); // the task link carries over
  expect(signoff(work, env, "result", "p1", "pass").code).not.toBe(0);
});

test("signoff dry run and bad ids write nothing", () => {
  const [d, work, env] = project();
  const p = signoff(work, env, "add", "x1", "--task", "1", "--check", "look", "--dry-run");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("would post");
  expect(p.stdout).toContain("factory-signoff id=x1 task=1");
  expect(posted(d)).toEqual([]);
  const bad = signoff(work, env, "add", "no spaces", "--task", "1", "--check", "look");
  expect(bad.code).not.toBe(0);
  expect(bad.stderr).toContain("fix:");
  expect(posted(d)).toEqual([]);
  expect(signoff(work, env, "confirm", "ghost").code).not.toBe(0);
});
