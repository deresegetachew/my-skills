// The NATS plugin as a release ships it (#409, decision 0004 point 5): bundled into one file by tools/build_plugins.ts,
// loaded by hooks/factory_plugins.ts from a project's hooks folder that has no node_modules, and still able to talk to
// a real nats-server: each call runs the bundle itself as the child that holds the connection.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundlePlugin } from "../../../../tools/build_plugins.ts";
import { loadPlugin } from "../../../hooks/factory_plugins.ts";
import { Message } from "../../../hooks/core/domain/message.ts";
import type { Messaging } from "../../../hooks/core/ports/messaging.ts";
import { freshProject, MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

let server: Server | null = null;
beforeAll(async () => {
  if (NATS_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

const SF = join(import.meta.dir, "..", "..", "..");

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  test("the release's bundle loads with no node_modules and sends and reads over a real server", () => {
    const root = mkdtempSync(join(tmpdir(), "nats-bundle-"));
    const hooks = join(root, ".claude", "hooks");
    mkdirSync(join(hooks, "plugins"), { recursive: true });
    mkdirSync(join(root, ".claude", "factory"), { recursive: true });
    writeFileSync(join(root, ".claude", "factory", "release.json"), JSON.stringify({ version: "9.9.9" }));
    writeFileSync(join(hooks, "plugins", "nats.js"), bundlePlugin(SF, "nats", "9.9.9"));
    const mod = loadPlugin("nats", { hooks }) as { createMessaging: (o: { url: string; project: string }) => Messaging & { check(): void } };
    const port = mod.createMessaging({ url: (server as Server).url, project: freshProject() });
    port.check();
    port.send(new Message({ id: "q1abc", kind: "question", frm: "haile", to: "po", state: "submitted", ref: "issue#9" }), "Bundled?");
    const got = port.read(null);
    expect(got.messages.map((m) => [m.id, m.thread, m.summary])).toEqual([["q1abc", "issue#9", "Bundled?"]]);
  }, 120_000);
}
