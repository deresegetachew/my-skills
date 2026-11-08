// factory-loop.sh and Claude's usage limit (#614): a session that ends on the limit makes the loop wait once for the
// reset (said in one line, the shared file written, the agent's state "waiting on the Claude limit until HH:MM"), then
// carry on; a limit another loop found makes it wait before it starts a session; Ctrl-C and a stop end the wait. The
// real loop and factory_claude_limit.ts run in a throwaway repo with stub hooks and a fake `claude` that writes a
// transcript as Claude Code does and exits on the limit.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, read, sh, write, writeExe } from "./support.ts";
import { commitAll, type Env, loopRepo, push, runOnATerminal } from "./loop_support.ts";

/** The real check and what it imports (not factory_agents.ts: the loop's stub stays, so its pings are logged). */
const REAL = ["factory_claude_limit.ts", "factory_config.ts", "factory_clock.ts", "factory_lib.ts", "factory_usage_logs.ts"];

/** next_task hands out the same task twice (a session after the wait), then nothing. */
const NEXT_TASK = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
if (process.env.LOOP_LOG) appendFileSync(process.env.LOOP_LOG, "next_task.ts " + process.argv.slice(2).join(" ") + "\n");
const state = process.env.LOOP_STATE as string;
const n = existsSync(state) ? Number(readFileSync(state, "utf8")) : 0;
writeFileSync(state, String(n + 1));
if (n < 2) { console.log("1.1 First task"); process.exit(0); }
process.exit(1);
`;

/** A fake claude: its first LIMITED_RUNS runs end on the usage limit, as Claude Code 2.1.x logs it (a synthetic reply with
 * quotaLimits.resetsAt RESET_IN seconds ahead) and says it; the others end normally. Each run is logged. */
const CLAUDE = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(process.env.LOOP_LOG as string, "claude ran\n");
const count = process.env.CLAUDE_COUNT as string;
const n = (existsSync(count) ? Number(readFileSync(count, "utf8")) : 0) + 1;
writeFileSync(count, String(n));
const dir = join(process.env.CLAUDE_CONFIG_DIR as string, "projects", realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, "-"));
mkdirSync(dir, { recursive: true });
const now = Math.floor(Date.now() / 1000);
const at = new Date().toISOString();
if (n <= Number(process.env.LIMITED_RUNS ?? "1")) {
  const resetsAt = now + Number(process.env.RESET_IN ?? "3");
  const text = "You've hit your limit · resets soon";
  writeFileSync(join(dir, "s" + n + ".jsonl"), JSON.stringify({ type: "assistant", timestamp: at, isApiErrorMessage: true, error: "rate_limit",
    apiError: "usage_limit_reached", quotaLimits: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
    message: { model: "<synthetic>", content: [{ type: "text", text }] } }) + "\n");
  console.log(text);
  process.exit(1);
}
writeFileSync(join(dir, "s" + n + ".jsonl"), JSON.stringify({ type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } }) + "\n");
`;

interface Setup { work: string; env: Env; state: string; log: string }

/** factory_roles.ts for a product owner whose queue always has the same item, with no waits between passes. */
const ROLES = String.raw`#!/usr/bin/env bun
const [cmd] = process.argv.slice(2);
if (cmd === "vars") console.log("role_kind=skill\nrole_skill=product-pass\nrole_model_role=product-owner\nrole_title=x\nrole_busy=0\nrole_idle=0\nrole_profile=");
else if (cmd === "work") console.log("ask 9: pick a database");
else if (cmd === "prompt") console.log("/product-pass ask-9");
`;

function setup(extra: Record<string, string> = {}): Setup {
  const [d, work] = loopRepo(undefined, {
    ".claude/factory.json": JSON.stringify({ waitMinutes: 0, claudeLimit: { marginSeconds: 0 } }),
  });
  writeExe(join(work, ".claude", "hooks", "next_task.ts"), NEXT_TASK);
  writeExe(join(work, ".claude", "hooks", "factory_roles.ts"), ROLES);
  for (const f of REAL) copyFileSync(join(HOOKS, f), join(work, ".claude", "hooks", f));
  commitAll(work, "the limit check");
  push(work);
  writeExe(join(d, "bin", "claude"), CLAUDE);
  const stateHome = join(d, "state-home");
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, LOOP_LOG: join(d, "log"), LOOP_STATE: join(d, "next"),
    CLAUDE_COUNT: join(d, "count"), CLAUDE_CONFIG_DIR: join(d, "claude-config"), XDG_STATE_HOME: stateHome, TZ: "UTC",
    FACTORY_REMOTE_CONTROL: "0", ...extra };
  for (const k of ["FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_NOW", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"]) delete env[k];
  return { work, env, state: join(stateHome, "work-factory", "claude-limit.json"), log: join(d, "log") };
}

// The clock the command prints (TZ is UTC here): HH:MM on the same day, the date first on another day.
function hhmm(t: number, from: number = Date.now() / 1000): string {
  const iso = new Date(t * 1000).toISOString();
  const sameDay = iso.slice(0, 10) === new Date(from * 1000).toISOString().slice(0, 10);
  return sameDay ? iso.slice(11, 16) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

function claudeRuns(s: Setup): number {
  return read(s.log).split("\n").filter((l) => l === "claude ran").length;
}

test("a session that ends on the limit makes the loop wait once for the reset, then carry on", () => {
  const s = setup();
  const start = Date.now();
  const p = sh(["bash", "./factory-loop.sh"], { cwd: s.work, env: s.env, timeoutMs: 60_000 });
  const took = (Date.now() - start) / 1000;
  expect(p.code, p.out).toBe(0);
  const limit = JSON.parse(readFileSync(s.state, "utf8")) as { reset: number; until: number; by: string; pattern: string };
  expect([limit.by, limit.pattern, limit.until]).toEqual(["solo", "quota-rejected", limit.reset]);
  expect(p.stdout).toContain("[solo] The session ended on Claude's usage limit (quota-rejected, five-hour window)");
  expect(count(p.stdout, `[solo] Claude limit reached; waiting until ${hhmm(limit.reset)} (local)`)).toBe(1);
  expect(p.stdout.indexOf("Claude limit reached; waiting")).toBeLessThan(p.stdout.lastIndexOf("=== [solo]")); // waited, then the task again
  expect(claudeRuns(s)).toBe(2); // not a session every 10 s: one on the limit, one after the reset
  expect(took).toBeGreaterThanOrEqual(2);
  expect(read(s.log)).toContain(`factory_agents.ts ping --agent solo --status waiting on the Claude limit until ${hhmm(limit.reset)}`);
});

test("a limit another loop found makes this loop wait before it claims a task", () => {
  const s = setup({ LIMITED_RUNS: "0" });
  const now = Math.floor(Date.now() / 1000);
  write(s.state, JSON.stringify({ at: now, reset: now + 2, until: now + 2, window: "five_hour", pattern: "quota-rejected", text: "x", by: "haile" }));
  const p = sh(["bash", "./factory-loop.sh", "--once"], { cwd: s.work, env: s.env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`[solo] Claude limit reached; waiting until ${hhmm(now + 2)} (local)`);
  expect(p.stdout.indexOf("Claude limit reached; waiting")).toBeLessThan(p.stdout.indexOf("=== [solo]"));
  const log = read(s.log);
  expect(log.indexOf("--status waiting on the Claude limit until")).toBeGreaterThan(-1);
  expect(log.indexOf("--status waiting on the Claude limit until")).toBeLessThan(log.indexOf("next_task.ts --claim")); // no claim held through the wait
  expect(claudeRuns(s)).toBe(1);
  expect((JSON.parse(readFileSync(s.state, "utf8")) as { by: string }).by).toBe("haile");
});

test("with -i a session on the limit waits for the reset instead of the 10 s countdown", async () => {
  const s = setup();
  const [code, out] = await runOnATerminal(s.work, s.env, 60, ["-i", "3"]);
  expect(code, out).toBe(0);
  expect(count(out, "Claude limit reached; waiting until")).toBe(1);
  expect(count(out, "Carrying on in 10 s")).toBe(1); // only the second session, which ended without the limit
  expect(out.indexOf("Claude limit reached; waiting")).toBeLessThan(out.indexOf("Carrying on in 10 s"));
  expect(claudeRuns(s)).toBe(2);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal === "SIGINT" ? "Ctrl-C" : "a stop"} ends the loop during the wait, and the wait with it`, async () => {
    const s = setup({ LIMITED_RUNS: "0" });
    const now = Math.floor(Date.now() / 1000);
    write(s.state, JSON.stringify({ at: now, reset: now + 600, until: now + 600, window: "five_hour", pattern: "quota-rejected", text: "x", by: "haile" }));
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env)) if (v !== undefined) clean[k] = v;
    const proc = Bun.spawn(["bash", "./factory-loop.sh"], { cwd: s.work, env: clean, stdout: "pipe", stderr: "pipe" });
    let out = "";
    const reader = (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk);
    })();
    for (let i = 0; i < 200 && !out.includes("waiting until"); i++) await Bun.sleep(50);
    expect(out).toContain("Claude limit reached; waiting until");
    const start = Date.now();
    proc.kill(signal);
    const code = await proc.exited;
    await reader;
    expect((Date.now() - start) / 1000).toBeLessThan(5);
    expect(code).toBe(130);
    await Bun.sleep(300);
    const left = sh(["ps", "-axo", "args"]).stdout.split("\n").filter((l) => l.includes(s.work) && l.includes("factory_claude_limit.ts wait"));
    expect(left).toEqual([]);
    expect(claudeRuns(s)).toBe(0);
    expect(existsSync(s.state)).toBe(true);
  });
}

test("a product owner's pass that ends on the limit three times is not an item that came up 3 times in a row", () => {
  // Each fake limit resets an hour ahead, and the test clock stands still (FACTORY_NOW, which also makes the wait say its
  // line without sleeping), so every pass after one on the limit finds it active however slow the machine is.
  const s = setup({ FACTORY_ROLE: "product-owner", LIMITED_RUNS: "9", RESET_IN: "3600" });
  s.env.FACTORY_NOW = String(Math.floor(Date.now() / 1000));
  const p = sh(["bash", "./factory-loop.sh", "4"], { cwd: s.work, env: s.env, timeoutMs: 90_000 });
  expect(p.code, p.out).toBe(0);
  expect(p.out).not.toContain("came up 3 times in a row");
  expect(p.out).not.toContain("passes failed in a row");
  expect(claudeRuns(s)).toBe(4);
  expect(count(p.stdout, "The session ended on Claude's usage limit")).toBe(4);
  expect(count(p.stdout, "Claude limit reached; waiting until")).toBe(3); // passes 2, 3 and 4 each wait first; pass 1 finds no limit
});
