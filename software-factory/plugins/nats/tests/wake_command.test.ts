// Wake-ups end to end (#410): `factory_wake.ts send` and `wait`, the hook that sends them when an agent opens a pull
// request or answers, `minutes` (the slower GitHub poll), and that with wake not in messaging.kinds nothing goes to
// NATS and a wait just sleeps. Against a real nats-server.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, runCode } from "../../../tests/support.ts";
import { createMessaging } from "../index.ts";
import { hook, type Project, project } from "./project.ts";
import { MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

setDefaultTimeout(60_000);
let server: Server | null = null;
beforeAll(async () => {
  if (NATS_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

const url = (): string => (server as Server).url;
const on = (extra: Record<string, unknown> = {}) => ({ agents: ["haile", "abebe"], roles: { "dev-manager": { names: ["dm-1"] } },
  messaging: { transport: "nats", url: url(), kinds: ["wake"], ...extra } });

/** The wake-ups said in project `name` since `since`, for `names`, waiting up to `seconds`. */
function heard(name: string, names: string[], since: number, seconds = 5) {
  return createMessaging({ url: url(), project: name }).waitWake({ names, since, seconds });
}

function hookEvent(p: Project, agent: string, command: string, role = "coding-agent") {
  const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } });
  const { runHook } = require("../../../tests/support.ts") as typeof import("../../../tests/support.ts");
  return runHook("factory_agents", ["hook"], { cwd: p.dir, input, timeoutMs: 60_000,
    env: { ...p.env, FACTORY_AGENT: agent, FACTORY_ROLE: role } });
}

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  test("send: a wake-up as FACTORY_AGENT reaches whoever listens for its addressee", () => {
    const p = project("Wake1", on());
    const since = Date.now();
    const r = hook(p, "factory_wake", ["send", "--to", "dev-manager", "--ref", "pr#3", "--why", "pushed"], "haile");
    expect(r.code, r.out).toBe(0);
    expect(heard("wake1", ["dm-1", "dev-manager", "all"], since)).toMatchObject({ from: "haile", ref: "pr#3", why: "pushed" });
  });

  test("wait: a dev manager is woken by a wake-up for dev-manager, and says by whom", () => {
    const p = project("Wake2", on());
    const since = Math.floor(Date.now() / 1000) - 1;
    createMessaging({ url: url(), project: "wake2" }).wake({ from: "haile", to: "dev-manager", ref: "pr#4", why: "opened a pull request" });
    const started = Date.now();
    const r = hook(p, "factory_wake", ["wait", "--seconds", "30", "--since", String(since)], "dm-1", { FACTORY_ROLE: "dev-manager" });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain("woken by haile: opened a pull request (pr#4)");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test("wait: a wake-up for someone else doesn't wake it; the time running out is exit 2", () => {
    const p = project("Wake3", on());
    createMessaging({ url: url(), project: "wake3" }).wake({ from: "haile", to: "po", ref: "", why: "for the product owner" });
    const r = hook(p, "factory_wake", ["wait", "--seconds", "2", "--since", String(Math.floor(Date.now() / 1000) - 1)], "dm-1",
      { FACTORY_ROLE: "dev-manager" });
    expect(r.code, r.out).toBe(2);
    expect(r.stdout).toBe("");
  });

  test("the hook: a coding agent's gh pr create wakes the dev manager; a dev manager's must-fix wakes the coding agents", async () => {
    const p = project("Wake4", on());
    let since = Date.now();
    expect(hookEvent(p, "haile", "gh pr create --title x --body y").code).toBe(0);
    expect(heard("wake4", ["dm-1", "dev-manager", "all"], since, 10)).toMatchObject({ from: "haile", why: "opened a pull request" });
    since = Date.now();
    expect(hookEvent(p, "dm-1", "gh pr comment 7 --body '<!-- factory-mustfix sha=abcdef1 -->'", "dev-manager").code).toBe(0);
    expect(heard("wake4", ["abebe", "coding-agent", "all"], since, 10))
      .toMatchObject({ from: "dm-1", to: "coding-agent", ref: "pr#7", why: "asked for a fix" });
  });

  // #413 (re-scoped 6 Nov 2026): questions, answers and hand-offs stay on GitHub; a wake-up tells the addressee at once.
  test("the hook: a question written in a --body-file wakes its addressee", () => {
    const p = project("Wake8", on());
    writeFileSync(join(p.dir, "q.md"), "<!-- factory-msg v=1 id=01abc23def kind=question from=haile to=po state=submitted ref=issue#7 -->\n" +
      "Which colour?\n");
    const since = Date.now();
    expect(hookEvent(p, "haile", "gh issue comment 7 --body-file q.md").code).toBe(0);
    expect(heard("wake8", ["po"], since, 10)).toMatchObject({ from: "haile", to: "po", why: "asked a question" });
  });

  test("the hook: an answer addressed to one agent wakes that agent, not every loop", () => {
    const p = project("Wake9", on());
    const since = Date.now();
    const body = "<!-- factory-msg v=1 id=01abc23dff kind=answer from=dm-1 to=haile state=completed ref=pr#5 in-reply-to=01abc23def -->";
    expect(hookEvent(p, "dm-1", `gh pr comment 5 --body '${body}\nBlue.'`, "dev-manager").code).toBe(0);
    expect(heard("wake9", ["haile"], since, 10)).toMatchObject({ from: "dm-1", to: "haile", ref: "pr#5", why: "answered a question" });
  });

  test("a sub-manager's hand-off on a pull request (its next step) wakes the coding agents", () => {
    const pr = { number: 5, title: "Fix", state: "open", draft: true, head: { sha: "a".repeat(40), ref: "task/1-fix" }, labels: [] };
    const p = project("Wake10", on(), { pulls: [pr], issues: [{ ...pr, pull_request: {} }], comments: { 5: [] } });
    const since = Date.now();
    const code = `import { leaveVerdict } from ${JSON.stringify(join(HOOKS, "factory_orchestrator.ts"))};
      import { load } from ${JSON.stringify(join(HOOKS, "factory_config.ts"))};
      const item = { pr: 5, kind: "review", ref: "pr-5", target: 5 } as unknown as Parameters<typeof leaveVerdict>[2];
      console.log(leaveVerdict(load(), "dm-1", item, new Set(), () => {}));`;
    const r = runCode(code, { cwd: p.dir, env: { ...p.env, FACTORY_AGENT: "dm-1", FACTORY_ROLE: "dev-manager" } });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout.trim()).toBe("true");
    expect(heard("wake10", ["abebe", "coding-agent", "all"], since, 10))
      .toMatchObject({ from: "dm-1", to: "coding-agent", ref: "pr#5", why: "left the next step" });
  });

  test("minutes: an idle wait is messaging.pollMinutes while wake-ups come over NATS, else the loop's own", () => {
    expect(hook(project("Wake5", on({ pollMinutes: 20 })), "factory_wake", ["minutes", "1"], "haile").stdout.trim()).toBe("20");
    expect(hook(project("Wake5", on()), "factory_wake", ["minutes", "1"], "haile").stdout.trim()).toBe("15");
    expect(hook(project("Wake5", on({ kinds: [] })), "factory_wake", ["minutes", "1"], "haile").stdout.trim()).toBe("1");
  });

  test("without wake in messaging.kinds nothing is sent, and a wait sleeps its time and exits 2", () => {
    const p = project("Wake6", on({ kinds: ["question"] }));
    const since = Date.now();
    expect(hook(p, "factory_wake", ["send", "--to", "dev-manager"], "haile").code).toBe(0);
    expect(hookEvent(p, "haile", "gh pr create --title x").code).toBe(0);
    expect(heard("wake6", ["dm-1", "dev-manager", "all"], since, 2)).toBeNull();
    const started = Date.now();
    const r = hook(p, "factory_wake", ["wait", "--seconds", "1"], "dm-1");
    expect(r.code).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test("with NATS down, minutes is the loop's own and a wait sleeps, saying nats-unreachable once", () => {
    const p = project("Wake7", { messaging: { transport: "nats", url: "nats://127.0.0.1:9", kinds: ["wake"] } });
    expect(hook(p, "factory_wake", ["minutes", "1"], "haile").stdout.trim()).toBe("1");
    const r = hook(p, "factory_wake", ["wait", "--seconds", "1"], "haile");
    expect(r.code).toBe(2);
    expect(r.stderr.split("nats-unreachable").length - 1).toBe(1);
  });
}
