// Tar archives for the factory's releases (#113): a deterministic writer (tools/build_release.ts) and a careful reader
// (factory_release.ts, `factory update`). Bun has gzip built in but no tar, and the factory uses no npm package.
//
// Writer: POSIX ustar, with a PAX header ("x") only for a path that does not fit; owner, group and times are fixed.
// Reader: ustar, PAX ("x", "g") and GNU long names ("L", "K"), so archives made by Python's tarfile read the same.

const BLOCK = 512;
const RECORD = BLOCK * 20;

export class TarError extends Error {}

export interface TarInput {
  name: string;
  mode: number;
  data: Uint8Array;
}

export type TarKind = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarEntry {
  name: string;
  kind: TarKind;
  mode: number;
  size: number;
  linkname: string;
  data: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function putString(buf: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = enc.encode(text);
  if (bytes.length > length) throw new TarError(`'${text}' does not fit in a tar header field`);
  buf.set(bytes, offset);
}

function putOctal(buf: Uint8Array, offset: number, length: number, value: number): void {
  // length-1 octal digits, then a NUL (as Python's tarfile writes them)
  putString(buf, offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
}

function header(name: string, mode: number, size: number, type: string, prefix = ""): Uint8Array {
  const h = new Uint8Array(BLOCK);
  putString(h, 0, 100, name);
  putOctal(h, 100, 8, mode);
  putOctal(h, 108, 8, 0); // uid
  putOctal(h, 116, 8, 0); // gid
  putOctal(h, 124, 12, size);
  putOctal(h, 136, 12, 0); // mtime
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  putString(h, 156, 1, type);
  putString(h, 257, 6, "ustar\0");
  putString(h, 263, 2, "00");
  putOctal(h, 329, 8, 0); // devmajor
  putOctal(h, 337, 8, 0); // devminor
  putString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  putString(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/** Split a path into ustar (prefix, name), or null when it needs a PAX header. */
function ustarName(path: string): [string, string] | null {
  const n = enc.encode(path).length;
  if (n <= 100 && /^[\x20-\x7e]*$/.test(path)) return ["", path];
  if (!/^[\x20-\x7e]*$/.test(path)) return null;
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return [prefix, name];
  }
  return null;
}

function paxRecord(key: string, value: string): string {
  // "<length> key=value\n", where <length> counts its own digits too.
  const body = enc.encode(` ${key}=${value}\n`).length;
  let len = body + 1;
  while (String(len).length + body !== len) len = String(len).length + body;
  return `${len} ${key}=${value}\n`;
}

function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
  out.set(data);
  return out;
}

/** A tar archive of plain files, in the order given, padded to a whole record like Python's tarfile. */
export function tarCreate(entries: readonly TarInput[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const split = ustarName(e.name);
    if (split) parts.push(header(split[1], e.mode, e.data.length, "0", split[0]));
    else {
      const pax = enc.encode(paxRecord("path", e.name));
      parts.push(header("././@PaxHeader", 0o644, pax.length, "x"), padded(pax));
      parts.push(header(e.name.slice(-100).replace(/[^\x20-\x7e]/g, "_"), e.mode, e.data.length, "0"));
    }
    parts.push(padded(e.data));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(Math.ceil(total / RECORD) * RECORD);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Gzip with no time and no name in the header, so the same bytes give the same archive. */
export function gzipFixed(data: Uint8Array): Uint8Array {
  const out = Bun.gzipSync(new Uint8Array(data), { level: 9 });
  out[4] = out[5] = out[6] = out[7] = 0;
  return out;
}

function str(buf: Uint8Array, offset: number, length: number): string {
  const field = buf.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return dec.decode(end < 0 ? field : field.subarray(0, end));
}

function octal(buf: Uint8Array, offset: number, length: number): number {
  if ((buf[offset] ?? 0) & 0x80) {
    // base-256, as GNU tar writes big numbers
    let v = 0;
    for (let i = offset + 1; i < offset + length; i++) v = v * 256 + (buf[i] ?? 0);
    return v;
  }
  const text = str(buf, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`invalid number in a tar header: '${text}'`);
  return parseInt(text, 8);
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    if (sp < 0) break;
    const len = Number(dec.decode(data.subarray(at, sp)));
    if (!Number.isInteger(len) || len <= 0) throw new TarError("invalid PAX header");
    const rec = dec.decode(data.subarray(sp + 1, at + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    at += len;
  }
  return out;
}

/** The members of a tar archive, one at a time, in order. Throws TarError on a damaged archive. */
export function* tarEntries(tar: Uint8Array): Generator<TarEntry> {
  let at = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;
  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) return; // end of archive
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] as number);
    if (sum !== octal(h, 148, 8)) throw new TarError("bad checksum in a tar header");
    const type = String.fromCharCode(h[156] as number) || "0";
    let size = octal(h, 124, 12);
    if (pax.size !== undefined) size = Number(pax.size);
    const start = at + BLOCK;
    const end = start + size;
    if (end > tar.length) throw new TarError("unexpected end of data");
    const data = tar.subarray(start, end);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = str(data, 0, data.length);
      continue;
    }
    if (type === "K") {
      longLink = str(data, 0, data.length);
      continue;
    }
    const magic = str(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? str(h, 345, 155) : "";
    let name = pax.path ?? longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const linkname = pax.linkpath ?? longLink ?? str(h, 157, 100);
    const kind: TarKind = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "dir"
      : type === "2" ? "symlink" : type === "1" ? "hardlink" : "other";
    if (kind === "dir") name = name.replace(/\/+$/, "");
    yield { name, kind, mode: octal(h, 100, 8), size, linkname, data };
    pax = {};
    longName = null;
    longLink = null;
  }
  if (at < tar.length) throw new TarError("unexpected end of data");
}
