// NATS user keys (nkeys), with Node's own crypto: an ed25519 pair, a seed (`SU...`) and a public key (`U...`), as the
// nats-server and its clients read them. No npm package (CLAUDE.md): the format is a prefix byte, the key, and a CRC16,
// in base32 without padding.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PREFIX_SEED = 18 << 3;
const PREFIX_USER = 20 << 3;
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

function encode(payload: Uint8Array): string {
  const crc = crc16(payload);
  return base32(Buffer.concat([payload, Buffer.from([crc & 255, crc >> 8])]));
}

export interface UserKey {
  seed: string;
  publicKey: string;
}

/** A new user key: the seed (secret) and the public key the server's config names. */
export function newUserKey(): UserKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(String(privateKey.export({ format: "jwk" }).d), "base64url");
  const pub = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
  return { seed: encodeSeed(raw), publicKey: encode(Buffer.concat([Buffer.from([PREFIX_USER]), pub])) };
}

function encodeSeed(raw: Buffer): string {
  const head = Buffer.from([PREFIX_SEED | (PREFIX_USER >> 5), (PREFIX_USER & 31) << 3]);
  return encode(Buffer.concat([head, raw]));
}

/** The 32 raw bytes inside a user seed, or null when the text is not one (wrong prefix, length or checksum). */
export function rawSeed(seed: string): Buffer | null {
  const bytes = unbase32(seed.trim());
  if (!bytes || bytes.length !== 36) return null;
  const crc = bytes[34]! | (bytes[35]! << 8);
  if (crc16(bytes.subarray(0, 34)) !== crc) return null;
  if (bytes[0] !== (PREFIX_SEED | (PREFIX_USER >> 5)) || bytes[1] !== ((PREFIX_USER & 31) << 3)) return null;
  return bytes.subarray(2, 34);
}

/** The public key for a seed, or null when it is not a user seed. */
export function publicKeyOf(seed: string): string | null {
  const raw = rawSeed(seed);
  if (!raw) return null;
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw]), format: "der", type: "pkcs8" });
  const x = Buffer.from(String(key.export({ format: "jwk" }).x), "base64url");
  return encode(Buffer.concat([Buffer.from([PREFIX_USER]), x]));
}

/** What the server asks for on CONNECT: the server's nonce signed with the seed, base64url without padding. */
export function signNonce(seed: string, nonce: string): string | null {
  const raw = rawSeed(seed);
  if (!raw) return null;
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw]), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(nonce), key).toString("base64url");
}
