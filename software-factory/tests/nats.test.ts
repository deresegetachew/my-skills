// `factory nats up|down|status` and the doctor's "server answers" check (decision 0004, points 3 and 4).
//
// Docker and tailscale are fakes on PATH that log what they were asked. The NATS server is a tiny Bun script in its own
// process that sends the `INFO {json}` line a real server sends on connect, so the hook can read it.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { doctor, lines, machine, project as doctorProject } from "./doctor_support.ts";
import { read, runHook, sh, type Proc, tmp, write, writeExe } from "./support.ts";

const INFO = '{"server_id":"x","version":"2.10.22","jetstream":true,"max_payload":1048576}';
const SERVER = String.raw`import { writeFileSync } from "node:fs";
const info = process.argv[3] as string;
const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
  open(s: any) { s.write("INFO " + info + "\r\n"); }, data() {}, close() {}, error() {} } });
writeFileSync(process.argv[2] as string, String(server.port));
setInterval(() => {}, 1000);
`;

const servers: { kill(sig?: number): void }[] = [];
afterAll(() => servers.forEach((s) => s.kill(9)));

/** Start a fake NATS server; returns its port. */
function listen(info = INFO): number {
  const d = tmp();
  const script = write(join(d, "server.ts"), SERVER);
  const portFile = join(d, "port");
  const p = Bun.spawn([process.execPath, "--no-env-file", script, portFile, info], { stdout: "ignore", stderr: "ignore" });
  servers.push(p);
  const deadline = Date.now() + 10_000;
  while (!(existsSync(portFile) && read(portFile).length > 0) && Date.now() < deadline) Bun.sleepSync(20);
  return Number(read(portFile));
}

/** A port nothing listens on. */
function closedPort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.docker"
[ "\${FAKE_DOCKER_DOWN:-0}" = 1 ] && [ "$1" = info ] && exit 1
if [ "\${FAKE_COMPOSE_FAILS:-0}" = 1 ] && [ "$1" = compose ]; then
  case "$*" in *" up "*) echo "pull access denied" >&2; exit 1 ;; esac
fi
exit 0
`;
const FAKE_TAILSCALE = `#!/usr/bin/env bash
if [ "$1 $2" = "ip -4" ]; then echo 100.101.102.103; echo 100.101.102.104; exit 0; fi
exit 1
`;

interface Rig { dir: string; env: Record<string, string>; state: string; nats: string; bin: string }

function rig(o: { docker?: boolean; tailscale?: boolean } = {}): Rig {
  const root = tmp();
  const dir = join(root, "widget");
  const bin = join(root, "bin");
  const state = join(root, "state");
  sh(["git", "init", "-q", "-b", "main", dir]);
  write(join(dir, ".claude", "factory.json"), "{}");
  write(join(bin, "placeholder"), "");
  for (const t of ["git", "bash", "sh", "env", "cat", "dirname", "basename", "uname"]) {
    const found = Bun.which(t);
    if (found) symlinkSync(found, join(bin, t));
  }
  if (o.docker ?? true) writeExe(join(bin, "docker"), FAKE_DOCKER);
  if (o.tailscale ?? true) writeExe(join(bin, "tailscale"), FAKE_TAILSCALE);
  const env: Record<string, string> = { PATH: bin, HOME: root, XDG_STATE_HOME: state, FAKE_LOG: join(root, "log"),
    FACTORY_NATS_WAIT: "2" };
  for (const k of ["FACTORY_CONFIG_DIR", "FACTORY_CLAIM_SETTLE_SECONDS"]) if (process.env[k]) env[k] = process.env[k] as string;
  return { dir, env, state, nats: join(state, "widget-factory", "nats"), bin };
}

function nats(r: Rig, args: string[], extra: Record<string, string> = {}): Proc {
  return runHook("factory_nats", args, { cwd: r.dir, env: { ...r.env, ...extra }, timeoutMs: 60_000 });
}

function dockerLog(r: Rig): string {
  try { return read(r.env.FAKE_LOG + ".docker"); } catch { return ""; }
}

function files(r: Rig): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(r.nats)) return out;
  for (const f of readdirSync(r.nats).sort()) out[f] = read(join(r.nats, f));
  return out;
}

function mode(p: string): number { return statSync(p).mode & 0o777; }

function errorOf(p: Proc): { code: string; message: string; fix: string } {
  return JSON.parse(p.stderr.trim().split("\n").filter((l) => l.startsWith("{")).pop() as string);
}

const compose = (r: Rig): string => read(join(r.nats, "compose.yaml"));
const conf = (r: Rig): string => read(join(r.nats, "nats.conf"));

// ---------- up as a hub ----------
test("up as a hub writes a compose file that publishes only on the tailnet address, pinned and restarting", () => {
  const r = rig();
  const p = nats(r, ["up", "--address", "100.64.1.2"]);
  expect(p.code).toBe(0);
  const text = compose(r);
  expect(text).toContain('"100.64.1.2:4222:4222"');
  expect(text).toContain('"100.64.1.2:7422:7422"');
  expect(text).not.toContain("0.0.0.0");
  expect(text).toMatch(/image:\s*nats:\d+\.\d+\.\d+/);
  expect(text).not.toContain("latest");
  expect(text).toContain("restart: unless-stopped");
  expect(text).toContain("./nats.conf");
});

test("a hub's nats.conf turns JetStream on with a store folder and opens the leaf port", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2"]);
  const text = conf(r);
  expect(text).toContain("jetstream");
  expect(text).toContain("store_dir");
  expect(text).toMatch(/leafnodes\s*\{[^}]*port:\s*7422/);
});

test("up saves the choices in nats.json", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2"], { FACTORY_NATS_PORT: "4333", FACTORY_NATS_LEAF_PORT: "7444" });
  const saved = JSON.parse(read(join(r.nats, "nats.json")));
  expect(saved).toMatchObject({ role: "hub", address: "100.64.1.2", port: 4333, leafPort: 7444 });
  expect(compose(r)).toContain('"100.64.1.2:4333:4222"');
  expect(compose(r)).toContain('"100.64.1.2:7444:7422"');
});

test("the address comes from the first line of tailscale ip -4 when --address is not given", () => {
  const r = rig();
  const p = nats(r, ["up"]);
  expect(p.code).toBe(0);
  expect(compose(r)).toContain('"100.101.102.103:4222:4222"');
  expect(compose(r)).not.toContain("100.101.102.104");
});

test("the folder is readable by the container's user and the files are not writable by others", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2"]);
  expect(mode(r.nats)).toBe(0o755);
  for (const f of ["compose.yaml", "nats.conf", "nats.json"]) expect(mode(join(r.nats, f))).toBe(0o644);
});

test("up asks docker info, then compose up -d on the compose file in the state folder", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2"]);
  const calls = dockerLog(r).trim().split("\n");
  expect(calls[0]).toBe("info");
  const up = calls.find((c) => c.startsWith("compose")) as string;
  expect(up).toContain(`--file ${join(r.nats, "compose.yaml")}`);
  expect(up).toContain("--project-name");
  expect(up).toContain("up -d");
});

test("up waits for the server, says it answers with its address and JetStream, and prints the network guard line", () => {
  const port = listen();
  const r = rig();
  const p = nats(r, ["up", "--address", "127.0.0.1"], { FACTORY_NATS_PORT: String(port) });
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("answers");
  expect(p.stdout).toContain(`nats://127.0.0.1:${port}`);
  expect(p.stdout).toContain("JetStream on");
  expect(p.stdout).toContain(`factory bootstrap machine --apply --allow-host 127.0.0.1:${port}`);
});

test("up exits 0 when compose worked but the server does not answer yet, and says so", () => {
  const r = rig();
  const p = nats(r, ["up", "--address", "127.0.0.1"], { FACTORY_NATS_PORT: String(closedPort()) });
  expect(p.code).toBe(0);
  expect(p.stdout).toMatch(/not answer|doesn't answer|no answer/i);
});

test("a second up with the same inputs leaves the three files byte-identical and exits 0", () => {
  const r = rig();
  expect(nats(r, ["up", "--address", "100.64.1.2"]).code).toBe(0);
  const before = files(r);
  expect(Object.keys(before).sort()).toEqual(["compose.yaml", "nats.conf", "nats.json"]);
  expect(nats(r, ["up", "--address", "100.64.1.2"]).code).toBe(0);
  expect(files(r)).toEqual(before);
});

// ---------- up as a leaf ----------
test("up --leaf writes a leaf: a remote to the hub, no JetStream, only the client port published", () => {
  const r = rig();
  const p = nats(r, ["up", "--address", "100.64.1.2", "--leaf", "100.64.9.9"]);
  expect(p.code).toBe(0);
  expect(conf(r)).toContain("remotes");
  expect(conf(r)).toContain("nats-leaf://100.64.9.9:7422");
  expect(conf(r)).not.toContain("jetstream");
  expect(compose(r)).toContain('"100.64.1.2:4222:4222"');
  expect(compose(r)).not.toContain("7422");
  expect(compose(r)).not.toContain("0.0.0.0");
  expect(JSON.parse(read(join(r.nats, "nats.json")))).toMatchObject({ role: "leaf", hub: "100.64.9.9:7422" });
});

test("up --leaf takes the hub's port and the guard line names the hub too", () => {
  const r = rig();
  const p = nats(r, ["up", "--address", "100.64.1.2", "--leaf", "100.64.9.9:7500"]);
  expect(conf(r)).toContain("nats-leaf://100.64.9.9:7500");
  expect(p.stdout).toContain("--allow-host 100.64.1.2:4222");
  expect(p.stdout).toContain("--allow-host 100.64.9.9:7500");
});

test("a second up with no role flag stays a leaf", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2", "--leaf", "100.64.9.9"]);
  const before = files(r);
  expect(nats(r, ["up", "--address", "100.64.1.2"]).code).toBe(0);
  expect(files(r)).toEqual(before);
  expect(JSON.parse(read(join(r.nats, "nats.json"))).role).toBe("leaf");
});

test("up --hub switches a leaf back to a hub", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2", "--leaf", "100.64.9.9"]);
  expect(nats(r, ["up", "--address", "100.64.1.2", "--hub"]).code).toBe(0);
  expect(JSON.parse(read(join(r.nats, "nats.json"))).role).toBe("hub");
  expect(conf(r)).toContain("jetstream");
  expect(compose(r)).toContain('"100.64.1.2:7422:7422"');
});

// ---------- refusals ----------
function refused(p: Proc, code: string, r: Rig): void {
  expect(p.code).toBe(1);
  const e = errorOf(p);
  expect(e.code).toBe(code);
  expect(e.message.length).toBeGreaterThan(0);
  expect(e.fix.length).toBeGreaterThan(0);
  expect(existsSync(r.nats)).toBe(false);
}

test("up refuses when docker is not installed, and changes nothing", () => {
  const r = rig({ docker: false });
  refused(nats(r, ["up", "--address", "100.64.1.2"]), "docker-missing", r);
});

test("up refuses when docker is not running, and changes nothing", () => {
  const r = rig();
  const p = nats(r, ["up", "--address", "100.64.1.2"], { FAKE_DOCKER_DOWN: "1" });
  refused(p, "docker-down", r);
  expect(dockerLog(r)).not.toContain("compose");
});

test("up refuses with no tailscale and no --address", () => {
  const r = rig({ tailscale: false });
  refused(nats(r, ["up"]), "no-address", r);
});

test("up refuses 0.0.0.0", () => {
  const r = rig();
  refused(nats(r, ["up", "--address", "0.0.0.0"]), "wide-address", r);
});

test("up refuses an address that is not an IP", () => {
  const r = rig();
  refused(nats(r, ["up", "--address", "not-an-ip"]), "bad-address", r);
});

test("up refuses a hub given as a name instead of an IP", () => {
  const r = rig();
  refused(nats(r, ["up", "--address", "100.64.1.2", "--leaf", "hub.example.com"]), "bad-address", r);
});

test("a refusal on a second run leaves the previous files exactly as they were", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2"]);
  const before = files(r);
  const p = nats(r, ["up", "--address", "0.0.0.0"]);
  expect(p.code).toBe(1);
  expect(files(r)).toEqual(before);
});

test("when compose up fails, up exits 1 with compose-failed and puts the files back", () => {
  const r = rig();
  const p = nats(r, ["up", "--address", "100.64.1.2"], { FAKE_COMPOSE_FAILS: "1" });
  expect(p.code).toBe(1);
  expect(errorOf(p).code).toBe("compose-failed");
  expect(existsSync(join(r.nats, "compose.yaml"))).toBe(false);
});

test("when compose up fails on a later run, the earlier files come back", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2"]);
  const before = files(r);
  const p = nats(r, ["up", "--address", "100.64.1.9"], { FAKE_COMPOSE_FAILS: "1" });
  expect(errorOf(p).code).toBe("compose-failed");
  expect(files(r)).toEqual(before);
});

// ---------- down ----------
test("down when nothing is set up says so, names factory nats up and does not call docker", () => {
  const r = rig();
  const p = nats(r, ["down"]);
  expect(p.code).toBe(0);
  expect(p.out).toMatch(/no NATS server is set up here/i);
  expect(p.out).toContain("factory nats up");
  expect(dockerLog(r)).toBe("");
});

test("down stops the containers without removing volumes and keeps the files", () => {
  const r = rig();
  nats(r, ["up", "--address", "100.64.1.2"]);
  const before = files(r);
  const p = nats(r, ["down"]);
  expect(p.code).toBe(0);
  const call = dockerLog(r).trim().split("\n").filter((c) => c.startsWith("compose")).pop() as string;
  expect(call).toContain(`--file ${join(r.nats, "compose.yaml")}`);
  expect(call).toContain("--project-name");
  expect(call).toContain("down --remove-orphans");
  expect(call).not.toContain("--volumes");
  expect(call).not.toContain(" -v");
  expect(files(r)).toEqual(before);
});

// ---------- status ----------
test("status when nothing is set up says so and exits 0", () => {
  const r = rig();
  const p = nats(r, ["status"]);
  expect(p.code).toBe(0);
  expect(p.out).toMatch(/no NATS server is set up here/i);
  expect(p.out).toContain("factory nats up");
});

test("status of a server that answers shows role, address, version and JetStream", () => {
  const port = listen();
  const r = rig();
  nats(r, ["up", "--address", "127.0.0.1"], { FACTORY_NATS_PORT: String(port) });
  const p = nats(r, ["status"], { FACTORY_NATS_PORT: String(port) });
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("hub");
  expect(p.stdout).toContain("127.0.0.1");
  expect(p.stdout).toContain("answers");
  expect(p.stdout).toContain("2.10.22");
  expect(p.stdout).toContain("JetStream on");
});

test("status of a server that does not answer says so, names factory nats up and exits 1", () => {
  const r = rig();
  const port = closedPort();
  nats(r, ["up", "--address", "127.0.0.1"], { FACTORY_NATS_PORT: String(port) });
  const p = nats(r, ["status"], { FACTORY_NATS_PORT: String(port) });
  expect(p.code).toBe(1);
  expect(p.out).toMatch(/not answer|doesn't answer|no answer/i);
  expect(p.out).toContain("factory nats up");
});

test("an unknown subcommand prints usage on stderr and exits 2", () => {
  const r = rig();
  const p = nats(r, ["frobnicate"]);
  expect(p.code).toBe(2);
  expect(p.stderr).toMatch(/usage/i);
});

// ---------- doctor ----------
function doctorFor(cfg: Record<string, unknown>): Proc {
  const d = doctorProject({}, { agents: ["menelik", "taytu"], ...cfg });
  return doctor(d, { ...machine(), FACTORY_AGENTS: "taytu" });
}

test("doctor says the NATS server answers when it does", () => {
  const port = listen();
  const p = doctorFor({ messaging: { transport: "nats", url: `nats://127.0.0.1:${port}` } });
  expect(lines(p, "ok").some((l) => l.includes("NATS server answers"))).toBe(true);
});

test("doctor tells the person to run factory nats up when nothing listens", () => {
  const port = closedPort();
  const p = doctorFor({ messaging: { transport: "nats", url: `nats://127.0.0.1:${port}` } });
  const fix = lines(p, "fix").filter((l) => l.includes("NATS"));
  expect(fix.length).toBeGreaterThan(0);
  expect(fix.some((l) => l.includes("factory nats up"))).toBe(true);
});

test("doctor says nothing about NATS with the github transport", () => {
  const p = doctorFor({});
  expect(p.out).not.toMatch(/nats/i);
});
