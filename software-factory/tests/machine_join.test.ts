// `factory machine add|join|ls|remove` (#445). Docker and Tailscale are fakes on PATH that log what they were given; the hub
// and the new machine are two worlds (own HOME and config folder). What is checked is what a person sees: output, exit codes,
// the files written with their modes, and the docker commands run.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { read, runHook, sh, type Proc, tmp, write, writeExe } from "./support.ts";

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.docker"
[ "$1" = info ] && { [ "\${FAKE_DOCKER_DOWN:-0}" = 1 ] && exit 1; exit 0; }
exit 0
`;
const FAKE_TAILSCALE = `#!/usr/bin/env bash
[ "$*" = "ip -4" ] || exit 2
[ -n "\${FAKE_TS_IP:-}" ] || { echo "Tailscale is stopped." >&2; exit 1; }
echo "$FAKE_TS_IP"
`;

type Env = Record<string, string | undefined>;
interface World { d: string; root: string; env: Env; cfg: string; creds: string }

function world(ip: string): World {
  const root = tmp("mjoin-");
  const d = join(root, "work");
  const bin = join(root, "bin");
  sh(["git", "init", "-q", "-b", "main", d]);
  sh(["git", "-C", d, "remote", "add", "origin", "git@github.com:acme/Widget.git"]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({}));
  writeExe(join(bin, "docker"), FAKE_DOCKER);
  writeExe(join(bin, "tailscale"), FAKE_TAILSCALE);
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("FACTORY_") && !k.startsWith("CLAUDE")) env[k] = v;
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, HOME: root, FAKE_LOG: join(root, "log"),
    FACTORY_CONFIG_DIR: join(root, "cfg"), FACTORY_NATS_WAIT: "0", FAKE_TS_IP: ip });
  return { d, root, env, cfg: join(root, "cfg"), creds: join(root, ".secrets", "nats", "widget") };
}

const run = (hook: string, w: World, args: string[], extra: Env = {}): Proc =>
  runHook(hook, args, { cwd: w.d, env: { ...w.env, ...extra }, timeoutMs: 60_000 });
const machine = (w: World, args: string[], extra: Env = {}): Proc => run("factory_machine_join", w, args, extra);
const mode = (p: string): number => statSync(p).mode & 0o777;
const dockerLog = (w: World): string => (existsSync(`${w.env.FAKE_LOG}.docker`) ? read(`${w.env.FAKE_LOG}.docker`) : "");
const error = (p: Proc): { code: string; message: string; fix: string } =>
  JSON.parse(p.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };

function hub(): World {
  const w = world("100.64.0.7");
  const up = run("factory_nats", w, ["up", "--hub"]);
  expect(up.code, up.stderr).toBe(0);
  return w;
}

function codeOf(p: Proc): string {
  const m = /FJ1-[A-Za-z0-9_-]+/.exec(p.stdout);
  expect(m, p.stdout).not.toBeNull();
  return (m as RegExpExecArray)[0];
}

test("add refuses when this machine is not a hub, and says how to start one", () => {
  const w = world("100.64.0.7");
  const p = machine(w, ["add", "office-pc"]);
  expect(p.code).toBe(1);
  expect(error(p).code).toBe("no-hub");
  expect(error(p).fix).toContain("factory nats up --hub");
  expect(existsSync(join(w.cfg, "machines.json"))).toBe(false);
});

test("add refuses a hub with no Tailscale address, and a bad name", () => {
  const w = world("");
  expect(run("factory_nats", w, ["up", "--hub"]).code).toBe(0);
  expect(error(machine(w, ["add", "office-pc"])).code).toBe("no-tailscale");
  const h = hub();
  expect(error(machine(h, ["add", "Office PC"])).code).toBe("bad-name");
  expect(error(machine(h, ["add", "x", "--minutes", "0"])).code).toBe("bad-minutes");
  expect(error(machine(h, ["add", "x", "--agents", "haile:wizard"])).code).toBe("bad-role");
});

test("add prints one code and makes the keys of the agents; machines.json holds no secret", () => {
  const w = hub();
  const p = machine(w, ["add", "office-pc", "--agents", "haile,tewodros:manager"]);
  expect(p.code, p.stderr).toBe(0);
  const code = codeOf(p);
  expect(p.stdout).toContain("expires in 15 minutes");
  expect(p.stdout).toContain("haile, tewodros");
  expect(mode(join(w.creds, "haile.nk"))).toBe(0o600);
  const users = JSON.parse(read(join(w.cfg, "nats", "users.json"))) as { name: string; role: string }[];
  expect(users.map((u) => `${u.name}:${u.role}`)).toEqual(["haile:builder", "tewodros:manager"]);
  expect(mode(join(w.cfg, "machines.json"))).toBe(0o600);
  const stored = read(join(w.cfg, "machines.json"));
  expect(stored).not.toContain(read(join(w.cfg, "nats", "leaf.password")).trim());
  expect(stored).not.toContain(read(join(w.creds, "haile.nk")).trim());
  expect(code.length).toBeGreaterThan(40);
});

test("add --json prints the code and the command to run, and a second code for a live name is refused", () => {
  const w = hub();
  const p = machine(w, ["add", "office-pc", "--json"]);
  const j = JSON.parse(p.stdout) as { code: string; command: string; minutes: number };
  expect(j.command).toBe(`factory machine join ${j.code}`);
  expect(j.minutes).toBe(15);
  const again = machine(w, ["add", "office-pc"]);
  expect(error(again).code).toBe("machine-exists");
  expect(error(again).fix).toContain("factory machine remove office-pc");
});

test("a code round-trips: join writes the seeds with their modes, the leaf password, and starts the leaf", () => {
  const h = hub();
  const code = codeOf(machine(h, ["add", "office-pc", "--agents", "haile"]));
  const n = world("100.64.0.9");
  const j = machine(n, ["join", code, "--no-doctor"]);
  expect(j.code, j.stderr).toBe(0);
  expect(read(join(n.creds, "haile.nk"))).toBe(read(join(h.creds, "haile.nk")));
  expect(mode(join(n.creds, "haile.nk"))).toBe(0o600);
  expect(mode(n.creds)).toBe(0o700);
  expect(read(join(n.cfg, "nats", "leaf.password"))).toBe(read(join(h.cfg, "nats", "leaf.password")));
  expect(mode(join(n.cfg, "nats", "leaf.password"))).toBe(0o600);
  expect(JSON.parse(read(join(n.cfg, "nats", "state.json")))).toMatchObject({ mode: "leaf", hub: "nats-leaf://100.64.0.7:7422" });
  expect(dockerLog(n)).toContain("up -d");
  expect(j.stdout).toContain("Started a leaf server");
  expect(j.stdout).toContain("nats://127.0.0.1:4222");
  expect(j.stdout).toContain("--no-doctor");
});

test("a code works once: the second join is refused and changes nothing", () => {
  const h = hub();
  const code = codeOf(machine(h, ["add", "office-pc", "--agents", "haile"]));
  const n = world("100.64.0.9");
  expect(machine(n, ["join", code, "--no-doctor"]).code).toBe(0);
  const log = dockerLog(n);
  const again = machine(n, ["join", code, "--no-doctor"]);
  expect(again.code).toBe(1);
  expect(error(again).code).toBe("code-used");
  expect(error(again).fix).toContain("factory machine add office-pc");
  expect(dockerLog(n)).toBe(log);
});

test("an expired code is refused, and nothing is written", async () => {
  const h = hub();
  const code = codeOf(machine(h, ["add", "office-pc", "--agents", "haile"]));
  const n = world("100.64.0.9");
  const later = Date.now() + 16 * 60_000;
  const decoded = JSON.parse(Buffer.from(code.slice(4), "base64url").toString()) as { expires: number };
  expect(decoded.expires).toBeLessThan(later);
  const old = { ...decoded, expires: Date.now() - 1000 };
  const stale = "FJ1-" + Buffer.from(JSON.stringify(old)).toString("base64url");
  const p = machine(n, ["join", stale, "--no-doctor"]);
  expect(error(p).code).toBe("code-expired");
  expect(existsSync(n.creds)).toBe(false);
  expect(existsSync(join(n.cfg, "nats"))).toBe(false);
});

test("a code that is cut short or not ours is refused with bad-code", () => {
  const n = world("100.64.0.9");
  expect(error(machine(n, ["join", "hello"])).code).toBe("bad-code");
  expect(error(machine(n, ["join", "FJ1-AAAA"])).code).toBe("bad-code");
  expect(error(machine(n, ["join"])).code).toBe("no-code");
});

test("without Docker it joins by a direct client connection and says so; keys are still written", () => {
  const h = hub();
  const code = codeOf(machine(h, ["add", "office-pc", "--agents", "haile"]));
  const n = world("100.64.0.9");
  const j = machine(n, ["join", code, "--no-doctor"], { FAKE_DOCKER_DOWN: "1" });
  expect(j.code, j.stderr).toBe(0);
  expect(j.stdout).toContain("Docker isn't available");
  expect(j.stdout).toContain("nats://100.64.0.7:4223");
  expect(existsSync(join(n.cfg, "nats"))).toBe(false);
  expect(mode(join(n.creds, "haile.nk"))).toBe(0o600);
});

test("without Tailscale it says the hub must be reachable another way, and still joins", () => {
  const h = hub();
  const code = codeOf(machine(h, ["add", "office-pc"]));
  const n = world("");
  const j = machine(n, ["join", code, "--no-doctor"]);
  expect(j.code, j.stderr).toBe(0);
  expect(j.stdout).toContain("Tailscale isn't up here");
});

test("a seed already there with a different key stops the join before anything is written", () => {
  const h = hub();
  const code = codeOf(machine(h, ["add", "office-pc", "--agents", "haile"]));
  const n = world("100.64.0.9");
  write(join(n.creds, "haile.nk"), "SUAOTHERKEY\n");
  const p = machine(n, ["join", code, "--no-doctor"]);
  expect(error(p).code).toBe("seed-differs");
  expect(existsSync(join(n.cfg, "nats"))).toBe(false);
  expect(existsSync(join(n.cfg, "used-codes.json"))).toBe(false);
});

test("a failed leaf start undoes the files and leaves the code usable", () => {
  const h = hub();
  const code = codeOf(machine(h, ["add", "office-pc", "--agents", "haile"]));
  const n = world("100.64.0.9");
  writeExe(join(n.root, "bin", "docker"), FAKE_DOCKER.replace('exit 0\n', '[ "$1" = compose ] && { echo boom >&2; exit 1; }\nexit 0\n'));
  const bad = machine(n, ["join", code, "--no-doctor"]);
  expect(bad.code).toBe(1);
  expect(existsSync(join(n.creds, "haile.nk"))).toBe(false);
  expect(existsSync(join(n.cfg, "nats"))).toBe(false);
  writeExe(join(n.root, "bin", "docker"), FAKE_DOCKER);
  expect(machine(n, ["join", code, "--no-doctor"]).code).toBe(0);
});

test("a hub cannot join another hub", () => {
  const h = hub();
  const code = codeOf(machine(h, ["add", "office-pc"]));
  expect(error(machine(h, ["join", code, "--no-doctor"])).code).toBe("is-hub");
});

test("ls shows the code waiting, or expired; remove forgets the machine", () => {
  const w = hub();
  expect(machine(w, ["ls"]).stdout).toContain("No join codes");
  machine(w, ["add", "office-pc", "--agents", "haile"]);
  const ls = machine(w, ["ls"]);
  expect(ls.stdout).toContain("office-pc");
  expect(ls.stdout).toContain("code waiting, 15 min left");
  const json = JSON.parse(machine(w, ["ls", "--json"]).stdout) as { name: string; state: string }[];
  expect(json).toMatchObject([{ name: "office-pc", state: "waiting" }]);
  const rm = machine(w, ["remove", "office-pc"]);
  expect(rm.code).toBe(0);
  expect(machine(w, ["ls"]).stdout).toContain("No join codes");
  expect(error(machine(w, ["remove", "office-pc"])).code).toBe("unknown-machine");
  expect(readdirSync(w.cfg)).toContain("machines.json");
});

test("factory machine add|join reach this command from the factory script, and show/setup still go to the old one", () => {
  const w = world("100.64.0.7");
  symlinkSync(join(import.meta.dir, "..", "hooks"), join(w.d, ".claude", "hooks"));
  const viaScript = (args: string[]): Proc => sh(["bash", join(import.meta.dir, "..", "factory"), ...args], { cwd: w.d, env: w.env as Record<string, string> });
  const add = viaScript(["machine", "add", "office-pc"]);
  expect(add.stderr).toContain("no-hub");
  expect(viaScript(["machine", "show"]).stdout).toContain("machine id:");
});
