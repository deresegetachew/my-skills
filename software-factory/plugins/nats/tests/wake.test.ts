// The plugin's wake-ups and claim lookups (#410, #411): a wake goes on factory.<project>.wake.<from>; a waiting reader
// gets the first wake addressed to one of its names since a time, or null when its wait runs out; and a claim can be
// looked up (holder) or dropped whoever holds it (drop). Against a real nats-server.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createMessaging, type NatsMessaging } from "../index.ts";
import { freshProject, MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

let server: Server | null = null;
beforeAll(async () => {
  if (NATS_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

const port = (project = freshProject()): NatsMessaging => createMessaging({ url: (server as Server).url, project });

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  test("a wake goes on factory.<project>.wake.<from> with from, to, ref and why", async () => {
    const project = freshProject();
    port(project).wake({ from: "haile", to: "dev-manager", ref: "pr#12", why: "opened a pull request" });
    const nc = await connect({ servers: (server as Server).url });
    try {
      const stored = await (await jetstreamManager(nc)).streams.getMessage(`factory-${project}`, { seq: 1 });
      expect(stored?.subject).toBe(`factory.${project}.wake.haile`);
      expect(stored?.json<Record<string, unknown>>()).toMatchObject({ v: 1, kind: "wake", from: "haile", to: "dev-manager",
        ref: "pr#12", text: "opened a pull request" });
    } finally {
      await nc.close();
    }
  });

  test("a wait gets a wake said since the time it gives, addressed to one of its names", () => {
    const p = port();
    const since = Date.now();
    p.wake({ from: "haile", to: "dev-manager", ref: "pr#12", why: "pushed" });
    const got = p.waitWake({ names: ["dm-1", "dev-manager", "all"], since, seconds: 5 });
    expect(got).toMatchObject({ from: "haile", to: "dev-manager", ref: "pr#12", why: "pushed" });
  });

  test("a wait ignores wakes for others, its own and older ones, and gives null when its time runs out", () => {
    const p = port();
    p.wake({ from: "haile", to: "dev-manager", ref: "", why: "old" });
    Bun.sleepSync(20);
    const since = Date.now();
    p.wake({ from: "haile", to: "po", ref: "", why: "for the product owner" });
    p.wake({ from: "dm-1", to: "all", ref: "", why: "my own" });
    const started = Date.now();
    expect(p.waitWake({ names: ["dm-1", "dev-manager", "all"], since, seconds: 2 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  });

  test("a wait returns as soon as a wake arrives while it waits", async () => {
    const project = freshProject();
    const since = Date.now();
    const waiter = Bun.spawn([process.execPath, "-e", `import { createMessaging } from ${JSON.stringify(`${import.meta.dir}/../index.ts`)};
      const w = createMessaging({ url: ${JSON.stringify((server as Server).url)}, project: ${JSON.stringify(project)} })
        .waitWake({ names: ["haile", "coding-agent", "all"], since: ${since}, seconds: 30 });
      console.log(JSON.stringify(w));`], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(1500);
    const sent = Date.now();
    port(project).wake({ from: "dm-1", to: "coding-agent", ref: "pr#3", why: "must-fix" });
    await waiter.exited;
    expect(Date.now() - sent).toBeLessThan(10_000);
    expect(JSON.parse(await new Response(waiter.stdout).text())).toMatchObject({ from: "dm-1", why: "must-fix" });
  });

  test("holder names who holds a claim (empty when nobody, or when it ran out); drop frees it whoever holds it", async () => {
    const p = port();
    expect(p.holder("review.12.abcdef1")).toBe("");
    p.claim("review.12.abcdef1", "dm-1", 600);
    expect(p.holder("review.12.abcdef1")).toBe("dm-1");
    expect(p.drop("review.12.abcdef1")).toBe(true);
    expect(p.holder("review.12.abcdef1")).toBe("");
    expect(p.drop("review.12.abcdef1")).toBe(false);
    p.claim("task.7", "haile", 1);
    await Bun.sleep(1100);
    expect(p.holder("task.7")).toBe("");
  });
}
