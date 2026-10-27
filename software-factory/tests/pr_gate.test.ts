// The PR gate (pr-gate.ts) against the bypasses the 22 Oct security audit found, with a fake `gh`.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Env, runGate } from "./pr_gate_support.ts";
import { git, KIT, sh, tmp, write, writeExe } from "./support.ts";

const HEAD = "a".repeat(40);

// Answers from a scenario file; every call is logged, so a test can see which PR the gate looked at.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.GATE_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.GATE_LOG as string, a.join(" ") + "\n");
function out(x: unknown): never { console.log(JSON.stringify(x)); process.exit(0); }
function fail(m: string): never { console.error(m); process.exit(1); }
const j = a.join(" ");
if (s.gh_broken) fail("gh: not signed in");
if (a[0] === "pr" && a[1] === "view") out(s.pr);
if (a[0] === "pr" && a[1] === "checks") process.exit(s.ci_green === false ? 1 : 0);
if (a[0] === "pr" && a[1] === "list") out(s.open_prs ?? []);
if (a[0] === "repo" && a[1] === "view") { console.log(s.default_branch ?? "main"); process.exit(0); }
if (a[0] === "api" && j.includes("/contents/.claude/factory.json")) {
  if (s.settings_error) fail(s.settings_error);
  if (s.main_settings === null || s.main_settings === undefined) fail("gh: Not Found (HTTP 404)");
  out(s.main_settings);
}
if (a[0] === "api" && j.includes("/files")) { console.log((s.files ?? ["src/a.ts"]).join("\n")); process.exit(0); }
if (a[0] === "api" && j.includes("/comments")) { if (!("thread" in s)) fail("gh: no thread"); out(s.thread); }
if (a[0] === "api" && j.includes("/issues/")) out(s.issue ?? { state: "open", labels: [] });
fail("fake gh: no answer for " + j);
`;

type Obj = Record<string, unknown>;

function setup(o: { pr?: Obj; cfgExtra?: Obj; [key: string]: unknown } = {}): [string, Env] {
  const { pr, cfgExtra, ...scenario } = o;
  const d = tmp();
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const cfg = { reviewMarkers: "tmp/reviews", protected: ["^\\.claude/"], alwaysAllowed: [], maxOpenPRs: 3, ...(cfgExtra ?? {}) };
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  write(join(d, "tmp", "reviews", "task_1-x.ok"), HEAD); // the reviewer passed HEAD
  const fullPr = { number: 7, headRefName: "task/1-x", headRefOid: HEAD, comments: [], labels: [], body: "", ...(pr ?? {}) };
  // The gate reads the settings from GitHub's default branch (#51): the fake gh serves the same ones.
  write(join(d, "scenario.json"), JSON.stringify({ pr: fullPr, main_settings: cfg, ...scenario }));
  sh(["git", "init", "-q", d]);
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, GATE_SCENARIO: join(d, "scenario.json"),
    GATE_LOG: join(d, "log") };
  delete env.FACTORY_AGENT;
  delete env.CLAUDE_PROJECT_DIR;
  return [d, env];
}

const gate = (d: string, env: Env, command: string): [number, string] => runGate(d, env, command);

function log(d: string): string {
  return existsSync(join(d, "log")) ? readFileSync(join(d, "log"), "utf8") : "";
}

function rc(d: string, env: Env, command: string): number {
  return gate(d, env, command)[0];
}

const MERGE = `gh pr merge 7 --squash --match-head-commit ${HEAD}`;
const REVIEW_OK = (d: string): string => join(d, "tmp", "reviews", "task_1-x.ok");

test("a good merge passes", () => {
  const [d, env] = setup();
  expect(gate(d, env, MERGE)).toEqual([0, ""]);
});

test("other commands pass untouched", () => {
  const [d, env] = setup();
  for (const c of ["git status", "pnpm test", "gh pr view 7", "gh pr list", "echo gh-pr-merge"]) expect(rc(d, env, c), c).toBe(0);
});

test("fails closed on a broken config", () => {
  const [d, env] = setup();
  writeFileSync(join(d, ".claude", "factory.json"), "{ not json");
  const [code, err] = gate(d, env, MERGE);
  expect(code, err).toBe(2);
  expect(err).toContain("PR gate hit an error");
});

test("fails closed when gh fails", () => {
  const [d, env] = setup({ gh_broken: true });
  expect(rc(d, env, MERGE)).toBe(2);
});

test("the pr number after flags is the one checked", () => {
  const [d, env] = setup();
  gate(d, env, `gh pr merge --squash 99 --match-head-commit ${HEAD}`);
  expect(log(d)).toContain("pr view 99 ");
});

test("a merge needs the checked head commit", () => {
  const [d, env] = setup();
  const [code, err] = gate(d, env, "gh pr merge 7 --squash");
  expect(code).toBe(2);
  expect(err).toContain("--match-head-commit");
  expect(rc(d, env, "gh pr merge 7 --squash --match-head-commit " + "b".repeat(40))).toBe(2);
});

test("hidden merges are gated", () => {
  const [d, env] = setup({ ci_green: false });
  for (const c of [`gh -R o/r pr merge 7 --match-head-commit ${HEAD}`, `cd x && gh pr merge 7 --match-head-commit ${HEAD}`,
    `/usr/bin/gh pr merge 7 --match-head-commit ${HEAD}`]) {
    expect(rc(d, env, c), c).toBe(2); // CI is red, so every one of these must be blocked
  }
});

test("one merge per command and no push with it", () => {
  const [d, env] = setup();
  expect(rc(d, env, `${MERGE}; gh pr merge 8 --match-head-commit ${HEAD}`)).toBe(2);
  expect(rc(d, env, `git push origin task/1-x && ${MERGE}`)).toBe(2);
});

test("pr new and ready are gated like create", () => {
  const [d, env] = setup();
  rmSync(REVIEW_OK(d));
  expect(rc(d, env, "gh pr ready 7")).toBe(2);
  expect(rc(d, env, "gh pr new --title x --body y")).toBe(2);
  expect(rc(d, env, "gh pr create --draft --title x --body y")).toBe(0); // drafts are for questions
  expect(rc(d, env, "gh pr create --title 'not a -d draft' --body y")).toBe(2);
});

test("aliases are refused", () => {
  const [d, env] = setup();
  expect(rc(d, env, "gh alias set m 'pr merge'")).toBe(2);
  expect(rc(d, env, "gh m 7")).toBe(2);
});

test("agents cannot post dev manager markers or touch review labels", () => {
  const [d, env] = setup();
  const body = write(join(d, "body.md"), "<!-- factory-approved sha=aaaaaaa -->");
  for (const c of ["gh pr comment 7 --body '<!-- factory-approved sha=aaaaaaa -->'", `gh pr comment 7 --body-file ${body}`,
    "gh issue comment 9 -b '<!-- factory-answer -->'", "gh pr edit 7 --remove-label factory-hold",
    "gh pr edit 7 --add-label tests-reviewed", "gh pr review 7 --approve"]) {
    expect(rc(d, env, c), c).toBe(2);
  }
  expect(rc(d, env, "gh pr comment 7 --body '<!-- factory-question --> which one?'")).toBe(0);
});

function envelope(kw: Record<string, string>): string {
  const all = "v" in kw ? kw : { ...kw, v: "1" }; // setdefault: v goes last
  return "<!-- factory-msg " + Object.entries(all).map(([k, v]) => `${k.replace(/_/g, "-")}=${v}`).join(" ") + " -->";
}

function post(d: string, env: Env, text: string, n = "7", cmd = "pr"): [number, string] {
  const body = write(join(d, "msg.md"), text);
  return gate(d, env, `gh ${cmd} comment ${n} --body-file ${body}`);
}

function threadOf(...messages: string[]): Obj[] {
  return messages.map((b, i) => ({ id: i + 1, body: b, user: { login: "me" } }));
}

const QUESTION_TO_HAILE = envelope({ id: "q1x", kind: "question", from: "taytu", to: "haile", state: "submitted", ref: "pr#7" });
const ANSWER_FROM_HAILE = envelope({ id: "a1x", kind: "answer", from: "haile", to: "taytu", state: "completed",
  in_reply_to: "q1x", ref: "pr#7" }) + "\nUse blue.";

test("an agent may ask a question in the new form", () => {
  const [d, env] = setup();
  env.FACTORY_AGENT = "haile";
  const q = envelope({ id: "q9x", kind: "question", from: "haile", to: "po", state: "submitted" }) + "\nWhich colour?";
  expect(post(d, env, q)).toEqual([0, ""]);
  expect(post(d, env, q, "9", "issue")[0]).toBe(0);
});

test("an agent cannot post as someone else", () => {
  const [d, env] = setup();
  env.FACTORY_AGENT = "haile";
  const [code, err] = post(d, env, envelope({ id: "q9x", kind: "question", from: "po", state: "submitted" }));
  expect(code, err).toBe(2);
  expect(err).toContain("yourself");
});

test("agents cannot post approvals or mustfixes in the new form", () => {
  const [d, env] = setup();
  env.FACTORY_AGENT = "haile";
  for (const [kind, state] of [["approval", "completed"], ["mustfix", "submitted"]] as const) {
    const [code, err] = post(d, env, envelope({ id: "m1x", kind, from: "haile", state, sha: "aaaaaaa" }));
    expect(code, `${kind} ${err}`).toBe(2);
    expect(err).toContain("reserved");
  }
});

test("an agent answers only a question addressed to it", () => {
  let [d, env] = setup({ thread: threadOf(QUESTION_TO_HAILE) });
  env.FACTORY_AGENT = "haile";
  expect(post(d, env, ANSWER_FROM_HAILE)).toEqual([0, ""]);
  [d, env] = setup({ thread: threadOf(QUESTION_TO_HAILE.replace("to=haile", "to=po")) });
  env.FACTORY_AGENT = "haile";
  const [code, err] = post(d, env, ANSWER_FROM_HAILE);
  expect(code, err).toBe(2);
  expect(err).toContain("addressed to po");
});

test("a po answer from an agent is refused", () => {
  const [d, env] = setup({ thread: threadOf(QUESTION_TO_HAILE.replace("to=haile", "to=po")) });
  env.FACTORY_AGENT = "haile";
  const [code, err] = post(d, env, ANSWER_FROM_HAILE.replace("from=haile", "from=po"));
  expect(code, err).toBe(2);
  expect(err).toContain("yourself");
});

test("a reply must name its thread and a question in it", () => {
  const [d, env] = setup({ thread: threadOf(QUESTION_TO_HAILE) });
  env.FACTORY_AGENT = "haile";
  const noRef = ANSWER_FROM_HAILE.replace(" ref=pr#7", "");
  const body = write(join(d, "msg.md"), noRef);
  let [code, err] = gate(d, env, `gh pr comment --body-file ${body}`); // no number and no ref: the thread is unknown
  expect(code, err).toBe(2);
  expect(err).toContain("ref=");
  expect(post(d, env, noRef)[0]).toBe(0); // the number on the command names it
  [code, err] = post(d, env, ANSWER_FROM_HAILE.replace("in-reply-to=q1x", "in-reply-to=zzz"));
  expect(code, err).toBe(2);
  expect(err).toContain("can't find");
  [code, err] = post(d, env, ANSWER_FROM_HAILE.replace(" in-reply-to=q1x", ""));
  expect(code, err).toBe(2);
  expect(err).toContain("in-reply-to");
  [code, err] = post(d, env, ANSWER_FROM_HAILE, "9"); // comments on 9 but ref says pr#7
  expect(code, err).toBe(2);
  expect(err).toContain("pr#7");
});

test("a thread gh cannot read fails closed", () => {
  const [d, env] = setup(); // the fake has no thread to give
  env.FACTORY_AGENT = "haile";
  const [code, err] = post(d, env, ANSWER_FROM_HAILE);
  expect(code, err).toBe(2);
  expect(err).toContain("read");
});

test("an invalid transition is refused", () => {
  const done = ANSWER_FROM_HAILE.replace("a1x", "a0x");
  const [d, env] = setup({ thread: threadOf(QUESTION_TO_HAILE, done) });
  env.FACTORY_AGENT = "haile";
  const [code, err] = post(d, env, ANSWER_FROM_HAILE.replace("state=completed", "state=failed"));
  expect(code, err).toBe(2);
  expect(err).toContain("completed");
  expect(post(d, env, done)[0]).toBe(0); // the same message again is a no-op
});

test("unknown versions and plain text pass and old markers stay reserved", () => {
  const [d, env] = setup();
  env.FACTORY_AGENT = "haile";
  expect(post(d, env, envelope({ v: "2", id: "a1x", kind: "approval", state: "completed" }))[0]).toBe(0);
  expect(post(d, env, "<!-- factory-answer -->\nx")[0]).toBe(2);
  expect(post(d, env, envelope({ id: "a1x", kind: "answer", from: "haile", in_reply_to: "q1x" }) + "\n<!-- factory-answer -->")[0]).toBe(2);
});

test("a merge honours a mustfix and an approval in the new form", () => {
  const mustfix = { body: envelope({ id: "m1x", kind: "mustfix", from: "dev-manager", state: "submitted", sha: "aaaaaaa" }),
    author: { login: "owner" } };
  let [d, env] = setup({ pr: { comments: [mustfix] } });
  expect(rc(d, env, MERGE)).toBe(2);
  const ok = { body: envelope({ id: "p1x", kind: "approval", from: "dev-manager", state: "completed", sha: HEAD.slice(0, 7) }),
    author: { login: "owner" } };
  [d, env] = setup({ pr: { comments: [mustfix, ok] } });
  expect(rc(d, env, MERGE)).toBe(0);
  [d, env] = setup({ pr: { comments: [mustfix, ok] }, cfgExtra: { trustedReviewers: ["someone-else"] } });
  expect(rc(d, env, MERGE)).toBe(2);
});

test("a mustfix holds until an approval of this commit", () => {
  const mustfix = { body: "<!-- factory-mustfix sha=aaaaaaa -->", author: { login: "owner" } };
  let [d, env] = setup({ pr: { comments: [mustfix] } });
  expect(rc(d, env, MERGE)).toBe(2);
  const old = { body: "<!-- factory-approved sha=bbbbbbb -->", author: { login: "owner" } };
  [d, env] = setup({ pr: { comments: [mustfix, old] } });
  expect(rc(d, env, MERGE)).toBe(2); // approval of another commit
  const ok = { body: `<!-- factory-approved sha=${HEAD.slice(0, 7)} -->`, author: { login: "owner" } };
  [d, env] = setup({ pr: { comments: [mustfix, ok] } });
  expect(rc(d, env, MERGE)).toBe(0);
});

test("only trusted reviewers approvals count", () => {
  const mustfix = { body: "<!-- factory-mustfix sha=aaaaaaa -->", author: { login: "owner" } };
  const forged = { body: `<!-- factory-approved sha=${HEAD.slice(0, 7)} -->`, author: { login: "agent-bot" } };
  const [d, env] = setup({ pr: { comments: [mustfix, forged] }, cfgExtra: { trustedReviewers: ["owner"] } });
  expect(rc(d, env, MERGE)).toBe(2);
});

test("hold label and protected files beyond 100", () => {
  let [d, env] = setup({ pr: { labels: [{ name: "factory-hold" }] } });
  expect(rc(d, env, MERGE)).toBe(2);
  const many = [...Array.from({ length: 150 }, (_, i) => `src/f${i}.ts`), ".claude/settings.json"];
  [d, env] = setup({ files: many });
  const [code, err] = gate(d, env, MERGE);
  expect(code, err).toBe(2);
  expect(err).toContain(".claude/settings.json");
});

test("copilot review points on pr 36", () => {
  let [d, env] = setup();
  const reply = write(join(d, "reply.md"), "<!-- factory-approved sha=aaaaaaa -->");
  expect(rc(d, env, `gh pr comment 7 -F${reply}`)).toBe(2); // attached short value is read
  expect(rc(d, env, "gh pr create --draft --label tests-reviewed --title x --body y")).toBe(2);
  expect(rc(d, env, "gh -R other/repo pr comment 7 --body hi")).toBe(2); // other repos aren't checked
  rmSync(REVIEW_OK(d));
  expect(rc(d, env, "gh pr create --draft=false --title x --body y")).toBe(2); // not a draft
  expect(rc(d, env, "gh pr ready 7 --undo")).toBe(0); // back to draft needs nothing
  expect(rc(d, env, `gh pr merge https://github.com/other/repo/pull/7 --match-head-commit ${HEAD}`)).toBe(2);
  [d, env] = setup({ cfgExtra: { holdLabel: "review-in-progress" } });
  expect(rc(d, env, "gh pr edit 7 --remove-label review-in-progress")).toBe(2);
});

test("copilot second review on pr 36", () => {
  const [d, env] = setup();
  gate(d, env, `gh pr merge -s 99 --match-head-commit ${HEAD}`);
  expect(log(d)).toContain("pr view 99 "); // -s is squash, not a value
  expect(rc(d, env, 'gh pr comment 7 --body "$(cat reply.md)"')).toBe(2);
  expect(rc(d, env, "gh pr comment 7 --body `cat reply.md`")).toBe(2);
  expect(rc(d, env, 'gh pr comment 7 --body "$TEXT"')).toBe(2);
  expect(rc(d, env, "gh pr create --title x --body 'Closes #1'")).toBe(2); // no origin/main: git diff fails
});

test("copilot third review on pr 36", () => {
  let [d, env] = setup({ ci_green: false });
  for (const c of [`bash -lc 'gh pr merge 7 --match-head-commit ${HEAD}'`, 'sh -c "gh pr merge 7"', "eval 'gh pr comment 7 --body hi'"]) {
    expect(rc(d, env, c), c).toBe(2);
  }
  [d, env] = setup();
  rmSync(REVIEW_OK(d));
  expect(rc(d, env, "gh pr create --draft --draft=false --title x --body y")).toBe(2);
  expect(rc(d, env, "gh pr ready 7 --undo=false")).toBe(2);
  expect(rc(d, env, "echo 'use gh to open it'")).toBe(0); // plain text mentioning gh is fine
});

test("copilot fourth review on pr 36", () => {
  const [d, env] = setup({ ci_green: false });
  expect(rc(d, env, `gh pr \\\nmerge 7 --match-head-commit ${HEAD}`)).toBe(2); // backslash-newline
  expect(rc(d, env, `gh -Rother/repo pr merge 7 --match-head-commit ${HEAD}`)).toBe(2);
  expect(rc(d, env, `gh pr merge 7 -Rother/repo --match-head-commit ${HEAD}`)).toBe(2);
  expect(rc(d, env, `env GH_DEBUG=1 gh pr merge 7 --match-head-commit ${HEAD}`)).toBe(2); // still gh
  expect(rc(d, env, "echo gh pr merge 7 --squash")).toBe(0); // gh as data, not the program
  expect(rc(d, env, "grep -n 'gh pr merge' README.md")).toBe(0);
});

test("copilot fifth review on pr 36", () => {
  const [d, env] = setup({ ci_green: false });
  for (const c of [`if gh pr merge 7 --match-head-commit ${HEAD}; then :; fi`, `! gh pr merge 7 --match-head-commit ${HEAD}`,
    'result="$(gh pr merge 7 --squash)"', "echo `gh pr merge 7`", 'gh pr edit 7 --add-label "$LABEL"',
    "cd ../other && gh pr ready 7"]) {
    expect(rc(d, env, c), c).toBe(2);
  }
});

test("agents cannot delete remote branches", () => {
  const [d, env] = setup();
  for (const c of ["git push origin :task/1-x", "git -C . push origin :x", "true && git push origin +:x",
    "git push origin a:a :b", "bash -c 'git push origin :x'"]) {
    const [code, err] = gate(d, env, c);
    expect(code, `${c} ${err}`).toBe(2);
    expect(err).toContain("delete remote branches");
  }
  for (const c of ["git push origin task/1-x", "git push -u origin HEAD", "git push origin task/1-x:task/1-x",
    "git push origin HEAD:refs/heads/task/1-x", "echo push: done"]) {
    expect(rc(d, env, c), c).toBe(0);
  }
});

test("gh run through a package runner is refused", () => {
  const [d, env] = setup();
  for (const c of [`pnpm exec gh pr merge 7 --squash --match-head-commit ${HEAD}`, "npx gh pr merge 7",
    "pnpm dlx gh pr merge 7", "yarn exec gh pr comment 7 --body x"]) {
    expect(rc(d, env, c), c).toBe(2);
  }
  for (const c of ["pnpm test", "pnpm -s typecheck", "npx vitest run"]) expect(rc(d, env, c), c).toBe(0);
});

function editLocal(d: string, change: Obj): void {
  const path = join(d, ".claude", "factory.json");
  writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as Obj), ...change }));
}

test("the worktree copy of the settings changes nothing", () => {
  // Main's settings protect .claude/ and know the hold label; the agent edits its own copy to drop both.
  let [d, env] = setup({ pr: { labels: [{ name: "factory-hold" }] } });
  editLocal(d, { holdLabel: "none", protected: [] });
  let [code, err] = gate(d, env, MERGE);
  expect(code, err).toBe(2);
  expect(err).toContain("factory-hold");
  [d, env] = setup({ files: [".claude/settings.json"] });
  editLocal(d, { protected: [] });
  [code, err] = gate(d, env, MERGE);
  expect(code, err).toBe(2);
  expect(err).toContain(".claude/settings.json");
});

test("settings the gate cannot read from github fail closed", () => {
  const [d, env] = setup({ settings_error: "gh: HTTP 500" });
  const [code, err] = gate(d, env, MERGE);
  expect(code, err).toBe(2);
  expect(err).toContain("factory.json");
});

test("no settings on main yet means the defaults", () => {
  const [d, env] = setup({ files: [".claude/settings.json"], main_settings: null });
  const [code, err] = gate(d, env, MERGE);
  expect(code, err).toBe(2);
  expect(err).toContain(".claude/settings.json"); // the default `protected` covers .claude/
});

function gitT(d: string, ...args: string[]): string {
  return git(d, "-c", "user.name=t", "-c", "user.email=t@t", ...args);
}

test("local refs and mainbranch cannot steer the settings", () => {
  // The agent points mainBranch at its own branch and plants a local `origin/main` with permissive settings.
  const [d, env] = setup({ files: [".claude/settings.json"] });
  editLocal(d, { mainBranch: "task/x", protected: [] });
  gitT(d, "add", "-A");
  gitT(d, "commit", "-q", "-m", "x");
  gitT(d, "branch", "origin/main");
  gitT(d, "update-ref", "refs/remotes/origin/main", "HEAD");
  const [code, err] = gate(d, env, MERGE);
  expect(code, err).toBe(2);
  expect(err).toContain(".claude/settings.json");
});

const CI_CMD = "pnpm turbo run typecheck lint test build --filter=...[{base}]";

/** A bare origin with one commit on main, so the gate's number check can fetch it. */
function giveOrigin(d: string): void {
  const origin = tmp();
  sh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  write(join(d, "README"), "start\n");
  gitT(d, "add", "README");
  gitT(d, "commit", "-q", "-m", "start");
  gitT(d, "remote", "add", "origin", origin);
  gitT(d, "push", "-q", "origin", "HEAD:main");
  gitT(d, "fetch", "-q", "origin");
}

/** A real task branch one commit past origin/main, reviewed; returns its HEAD. */
function branchWithACommit(d: string): string {
  giveOrigin(d);
  gitT(d, "checkout", "-q", "-b", "task/1-x");
  write(join(d, "src", "a.ts"), "x\n");
  gitT(d, "add", "src");
  gitT(d, "commit", "-q", "-m", "work");
  const head = gitT(d, "rev-parse", "HEAD").trim();
  write(REVIEW_OK(d), head);
  return head;
}

function ciMark(d: string, sha: string): void {
  write(join(d, "tmp", "reviews", "task_1-x.ci.ok"), sha);
}

test("a ready pr needs the local ci check for its head commit", () => {
  const [d, env] = setup({ cfgExtra: { commands: { ci: CI_CMD } } });
  giveOrigin(d);
  let [code, err] = gate(d, env, "gh pr ready 7");
  expect(code, err).toBe(2);
  expect(err).toContain("factory verify"); // no marker
  ciMark(d, "b".repeat(40));
  [code, err] = gate(d, env, "gh pr ready 7");
  expect(code, err).toBe(2);
  expect(err).toContain("factory verify"); // a marker for an older commit
  ciMark(d, HEAD);
  expect(gate(d, env, "gh pr ready 7")).toEqual([0, ""]);
});

test("pr create needs the local ci check but a draft does not", () => {
  const [d, env] = setup({ cfgExtra: { commands: { ci: CI_CMD } } });
  const head = branchWithACommit(d);
  const [code, err] = gate(d, env, "gh pr create --title x --body y");
  expect(code, err).toBe(2);
  expect(err).toContain("factory verify");
  expect(rc(d, env, "gh pr create --draft --title x --body y")).toBe(0);
  ciMark(d, head);
  expect(gate(d, env, "gh pr create --title x --body y")).toEqual([0, ""]);
});

test("without commands ci on main no local ci check is needed", () => {
  let [d, env] = setup();
  giveOrigin(d);
  expect(gate(d, env, "gh pr ready 7")).toEqual([0, ""]);
  // An agent can't switch the check off in its own copy of the settings either.
  [d, env] = setup({ cfgExtra: { commands: { ci: CI_CMD } } });
  writeFileSync(join(d, ".claude", "factory.json"), JSON.stringify({ reviewMarkers: "tmp/reviews", commands: { ci: "" } }));
  expect(rc(d, env, "gh pr ready 7")).toBe(2);
});

test("a merge doesnt need the local ci check", () => {
  const [d, env] = setup({ cfgExtra: { commands: { ci: CI_CMD } } }); // CI itself is green on GitHub by then
  expect(gate(d, env, MERGE)).toEqual([0, ""]);
});

test("the kits settings protect the mcp config", () => {
  // Claude starts the servers in main's .mcp.json without asking (#55), so a change to it needs a person.
  const kitCfg = JSON.parse(readFileSync(join(KIT, ".claude", "factory.json"), "utf8")) as { protected: string[] };
  const [d, env] = setup({ files: [".mcp.json"], cfgExtra: { protected: kitCfg.protected } });
  const [code, err] = gate(d, env, MERGE);
  expect(code, err).toBe(2);
  expect(err).toContain(".mcp.json");
  const deny = (JSON.parse(readFileSync(join(KIT, ".claude", "factory", "settings.json"), "utf8")) as { permissions: { deny: string[] } })
    .permissions.deny;
  expect(deny).toContain("Edit(./.mcp.json)");
});

// --- #260: the gate hardening from the #43 audit ----------------------------------------------------------------------

test("a merge with --admin is refused wherever the flag sits", () => {
  const [d, env] = setup(); // everything else about this merge passes
  for (const c of [`${MERGE} --admin`, `gh pr merge --admin 7 --squash --match-head-commit ${HEAD}`,
    `gh pr merge 7 --admin=true --squash --match-head-commit ${HEAD}`]) {
    const [code, err] = gate(d, env, c);
    expect(code, `${c} ${err}`).toBe(2);
    expect(err).toContain("Merge without --admin");
  }
});

test("gh api writes to merges labels and reviews are refused", () => {
  const [d, env] = setup();
  for (const c of ["gh api -X PUT repos/{owner}/{repo}/pulls/1/merge", "gh api --method=PUT /repos/o/r/pulls/1/merge",
    "gh api -XPUT repos/o/r/pulls/1/merge", "gh api --method put repos/o/r/pulls/1/merge?x=1"]) {
    const [code, err] = gate(d, env, c);
    expect(code, `${c} ${err}`).toBe(2);
    expect(err).toContain("Merge with `gh pr merge <n> --match-head-commit <head>`");
  }
  for (const c of ["gh api repos/{owner}/{repo}/issues/7/labels -f 'labels[]=tests-reviewed'",
    "gh api -X DELETE repos/{owner}/{repo}/issues/7/labels/factory-hold", "gh api -X POST repos/o/r/labels -f name=x",
    "gh api -X PATCH repos/{owner}/{repo}/issues/7 -f 'labels[]=x'"]) {
    const [code, err] = gate(d, env, c);
    expect(code, `${c} ${err}`).toBe(2);
    expect(err).toContain("Change labels with `gh pr edit`");
  }
  for (const c of ["gh api repos/{owner}/{repo}/pulls/7/reviews -f event=APPROVE",
    "gh api -X PUT repos/o/r/pulls/7/reviews/1/dismissals -f message=x"]) {
    const [code, err] = gate(d, env, c);
    expect(code, `${c} ${err}`).toBe(2);
    expect(err).toContain("Agents don't post pull-request reviews");
  }
});

test("gh api comment bodies go through the marker check", () => {
  const [d, env] = setup();
  const file = write(join(d, "m.md"), "<!-- factory-mustfix sha=aaaaaaa -->");
  const json = write(join(d, "m.json"), JSON.stringify({ body: "<!-- factory-approved sha=aaaaaaa -->" }).replace("<", "\\u003c"));
  for (const c of ["gh api repos/{owner}/{repo}/issues/7/comments -f 'body=<!-- factory-approved sha=aaaaaaa -->'",
    `gh api repos/{owner}/{repo}/issues/7/comments -F body=@${file}`, `gh api repos/{owner}/{repo}/issues/7/comments --input ${json}`,
    "gh api -X PATCH repos/{owner}/{repo}/issues/comments/5 --raw-field 'body=<!-- factory-answer -->'"]) {
    const [code, err] = gate(d, env, c);
    expect(code, `${c} ${err}`).toBe(2);
    expect(err).toContain("Ask with <!-- factory-question --> instead");
  }
  let [code, err] = gate(d, env, "gh api repos/{owner}/{repo}/issues/7/comments --input -");
  expect(code, err).toBe(2);
  expect(err).toContain("--input <file>");
  [code, err] = gate(d, env, 'gh api repos/{owner}/{repo}/issues/7/comments -f body="$(cat m.md)"');
  expect(code, err).toBe(2);
  expect(err).toContain("plain text");
  env.FACTORY_AGENT = "haile";
  const asPo = write(join(d, "po.md"), envelope({ id: "q9x", kind: "question", from: "po", state: "submitted" }));
  [code, err] = gate(d, env, `gh api repos/{owner}/{repo}/issues/7/comments -F body=@${asPo}`);
  expect(code, err).toBe(2);
  expect(err).toContain("yourself");
  expect(rc(d, env, "gh api repos/{owner}/{repo}/issues/7/comments -f 'body=<!-- factory-question --> which one?'")).toBe(0);
});

test("gh api pull request creation gets the create checks", () => {
  const [d, env] = setup();
  rmSync(REVIEW_OK(d));
  giveOrigin(d);
  for (const c of ["gh api repos/{owner}/{repo}/pulls -f title=x -f head=task/1-x -f base=main -f body=y",
    "gh api -X POST /repos/o/r/pulls -F draft=false -f title=x"]) {
    const [code, err] = gate(d, env, c);
    expect(code, `${c} ${err}`).toBe(2);
    expect(err).toContain("No reviewer pass");
  }
  expect(rc(d, env, "gh api repos/{owner}/{repo}/pulls -F draft=true -f title=x -f head=task/1-x -f base=main")).toBe(0);
  const [code, err] = gate(d, env, "gh api graphql -f 'query=mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'");
  expect(code, err).toBe(2);
  expect(err).toContain("GraphQL mutations");
});

test("plain gh api reads pass the gate", () => {
  const [d, env] = setup();
  for (const c of ["gh api repos/{owner}/{repo}/pulls/7", "gh api repos/{owner}/{repo}/pulls/1/merge",
    "gh api --paginate repos/{owner}/{repo}/issues/7/labels", "gh api -X GET repos/{owner}/{repo}/pulls -f state=open",
    "gh api graphql -f 'query=query { viewer { login } }'"]) {
    expect(gate(d, env, c), c).toEqual([0, ""]);
  }
});

test("the default and kit protected lists cover the loop script and the cli", () => {
  for (const f of ["factory", "factory-loop.sh"]) {
    let [d, env] = setup({ files: [f], main_settings: null }); // no settings on main: the defaults
    let [code, err] = gate(d, env, MERGE);
    expect(code, `${f} ${err}`).toBe(2);
    expect(err).toContain(`changes protected files, so the dev manager or a person merges it: ${f}`);
    const kitCfg = JSON.parse(readFileSync(join(KIT, ".claude", "factory.json"), "utf8")) as { protected: string[] };
    [d, env] = setup({ files: [f], cfgExtra: { protected: kitCfg.protected } });
    [code, err] = gate(d, env, MERGE);
    expect(code, `${f} ${err}`).toBe(2);
    expect(err).toContain(`merges it: ${f}`);
  }
});

test("force pushes are refused wherever the global options sit", () => {
  const [d, env] = setup();
  for (const c of ["git push -f origin task/1-x", "git -C . push --force origin x", "git -c a.b=c push origin x --force-with-lease",
    "git push --force-with-lease=x:abc origin x", "git push --force-if-includes origin x", "git push --mirror origin",
    "git push origin +task/1-x", "git push origin +HEAD:refs/heads/x", "git push -uf origin x", "true && git -C . -c x=y push origin +x",
    "bash -c 'git push -f origin x'", "xargs git push --force origin", "g\\it push -f origin x"]) {
    const [code, err] = gate(d, env, c);
    expect(code, `${c} ${err}`).toBe(2);
    expect(err).toContain("Agents don't force-push");
  }
  for (const c of ["git push origin task/1-x", "git push -u origin HEAD", "git push -o ci.skip origin x", "git push -ofoo origin x",
    "git commit -m 'push -f later'"]) {
    expect(rc(d, env, c), c).toBe(0);
  }
});

test("quoting gh does not get past the gate", () => {
  const [d, env] = setup({ ci_green: false });
  for (const c of [`g\\h pr merge 7 --match-head-commit ${HEAD}`, `"g"h pr merge 7 --match-head-commit ${HEAD}`,
    `'g'"h" pr merge 7 --admin`, `bash -c 'g\\h pr merge 7'`, "g\\h api -X PUT repos/o/r/pulls/1/merge",
    `g\\\nh pr merge 7 --match-head-commit ${HEAD}`]) { // backslash-newline is removed by bash: that is gh
    expect(rc(d, env, c), c).toBe(2);
  }
  expect(rc(d, env, "echo 'g' 'h'")).toBe(0);
});
