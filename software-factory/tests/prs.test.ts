// `factory prs`: the one list a dev manager starts a pass from (#98), against a fake `gh` that answers from a scenario
// (recorded-style REST replies) and logs every call.
import { expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { judgeCi, OWNER_ASK, openQuestions } from "../hooks/factory_prs.ts";
import { HOOKS, SF, envWith, gitRepo, sh, tmp, write, writeExe, type Proc } from "./support.ts";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.PRS_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.PRS_LOG as string, a.join(" ") + "\n");
function fail(m: string): never { console.error(m); process.exit(1); }
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
const method = a.includes("-X") ? a[a.indexOf("-X") + 1] : "GET";
if (a[0] !== "api" || method !== "GET" || a.includes("--input") || a.includes("-f") || a.includes("-F")) fail("fake gh: prs must only read");
const raw = a.slice(1).filter((x) => !x.startsWith("-") && x !== "GET" && x !== "Accept: application/vnd.github+json")[0] as string;
const path = new URL(raw.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1);
if (path === "contents/.claude/factory.json") out(s.main_settings ?? {});
if ((s.broken ?? []).includes(path)) fail("gh: HTTP 403");
if (path in s) out(s[path]);
if (path === "branches") out([]);
fail("fake gh: no answer for " + path);
`;

const LONG_AGO = "2020-01-01T00:00:00Z";
const FAR = "2099-01-01T00:00:00Z";
const SHAS: Record<number, string> = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 1, (i + 1).toString(16).repeat(40)]));
const OLD = "0".repeat(40);
const CFG = { tasks: { source: "issues" }, agents: ["menelik", "taytu"] };
const MAIN = { tasks: { source: "issues" }, manager: { flakes: ["e2e"] }, protected: ["^\\.claude/"] };

type Row = Record<string, any>;

interface PrSpec {
  name: number;
  ci: Row[];
  comments: Row[];
  labels: string[];
  draft: boolean;
  branch: string;
  body: string;
  files: string[];
}

function run(name: number, ci: Row[] = [], comments: Row[] = [], o: Partial<PrSpec> = {}): PrSpec {
  return { name, ci, comments, labels: o.labels ?? [], draft: o.draft ?? false, branch: o.branch ?? `task/${name}-x`,
    body: o.body ?? "", files: o.files ?? ["src/a.py"] };
}

function check(name: string, conclusion: string | null = "success", status = "completed", id = 1): Row {
  return { id, name, status, conclusion };
}

function marker(kind: string, sha: string, at = "2020-01-01T01:00:00Z", extra = ""): Row {
  return { body: `<!-- ${kind} sha=${sha} ${extra}-->`, created_at: at };
}

function scenario(prs: Record<number, PrSpec>, extra: Row = {}): Row {
  const s: Row = { pulls: [], issues: [], "issues/comments": [] };
  for (const [k, p] of Object.entries(prs)) {
    const n = Number(k);
    const sha = SHAS[n] as string;
    s.pulls.push({ number: n, title: `Task ${n}`, draft: p.draft, body: p.body, html_url: `https://github.com/o/r/pull/${n}`,
      head: { sha, ref: p.branch }, labels: p.labels.map((x) => ({ name: x })) });
    s[`commits/${sha}`] = { commit: { committer: { date: LONG_AGO } } };
    s[`commits/${sha}/check-runs`] = { check_runs: p.ci };
    s[`issues/${n}/comments`] = p.comments;
    s[`pulls/${n}/files`] = p.files.map((f) => ({ filename: f }));
  }
  s.main_settings = MAIN;
  return { ...s, ...extra };
}

type Env = Record<string, string | undefined>;

function project(sc: Row, cfg: Row = CFG): [string, Env] {
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  write(join(root, "scenario.json"), JSON.stringify(sc));
  const env = envWith(join(root, "bin"), { PRS_SCENARIO: join(root, "scenario.json"), PRS_LOG: join(root, "log"),
    FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, CLAUDE_PROJECT_DIR: undefined });
  return [d, env];
}

function prs(sc: Row, ...args: string[]): [Env, Proc] {
  const [d, env] = project(sc);
  return [env, sh(["bash", join(SF, "factory"), "prs", ...args], { cwd: d, env })];
}

function pullsJson(sc: Row): [Map<number, Row>, Row] {
  const [, p] = prs(sc, "--json");
  expect(p.code, p.out).toBe(0);
  const out = JSON.parse(p.stdout) as Row;
  return [new Map((out.pulls as Row[]).map((x) => [x.number as number, x])), out];
}

const got1 = (sc: Row, n: number): Row => pullsJson(sc)[0].get(n) as Row;

// --- CI judged by the rule -------------------------------------------------------------------------------------

test("a rerun replaces a failure and a skipped job is ignored", () => {
  const ci = [check("test", "failure", "completed", 1), check("test", "success", "completed", 5), check("lint", "success", "completed", 2),
    check("deploy", "success", "completed", 3), check("deploy", "skipped", "completed", 9)]; // the skipped run is the newest one
  const p = got1(scenario({ 1: run(1, ci, [marker("factory-approved", SHAS[1] as string)]) }), 1);
  expect(p.ci.state).toBe("green");
  expect(p.ci.notGreen).toEqual([]);
  expect(p.next.action).toBe("merge");
});

test("a failed newest run is red and names the job", () => {
  const ci = [check("test", "success", "completed", 1), check("test", "failure", "completed", 5), check("lint", "success", "completed", 2)];
  const p = got1(scenario({ 1: run(1, ci) }), 1);
  expect(p.ci.state).toBe("red");
  expect(p.ci.notGreen).toEqual([{ name: "test", state: "red" }]);
});

test("running and queued and no runs", () => {
  const running = [check("a", "success", "completed", 1), check("b", null, "in_progress", 2), check("c", null, "queued", 3)];
  const queued = [check("a", "success", "completed", 1), check("c", null, "queued", 3)];
  const [got] = pullsJson(scenario({ 1: run(1, running), 2: run(2, queued), 3: run(3, [], [marker("factory-approved", SHAS[3] as string)]) }));
  expect(got.get(1)?.ci.state).toBe("running");
  expect(got.get(2)?.ci.state).toBe("queued");
  expect(new Set((got.get(1)?.ci.notGreen as Row[]).map((x) => x.name))).toEqual(new Set(["b", "c"]));
  expect(got.get(3)?.ci.state).toBe("none");
  expect(got.get(3)?.next.action).toBe("wait-ci");
});

// --- markers per sha -------------------------------------------------------------------------------------------

test("a marker for an older head does not count", () => {
  const p = got1(scenario({ 2: run(2, [check("t")], [marker("factory-approved", OLD)]) }), 2);
  expect(p.headMarker).toBeNull();
  expect(p.next.action).toBe("review");
  expect(p.markers).toEqual([{ kind: "factory-approved", sha: OLD, at: "2020-01-01T01:00:00Z", namesHead: false }]);
});

test("the newest marker per sha wins", () => {
  const cs = [marker("factory-mustfix", OLD, "2020-01-01T00:00:00Z"), marker("pr-watch", SHAS[1] as string, "2020-01-01T01:00:00Z"),
    marker("factory-mustfix", SHAS[1] as string, "2020-01-01T02:00:00Z"), marker("factory-approved", SHAS[1] as string, "2020-01-01T03:00:00Z")];
  const p = got1(scenario({ 1: run(1, [check("t")], cs) }), 1);
  expect(p.headMarker).toBe("factory-approved");
  expect((p.markers as Row[]).map((m) => [m.sha, m.kind])).toEqual([[OLD, "factory-mustfix"], [SHAS[1], "factory-approved"]]);
  expect(p.next.action).toBe("merge");
});

test("a must fix holds until an approval of the head follows", () => {
  const p = got1(scenario({ 1: run(1, [check("t")], [marker("factory-mustfix", SHAS[1] as string)]) }), 1);
  expect(p.headMarker).toBe("factory-mustfix");
  expect(p.next.action).toBe("waiting-for-agent");
});

test("an approval from a login main does not trust is ignored", () => {
  const c = { ...marker("factory-approved", SHAS[1] as string), user: { login: "someone-else" } };
  const sc = scenario({ 1: run(1, [check("t")], [c]) });
  sc.main_settings = { ...MAIN, trustedReviewers: ["manager-login"] };
  const p = got1(sc, 1);
  expect(p.headMarker).toBeNull();
  expect(p.next.action).toBe("review");
});

// --- next action -----------------------------------------------------------------------------------------------

test("a draft waits for its agent", () => {
  const p = got1(scenario({ 3: run(3, [check("t")], [], { draft: true }) }), 3);
  expect(p.draft).toBe(true);
  expect(p.next.action).toBe("waiting-for-agent");
  expect(p.next.text).toBe("waiting for agent");
});

test("a protected pr that is approved and green goes to the owner", () => {
  const p = got1(scenario({ 4: run(4, [check("t")], [marker("factory-approved", SHAS[4] as string)], { files: [".claude/factory.json", "src/a.py"] }) }), 4);
  expect(p.protected).toBe(true);
  expect(p.next).toEqual({ action: "owner-merges", text: "owner merges (protected)", reason: "protected" });
});

test("a pr that says a person merges it counts as protected", () => {
  const p = got1(scenario({ 4: run(4, [check("t")], [marker("factory-approved", SHAS[4] as string)], { body: "A person merges this one: CI" }) }), 4);
  expect(p.next.text).toBe("owner merges (protected)");
});

test("a pr the manager opened is never merged by the manager", () => {
  const p = got1(scenario({ 5: run(5, [check("t")], [], { branch: "chore/fix-ci" }) }), 5);
  expect(p.agentPr).toBe(false);
  expect(p.next).toEqual({ action: "owner-merges", text: "owner merges (own PR)", reason: "not-agent-pr" });
});

test("an unreviewed head needs a review even while ci runs", () => {
  expect(got1(scenario({ 1: run(1, [check("t", null, "in_progress")]) }), 1).next.text).toBe("review");
});

test("approved but ci still running waits for ci", () => {
  expect(got1(scenario({ 1: run(1, [check("t", null, "queued")], [marker("factory-approved", SHAS[1] as string)]) }), 1).next.text).toBe("wait CI");
});

test("a known flake failing for the first time is rerun a second failure is not", () => {
  const first = [check("e2e", "failure", "completed", 1), check("lint", "success", "completed", 2)];
  const again = [check("e2e", "failure", "completed", 1), check("e2e", "failure", "completed", 7), check("lint", "success", "completed", 2)];
  const other = [check("unit", "failure", "completed", 1)];
  const [got] = pullsJson(scenario({ 1: run(1, first, [marker("pr-watch", SHAS[1] as string)]),
    2: run(2, again, [marker("pr-watch", SHAS[2] as string)]), 3: run(3, other, [marker("pr-watch", SHAS[3] as string)]) }));
  expect(got.get(1)?.next.text).toBe("rerun flake");
  expect(got.get(2)?.next.text).toBe("waiting for agent");
  expect(got.get(3)?.next.text).toBe("waiting for agent");
});

test("a review that only watches leaves nothing to do", () => {
  const p = got1(scenario({ 1: run(1, [check("t")], [marker("pr-watch", SHAS[1] as string)]) }), 1);
  expect(p.headMarker).toBe("pr-watch");
  expect(p.next.text).toBe("none");
});

// --- review claims and holds -----------------------------------------------------------------------------------

function claim(manager: string, sha: string, until: string, at = "2020-01-01T01:00:00Z"): Row {
  return { body: `<!-- factory-review-claim manager=${manager} sha=${sha} until=${until} -->`, created_at: at };
}

test("an unexpired claim shows who and until when and the pr is held", () => {
  // claims are leases: recent comments, `until` shortly ahead (a claim never counts for long after its comment, #99)
  const t = (m: number): string => new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const until = t(15);
  const cs = [claim("ana", SHAS[7] as string, until, t(-2)), claim("ben", SHAS[7] as string, until, t(-1))];
  const p = got1(scenario({ 7: run(7, [check("t")], cs, { labels: ["factory-hold"] }) }), 7);
  expect(p.claim).toEqual({ manager: "ana", until, expired: false }); // the earliest unexpired claim wins
  expect(p.next.text).toBe("held by ana");
  expect(p.labels).toContain("factory-hold");
});

test("an expired claim or one for an older head is not a claim and a stale hold can be reviewed", () => {
  const cs = [claim("ana", SHAS[7] as string, LONG_AGO), claim("ben", OLD, FAR)];
  const p = got1(scenario({ 7: run(7, [check("t")], cs, { labels: ["factory-hold"] }) }), 7);
  expect(p.claim).toBeNull();
  expect(p.next.text).toBe("review");
  expect(p.staleHold).toBe(true);
});

test("a hold with no claim at all is held by a manager", () => {
  expect(got1(scenario({ 7: run(7, [check("t")], [], { labels: ["factory-hold"] }) }), 7).next.text).toBe("held by manager");
});

// --- the rest of the list --------------------------------------------------------------------------------------

test("questions owner asks and agents below the pull requests", () => {
  let k = 0;
  const ask = (slug: string, at: string): Row => ({ id: ++k, body: `<!-- factory-owner-ask id=${slug} -->\nthis needs your yes`,
    created_at: at, html_url: `https://github.com/o/r/issues/60#c-${slug}`, issue_url: "x/issues/60" });
  const reply = { id: 2, body: "yes, do it", created_at: "2020-01-01T02:00:00Z", html_url: "u", issue_url: "x/issues/60" };
  const q = (n: number, body: string, at: string): Row => ({ id: n * 10, body, created_at: at,
    html_url: `https://github.com/o/r/issues/${n}#c`, issue_url: `x/issues/${n}` });
  const sc = scenario({ 2: run(2, [check("t")], [{ body: "<!-- factory-question -->\nwhich?", created_at: LONG_AGO,
    html_url: "https://github.com/o/r/pull/2#c" }]) });
  sc.issues = [
    { number: 50, title: "A task", state: "open", labels: [], body: "" },
    { number: 60, title: "Dev manager: needs the owner", state: "open", labels: [], body: "" },
    { number: 90, title: "Agent: taytu · working", state: "open", labels: [{ name: "factory:agent" }],
      body: `<!-- factory-agent name=taytu status=working ping=${LONG_AGO} -->` },
    { number: 91, title: "Agent: menelik · working", state: "open", labels: [{ name: "factory:agent" }],
      body: `<!-- factory-agent name=menelik status=working ping=${FAR} -->` },
  ];
  sc["issues/comments"] = [
    q(50, "<!-- factory-question -->\nneeds a ruling", LONG_AGO),
    q(51, "<!-- factory-question -->\nold and closed", LONG_AGO), // #51 is not open: not listed
    q(50, "unrelated chat", "2020-01-02T00:00:00Z"),
  ];
  sc["issues/60/comments"] = [ask("a", "2020-01-01T01:00:00Z"), reply, ask("b", "2020-01-01T03:00:00Z")];
  sc.issues.push({ number: 7, title: "Stale", state: "open", body: "", updated_at: LONG_AGO, labels: [{ name: "factory:in-progress" }] });
  const [, p] = prs(sc, "--json");
  expect(p.code, p.out).toBe(0);
  const out = JSON.parse(p.stdout) as Row;
  expect(new Set((out.questions as Row[]).map((x) => `${x.kind}:${x.number}`))).toEqual(new Set(["pr:2", "issue:50"]));
  for (const x of out.questions as Row[]) {
    expect((x.url as string).startsWith("https://github.com/o/r/")).toBe(true);
    expect(x.ageMinutes > 1000).toBe(true);
  }
  expect((out.ownerAsks as Row[]).map((x) => x.id)).toEqual(["b"]);
  expect((out.agents as Row[]).map((x) => x.name)).toEqual(["taytu"]);
  expect(out.agents[0].status).toBe("silent");
  expect((out.staleTasks as Row[]).map((x) => x.number)).toEqual([7]);
});

test("owner asks carry forProduct and a state: open, owner or product (#352)", () => {
  const c = (n: number, body: string): Row => ({ id: n, body, created_at: `2020-01-01T0${n}:00:00Z`,
    html_url: `https://github.com/o/r/issues/60#c${n}`, issue_url: "x/issues/60" });
  const a = (slug: string, tag: string, n: number): Row => c(n, `<!-- factory-owner-ask id=${slug}${tag} -->\nthis needs your yes`);
  const po = (slug: string, n: number): Row => c(n, `<!-- factory-po-reply ask=${slug} -->\nmy reply`);
  const sc = scenario({});
  sc.issues = [{ number: 60, title: "Dev manager: needs the owner", state: "open", labels: [], body: "" }];
  sc["issues/60/comments"] = [
    a("plain", "", 1), a("fresh", " for=product", 2), a("waits", " for=product", 3), po("waits", 4),
    a("back", " for=product", 5), po("back", 6), c(7, "<!-- factory-owner-answer id=back -->\nno, do it so"),
    a("gone", " for=product", 8), c(9, "<!-- factory-owner-answer id=gone -->\nok"), // answered with no po reply: left out
  ];
  const [, p] = prs(sc, "--json");
  expect(p.code, p.out).toBe(0);
  const asks = new Map(((JSON.parse(p.stdout) as Row).ownerAsks as Row[]).map((x) => [x.id as string, x]));
  expect(asks.get("plain")).toMatchObject({ forProduct: false, state: "open" });
  expect(asks.get("fresh")).toMatchObject({ forProduct: true, state: "open" });
  expect(asks.get("waits")).toMatchObject({ forProduct: true, state: "owner" });
  expect(asks.get("back")).toMatchObject({ forProduct: true, state: "product" });
  expect(asks.has("gone")).toBe(false);
  const text = prs(sc)[1].stdout;
  expect(text).toMatch(/^ {2}waits waiting \d+ \w+ for the owner \(the product owner replied\): https:\/\/github\.com\/o\/r\/issues\/60#c3$/m);
  expect(text).toMatch(/^ {2}fresh waiting \d+ \w+ for the product owner: https:/m);
  expect(text).toMatch(/^ {2}back waiting \d+ \w+ for the product owner: https:/m);
  expect(text).toMatch(/^ {2}plain waiting \d+ \w+: https:/m);
});

test("one comment with two answer markers answers both asks, and one with two ask markers opens both (#357)", () => {
  const c = (n: number, body: string): Row => ({ id: n, body, created_at: `2020-01-01T0${n}:00:00Z`,
    html_url: `https://github.com/o/r/issues/60#c${n}`, issue_url: "x/issues/60" });
  const sc = scenario({});
  sc.issues = [{ number: 60, title: "Dev manager: needs the owner", state: "open", labels: [], body: "" }];
  sc["issues/60/comments"] = [
    c(1, "<!-- factory-owner-ask id=draft-limit for=product -->\nno draft limit?"),
    c(2, "<!-- factory-owner-ask id=free-visits for=product -->\nfree visits on starter?"),
    c(3, "<!-- factory-owner-answer id=draft-limit -->\n<!-- factory-owner-answer id=free-visits -->\nyes to both"),
    c(4, "<!-- factory-owner-ask id=one -->\n<!-- factory-owner-ask id=two -->\ntwo asks in one comment"),
  ];
  const [, p] = prs(sc, "--json");
  expect(p.code, p.out).toBe(0);
  const ids = ((JSON.parse(p.stdout) as Row).ownerAsks as Row[]).map((x) => x.id);
  expect(ids).toEqual(["one", "two"]);
});

test("a plain reply under a comment with two ask markers answers both (#357)", () => {
  const c = (n: number, body: string): Row => ({ id: n, body, created_at: `2020-01-01T0${n}:00:00Z`,
    html_url: `https://github.com/o/r/issues/60#c${n}`, issue_url: "x/issues/60" });
  const sc = scenario({});
  sc.issues = [{ number: 60, title: "Dev manager: needs the owner", state: "open", labels: [], body: "" }];
  sc["issues/60/comments"] = [
    c(1, "<!-- factory-owner-ask id=one -->\n<!-- factory-owner-ask id=two -->\ntwo asks in one comment"),
    c(2, "yes to both"),
  ];
  const [, p] = prs(sc, "--json");
  expect(p.code, p.out).toBe(0);
  expect(((JSON.parse(p.stdout) as Row).ownerAsks as Row[]).map((x) => x.id)).toEqual([]);
});

test("plain text is compact and has every part", () => {
  const p1 = run(1, [check("t")], [marker("factory-approved", SHAS[1] as string)], { labels: ["agent:taytu"] });
  const p2 = run(2, [check("lint", "failure")], [], { draft: true });
  const [, p] = prs(scenario({ 1: p1, 2: p2 }));
  expect(p.code, p.out).toBe(0);
  const out = p.stdout;
  for (const w of ["#1 ", "merge", "#2 ", "waiting for agent", "CI red (lint)", "CI green", "draft", "agent:taytu", (SHAS[1] as string).slice(0, 7),
    "Questions", "Owner asks", "Agents"]) {
    expect(out).toContain(w);
  }
  expect(out.replace(/\n$/, "").split("\n").length < 40).toBe(true);
});

test("an empty repo says so", () => {
  const [, p] = prs(scenario({}));
  expect(p.code).toBe(0);
  expect(p.stdout.toLowerCase()).toContain("no open pull requests");
});

// --- read-only, REST only, errors ------------------------------------------------------------------------------

test("it only reads through the rest api", () => {
  const [env] = prs(scenario({ 1: run(1, [check("t")], [marker("factory-approved", SHAS[1] as string)]) }));
  const calls = readFileSync(env.PRS_LOG as string, "utf8").split("\n").filter((l) => l);
  const reads = calls.filter((c) => !c.startsWith("repo view --json defaultBranchRef"));
  expect(reads.length > 0).toBe(true);
  for (const c of reads) expect(c.startsWith("api ") && (!c.includes(" -X ") || c.includes(" -X GET ")), c).toBe(true);
  expect(calls.some((c) => c.startsWith("pr ") || c.includes("graphql"))).toBe(false);
});

test("a pr that cannot be read does not hide the others", () => {
  const sc = scenario({ 1: run(1, [check("t")]), 2: run(2, [check("t")]) });
  sc.broken = [`commits/${SHAS[2]}/check-runs`];
  const [got] = pullsJson(sc);
  expect(got.get(1)?.ci.state).toBe("green");
  expect(got.get(2)?.ci.state).toBe("unknown");
  expect(got.get(2)?.next.action).toBe("none");
  expect("error" in (got.get(2)?.next as Row)).toBe(true);
});

test("a section github cannot answer says so", () => {
  const sc = scenario({ 1: run(1, [check("t")]) });
  sc.broken = ["issues/comments"];
  const [, p] = prs(sc);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("can't read");
});

test("status uses the same ci rule", () => {
  const ci = [check("test", "failure", "completed", 1), check("test", "success", "completed", 5), check("deploy", "skipped", "completed", 9)];
  const sc = scenario({ 1: run(1, ci, [marker("factory-approved", SHAS[1] as string)]) });
  sc["actions/runs"] = { workflow_runs: [] };
  const [d, env] = project(sc);
  const p = sh(["bash", join(SF, "factory"), "status", "--json"], { cwd: d, env });
  expect((JSON.parse(p.stdout) as Row).pulls.pulls[0].ci, p.out).toBe("green");
});

test("the judging functions directly", () => {
  expect(judgeCi([])).toEqual(["none", []]);
  const [state, bad] = judgeCi([check("x", "failure", "completed", 2), check("x", "success", "completed", 3)]);
  expect(state).toBe("green");
  expect(bad).toEqual([]);
  expect(openQuestions([{ body: "<!-- factory-question -->" }, { body: "<!-- factory-answer -->" }])).toEqual([]);
});

test("a must fix without a commit is kept apart from the pinned markers", () => {
  const cs = [marker("factory-approved", SHAS[1] as string), { body: "<!-- factory-mustfix -->\nfix it", created_at: "2020-01-02T00:00:00Z" }];
  const p = got1(scenario({ 1: run(1, [check("t")], cs) }), 1);
  expect(new Set((p.markers as Row[]).map((m) => m.kind))).toEqual(new Set(["factory-approved", "factory-mustfix"]));
  expect(p.next.text).toBe("waiting for agent"); // it holds the merge, as at the gate
});

test("asks tagged for product are read by the dev manager side too", () => {
  // (from test_product_owner.py; the orchestrator's side stays there until factory_orchestrator is ported)
  const ask = (slug: string, tag = ""): string => `<!-- factory-owner-ask id=${slug}${tag ? " " + tag : ""} -->\nthis needs your yes: renumber the PRD stories?`;
  expect(OWNER_ASK.exec(ask("renumber", "for=product"))?.[1]).toBe("renumber");
  expect(OWNER_ASK.exec(ask("plain"))?.[1]).toBe("plain");
});

test("settings lists the flake list", () => {
  const [d, env] = project(scenario({}));
  const p = sh([process.execPath, "--no-env-file", join(HOOKS, "factory_settings.ts"), "show", "manager.flakes"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("manager.flakes");
});
