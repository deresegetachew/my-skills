// `factory nats user add|check` (#408, decision 0004 point 4): one nkey per agent, the role's permissions in the
// server's users file, the seed in a mode-600 file, and a check that the server refuses a publish as someone else.
// The server here is a small fake that speaks the NATS text protocol and checks the nkey signature on CONNECT.
import { afterAll, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, runBun, sh, tmp, write, writeExe } from "./support.ts";

const dirs: string[] = [];
const servers: { stop(close?: boolean): void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Box {
  home: string;
  project: string;
  creds: string;
  server: string;
  bin: string;
  dockerLog: string;
}

/** A fake HOME, a git project called `demo`, and a fake `docker` (it logs its arguments; `dockerFails` makes it exit 1). */
function box(dockerFails = false): Box {
  const root = tmp();
  dirs.push(root);
  const home = join(root, "home");
  const project = join(root, "demo");
  const bin = join(root, "bin");
  for (const d of [home, project, bin]) mkdirSync(d);
  sh(["git", "init", "-q", project]);
  const dockerLog = join(root, "docker.log");
  writeExe(join(bin, "docker"), `#!/bin/sh\necho "$@" >> '${dockerLog}'\nexit ${dockerFails ? 1 : 0}\n`);
  return { home, project, bin, dockerLog, creds: join(home, ".secrets", "nats", "demo"),
    server: join(home, ".config", "factory", "nats", "demo") };
}

function nats(b: Box, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: b.home, PATH: `${b.bin}:${process.env.PATH ?? ""}`,
    ...extraEnv };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) if (!(k in extraEnv)) delete env[k];
  return runBun(join(HOOKS, "factory_nats_user.ts"), args, { cwd: b.project, env });
}

/** `check` talks to a server in this very process, so it can't be run with a blocking spawn. */
async function natsAsync(b: Box, args: string[], extraEnv: Record<string, string> = {}, script = "factory_nats_user.ts") {
  const env: Record<string, string | undefined> = { ...process.env, HOME: b.home, PATH: `${b.bin}:${process.env.PATH ?? ""}`, ...extraEnv };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) if (!(k in extraEnv)) delete env[k];
  const p = Bun.spawn([process.execPath, "--no-env-file", join(HOOKS, script), ...args], { cwd: b.project,
    env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr, out: stdout + stderr };
}

const mode = (p: string) => statSync(p).mode & 0o777;
const seedOf = (b: Box, name: string) => readFileSync(join(b.creds, `${name}.nk`), "utf8").trim();
const usersOf = (b: Box) => readFileSync(join(b.server, "users.conf"), "utf8");

// --- add ----------------------------------------------------------------------------------------------------------

test("add makes the seed file (mode 600, in a 700 folder) and never prints the seed", () => {
  const b = box();
  const r = nats(b, ["add", "alice", "--role", "coding-agent"]);
  expect(r.code).toBe(0);
  const seed = seedOf(b, "alice");
  expect(seed).toMatch(/^SU[A-Z2-7]{56}$/);
  expect(mode(join(b.creds, "alice.nk"))).toBe(0o600);
  expect(mode(b.creds)).toBe(0o700);
  expect(r.out).toContain(join(b.creds, "alice.nk"));
  expect(r.out).not.toContain(seed);
});

test("add puts the public key and the role's permissions in the users file, which a container can read", () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const conf = usersOf(b);
  expect(conf).toMatch(/nkey:\s*"?U[A-Z2-7]{55}"?/);
  expect(conf).not.toContain(seedOf(b, "alice"));
  // Each subject ends in the agent's own name.
  for (const s of ["factory.demo.claims.alice", "factory.demo.pr.*.alice", "factory.demo.issue.*.alice",
    "factory.demo.agent.*.alice", "factory.demo.wake.alice"]) expect(conf).toContain(s);
  expect(conf).not.toContain("factory.demo.handoff.alice");
  expect(mode(join(b.server, "users.conf"))).toBe(0o644);
  expect(mode(b.server)).toBe(0o755);
});

test("an agent gets no JetStream admin: no $JS.API.>, and acks only on its own durable", () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const conf = usersOf(b);
  expect(conf).not.toContain('"$JS.API.>"');
  expect(conf).not.toContain('"$JS.ACK.>"');
  expect(conf).not.toMatch(/STREAM\.(UPDATE|DELETE|PURGE|CREATE)/);
  expect(conf).toContain("$JS.ACK.factory-demo.alice.>");
});

test("a bad --project is refused, and so is a bad name or a loose seed folder", () => {
  const b = box();
  for (const project of ["*", "../x", "A b"]) {
    const r = nats(b, ["add", "alice", "--role", "coding-agent", "--project", project]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nats-project-name");
  }
  expect(existsSync(b.server)).toBe(false);
  mkdirSync(b.creds, { recursive: true, mode: 0o755 });
  chmodSync(b.creds, 0o755);
  const loose = nats(b, ["add", "alice", "--role", "coding-agent"]);
  expect(loose.code).toBe(1);
  expect(loose.stderr).toContain("nats-creds-mode");
  expect(existsSync(join(b.creds, "alice.nk"))).toBe(false);
});

test("a seed is never written through a link someone planted", () => {
  const b = box();
  mkdirSync(b.creds, { recursive: true, mode: 0o700 });
  const target = join(b.home, "victim");
  symlinkSync(target, join(b.creds, "alice.nk"));
  const r = nats(b, ["add", "alice", "--role", "coding-agent"]);
  expect(r.code).toBe(1);
  expect(existsSync(target)).toBe(false);
});

test("only a dev manager may publish hand-offs", () => {
  const b = box();
  for (const [name, role] of [["boss", "dev-manager"], ["pat", "product-owner"], ["bob", "coding-agent"]]) {
    expect(nats(b, ["add", name as string, "--role", role as string]).code).toBe(0);
  }
  const conf = usersOf(b);
  expect(conf).toContain("factory.demo.handoff.boss");
  expect(conf).not.toContain("factory.demo.handoff.pat");
  expect(conf).not.toContain("factory.demo.handoff.bob");
  // Three users, three different keys.
  expect(new Set(conf.match(/U[A-Z2-7]{55}/g)).size).toBe(3);
});

test("add asks the server to reload, and says so when no server is running", () => {
  const b = box();
  const r = nats(b, ["add", "alice", "--role", "coding-agent"]);
  expect(r.code).toBe(0);
  expect(readFileSync(b.dockerLog, "utf8")).toMatch(/HUP/);
  const down = box(true);
  const r2 = nats(down, ["add", "alice", "--role", "coding-agent"]);
  expect(r2.code).toBe(0);
  expect(r2.out).toMatch(/not running|not reloaded/i);
  expect(existsSync(join(down.creds, "alice.nk"))).toBe(true);
});

test("--creds and the project's messaging.creds setting say where the seed goes", () => {
  const b = box();
  const other = join(b.home, "elsewhere");
  expect(nats(b, ["add", "alice", "--role", "coding-agent", "--creds", other]).code).toBe(0);
  expect(existsSync(join(other, "alice.nk"))).toBe(true);
  mkdirSync(join(b.project, ".claude"));
  const set = join(b.home, "from-setting");
  write(join(b.project, ".claude", "factory.json"), JSON.stringify({ messaging: { creds: set } }));
  expect(nats(b, ["add", "bob", "--role", "coding-agent"]).code).toBe(0);
  expect(existsSync(join(set, "bob.nk"))).toBe(true);
});

test("a name that is taken is refused with {code, message, fix} and nothing changes", () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const seed = seedOf(b, "alice");
  const conf = usersOf(b);
  const r = nats(b, ["add", "alice", "--role", "dev-manager"]);
  expect(r.code).toBe(1);
  const e = JSON.parse(r.stderr.trim().split("\n").pop() as string);
  expect(e.code).toBe("nats-user-exists");
  expect(e.fix).toBeTruthy();
  expect(seedOf(b, "alice")).toBe(seed);
  expect(usersOf(b)).toBe(conf);
});

test("a bad name or role is refused and writes nothing", () => {
  const b = box();
  expect(nats(b, ["add", "Alice.B", "--role", "coding-agent"]).code).not.toBe(0);
  expect(nats(b, ["add", "alice", "--role", "owner"]).code).not.toBe(0);
  expect(nats(b, ["add", "alice"]).code).not.toBe(0);
  expect(existsSync(b.creds)).toBe(false);
  expect(existsSync(b.server)).toBe(false);
});

test("when the users file can't be written, the seed is taken back", () => {
  const b = box();
  mkdirSync(b.server, { recursive: true });
  mkdirSync(join(b.server, "users.conf")); // a folder where the file should be
  const r = nats(b, ["add", "alice", "--role", "coding-agent"]);
  expect(r.code).toBe(1);
  expect(existsSync(b.creds) ? readdirSync(b.creds) : []).toEqual([]);
});

// --- check: a fake server -----------------------------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of text) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

interface Fake {
  url: string;
  published: string[];
  signatureOk: boolean[];
}

/** A server that wants a signed nonce from `pub` (the users file's key) and lets a connection publish only on
 * subjects `allow` says yes to; `allow` always yes is the server that forgot its permissions. */
function fakeServer(pub: string, allow: (subject: string) => boolean): Fake {
  const fake: Fake = { url: "", published: [], signatureOk: [] };
  const raw = b32decode(pub).subarray(1, 33);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const nonce = "n0nce" + Math.random().toString(36).slice(2);
  const server = Bun.listen<{ buf: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: "" };
        s.write(`INFO ${JSON.stringify({ server_id: "fake", version: "2.10.0", auth_required: true, nonce, headers: true })}\r\n`);
      },
      data(s, chunk) {
        s.data.buf += chunk.toString();
        for (;;) {
          const nl = s.data.buf.indexOf("\r\n");
          if (nl < 0) return;
          const line = s.data.buf.slice(0, nl);
          if (line.startsWith("PUB ")) {
            const parts = line.split(" ");
            const len = Number(parts[parts.length - 1]);
            if (s.data.buf.length < nl + 2 + len + 2) return;
            s.data.buf = s.data.buf.slice(nl + 2 + len + 2);
            if (allow(parts[1] as string)) fake.published.push(parts[1] as string);
            else s.write(`-ERR 'Permissions Violation for Publish to "${parts[1]}"'\r\n`);
            continue;
          }
          s.data.buf = s.data.buf.slice(nl + 2);
          if (line.startsWith("CONNECT ")) {
            const c = JSON.parse(line.slice(8)) as { nkey?: string; sig?: string };
            const ok = c.nkey === pub && typeof c.sig === "string" && verify(null, Buffer.from(nonce), key, Buffer.from(c.sig, "base64url"));
            fake.signatureOk.push(ok);
            if (!ok) {
              s.write("-ERR 'Authorization Violation'\r\n");
              s.end();
              return;
            }
          } else if (line === "PING") s.write("PONG\r\n");
        }
      },
    },
  });
  servers.push(server);
  fake.url = `nats://127.0.0.1:${server.port}`;
  return fake;
}

const pubOf = (b: Box) => (usersOf(b).match(/U[A-Z2-7]{55}/) as RegExpMatchArray)[0];
/** Allowed: the agent's own subjects, which is what its role's permissions say. */
const ownOnly = (name: string) => (s: string) => s.endsWith(`.${name}`);

test("check signs in with the seed, publishes as itself, and finds a publish as another agent refused", async () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const fake = fakeServer(pubOf(b), ownOnly("alice"));
  const r = await natsAsync(b, ["check", "alice", "--url", fake.url]);
  expect(r.code).toBe(0);
  expect(fake.signatureOk).toContain(true);
  expect(fake.published.length).toBeGreaterThan(0);
  expect(fake.published.every((s) => s === "factory.demo.wake.alice")).toBe(true);
  expect(r.out).toMatch(/refused/i);
});

test("a server that accepts a publish as another agent fails the check", async () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const fake = fakeServer(pubOf(b), () => true);
  const r = await natsAsync(b, ["check", "alice", "--url", fake.url]);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/as another agent/i);
  expect(r.out).toMatch(/fix/i);
});

test("a server that lets an agent change the stream fails the check", async () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const fake = fakeServer(pubOf(b), (s) => s.endsWith(".alice") || s.startsWith("$JS.API.STREAM.UPDATE."));
  const r = await natsAsync(b, ["check", "alice", "--url", fake.url]);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/rewrite the stream/);
});

test("check refuses a name that could leave the seed folder", async () => {
  const b = box();
  const r = await natsAsync(b, ["check", "../x", "--url", "nats://127.0.0.1:1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("nats-user-name");
});

test("a server that refuses the agent's own subject fails the check", async () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const fake = fakeServer(pubOf(b), () => false);
  const r = await natsAsync(b, ["check", "alice", "--url", fake.url]);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/own subject/i);
});

test("check uses FACTORY_AGENT and messaging.url when no name or --url is given", async () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const fake = fakeServer(pubOf(b), ownOnly("alice"));
  mkdirSync(join(b.project, ".claude"));
  write(join(b.project, ".claude", "factory.json"), JSON.stringify({ messaging: { transport: "nats", url: fake.url, creds: b.creds } }));
  expect((await natsAsync(b, ["check"], { FACTORY_AGENT: "alice" })).code).toBe(0);
});

test("check fails with the fix when the seed is missing, too open, or the server is not there", async () => {
  const b = box();
  const fake = fakeServer("U" + "A".repeat(55), () => true);
  const missing = await natsAsync(b, ["check", "alice", "--url", fake.url]);
  expect(missing.code).toBe(1);
  expect(missing.out).toContain(join(b.creds, "alice.nk"));
  expect(missing.out).toContain("factory nats user add");

  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  chmodSync(join(b.creds, "alice.nk"), 0o644);
  const open = await natsAsync(b, ["check", "alice", "--url", fake.url]);
  expect(open.code).toBe(1);
  expect(open.out).toContain("chmod 600");
  chmodSync(join(b.creds, "alice.nk"), 0o600);
  chmodSync(b.creds, 0o755);
  const folder = await natsAsync(b, ["check", "alice", "--url", fake.url]);
  expect(folder.code).toBe(1);
  expect(folder.out).toContain("chmod 700");
  chmodSync(b.creds, 0o700);

  const gone = await natsAsync(b, ["check", "alice", "--url", "nats://127.0.0.1:1"]);
  expect(gone.code).toBe(1);
  expect(gone.out).toMatch(/answer|reach/i);
});

// --- wiring -------------------------------------------------------------------------------------------------------

test("factory help and the commands page list nats user add", () => {
  const help = sh([join(HOOKS, "..", "factory"), "help"]);
  expect(help.out).toContain("nats user add");
  expect(readFileSync(join(HOOKS, "..", "docs", "wiki", "commands.md"), "utf8")).toContain("factory nats user add");
});

test("factory doctor runs the credential check when messaging.transport is nats", async () => {
  const b = box();
  expect(nats(b, ["add", "alice", "--role", "coding-agent"]).code).toBe(0);
  const fake = fakeServer(pubOf(b), () => true);
  mkdirSync(join(b.project, ".claude"));
  write(join(b.project, ".claude", "factory.json"), JSON.stringify({ messaging: { transport: "nats", url: fake.url, creds: b.creds } }));
  const r = await natsAsync(b, [], { FACTORY_AGENT: "alice" }, "factory_doctor.ts");
  expect(r.out).toMatch(/accepted a publish as another agent/);
  const quiet = box();
  const off = await natsAsync(quiet, [], { FACTORY_AGENT: "alice" }, "factory_doctor.ts");
  expect(off.out).not.toMatch(/NATS/);
});
