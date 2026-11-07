// A project on the message board (#500, decision 0007 point 10), as its agents and commands use it, against a real
// Postgres: with `tasks.source: "board"`, `factory next` shows the next task and claims nothing, a loop's pick claims on
// the board (the token kept in the project's state folder, mode 600), a builder's release, review and done land there,
// and the factory's messages go there too. With `messaging.transport: "board"`, claims, wake-ups and the pull request
// feed are the board's. `factory doctor` says whether the board answers, with the fix when it doesn't.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message as BoardMessage, Task as BoardTask } from "../message-board/src/index.ts";
import { type BoardWorld, boardWorld } from "./board_support.ts";
import { doctor, lines, machine, project as doctorProject } from "./doctor_support.ts";
import { FAKE_GH } from "./issues_support.ts";
import { git, gitRepo, HOOKS, runCode, runHook, write, writeExe } from "./support.ts";

setDefaultTimeout(180_000);

let world: BoardWorld;

beforeAll(async () => {
  world = await boardWorld();
}, 600_000);

afterAll(async () => {
  await world?.end();
}, 120_000);

type Env = Record<string, string | undefined>;

/** A project on the board: its repo's tasks One (#101) and Two (#102) are on it, ready. */
function boardProject(extra: Record<string, unknown> = {}): { d: string; env: Env; repo: string; ids: number[] } {
  const repo = world.repo();
  const d = gitRepo();
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "board" }, agents: ["haile", "taytu"], ...extra }));
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "factory.json");
  const db = write(join(d, "gh-db.json"), JSON.stringify({ issues: [], pulls: [] }));
  const made = world.child.call("system", [1, 2].map((k) => ({ op: "create", args: [{ title: ["One", "Two"][k - 1], ref: `github:${repo}#${100 + k}` }] }))) as BoardTask[];
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, FAKE_GH_DB: db, MB_URL: world.url, GH_REPO: repo };
  delete env.FACTORY_AGENT;
  delete env.FACTORY_PID;
  return { d, env, repo, ids: made.map((t) => t.id) };
}

function onBoard(id: number): BoardTask {
  return world.child.call("system", [{ op: "get", args: [id] }])[0] as BoardTask;
}

function hook(d: string, env: Env, name: string, ...args: string[]): { code: number; out: string; stdout: string; stderr: string } {
  const p = runHook(name, args, { cwd: d, env, timeoutMs: 90_000 });
  return { code: p.code, out: p.out, stdout: p.stdout.trim(), stderr: p.stderr.trim() };
}

/** Code run in the project with the factory's settings loaded and its ports composed. */
function inProject(d: string, env: Env, body: string): { code: number; out: string; stdout: string } {
  const code = `import { compose, busFor } from ${JSON.stringify(join(HOOKS, "core", "compose.ts"))};
import { load } from ${JSON.stringify(join(HOOKS, "factory_config.ts"))};
const cfg = load(); const ports = compose(cfg);
${body}`;
  const p = runCode(code, { cwd: d, env, timeoutMs: 90_000 });
  return { code: p.code, out: p.out, stdout: p.stdout.trim() };
}

test("factory next shows the board's next task and claims nothing", () => {
  const p = boardProject();
  const r = hook(p.d, p.env, "next_task", "--note");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout.split("\n")[0]).toBe("101 One");
  expect(r.stdout).toContain("Not claimed.");
  expect(onBoard(p.ids[0] as number).holder).toBeNull();
  const json = hook(p.d, p.env, "next_task", "--json", "--no-claim");
  expect(JSON.parse(json.stdout)).toMatchObject({ id: "101", title: "One" });
});

test("a loop's pick claims on the board, keeps the token mode 600, and the same agent gets its own task back", () => {
  const p = boardProject();
  const first = hook(p.d, p.env, "next_task", "--claim", "haile", "--pid", "123");
  expect(first.code, first.out).toBe(0);
  expect(first.stdout).toBe("101 One");
  expect(onBoard(p.ids[0] as number)).toMatchObject({ holder: "haile", status: "in_progress" });
  const tokens = join(p.d, ".git", "factory", "board-claims.json");
  expect(statSync(tokens).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(tokens, "utf8"))[String(p.ids[0])]).toMatchObject({ agent: "haile" });
  expect(hook(p.d, p.env, "next_task", "--claim", "taytu", "--pid", "124").stdout).toBe("102 Two");
  expect(hook(p.d, p.env, "next_task", "--claim", "haile", "--pid", "123").stdout).toBe("101 One");
  const none = hook(p.d, p.env, "next_task", "--claim", "menelik", "--pid", "125");
  expect([none.code, none.stdout]).toEqual([1, "none"]);
});

test("a named claim (--issue) takes exactly that task, or refuses with code, message and fix", () => {
  const p = boardProject();
  const r = hook(p.d, p.env, "next_task", "--claim", "haile", "--issue", "102");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toBe("102 Two");
  const taken = hook(p.d, p.env, "next_task", "--claim", "taytu", "--issue", "102");
  expect(taken.code).toBe(1);
  expect(JSON.parse(taken.stderr)).toMatchObject({ code: "task-taken" });
});

test("a builder's claim, release, review and done land on the board, with its token", () => {
  const p = boardProject();
  hook(p.d, p.env, "next_task", "--claim", "haile", "--pid", "123");
  const released = hook(p.d, p.env, "factory_issues", "release", "101", "the run ended");
  expect(released.code, released.out).toBe(0);
  expect(onBoard(p.ids[0] as number)).toMatchObject({ holder: null, status: "open" });
  expect(hook(p.d, p.env, "next_task", "--claim", "haile", "--pid", "123").stdout).toBe("101 One");
  const review = hook(p.d, p.env, "factory_issues", "review", "101");
  expect(review.code, review.out).toBe(0);
  expect(review.stdout).toContain("101 is in review");
  expect(onBoard(p.ids[0] as number)).toMatchObject({ holder: null, status: "in_review" });
  const done = inProject(p.d, p.env, `console.log(ports.tasks.setState("101", "done"));`);
  expect(done.code, done.out).toBe(0);
  expect(onBoard(p.ids[0] as number)).toMatchObject({ holder: null, status: "done", outcome: "done" });
  const shown = hook(p.d, p.env, "factory_issues", "show", "102");
  expect(shown.stdout).toContain("102 Two");
});

test("the factory's messages follow the tasks to the board", () => {
  const p = boardProject();
  const before = (world.child.call("system", [{ op: "messages", args: [] }])[0] as { cursor: number }).cursor;
  const r = inProject(p.d, p.env, `import { Message } from ${JSON.stringify(join(HOOKS, "core", "domain", "message.ts"))};
ports.messaging.send(new Message({ id: "q1board", kind: "question", frm: "haile", to: "po", ref: "issue#101" }), "Which colour?");
console.log(ports.messaging.read(null).messages.map((m) => m.id).join(","));`);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toBe("q1board");
  const got = (world.child.call("system", [{ op: "messages", args: [{ after: before }] }])[0] as { messages: BoardMessage[] }).messages;
  expect(got.map((m) => [m.from, m.to, m.tag])).toEqual([["haile", "po", `msg:${p.repo}`]]);
});

test("messaging.transport board: claims, wake-ups and the pull request feed are the board's", () => {
  const p = boardProject({ messaging: { transport: "board", kinds: ["wake", "claim", "pr"], githubCopy: [] } });
  const r = inProject(p.d, p.env, `
const claims = busFor(cfg, "claim"); const wakes = busFor(cfg, "wake"); const prs = busFor(cfg, "pr");
console.log(JSON.stringify(claims.claim("review.5.abcdef0", "lead", 60)));
wakes.wake({ from: "lead", to: "haile", ref: "pr#5", why: "look" });
console.log(JSON.stringify(wakes.waitWake({ names: ["haile", "coding-agent", "all"], since: Date.now() - 5000, seconds: 5 })));
console.log(String(prs.prs()));`);
  expect(r.code, r.out).toBe(0);
  const [claimed, woke, snap] = r.stdout.split("\n");
  expect(JSON.parse(claimed as string)).toEqual({ held: true, holder: "lead" });
  expect(JSON.parse(woke as string)).toMatchObject({ from: "lead", to: "haile", ref: "pr#5", why: "look" });
  expect(snap).toBe("null");
  const off = boardProject({ messaging: { transport: "board", kinds: ["wake"] } });
  expect(inProject(off.d, off.env, `console.log(String(busFor(cfg, "claim")));`).stdout).toBe("null"); // claim not moved
});

test("factory doctor: the board answers, or it says so with the fix", () => {
  const ok = doctorProject({}, { tasks: { source: "board" }, agents: ["haile"] });
  const env = { ...machine(), MB_URL: world.url };
  const good = doctor(ok, env);
  expect(lines(good, "ok").some((l) => l.includes("message board answers")), good.stdout).toBe(true);
  const down = new URL(world.url);
  down.port = "1";
  const bad = doctor(ok, { ...env, MB_URL: down.toString() });
  const fix = lines(bad, "fix").find((l) => l.includes("message board"));
  expect(fix, bad.stdout).toBeDefined();
  expect(fix).toContain("factory board up");
  // #520: the message and the fix are two sentences: "... Failed to connect. Fix: Start it ..."
  expect(fix, fix).toMatch(/[.!?] Fix: \S/);
  expect(bad.stdout).not.toContain(new URL(world.url).password);
  // with no tasks.source board and no transport set, a machine with a board uses it for messages (#504): checked too
  const plain = doctorProject({}, { agents: ["haile"] });
  expect(lines(doctor(plain, { ...env, MB_URL: down.toString() }), "fix").some((l) => l.includes("message board"))).toBe(true);
  const github = doctorProject({}, { agents: ["haile"], messaging: { transport: "github" } });
  expect(doctor(github, { ...env, MB_URL: down.toString() }).stdout).not.toContain("message board");
  const old = doctorProject({}, { agents: ["haile"], messaging: { transport: "nats" } });
  expect(lines(doctor(old, env), "fix").find((l) => l.includes("messaging.transport"))).toContain("factory settings set messaging.transport board");
});

test("a board that refuses this machine's login: next and doctor say to ask the hub for a new code, not to start it", () => {
  const p = boardProject();
  const refusedUrl = new URL(world.url);
  refusedUrl.password = "not-the-password"; // as a removed or expired login is refused
  const env = { ...p.env, MB_URL: refusedUrl.toString() };
  const r = hook(p.d, env, "next_task", "--note");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("This machine's board login was refused (removed or expired).");
  expect(r.out).toContain("factory machine leave");
  expect(r.out).not.toContain("factory board up");
  expect(r.out).not.toContain(new URL(world.url).password);
  const ok = doctorProject({}, { tasks: { source: "board" }, agents: ["haile"] });
  const d = doctor(ok, { ...machine(), MB_URL: refusedUrl.toString() });
  const fix = lines(d, "fix").find((l) => l.includes("message board"));
  expect(fix, d.stdout).toBeDefined();
  expect(fix).toContain("This machine's board login was refused (removed or expired).");
  expect(fix).toContain("factory machine add <name> --agent ...");
  expect(fix).not.toContain("factory board up");
});

test("factory next in board mode reads a pull request's comments only when it changed: one GitHub call when nothing did (#515)", () => {
  const p = boardProject();
  const db = p.env.FAKE_GH_DB as string;
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(db, "utf8")) as Record<string, unknown>;
  const old = "2026-10-01T09:00:00Z";
  const head = (n: number): string => String(n).repeat(40).slice(0, 40);
  const data = read();
  data.pulls = [201, 202, 203].map((n) => ({ number: n, title: `PR ${n}`, labels: [], head: { sha: head(n % 10), ref: `task/${n}` }, updated_at: old }));
  data.comments = { 201: [{ body: "Looks fine.", at: 1 }], 202: [], 203: [{ body: "Nice.", at: 1 }] };
  writeFileSync(db, JSON.stringify(data));
  const calls = (): number => Number(read().clock ?? 0);

  let before = calls();
  const first = hook(p.d, p.env, "next_task", "--json");
  expect(first.code, first.out).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ id: "101" });
  expect(calls() - before).toBe(4); // the open pull requests, then each one's comments once

  before = calls();
  const again = hook(p.d, p.env, "next_task", "--json");
  expect(again.code, again.out).toBe(0);
  expect(calls() - before).toBeLessThanOrEqual(2); // nothing changed: the list, and no comments read
  expect(calls() - before).toBe(1);

  // a must-fix on #202's head: its updated_at moves, so its comments (only its) are read again
  const changed = read();
  (changed.comments as Record<string, unknown[]>)["202"] = [{ body: `<!-- factory-mustfix sha=${head(2).slice(0, 7)} -->\nFix it.`, at: 2 }];
  ((changed.pulls as Record<string, unknown>[])[1] as Record<string, unknown>).updated_at = "2026-10-02T09:00:00Z";
  writeFileSync(db, JSON.stringify(changed));
  before = calls();
  const rework = hook(p.d, p.env, "next_task", "--json");
  expect(rework.code, rework.out).toBe(0);
  expect(JSON.parse(rework.stdout)).toMatchObject({ id: "pr-202" });
  expect(calls() - before).toBe(2);
});

test("a task made on the board (b<n>) goes through review, block, release and show by its id, like an issue's (#544)", () => {
  const repo = world.repo();
  const d = gitRepo();
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "board" }, agents: ["haile"] }));
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "factory.json");
  const db = write(join(d, "gh-db.json"), JSON.stringify({ issues: [], pulls: [] }));
  // made with board_create: tagged with the project, no issue behind it
  const [made] = world.child.call("system", [{ op: "create", args: [{ title: "Slugify", ref: `factory:${repo.toLowerCase()}/0f3c-board-only` }] }]) as BoardTask[];
  const id = `b${(made as BoardTask).id}`;
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, FAKE_GH_DB: db, MB_URL: world.url, GH_REPO: repo };
  delete env.FACTORY_AGENT;
  delete env.FACTORY_PID;
  const picked = hook(d, env, "next_task", "--claim", "haile", "--pid", "123");
  expect(picked.stdout, picked.out).toBe(`${id} Slugify`);
  const shown = hook(d, env, "factory_issues", "show", id);
  expect(shown.code, shown.out).toBe(0);
  expect(shown.stdout).toContain("Slugify");
  // what board.md says after `gh pr create`: it ends the loop's claim, so board_close then works with no token
  const review = hook(d, env, "factory_issues", "review", id);
  expect(review.code, review.out).toBe(0);
  expect(onBoard((made as BoardTask).id)).toMatchObject({ holder: null, status: "in_review" });
  const blocked = hook(d, env, "factory_issues", "block", id, "waiting on the owner");
  expect(blocked.code, blocked.out).toBe(0);
  const released = hook(d, env, "factory_issues", "release", id, "back to ready");
  expect(released.code, released.out).toBe(0);
  expect(onBoard((made as BoardTask).id).holder).toBeNull();
  // an id that is neither a number nor b<n> is still refused, as before
  const bad = hook(d, env, "factory_issues", "review", "x1");
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain("invalid int value: 'x1'");
});
