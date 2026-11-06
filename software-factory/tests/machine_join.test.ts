// `factory machine add|join|ls|remove` (#445): a hub makes a join code for a new machine, the machine uses it.
//
// Two worlds: the hub (nats up done, fake tailscale 100.64.0.7) and a new machine (own HOME, config folder and git
// repo). `docker` and `tailscale` are fakes on PATH that log what they were given. What is checked is what a person
// sees: output, exit codes, files written with their modes, and the docker commands run. The code is opaque.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { read, runHook, SF, sh, type Proc, tmp, write, writeExe } from "./support.ts";

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.docker"
[ "$1" = info ] && { [ "\${FAKE_DOCKER_DOWN:-0}" = 1 ] && exit 1; exit 0; }
case " $* " in *" up "*) [ "\${FAKE_COMPOSE_FAIL:-0}" = 1 ] && { echo "Error: port is already allocated" >&2; exit 1; } ;; esac
exit 0
`;
const FAKE_TAILSCALE = `#!/usr/bin/env bash
[ "$*" = "ip -4" ] || exit 2
[ -n "\${FAKE_TS_IP:-}" ] || { echo "Tailscale is stopped." >&2; exit 1; }
echo "$FAKE_TS_IP"
`;

type Env = Record<string, string | undefined>;
interface World { d: string; root: string; env: Env; dir: string }
interface Opts { docker?: boolean; tailscale?: boolean; ip?: string | null }

const NOW = 1_800_000_000;

function world(o: Opts = {}): World {
  const root = tmp("mjoin-");
  const d = join(root, "work");
  const bin = join(root, "bin");
  sh(["git", "init", "-q", "-b", "main", d]);
  sh(["git", "-C", d, "remote", "add", "origin", "git@github.com:acme/Widget.git"]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({}));
  if (o.docker !== false) writeExe(join(bin, "docker"), FAKE_DOCKER);
  if (o.tailscale !== false) writeExe(join(bin, "tailscale"), FAKE_TAILSCALE);
  // With no docker the PATH is just the fakes and the basics, so a real docker on this machine can't leak in.
  let path = `${bin}:${process.env.PATH}`;
  if (o.docker === false || o.tailscale === false) { // a tailscale on this machine's PATH must not leak in either
    for (const t of ["git", "bash", "sh", "env", "uname", "dirname", "basename", "cat", "mkdir", "chmod", "rm", "mv", "cp", "ls", "sleep", "head", "tr", "date", "sed", "grep", "awk"]) {
      const found = Bun.which(t);
      if (found && !existsSync(join(bin, t))) symlinkSync(found, join(bin, t));
    }
    symlinkSync(process.execPath, join(bin, "bun"));
    path = bin;
  }
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("FACTORY_") && !k.startsWith("CLAUDE")) env[k] = v;
  Object.assign(env, { PATH: path, HOME: root, FAKE_LOG: join(root, "log"), FACTORY_CONFIG_DIR: join(root, "cfg"),
    FACTORY_NATS_WAIT: "0", FACTORY_NOW: String(NOW) });
  const ip = o.ip === undefined ? "100.64.0.7" : o.ip;
  if (ip) env.FAKE_TS_IP = ip;
  return { d, root, env, dir: join(root, "cfg", "nats") };
}

function hook(name: string, w: World, args: string[], extra: Env = {}): Proc {
  return runHook(name, args, { cwd: w.d, env: { ...w.env, ...extra }, timeoutMs: 60_000 });
}
const machine = (w: World, args: string[], extra: Env = {}): Proc => hook("factory_machine", w, args, extra);

// ---------- the hub's monitoring port: a fake in its own process (the hooks run with spawnSync) ----------
const procs: { kill(n?: number): void }[] = [];
afterAll(() => procs.forEach((p) => p.kill(9)));

function startScript(code: string, ...args: string[]): number {
  const d = tmp("mjoin-srv-");
  const script = write(join(d, "srv.ts"), code);
  const portFile = join(d, "port");
  const p = Bun.spawn(["sh", "-c", 'exec "$0" --no-env-file "$@" > "$PORT_FILE"', process.execPath, script, ...args],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, PORT_FILE: portFile } });
  procs.push(p);
  const deadline = Date.now() + 10_000;
  while (!(existsSync(portFile) && read(portFile).includes("\n")) && Date.now() < deadline) Bun.sleepSync(20);
  return Number(read(portFile).trim());
}

// Answers /healthz, and /leafz and /connz from a file the test rewrites: {"leafz": {...}, "connz": {...}}.
const MONITOR = String.raw`import { readFileSync } from "node:fs";
const seen = process.argv[2];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const u = new URL(req.url);
  let now = {};
  try { now = JSON.parse(readFileSync(seen, "utf8")); } catch {}
  if (u.pathname === "/healthz") return Response.json({ status: "ok" });
  if (u.pathname === "/leafz") return Response.json(now.leafz ?? { leafnodes: 0, leafs: [] });
  if (u.pathname === "/connz") return Response.json(now.connz ?? { num_connections: 0, connections: [] });
  return new Response("", { status: 404 });
} });
console.log(server.port);
`;

interface Monitor { port: number; see(what: { leafz?: unknown; connz?: unknown }): void }
function monitor(): Monitor {
  const file = join(tmp("mjoin-seen-"), "seen.json");
  write(file, "{}");
  return { port: startScript(MONITOR, file), see: (what) => write(file, JSON.stringify(what)) };
}

/** A port nothing listens on: a server is started there and stopped again. */
function deadPort(): number {
  return startScript("const s = Bun.serve({ hostname: \"127.0.0.1\", port: 0, fetch: () => new Response('') }); console.log(s.port); s.stop(true);");
}

/** A hub; its monitoring port is `monitorPort`, else one nothing answers on (so a NATS server on this machine can't leak in). */
function hub(o: Opts = {}, monitorPort = deadPort()): World {
  const w = world(o);
  expect(hook("factory_nats", w, ["up", "--monitor-port", String(monitorPort)]).code).toBe(0);
  return w;
}

interface Added { name: string; code: string; expiresAt: number; agents: { name: string; role: string }[]; command: string }
function add(w: World, name: string, agents = ["haile", "taytu:manager"], extra: string[] = [], env: Env = {}): Added {
  const p = machine(w, ["add", name, ...agents.flatMap((a) => ["--agent", a]), ...extra, "--json"], env);
  expect(p.code, p.out).toBe(0);
  return JSON.parse(p.stdout) as Added;
}

const dockerLog = (w: World): string => (existsSync(`${w.env.FAKE_LOG}.docker`) ? read(`${w.env.FAKE_LOG}.docker`) : "");
const mode = (path: string): number => statSync(path).mode & 0o777;
const seeds = (w: World): string => join(w.root, ".secrets", "nats", "widget");
function error(p: Proc): { code: string; message: string; fix: string } {
  return JSON.parse(p.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
}
function refused(p: Proc, code: string): { code: string; message: string; fix: string } {
  expect(p.code, p.out).toBe(1);
  expect(error(p).code).toBe(code);
  return error(p);
}
const users = (w: World): { name: string }[] => JSON.parse(read(join(w.dir, "users.json"))) as { name: string }[];

// ---------- add ----------
test("add without the hub set up is refused and says to run nats up", () => {
  const w = world();
  const p = machine(w, ["add", "laptop", "--agent", "haile"]);
  expect(refused(p, "hub-not-ready").fix).toContain("factory nats up");
});

test("add on a hub with no Tailscale address is refused", () => {
  const w = world({ ip: null });
  expect(hook("factory_nats", w, ["up"]).code).toBe(0);
  refused(machine(w, ["add", "laptop", "--agent", "haile"]), "hub-no-tailscale");
});

test("add refuses a bad name, no agents, a bad role and a name already in use", () => {
  const w = hub();
  refused(machine(w, ["add", "Bad_Name", "--agent", "haile"]), "bad-name");
  refused(machine(w, ["add", "-x", "--agent", "haile"]), "bad-name");
  refused(machine(w, ["add", "laptop"]), "no-agents");
  refused(machine(w, ["add", "laptop", "--agent", "haile:boss"]), "bad-role");
  expect(machine(w, ["add", "laptop", "--agent", "haile"]).code).toBe(0);
  const fix = refused(machine(w, ["add", "laptop", "--agent", "tewodros"]), "machine-exists").fix;
  expect(fix).toContain("factory machine remove");
});

test("add makes the keys on the hub, saves a record, and prints the join code and the command to run", () => {
  const w = hub();
  const p = machine(w, ["add", "laptop", "--agent", "haile", "--agent", "taytu:manager"]);
  expect(p.code, p.out).toBe(0);
  const codeLine = p.stdout.split("\n").find((l) => l.startsWith("FM1-"));
  expect(codeLine).toBeTruthy();
  expect(p.stdout).toContain(`factory machine join ${codeLine}`);
  expect(users(w).map((u) => u.name).sort()).toEqual(["haile", "taytu"]);
  const all = JSON.parse(read(join(w.dir, "users.json"))) as { name: string; role: string; nkey: string }[];
  const conf = read(join(w.dir, "conf", "nats-server.conf"));
  for (const u of all) expect(conf).toContain(`nkey: "${u.nkey}"`);
  expect(all.find((u) => u.name === "taytu")?.role).toBe("manager");
  expect(all.find((u) => u.name === "haile")?.role).toBe("builder");
  expect(existsSync(join(w.dir, "machines.json"))).toBe(true);
});

test("add --json prints name, code, expiry (default 15 minutes), agents and the command; --ttl and FACTORY_NOW move it", () => {
  const w = hub();
  const a = add(w, "laptop");
  expect(a.name).toBe("laptop");
  expect(a.code).toStartWith("FM1-");
  expect(a.expiresAt).toBe(NOW + 15 * 60);
  expect(a.agents).toEqual([{ name: "haile", role: "builder" }, { name: "taytu", role: "manager" }]);
  expect(a.command).toBe(`factory machine join ${a.code}`);
  const b = add(w, "desktop", ["tewodros"], ["--ttl", "60"], { FACTORY_NOW: String(NOW + 100) });
  expect(b.expiresAt).toBe(NOW + 100 + 3600);
});

// ---------- join ----------
test("join refuses text that is not a code", () => {
  const m = world();
  refused(machine(m, ["join", "garbage"]), "bad-code");
  refused(machine(m, ["join", "XX9-abcdef"]), "bad-code");
  expect(existsSync(m.dir)).toBe(false);
});

test("join with an expired code says to run add on the hub and writes nothing", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world();
  const p = machine(m, ["join", a.code], { FACTORY_NOW: String(NOW + 16 * 60) });
  expect(refused(p, "code-expired").fix).toContain("factory machine add");
  expect(existsSync(m.dir)).toBe(false);
  expect(existsSync(join(m.root, ".secrets"))).toBe(false);
  expect(dockerLog(m)).toBe("");
});

test("join with Docker starts a leaf, writes the seeds and the leaf password, and prints the messaging url", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world();
  const p = machine(m, ["join", a.code, "--no-doctor"]);
  expect(p.code, p.out).toBe(0);
  expect(mode(seeds(m))).toBe(0o700);
  for (const n of ["haile", "taytu"]) {
    expect(read(join(seeds(m), `${n}.nk`)).trim()).toStartWith("SU");
    expect(mode(join(seeds(m), `${n}.nk`))).toBe(0o600);
  }
  expect(mode(join(m.dir, "leaf.password"))).toBe(0o600);
  expect(dockerLog(m)).toMatch(/\bup\b/);
  const conf = join(m.dir, "conf", "nats-server.conf");
  expect(mode(conf)).toBe(0o600);
  expect(read(conf)).toContain("nats-leaf://");
  expect(read(conf)).toContain("100.64.0.7:7422");
  expect(p.stdout).toMatch(/Docker leaf/i);
  expect(p.stdout).toContain("nats://127.0.0.1:4222");
  const shown = machine(m, ["show"]);
  expect(shown.out).toContain("haile");
  expect(shown.out).toContain("taytu");
});

test("the same code used again is refused and changes nothing", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  const before = readdirSync(seeds(m)).sort();
  const log = dockerLog(m);
  refused(machine(m, ["join", a.code, "--no-doctor"]), "code-used");
  expect(readdirSync(seeds(m)).sort()).toEqual(before);
  expect(dockerLog(m)).toBe(log);
});

test("join without Docker connects the agents directly: seeds written, no docker call, no leaf files", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world({ docker: false });
  const p = machine(m, ["join", a.code, "--no-doctor"]);
  expect(p.code, p.out).toBe(0);
  expect(dockerLog(m)).toBe("");
  expect(p.stdout).toMatch(/Docker (is not|isn't) available/i);
  expect(p.stdout).toContain("nats://100.64.0.7:4223");
  expect(mode(seeds(m))).toBe(0o700);
  expect(mode(join(seeds(m), "haile.nk"))).toBe(0o600);
  expect(existsSync(join(m.dir, "leaf.password"))).toBe(false);
  expect(existsSync(join(m.dir, "compose.yaml"))).toBe(false);
});

test("join with Docker installed but not running is treated as no Docker", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world();
  const p = machine(m, ["join", a.code, "--no-doctor"], { FAKE_DOCKER_DOWN: "1" });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toMatch(/Docker (is not|isn't) (available|running)/i);
  expect(p.stdout).toContain("nats://100.64.0.7:4223");
  expect(existsSync(join(m.dir, "leaf.password"))).toBe(false);
  expect(existsSync(join(seeds(m), "haile.nk"))).toBe(true);
});

test("join without Tailscale is refused with nothing written; --no-tailscale skips the check", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world({ ip: null });
  refused(machine(m, ["join", a.code, "--no-doctor"]), "tailscale-missing");
  expect(existsSync(m.dir)).toBe(false);
  expect(existsSync(join(m.root, ".secrets"))).toBe(false);
  const n = world({ tailscale: false });
  refused(machine(n, ["join", a.code, "--no-doctor"]), "tailscale-missing");
  expect(existsSync(n.dir)).toBe(false);
  const p = machine(m, ["join", a.code, "--no-doctor", "--no-tailscale"]);
  expect(p.code, p.out).toBe(0);
  expect(existsSync(join(seeds(m), "haile.nk"))).toBe(true);
});

test("a leaf that fails to start leaves nothing behind and the code still works", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world();
  const p = machine(m, ["join", a.code, "--no-doctor"], { FAKE_COMPOSE_FAIL: "1" });
  expect(p.code, p.out).toBe(1);
  expect(existsSync(join(seeds(m), "haile.nk"))).toBe(false);
  expect(existsSync(join(seeds(m), "taytu.nk"))).toBe(false);
  expect(existsSync(join(m.dir, "leaf.password"))).toBe(false);
  const again = machine(m, ["join", a.code, "--no-doctor"]);
  expect(again.code, again.out).toBe(0);
  expect(existsSync(join(seeds(m), "haile.nk"))).toBe(true);
});

test("join runs the doctor and reports it unless --no-doctor", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world();
  const p = machine(m, ["join", a.code]);
  expect(p.stdout).toMatch(/^doctor:/m);
  const h2 = add(h, "desktop", ["tewodros"]);
  const n = world();
  const q = machine(n, ["join", h2.code, "--no-doctor"]);
  expect(q.code, q.out).toBe(0);
  expect(q.stdout).not.toMatch(/^doctor:/m);
});

// ---------- ls and remove ----------
test("ls says none when there are no machines", () => {
  const w = hub();
  const p = machine(w, ["ls"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toMatch(/no machines|none/i);
});

test("ls lists each machine with its agents and whether its code is live or expired", () => {
  const w = hub();
  add(w, "laptop");
  let p = machine(w, ["ls"]);
  expect(p.code, p.out).toBe(0);
  let line = p.stdout.split("\n").find((l) => l.includes("laptop")) as string;
  expect(line).toContain("haile");
  expect(line).toContain("taytu");
  expect(line).toContain("waiting for join (expires in 15 min)");
  const j = JSON.parse(machine(w, ["ls", "--json"]).stdout) as { name: string; agents: { name: string; role: string }[]; state: string; expiresAt: number }[];
  expect(j).toEqual([{ name: "laptop", agents: [{ name: "haile", role: "builder" }, { name: "taytu", role: "manager" }], state: "waiting",
    expiresAt: NOW + 900, joinedAt: null, revokedAt: null }]);
  p = machine(w, ["ls"], { FACTORY_NOW: String(NOW + 16 * 60) });
  line = p.stdout.split("\n").find((l) => l.includes("laptop")) as string;
  expect(line).toContain("code expired");
  const k = JSON.parse(machine(w, ["ls", "--json"], { FACTORY_NOW: String(NOW + 2000) }).stdout) as { state: string }[];
  expect(k[0]?.state).toBe("expired-unchecked"); // this hub's monitoring port doesn't answer
});

test("remove drops the record, revokes the keys, deletes the hub's seeds and reloads the server", () => {
  const w = hub();
  add(w, "laptop");
  add(w, "desktop", ["tewodros"]);
  expect(existsSync(join(seeds(w), "haile.nk"))).toBe(true);
  const p = machine(w, ["remove", "laptop"]);
  expect(p.code, p.out).toBe(0);
  expect(users(w).map((u) => u.name)).toEqual(["tewodros"]);
  const conf = read(join(w.dir, "conf", "nats-server.conf"));
  expect(conf).not.toContain("haile");
  expect(conf).not.toContain("taytu");
  expect(conf).toContain("tewodros");
  expect(existsSync(join(seeds(w), "haile.nk"))).toBe(false);
  expect(existsSync(join(seeds(w), "taytu.nk"))).toBe(false);
  expect(existsSync(join(seeds(w), "tewodros.nk"))).toBe(true);
  expect(dockerLog(w)).toContain("kill -s SIGHUP");
  expect(machine(w, ["ls"]).stdout).not.toContain("laptop");
});

test("remove of an unknown machine, or the same one twice, is refused and changes nothing", () => {
  const w = hub();
  add(w, "laptop");
  refused(machine(w, ["remove", "nope"]), "unknown-machine");
  expect(machine(w, ["remove", "laptop"]).code).toBe(0);
  const usersBefore = read(join(w.dir, "users.json"));
  const confBefore = read(join(w.dir, "conf", "nats-server.conf"));
  refused(machine(w, ["remove", "laptop"]), "unknown-machine");
  expect(read(join(w.dir, "users.json"))).toBe(usersBefore);
  expect(read(join(w.dir, "conf", "nats-server.conf"))).toBe(confBefore);
});

// ---------- a machine's own way in (security review) ----------
test("each machine has its own leaf user on the hub, and remove takes it away", () => {
  const w = hub();
  const a = add(w, "laptop");
  const b = add(w, "desktop", ["tewodros"]);
  const conf = (): string => read(join(w.dir, "conf", "nats-server.conf"));
  const lines = (): string[] => conf().split("\n").filter((l) => l.includes("leafnodes") && l.includes("listen"));
  expect(lines().length).toBe(1);
  const leafUsers = JSON.parse(read(join(w.dir, "leaf-users.json"))) as { user: string; password: string }[];
  expect(leafUsers.length).toBe(2);
  expect(mode(join(w.dir, "leaf-users.json"))).toBe(0o600);
  for (const l of leafUsers) expect(conf()).toContain(l.password);
  // the codes carry their own passwords, not the hub's
  const hubPw = read(join(w.dir, "leaf.password")).trim();
  expect(Buffer.from(a.code.slice(4), "base64url").toString()).not.toContain(hubPw);
  expect(a.code).not.toBe(b.code);
  expect(machine(w, ["remove", "laptop"]).code).toBe(0);
  const after = JSON.parse(read(join(w.dir, "leaf-users.json"))) as { user: string; password: string }[];
  expect(after.length).toBe(1);
  expect(conf()).not.toContain(leafUsers.find((l) => !after.some((x) => x.user === l.user))!.password);
  expect(conf()).toContain(after[0]!.password);
});

test("the joined leaf connects as the machine's own user, with the code's password", () => {
  const h = hub();
  const a = add(h, "laptop");
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  const user = (JSON.parse(read(join(h.dir, "leaf-users.json"))) as { user: string; password: string }[])[0]!;
  expect(read(join(m.dir, "conf", "nats-server.conf"))).toContain(`nats-leaf://${user.user}:${user.password}@100.64.0.7:7422`);
});

test("an agent that already has a key, here or on another machine, is refused and no key is touched", () => {
  const w = hub();
  add(w, "laptop");
  const before = read(join(w.dir, "users.json"));
  refused(machine(w, ["add", "desktop", "--agent", "haile"]), "agent-has-key");
  refused(machine(w, ["add", "desktop", "--agent", "tewodros", "--agent", "tewodros"]), "agent-has-key");
  expect(read(join(w.dir, "users.json"))).toBe(before);
  expect(machine(w, ["remove", "laptop"]).code).toBe(0);
  expect(machine(w, ["add", "desktop", "--agent", "haile"]).code).toBe(0); // free again after remove
});

// ---------- the hub enforces the code's expiry (review of #445) ----------
interface Row { name: string; state: string; joinedAt: number | null; revokedAt: number | null }
const lsJson = (w: World, at: number): Row[] => JSON.parse(machine(w, ["ls", "--json"], { FACTORY_NOW: String(at) }).stdout) as Row[];
const lsLine = (w: World, name: string, at: number): string =>
  machine(w, ["ls"], { FACTORY_NOW: String(at) }).stdout.split("\n").find((l) => l.startsWith(name)) ?? "";
const leafUsers = (w: World): { user: string }[] =>
  existsSync(join(w.dir, "leaf-users.json")) ? JSON.parse(read(join(w.dir, "leaf-users.json"))) as { user: string }[] : [];
const userNames = (w: World): string[] => (existsSync(join(w.dir, "users.json")) ? users(w).map((u) => u.name).sort() : []);
const LATER = NOW + 16 * 60;

test("add says the code's keys come off the hub if the machine hasn't joined by the time it expires", () => {
  const w = hub();
  const p = machine(w, ["add", "laptop", "--agent", "haile"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toMatch(/expires in 15 min/);
  expect(p.stdout).toMatch(/removed from the hub/);
});

test("a code that expires before its machine joins: its keys and leaf user come off the hub, and ls says so", () => {
  const mon = monitor();
  const w = hub({}, mon.port);
  add(w, "laptop");
  expect(lsLine(w, "laptop", NOW + 60)).toContain("waiting for join (expires in 14 min)");
  expect(userNames(w)).toEqual(["haile", "taytu"]); // before expiry nothing is touched
  expect(leafUsers(w).length).toBe(1);
  const line = lsLine(w, "laptop", LATER);
  expect(line).toContain("code expired; its keys were removed from the hub");
  expect(line).toContain("factory machine remove laptop");
  expect(userNames(w)).toEqual([]);
  expect(leafUsers(w)).toEqual([]);
  const conf = read(join(w.dir, "conf", "nats-server.conf"));
  expect(conf).not.toContain("haile");
  expect(conf).not.toMatch(/"m-[0-9a-f]+"/);
  expect(existsSync(join(seeds(w), "haile.nk"))).toBe(false);
  expect(dockerLog(w)).toContain("kill -s SIGHUP");
  const [row] = lsJson(w, LATER + 60);
  expect(row?.state).toBe("revoked");
  expect(row?.revokedAt).toBe(LATER);
  expect(row?.joinedAt).toBeNull();
  expect(machine(w, ["remove", "laptop"]).code).toBe(0); // the record is kept until remove
  expect(machine(w, ["ls"]).stdout).not.toContain("laptop");
});

test("add sweeps too: an expired code that never joined is revoked when the next machine is added", () => {
  const mon = monitor();
  const w = hub({}, mon.port);
  add(w, "laptop");
  add(w, "desktop", ["tewodros"], [], { FACTORY_NOW: String(LATER) });
  expect(userNames(w)).toEqual(["tewodros"]);
  expect(lsJson(w, LATER).map((r) => [r.name, r.state])).toEqual([["laptop", "revoked"], ["desktop", "waiting"]]);
});

test("a machine whose leaf the hub sees is joined, and stays joined (keys kept) after its code expires", () => {
  const mon = monitor();
  const h = hub({}, mon.port);
  const a = add(h, "laptop");
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  const user = leafUsers(h)[0]!.user;
  const name = /server_name: "([^"]+)"/.exec(read(join(m.dir, "conf", "nats-server.conf")))?.[1] ?? "";
  expect(name).toContain(user); // the leaf names itself after its leaf user, so the hub can tell it
  mon.see({ leafz: { leafnodes: 1, leafs: [{ name: "factory-leaf-other", account: "$G" }, { name, account: "$G", ip: "100.64.0.9" }] } });
  expect(lsLine(h, "laptop", NOW + 60)).toContain("joined");
  expect(lsJson(h, NOW + 60)[0]).toMatchObject({ state: "joined", joinedAt: NOW + 60, revokedAt: null });
  mon.see({}); // the leaf went away for a while
  expect(lsJson(h, LATER + 600)[0]?.state).toBe("joined");
  expect(lsLine(h, "laptop", LATER + 600)).not.toContain("expired");
  expect(userNames(h)).toEqual(["haile", "taytu"]);
  expect(leafUsers(h).map((l) => l.user)).toEqual([user]);
});

test("a machine without Docker is joined when one of its agents' keys connects to the hub", () => {
  const mon = monitor();
  const h = hub({}, mon.port);
  add(h, "laptop");
  const key = users(h).find((u) => u.name === "taytu") as unknown as { nkey: string };
  mon.see({ connz: { num_connections: 2, connections: [{ cid: 1, authorized_user: "someone-else" }, { cid: 2, authorized_user: key.nkey, account: "$G" }] } });
  expect(lsJson(h, LATER)[0]).toMatchObject({ state: "joined", joinedAt: LATER });
  expect(userNames(h)).toEqual(["haile", "taytu"]);
});

test("when the hub's monitoring port doesn't answer, nothing is revoked and ls says it couldn't check", () => {
  const w = hub(); // a monitoring port nothing listens on
  add(w, "laptop");
  const line = lsLine(w, "laptop", LATER);
  expect(line).toContain("code expired; not checked");
  expect(line).toContain("factory nats up");
  expect(lsJson(w, LATER)[0]).toMatchObject({ state: "expired-unchecked", joinedAt: null, revokedAt: null });
  expect(userNames(w)).toEqual(["haile", "taytu"]);
  expect(leafUsers(w).length).toBe(1);
});

test("add that can't write the machine's record undoes the keys and the leaf user it made", () => {
  const w = hub();
  mkdirSync(join(w.dir, "machines.json")); // a folder where the records go: the write fails
  const p = machine(w, ["add", "laptop", "--agent", "haile"]);
  expect(p.code, p.out).toBe(1);
  expect(error(p).code).toBe("record-failed");
  expect(userNames(w)).toEqual([]);
  expect(leafUsers(w)).toEqual([]);
  expect(existsSync(join(seeds(w), "haile.nk"))).toBe(false);
  expect(read(join(w.dir, "conf", "nats-server.conf"))).not.toContain("haile");
});

// ---------- help ----------
test("factory help lists machine add, join, ls and remove", () => {
  const w = world();
  const help = sh(["bash", join(SF, "factory"), "help"], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
  for (const c of ["machine add", "machine join", "machine ls", "machine remove"]) expect(help.stdout).toContain(c);
});
