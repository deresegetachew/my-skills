// `factory usage`: tokens per task from Claude Code's logs.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { read, runHook, tmp, write } from "./support.ts";

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
