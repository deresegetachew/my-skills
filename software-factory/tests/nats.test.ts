// `factory nats up|down|status` (#407) and `factory nats user add` (#408), decision 0004 points 3 and 4.
//
// Docker can't run in the tests: `docker` and `tailscale` are fakes on PATH that log what they were given, and the
// server's monitoring port and the NATS port itself are small fake servers in their own processes (the hook runs with
// spawnSync, which blocks this process). What is checked is what a person sees: output, exit codes, the files
// written with their modes, and the docker commands run.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { doctor as runDoctor, machine, project as doctorProject } from "./doctor_support.ts";
import { read, runHook, SF, sh, type Proc, tmp, WIKI, write, writeExe } from "./support.ts";

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.docker"
[ "$1" = info ] && { [ "\${FAKE_DOCKER_DOWN:-0}" = 1 ] && exit 1; exit 0; }
case " $* " in *" up "*) [ "\${FAKE_COMPOSE_FAIL:-0}" = 1 ] && { echo "Error: port is already allocated" >&2; exit 1; } ;; esac
case " $* " in *" kill "*) [ "\${FAKE_NOT_RUNNING:-0}" = 1 ] && { echo "no container" >&2; exit 1; } ;; esac
exit 0
`;
const FAKE_TAILSCALE = `#!/usr/bin/env bash
[ "$*" = "ip -4" ] || exit 2
[ -n "\${FAKE_TS_IP:-}" ] || { echo "Tailscale is stopped." >&2; exit 1; }
echo "$FAKE_TS_IP"
`;

type Env = Record<string, string | undefined>;
interface World { d: string; root: string; env: Env; dir: string }

function world(cfg: Record<string, unknown> = {}): World {
  const root = tmp("nats-");
  const d = join(root, "work");
  const bin = join(root, "bin");
  sh(["git", "init", "-q", "-b", "main", d]);
  sh(["git", "-C", d, "remote", "add", "origin", "git@github.com:acme/Widget.git"]);
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  writeExe(join(bin, "docker"), FAKE_DOCKER);
  writeExe(join(bin, "tailscale"), FAKE_TAILSCALE);
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("FACTORY_") && !k.startsWith("CLAUDE")) env[k] = v;
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, HOME: root, FAKE_LOG: join(root, "log"),
    FACTORY_CONFIG_DIR: join(root, "cfg"), FACTORY_NATS_WAIT: "0", FAKE_TS_IP: "100.64.0.7" });
  return { d, root, env, dir: join(root, "cfg", "nats") };
}

function nats(w: World, args: string[], extra: Env = {}): Proc {
  return runHook("factory_nats", args, { cwd: w.d, env: { ...w.env, ...extra }, timeoutMs: 60_000 });
}

function dockerLog(w: World): string {
  return existsSync(`${w.env.FAKE_LOG}.docker`) ? read(`${w.env.FAKE_LOG}.docker`) : "";
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function error(p: Proc): { code: string; message: string; fix: string } {
  return JSON.parse(p.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
}

// ---------- fake servers, each in its own process ----------
const procs: { kill(n?: number): void }[] = [];
afterAll(() => procs.forEach((p) => p.kill(9)));

function startScript(code: string, ...args: string[]): number {
  const d = tmp("nats-srv-");
  const script = write(join(d, "srv.ts"), code);
  const portFile = join(d, "port");
  const p = Bun.spawn(["sh", "-c", 'exec "$0" --no-env-file "$@" > "$PORT_FILE"', process.execPath, script, ...args],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, PORT_FILE: portFile } });
  procs.push(p);
  const deadline = Date.now() + 10_000;
  while (!(existsSync(portFile) && read(portFile).includes("\n")) && Date.now() < deadline) Bun.sleepSync(20);
  return Number(read(portFile).trim());
}

const MONITOR = String.raw`const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/healthz") return Response.json({ status: "ok" });
  if (u.pathname === "/varz") return Response.json({ version: "2.15.2", connections: 3, leafnodes: 1, jetstream: { config: {} } });
  return new Response("", { status: 404 });
} });
console.log(server.port);
`;

// A NATS server that speaks just enough: INFO with a nonce, then for each PUB either a permissions error (strict:
// a subject whose last token isn't the sender's, here "not-*") or nothing, and PONG to PING.
const NATS = String.raw`const strict = process.argv[2] === "strict";
const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
  open(s) { s.write('INFO {"server_id":"x","version":"2.15.2","nonce":"abc123","auth_required":true}\r\n'); },
  data(s, d) {
    for (const line of d.toString().split("\r\n")) {
      const m = /^PUB (\S+)/.exec(line);
      if (m && strict && /\.not-[^.]+$/.test(m[1])) s.write("-ERR 'Permissions Violation for Publish to \"" + m[1] + "\"'\r\n");
      if (line === "PING") s.write("PONG\r\n");
    }
  },
} });
console.log(server.port);
`;

// ---------- up ----------
test("up writes a hub: pinned image, JetStream on a volume, localhost and Tailscale only, and starts it", () => {
  const w = world();
  const p = nats(w, ["up"]);
  expect(p.code, p.out).toBe(0);
  const compose = read(join(w.dir, "compose.yaml"));
  expect(compose).toMatch(/image: nats:\d+\.\d+\.\d+-alpine/);
  // This machine's agents on localhost (the agents' network guard keeps them off the tailnet); other machines on the
  // Tailscale address, on its own port: Docker 29 refuses one host port on two addresses ("address already in use").
  for (const port of ["127.0.0.1:4222:4222", "100.64.0.7:4223:4222", "127.0.0.1:8222:8222", "100.64.0.7:7422:7422"]) {
    expect(compose).toContain(`"${port}"`);
  }
  expect(compose).not.toContain('"100.64.0.7:4222:4222"');
  expect(p.stdout).toContain("This machine's agents connect on nats://127.0.0.1:4222; other machines on nats://100.64.0.7:4223.");
  expect(compose).not.toContain("0.0.0.0"); // never every interface of the host
  expect(compose).toContain("data:/data");
  const conf = read(join(w.dir, "conf", "nats-server.conf"));
  expect(conf).toContain('jetstream { store_dir: "/data" }');
  expect(conf).toMatch(/leafnodes \{ listen: 0\.0\.0\.0:7422, authorization \{ user: leaf, password: "[A-Za-z0-9_-]{20,}" \} \}/);
  expect(conf).not.toContain("authorization {\n"); // no keys yet: clients connect without one
  expect(dockerLog(w)).toContain("info");
  expect(dockerLog(w)).toContain(`compose --file ${join(w.dir, "compose.yaml")} --project-name factory-nats up -d`);
  expect(p.stdout).toContain("nats://100.64.0.7:4223");
  expect(p.stdout).toContain("--allow-host 100.64.0.7:4223"); // the network guard's allow rule
  expect(p.stdout).toContain("factory nats user add");
});

test("the files get the modes their reader needs: the config and the leaf password are owner-only", () => {
  const w = world();
  expect(nats(w, ["up"]).code).toBe(0);
  expect(mode(w.dir)).toBe(0o700);
  expect(mode(join(w.dir, "conf"))).toBe(0o700);
  expect(mode(join(w.dir, "conf", "nats-server.conf"))).toBe(0o600);
  expect(mode(join(w.dir, "leaf.password"))).toBe(0o600);
  expect(mode(join(w.dir, "compose.yaml")) & 0o022).toBe(0); // not writable by others
});

test("without Tailscale it listens on localhost only and says so", () => {
  const w = world();
  const p = nats(w, ["up"], { FAKE_TS_IP: "" });
  expect(p.code, p.out).toBe(0);
  const compose = read(join(w.dir, "compose.yaml"));
  expect(compose).toContain('"127.0.0.1:4222:4222"');
  expect(compose).not.toMatch(/100\.64|7422/);
  expect(p.stdout).toMatch(/Tailscale isn't installed or isn't up here, so the server listens on localhost only/);
});

test("up twice changes nothing the second time and doesn't recreate the container", () => {
  const w = world();
  expect(nats(w, ["up"]).code).toBe(0);
  const before = readdirSync(w.dir).map((f) => f + (f === "conf" ? "" : read(join(w.dir, f)))).join("|");
  const conf = read(join(w.dir, "conf", "nats-server.conf"));
  const p = nats(w, ["up"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("up to date");
  expect(readdirSync(w.dir).map((f) => f + (f === "conf" ? "" : read(join(w.dir, f)))).join("|")).toBe(before);
  expect(read(join(w.dir, "conf", "nats-server.conf"))).toBe(conf); // the leaf password is made once
  const ups = dockerLog(w).split("\n").filter((l) => l.includes(" up "));
  expect(ups[0]).toContain("--force-recreate");
  expect(ups[1]).not.toContain("--force-recreate");
});

test("with Docker down it refuses with a fix and writes nothing", () => {
  const w = world();
  const p = nats(w, ["up"], { FAKE_DOCKER_DOWN: "1" });
  expect(p.code).toBe(1);
  const e = error(p);
  expect(e.code).toBe("docker-down");
  expect(e.fix).toContain("Start Docker");
  expect(existsSync(w.dir)).toBe(false);
});

test("when docker compose fails, a first up leaves nothing and a later one puts the old files back", () => {
  const w = world();
  let p = nats(w, ["up"], { FAKE_COMPOSE_FAIL: "1" });
  expect(p.code).toBe(1);
  expect(error(p).code).toBe("compose-failed");
  expect(error(p).message).toContain("port is already allocated");
  expect(existsSync(w.dir)).toBe(false);

  expect(nats(w, ["up"]).code).toBe(0);
  const compose = read(join(w.dir, "compose.yaml"));
  p = nats(w, ["up", "--port", "4333"], { FAKE_COMPOSE_FAIL: "1" });
  expect(p.code).toBe(1);
  expect(read(join(w.dir, "compose.yaml"))).toBe(compose);
});

test("--leaf makes a leaf server that connects to the hub with the hub's leaf password, without JetStream", () => {
  const w = world();
  let p = nats(w, ["up", "--leaf", "100.64.0.9"]);
  expect(p.code).toBe(1);
  expect(error(p).code).toBe("leaf-password-missing");
  expect(error(p).fix).toContain("leaf.password");
  expect(existsSync(w.dir)).toBe(false);

  write(join(w.dir, "leaf.password"), "s3cret-from-the-hub\n", 0o600);
  p = nats(w, ["up", "--leaf", "100.64.0.9"]);
  expect(p.code, p.out).toBe(0);
  const conf = read(join(w.dir, "conf", "nats-server.conf"));
  expect(conf).toContain('remotes: [ { url: "nats-leaf://leaf:s3cret-from-the-hub@100.64.0.9:7422" } ]');
  expect(conf).not.toContain("jetstream");
  const compose = read(join(w.dir, "compose.yaml"));
  expect(compose).not.toContain("7422");
  expect(compose).not.toContain("data:/data");
  expect(p.stdout).toContain("connects to the hub at nats-leaf://100.64.0.9:7422");
  expect(p.out).not.toContain("s3cret"); // the password is never printed

  // run again with no flag: it stays a leaf
  p = nats(w, ["up"]);
  expect(read(join(w.dir, "conf", "nats-server.conf"))).toContain("remotes:");
});

test("--leaf with the hub's client port is refused with the leaf port in the fix", () => {
  const w = world();
  const p = nats(w, ["up", "--leaf", "nats://100.64.0.9:4222"]);
  expect(p.code).toBe(1);
  expect(error(p).code).toBe("bad-hub");
  const q = nats(w, ["up", "--leaf", "nats-leaf://100.64.0.9:4222"]);
  expect(error(q).code).toBe("bad-hub");
  expect(error(q).fix).toContain("nats-leaf://100.64.0.9:7422");
});

// ---------- status ----------
test("status says when no server is set up here", () => {
  const w = world();
  const p = nats(w, ["status"]);
  expect(p.code).toBe(1);
  expect(p.stdout).toContain("No NATS server is set up on this machine");
  expect(p.stdout).toContain("factory nats up");
});

test("status asks the monitoring port and reports what the server says", () => {
  const w = world();
  const port = startScript(MONITOR);
  expect(nats(w, ["up", "--monitor-port", String(port)]).code).toBe(0);
  const p = nats(w, ["status"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toMatch(/^mode +hub/m);
  expect(p.stdout).toContain("answers: version 2.15.2, 3 connections, 1 leaf servers, JetStream on");
});

test("status says the server doesn't answer when nothing listens", () => {
  const w = world();
  const free = startScript("const s = Bun.serve({ port: 0, fetch: () => new Response('') }); console.log(s.port); s.stop(true);");
  expect(nats(w, ["up", "--monitor-port", String(free)]).code).toBe(0);
  const p = nats(w, ["status"]);
  expect(p.code).toBe(1);
  expect(p.stdout).toContain("doesn't answer on its monitoring port");
});

// ---------- down ----------
test("down stops it and keeps the data; --purge removes it; before any up there is nothing to stop", () => {
  const w = world();
  let p = nats(w, ["down"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("Nothing to stop");
  expect(nats(w, ["up"]).code).toBe(0);
  p = nats(w, ["down"]);
  expect(p.code, p.out).toBe(0);
  expect(dockerLog(w)).toContain("--project-name factory-nats down --remove-orphans\n");
  p = nats(w, ["down", "--purge"]);
  expect(dockerLog(w)).toContain("down --remove-orphans --volumes");
  expect(p.stdout).toContain("removed JetStream's data");
});

// ---------- user add ----------
test("user add makes a seed (mode 600 in a 700 folder) and puts the key and its permissions in the server's config", () => {
  const w = world();
  expect(nats(w, ["up"]).code).toBe(0);
  const p = nats(w, ["user", "add", "haile", "--role", "builder"]);
  expect(p.code, p.out).toBe(0);
  const creds = join(w.root, ".secrets", "nats", "widget");
  const seed = read(join(creds, "haile.nk")).trim();
  expect(seed).toMatch(/^SU[A-Z2-7]{56}$/);
  expect(mode(join(creds, "haile.nk"))).toBe(0o600);
  expect(mode(creds)).toBe(0o700);
  expect(p.out).not.toContain(seed); // the seed is never printed
  const users = JSON.parse(read(join(w.dir, "users.json"))) as { project: string; name: string; role: string; nkey: string }[];
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({ project: "widget", name: "haile", role: "builder" });
  expect(users[0]?.nkey).toMatch(/^U[A-Z2-7]{55}$/);
  const conf = read(join(w.dir, "conf", "nats-server.conf"));
  expect(conf).toContain(`nkey: "${users[0]?.nkey}"`);
  expect(conf).toContain('"factory.widget.wake.haile"');
  expect(conf).toContain('"factory.widget.pr.*.haile"');
  expect(conf).not.toContain("handoff"); // only a manager hands off
  expect(conf).toContain("$JS.API.STREAM.DELETE.>"); // denied to a builder
  expect(dockerLog(w)).toContain("--project-name factory-nats kill -s SIGHUP nats");
  expect(p.stdout).toContain("The server reloaded its config.");
});

test("user add twice keeps the key; a new role keeps the key and changes the permissions", () => {
  const w = world();
  expect(nats(w, ["up"]).code).toBe(0);
  expect(nats(w, ["user", "add", "taytu", "--role", "dev-manager"]).code).toBe(0); // decision 0004's name for manager
  const seedFile = join(w.root, ".secrets", "nats", "widget", "taytu.nk");
  const seed = read(seedFile);
  let p = nats(w, ["user", "add", "taytu", "--role", "manager"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("already has a key as manager; nothing changed");
  expect(read(join(w.dir, "conf", "nats-server.conf"))).toContain('"factory.widget.handoff.taytu"');
  p = nats(w, ["user", "add", "taytu", "--role", "po"]);
  expect(p.code, p.out).toBe(0);
  expect(read(seedFile)).toBe(seed);
  expect(read(join(w.dir, "conf", "nats-server.conf"))).not.toContain("handoff");
});

test("user add uses messaging.creds, and before any up says the key waits for the server", () => {
  const w = world({ messaging: { creds: "" } });
  const creds = join(w.root, "my-creds");
  write(join(w.d, ".claude", "factory.json"), JSON.stringify({ messaging: { creds } }));
  const p = nats(w, ["user", "add", "menelik", "--role", "owner"]);
  expect(p.code, p.out).toBe(0);
  expect(mode(join(creds, "menelik.nk"))).toBe(0o600);
  expect(p.stdout).toContain("`factory nats up` starts one with this key");
  expect(nats(w, ["up"]).code).toBe(0);
  expect(read(join(w.dir, "conf", "nats-server.conf"))).toContain("# widget/menelik (owner)");
});

test("user add refuses a bad role or name with a fix, and writes nothing", () => {
  const w = world();
  let p = nats(w, ["user", "add", "haile", "--role", "boss"]);
  expect(p.code).toBe(1);
  expect(error(p).code).toBe("bad-role");
  expect(error(p).fix).toContain("--role builder");
  p = nats(w, ["user", "add", "Haile.X", "--role", "builder"]);
  expect(error(p).code).toBe("bad-name");
  expect(existsSync(join(w.root, ".secrets"))).toBe(false);
  expect(existsSync(w.dir)).toBe(false);
});

// ---------- doctor ----------
function doctorWorld(url: string): [string, Record<string, string>, string] {
  const env = machine();
  const creds = join(env.HOME, "creds");
  const d = doctorProject({}, { agents: ["menelik", "taytu"], messaging: { transport: "nats", url, creds } });
  return [d, { ...env, FACTORY_CONFIG_DIR: join(env.HOME, "cfg") }, creds];
}

function addUser(d: string, env: Record<string, string>, name: string): void {
  const p = sh([process.execPath, "--no-env-file", join(SF, "hooks", "factory_nats.ts"), "user", "add", name, "--role", "builder"],
    { cwd: d, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
}

test("doctor: the NATS server answers, and each key publishes as itself and is refused as another agent", () => {
  const port = startScript(NATS, "strict");
  const [d, env] = doctorWorld(`nats://127.0.0.1:${port}`);
  addUser(d, env, "haile");
  const p = runDoctor(d, env);
  expect(p.stdout).toContain(`ok    NATS server answers at nats://127.0.0.1:${port}`);
  expect(p.stdout).toContain("ok    NATS key haile: publishes as itself, and a publish as another agent is refused");
});

test("doctor: a server that lets an agent publish as another fails", () => {
  const port = startScript(NATS, "open");
  const [d, env] = doctorWorld(`nats://127.0.0.1:${port}`);
  addUser(d, env, "haile");
  const p = runDoctor(d, env);
  expect(p.code).toBe(1);
  expect(p.stdout).toContain("fix   NATS key haile: the server let haile publish as another agent");
});

test("doctor: nothing answering at messaging.url is a fix that names factory nats up", () => {
  const free = startScript("const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true);");
  const [d, env] = doctorWorld(`nats://127.0.0.1:${free}`);
  const p = runDoctor(d, env);
  expect(p.code).toBe(1);
  expect(p.stdout).toMatch(/fix {3}NATS server answers: nothing answers at .*factory nats up/);
});

test("doctor: no NATS lines while messaging.transport is github", () => {
  const env = machine();
  const d = doctorProject({}, { agents: ["menelik", "taytu"] });
  expect(runDoctor(d, env).stdout).not.toContain("NATS");
});

// ---------- help and docs ----------
test("factory help lists nats, the script runs it, and the commands page has its rows", () => {
  const w = world();
  const help = sh(["bash", join(SF, "factory"), "help"], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
  expect(help.stdout).toMatch(/^ {2}nats up \[--leaf <hub>\]/m);
  expect(help.stdout).toMatch(/^ {2}nats user add <agent> --role builder\|manager\|po\|owner/m);
  const wiki = read(join(WIKI, "commands.md"));
  for (const row of ["| `factory nats up", "| `factory nats down", "| `factory nats status", "| `factory nats user add"]) {
    expect(wiki).toContain(row);
  }
});
