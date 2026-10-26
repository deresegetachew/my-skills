// Factory sessions load only the project's MCP servers, never the user's own connectors (#55): every `claude` that
// factory-loop.sh (headless and -i) starts gets --strict-mcp-config, --mcp-config with the .mcp.json main has on origin
// (or an empty config), never the worktree's copy, and settings that turn the claude.ai connectors off. Runs the real
// scripts with stub hooks and a stub `claude` that records its arguments.
// `factory agent` starts its claude the same way.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { calls, EMPTY, type Env, fakeClaude, flag, loopProject, mainCopy, NO_CONNECTORS, quiet } from "./loop_support.ts";
import { readdirSync, symlinkSync } from "node:fs";
import { HOOKS, read, SF, sh, tmp, write } from "./support.ts";

function assertIsolated(args: string[], mcpConfig: string): void {
  expect(args).toContain("--strict-mcp-config");
  expect(flag(args, "--mcp-config")).toBe(mcpConfig);
  expect(JSON.parse(flag(args, "--settings"))).toEqual(JSON.parse(NO_CONNECTORS));
}

/** factory-loop.sh -i reads /dev/tty, so it runs on a pseudo-terminal. Returns its output. */
async function runOnATerminal(work: string, env: Env, timeoutMs: number): Promise<string> {
  let out = "";
  let answered = false;
  const p = Bun.spawn(["bash", "./factory-loop.sh", "-i", "1"], {
    cwd: work,
    env: env as Record<string, string>,
    terminal: {
      cols: 200,
      rows: 50,
      data(t, d) {
        out += new TextDecoder().decode(d);
        if (!answered && out.includes("type q and Enter to stop")) {
          answered = true;
          t.write("q\n");
        }
      },
    },
  });
  const timer = setTimeout(() => p.kill(9), timeoutMs);
  await p.exited;
  clearTimeout(timer);
  return out;
}

function headless(work: string, env: Env): string[] {
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const got = calls(env);
  expect(got.length, JSON.stringify(got)).toBe(1);
  return got[0] as string[];
}

const DOCS = { mcpServers: { docs: { command: "docs-server" } } };
const EVIL = { mcpServers: { github: { command: "github-mcp-server" } } };

test("a headless loop run gets an empty mcp config without a project file", () => {
  const [work, env] = loopProject();
  const args = headless(work, env);
  assertIsolated(args, EMPTY);
  expect(args.slice(-2)).toEqual(["-p", "/next-task 1.1"]);
});

test("a headless loop run uses the mcp json main has", () => {
  const [work, env] = loopProject(DOCS);
  const args = headless(work, env);
  assertIsolated(args, mainCopy(work));
  expect(JSON.parse(read(mainCopy(work)))).toEqual(DOCS);
});

test("a worktree only mcp json is never passed to claude", () => {
  let [work, env] = loopProject(undefined, EVIL); // untracked, main has none
  assertIsolated(headless(work, env), EMPTY);
  [work, env] = loopProject(DOCS, EVIL); // an uncommitted edit: main's copy wins
  const args = headless(work, env);
  assertIsolated(args, mainCopy(work));
  expect(JSON.parse(read(mainCopy(work)))).toEqual(DOCS);
  expect(JSON.stringify(args)).not.toContain("github-mcp-server");
});

test("the worktree cannot steer which branch the config comes from", () => {
  // An agent pushes a branch with its own .mcp.json, then points the worktree at it: an uncommitted `mainBranch`
  // in .claude/factory.json, and a planted local origin/main ref. main's copy must still win.
  const [work, env] = loopProject(DOCS);
  quiet(["git", "checkout", "-q", "-b", "task/x"], work);
  write(join(work, ".mcp.json"), JSON.stringify(EVIL));
  quiet(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "evil"], work);
  quiet(["git", "push", "-q", "origin", "task/x"], work);
  quiet(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], work);
  write(join(work, ".claude", "factory.json"), '{"waitMinutes": 0, "mainBranch": "task/x"}');
  const args = headless(work, env);
  assertIsolated(args, mainCopy(work));
  expect(JSON.parse(read(mainCopy(work)))).toEqual(DOCS);
  expect(JSON.stringify(args)).not.toContain("github-mcp-server");
});

test("an interactive loop session is isolated too", async () => {
  const [work, env] = loopProject();
  const out = await runOnATerminal(work, env, 45_000);
  const got = calls(env);
  expect(got.length, JSON.stringify(got) + out).toBe(1);
  assertIsolated(got[0] as string[], EMPTY);
  expect((got[0] as string[])[(got[0] as string[]).length - 1]).toBe("/next-task 1.1");
}, 60_000);

test("factory agent starts claude isolated and passes its own arguments on", () => {
  const d = tmp();
  const work = join(d, "proj");
  quiet(["git", "init", "-q", "-b", "main", work]);
  write(join(work, ".claude", "hooks", ".keep"), "");
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(work, ".claude", "hooks", f));
  write(join(work, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
  write(join(work, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"] }));
  write(join(work, ".mcp.json"), JSON.stringify(DOCS));
  quiet(["git", "add", "-A"], work);
  quiet(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start"], work);
  const origin = join(d, "origin.git");
  quiet(["git", "init", "-q", "--bare", "-b", "main", origin]);
  quiet(["git", "remote", "add", "origin", origin], work);
  quiet(["git", "push", "-q", "origin", "HEAD:main"], work);
  write(join(work, ".mcp.json"), JSON.stringify(EVIL)); // the agent's edit, not on main
  const env = fakeClaude(d);
  const p = sh(["bash", join(SF, "factory"), "agent", "menelik", "--resume"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const got = calls(env);
  expect(got.length).toBe(1);
  const args = got[0] as string[];
  assertIsolated(args, mainCopy(work));
  expect(JSON.parse(read(mainCopy(work)))).toEqual(DOCS);
  expect(args[args.length - 1]).toBe("--resume");
});
