// The owner's commands (#302): `factory owner merge|label|answer|release`. Runs hooks/factory_owner.ts in a throwaway
// project (roles_support.ts) with a small dedicated fake `gh` (a JSON db and a log of every call) and a real local bare
// origin for the release tags. The tests run inside a factory agent session, so every command gets a cleaned env.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT, project, type Row } from "./roles_support.ts";
import { type Proc, SF, sh, WIKI, writeExe } from "./support.ts";

type Env = Record<string, string | undefined>;

const SHA = "0123456789abcdef0123456789abcdef01234567";
const QUEUE = "Dev manager: needs the owner";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const file = process.env.FAKE_DB as string;
const db = JSON.parse(readFileSync(file, "utf8"));
const valueFlags = new Set(["-X", "--method", "-H", "--header", "--input", "-q", "--jq", "-f", "-F", "--json"]);
let stdin = "";
if (a.includes("--input")) stdin = await Bun.stdin.text();
appendFileSync(process.env.FAKE_LOG as string, JSON.stringify({ argv: a, stdin }) + "\n");
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
const fail = (m: string): never => { process.stderr.write(m + "\n"); process.exit(1); };
const save = () => writeFileSync(file, JSON.stringify(db));
if (a[0] === "repo" && a[1] === "view") { console.log(db.main ?? "main"); process.exit(0); }
if (a[0] === "pr" && a[1] === "merge") {
  if (db.mergeFails) fail("merge failed: base branch policy prohibits the merge");
  (db.merged ??= []).push(a.slice(2)); save(); process.exit(0);
}
if (a[0] !== "api") fail("unexpected gh " + a.join(" "));
let method = "GET"; let path = "";
for (let i = 1; i < a.length; i++) {
  const x = a[i] as string;
  if (x === "-X" || x === "--method") method = a[++i] as string;
  else if (valueFlags.has(x)) i++;
  else if (x.startsWith("-")) continue;
  else if (!path) path = x;
}
const u = new URL(path.replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = decodeURIComponent(u.pathname.slice(1)); const page = Number(u.searchParams.get("page") ?? "1");
const paged = (xs: unknown[]) => out(a.includes("--paginate") || page === 1 ? xs : []);
let m: RegExpExecArray | null;
if (p === "contents/.claude/factory.json") {
  if (db.factoryJson == null) fail("gh: Not Found (HTTP 404)");
  console.log(db.factoryJson); process.exit(0);
}
if ((m = /^pulls\/(\d+)$/.exec(p))) { const pr = db.prs?.[m[1] as string]; if (!pr) fail("gh: Not Found (HTTP 404)"); out(pr); }
if ((m = /^pulls\/(\d+)\/files$/.exec(p))) paged((db.files?.[m[1] as string] ?? []).map((f: string) => ({ filename: f })));
if ((m = /^commits\/([0-9a-f]+)\/check-runs$/.exec(p))) out({ check_runs: db.checkRuns?.[m[1] as string] ?? [] });
if ((m = /^commits\/([0-9a-f]+)\/status$/.exec(p))) out({ statuses: db.statuses?.[m[1] as string] ?? [] });
if (p === "labels" && method === "GET") paged((db.labels ?? []).map((name: string) => ({ name })));
if (p === "issues" && method === "GET") paged((db.issues ?? []).filter((i: { state: string }) => i.state === "open"));
if ((m = /^issues\/(\d+)\/comments$/.exec(p))) {
  const n = m[1] as string;
  if (method === "POST") { (db.posted ??= []).push({ issue: n, body: JSON.parse(stdin).body }); save(); out({ id: 1 }); }
  paged((db.comments?.[n] ?? []).map((c: string | { body: string }) => (typeof c === "string" ? { body: c } : c)));
}
if ((m = /^issues\/(\d+)\/labels$/.exec(p)) && method === "POST") { (db.labelled ??= []).push({ issue: m[1], ...JSON.parse(stdin) }); save(); out([]); }
if ((m = /^issues\/(\d+)\/labels\/(.+)$/.exec(p)) && method === "DELETE") { (db.unlabelled ??= []).push({ issue: m[1], label: m[2] }); save(); out([]); }
if ((m = /^issues\/(\d+)$/.exec(p)) && method === "GET") {
  const i = (db.issues ?? []).find((x: { number: number }) => String(x.number) === m![1]);
  if (!i) fail("gh: Not Found (HTTP 404)"); out(i);
}
fail("gh: Not Found (HTTP 404) for " + method + " " + path);
`;

const GREEN = [{ name: "build", status: "completed", conclusion: "success", started_at: "2026-10-25T10:00:00Z", id: 1 }];

interface Rig { d: string; work: string; env: Env }
interface Db { prs?: Row; files?: Row; comments?: Row; checkRuns?: Row; statuses?: Row; labels?: string[]; issues?: Row[]; factoryJson?: string | null;
  mergeFails?: boolean }

function pr(n: number, over: Row = {}): Row {
  return { number: n, state: "open", draft: false, mergeable: true, mergeable_state: "clean", title: "A change",
    head: { sha: SHA, ref: "task/x" }, body: "", ...over };
}

function rig(db: Db = {}, files: Record<string, string> = {}): Rig {
  const [d, work, base] = project({ files });
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  writeFileSync(join(d, "db.json"), JSON.stringify({ main: "main", ...db }));
  const env: Env = { ...base, FAKE_DB: join(d, "db.json"), FAKE_LOG: join(d, "gh.log") };
  writeFileSync(join(d, "gh.log"), "");
  return { d, work, env };
}

const OWNER: Env = {};
const OWNER_SESSION: Env = { CLAUDECODE: "1" };
const MANAGER: Env = { FACTORY_AGENT: "lead", FACTORY_ROLE: "dev-manager" };
const MANAGER_LOOP: Env = { FACTORY_LOOP: "1", FACTORY_ROLE: "dev-manager" };
const CODER: Env = { FACTORY_AGENT: "menelik" };
const CODER_ROLE: Env = { FACTORY_AGENT: "menelik", FACTORY_ROLE: "coding-agent" };
const PO: Env = { FACTORY_AGENT: "eleni", FACTORY_ROLE: "product-owner" };

function owner(r: Rig, who: Env, ...args: string[]): Proc {
  const env: Env = { ...r.env };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "FACTORY_ROLE", "FACTORY_NAME", "FACTORY_ITEM", "CLAUDECODE"]) delete env[k];
  Object.assign(env, who);
  return sh([process.execPath, "--no-env-file", "--config=/dev/null", join(r.work, ".claude", "hooks", "factory_owner.ts"), ...args],
    { cwd: r.work, env });
}

interface Call { argv: string[]; stdin: string }
function calls(r: Rig): Call[] {
  return readFileSync(join(r.d, "gh.log"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Call);
}
const merges = (r: Rig) => calls(r).filter((c) => c.argv[0] === "pr" && c.argv[1] === "merge");
const writes = (r: Rig) => calls(r).filter((c) => (c.argv[0] === "pr" && c.argv[1] === "merge")
  || (c.argv[0] === "api" && c.argv.some((x, i) => (x === "-X" && c.argv[i + 1] !== "GET"))));

function dbOf(r: Rig): Record<string, unknown[]> {
  return JSON.parse(readFileSync(join(r.d, "db.json"), "utf8")) as Record<string, unknown[]>;
}

function err(p: Proc): { code: string; message: string; fix: string } {
  const line = p.stderr.trim().split("\n").filter((l) => l !== "").pop() ?? "";
  return JSON.parse(line) as { code: string; message: string; fix: string };
}

function refused(p: Proc, code: string): void {
  expect(p.code, p.out).toBe(1);
  const e = err(p);
  expect(e.code).toBe(code);
  expect(e.message.length).toBeGreaterThan(0);
  expect(e.fix.length).toBeGreaterThan(0);
}

function openPr(over: Row = {}, n = 7, db: Db = {}, files: Record<string, string> = {}): Rig {
  return rig({ prs: { [n]: pr(n, over) }, files: { [n]: ["src/a.ts"] }, checkRuns: { [SHA]: GREEN }, ...db }, files);
}

// --- who may run it --------------------------------------------------------------------------------------------------

test("the owner, also in their own Claude session, can merge", () => {
  for (const who of [OWNER, OWNER_SESSION]) {
    const r = openPr();
    const p = owner(r, who, "merge", "7");
    expect(p.code, p.out).toBe(0);
    expect(merges(r)).toHaveLength(1);
  }
});

const SUBS: string[][] = [["merge", "7"], ["label", "7", "factory:blocked"], ["answer", "renumber", "yes"], ["release", "1.2.3"]];

test("a coding agent or product owner is refused every subcommand with owner_only and nothing is asked of gh or git", () => {
  for (const who of [CODER, CODER_ROLE, PO]) {
    for (const sub of SUBS) {
      const r = openPr({}, 7, { labels: ["factory:blocked"], issues: [{ number: 7, state: "open", title: "x" }] });
      const p = owner(r, who, ...sub);
      refused(p, "owner_only");
      expect(calls(r)).toEqual([]);
      expect(sh(["git", "-C", r.work, "tag", "--list"]).stdout).toBe("");
      expect(sh(["git", "-C", join(r.d, "origin.git"), "tag", "--list"]).stdout).toBe("");
    }
  }
});

test("the dev manager (agent or loop) cannot answer or release: those are the owner's", () => {
  for (const who of [MANAGER, MANAGER_LOOP]) {
    for (const sub of [["answer", "renumber", "yes"], ["release", "1.2.3"]]) {
      const r = rig({ issues: [{ number: 40, state: "open", title: QUEUE }] }, { "software-factory/VERSION": "1.2.3\n" });
      refused(owner(r, who, ...sub), "owner_only");
      expect(writes(r)).toEqual([]);
      expect(sh(["git", "-C", join(r.d, "origin.git"), "tag", "--list"]).stdout).toBe("");
    }
  }
});

// --- merge -----------------------------------------------------------------------------------------------------------

test("merge pins the merge to the full head sha, names the protected paths first and prints what it merged", () => {
  const r = openPr({}, 7, { factoryJson: JSON.stringify({ protected: ["^\\.github/", "^CLAUDE\\.md$", "^docs/"], alwaysAllowed: ["docs/build-plan.md"] }),
    files: { "7": ["src/a.ts", ".github/workflows/ci.yml", "CLAUDE.md", "docs/build-plan.md"] } });
  const p = owner(r, OWNER, "merge", "7");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Protected paths: .github/workflows/ci.yml, CLAUDE.md");
  expect(p.stdout).not.toContain("build-plan");
  expect(p.stdout).toContain(`Merged #7 at ${SHA.slice(0, 12)}.`);
  expect(p.stdout.indexOf("Protected paths")).toBeLessThan(p.stdout.indexOf("Merged #7"));
  const m = merges(r);
  expect(m).toHaveLength(1);
  expect(m[0]?.argv).toEqual(["pr", "merge", "7", "--squash", "--delete-branch", "--match-head-commit", SHA]);
});

test("merge says 'Protected paths: none' when no path matches", () => {
  const r = openPr({}, 7, { factoryJson: JSON.stringify({ protected: ["^\\.github/"] }) });
  const p = owner(r, OWNER, "merge", "7");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Protected paths: none");
});

test("merge refuses a PR that does not exist, is closed or is a draft, and merges nothing", () => {
  const cases: [Rig, string][] = [
    [rig({}), "no_such_pr"],
    [openPr({ state: "closed" }), "pr_not_open"],
    [openPr({ draft: true }), "pr_draft"],
  ];
  for (const [r, code] of cases) {
    refused(owner(r, OWNER, "merge", "7"), code);
    expect(merges(r)).toEqual([]);
  }
});

test("merge refuses failed CI, pending CI and a PR with no CI runs yet", () => {
  const run = (conclusion: string | null, status = "completed") => [{ name: "build", status, conclusion, started_at: "2026-10-25T10:00:00Z", id: 1 }];
  const cases: [Db["checkRuns"], string][] = [
    [{ [SHA]: run("failure") }, "checks_failed"],
    [{ [SHA]: run(null, "in_progress") }, "checks_pending"],
    [{}, "checks_pending"],
  ];
  for (const [checkRuns, code] of cases) {
    const r = openPr({}, 7, { checkRuns });
    refused(owner(r, OWNER, "merge", "7"), code);
    expect(merges(r)).toEqual([]);
  }
});

test("merge refuses a PR GitHub says cannot be merged (conflicts)", () => {
  for (const over of [{ mergeable: false }, { mergeable_state: "dirty" }]) {
    const r = openPr(over);
    refused(owner(r, OWNER, "merge", "7"), "not_mergeable");
    expect(merges(r)).toEqual([]);
  }
});

test("merge reports merge_failed when gh pr merge itself fails", () => {
  const r = openPr({}, 7, { mergeFails: true });
  const p = owner(r, OWNER, "merge", "7");
  refused(p, "merge_failed");
  expect(merges(r)).toHaveLength(1);
});

const PROTECTED_DB: Db = { factoryJson: JSON.stringify({ protected: ["^\\.github/"] }), files: { "7": [".github/workflows/ci.yml"] } };
const approval = (sha = SHA) => ({ body: `<!-- factory-approved sha=${sha} -->`, user: { login: "lead" } });

test("the owner may merge a PR with protected paths and sees them listed", () => {
  const r = openPr({}, 7, PROTECTED_DB);
  const p = owner(r, OWNER, "merge", "7");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Protected paths: .github/workflows/ci.yml");
  expect(merges(r)).toHaveLength(1);
});

test("the dev manager may not merge a PR with protected paths, even approved: protected_owner_merges names them", () => {
  const r = openPr({}, 7, { ...PROTECTED_DB, comments: { "7": [approval()] } });
  const p = owner(r, MANAGER, "merge", "7");
  refused(p, "protected_owner_merges");
  expect(err(p).message).toContain(".github/workflows/ci.yml");
  expect(merges(r)).toEqual([]);
});

test("the dev manager's merge goes through the manager gate: no approval comment means gate_refused", () => {
  for (const who of [MANAGER, MANAGER_LOOP]) {
    const r = openPr();
    const p = owner(r, who, "merge", "7");
    refused(p, "gate_refused");
    expect(err(p).message).toContain("factory-approved");
    expect(merges(r)).toEqual([]);
  }
});

test("the dev manager merges a PR with an approval for the head and green CI", () => {
  const r = openPr({}, 7, { comments: { "7": [approval()] } });
  const p = owner(r, MANAGER, "merge", "7");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`Merged #7 at ${SHA.slice(0, 12)}.`);
  expect(merges(r)[0]?.argv).toContain(SHA);
});

test("the dev manager's merge is refused by the gate when the approval is for an older head", () => {
  const r = openPr({}, 7, { comments: { "7": [approval("fedcba9876543210")] } });
  refused(owner(r, MANAGER, "merge", "7"), "gate_refused");
  expect(merges(r)).toEqual([]);
});

// --- label -----------------------------------------------------------------------------------------------------------

const LABELLED: Db = { labels: ["factory:ready", "factory:blocked"], issues: [{ number: 12, state: "open", title: "A task", labels: [] }] };

test("label adds a label to an issue with one POST of {labels: [...]}", () => {
  const r = rig(LABELLED);
  const p = owner(r, OWNER, "label", "12", "factory:blocked");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("#12: added factory:blocked.");
  const post = calls(r).find((c) => c.argv.includes("POST") && c.argv.some((x) => x.endsWith("issues/12/labels")));
  expect(post).toBeDefined();
  expect(JSON.parse(post?.stdin ?? "null")).toEqual({ labels: ["factory:blocked"] });
});

test("label --remove deletes the label, url-quoted", () => {
  const r = rig(LABELLED);
  const p = owner(r, OWNER, "label", "12", "factory:blocked", "--remove");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("#12: removed factory:blocked.");
  const del = calls(r).find((c) => c.argv.includes("DELETE"));
  expect(del?.argv.some((x) => x.endsWith("issues/12/labels/factory%3Ablocked"))).toBe(true);
});

test("label refuses a label the repository does not have and writes nothing", () => {
  const r = rig(LABELLED);
  const p = owner(r, OWNER, "label", "12", "factory:nonsense");
  refused(p, "no_such_label");
  expect(err(p).fix).toContain("factory issues setup");
  expect(writes(r)).toEqual([]);
});

test("label refuses an item that does not exist", () => {
  const r = rig(LABELLED);
  refused(owner(r, OWNER, "label", "99", "factory:blocked"), "no_such_item");
  expect(writes(r)).toEqual([]);
});

test("the dev manager can label when the manager gate allows the command", () => {
  const r = rig(LABELLED);
  const p = owner(r, MANAGER, "label", "12", "factory:blocked");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("#12: added factory:blocked.");
});

// --- answer ----------------------------------------------------------------------------------------------------------

const ask = (id: string) => `<!-- factory-owner-ask id=${id} -->\nquestion ${id}?`;
const queue = (...comments: string[]): Db => ({ issues: [{ number: 40, state: "open", title: QUEUE }, { number: 41, state: "open", title: QUEUE + " (a PR)", pull_request: {} }],
  comments: { "40": comments } });

test("answer posts a marked comment on the owner-queue issue", () => {
  const r = rig(queue(ask("renumber"), ask("palette")));
  const p = owner(r, OWNER, "answer", "palette", "Use the blue one");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Answered palette on #40.");
  const posted = dbOf(r).posted as { issue: string; body: string }[];
  expect(posted).toHaveLength(1);
  expect(posted[0]?.issue).toBe("40");
  expect(posted[0]?.body.startsWith("<!-- factory-owner-answer id=palette -->")).toBe(true);
  expect(posted[0]?.body).toContain("Use the blue one");
});

test("answer without an owner queue says no_owner_queue", () => {
  const r = rig({ issues: [{ number: 5, state: "open", title: "Something else" }] });
  refused(owner(r, OWNER, "answer", "x", "y"), "no_owner_queue");
  expect(writes(r)).toEqual([]);
});

test("answer for an unknown id says no_such_ask and lists the open ids", () => {
  const r = rig(queue(ask("renumber"), ask("palette")));
  const p = owner(r, OWNER, "answer", "nope", "text");
  refused(p, "no_such_ask");
  expect(err(p).message).toContain("renumber");
  expect(err(p).message).toContain("palette");
  expect(dbOf(r).posted).toBeUndefined();
});

test("answer for an ask that already has an answer says so, posts nothing and exits 0", () => {
  const r = rig(queue(ask("renumber"), "<!-- factory-owner-answer id=renumber -->\nyes", ask("palette"), "blue then"));
  for (const id of ["renumber", "palette"]) {
    const p = owner(r, OWNER, "answer", id, "again");
    expect(p.code, p.out).toBe(0);
    expect(p.stdout.toLowerCase()).toContain("already answered");
  }
  expect(dbOf(r).posted).toBeUndefined();
});

test("answer with empty text says needs_text", () => {
  const r = rig(queue(ask("renumber")));
  refused(owner(r, OWNER, "answer", "renumber", "  "), "needs_text");
  expect(dbOf(r).posted).toBeUndefined();
});

// --- release ---------------------------------------------------------------------------------------------------------

const VERSION_FILE = { "software-factory/VERSION": "1.2.3\n" };
const originOf = (r: Rig) => join(r.d, "origin.git");
const tags = (dir: string) => sh(["git", "-C", dir, "tag", "--list"], { env: { ...process.env, ...GIT } }).stdout.trim();

test("release rejects a string that is not a version", () => {
  const r = rig({}, VERSION_FILE);
  for (const v of ["1.2", "latest", "1.2.3.4", "v1.x.3"]) refused(owner(r, OWNER, "release", v), "bad_version");
  expect(tags(originOf(r))).toBe("");
});

test("release with a version that differs from VERSION on origin/main changes nothing", () => {
  const r = rig({}, VERSION_FILE);
  const p = owner(r, OWNER, "release", "1.2.4");
  refused(p, "version_mismatch");
  expect(err(p).message).toContain("1.2.4");
  expect(err(p).message).toContain("1.2.3");
  expect(tags(r.work)).toBe("");
  expect(tags(originOf(r))).toBe("");
});

test("release with no VERSION file on main says no_version_file", () => {
  const r = rig({});
  refused(owner(r, OWNER, "release", "1.2.3"), "no_version_file");
  expect(tags(originOf(r))).toBe("");
});

test("release tags origin/main's commit with an annotated tag vX.Y.Z and pushes it", () => {
  const r = rig({}, VERSION_FILE);
  const head = sh(["git", "-C", r.work, "rev-parse", "origin/main"]).stdout.trim();
  const p = owner(r, OWNER, "release", "1.2.3");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`Tagged v1.2.3 at ${head.slice(0, 12)}`);
  const origin = originOf(r);
  expect(tags(origin)).toBe("v1.2.3");
  expect(sh(["git", "-C", origin, "cat-file", "-t", "v1.2.3"]).stdout.trim()).toBe("tag");
  expect(sh(["git", "-C", origin, "rev-parse", "v1.2.3^{commit}"]).stdout.trim()).toBe(head);
});

test("release accepts vX.Y.Z and, run again, says it is already published", () => {
  const r = rig({}, VERSION_FILE);
  expect(owner(r, OWNER, "release", "v1.2.3").code).toBe(0);
  const again = owner(r, OWNER, "release", "1.2.3");
  expect(again.code, again.out).toBe(0);
  expect(again.stdout.toLowerCase()).toContain("already published");
  expect(tags(originOf(r))).toBe("v1.2.3");
});

// --- usage and docs --------------------------------------------------------------------------------------------------

test("with no arguments or help it prints the usage and exits 0", () => {
  const r = rig({});
  for (const args of [[], ["help"]]) {
    const p = owner(r, OWNER, ...args);
    expect(p.code, p.out).toBe(0);
    for (const sub of ["merge", "label", "answer", "release"]) expect(p.stdout).toContain(sub);
  }
});

test("an unknown subcommand is unknown_command with exit 2", () => {
  const r = rig({});
  const p = owner(r, OWNER, "explode");
  expect(p.code, p.out).toBe(2);
  expect(err(p).code).toBe("unknown_command");
});

test("factory help and the wiki's commands page list the owner commands", () => {
  const r = rig({});
  const help = sh(["bash", join(SF, "factory"), "help"], { cwd: r.work, env: { ...r.env, FACTORY_AGENT: undefined, FACTORY_LOOP: undefined } });
  const page = readFileSync(join(WIKI, "commands.md"), "utf8");
  for (const sub of ["merge", "label", "answer", "release"]) {
    expect(help.out, help.out).toContain(`owner ${sub}`);
    expect(page).toContain(`factory owner ${sub}`);
  }
});
