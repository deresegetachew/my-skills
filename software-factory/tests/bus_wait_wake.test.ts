// `factory wait answer|slot|ready` with wake-ups on the message board (#410, moved from NATS in #504): between its looks
// at GitHub it listens for a wake-up instead of sleeping, so an answer is seen as soon as the dev manager's wake-up
// comes, while the looks themselves are messaging.pollMinutes apart. With wake off it looks every FACTORY_WAIT_START
// seconds as before. Against a real Postgres.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS } from "./support.ts";
import { busOf, calls, endBoard, type Project, project, startBoard } from "./bus_support.ts";

setDefaultTimeout(90_000);
beforeAll(startBoard, 600_000);
afterAll(endBoard, 120_000);

const QUESTION = "<!-- factory-msg v=1 id=q1abcdef kind=question from=haile to=dev-manager state=submitted ref=pr#7 -->\nWhich one?";
const ANSWER = "<!-- factory-msg v=1 id=a1abcdef kind=answer from=dm-1 to=haile state=completed ref=pr#7 in-reply-to=q1abcdef -->\nThis one.";

function waiting(name: string, kinds: string[]): Project {
  return project(name, { agents: ["haile"], roles: { "dev-manager": { names: ["dm-1"] } },
    messaging: { transport: "board", kinds, pollMinutes: 10 } },
  { comments: { 7: [{ id: 1, body: QUESTION, created_at: "2026-11-05T10:00:00Z", user: { login: "me" } }] } });
}

function answer(p: Project): void {
  const db = JSON.parse(readFileSync(p.db, "utf8")) as { comments: Record<string, unknown[]> };
  (db.comments["7"] as unknown[]).push({ id: 2, body: ANSWER, created_at: "2026-11-05T10:05:00Z", user: { login: "me" } });
  writeFileSync(p.db, JSON.stringify(db));
}

/** Start `factory wait answer 7 30` as haile; it looks every 10 minutes either way (FACTORY_WAIT_START / pollMinutes). */
function startWait(p: Project) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...p.env, FACTORY_AGENT: "haile", FACTORY_ROLE: "coding-agent", FACTORY_WAIT_START: "600",
    FACTORY_WAIT_MAX: "600" })) if (v !== undefined) env[k] = v;
  return Bun.spawn([process.execPath, "--no-env-file", join(HOOKS, "factory_wait.ts"), "answer", "7", "30"],
    { cwd: p.dir, env, stdout: "pipe", stderr: "pipe" });
}

test("wait answer: the dev manager's wake-up ends the wait as soon as the answer is there", async () => {
  const p = waiting("Wait1", ["wake"]);
  const proc = startWait(p);
  await Bun.sleep(3000);
  answer(p);
  const sent = Date.now();
  busOf("wait1").wake({ from: "dm-1", to: "all", ref: "pr#7", why: "answered" });
  const timer = setTimeout(() => proc.kill(9), 30_000);
  const code = await proc.exited;
  clearTimeout(timer);
  expect(Date.now() - sent).toBeLessThan(15_000);
  expect(code).toBe(0);
  expect(await new Response(proc.stdout).text()).toContain("PR #7: answered");
  expect(calls(p).filter((c) => c.includes("issues/7/comments")).length).toBe(3); // two looks before it waits, one after the wake
});

test("wait answer with wake off doesn't listen: the answer waits for the next look", async () => {
  const p = waiting("Wait2", ["question"]);
  const proc = startWait(p);
  await Bun.sleep(3000);
  answer(p);
  busOf("wait2").wake({ from: "dm-1", to: "all", ref: "pr#7", why: "answered" });
  await Bun.sleep(6000);
  expect(proc.exitCode).toBeNull(); // still waiting for its next look, 10 minutes after the first
  proc.kill(9);
  await proc.exited;
});
