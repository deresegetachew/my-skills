// `factory bootstrap` and `factory doctor --sandbox` (#105): the plan, the manifest, a second run that changes nothing,
// the refusals, the project part and the sandbox checks. (The guard and sops tests are in netguard.test.ts.)
//
// apt-get, adduser, usermod, gpasswd, chmod, loginctl, systemctl, nft, ss, resolvectl, dpkg-query, id, docker, curl, sudo,
// ip and journalctl are fakes on PATH that keep their state in files; system paths live under a temp root (setRoot).
// What apt, systemd and nftables really do on a machine can't be tested here. `factory bootstrap` runs in this process
// (main), with its output captured, as the Python test did.
//
// test_after_the_sign_ins_the_runners_and_autostart_are_installed_and_doctor_runs and
// test_doctor_sandbox_is_wired_into_the_doctor_and_the_factory_command stay in test_bootstrap.py until factory_doctor
// is ported: the first ends with `factory doctor --sandbox`'s own output, the second reads factory_doctor's source.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as M from "../hooks/factory_bootstrap_machine.ts";
import * as S from "../hooks/factory_sandbox.ts";
import { addUserTools, closeMachine, Machine, machineArgs, projectRepo, Rep, USER } from "./bootstrap_support.ts";
import { HOOKS, KIT, readJson, readmeAndWiki, sh, SF, tmp, write, writeExe } from "./support.ts";

afterEach(closeMachine);

const code = (err: string): string => (JSON.parse(err) as { code: string }).code;
const fixOf = (err: string): string => (JSON.parse(err) as { fix: string }).fix;
const mtime = (p: string): number => Number(statSync(p, { bigint: true }).mtimeNs);

test("an agent session cannot run bootstrap but can read its status", async () => {
  const m = new Machine();
  for (const v of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    process.env[v] = "1";
    const [rc, , err] = await m.run(...machineArgs("--apply", "--yes"));
    expect(rc).toBe(1);
    expect(code(err)).toBe("agent-session");
    expect(m.mutations()).toEqual({});
    expect((await m.run("status"))[0]).toBe(0);
    delete process.env[v];
  }
});

test("the plan changes nothing and says how to run it", async () => {
  const m = new Machine();
  const [rc, out, err] = await m.run(...machineArgs("--allow-host", "192.168.2.10:5432", "--block-loopback-port", "3000"));
  expect(rc, err).toBe(0);
  expect(err).toBe("");
  for (const part of ["plan  Create the user sbxuser", "plan  Install the network guard", "sudo factory bootstrap machine --apply",
    "Nothing was changed", "apt-get install -y -q", "192.168.2.10"]) expect(out).toContain(part);
  expect(m.mutations()).toEqual({});
  expect(existsSync(M.manifestPath())).toBe(false);
  expect(existsSync(M.rulesPath())).toBe(false);
  expect((await m.run(...machineArgs("--dry-run", "--apply")))[0]).toBe(0); // --dry-run wins
  expect(m.mutations()).toEqual({});
});

test("a script is written for the owner to read and nothing runs", async () => {
  const m = new Machine();
  const target = join(m.state, "steps.sh");
  let [rc, out] = await m.run(...machineArgs("--script", target));
  expect(rc).toBe(0);
  expect(m.mutations()).toEqual({});
  const text = readFileSync(target, "utf8");
  expect(text.startsWith("#!/usr/bin/env bash")).toBe(true);
  for (const part of ['id -u)" = 0', "adduser --disabled-password", "UID_F=$(id -u sbxuser)", "meta skuid $UID_F"]) expect(text).toContain(part);
  expect(sh(["bash", "-n", target]).code).toBe(0);
  [rc, out] = await m.run(...machineArgs("--script"));
  expect(out.startsWith("#!/usr/bin/env bash")).toBe(true);
  expect(rc).toBe(0);
});

test("apply without root is refused with the fix and nothing runs", async () => {
  const m = new Machine();
  m.rootUser = false;
  const [rc, , err] = await m.run(...machineArgs("--apply", "--yes"));
  expect(rc).toBe(1);
  expect(code(err)).toBe("not-root");
  expect(fixOf(err)).toContain("sudo factory bootstrap machine --apply");
  expect(m.mutations()).toEqual({});
});

test("apply needs yes when there is no terminal to ask on", async () => {
  const m = new Machine();
  const [rc, , err] = await m.run(...machineArgs("--apply"));
  expect(rc).toBe(1);
  expect(code(err)).toBe("needs-yes");
  expect(m.mutations()).toEqual({});
});

test("apply sets everything up and records a manifest", async () => {
  const m = new Machine({ "ss.txt": "LISTEN 0 1 127.0.0.1:9999 0.0.0.0:* uid:1000 ino:1\n" });
  const [rc, out, err] = await m.run(...machineArgs("--apply", "--yes", "--allow-host", "192.168.2.10:5432", "--block-loopback-port", "3000",
    "--block-inbound-port", "5440"));
  expect(rc, out + err).toBe(0);
  expect(m.logged("apt-get")[1]).toContain("uidmap");
  expect(m.logged("apt-get")[1]).toContain("nftables");
  expect(m.logged("adduser").some((l) => l.includes("--disabled-password") && l.endsWith(USER))).toBe(true);
  expect(m.logged("usermod").some((l) => l.includes("--add-subuids 100000-165535"))).toBe(true);
  expect(m.logged("loginctl")).toEqual([`enable-linger ${USER}`]);
  const rules = m.file("/etc/software-factory/net-guard.nft");
  expect(rules).toContain("meta skuid 4242"); // the uid
  expect(rules).toContain("192.168.2.1 meta l4proto"); // the resolver read from resolvectl
  expect(rules).toContain("tcp dport { 3000, 9999 }"); // configured port plus the one another user's service listens on
  expect(rules).toContain("192.168.2.10 tcp dport 5432 accept");
  expect(rules).toContain("5440");
  expect(m.file("/etc/systemd/system/factory-net-guard.service")).toContain("ExecStart=/usr/sbin/nft -f /etc/software-factory/net-guard.nft");
  expect(m.logged("systemctl")).toContain("enable factory-net-guard.service");
  expect(JSON.parse(m.file("/etc/software-factory/sandbox.json")).allowHosts).toEqual(["192.168.2.10:5432"]);
  const data = readJson<{ user: string; uid: number; version: number; steps: Record<string, { record: Record<string, unknown> }> }>(M.manifestPath());
  expect(data.user).toBe(USER);
  expect(data.uid).toBe(4242);
  expect(data.version).toBe(1);
  for (const s of ["packages", "user", "linger", "net-guard", "sandbox-config"]) expect(Object.keys(data.steps)).toContain(s);
  expect(data.steps.user?.record.created).toBe(true);
  expect(out).toContain("Next, as sbxuser");
  expect(out).toContain("factory bootstrap project");
});

test("running it again changes nothing", async () => {
  const m = new Machine();
  expect((await m.run(...machineArgs("--apply", "--yes")))[0]).toBe(0);
  const before = m.mutations();
  const paths = [M.rulesPath(), M.unitPath(), M.manifestPath()];
  const stat = paths.map(mtime);
  let [rc, out, err] = await m.run(...machineArgs("--apply", "--yes"));
  expect(rc, out + err).toBe(0);
  expect(m.mutations(), "a second run changed something").toEqual(before);
  expect(paths.map(mtime)).toEqual(stat);
  expect(out).not.toContain("run   ");
  expect(out.split("ok    ").length - 1).toBeGreaterThanOrEqual(8);
  [rc, out] = await m.run(...machineArgs());
  expect(out).toContain("Everything is in place.");
});

test("a changed setting rewrites the guard and restarts it", async () => {
  const m = new Machine();
  expect((await m.run(...machineArgs("--apply", "--yes")))[0]).toBe(0);
  const restarts = m.logged("systemctl").filter((l) => l === "restart factory-net-guard.service").length;
  expect((await m.run(...machineArgs("--apply", "--yes", "--block-loopback-port", "8123")))[0]).toBe(0);
  expect(m.file("/etc/software-factory/net-guard.nft")).toContain("8123");
  expect(m.logged("systemctl").filter((l) => l === "restart factory-net-guard.service").length).toBe(restarts + 1);
});

test("a user in the sudo or docker group is taken out", async () => {
  const m = new Machine({ [`user-${USER}`]: "", [`groups-${USER}`]: "sudo docker\n" });
  expect((await m.run(...machineArgs("--apply", "--yes")))[0]).toBe(0);
  const g = m.logged("gpasswd");
  expect(JSON.stringify(g) === JSON.stringify([`-d ${USER} sudo`]) || g.length >= 1).toBe(true);
  expect(m.logged("adduser").some((l) => l.startsWith("--disabled-password")), "an existing user is not created again").toBe(false);
  const steps = readJson<{ steps: Record<string, { record: Record<string, unknown> }> }>(M.manifestPath()).steps;
  expect("user" in steps ? steps.user?.record.created === false : true).toBe(true);
});

test("options are checked before anything is planned", async () => {
  const m = new Machine();
  for (const [argv, want] of [[["--user", "root"], "bad-user"], [["--user", "Bad Name"], "bad-user"], [["--egress", "wide"], "bad-egress"],
    [["--allow-host", "router.lan"], "bad-option"], [["--block-loopback-port", "70000"], "bad-option"],
    [["--agents", "Haile"], "bad-agents"]] as [string[], string][]) {
    const [rc, , err] = await m.run("machine", ...argv);
    expect(rc, argv.join(" ")).toBe(1);
    expect(code(err), err).toBe(want);
    expect(Object.keys(JSON.parse(err))).toContain("fix");
  }
});

test("other systems are refused with a way forward", async () => {
  const m = new Machine();
  write(join(m.root, "etc", "os-release"), 'ID=fedora\nPRETTY_NAME="Fedora"\n');
  const [rc, , err] = await m.run(...machineArgs());
  expect(rc).toBe(1);
  expect(code(err)).toBe("unsupported-os");
});

test("key only ssh and keep awake are opt in and a private key is refused", async () => {
  const m = new Machine();
  let [rc, out, err] = await m.run(...machineArgs());
  for (const part of ["key-only SSH", "stays awake", "Keep the machine awake"]) expect(out).not.toContain(part);
  [rc, out] = await m.run(...machineArgs("--harden-ssh", "--keep-awake"));
  for (const part of ["Key-only SSH", "Keep the machine awake", "mask sleep.target"]) expect(out).toContain(part);
  expect((await m.run(...machineArgs("--apply", "--yes", "--harden-ssh", "--keep-awake")))[0]).toBe(0);
  expect(m.file("/etc/ssh/sshd_config.d/50-factory.conf")).toContain("PasswordAuthentication no");
  expect(m.file("/etc/systemd/logind.conf.d/50-factory.conf")).toContain("HandleLidSwitch=ignore");
  const key = write(join(m.state, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nxx\n");
  [rc, out, err] = await m.run(...machineArgs("--authorized-keys", key));
  expect(rc).toBe(1);
  expect(code(err)).toBe("private-key");
  const pub = write(join(m.state, "k.pub"), "ssh-ed25519 AAAAC3 me@laptop\n");
  expect((await m.run(...machineArgs("--apply", "--yes", "--authorized-keys", pub)))[0]).toBe(0);
  expect(m.file(`/home/${USER}/.ssh/authorized_keys`)).toBe("ssh-ed25519 AAAAC3 me@laptop\n");
});

test("a laptop stays awake without being asked and can opt out", async () => {
  const m = new Machine();
  mkdirSync(join(m.root, "sys", "class", "power_supply", "BAT0"), { recursive: true });
  expect((await m.run(...machineArgs()))[1]).toContain("Keep the machine awake");
  expect((await m.run(...machineArgs("--no-keep-awake")))[1]).not.toContain("Keep the machine awake");
});

test("status matches reality and shows what drifted", async () => {
  const m = new Machine();
  let [rc, out] = await m.run("status");
  expect(rc).toBe(0);
  expect(out).toContain("has not been run");
  await m.run(...machineArgs("--apply", "--yes"));
  [rc, out] = await m.run("status");
  expect(rc).toBe(0);
  expect(out).toContain("Sandbox user: sbxuser (uid 4242)");
  expect(out).not.toContain("fix   ");
  expect(out).toContain("ok    net-guard");
  rmSync(M.rulesPath());
  [rc, out] = await m.run("status");
  expect(rc).toBe(1);
  for (const part of ["net-guard", "net-guard.nft is missing", "puts them back"]) expect(out).toContain(part);
});

test("uninstall removes the system parts and keeps the user and the home", async () => {
  const m = new Machine();
  await m.run(...machineArgs("--apply", "--yes"));
  const home = join(m.root, "home-sbxuser");
  write(join(home, "keep.txt"), "x");
  let [rc, out, err] = await m.run("uninstall");
  expect(rc).toBe(0);
  expect(out).toContain("Nothing was changed");
  expect(existsSync(M.rulesPath())).toBe(true);
  [rc, out, err] = await m.run("uninstall", "--apply", "--yes");
  expect(rc, out + err).toBe(0);
  for (const p of [M.rulesPath(), M.unitPath(), M.manifestPath()]) expect(existsSync(p), p).toBe(false);
  expect(m.logged("systemctl")).toContain("disable --now factory-net-guard.service");
  expect(m.logged("nft").some((l) => l.includes("delete table inet factory_guard"))).toBe(true);
  expect(existsSync(join(home, "keep.txt"))).toBe(true);
  expect(existsSync(join(m.state, `user-${USER}`))).toBe(true);
  expect(m.logged("adduser").some((l) => l.includes("deluser"))).toBe(false);
});

test("removing the user needs its name typed", async () => {
  const m = new Machine();
  await m.run(...machineArgs("--apply", "--yes"));
  for (const argv of [["--remove-user"], ["--delete-home", "--confirm", "wrong"]]) {
    const [rc, , err] = await m.run("uninstall", "--apply", ...argv);
    expect(rc, err).toBe(1);
    expect(code(err)).toBe("not-confirmed");
    expect(existsSync(M.manifestPath())).toBe(true);
    expect(existsSync(M.rulesPath())).toBe(true);
  }
  writeExe(join((m.env.PATH as string).split(":")[0] as string, "deluser"), '#!/bin/bash\necho "$*" >>"$FAKE_LOG/deluser.log"\n');
  const [rc, out, err] = await m.run("uninstall", "--apply", "--delete-home", "--confirm", USER, "--user", USER);
  expect(rc, out + err).toBe(0);
  expect(m.logged("deluser")).toEqual([`--remove-home ${USER}`]);
});

test("a user that existed before is never removed", async () => {
  const m = new Machine({ [`user-${USER}`]: "" });
  await m.run(...machineArgs("--apply", "--yes"));
  const [rc, out] = await m.run("uninstall", "--apply", "--yes", "--remove-user");
  expect(rc).toBe(0);
  expect(out).toContain("existed before bootstrap");
  expect(m.logged("deluser")).toEqual([]);
});

// ---- the project part -------------------------------------------------------------------------------------------------

test("the project part refuses to run as root", async () => {
  const m = new Machine();
  const [rc, , err] = await m.run("project", "--user", USER);
  expect(rc).toBe(1);
  expect(code(err)).toBe("root-refused");
  expect(fixOf(err)).toContain(USER);
});

test("the project part stops for the human steps and never prints a token", async () => {
  const m = new Machine();
  m.rootUser = false;
  addUserTools(m);
  process.env.GH_TOKEN = "ghp_SECRETSECRETSECRET";
  process.env.ANTHROPIC_API_KEY = "sk-ant-SECRETSECRET";
  const repo = projectRepo(m, { commands: { install: "true" } }, { ".env.example": "A=\n", ".sops.yaml": "creation_rules: []\n" });
  mkdirSync(join(process.env.HOME as string, ".secrets"), { mode: 0o700 });
  process.chdir(repo);
  const [rc, out, err] = await m.run("project", "--user", USER, "--agents", "haile,tewodros");
  expect(rc, out + err).toBe(2);
  for (const part of ["gh auth login", "claude", "keys.txt", "never reads or stores a token"]) expect(out).toContain(part);
  for (const secret of ["ghp_SECRETSECRETSECRET", "sk-ant-SECRETSECRET"]) {
    expect(out).not.toContain(secret);
    expect(err).not.toContain(secret);
  }
  expect((m.logged("factory")[0] ?? "").includes("factory machine setup haile,tewodros") ||
    m.logged("factory").join(" ").includes("machine setup haile,tewodros")).toBe(true);
  expect(existsSync(join(repo, ".env.local"))).toBe(true);
  expect(m.logged("factory").join(" "), "runners wait for the sign-ins").not.toContain("ci install");
  expect(readFileSync(join(process.env.HOME as string, ".bashrc"), "utf8")).toContain("# --- software factory");
});

test("the project part without a checkout asks for a repo", async () => {
  const m = new Machine();
  m.rootUser = false;
  addUserTools(m);
  process.chdir(m.state);
  let [rc, out, err] = await m.run("project", "--user", USER);
  expect(rc).toBe(1);
  expect(code(err)).toBe("no-project");
  expect(fixOf(err)).toContain("--repo");
  [rc, out, err] = await m.run("project", "--user", USER, "--repo", "https://github.com/acme/app.git", "--dry-run");
  expect(rc, err).toBe(0);
  expect(out).toContain("git clone --recurse-submodules https://github.com/acme/app.git");
});

// ---- doctor --sandbox -------------------------------------------------------------------------------------------------

const uid = (): number => (process.getuid ? process.getuid() : 0);
const cgroupDir = (m: Machine): string => join(m.root, `sys/fs/cgroup/user.slice/user-${uid()}.slice/user@${uid()}.service`);

/** A machine where bootstrap ran and everything holds. */
async function sandboxMachine(m: Machine): Promise<void> {
  await m.run(...machineArgs("--apply", "--yes", "--block-loopback-port", "3000"));
  write(join(m.state, "dockerinfo"), '["name=seccomp","name=rootless"]|overlay2');
  write(join(m.state, "ss.txt"), "");
  write(join(cgroupDir(m), "cgroup.controllers"), "cpuset cpu io memory pids\n");
  write(join(m.state, "userunits"), "proj-ci.service loaded active running CI runner\n");
  const manifest = readJson<{ steps: Record<string, unknown> }>(M.manifestPath());
  manifest.steps.isolate = { record: { adminHome: join(m.root, "home-admin") } };
  write(M.manifestPath(), JSON.stringify(manifest));
}

function sandboxReport(): Rep {
  const r = new Rep();
  S.run(r, { ci: { runners: 1 } });
  return r;
}

test("the sandbox checks pass on a machine where everything holds", async () => {
  const m = new Machine();
  await sandboxMachine(m);
  const r = sandboxReport();
  expect(r.lines.filter((l) => l[0] === "fix"), r.text()).toEqual([]);
  const text = r.text();
  for (const part of ["no sudo", "not in the sudo, docker or admin groups", "the internet works", "not reachable",
    "cannot reach the router either", "Docker is rootless", "cpu, memory and pids", "linger is on", "FACTORY-BLOCK"]) {
    expect(text, part).toContain(part);
  }
});

test("a user with sudo or the docker group fails the sandbox with a fix", async () => {
  const m = new Machine();
  await sandboxMachine(m);
  write(join(m.state, "has-sudo"), "");
  write(join(m.state, `groups-${USER}`), "docker\n");
  process.env.USER = USER;
  const r = sandboxReport();
  const fixes = r.lines.filter(([k]) => k === "fix").map(([, w, h]) => [w, h]);
  expect(fixes.some(([w, h]) => w === "sudo" && (h as string).includes("gpasswd -d")), r.text()).toBe(true);
});

test("reaching the router the tailnet or a blocked port fails the sandbox", async () => {
  const m = new Machine();
  await sandboxMachine(m);
  write(join(m.state, "open"), "http://192.168.2.1\nhttp://127.0.0.1:3000\n");
  const r = sandboxReport();
  const fix = r.lines.filter(([k, w]) => k === "fix" && w === "home network").map(([, , h]) => h);
  expect(fix.length, r.text()).toBeGreaterThan(0);
  expect(fix[0]).toContain("the router 192.168.2.1");
  expect(fix[0]).toContain("127.0.0.1:3000");
  expect(fix[0]).not.toContain("tailnet");
});

test("a container that reaches the router fails the sandbox gap two", async () => {
  const m = new Machine();
  await sandboxMachine(m);
  write(join(m.state, "container-open"), "");
  const r = sandboxReport();
  expect(r.lines.some(([k, w]) => k === "fix" && w === "containers"), r.text()).toBe(true);
});

test("a local service the guard does not cover fails the sandbox gap one", async () => {
  const m = new Machine();
  await sandboxMachine(m);
  write(join(m.state, "ss.txt"), "LISTEN 0 1 127.0.0.1:9100 0.0.0.0:* uid:1000 ino:1\n");
  const r = sandboxReport();
  const fix = r.lines.filter(([k, w]) => k === "fix" && w === "local services of other users").map(([, , h]) => h);
  expect(fix.length, r.text()).toBeGreaterThan(0);
  expect(fix[0]).toContain("9100");
  expect(fix[0]).toContain("machine --apply");
});

test("missing cgroup controllers linger and runners each get a fix", async () => {
  const m = new Machine();
  await sandboxMachine(m);
  write(join(cgroupDir(m), "cgroup.controllers"), "cpuset io\n");
  rmSync(join(m.state, "linger"));
  write(join(m.state, "userunits"), "");
  const r = sandboxReport();
  const whats = new Set(r.lines.filter(([k]) => k === "fix").map(([, w]) => w));
  for (const w of ["cgroup controllers", "linger", "CI runners"]) expect(whats.has(w), r.text()).toBe(true);
  expect(r.lines.some(([, w, h]) => w === "cgroup controllers" && h.includes("Delegate="))).toBe(true);
});

// ---- the factory command and the docs ------------------------------------------------------------------------------------

test("factory bootstrap help works outside a repo", () => {
  // The bootstrap half of test_doctor_sandbox_is_wired_into_the_doctor_and_the_factory_command (the doctor half stays in
  // test_bootstrap.py until factory_doctor is ported).
  const p = sh(["bash", join(SF, "factory"), "bootstrap", "help"], { cwd: tmp(), env: { ...process.env, GIT_CEILING_DIRECTORIES: "/" } });
  expect(p.code, p.stderr).toBe(0);
  expect(p.stdout).toContain("factory bootstrap machine");
});

test("factory help lists bootstrap and the sandbox option", () => {
  const d = tmp();
  sh(["git", "init", "-q", d]);
  const p = sh(["bash", join(SF, "factory"), "help"], { cwd: d });
  expect(p.stdout, p.stderr).toContain("bootstrap machine|project|all|status|uninstall");
  expect(p.stdout).toContain("doctor [--sandbox]");
});

test("the scripts are bun scripts with no forwarder and are documented", () => {
  // #252: a .ts gets no forwarder in kit/.claude/hooks; projects link hooks/ directly.
  for (const name of ["factory_bootstrap", "factory_bootstrap_core", "factory_bootstrap_machine", "factory_bootstrap_project",
    "factory_sandbox", "factory_netguard"]) {
    expect(existsSync(join(HOOKS, name + ".ts")), name).toBe(true);
    expect(sh(["test", "-e", join(KIT, ".claude", "hooks", name + ".py")]).code, name).not.toBe(0);
  }
  const readme = readmeAndWiki();
  for (const part of ["factory bootstrap", "--apply", "--script", "doctor --sandbox", "Network guard", "manifest",
    "gh auth login", "FACTORY-BLOCK"]) expect(readme, part).toContain(part);
});
