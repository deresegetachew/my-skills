#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory nats user add|check` (#408, decision 0004 point 4): one credential per agent on the NATS server.
//
//   factory nats user add <name> --role coding-agent|dev-manager|product-owner [--project P] [--creds DIR] [--server-dir DIR]
//       makes an nkey, writes its seed to <creds>/<name>.nk (mode 600, in a 700 folder), adds its public key and its
//       role's permissions to the server's users file (<server-dir>/users.conf, which the server's config includes), and
//       tells the server to reload. Refuses a name that exists; undoes the seed when the users file can't be written.
//   factory nats user check [<name>] [--url U] [--project P] [--creds DIR]
//       what `factory doctor` runs when messaging.transport is "nats": the seed and its modes, signing in, a publish on
//       the agent's own subject (accepted), and a publish as another agent (must be refused: a server that accepts it
//       fails the check).
//
// The permissions are by subject, and the last token of every subject is its sender (decision 0004 point 6), so an agent
// may publish only on subjects that end in its own name. Only a dev manager may publish hand-offs. Defaults: the seed
// folder is `messaging.creds`, else ~/.secrets/nats/<project>/; the users file is in ~/.config/factory/nats/<project>/;
// the project is the repo's folder name. The server runs in Docker (`factory nats up`), so the reload is
// `docker kill --signal HUP factory-nats-<project>`; with no such container the file is read when the server starts.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { messagingSettings } from "./core/compose.ts";
import { type Config, load } from "./factory_config.ts";
import { Exit, FactoryError, git, parseArgs, run, runMain } from "./factory_lib.ts";
import { newUserKey, publicKeyOf, signNonce } from "./factory_nkey.ts";

export const ROLES = ["coding-agent", "dev-manager", "product-owner"] as const;
const NAME = /^[a-z0-9-]+$/;
const USAGE = "usage: factory nats user add <name> --role coding-agent|dev-manager|product-owner [--creds DIR]\n" +
  "       factory nats user check [<name>] [--url URL]";

export interface Where {
  project: string;
  creds: string;
  serverDir: string;
}

function config(): Config | null {
  try {
    return load();
  } catch {
    return null;
  }
}

function expand(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

/** The project's name as a NATS subject token: the repo folder's name, lowercase, anything else a dash. */
export function projectName(dir: string = process.cwd()): string {
  const top = git(["rev-parse", "--show-toplevel"], { cwd: dir });
  const base = (top.code === 0 ? top.stdout.trim() : dir).split("/").pop() ?? "";
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function where(opts: { project?: string; creds?: string; serverDir?: string }, cfg: Config | null): Where {
  const project = opts.project ?? projectName();
  if (!NAME.test(project)) fail("nats-project-name", `"${project}" is not a project name NATS can use in a subject.`, "Use lowercase letters, digits and dashes in --project.");
  const fromSetting = cfg ? messagingSettings(cfg).creds : "";
  return {
    project,
    creds: resolve(expand(opts.creds ?? (fromSetting || join(homedir(), ".secrets", "nats", project)))),
    serverDir: resolve(expand(opts.serverDir ?? join(homedir(), ".config", "factory", "nats", project))),
  };
}

/** The project's JetStream stream (one per project, decision 0004 point 6); the NATS transport (#409) creates it. */
export function streamName(project: string): string {
  return `factory-${project}`;
}

/** The subjects a role may publish and subscribe on (the last token of each publish subject is the sender). */
export function permissions(project: string, name: string, role: string): { publish: string[]; subscribe: string[] } {
  const p = `factory.${project}`;
  const publish = [`${p}.claims.${name}`, `${p}.pr.*.${name}`, `${p}.issue.*.${name}`, `${p}.agent.*.${name}`, `${p}.wake.${name}`];
  if (role === "dev-manager") publish.push(`${p}.handoff.${name}`);
  // JetStream's own subjects carry no sender (decision 0004 point 4), so an agent gets only what reading needs: its own
  // durable consumer on the project's stream, and the claims bucket. Making, changing or purging the stream is the
  // operator's (`factory nats up`), never an agent's: `$JS.API.>` would let a builder rewrite subjects and forge senders.
  const s = streamName(project);
  const c = `${s}.${name}`;
  publish.push("$JS.API.INFO", `$JS.API.STREAM.INFO.${s}`, `$JS.API.CONSUMER.CREATE.${c}`, `$JS.API.CONSUMER.CREATE.${c}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${c}`, `$JS.API.CONSUMER.INFO.${c}`, `$JS.API.CONSUMER.MSG.NEXT.${c}`, `$JS.ACK.${c}.>`,
    "$JS.API.STREAM.INFO.KV_claims", "$JS.API.STREAM.MSG.GET.KV_claims", "$JS.API.DIRECT.GET.KV_claims.>", "$KV.claims.>");
  return { publish, subscribe: [`${p}.>`, "_INBOX.>"] };
}

const HEADER = "# Managed by `factory nats user add`: do not edit by hand. The server's config includes this file:\n" +
  '#   authorization { include "users.conf" }\n';

function userBlock(w: Where, name: string, role: string, publicKey: string): string {
  const perm = permissions(w.project, name, role);
  const list = (xs: string[]) => xs.map((x) => JSON.stringify(x)).join(", ");
  return `  # factory-user ${name} ${role}\n  {\n    nkey: ${publicKey}\n    permissions: {\n` +
    `      publish: { allow: [${list(perm.publish)}] }\n      subscribe: { allow: [${list(perm.subscribe)}] }\n    }\n  }\n`;
}

function usersFile(w: Where): string {
  return join(w.serverDir, "users.conf");
}

function readUsers(w: Where): string {
  return existsSync(usersFile(w)) ? readFileSync(usersFile(w), "utf8") : `${HEADER}users = [\n]\n`;
}

function hasUser(text: string, name: string): boolean {
  return text.split("\n").some((l) => l.startsWith(`  # factory-user ${name} `));
}

function writeUsers(w: Where, text: string): void {
  mkdirSync(w.serverDir, { recursive: true, mode: 0o755 });
  chmodSync(w.serverDir, 0o755);
  const tmp = `${usersFile(w)}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    chmodSync(tmp, 0o644); // a container reads it: not writable by others
    renameSync(tmp, usersFile(w));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function fail(code: string, message: string, fix: string): never {
  throw new FactoryError(code, message, fix);
}

/** Add a user: seed file, users file, reload. Returns the lines to print. */
export function add(name: string, role: string, w: Where): string[] {
  if (!NAME.test(name)) fail("nats-user-name", `"${name}" is not a name NATS can use in a subject.`, "Use lowercase letters, digits and dashes.");
  if (!(ROLES as readonly string[]).includes(role)) {
    fail("nats-user-role", `"${role}" is not a role.`, `Use one of: ${ROLES.join(", ")}.`);
  }
  const seedPath = join(w.creds, `${name}.nk`);
  let users: string;
  try {
    users = readUsers(w);
  } catch (e) {
    return fail("nats-user-write", `Can't read ${usersFile(w)}: ${(e as Error).message}`, "Fix that file's permissions or remove it, and run the command again.");
  }
  if (existsSync(seedPath) || hasUser(users, name)) {
    fail("nats-user-exists", `"${name}" already has a credential (${seedPath}).`,
      "Pick another name. To replace it, delete its seed file and its block in the users file, then add it again.");
  }
  const key = newUserKey();
  const madeFolder = !existsSync(w.creds);
  if (!madeFolder && mode(w.creds) !== 0o700) {
    fail("nats-creds-mode", `The seed folder ${w.creds} is mode ${mode(w.creds).toString(8)}, so others could plant or read seeds.`,
      `Run \`chmod 700 ${w.creds}\` and add the user again.`);
  }
  let wrote = false;
  try {
    mkdirSync(w.creds, { recursive: true, mode: 0o700 });
    if (madeFolder) chmodSync(w.creds, 0o700);
    writeFileSync(seedPath, `${key.seed}\n`, { mode: 0o600, flag: "wx" }); // never through a link, never over another's seed
    wrote = true;
    chmodSync(seedPath, 0o600);
    const end = users.lastIndexOf("]\n");
    writeUsers(w, users.slice(0, end) + userBlock(w, name, role, key.publicKey) + users.slice(end));
  } catch (e) {
    if (wrote) rmSync(seedPath, { force: true });
    if (madeFolder) rmSync(w.creds, { recursive: true, force: true });
    if (e instanceof FactoryError) throw e;
    return fail("nats-user-write", `Couldn't write the credential: ${(e as Error).message}`, "Nothing was changed. Check the folders' permissions and run the command again.");
  }
  const reload = run(["docker", "kill", "--signal", "HUP", `factory-nats-${w.project}`]);
  return [`added ${name} (${role})`, `  seed:   ${seedPath} (mode 600)`, `  server: ${usersFile(w)}`,
    reload.code === 0 ? "  the server reloaded its users" : "  the server is not running here (or docker is not): it reads the file when it starts, so nothing is reloaded",
    `check it: factory nats user check ${name}`];
}

// --- check --------------------------------------------------------------------------------------------------------

export interface Line {
  ok: boolean;
  what: string;
  how?: string;
}

const mode = (path: string): number => statSync(path).mode & 0o777;

interface Probe {
  error: string | null;
  refused: boolean[];
}

/** Sign in with the seed and publish one message on each subject; for each, whether the server refused it. */
function probe(url: string, seed: string, subjects: { subject: string; payload: string }[]): Promise<Probe> {
  return new Promise((done) => {
    const u = new URL(url);
    const sock = connect({ host: u.hostname, port: Number(u.port || 4222) });
    const refused: boolean[] = [];
    let buf = "";
    let step = -1; // -1: waiting for INFO; then the index of the subject being tried
    let violation = false;
    let ended = false;
    const finish = (error: string | null): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      sock.destroy();
      done({ error, refused });
    };
    const timer = setTimeout(() => finish("the server did not answer in 5 seconds"), 5000);
    const next = (): void => {
      step++;
      const s = subjects[step];
      if (!s) return finish(null);
      violation = false;
      sock.write(`PUB ${s.subject} ${Buffer.byteLength(s.payload)}\r\n${s.payload}\r\nPING\r\n`);
    };
    sock.on("error", (e) => finish(e.message));
    sock.on("close", () => finish("the server closed the connection"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (line.startsWith("INFO ") && step === -1) {
          let nonce = "";
          try {
            nonce = String((JSON.parse(line.slice(5)) as { nonce?: unknown }).nonce ?? "");
          } catch {
            return finish("the server's greeting could not be read");
          }
          if (!nonce) return finish("the server does not ask for a key, so it accepts anyone");
          const pub = publicKeyOf(seed);
          const sig = signNonce(seed, nonce);
          if (!pub || !sig) return finish("the seed is not a valid NATS user seed");
          sock.write(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, nkey: pub, sig, protocol: 1, lang: "factory", version: "1" })}\r\n`);
          next();
        } else if (line.startsWith("-ERR")) {
          if (/permissions violation/i.test(line)) violation = true;
          else return finish(line.slice(5).replace(/^'|'$/g, "") || "the server refused the connection");
        } else if (line === "PONG" && step >= 0) {
          refused.push(violation);
          next();
        }
      }
    });
  });
}

/** The checks for one agent: the seed and its modes, signing in, an accepted own publish, a refused foreign one. */
export async function check(name: string, url: string, w: Where): Promise<Line[]> {
  if (!NAME.test(name)) fail("nats-user-name", `"${name}" is not a name NATS can use in a subject.`, "Use lowercase letters, digits and dashes.");
  const lines: Line[] = [];
  const seedPath = join(w.creds, `${name}.nk`);
  const add = `factory nats user add ${name} --role <role>`;
  if (!existsSync(seedPath)) {
    return [{ ok: false, what: `NATS seed for ${name}: ${seedPath} does not exist`, how: `Run \`${add}\`, or copy the seed to that path.` }];
  }
  const seedOk = mode(seedPath) === 0o600;
  const dirOk = mode(w.creds) === 0o700;
  lines.push(seedOk ? { ok: true, what: `NATS seed ${seedPath} is mode 600` }
    : { ok: false, what: `NATS seed ${seedPath} is mode ${mode(seedPath).toString(8)}, so other users can read it`, how: `Run \`chmod 600 ${seedPath}\`.` });
  lines.push(dirOk ? { ok: true, what: `NATS seed folder ${w.creds} is mode 700` }
    : { ok: false, what: `NATS seed folder ${w.creds} is mode ${mode(w.creds).toString(8)}`, how: `Run \`chmod 700 ${w.creds}\`.` });
  if (!seedOk || !dirOk) return lines;
  if (!url) return [...lines, { ok: false, what: "NATS server address: messaging.url is empty", how: "Run `factory settings set messaging.url nats://<address>:4222`, or pass --url." }];

  const seed = readFileSync(seedPath, "utf8").trim();
  const base = `factory.${w.project}.wake`;
  const other = name === "doctor-probe" ? "doctor-probe-2" : "doctor-probe";
  const msg = (from: string) => JSON.stringify({ v: 1, id: `doctor-${Date.now().toString(36)}`, kind: "probe", from, text: "factory nats user check", at: new Date().toISOString() });
  const update = `$JS.API.STREAM.UPDATE.${streamName(w.project)}`; // an agent must not be able to reconfigure the stream
  const result = await probe(url, seed, [{ subject: `${base}.${name}`, payload: msg(name) }, { subject: `${base}.${other}`, payload: msg(other) },
    { subject: update, payload: "{}" }]);
  if (result.error !== null) {
    return [...lines, { ok: false, what: `the NATS server at ${url} did not answer for ${name}: ${result.error}`,
      how: "Run `factory nats status`; check messaging.url and that this seed belongs to a user in the server's users file." }];
  }
  lines.push({ ok: true, what: `signed in to ${url} as ${name}` });
  lines.push(result.refused[0] ? { ok: false, what: `the server refused ${name}'s publish on its own subject (${base}.${name})`,
    how: `The user's block in the users file lacks its permissions: add the user again with \`${add}\` and reload the server.` }
    : { ok: true, what: `${name} can publish on its own subject` });
  lines.push(result.refused[1] ? { ok: true, what: "a publish as another agent is refused" }
    : { ok: false, what: `the server accepted a publish as another agent (${base}.${other}) from ${name}`,
      how: "The server is not checking the sender: give each user only the permissions of its role (`factory nats user add`), and remove any user without a permissions block from the server's config." });
  lines.push(result.refused[2] ? { ok: true, what: "a change to the project's stream is refused" }
    : { ok: false, what: `the server accepted ${update} from ${name}, so an agent could rewrite the stream and forge senders`,
      how: `Give agents no \`$JS.API.>\`: run \`${add}\` again for a new user, and remove the old user's block from the users file.` });
  return lines;
}

// --- the command --------------------------------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "add") {
    const a = parseArgs(rest, { valued: ["--role", "--project", "--creds", "--server-dir"], positionals: ["name"], required: ["--role"] }, "factory nats user add", USAGE);
    for (const l of add(String(a.name), String(a.role), where({ project: a.project as string | undefined, creds: a.creds as string | undefined, serverDir: a["server-dir"] as string | undefined }, config()))) console.log(l);
    return 0;
  }
  if (sub === "check") {
    const a = parseArgs(rest, { valued: ["--url", "--project", "--creds", "--server-dir"], positionals: ["name?"] }, "factory nats user check", USAGE);
    const cfg = config();
    const name = String(a.name ?? process.env.FACTORY_AGENT ?? "");
    if (!name) fail("nats-user-name", "No agent name: give one, or run it as an agent (FACTORY_AGENT).", "Run `factory nats user check <name>`.");
    const url = String(a.url ?? (cfg ? messagingSettings(cfg).url : ""));
    const lines = await check(name, url, where({ project: a.project as string | undefined, creds: a.creds as string | undefined, serverDir: a["server-dir"] as string | undefined }, cfg));
    for (const l of lines) console.log(l.ok ? `ok: ${l.what}` : `fix: ${l.what}\n     ${l.how}`);
    return lines.every((l) => l.ok) ? 0 : 1;
  }
  process.stderr.write(`${USAGE}\n`);
  throw new Exit(2);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));