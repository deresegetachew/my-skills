// A project on the message board (#500, decision 0007 point 10), as its agents and commands use it, against a real
// Postgres: with `tasks.source: "board"`, `factory next` shows the next task and claims nothing, a loop's pick claims on
// the board (the token kept in the project's state folder, mode 600), a builder's release, review and done land there,
// and the factory's messages go there too. With `messaging.transport: "board"`, claims, wake-ups and the pull request
// feed are the board's. `factory doctor` says whether the board answers, with the fix when it doesn't.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
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
  const code = `import { compose, natsFor } from ${JSON.stringify(join(HOOKS, "core", "compose.ts"))};
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
const claims = natsFor(cfg, "claim"); const wakes = natsFor(cfg, "wake"); const prs = natsFor(cfg, "pr");
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
  expect(inProject(off.d, off.env, `console.log(String(natsFor(cfg, "claim")));`).stdout).toBe("null"); // claim not moved
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
  expect(bad.stdout).not.toContain(new URL(world.url).password);
  const plain = doctorProject({}, { agents: ["haile"] });
  expect(doctor(plain, { ...env, MB_URL: down.toString() }).stdout).not.toContain("message board");
});
