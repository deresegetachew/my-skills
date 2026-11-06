// The project's JetStream stream has limits (6 Nov 2026, "NATS is not the record"): messages older than 30 days go, and
// the stream never holds more than 1 GiB (the oldest go first). A stream made before the limits gets them on the next
// call, so a hub that is already running is brought in line. Against a real nats-server.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { DiscardPolicy, jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import { createMessaging } from "../index.ts";
import { freshProject, MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

setDefaultTimeout(60_000);
let server: Server | null = null;
beforeAll(async () => {
  if (NATS_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

const DAYS_30 = nanos(30 * 24 * 3600 * 1000);
const GIB = 1024 * 1024 * 1024;

async function streamConfig(project: string) {
  const nc = await connect({ servers: (server as Server).url });
  try {
    return (await (await jetstreamManager(nc)).streams.info(`factory-${project}`)).config;
  } finally {
    await nc.close();
  }
}

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  test("a new stream keeps 30 days and at most 1 GiB, dropping the oldest first", async () => {
    const project = freshProject();
    createMessaging({ url: (server as Server).url, project }).wake({ from: "haile", to: "dev-manager", ref: "", why: "pushed" });
    const c = await streamConfig(project);
    expect(c.max_age).toBe(DAYS_30);
    expect(c.max_bytes).toBe(GIB);
    expect(c.discard).toBe(DiscardPolicy.Old);
  });

  test("a stream made before the limits gets them on the next call, and keeps its messages", async () => {
    const project = freshProject();
    const nc = await connect({ servers: (server as Server).url });
    try {
      await (await jetstreamManager(nc)).streams.add({ name: `factory-${project}`, subjects: [`factory.${project}.>`],
        storage: StorageType.File, retention: RetentionPolicy.Limits, discard: DiscardPolicy.Old, allow_direct: true,
        duplicate_window: nanos(60 * 60 * 1000) });
    } finally {
      await nc.close();
    }
    const port = createMessaging({ url: (server as Server).url, project });
    port.wake({ from: "haile", to: "dev-manager", ref: "", why: "first" });
    expect((await streamConfig(project)).max_age).toBe(DAYS_30);
    port.wake({ from: "haile", to: "dev-manager", ref: "", why: "second" });
    const c = await streamConfig(project);
    expect(c.max_age).toBe(DAYS_30);
    expect(c.max_bytes).toBe(GIB);
    expect(port.waitWake({ names: ["dev-manager"], since: Date.now() - 60_000, seconds: 5 })).toMatchObject({ why: "first" });
  });
}
