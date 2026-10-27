// The 22 Oct lessons about claims and issues (from test_lessons.py, #252): a finished branch waiting for a PR slot, a
// long-running loop keeps its name, and only a real loop or Claude process holds one. The rest of that file (numbers,
// CI that never started, the gate) belongs to the gates family.
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isLoop, runsLoopScript } from "../hooks/factory_claims.ts";
import { read, runHook, sh, tmp, write, writeExe } from "./support.ts";

// Answers by path (without "repos/{owner}/{repo}/" and the query): "text" for calls with --jq, "json" for the others.
// Unknown paths fail, like a broken gh.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const dbPath = process.env.FAKE_GH_DB as string;
const db = JSON.parse(readFileSync(dbPath, "utf8"));
const a = process.argv.slice(2);
appendFileSync(dbPath + ".log", a.join(" ") + "\n");
function fail(t: string): never { process.stderr.write(t + "\n"); process.exit(1); }
function out(x: unknown): never { process.stdout.write(x + "\n"); process.exit(0); }
if (a[0] === "pr" && a[1] === "list") out(JSON.stringify(db.open_prs ?? []));
if (a[0] === "repo" && a[1] === "view") out("main");
if (a[0] !== "api") fail("fake gh: no answer for " + a.join(" "));
const rest = a.slice(1);
let path = "";
for (let k = 0; k < rest.length;) {
  const w = rest[k] as string;
  if (["-X", "-H", "--jq", "-f", "-F", "--input"].includes(w)) k += 2;
  else if (w.startsWith("-")) k += 1;
  else { path = w; break; }
}
const p = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/").pathname.slice(1).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
if (a.includes("--jq") && p in (db.text ?? {})) out(db.text[p]);
if (p in (db.json ?? {})) out(JSON.stringify(db.json[p]));
fail("fake gh: no answer for " + p);
`;

type Env = Record<string, string | undefined>;

function git(d: string, ...a: string[]): string {
  const p = sh(["git", ...a], { cwd: d });
  if (p.code !== 0) throw new Error(`git ${a.join(" ")}: ${p.out}`);
  return p.stdout.trim();
}

/** A clone with a commit on origin/main and a branch task/1-x, plus a fake gh. */
function project(cfg: Record<string, unknown>): [string, string, Env] {
  const root = tmp();
  const origin = join(root, "origin.git");
  const d = join(root, "work");
  sh(["git", "init", "-q", "--bare", "-b", "main", origin]);
  sh(["git", "clone", "-q", origin, d]);
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ reviewMarkers: "tmp/reviews", protected: [], alwaysAllowed: [],
    maxOpenPRs: 3, ...cfg }));
  write(join(d, "README.md"), "README.md");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "main");
  git(d, "push", "-q", "origin", "HEAD:main");
  git(d, "checkout", "-qb", "task/1-x");
  git(d, "commit", "-q", "--allow-empty", "-m", "task");
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  const db = write(join(root, "db.json"), JSON.stringify({ text: { pulls: "" } }));
  const env: Env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FAKE_GH_DB: db };
  delete env.FACTORY_AGENT;
  return [d, db, env];
}

function answers(db: string, kw: Record<string, Record<string, unknown>>): void {
  const data = JSON.parse(read(db)) as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(kw)) data[k] = { ...(data[k] ?? {}), ...v };
  write(db, JSON.stringify(data));
}

// --- a finished branch waiting for a PR slot --------------------------------------------------------------------

function pick(d: string, env: Env): [number, string, string] {
  const p = runHook("factory_issues", ["pick", "--agent", "taytu"], { cwd: d, env });
  return [p.code, p.stdout.trim(), p.stderr.trim()];
}

interface Pr { number: number; head: { ref: string; repo?: { full_name: string } }; draft: boolean; user: { login: string } }

function issuesProject(openPrs: Pr[], branchAhead = 3): [string, string, Env] {
  const [d, db, env] = project({ tasks: { source: "issues" }, agents: ["menelik", "taytu"], maxOpenPRs: 2 });
  const mine = { number: 107, title: "Demo guides", state: "open", body: "", milestone: null,
    labels: [{ name: "factory:in-progress" }, { name: "agent:taytu" }] };
  const ready = { number: 108, title: "Next", state: "open", body: "", milestone: null, labels: [{ name: "factory:ready" }] };
  answers(db, { json: { issues: [mine, ready], branches: [{ name: "task/107-demo-guides" }], pulls: openPrs,
    "issues/107/comments": [], "compare/main...task/107-demo-guides": { ahead_by: branchAhead }, user: { login: "owner" },
    "repos/{owner}/{repo}": { full_name: "deresegetachew/remanual" } } });
  return [d, db, env];
}

function pr(n: number, ref: string, draft = false, by = "owner"): Pr {
  return { number: n, head: { ref }, draft, user: { login: by } };
}

test("a pushed branch waits quietly while the cap is full", () => {
  const [d, db, env] = issuesProject([pr(115, "a"), pr(144, "b")]);
  const [, out, err] = pick(d, env);
  expect(out).toBe("none");
  expect(err).toContain("#107 is ready on its branch and waits for a pull-request slot (2 of 2 open: #115, #144)");
  expect(read(db + ".log")).not.toContain("issues/108/labels"); // it took no new work meanwhile
});

test("the issue comes back once a slot frees or a draft does not count", () => {
  const [d, , env] = issuesProject([pr(115, "a"), pr(144, "b", true)]);
  expect(pick(d, env)[1]).toBe("issue-107 Demo guides");
});

test("a branch still being built is not waiting", () => {
  const [d, , env] = issuesProject([pr(115, "a"), pr(144, "b")], 0);
  expect(pick(d, env)[1]).toBe("issue-107 Demo guides");
});

test("other accounts prs do not fill this accounts slots", () => {
  const [d, , env] = issuesProject([pr(115, "a", false, "someone-else"), pr(144, "b", false, "someone-else")]);
  expect(pick(d, env)[1]).toBe("issue-107 Demo guides");
});

test("a fork pr with the same branch name is not this branchs pr", () => {
  const fork = pr(200, "task/107-demo-guides");
  fork.head.repo = { full_name: "stranger/fork" };
  const [d, , env] = issuesProject([pr(115, "a"), pr(144, "b"), fork]);
  const [, out, err] = pick(d, env);
  expect(out).toBe("none");
  expect(err).toContain("waits for a pull-request slot");
});

test("a task waiting for a slot is not stale", () => {
  const [d, db, env] = issuesProject([pr(115, "a"), pr(144, "b")]);
  const data = JSON.parse(read(db)) as { json: Record<string, unknown> };
  (data.json.issues as Record<string, unknown>[])[0]!.updated_at = "2020-01-01T00:00:00Z";
  (data.json.branches as Record<string, unknown>[])[0]!.commit = { sha: "c1" };
  data.json["commits/c1"] = { commit: { committer: { date: "2020-01-01T00:00:00Z" } } };
  write(db, JSON.stringify(data));
  const p = runHook("factory_issues", ["stale"], { cwd: d, env });
  expect(p.stdout, p.out).not.toContain("#107");
});

// --- a long-running loop keeps its name -------------------------------------------------------------------------

function checkout(d: string, env: Env, pid: number): string {
  const p = runHook("factory_claims", ["checkout", "--pid", String(pid)], { cwd: d, env });
  return p.code === 0 ? (p.stdout.split(/\s+/)[0] as string) : p.stderr;
}

function spawn(cmd: string[]) {
  return Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

test("a loop running longer than claim stale hours keeps its name", async () => {
  const [d, , env] = project({ agents: ["menelik", "taytu"], claimStaleHours: 6 });
  // A stand-in for menelik's loop, still at its "next task in 10 s" prompt after 7 hours.
  const loop = spawn(["bash", "-c", "exec -a factory-loop.sh sleep 60"]);
  await Bun.sleep(100);
  try {
    expect(checkout(d, env, loop.pid)).toBe("menelik");
    const claims = join(git(d, "rev-parse", "--absolute-git-dir"), "factory", "claims.json");
    const data = JSON.parse(read(claims)) as { checkouts: Record<string, { at: number }> };
    (data.checkouts.menelik as { at: number }).at -= 7 * 3600;
    write(claims, JSON.stringify(data));
    expect(checkout(d, env, process.pid)).toBe("taytu"); // the second loop, not a second menelik
  } finally {
    loop.kill(9);
    await loop.exited;
  }
  expect(checkout(d, env, process.pid)).toBe("menelik"); // menelik's loop ended: its name is free again
});

test("a reused pid of another program does not hold a name", async () => {
  const [d, , env] = project({ agents: ["menelik", "taytu"] });
  const other = spawn(["sleep", "60"]);
  try {
    expect(checkout(d, env, other.pid)).toBe("menelik");
    expect(checkout(d, env, process.pid)).toBe("menelik"); // `sleep` is no loop: the old claim doesn't count
  } finally {
    other.kill(9);
    await other.exited;
  }
});

test("only a loop or claude by its program holds a name", async () => {
  const procs = [spawn(["bash", "-c", "exec -a factory-loop.sh sleep 30"]),
    spawn([process.execPath, "-e", "await Bun.sleep(30000)", "/home/claude/factory-loop.sh"])];
  await Bun.sleep(200);
  try {
    expect(isLoop(procs[0]!.pid)).toBe(true);
    expect(isLoop(procs[1]!.pid)).toBe(false); // "claude" and "factory-loop" only as arguments don't count
  } finally {
    for (const p of procs) p.kill(9);
  }
});

test("a loop in a folder with spaces is still a loop", async () => {
  const d = join(tmp(), "My Projects", "app");
  mkdirSync(d, { recursive: true });
  const script = write(join(d, "factory-loop.sh"), "sleep 30\n");
  const loop = spawn(["bash", script, "-i"]);
  await Bun.sleep(200);
  try {
    expect(isLoop(loop.pid)).toBe(true);
  } finally {
    loop.kill(9);
  }
});

test("the loop script is the shells first argument", () => {
  const spaced = join(tmp(), "My Projects", "app");
  write(join(spaced, "factory-loop.sh"), "");
  const cases: [string, boolean][] = [["factory-loop.sh -i", true], ["./factory-loop.sh", true], ["/x/factory-loop.sh 5", true],
    ["-x factory-loop.sh", true], [`${spaced}/factory-loop.sh -i`, true], ["/tmp/worker.sh /tmp/factory-loop.sh", false],
    ["worker.sh factory-loop.sh", false], ["-c echo factory-loop.sh", false], ["/no such/dir/factory-loop.sh -i", false], ["", false]];
  for (const [args, want] of cases) expect(runsLoopScript(args), args).toBe(want);
});
