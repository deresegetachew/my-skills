// The network guard (factory_netguard.ts) and the sops download of the machine part (factory_bootstrap_machine.ts), #105.
// These are the Bun twins of the guard and sops tests in test_bootstrap.py, which stays in Python until
// factory_bootstrap and factory_sandbox are ported (it also drives `factory bootstrap` itself).
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as M from "../hooks/factory_bootstrap_machine.ts";
import { BootstrapError, Context, shellOf } from "../hooks/factory_bootstrap_core.ts";
import * as G from "../hooks/factory_netguard.ts";
import { runHook, tmp, write, writeExe } from "./support.ts";

test("the guard rules have the uid the resolver the allow list and the blocked ports", () => {
  const text = G.renderRules(1001, ["192.168.2.1"], ["192.168.2.10:5432"], ["3000", "45876"], ["4100-4199", "5440"]);
  expect(text).toContain("meta skuid 1001 ip daddr 192.168.2.1 meta l4proto { tcp, udp } th dport 53 accept");
  expect(text).toContain("meta skuid 1001 ip daddr 192.168.2.10 tcp dport 5432 accept");
  for (const part of ["100.64.0.0/10", "169.254.0.0/16", "fd7a:115c:a1e0::/48"]) expect(text).toContain(part);
  expect(text).toContain("tcp dport { 3000, 45876 }");
  expect(text).toContain("tcp dport { 4100-4199, 5440 }");
  expect(text.indexOf("192.168.2.10 tcp dport 5432 accept")).toBeLessThan(text.indexOf('log prefix "FACTORY-BLOCK " drop')); // allowed first
  expect(G.renderRules(1001, ["192.168.2.1"], [], [], [])).toBe(G.renderRules(1001, ["192.168.2.1"], [], [], []));
  const none = G.renderRules(1001, [], [], [], [], "none");
  expect(none).toContain('oifname != "lo"');
  expect(none).not.toContain("192.168.0.0/16");
});

test("bad guard inputs are refused", () => {
  const bad = [() => G.renderRules(0), () => G.renderRules("x"), () => G.renderRules(1001, [], [], [], [], "open"),
    () => G.renderRules(1001, [], ["router.local"]), () => G.renderRules(1001, [], [], ["99999"]),
    () => G.renderRules(1001, [], ["2001:db8::1"])];
  for (const f of bad) expect(f).toThrow(G.GuardError);
});

test("the resolver is read not hardcoded and the local stub is skipped", () => {
  expect(G.resolversFrom("nameserver 127.0.0.53\nsearch lan\n", "Link 2 (eth0): 10.1.1.1 10.1.1.1")).toEqual(["10.1.1.1"]);
  expect(G.resolversFrom("nameserver 192.168.0.1\nnameserver 8.8.8.8\n")).toEqual(["192.168.0.1", "8.8.8.8"]);
});

test("ports other users listen on are found and the sandbox user's own are not", () => {
  const ss = 'LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("web",pid=5,fd=3)) uid:1000 ino:1\n' +
    "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* uid:0 ino:2\n" +
    "LISTEN 0 4096 127.0.0.1:2375 0.0.0.0:* uid:4242 ino:3\n" +
    "LISTEN 0 4096 127.0.0.53:53 0.0.0.0:* uid:101 ino:4\n" +
    "LISTEN 0 4096 192.168.2.9:8080 0.0.0.0:* uid:1000 ino:5\n" +
    "LISTEN 0 4096 [::1]:631 [::]:* uid:0 ino:6\n";
  expect(G.listeningPortsNotOwned(ss, 4242)).toEqual([22, 631, 3000]);
});

test("the render command prints the rules and refuses a bad value with exit 1", () => {
  let p = runHook("factory_netguard", ["render", "--uid", "1001", "--resolver", "192.168.2.1", "--block-loopback-port", "3000"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toBe(G.renderRules(1001, ["192.168.2.1"], [], ["3000"], []));
  p = runHook("factory_netguard", ["render", "--uid", "5", "--egress", "x"]);
  expect(p.code).toBe(1);
  expect(p.stderr).toBe("factory: egress must be 'internet' or 'none', got 'x'\n");
  p = runHook("factory_netguard", ["render"]);
  expect(p.code).toBe(2);
  expect(p.stderr).toContain("error: the following arguments are required: --uid");
});

test("sops is installed only when its checksum matches", async () => {
  const blob = new TextEncoder().encode("#!/bin/sh\necho sops\n");
  const sums = createHash("sha256").update(blob).digest("hex");
  const fake = (good: boolean): M.Fetcher => async (url: string) => {
    if (url.endsWith("/releases/latest")) return new TextEncoder().encode(JSON.stringify({ tag_name: "v3.9.0" }));
    if (url.endsWith("checksums.txt")) return new TextEncoder().encode(`${good ? sums : "0".repeat(64)}  sops-v3.9.0.linux.amd64\n`);
    return blob;
  };
  const savedRoot = M.ROOT;
  M.setRoot(tmp());
  M.setMachine(() => "x86_64");
  try {
    M.setFetcher(fake(false));
    let err: unknown = null;
    try {
      await M.installSops();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BootstrapError); // installed a download with the wrong checksum otherwise
    expect((err as BootstrapError).code).toBe("checksum");
    expect(existsSync(M.P("/usr/local/bin/sops"))).toBe(false);
    M.setFetcher(fake(true));
    await M.installSops();
    expect(new Uint8Array(readFileSync(M.P("/usr/local/bin/sops")))).toEqual(blob);
    expect(statSync(M.P("/usr/local/bin/sops")).mode & 0o777).toBe(0o755);
  } finally {
    M.setFetcher();
    M.setMachine();
    M.setRoot(savedRoot);
  }
});

test("the machine steps plan as shell text with the uid variable, the user and the guard", () => {
  const base = tmp();
  const bin = `${base}/bin`;
  const state = `${base}/state`;
  const root = `${base}/root`;
  write(`${root}/etc/os-release`, 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04"\n');
  write(`${root}/etc/resolv.conf`, "nameserver 127.0.0.53\n");
  write(`${state}/.keep`, "");
  writeExe(`${bin}/id`, '#!/bin/bash\ncase "$1" in -u) [ -f "$FAKE_STATE/user-$2" ] && echo 4242 || exit 1 ;; -nG) echo "$2 sudo" ;; esac\n');
  writeExe(`${bin}/dpkg-query`, '#!/bin/bash\n[ "${!#}" = git ] && printf "install ok installed" || exit 1\n');
  writeExe(`${bin}/ss`, '#!/bin/bash\necho "LISTEN 0 1 127.0.0.1:9999 0.0.0.0:* uid:1000 ino:1"\n');
  writeExe(`${bin}/resolvectl`, '#!/bin/bash\necho "Link 2 (eth0): 192.168.2.1"\n');
  const saved = { ...process.env };
  const savedRoot = M.ROOT;
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.FAKE_STATE = state;
  delete process.env.SUDO_USER;
  M.setRoot(root);
  try {
    const steps = M.steps({ user: "sbxuser", egress: "internet", allow_hosts: ["192.168.2.10:5432"], block_loopback_ports: ["3000"],
      block_inbound_ports: [], harden_ssh: true, keep_awake: false });
    expect(steps.map((s) => s.id)).toEqual(["packages", "sops", "user", "isolate", "subids", "linger", "sandbox-config", "net-guard", "ssh-hardening"]);
    expect(steps.every((s) => s.privileged)).toBe(true);
    const ctx = new Context("sbxuser", false);
    const text = steps.flatMap((s) => s.actions.map((a) => shellOf(a, ctx))).join("\n");
    expect(text).toContain("DEBIAN_FRONTEND=noninteractive apt-get install -y -q uidmap slirp4netns");
    expect(text).not.toContain(" git gh ");
    expect(text).toContain("adduser --disabled-password --gecos 'Software factory' sbxuser");
    expect(text).toContain("gpasswd -d sbxuser sudo");
    expect(text).toContain("usermod --add-subuids 100000-165535 --add-subgids 100000-165535 sbxuser");
    expect(text).toContain(`install -m 644 /dev/stdin ${root}/etc/software-factory/net-guard.nft <<FACTORY_EOF`);
    expect(text).toContain("meta skuid $UID_F ip daddr 192.168.2.1 meta l4proto");
    expect(text).toContain("tcp dport { 3000, 9999 }");
    expect(text).toContain(`<<'FACTORY_EOF'\n{\n  "allowHosts": [\n    "192.168.2.10:5432"\n  ],`);
    expect(text).toContain("# download sops (done by factory bootstrap itself; see the plan for what it does)");
    expect(steps.find((s) => s.id === "user")?.record).toEqual({ user: "sbxuser", created: true });
    expect(steps.find((s) => s.id === "user")?.done()).toBe(false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    M.setRoot(savedRoot);
  }
});
