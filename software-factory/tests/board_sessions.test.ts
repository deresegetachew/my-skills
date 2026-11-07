// Agents' sessions talk to the message board through its MCP server (#501, decision 0007 step 3b). With the board on
// (`tasks.source` board, or `messaging.transport` board), factory_mcp.ts gives a session exactly one MCP server, the
// board's, for that agent's actor, its board role and a session id of its own; the board's URL reaches the server
// through its environment (MB_URL or the url file), never on a command line. With the board off, nothing changes.
// The agents' rules allow each role the board tools it needs and no more, and the skills name the tools.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { boardWorld, type BoardWorld } from "./board_support.ts";
import { commitAll, KIT_AGENT_SETTINGS, LOGGING_STUB, loopRepo, mainCopy, push, quiet, STUB_HOOKS } from "./loop_support.ts";
import { HOOKS, KIT, read, SF, sh, tmp, write, writeExe } from "./support.ts";

const MCP = join(HOOKS, "factory_mcp.ts");
const BIN = join(SF, "message-board", "bin.ts");
const DOCS = { mcpServers: { docs: { command: "docs-server" } } };
const SECRET = "s3cret-pw-501";
const URL_WITH_PASSWORD = `postgres://factory:${SECRET}@127.0.0.1:1/board`;

const BUILDER_TOOLS = ["board_prime", "board_ready", "board_claim", "board_heartbeat", "board_release", "board_close",
  "board_show", "board_post", "board_thread", "board_note", "board_on_me", "board_delegated"];
const MANAGER_TOOLS = [...BUILDER_TOOLS, "board_move", "board_create", "board_assign", "board_link", "board_unlink", "board_comment"];
// The product owner never builds (#511): no claim, heartbeat, release or close; a task dropped is moved to done as wont_do.
const PO_TOOLS = MANAGER_TOOLS.filter((t) => !["board_claim", "board_heartbeat", "board_release", "board_close"].includes(t));

/** A clone whose origin main has `factoryJson` as .claude/factory.json (and `mcp` as .mcp.json). */
function project(factoryJson: unknown, mcp?: unknown): string {
  const d = tmp();
  const origin = join(d, "origin.git");
  const work = join(d, "work");
  quiet(["git", "init", "-q", "--bare", "-b", "main", origin]);
  quiet(["git", "clone", "-q", origin, work]);
  write(join(work, ".claude", "factory.json"), JSON.stringify(factoryJson));
  if (mcp !== undefined) write(join(work, ".mcp.json"), JSON.stringify(mcp));
  quiet(["git", "add", "-A"], work);
  quiet(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start"], work);
  quiet(["git", "push", "-q", "origin", "HEAD:main"], work);
  return work;
}

function mcpFor(work: string, args: string[], env: Record<string, string | undefined> = {}): { out: string; err: string; code: number } {
  const p = sh([process.execPath, "--no-env-file", "--config=/dev/null", MCP, ...args], { cwd: work, env: { ...process.env, ...env } });
  return { out: p.stdout.trim(), err: p.stderr.trim(), code: p.code };
}

interface Server {
  command: string;
  args: string[];
}

/** The one server a printed config names, after checking it is the only one and is called board. */
function boardServer(printed: string): Server {
  const cfg = JSON.parse(printed) as { mcpServers: Record<string, Server> };
  expect(Object.keys(cfg.mcpServers)).toEqual(["board"]);
  return cfg.mcpServers.board as Server;
}

/** The board command's own arguments: what follows message-board/bin.ts. */
function boardArgs(s: Server): string[] {
  const i = s.args.indexOf(BIN);
  expect(i, JSON.stringify(s)).toBeGreaterThanOrEqual(0);
  return s.args.slice(i + 1);
}

const BOARD_TASKS = { tasks: { source: "board" } };

test("with tasks on the board a session gets only the board's server, as its agent and role", () => {
  const work = project(BOARD_TASKS, DOCS);
  const r = mcpFor(work, ["--as", "menelik", "--role", "coding-agent", "--session", "s-1"]);
  expect(r.code, r.err).toBe(0);
  const s = boardServer(r.out);
  expect(isAbsolute(s.command)).toBe(true);
  expect(s.command).toBe(process.execPath);
  expect(boardArgs(s)).toEqual(["mcp", "--as", "menelik", "--role", "builder", "--session", "s-1"]);
  expect(r.out).not.toContain("docs-server");
});

test("each factory role gets its board role", () => {
  const work = project(BOARD_TASKS);
  const role = (r: string): string | undefined => {
    const a = boardArgs(boardServer(mcpFor(work, ["--as", "fasil", "--role", r, "--session", "s"]).out));
    return a[a.indexOf("--role") + 1];
  };
  expect(role("coding-agent")).toBe("builder");
  expect(role("dev-manager")).toBe("manager");
  expect(role("product-owner")).toBe("manager");
});

test("a session without a session id gets one of its own", () => {
  const work = project(BOARD_TASKS);
  const id = (): string => {
    const a = boardArgs(boardServer(mcpFor(work, ["--as", "taytu", "--role", "coding-agent"]).out));
    const v = a[a.indexOf("--session") + 1] as string;
    expect(v.length).toBeGreaterThan(0);
    return v;
  };
  expect(id()).not.toBe(id());
});

test("messaging on the board turns it on too", () => {
  const work = project({ tasks: { source: "issues" }, messaging: { transport: "board" } }, DOCS);
  const s = boardServer(mcpFor(work, ["--as", "taytu", "--role", "coding-agent", "--session", "s-2"]).out);
  expect(boardArgs(s)).toEqual(["mcp", "--as", "taytu", "--role", "builder", "--session", "s-2"]);
});

test("the board's URL and password are never in the config", () => {
  const work = project(BOARD_TASKS);
  const r = mcpFor(work, ["--as", "menelik", "--role", "dev-manager", "--session", "s-3"], { MB_URL: URL_WITH_PASSWORD });
  boardServer(r.out);
  expect(r.out).not.toContain(SECRET);
  expect(r.out).not.toContain("postgres://");
  expect(r.err).not.toContain(SECRET);
});

test("with the board off nothing changes", () => {
  // messaging.transport github wins over a board this machine has set up (MB_URL)
  const work = project({ tasks: { source: "issues" }, messaging: { transport: "github" } }, DOCS);
  const r = mcpFor(work, ["--as", "menelik", "--role", "coding-agent", "--session", "s-4"], { MB_URL: URL_WITH_PASSWORD });
  expect(r.code, r.err).toBe(0);
  expect(r.out).toBe(mainCopy(work));
  expect(JSON.parse(read(mainCopy(work)))).toEqual(DOCS);
  const none = project({ tasks: { source: "plan" } });
  expect(mcpFor(none, ["--as", "menelik", "--role", "coding-agent"]).out).toBe('{"mcpServers":{}}');
});

test("the worktree cannot turn the board on for itself", () => {
  // main says plan; an uncommitted edit says board: main's copy decides, as for .mcp.json
  const work = project({ tasks: { source: "plan" } }, DOCS);
  write(join(work, ".claude", "factory.json"), JSON.stringify(BOARD_TASKS));
  expect(mcpFor(work, ["--as", "menelik", "--role", "coding-agent"]).out).toBe(mainCopy(work));
});

test("an actor the board can't take starts no server and says why", () => {
  const work = project(BOARD_TASKS, DOCS);
  for (const as of [[], ["--as", "--role"], ["--as", "a b"], ["--as", "-x"]]) {
    const r = mcpFor(work, [...as, "--role", "coding-agent"]);
    expect(r.code).toBe(0);
    expect(r.out, JSON.stringify(as)).toBe('{"mcpServers":{}}');
    const e = JSON.parse(r.err.split("\n").at(-1) as string) as { code: string; fix: string };
    expect(e.code).toBe("board_actor");
    expect(e.fix.length).toBeGreaterThan(0);
  }
});

// --- the agents' rules ------------------------------------------------------------------------------------------

function boardAllows(path: string): string[] {
  const p = JSON.parse(readFileSync(path, "utf8")) as { permissions: { allow: string[]; deny?: string[] } };
  for (const d of p.permissions.deny ?? []) expect(d.startsWith("mcp__board__"), d).toBe(false);
  return p.permissions.allow.filter((a) => a.startsWith("mcp__")).sort();
}

const asRules = (tools: string[]): string[] => tools.map((t) => `mcp__board__${t}`).sort();

test("a builder's rules allow the builder's board tools and no more", () => {
  expect(boardAllows(KIT_AGENT_SETTINGS)).toEqual(asRules(BUILDER_TOOLS));
});

test("the dev manager's rules allow the manager's board tools; the product owner's the same but those for building", () => {
  expect(boardAllows(join(KIT, ".claude", "manager", "settings.json"))).toEqual(asRules(MANAGER_TOOLS));
  expect(boardAllows(join(KIT, ".claude", "product-owner", "settings.json"))).toEqual(asRules(PO_TOOLS));
});

// --- the skills ------------------------------------------------------------------------------------------------

/** The skill's "When the board is on" section: in SKILL.md, or (next-task, whose core file has a line limit) in the
 * board.md beside it that SKILL.md's table of files points to. */
function boardSection(skill: string): string {
  const dir = join(KIT, ".claude", "skills", skill);
  let text = read(join(dir, "SKILL.md"));
  if (skill === "next-task") {
    expect(text).toContain("| `board.md` |");
    text = read(join(dir, "board.md")).replace(/^# /, "## ");
  }
  const m = /^## When the board is on\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  expect(m, `${skill} has a "When the board is on" section`).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

test("the skills name the board tools to use when the board is on", () => {
  const next = boardSection("next-task");
  for (const t of ["board_prime", "board_claim", "board_heartbeat", "board_release", "board_close", "board_post", "board_note", "board_thread"]) {
    expect(next, `next-task: ${t}`).toContain(`\`${t}\``);
  }
  for (const skill of ["manage-pass", "product-pass"]) {
    const s = boardSection(skill);
    for (const t of ["board_prime", "board_post", "board_note", "board_thread"]) expect(s, `${skill}: ${t}`).toContain(`\`${t}\``);
  }
  // only tools the role's server offers
  for (const [skill, tools] of [["next-task", BUILDER_TOOLS], ["manage-pass", MANAGER_TOOLS], ["product-pass", PO_TOOLS]] as const) {
    for (const named of boardSection(skill).match(/board_[a-z_]+/g) ?? []) expect(tools, `${skill}: ${named}`).toContain(named);
  }
  // board off: today's commands stay
  expect(read(join(KIT, ".claude", "skills", "next-task", "SKILL.md"))).toContain(".claude/hooks/next_task.ts");
});

test("under the loop, next-task's board steps take a merged task to done: review after the PR, close after the merge (#534)", () => {
  const next = boardSection("next-task");
  // the loop holds the claim's token, so the session ends the claim through the port, which has it
  const review = next.indexOf(".claude/hooks/factory_issues.ts review <n>");
  const close = next.search(/`board_close`[^\n]*outcome `done`[^\n]*no token/);
  const done = next.indexOf(".claude/hooks/factory_claims.ts done --task issue-<n>");
  expect(review, next).toBeGreaterThan(-1);
  expect(close, next).toBeGreaterThan(review);
  expect(done, next).toBeGreaterThan(close);
  expect(next).toContain("gh pr create");
});

// --- the server the config starts -------------------------------------------------------------------------------

let world: BoardWorld | null = null;
afterAll(async () => {
  await world?.end();
});

/** Start `s` with MB_URL in its environment, initialize it and list its tools. */
async function talk(s: Server, url: string): Promise<{ instructions: string; tools: string[] }> {
  const p = Bun.spawn([s.command, ...s.args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, MB_URL: url } });
  const send = (m: unknown): void => {
    p.stdin.write(JSON.stringify(m) + "\n");
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await p.stdin.end();
  const timer = setTimeout(() => p.kill(9), 60_000);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(timer);
  const replies = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
  const init = replies.find((r) => r.id === 1)?.result as { instructions: string };
  const list = replies.find((r) => r.id === 2)?.result as { tools: { name: string }[] };
  expect(init, out).toBeDefined();
  return { instructions: init.instructions, tools: list.tools.map((t) => t.name).sort() };
}

test("the configured server answers as the agent, with its role's tools", async () => {
  world = await boardWorld();
  const work = project(BOARD_TASKS);
  const builder = await talk(boardServer(mcpFor(work, ["--as", "menelik", "--role", "coding-agent", "--session", "s-5"]).out), world.url);
  expect(builder.instructions).toContain("You are menelik on the message board, as its builder");
  expect(builder.tools).toEqual([...BUILDER_TOOLS].sort());
  const manager = await talk(boardServer(mcpFor(work, ["--as", "fasil", "--role", "dev-manager", "--session", "s-6"]).out), world.url);
  expect(manager.instructions).toContain("You are fasil on the message board, as its manager");
  expect(manager.tools).toEqual([...MANAGER_TOOLS].sort());
}, 300_000);

/** Run the board's MCP server with `args` and call one tool; its result, refused or not. */
async function callTool(args: string[], url: string, name: string, a: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const p = Bun.spawn(["bun", BIN, "mcp", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, MB_URL: url } });
  const send = (m: unknown): void => {
    p.stdin.write(JSON.stringify(m) + "\n");
  };
  send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: a } });
  await p.stdin.end();
  const timer = setTimeout(() => p.kill(9), 60_000);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(timer);
  const r = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; result: { isError?: boolean; content: { text: string }[] } })
    .find((x) => x.id === 1);
  expect(r, out).toBeDefined();
  return { isError: r?.result.isError, text: r?.result.content.map((c) => c.text).join("") ?? "" };
}

test("a task the loop claimed: the session can't close it while held, and after review through the port it closes it with no token (#534)", async () => {
  world ??= await boardWorld();
  const fx = world.tracker([{ title: "Is palindrome" }]);
  fx.port.pick({ agent: "taytu", machine: "m1" }); // the loop's claim: its token is on this machine, not in the session
  const as = ["--as", "taytu", "--role", "builder", "--repo", fx.repo];
  const held = await callTool(as, world.url, "board_close", { task: 101, outcome: "done" });
  expect(held.isError).toBe(true);
  expect(held.text).toContain("claim-lost");
  fx.port.setState("101", "in-review"); // `factory_issues.ts review 101`, as board.md says after `gh pr create`
  const closed = await callTool(as, world.url, "board_close", { task: 101, outcome: "done", reason: "PR merged" });
  expect(closed.isError, closed.text).toBeFalsy();
  expect(fx.port.list().map((t) => t.id)).toEqual([]);
}, 300_000);

// --- the dev manager's pass keeps GitHub's mirror of the board (#502) ------------------------------------------

/** A logging stub (LOGGING_STUB) whose factory_roles names an orchestrating dev manager that idles out at once, and
 * whose orchestrator finds nothing to do. */
const ROLE_STUB = LOGGING_STUB.replace('if (name === "next_task.ts") {',
  'if (name === "factory_roles.ts" && args[0] === "vars") console.log("role_kind=orchestrator\\nrole_idle=0\\nrole_busy=0\\nrole_model_role=manager");\n' +
  'if (name === "factory_orchestrator.ts") process.exit(3);\n' +
  'if (name === "next_task.ts") {');

/** One dev manager pass with `factoryJson` on main and a factory_board.ts stub: the log of the hooks it ran. */
function managerPass(factoryJson: unknown, role = "dev-manager"): string {
  const stubs = [...STUB_HOOKS, "factory_roles.ts", "factory_orchestrator.ts", "factory_board.ts"];
  const [d, work] = loopRepo(stubs);
  for (const s of stubs) writeExe(join(work, ".claude", "hooks", s), ROLE_STUB);
  write(join(work, ".claude", "factory.json"), JSON.stringify({ waitMinutes: 0, ...(factoryJson as object) }));
  commitAll(work, "config");
  push(work);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, LOOP_LOG: join(d, "log"),
    LOOP_STATE: join(d, "state"), FACTORY_ROLE: role, STUB_AGENT: "fasil" };
  for (const k of ["FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_NAME", "MB_URL"]) delete env[k];
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  return existsSync(join(d, "log")) ? read(join(d, "log")) : "";
}

// The loop runs it with a time limit (#511), so a hung mirror can't stall the pass: board_mirror.test.ts stops a hung gh.
const mirrors = (log: string): number => log.split("\n").filter((l) => l.startsWith("factory_board.ts mirror")).length;

test("with the board on, each dev manager pass runs factory board mirror once", () => {
  const log = managerPass(BOARD_TASKS);
  expect(log).toContain("factory_orchestrator.ts cycle");
  expect(mirrors(log)).toBe(1);
  expect(log).toContain("factory_board.ts mirror --max-seconds 300\n");
  expect(mirrors(managerPass({ tasks: { source: "issues" }, messaging: { transport: "board" } }))).toBe(1);
}, 120_000);

test("with the board off, or for another role, no pass runs the mirror", () => {
  const log = managerPass({ tasks: { source: "issues" }, messaging: { transport: "github" } });
  expect(log).toContain("factory_orchestrator.ts cycle");
  expect(mirrors(log)).toBe(0);
  expect(mirrors(managerPass(BOARD_TASKS, "product-owner"))).toBe(0);
}, 120_000);

// ... and `factory board sweep` (#513), with a time limit of its own, so a claim whose agent went quiet is freed without
// a job on the hub.
const sweeps = (log: string): number => log.split("\n").filter((l) => l.startsWith("factory_board.ts sweep")).length;

test("with the board on, each dev manager pass runs factory board sweep once, with a time limit", () => {
  const log = managerPass(BOARD_TASKS);
  expect(sweeps(log)).toBe(1);
  expect(log).toContain("factory_board.ts sweep --max-seconds 60\n");
  expect(sweeps(managerPass({ tasks: { source: "issues" }, messaging: { transport: "board" } }))).toBe(1);
}, 120_000);

test("with the board off, or for another role, no pass runs the sweep", () => {
  expect(sweeps(managerPass({ tasks: { source: "issues" }, messaging: { transport: "github" } }))).toBe(0);
  expect(sweeps(managerPass(BOARD_TASKS, "product-owner"))).toBe(0);
}, 120_000);

test("the dev manager may post owner asks, run the mirror and the sweep with factory board", () => {
  const allow = (JSON.parse(read(join(KIT, ".claude", "manager", "settings.json"))) as { permissions: { allow: string[] } }).permissions.allow;
  for (const r of ["Bash(factory board ask*)", "Bash(./factory board ask*)", "Bash(factory board mirror*)", "Bash(./factory board mirror*)",
    "Bash(factory board sweep*)", "Bash(./factory board sweep*)"]) {
    expect(allow).toContain(r);
  }
  expect(allow.filter((a) => a.includes("factory board")).length).toBe(6); // nothing else of the board's command
  expect(boardSection("manage-pass")).toContain("`factory board ask");
});

// --- a builder's claim is kept alive while its session runs (#513) -----------------------------------------------------

/** factory_agents.ts that, for `keep`, writes a beat to <LOOP_LOG>.beats every 100 ms until it is stopped, and logs
 * every call like the other stubs. */
const KEEPER_STUB = LOGGING_STUB.replace('if (name === "next_task.ts") {',
  'if (name === "factory_agents.ts" && args[0] === "keep") { setInterval(() => appendFileSync(process.env.LOOP_LOG + ".beats", "beat\\n"), 100); await new Promise(() => {}); }\n' +
  'if (name === "next_task.ts") {');

test("while a builder's session runs, the loop keeps its claim alive, and stops when the session ends", async () => {
  const [d, work] = loopRepo();
  writeExe(join(work, ".claude", "hooks", "factory_agents.ts"), KEEPER_STUB);
  commitAll(work, "keeper stub");
  push(work);
  // the session: a second and a half of nothing, as a long quiet build is
  writeExe(join(d, "bin", "claude"), '#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\nsleep 1.5\n');
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, LOOP_LOG: join(d, "log"),
    LOOP_STATE: join(d, "state"), STUB_TASK: "101 Add login", STUB_AGENT: "haile" };
  for (const k of ["FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_NAME", "MB_URL", "FACTORY_ROLE"]) delete env[k];
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const log = read(join(d, "log"));
  expect(log).toMatch(/^factory_agents\.ts keep --agent haile --task 101 --pid \d+$/m);
  const beats = (): number => (existsSync(join(d, "log.beats")) ? read(join(d, "log.beats")).split("\n").filter(Boolean).length : 0);
  expect(beats()).toBeGreaterThan(3); // it ran while the session did
  const after = beats();
  await Bun.sleep(600);
  expect(beats()).toBe(after); // and stopped with it
}, 120_000);
