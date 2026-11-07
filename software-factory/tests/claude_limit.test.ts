// Claude's usage limit (#614): the patterns that tell a session ended on it, the shared file one loop writes, and the
// wait every loop of the project on the machine makes until the reset.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, utimesSync } from "node:fs";
import { join } from "node:path";
import * as L from "../hooks/factory_claude_limit.ts";
import { gitRepo, readJson, readmeAndWiki, runHook, tmp, write } from "./support.ts";

type Raw = Record<string, unknown>;

/** A synthetic reply as Claude Code 2.1.304/2.1.310 logs a usage limit (seen in the owner's transcripts, Oct 2026). */
export function quotaReply(resetsAt: number, text: string, at: string, window = "five_hour"): Raw {
  return { type: "assistant", timestamp: at, isApiErrorMessage: true, error: "rate_limit", apiError: "usage_limit_reached",
    apiErrorStatus: 429, apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt, rateLimitType: window } },
    quotaLimits: { status: "rejected", resetsAt, rateLimitType: window },
    message: { model: "<synthetic>", content: [{ type: "text", text }] } };
}

function synthetic(text: string, error: string | null = null, at = "2026-10-20T18:29:01.478Z"): Raw {
  return { type: "assistant", timestamp: at, isApiErrorMessage: true, ...(error ? { error } : {}),
    message: { model: "<synthetic>", content: [{ type: "text", text }] } };
}

function hit(raw: Raw): L.Hit | null {
  return L.detect(L.entryOf(raw) as L.Entry);
}

const SESSION = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · " +
  "your session limit resets 9:20pm (Europe/Berlin)";
const WEEKLY = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · " +
  "your weekly limit resets Oct 27 at 4pm (Europe/Berlin)";

test("each pattern in the table: what it finds and its reset time", () => {
  // the real replies: the reset comes from resetsAt
  expect(hit(quotaReply(1792524000, SESSION, "2026-10-20T18:29:01.478Z"))).toMatchObject({ pattern: "quota-rejected", limit: true, reset: 1792524000, window: "five_hour" });
  expect(hit(quotaReply(1793113200, WEEKLY, "2026-10-24T06:32:20.548Z", "seven_day"))).toMatchObject({ pattern: "quota-rejected", reset: 1793113200, window: "seven_day" });
  // the same words without the numbers give the same times (the weekly one over the change to winter time)
  expect(hit(synthetic(SESSION, "rate_limit"))).toMatchObject({ pattern: "text-resets", limit: true, reset: 1792524000, window: "five_hour" });
  expect(hit(synthetic(WEEKLY, "rate_limit", "2026-10-24T06:32:20.548Z"))).toMatchObject({ pattern: "text-resets", reset: 1793113200, window: "seven_day" });
  // the older message with the time after a bar
  expect(hit(synthetic("Claude AI usage limit reached|1792524000"))).toMatchObject({ pattern: "text-epoch", limit: true, reset: 1792524000 });
  // a limit whose time can't be read: the loop waits claudeLimit.waitMinutes
  expect(hit(synthetic("Claude usage limit reached. Your limit will reset soon."))).toMatchObject({ pattern: "text-no-time", limit: true, reset: null });
  expect(hit(synthetic("API Error: Request rejected (429)", "rate_limit"))).toMatchObject({ pattern: "rate-limit", limit: true, reset: null });
  // Anthropic busy is not the login's limit
  expect(hit(synthetic("API Error: 529 Overloaded. Try again in a moment.", "overloaded"))).toMatchObject({ pattern: "overloaded", limit: false });
  // other errors and ordinary replies match nothing
  expect(hit(synthetic("API Error: 500 Internal server error.", "server_error"))).toBeNull();
  expect(hit(synthetic("Login expired · Please run /login", "authentication_failed"))).toBeNull();
  expect(hit({ type: "assistant", timestamp: "2026-10-20T10:00:00Z", message: { model: "claude-opus-5-5",
    content: [{ type: "text", text: "I added the check for 'usage limit reached|1792524000' and 'resets 9pm'." }] } })).toBeNull();
});

test("a reset said without a zone is this machine's time, and a time already gone today is tomorrow", () => {
  const at = new Date(2026, 9, 20, 23, 0).getTime() / 1000; // 11pm here
  expect(L.resetFromText("5-hour limit reached ∙ resets 3am", at)).toBe(new Date(2026, 9, 21, 3, 0).getTime() / 1000);
  expect(L.resetFromText("limit reached · resets 11:30pm", at)).toBe(new Date(2026, 9, 20, 23, 30).getTime() / 1000);
  expect(L.resetFromText("limit reached · resets soon", at)).toBeNull();
  expect(L.resetFromText("limit reached · resets 13pm", at)).toBeNull();
});

// --- the command ---------------------------------------------------------------------------------------------------

interface World { repo: string; env: Record<string, string | undefined>; state: string; projects: string }

/** A project (a git repo named proj) with its own Claude Code folder and state folder. */
function world(factoryJson: Raw = {}): World {
  const repo = join(tmp(), "proj");
  mkdirSync(repo);
  gitRepo(repo);
  write(join(repo, ".claude", "factory.json"), JSON.stringify(factoryJson));
  const config = tmp();
  const stateHome = tmp();
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: config, XDG_STATE_HOME: stateHome, TZ: "UTC", CLAUDE_PROJECT_DIR: repo };
  for (const k of ["FACTORY_NOW", "FACTORY_AGENT"]) delete env[k];
  return { repo, env, state: join(stateHome, "proj-factory", "claude-limit.json"), projects: join(config, "projects", realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-")) };
}

function transcript(w: World, lines: Raw[], name = "s1.jsonl"): string {
  return write(join(w.projects, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function cmd(w: World, args: string[], extra: Record<string, string> = {}) {
  return runHook("factory_claude_limit", args, { cwd: w.repo, env: { ...w.env, ...extra } });
}

function hhmm(t: number): string {
  return new Date(t * 1000).toISOString().slice(11, 16);
}

test("check reads the session's last reply and writes the reset time to the shared file", () => {
  const w = world();
  const now = Math.floor(Date.now() / 1000);
  const reset = now + 3 * 3600;
  transcript(w, [{ type: "user", message: { content: "/next-task issue-7" } },
    quotaReply(reset, SESSION, new Date(now * 1000).toISOString())]);
  const p = cmd(w, ["check", "--since", String(now - 5), "--name", "taytu"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`[taytu] The session ended on Claude's usage limit (quota-rejected, five-hour window); it resets at ${hhmm(reset)} (local).`);
  expect(readJson(w.state)).toMatchObject({ reset, until: reset, window: "five_hour", pattern: "quota-rejected", by: "taytu" });
});

test("check finds nothing in a session that ended normally, or in an older session", () => {
  const w = world();
  const now = Math.floor(Date.now() / 1000);
  transcript(w, [{ type: "assistant", timestamp: new Date(now * 1000).toISOString(), message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Done." }] } }]);
  expect(cmd(w, ["check", "--since", String(now - 5)]).code).toBe(1);
  const old = transcript(w, [quotaReply(now + 3600, SESSION, new Date((now - 7200) * 1000).toISOString())], "s0.jsonl");
  utimesSync(old, now - 7200, now - 7200);
  expect(cmd(w, ["check", "--since", String(now - 5)]).code).toBe(1); // the limit was in an earlier session
  expect(existsSync(w.state)).toBe(false);
  expect(cmd(w, ["check", "--since", String(now - 5)], {}).stdout).toBe("");
});

test("an unreadable reset waits claudeLimit.waitMinutes and says so", () => {
  const w = world({ claudeLimit: { waitMinutes: 45 } });
  const now = Math.floor(Date.now() / 1000);
  transcript(w, [synthetic("API Error: Request rejected (429)", "rate_limit", new Date(now * 1000).toISOString())]);
  const p = cmd(w, ["check", "--since", String(now - 5), "--name", "taytu"], { FACTORY_NOW: String(now) });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("its reset time couldn't be read");
  expect(readJson(w.state)).toMatchObject({ reset: null, until: now + 45 * 60, pattern: "rate-limit" });
  const q = cmd(w, ["wait", "--name", "taytu"], { FACTORY_NOW: String(now) });
  expect(q.code, q.out).toBe(0);
  expect(q.stdout).toContain(`[taytu] Claude limit reached; its reset time couldn't be read, so waiting claudeLimit.waitMinutes (45 min), until ${hhmm(now + 45 * 60)} (local)`);
});

test("wait sleeps until the reset plus the margin, then carries on; with no limit it returns at once", () => {
  const w = world({ claudeLimit: { marginSeconds: 1 } });
  expect(cmd(w, ["wait", "--name", "taytu"]).code).toBe(1);
  const now = Math.floor(Date.now() / 1000);
  write(w.state, JSON.stringify({ at: now, reset: now + 2, until: now + 2, window: "five_hour", pattern: "quota-rejected", text: "x", by: "haile" }));
  const start = Date.now();
  const p = cmd(w, ["wait", "--name", "taytu"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`[taytu] Claude limit reached; waiting until ${hhmm(now + 2)} (local)`);
  expect(p.stdout).toContain("the Claude limit should have reset; carrying on.");
  expect((Date.now() - start) / 1000).toBeGreaterThanOrEqual(2); // the reset, plus the margin
  expect(cmd(w, ["wait", "--name", "taytu"]).code).toBe(1); // it has passed: no second wait
});

test("a later limit already in the shared file is kept", () => {
  const w = world();
  const now = Math.floor(Date.now() / 1000);
  write(w.state, JSON.stringify({ at: now, reset: now + 7200, until: now + 7200, window: "seven_day", pattern: "quota-rejected", text: "x", by: "haile" }));
  transcript(w, [quotaReply(now + 600, SESSION, new Date(now * 1000).toISOString())]);
  expect(cmd(w, ["check", "--since", String(now - 5), "--name", "taytu"]).code).toBe(0);
  expect(readJson(w.state)).toMatchObject({ until: now + 7200, by: "haile" });
});

test("the soft budget: past claudeLimit.softTokens5h a loop starts no new task", () => {
  const w = world({ claudeLimit: { softTokens5h: 1000 } });
  const now = Math.floor(Date.now() / 1000);
  const reply = (id: string, ago: number) => ({ type: "assistant", timestamp: new Date((now - ago) * 1000).toISOString(), cwd: realpathSync(w.repo),
    message: { id, model: "claude-opus-5-5", usage: { input_tokens: 100, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000, output_tokens: 200 } } });
  transcript(w, [reply("m1", 3600)]); // 600 counted: under the budget
  expect(cmd(w, ["wait", "--name", "taytu"], { FACTORY_NOW: String(now) }).code).toBe(1);
  transcript(w, [reply("m1", 3600), reply("m2", 1800)]); // 1,200
  const p = cmd(w, ["wait", "--name", "taytu"], { FACTORY_NOW: String(now) });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("[taytu] The last 5 hours used 1,200 tokens, past claudeLimit.softTokens5h (1,000): starting no new task");
});

test("the settings, the commands page, factory help and the loops page know Claude's limit", () => {
  const settings = readmeAndWiki("settings.md");
  expect(settings).toContain("| `claudeLimit.waitMinutes` | int | `30` |");
  expect(settings).toContain("| `claudeLimit.marginSeconds` | int | `60` |");
  expect(settings).toContain("| `claudeLimit.softTokens5h` | int | `null` |");
  expect(readmeAndWiki("commands.md")).toContain("| `factory usage --window [--json]` |");
  expect(readmeAndWiki("agent-loops.md")).toContain("`Claude limit reached; waiting until HH:MM (local)`");
  const help = runHook("factory_usage", ["--help"]);
  expect(help.stdout).toContain("--window");
});
