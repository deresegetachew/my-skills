#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory nats up|down|status` (#407, decision 0004 point 3): this machine's NATS server, in Docker.
//
//   factory nats up [--leaf HUB_ADDRESS[:PORT] | --hub] [--address ADDRESS]
//                         write the compose file and the server's config to this machine's state folder and start it
//                         (docker compose, restart unless-stopped). A hub holds JetStream and takes the leaf servers
//                         of the other machines; a leaf connects to the hub. Without --leaf or --hub the saved role is
//                         kept (a hub the first time). It listens on this machine's Tailscale address only
//                         (`tailscale ip -4`, or --address), never 0.0.0.0, then waits until the server answers
//   factory nats down     stop it; JetStream's data and the files are kept, so `up` starts the same server again
//   factory nats status   the role, the address and whether the server answers (exit 1 when it is set up but doesn't)
//
// Ports: FACTORY_NATS_PORT (4222) for clients and FACTORY_NATS_LEAF_PORT (7422) for the hub's leaf port, on the host.
// The files are <state folder>/nats/{compose.yaml,nats.conf,nats.json}: readable by the container, not writable by
// others (#111). Refusals are {code, message, fix} on stderr with exit 1 and change nothing; a failed start puts the
// earlier files back.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { isIP, Socket } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { die, now, pyDumps, run, runMain, sleepSync, which, writeAtomic } from "./factory_lib.ts";
import { refuse, repoKey, stateDir } from "./factory_machine.ts";
import { GuardError, parseAllowHost } from "./factory_netguard.ts";

export const IMAGE = "nats:2.10.22-alpine";
const CLIENT_PORT = 4222; // inside the container
const LEAF_PORT = 7422;
const FILES = ["compose.yaml", "nats.conf", "nats.json"] as const;
const USAGE = "usage: factory nats up [--leaf HUB_ADDRESS[:PORT] | --hub] [--address ADDRESS] | down | status";
const NOT_SET_UP = "No NATS server is set up here. `factory nats up` starts one on this machine.";

export interface Saved {
  role: "hub" | "leaf";
  address: string;
  hub?: string;
  port: number;
  leafPort: number;
}

/** The project's name as a NATS token and a compose project: lowercase letters, digits and dashes. */
function token(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "factory";
}

export function natsDir(): string {
  return join(stateDir(), "nats");
}

function projectName(): string {
  return `${token(repoKey())}-nats`;
}

function portFrom(name: string, dflt: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > 65535) refuse("bad-port", `${name}=${raw} isn't a port.`, `Set ${name} to 1-65535, or unset it.`);
  return n;
}

function readSaved(): Saved | null {
  try {
    const data = JSON.parse(readFileSync(join(natsDir(), "nats.json"), "utf8")) as Saved;
    return data && (data.role === "hub" || data.role === "leaf") && typeof data.address === "string" ? data : null;
  } catch {
    return null;
  }
}

/** A specific IPv4 address to listen on; 0.0.0.0 and names are refused. */
function checkedAddress(text: string, what: string): string {
  const a = text.trim();
  if (a === "0.0.0.0") {
    refuse("wide-address", `${what} 0.0.0.0 would open NATS to every network this machine is on.`,
      "Give this machine's Tailscale address (`tailscale ip -4`), for example --address 100.64.1.2.");
  }
  if (isIP(a) !== 4) refuse("bad-address", `${what} ${JSON.stringify(a)} isn't an IPv4 address.`, "Give an address such as 100.64.1.2, not a name.");
  return a;
}

function tailscaleAddress(): string {
  const p = which("tailscale") ? run(["tailscale", "ip", "-4"]) : null;
  const first = p && p.code === 0 ? (p.stdout.trim().split("\n")[0] ?? "").trim() : "";
  if (!first) {
    refuse("no-address", "There is no Tailscale address to listen on: `tailscale ip -4` gave none.",
      "Start Tailscale (`tailscale up`), or give the address: factory nats up --address <this machine's address>.");
  }
  return first;
}

/** "addr" or "addr:port" of the hub, as "addr:port". */
function hubOf(text: string): string {
  let addr: string;
  let port: string | null;
  try {
    [addr, port] = parseAllowHost(text);
  } catch (e) {
    if (!(e instanceof GuardError)) throw e;
    return refuse("bad-address", `--leaf ${JSON.stringify(text)}: ${e.message}.`, "Give the hub's Tailscale address, for example --leaf 100.64.9.9.");
  }
  checkedAddress(addr, "--leaf");
  if (port && port.includes("-")) refuse("bad-address", `--leaf ${text}: a port range isn't a port.`, "Give one port, for example --leaf 100.64.9.9:7422.");
  return `${addr}:${port ?? LEAF_PORT}`;
}

export function renderConf(s: Saved, name: string): string {
  const out = ["# Written by `factory nats up`. Run it again to change this, not this file.",
    `server_name: "${name}"`, `port: ${CLIENT_PORT}`];
  if (s.role === "hub") {
    out.push("jetstream {", '  store_dir: "/data"', "}", "leafnodes {", `  port: ${LEAF_PORT}`, "}");
  } else {
    out.push("leafnodes {", "  remotes: [", `    { url: "nats-leaf://${s.hub}" }`, "  ]", "}");
  }
  return out.join("\n") + "\n";
}

export function renderCompose(s: Saved): string {
  // Inside the container the server listens on every interface of the container; on the host the ports are
  // published on the one address, so nothing else on this machine's networks reaches it.
  const ports = [`      - "${s.address}:${s.port}:${CLIENT_PORT}"`];
  if (s.role === "hub") ports.push(`      - "${s.address}:${s.leafPort}:${LEAF_PORT}"`);
  const volumes = ["      - ./nats.conf:/etc/nats/nats.conf:ro"];
  if (s.role === "hub") volumes.push("      - data:/data");
  const out = ["# Written by `factory nats up`. Run it again to change this, not this file.", "services:", "  nats:",
    `    image: ${IMAGE}`, '    command: ["nats-server", "--config", "/etc/nats/nats.conf"]', "    restart: unless-stopped",
    "    ports:", ...ports, "    volumes:", ...volumes];
  if (s.role === "hub") out.push("volumes:", "  data:");
  return out.join("\n") + "\n";
}

function compose(args: string[]) {
  return run(["docker", "compose", "--file", join(natsDir(), "compose.yaml"), "--project-name", projectName(), ...args]);
}

export interface Answer {
  ok: boolean;
  version: string;
  jetstream: boolean;
  why: string;
}

/** Connect to host:port and read the `INFO {json}` line a NATS server sends first. Never throws. */
export function probe(host: string, port: number, timeoutSeconds = 2): Promise<Answer> {
  return new Promise((done) => {
    const sock = new Socket();
    let buf = "";
    let settled = false;
    const finish = (a: Answer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      done(a);
    };
    const no = (why: string): Answer => ({ ok: false, version: "", jetstream: false, why });
    const timer = setTimeout(() => finish(no("no answer in time")), timeoutSeconds * 1000);
    sock.on("error", (e: NodeJS.ErrnoException) => finish(no(e.code === "ECONNREFUSED" ? "connection refused" : e.code || e.message)));
    sock.on("close", () => finish(no("closed before it said who it is")));
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      if (!line.startsWith("INFO ")) return finish(no("it isn't a NATS server"));
      try {
        const info = JSON.parse(line.slice(5)) as { version?: unknown; jetstream?: unknown };
        finish({ ok: true, version: typeof info.version === "string" ? info.version : "", jetstream: info.jetstream === true, why: "" });
      } catch {
        finish(no("it isn't a NATS server"));
      }
    });
    sock.connect(port, host);
  });
}

export function describe(a: Answer): string {
  return [a.version ? `nats-server ${a.version}` : "", a.jetstream ? "JetStream on" : "JetStream off"].filter(Boolean).join(", ");
}

/** Probe until it answers or `seconds` have passed. */
async function waitFor(host: string, port: number, seconds: number): Promise<Answer> {
  const deadline = now() + seconds;
  for (;;) {
    const left = deadline - now();
    const a = await probe(host, port, Math.max(0.2, Math.min(2, left)));
    if (a.ok || now() + 0.5 >= deadline) return a;
    sleepSync(0.5);
  }
}

function guardLine(s: Saved): string {
  const hosts = [`${s.address}:${s.port}`, ...(s.role === "leaf" && s.hub ? [s.hub] : [])];
  return "On a sandboxed machine the network guard must let the agents reach it: " +
    `sudo factory bootstrap machine --apply ${hosts.map((h) => `--allow-host ${h}`).join(" ")}`;
}

function dockerReady(): void {
  if (!which("docker")) refuse("docker-missing", "Docker isn't installed or isn't on your PATH.", "Install Docker (rootless on Linux; Docker Desktop or Colima on macOS), then run `factory nats up` again.");
  if (run(["docker", "info"]).code !== 0) {
    refuse("docker-down", "Docker isn't running, or this user can't reach it.",
      "Start Docker (rootless: `systemctl --user start docker`, and set DOCKER_HOST), then run `factory nats up` again.");
  }
}

interface UpArgs {
  address: string | null;
  leaf: string | null;
  hub: boolean;
}

function parseUp(argv: string[]): UpArgs {
  const a: UpArgs = { address: null, leaf: null, hub: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i] as string;
    if (x === "--hub") a.hub = true;
    else if (x === "--address" || x === "--leaf") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) usage(`${x} needs a value`);
      if (x === "--address") a.address = v;
      else a.leaf = v;
    } else usage(`unknown option ${x}`);
  }
  if (a.hub && a.leaf !== null) usage("--hub and --leaf can't go together");
  return a;
}

function usage(why: string): never {
  process.stderr.write(`${USAGE}\nfactory nats: ${why}\n`);
  return die(2);
}

/** Write the files; on failure of what follows, `undo` puts back what was there. */
function writeFiles(texts: Record<string, string>): () => void {
  const dir = natsDir();
  const existed = existsSync(dir);
  const before: Record<string, string | null> = {};
  for (const f of FILES) before[f] = existed && existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null;
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  for (const f of FILES) {
    writeAtomic(join(dir, f), texts[f] as string, 0o644);
    chmodSync(join(dir, f), 0o644); // writeFileSync's mode is cut by the umask
  }
  return () => {
    for (const f of FILES) {
      const old = before[f];
      if (old === null || old === undefined) rmSync(join(dir, f), { force: true });
      else writeAtomic(join(dir, f), old, 0o644);
    }
    if (!existed) {
      try {
        rmdirSync(dir);
      } catch {
        // something else is in it now: leave it
      }
    }
  };
}

async function up(argv: string[]): Promise<number> {
  const a = parseUp(argv);
  const saved = readSaved();
  const address = checkedAddress(a.address ?? tailscaleAddress(), "--address");
  const role = a.leaf !== null ? "leaf" : a.hub ? "hub" : saved?.role ?? "hub";
  const hub = a.leaf !== null ? hubOf(a.leaf) : role === "leaf" ? saved?.hub : undefined;
  if (role === "leaf" && !hub) refuse("no-hub", "This machine is a leaf, but the hub's address isn't saved.", "Run factory nats up --leaf <hub's Tailscale address>.");
  const s: Saved = { role, address, ...(role === "leaf" ? { hub } : {}), port: portFrom("FACTORY_NATS_PORT", CLIENT_PORT),
    leafPort: portFrom("FACTORY_NATS_LEAF_PORT", LEAF_PORT) };
  dockerReady();
  const name = `${token(repoKey())}-${role}-${token(hostname())}`;
  const undo = writeFiles({ "compose.yaml": renderCompose(s), "nats.conf": renderConf(s, name), "nats.json": pyDumps(s, { indent: 2 }) + "\n" });
  const p = compose(["up", "-d"]);
  if (p.code !== 0) {
    undo();
    refuse("compose-failed", `docker compose couldn't start the NATS server: ${(p.stderr || p.stdout).trim().slice(-400)}`,
      "Fix what Docker says, then run `factory nats up` again. The earlier files were put back.");
  }
  const url = `nats://${s.address}:${s.port}`;
  console.log(`Started the NATS ${role} ${projectName()} on ${url}` + (role === "leaf" ? `, connected to the hub at ${s.hub}` : "") +
    " (restarts with Docker).");
  const answer = await waitFor(s.address, s.port, Number(process.env.FACTORY_NATS_WAIT ?? "10"));
  if (answer.ok) console.log(`The server answers at ${url} (${describe(answer)}).`);
  else console.log(`note: the server doesn't answer at ${url} yet (${answer.why}). \`factory nats status\` checks it again.`);
  console.log(guardLine(s));
  return 0;
}

function down(argv: string[]): number {
  if (argv.length) usage(`down takes no options, not ${argv.join(" ")}`);
  if (!readSaved()) {
    console.log(NOT_SET_UP);
    return 0;
  }
  if (!which("docker")) refuse("docker-missing", "Docker isn't installed or isn't on your PATH.", "Install Docker, then run `factory nats down` again.");
  const p = compose(["down", "--remove-orphans"]);
  if (p.code !== 0) {
    refuse("compose-failed", `docker compose couldn't stop the NATS server: ${(p.stderr || p.stdout).trim().slice(-400)}`,
      "Fix what Docker says, then run `factory nats down` again.");
  }
  console.log(`Stopped ${projectName()}. JetStream's data and the files in ${natsDir()} are kept: \`factory nats up\` starts it again.`);
  return 0;
}

async function status(argv: string[]): Promise<number> {
  if (argv.length) usage(`status takes no options, not ${argv.join(" ")}`);
  const s = readSaved();
  if (!s) {
    console.log(NOT_SET_UP);
    return 0;
  }
  const url = `nats://${s.address}:${s.port}`;
  console.log(`This machine runs the NATS ${s.role} on ${url}` + (s.role === "leaf" ? `, a leaf of the hub at ${s.hub}` : "") +
    ` (files in ${natsDir()}).`);
  const a = await probe(s.address, s.port);
  if (a.ok) {
    console.log(`The server answers (${describe(a)}).`);
    return 0;
  }
  console.log(`The server doesn't answer (${a.why}). Run \`factory nats up\` to start it, and check \`docker compose ls\`.`);
  return 1;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "up") return up(rest);
  if (cmd === "down") return down(rest);
  if (cmd === "status" || cmd === undefined) return status(rest);
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return 0;
  }
  return usage(`unknown command ${cmd}`);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
