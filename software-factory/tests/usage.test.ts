// `factory usage`: tokens per task from Claude Code's logs.
import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitRepo, read, runHook, tmp, write } from "./support.ts";

function reply(mid: string, branch: string, cwd: string, o: { inp?: number; write?: number; read?: number; out?: number;
  ts?: string; model?: string } = {}): string {
  return JSON.stringify({ type: "assistant", timestamp: o.ts ?? "2026-10-24T10:00:00Z", gitBranch: branch, cwd,
    message: { id: mid, model: o.model ?? "claude-opus-5-5", usage: {
      input_tokens: o.inp ?? 10, cache_creation_input_tokens: o.write ?? 100,
      cache_read_input_tokens: o.read ?? 1000, output_tokens: o.out ?? 50 } } });
}

const slugOf = (root: string): string => root.replace(/[^A-Za-z0-9]/g, "-");

function setup(): [string, string] {
  const root = join(tmp(), "proj");
  mkdirSync(join(root, ".claude"), { recursive: true });
  const logs = tmp();
  const slug = slugOf(root);
  const [mainDir, agentDir, other] = [slug, slug + "-agents-taytu", "-elsewhere"].map((n) => join(logs, n)) as [string, string, string];
  for (const d of [mainDir, agentDir, other]) mkdirSync(d, { recursive: true });
  // Task 7 in the project folder, with a reviewer subagent; a reply logged twice counts once.
  const lines = [reply("m1", "task/7-x", root), reply("m1", "task/7-x", root), reply("m2", "HEAD", root)];
  write(join(mainDir, "s1.jsonl"), lines.join("\n") + "\n");
  const sub = join(mainDir, "s1", "subagents");
  write(join(sub, "agent-a.jsonl"), reply("r1", "HEAD", root, { model: "claude-sonnet-5-5" }) + "\n");
  writeFileSync(join(sub, "agent-a.meta.json"), JSON.stringify({ agentType: "reviewer" }));
  // Task 8 in an agent worktree; one reply outside the period.
  const wt = root + "-agents/taytu";
  write(join(agentDir, "s2.jsonl"), reply("m3", "task/8-y", wt) + "\n" + reply("m4", "task/8-y", wt, { ts: "2026-10-01T10:00:00Z" }) + "\n");
  // Another project's log is never counted.
  write(join(other, "s3.jsonl"), reply("m5", "task/9-z", "/elsewhere") + "\n");
  return [root, logs];
}

function usage(root: string, logs: string, ...args: string[]) {
  return runHook("factory_usage", ["--logs", logs, "--since", "2026-10-20", "--until", "2026-10-25", ...args],
    { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
}

type Data = { groups: Record<string, { replies: number }>; total: { tasks: string[]; replies: number; tokens: unknown } };

test("tokens are grouped per task once per reply", () => {
  const [root, logs] = setup();
  const p = usage(root, logs, "--json");
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(p.stdout) as Data;
  expect(data.total.tasks).toEqual(["7", "8"]);
  expect(data.total.replies).toBe(4); // m1 once, m2, r1, m3; not m4 (outside), not m5 (other project)
  expect(data.groups["7"]?.replies).toBe(3);
  expect(data.groups["8"]?.replies).toBe(1);
  expect(data.total.tokens).toEqual({ input: 40, cache_write: 400, cache_read: 4000, output: 200 });
});

test("by agent names the subagent types", () => {
  const [root, logs] = setup();
  const data = JSON.parse(usage(root, logs, "--json", "--by", "agent").stdout) as Data;
  expect(data.groups.reviewer?.replies).toBe(1);
  expect(data.groups.main?.replies).toBe(3);
});

test("by worker names the agent whose folder each session ran in (#455)", () => {
  const [root, logs] = setup();
  const p = usage(root, logs, "--json", "--by", "worker");
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(p.stdout) as Data & { by: string };
  expect(data.by).toBe("worker");
  expect(Object.keys(data.groups).sort()).toEqual(["(project folder)", "taytu"]);
  expect(data.groups.taytu?.replies).toBe(1); // m3 in <root>-agents/taytu
  expect(data.groups["(project folder)"]?.replies).toBe(3); // m1, m2 and the reviewer's r1
});

test("record appends a row to the usage log", () => {
  const [root, logs] = setup();
  expect(usage(root, logs, "--record", "baseline | before").code).toBe(0);
  expect(usage(root, logs, "--record", "after").code).toBe(0);
  const text = read(join(root, "docs", "factory-usage.md"));
  const rows = text.split("\n").filter((l) => l.startsWith("| 20"));
  expect(rows.length, text).toBe(2);
  expect(rows[0]).toContain("baseline / before");
  expect(rows[0]).toContain("| 2 |");
});

test("a task comment for the pr", () => {
  const [root, logs] = setup();
  let p = usage(root, logs, "--task", "7", "--markdown");
  expect(p.code, p.out).toBe(0);
  const out = p.stdout;
  expect(out.startsWith("<!-- factory-usage task=7 -->")).toBe(true);
  expect(out).toContain("| reviewer | 1 |");
  expect(out).toContain("| main | 2 |");
  expect(out).toContain("| **All** | 3 |");
  expect(out).not.toContain("task 8");
  p = usage(root, logs, "--task", "99", "--markdown");
  expect(p.stdout).toContain("No replies found");
});

test("the text report runs", () => {
  const [root, logs] = setup();
  const p = usage(root, logs);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Per task (2 tasks)");
});

test("by role tells a manager session from a builder session", () => {
  const [root, logs] = setup();
  const slug = slugOf(root);
  const manager = [JSON.stringify({ type: "user", message: { role: "user", content: "/manage-pass" } }),
    reply("mg1", "HEAD", root, { out: 7 }), reply("mg2", "HEAD", root, { out: 7 })];
  write(join(logs, slug, "s9.jsonl"), manager.join("\n") + "\n");
  const cmd = [JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/manage-pass</command-name>" } }),
    reply("mg3", "HEAD", root)];
  write(join(logs, slug, "s10.jsonl"), cmd.join("\n") + "\n");
  const data = JSON.parse(usage(root, logs, "--json", "--by", "role").stdout) as Data;
  expect(data.groups.manager?.replies).toBe(3);
  expect(data.groups.builder?.replies).toBe(4);
});

// --- #571: the logs of the project folder, every worktree and the dev manager's helpers, from a temporary HOME -----------

type Group = { replies: number; tokens: Record<string, number>; cost_usd: number; unpriced_replies: number };
type Full = { by: string; groups: Record<string, Group>; days: Record<string, Group>;
  total: { tasks: string[]; replies: number; cost_usd: number; unpriced_replies: number };
  sessions: Array<{ id: string; task: string; task_from: string | null; worker: string; role: string; replies: number;
    first: string; last: string; tokens: Record<string, number>; cost_usd: number }>;
  looked: Array<{ dir: string; state: string; folders: string[] }>; problems: Array<{ code: string; message: string; fix: string }> };

const dayOf = (back: number): string => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const at = (back: number, h: number): string => `${dayOf(back)}T${String(h).padStart(2, "0")}:00:00Z`;

/** A project in git with two agent worktrees (<root>-agents/taytu and the dev manager's <root>-agents/menelik) and a
 * helper worktree elsewhere; HOME is a temporary folder whose ~/.claude/projects holds Claude Code's logs, keyed by the
 * real path of each session's folder, as Claude Code writes them. */
function hub(): { root: string; home: string; logs: string } {
  const base = tmp();
  mkdirSync(join(base, "factory-sandbox"));
  const root = gitRepo(join(base, "factory-sandbox"));
  const worktrees: Array<[string, string]> = [[root + "-agents/taytu", "task/8-y"], [root + "-agents/menelik", "manager/menelik"],
    [join(base, "helpers", "fix-ci"), "fix-ci"]];
  for (const [path, branch] of worktrees) {
    mkdirSync(join(path, ".."), { recursive: true });
    git(root, "worktree", "add", "-q", "-b", branch, path);
  }
  const home = join(base, "home");
  const logs = join(home, ".claude", "projects");
  const real = (p: string): string => realpathSync(p);
  const dir = (p: string): string => join(logs, slugOf(real(p)));
  // Your own session in the project folder, task 7, over two days.
  const r = real(root);
  write(join(dir(root), "own.jsonl"), [reply("h1", "task/7-x", r, { ts: at(0, 9) }), reply("h2", "task/7-x", r, { ts: at(1, 9) })].join("\n") + "\n");
  // A coding agent in its worktree, task 8, with a reviewer subagent.
  const wt = real(root + "-agents/taytu");
  write(join(dir(wt), "agent.jsonl"), reply("t1", "task/8-y", wt, { ts: at(0, 10) }) + "\n");
  write(join(dir(wt), "agent", "subagents", "agent-r.jsonl"), reply("t2", "task/8-y", wt, { ts: at(0, 10), model: "claude-sonnet-5-5" }) + "\n");
  writeFileSync(join(dir(wt), "agent", "subagents", "agent-r.meta.json"), JSON.stringify({ agentType: "reviewer" }));
  // The dev manager's helper (a sub-manager): its folder is on the manager's branch; the task is in its first prompt.
  const mg = real(root + "-agents/menelik");
  const prompt = "/manage-pass pr-12\n\nItem pr-12 (review).\nPR #12: \"Add search\" on branch task/31-search into main.\nTask issue: #31.\n" +
    "<!-- factory-role role=dev-manager name=menelik -->";
  write(join(dir(mg), "sub.jsonl"), [JSON.stringify({ type: "user", cwd: mg, message: { role: "user", content: prompt } }),
    reply("m1", "manager/menelik", mg, { ts: at(0, 11) }), reply("m2", "manager/menelik", mg, { ts: at(0, 12) })].join("\n") + "\n");
  // A helper worktree outside <root>-agents, found through git.
  const hp = real(join(base, "helpers", "fix-ci"));
  write(join(dir(hp), "helper.jsonl"), reply("x1", "fix-ci", hp, { ts: at(0, 13) }) + "\n");
  // A log folder whose name doesn't match (a symlinked path, say), found by the folder its sessions ran in.
  write(join(logs, "-some-link-to-the-project", "linked.jsonl"), reply("l1", "task/7-x", r, { ts: at(0, 14) }) + "\n");
  // Another project's log is never counted.
  write(join(logs, "-elsewhere", "other.jsonl"), reply("o1", "task/9-z", "/elsewhere", { ts: at(0, 9) }) + "\n");
  return { root, home, logs };
}

function hubUsage(cwd: string, home: string, ...args: string[]) {
  return runHook("factory_usage", args, { cwd, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: undefined, CLAUDE_PROJECT_DIR: undefined } });
}

test("reads the project folder, every agent worktree and the helpers from Claude Code's folder in HOME (#571)", () => {
  const { root, home } = hub();
  for (const cwd of [root, root + "-agents/taytu"]) { // the same answer from the project folder and from an agent's worktree
    const p = hubUsage(cwd, home, "--json", "--by", "worker");
    expect(p.code, p.out).toBe(0);
    const data = JSON.parse(p.stdout) as Full;
    expect(Object.keys(data.groups).sort()).toEqual(["(project folder)", "fix-ci", "menelik", "taytu"]);
    expect(data.groups["(project folder)"]?.replies).toBe(3); // h1, h2 and the linked folder's l1
    expect(data.groups.taytu?.replies).toBe(2); // t1 and its reviewer's t2
    expect(data.groups.menelik?.replies).toBe(2);
    expect(data.groups["fix-ci"]?.replies).toBe(1);
    expect(data.total.replies).toBe(8); // never the other project's o1
    expect(data.problems).toEqual([]);
  }
});

test("by task: a helper session's task comes from its prompt; by day; each session is kept, joinable to its task (#571)", () => {
  const { root, home } = hub();
  const data = JSON.parse(hubUsage(root, home, "--json").stdout) as Full;
  expect(Object.keys(data.groups).sort()).toEqual(["-", "31", "7", "8"]);
  expect(data.groups["31"]?.replies).toBe(2);
  expect(data.groups["7"]?.replies).toBe(3);
  expect(data.total.tasks).toEqual(["31", "7", "8"]);
  expect(Object.keys(data.days).sort()).toEqual([dayOf(1), dayOf(0)]);
  expect(data.days[dayOf(1)]?.replies).toBe(1);
  const sub = data.sessions.find((s) => s.id === "sub");
  expect(sub).toMatchObject({ task: "31", task_from: "prompt", worker: "menelik", role: "manager", replies: 2,
    first: at(0, 11), last: at(0, 12) });
  expect(data.sessions.find((s) => s.id === "agent")).toMatchObject({ task: "8", task_from: "branch", worker: "taytu", replies: 2 });
  expect(data.sessions.find((s) => s.id === "helper")).toMatchObject({ task: "-", task_from: null, worker: "fix-ci" });
  const byDay = JSON.parse(hubUsage(root, home, "--json", "--by", "day").stdout) as Full;
  expect(byDay.by).toBe("day");
  expect(byDay.groups[dayOf(0)]?.replies).toBe(7);
  const text = hubUsage(root, home, "--by", "worker");
  expect(text.code, text.out).toBe(0);
  expect(text.stdout).toContain("menelik");
  expect(text.stdout).toContain("taytu");
});

test("cost where the model's price is known; other models are counted and said to have no price (#571)", () => {
  const { root, home, logs } = hub();
  const r = realpathSync(root);
  // One million of each kind on claude-opus-5-5: $4 input, $5 cache writes (1.25x), $0.20 cache reads, $20 output.
  write(join(logs, slugOf(r), "priced.jsonl"), [
    reply("p1", "task/40-a", r, { ts: at(0, 15), inp: 1_000_000, write: 1_000_000, read: 1_000_000, out: 1_000_000 }),
    reply("p2", "task/40-a", r, { ts: at(0, 15), model: "claude-made-up-9" })].join("\n") + "\n");
  let data = JSON.parse(hubUsage(root, home, "--json", "--task", "40").stdout) as Full;
  expect(data.groups["40"]?.cost_usd).toBeCloseTo(29.2, 6);
  expect(data.groups["40"]?.unpriced_replies).toBe(1);
  expect(data.total.unpriced_replies).toBe(1);
  // usage.prices adds a model's price (USD per million tokens).
  write(join(root, ".claude", "factory.json"), JSON.stringify({ usage: { prices: { "claude-made-up-9": { input: 1, output: 2, cacheRead: 0.5 } } } }));
  data = JSON.parse(hubUsage(root, home, "--json", "--task", "40").stdout) as Full;
  // p2: 10 input ($1/M), 100 cache writes (1.25 x $1/M), 1000 cache reads ($0.5/M), 50 output ($2/M)
  expect(data.groups["40"]?.cost_usd).toBeCloseTo(29.2 + (10 + 125 + 500 + 100) / 1_000_000, 9);
  expect(data.groups["40"]?.unpriced_replies).toBe(0);
  const text = hubUsage(root, home, "--task", "40");
  expect(text.stdout).toContain("$29.20");
});

test("claude-haiku-5-5 is priced per reply by its prompt's size: up to 100K tokens, then the long-prompt price (#571)", () => {
  const { root, home, logs } = hub();
  const r = realpathSync(root);
  // a prompt of exactly 100K tokens: $0.10 input, $0.50 output per million
  write(join(logs, slugOf(r), "haiku-short.jsonl"),
    reply("k1", "task/41-a", r, { ts: at(0, 15), model: "claude-haiku-5-5", inp: 100_000, write: 0, read: 0, out: 1_000_000 }) + "\n");
  // 50K input + 40K cache writes + 20K cache reads = 110K, over 100K: $0.50 input (writes 1.25x), $0.05 reads, $2.50 output
  write(join(logs, slugOf(r), "haiku-long.jsonl"),
    reply("k2", "task/42-a", r, { ts: at(0, 15), model: "claude-haiku-5-5", inp: 50_000, write: 40_000, read: 20_000, out: 1_000_000 }) + "\n");
  const data = JSON.parse(hubUsage(root, home, "--json").stdout) as Full;
  expect(data.groups["41"]?.cost_usd).toBeCloseTo(0.01 + 0.5, 9);
  expect(data.groups["42"]?.cost_usd).toBeCloseTo((50_000 * 0.5 + 40_000 * 0.625 + 20_000 * 0.05) / 1_000_000 + 2.5, 9);
  expect(data.groups["41"]?.unpriced_replies).toBe(0);
  expect(data.groups["42"]?.unpriced_replies).toBe(0);
});

test("no logs: says where it looked and why, with the fix (#571)", () => {
  const base = tmp();
  mkdirSync(join(base, "proj"));
  const root = gitRepo(join(base, "proj"));
  const home = join(base, "home");
  mkdirSync(join(home, ".claude", "projects", "-elsewhere"), { recursive: true });
  const p = hubUsage(root, home, "--json");
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(p.stdout) as Full;
  expect(data.total.replies).toBe(0);
  const no = data.problems.find((x) => x.code === "usage_no_logs");
  expect(no?.message).toContain(join(home, ".claude", "projects"));
  expect(no?.message).toContain(slugOf(realpathSync(root)));
  expect(no?.fix).toContain("usage.logFolders");
  expect(data.looked.map((l) => [l.dir, l.state])).toEqual([[join(home, ".claude", "projects"), "none"]]);
  // A Claude Code folder that isn't there says so too.
  const q = JSON.parse(hubUsage(root, join(base, "nobody"), "--json").stdout) as Full;
  expect(q.looked[0]?.state).toBe("missing");
  expect(q.problems[0]?.code).toBe("usage_no_logs");
  const text = hubUsage(root, join(base, "nobody"));
  expect(text.code, text.out).toBe(0);
  expect(text.stdout).toContain("usage_no_logs");
  expect(text.stdout).toContain("Fix: ");
});

test("usage.logFolders reads the Claude Code folder of the user that runs the agents (#571)", () => {
  const { root, logs } = hub();
  const mine = join(tmp(), "home");
  mkdirSync(mine, { recursive: true });
  write(join(root, ".claude", "factory.json"), JSON.stringify({ usage: { logFolders: [logs] } }));
  const data = JSON.parse(hubUsage(root, mine, "--json").stdout) as Full;
  expect(data.total.replies).toBe(8);
  expect(data.looked.map((l) => l.dir)).toEqual([join(mine, ".claude", "projects"), logs]);
  expect(data.problems).toEqual([]);
});

test("a board task (b<n>) gets its sessions: from a task/b<n>- branch, or from its first prompt (#604)", () => {
  const [root, logs] = setup();
  const dir = join(logs, slugOf(root) + "-agents-menelik");
  mkdirSync(dir, { recursive: true });
  const wt = root + "-agents/menelik";
  // A coding agent on a board task's branch.
  write(join(dir, "b1.jsonl"), reply("b1", "task/b27-reading-goal", wt) + "\n" + reply("b2", "task/b27-reading-goal", wt) + "\n");
  // A helper still on HEAD whose first prompt names the board task.
  const prompt = "/manage-pass pr-41\n\nPR #41 on branch task/b31-docs into main.\nTask issue: b31.\n";
  write(join(dir, "b3.jsonl"), [JSON.stringify({ type: "user", cwd: wt, message: { role: "user", content: prompt } }),
    reply("b3", "HEAD", wt)].join("\n") + "\n");
  write(join(dir, "b4.jsonl"), [JSON.stringify({ type: "user", cwd: wt, message: { role: "user", content: "/next-task issue-b40" } }),
    reply("b4", "HEAD", wt)].join("\n") + "\n");
  const p = usage(root, logs, "--json");
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(p.stdout) as Data;
  expect(data.groups.b27?.replies).toBe(2);
  expect(data.groups.b31?.replies).toBe(1);
  expect(data.groups.b40?.replies).toBe(1);
  expect(data.total.tasks).toEqual(["7", "8", "b27", "b31", "b40"]);
});
