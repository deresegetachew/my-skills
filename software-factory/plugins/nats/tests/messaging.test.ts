// The NATS transport plugin (#409, decision 0004) against a real nats-server with JetStream: the messaging port's
// contract, what goes over the wire (subjects, the JSON message), claims over the key-value bucket, nkey credentials,
// and the refusals when the server can't be reached.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, nkeys } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Message } from "../../../hooks/core/domain/message.ts";
import { messagingContract } from "../../../tests/contracts/messaging.ts";
import { createMessaging, type NatsMessaging } from "../index.ts";
import { freshProject, MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

let server: Server | null = null;
beforeAll(async () => {
  if (NATS_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

const url = (): string => (server as Server).url;
const port = (project = freshProject()): NatsMessaging => createMessaging({ url: url(), project });

function refusal(f: () => unknown): { code: string; message: string; fix: string } {
  try {
    f();
  } catch (e) {
    const x = e as { code?: string; message: string; fix?: string };
    return { code: x.code ?? "", message: x.message, fix: x.fix ?? "" };
  }
  throw new Error("expected an error with code, message and fix");
}

const question = (id: string, ref: string, frm = "haile"): Message =>
  new Message({ id, kind: "question", frm, to: "po", state: "submitted", ref });

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  messagingContract("nats", () => ({ port: port(), ref: "issue#5", other: "pr#7" }));

  test("a message goes on factory.<project>.<issue|pr>.<n>.<from> as the envelope's fields in JSON", async () => {
    const project = freshProject();
    port(project).send(new Message({ id: "q1abc", kind: "question", frm: "haile", to: "po", state: "submitted",
      ref: "pr#12", inReplyTo: "a0abc", sha: "b".repeat(40) }), "Which colour?\nDetails.");
    const nc = await connect({ servers: url() });
    try {
      const jsm = await jetstreamManager(nc);
      const stored = await jsm.streams.getMessage(`factory-${project}`, { seq: 1 });
      expect(stored?.subject).toBe(`factory.${project}.pr.12.haile`);
      const body = stored?.json<Record<string, unknown>>() ?? {};
      expect(body).toMatchObject({ v: 1, id: "q1abc", kind: "question", from: "haile", to: "po", state: "submitted",
        ref: "pr#12", "in-reply-to": "a0abc", sha: "b".repeat(40), text: "Which colour?\nDetails." });
      expect(typeof body.at).toBe("string");
    } finally {
      await nc.close();
    }
  });

  test("a message whose from doesn't match its subject's last token is dropped by the reader", async () => {
    const project = freshProject();
    const p = port(project);
    const start = p.read(null).cursor;
    p.send(question("q1abc", "issue#3"), "Real?");
    const nc = await connect({ servers: url() });
    try {
      const forged = { v: 1, id: "q2abc", kind: "question", from: "dev-manager", to: "po", state: "submitted", ref: "issue#3",
        text: "Forged", at: new Date().toISOString() };
      const js = (await jetstreamManager(nc)).jetstream();
      await js.publish(`factory.${project}.issue.3.haile`, JSON.stringify(forged));
    } finally {
      await nc.close();
    }
    expect(p.read(start).messages.map((m) => m.id)).toEqual(["q1abc"]);
  });

  test("a bare number reads both the issue and the PR of that number, and nothing else", () => {
    const p = port();
    p.send(question("q1abc", "issue#4"), "Issue?");
    p.send(question("q2abc", "pr#4"), "PR?");
    p.send(question("q3abc", "pr#40"), "Other?");
    expect(p.read(null, { ref: "4" }).messages.map((m) => m.id)).toEqual(["q1abc", "q2abc"]);
    expect(p.read(null, { ref: "#4" }).messages.map((m) => m.id)).toEqual(["q1abc", "q2abc"]);
    expect(refusal(() => p.read(null, { ref: "four" })).code).toBe("bad-ref");
  });

  test("two ports on one project see each other's messages; another project sees none", () => {
    const project = freshProject();
    const a = port(project);
    const b = port(project);
    a.send(question("q1abc", "issue#1"), "Hello?");
    expect(b.read(null).messages.map((m) => m.id)).toEqual(["q1abc"]);
    expect(port().read(null).messages).toEqual([]);
  });

  test("a project name that isn't lowercase letters, digits and dashes is refused", () => {
    const r = refusal(() => createMessaging({ url: url(), project: "My.Project" }));
    expect(r.code).toBe("bad-project");
    expect(r.fix.length).toBeGreaterThan(0);
  });

  // --- claims over the key-value bucket ---------------------------------------------------------------------------

  test("a claim is taken by the first holder; the second is told who holds it", () => {
    const project = freshProject();
    const a = port(project);
    const b = port(project);
    expect(a.claim("task.409", "haile", 600)).toEqual({ held: true, holder: "haile" });
    expect(b.claim("task.409", "abebe", 600)).toEqual({ held: false, holder: "haile" });
    expect(a.claim("task.409", "haile", 600)).toEqual({ held: true, holder: "haile" }); // again: still mine
  });

  test("a release by the holder frees the claim; a release by anyone else changes nothing", () => {
    const p = port();
    p.claim("task.1", "haile", 600);
    expect(p.release("task.1", "abebe")).toBe(false);
    expect(p.claim("task.1", "abebe", 600).holder).toBe("haile");
    expect(p.release("task.1", "haile")).toBe(true);
    expect(p.claim("task.1", "abebe", 600)).toEqual({ held: true, holder: "abebe" });
  });

  test("a claim past its ttl can be taken by someone else", async () => {
    const p = port();
    p.claim("task.2", "haile", 1);
    await Bun.sleep(1100);
    expect(p.claim("task.2", "abebe", 600)).toEqual({ held: true, holder: "abebe" });
  });

  test("of many claimants at once, exactly one wins", async () => {
    const project = freshProject();
    const names = ["a1", "a2", "a3", "a4", "a5", "a6"];
    const procs = names.map((n) => Bun.spawn([process.execPath, "--no-env-file", "-e",
      `import { createMessaging } from ${JSON.stringify(join(import.meta.dir, "..", "index.ts"))};` +
      `console.log(JSON.stringify(createMessaging({ url: ${JSON.stringify(url())}, project: ${JSON.stringify(project)} })` +
      `.claim("task.3", ${JSON.stringify(n)}, 600)));`], { stdout: "pipe", stderr: "pipe" }));
    const got = await Promise.all(procs.map(async (p) => JSON.parse(await new Response(p.stdout).text()) as { held: boolean; holder: string }));
    expect(got.filter((g) => g.held).length).toBe(1);
    expect(new Set(got.map((g) => g.holder)).size).toBe(1);
  });

  test("a claim key the bucket can't hold is refused with code message fix", () => {
    const r = refusal(() => port().claim("issue#409", "haile", 600));
    expect(r.code).toBe("bad-claim-key");
    expect(r.fix.length).toBeGreaterThan(0);
  });

  // --- credentials ----------------------------------------------------------------------------------------------------

  test("with a seed file the port signs in with that nkey; with none, a server that wants one refuses it", async () => {
    const user = nkeys.createUser();
    const pub = user.getPublicKey();
    const locked = await startServer(`authorization { users = [ { nkey: ${pub} } ] }`);
    try {
      const dir = mkdtempSync(join(tmpdir(), "nats-seed-"));
      const seed = join(dir, "haile.nk");
      writeFileSync(seed, new TextDecoder().decode(user.getSeed()) + "\n", { mode: 0o600 });
      const p = createMessaging({ url: locked.url, project: freshProject(), seed });
      p.send(question("q1abc", "issue#1"), "Signed?");
      expect(p.read(null).messages.map((m) => m.id)).toEqual(["q1abc"]);
      const anon = createMessaging({ url: locked.url, project: freshProject() });
      expect(refusal(() => anon.check()).code).toBe("nats-unreachable");
      const missing = createMessaging({ url: locked.url, project: freshProject(), seed: join(dir, "nobody.nk") });
      const r = refusal(() => missing.check());
      expect(r.code).toBe("nats-creds");
      expect(r.message).toContain("nobody.nk");
    } finally {
      locked.stop();
    }
  });
}

// --- no server --------------------------------------------------------------------------------------------------------

test("with no server at the url, check and send say nats-unreachable with the url and a fix, within a few seconds", () => {
  const p = createMessaging({ url: "nats://127.0.0.1:9", project: "p" });
  const start = Date.now();
  const r = refusal(() => p.check());
  expect(r.code).toBe("nats-unreachable");
  expect(r.message).toContain("nats://127.0.0.1:9");
  expect(r.fix.length).toBeGreaterThan(0);
  expect(refusal(() => p.send(question("q1abc", "issue#1"), "Hello?")).code).toBe("nats-unreachable");
  expect(Date.now() - start).toBeLessThan(15_000);
});

test("a message with no ref is refused before anything is sent", () => {
  const p = createMessaging({ url: "nats://127.0.0.1:9", project: "p" });
  expect(refusal(() => p.send(new Message({ id: "q1abc", kind: "question", frm: "haile" }), "Where?")).code).toBe("needs-ref");
});
