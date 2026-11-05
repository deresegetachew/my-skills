// NATS keys and permissions for the agents (#408, decision 0004 point 4), with Node's crypto only.
//
// An nkey is an ed25519 key written the NATS way: base32 (no padding) of a prefix byte, the 32 key bytes and a CRC-16
// (XMODEM, little-endian). A user's public key starts with U, its seed with SU. The server config lists the public
// key with the role's permissions; the seed stays with the agent (`<creds>/<name>.nk`, mode 600 in a 700 folder).
//
// `natsTry` is the smallest client the doctor needs: read the server's INFO, sign its nonce with the seed, CONNECT,
// publish once and see whether the server refuses it. It never subscribes and sends an empty payload.
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PREFIX_SEED = 18 << 3; // 'S'
const PREFIX_USER = 20 << 3; // 'U'
// The DER header of a PKCS#8 ed25519 private key; the 32 seed bytes follow it.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export const ROLES = ["builder", "manager", "po", "owner"] as const;
export type Role = (typeof ROLES)[number];
/** The role names decision 0004 and the loops use, as the same roles. */
export const ROLE_ALIASES: Record<string, Role> = { "coding-agent": "builder", "dev-manager": "manager",
  "product-owner": "po" };
/** A project or agent name: a valid NATS subject token (decision 0004 point 6). */
export const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function roleOf(text: string): Role | null {
  if ((ROLES as readonly string[]).includes(text)) return text as Role;
  return ROLE_ALIASES[text] ?? null;
}

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(data: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of data) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of text) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function withCrc(raw: number[]): Uint8Array {
  const c = crc16(Uint8Array.from(raw));
  return Uint8Array.from([...raw, c & 0xff, c >> 8]);
}

function keyObject(seed: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: "der", type: "pkcs8" });
}

function publicBytes(seed: Uint8Array): Uint8Array {
  const jwk = createPublicKey(keyObject(seed)).export({ format: "jwk" });
  return Uint8Array.from(Buffer.from(String(jwk.x), "base64url"));
}

/** A new user nkey: [seed "SU...", public key "U..."]. */
export function newUserKey(): [string, string] {
  const { privateKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(String(privateKey.export({ format: "jwk" }).d), "base64url");
  const seed = base32(withCrc([PREFIX_SEED | (PREFIX_USER >> 5), (PREFIX_USER & 31) << 3, ...d]));
  return [seed, publicKeyOf(seed)];
}

/** The 32 key bytes of a user seed; throws on anything else (a bad checksum, another kind of key). */
function seedBytes(seed: string): Uint8Array {
  const raw = unbase32(seed.trim());
  if (raw.length !== 36) throw new Error("not a user seed");
  const body = raw.slice(0, 34);
  const c = crc16(body);
  if (raw[34] !== (c & 0xff) || raw[35] !== c >> 8) throw new Error("bad checksum");
  if (raw[0] !== (PREFIX_SEED | (PREFIX_USER >> 5)) || raw[1] !== ((PREFIX_USER & 31) << 3)) throw new Error("not a user seed");
  return raw.slice(2, 34);
}

/** The public key "U..." of a user seed. Throws when the text is not one. */
export function publicKeyOf(seed: string): string {
  return base32(withCrc([PREFIX_USER, ...publicBytes(seedBytes(seed))]));
}

/** The signature the server asks for: the nonce signed with the seed, base64url without padding. */
export function signNonce(seed: string, nonce: string): string {
  return sign(null, Buffer.from(nonce), keyObject(seedBytes(seed))).toString("base64url");
}

export interface Permissions {
  publish: { allow: string[]; deny: string[] };
  subscribe: { allow: string[]; deny: string[] };
}

/** What an agent of `role` may publish and subscribe to in `project` (decision 0004 points 4 and 6). The last token of
 * every factory subject is the sender, so an agent publishes only on subjects that end in its own name; hand-offs
 * only a manager. JetStream's API and the key-value buckets are open to every role (the transport needs them), but
 * deleting or purging a stream is for the manager and the owner. */
export function permissions(project: string, name: string, role: Role): Permissions {
  const p = `factory.${project}`;
  const own = [`${p}.claims.${name}`, `${p}.pr.*.${name}`, `${p}.issue.*.${name}`, `${p}.agent.*.${name}`,
    `${p}.wake.${name}`];
  if (role === "manager") own.push(`${p}.handoff.${name}`);
  const js = ["$JS.API.>", "$JS.ACK.>", "$JS.FC.>", "$KV.>", "_INBOX.>"];
  const admin = role === "manager" || role === "owner";
  return {
    publish: { allow: [...own, ...js], deny: admin ? [] : ["$JS.API.STREAM.DELETE.>", "$JS.API.STREAM.PURGE.>"] },
    subscribe: { allow: [`${p}.>`, "$KV.>", "$JS.FC.>", "_INBOX.>"], deny: [] },
  };
}

export type TryResult = { state: "accepted" | "refused" | "auth" | "down"; detail: string };

/** Connect to `url` with `seed`, publish an empty message on `subject`, and say what the server did with it:
 * accepted, refused (a permissions violation), auth (the key was not taken) or down. Never throws. */
export function natsTry(url: string, seed: string, subject: string, timeoutMs = 3000): Promise<TryResult> {
  return new Promise((done) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      done({ state: "down", detail: "not a nats:// address" });
      return;
    }
    const port = Number(u.port || "4222");
    const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
    const sock = u.protocol === "tls:" ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    let buf = "";
    let sent = false;
    let settled = false;
    const finish = (r: TryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      done(r);
    };
    const timer = setTimeout(() => finish({ state: "down", detail: "no answer" }), timeoutMs);
    sock.on("error", (e: NodeJS.ErrnoException) => finish({ state: "down", detail: e.code ?? e.message }));
    sock.on("close", () => finish({ state: "down", detail: "closed" }));
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith("INFO ") && !sent) {
          sent = true;
          let nonce = "";
          try {
            nonce = String((JSON.parse(line.slice(5)) as { nonce?: string }).nonce ?? "");
          } catch {
            finish({ state: "down", detail: "a bad INFO line" });
            return;
          }
          let auth: Record<string, string> = {};
          try {
            auth = { nkey: publicKeyOf(seed), sig: signNonce(seed, nonce) };
          } catch {
            finish({ state: "auth", detail: "the seed file holds no user seed" });
            return;
          }
          const connect = { verbose: false, pedantic: false, lang: "factory", version: "1", protocol: 1, ...auth };
          sock.write(`CONNECT ${JSON.stringify(connect)}\r\nPUB ${subject} 0\r\n\r\nPING\r\n`);
        } else if (line.startsWith("-ERR")) {
          const text = line.slice(4).trim().replace(/^'|'$/g, "");
          if (/permissions violation/i.test(text)) finish({ state: "refused", detail: text });
          else finish({ state: /authoriz|authenticat/i.test(text) ? "auth" : "down", detail: text });
        } else if (line === "PONG") finish({ state: "accepted", detail: "" });
        else if (line === "PING") sock.write("PONG\r\n");
      }
    });
  });
}
