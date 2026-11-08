// Attachments (#637): images, test results, logs, videos and other files linked to a task, a pull request (with its head
// commit), a sign-off item or an epic, and shown in the web UI. Never in git.
//
// - The metadata is on the board, one value per attachment (`attachment:<repo>:<kind>:<id>:<attachment id>`), so it
//   lives with the project and needs no table of its own.
// - The bytes are content-addressed (SHA-256). On the hub (the machine that runs `factory board up`, which has
//   <settings>/message-board/state.json) they are files under <settings>/message-board/attachments/<repo>/<sha[0:2]>/<sha>.
//   An attach from any other machine can't reach that folder, so its bytes ride on the board once
//   (`attachment-bytes:<repo>:<sha>`, base64) until the hub reads them: then they move into the folder and leave the
//   board ("settled"). Bytes already kept for the project are never sent again.
// - Limits: a size cap per file and per project (the distinct files the project keeps), and a retention in days; an
//   attachment older than that is dropped, and so are bytes nothing points to any more (prune, run on each attach and
//   each listing on the hub).
// - The content type comes from the file's name, from a fixed list, and an image's or a video's first bytes must match
//   it; anything else is a download. What the agent says about a file is never trusted.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Board } from "./board.ts";
import { refuse } from "./errors.ts";
import { boardDir } from "./server.ts";

export const TARGET_KINDS = ["task", "pr", "signoff", "epic"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const ATTACHMENT_KINDS = ["image", "video", "junit", "html", "log", "file"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface Target {
  kind: TargetKind;
  /** task and epic: "12" (an issue) or "b3" (a task made on the board); pr: its number; signoff: the item's id. */
  id: string;
}

export interface Attachment {
  id: string;
  project: string;
  target: Target;
  /** The commit it was taken for: a pull request's head when it was attached (null for the other targets). */
  head: string | null;
  name: string;
  /** The content type it is served with (from CONTENT_TYPES, checked against its first bytes). */
  type: string;
  kind: AttachmentKind;
  size: number;
  sha256: string;
  note: string;
  by: string;
  at: string;
}

export interface AttachLimits {
  maxFileBytes: number;
  maxProjectBytes: number;
  retentionDays: number;
}

const MB = 1024 * 1024;
export const DEFAULT_LIMITS: AttachLimits = { maxFileBytes: 25 * MB, maxProjectBytes: 2000 * MB, retentionDays: 30 };
/** The most files one attach takes. */
export const MAX_FILES = 20;
export const NOTE_MAX = 2000;

/** The limits from settings in MB and days; a value that isn't a positive whole number keeps its default. */
export function limitsOf(o: { maxFileMb?: unknown; maxProjectMb?: unknown; retentionDays?: unknown }): AttachLimits {
  const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null);
  return {
    maxFileBytes: (whole(o.maxFileMb) ?? DEFAULT_LIMITS.maxFileBytes / MB) * MB,
    maxProjectBytes: (whole(o.maxProjectMb) ?? DEFAULT_LIMITS.maxProjectBytes / MB) * MB,
    retentionDays: whole(o.retentionDays) ?? DEFAULT_LIMITS.retentionDays,
  };
}

/** What each extension is served as. Anything not here is application/octet-stream (a download). */
export const CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  webm: "video/webm", mp4: "video/mp4",
  svg: "image/svg+xml", html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  xml: "application/xml", json: "application/json", txt: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
  out: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", md: "text/markdown; charset=utf-8", pdf: "application/pdf",
  zip: "application/zip",
};
const OCTET = "application/octet-stream";

/** The types shown in the page itself (an <img> or a <video>); every other type is served as a download. */
export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/webm", "video/mp4"]);

function starts(b: Uint8Array, at: number, bytes: number[]): boolean {
  return bytes.every((x, i) => b[at + i] === x);
}

/** Whether `bytes` really are of the inline `type` (its magic number). */
function looksLike(type: string, bytes: Uint8Array): boolean {
  switch (type) {
    case "image/png": return starts(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg": return starts(bytes, 0, [0xff, 0xd8, 0xff]);
    case "image/gif": return starts(bytes, 0, [0x47, 0x49, 0x46, 0x38]);
    case "image/webp": return starts(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, 8, [0x57, 0x45, 0x42, 0x50]);
    case "video/webm": return starts(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3]);
    case "video/mp4": return starts(bytes, 4, [0x66, 0x74, 0x79, 0x70]);
    default: return true;
  }
}

/** The content type and kind of a file called `name` holding `bytes`. */
export function classify(name: string, bytes: Uint8Array): { type: string; kind: AttachmentKind } {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? "").toLowerCase();
  let type = CONTENT_TYPES[ext] ?? OCTET;
  if (INLINE_TYPES.has(type) && !looksLike(type, bytes)) type = OCTET; // a .png that isn't one is only a download
  if (type.startsWith("image/") && INLINE_TYPES.has(type)) return { type, kind: "image" };
  if (type.startsWith("video/")) return { type, kind: "video" };
  if (type === "application/xml" && /<testsuites?[\s>]/.test(new TextDecoder().decode(bytes.subarray(0, 64 * 1024)))) return { type, kind: "junit" };
  if (type.startsWith("text/html")) return { type, kind: "html" };
  if (type.startsWith("text/plain")) return { type, kind: "log" };
  return { type, kind: "file" };
}

/** A file's name as kept: its last path part, with anything but letters, digits, dots, dashes, underscores, spaces,
 *  brackets and plus signs made a dash, at most 120 characters. Never a path. */
export function safeName(name: string): string {
  const base = basename(String(name).replace(/\\/g, "/")).replace(/[^\w .()+-]/g, "-").replace(/^[.\s]+/, "").trim().slice(0, 120);
  return base || "file";
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{64}$/;
const HEAD = /^[0-9a-f]{7,64}$/;
export const ATTACHMENT_ID = /^[0-9a-f]{12}$/;
const SIGNOFF = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** The project's repo as the keys name it (owner/name, lower case); refused when it isn't one. */
export function repoKey(repo: string | null | undefined): string {
  const r = String(repo ?? "").trim().toLowerCase();
  if (!REPO.test(r)) {
    refuse("bad-input", "Attachments need the project's GitHub repo (owner/name), and none is known here.",
      "Run it in the project's checkout (its origin remote names the repo), or set GH_REPO=owner/name.");
  }
  return r;
}

/** The target as typed (`pr 12`, `task #12`, `task b3`, `signoff login-flow`), checked; refused with the fix. */
export function targetOf(kind: string, id: string): Target {
  const k = String(kind).trim().toLowerCase();
  const v = String(id).trim();
  if (!(TARGET_KINDS as readonly string[]).includes(k)) {
    refuse("bad-input", `${JSON.stringify(kind)} isn't something a file can be attached to.`, "Attach to a task, a pr, a signoff item or an epic.");
  }
  if (k === "pr") {
    const m = /^#?([1-9]\d{0,9})$/.exec(v);
    if (!m) refuse("bad-input", `${JSON.stringify(id)} isn't a pull request's number.`, "Give its number, like 12.");
    return { kind: "pr", id: m[1] as string };
  }
  if (k === "signoff") {
    if (!SIGNOFF.test(v)) refuse("bad-input", `${JSON.stringify(id)} isn't a sign-off item's id.`, "Give the item's id, like login-flow-2 (`factory signoff ls`).");
    return { kind: "signoff", id: v };
  }
  const m = /^(?:#?([1-9]\d{0,9})|[bB]([1-9]\d{0,9}))$/.exec(v);
  if (!m) refuse("bad-input", `${JSON.stringify(id)} isn't a task's number.`, "Give 12 or #12 for issue 12, b3 for a task made on the board.");
  return { kind: k as TargetKind, id: m[1] ? (m[1] as string) : `b${m[2]}` };
}

function prefixOf(repo: string, target?: Target): string {
  return target ? `attachment:${repo}:${target.kind}:${target.id}:` : `attachment:${repo}:`;
}

function bytesKey(repo: string, sha: string): string {
  return `attachment-bytes:${repo}:${sha}`;
}

/** The hub's store: <settings>/message-board/attachments. */
export function storeDir(): string {
  return join(boardDir(), "attachments");
}

/** Whether this machine is the hub: it runs the board (`factory board up` wrote its state.json). */
export function isHub(): boolean {
  return existsSync(join(boardDir(), "state.json"));
}

/** Where the store keeps a file of project `repo` with this hash. */
export function storePath(repo: string, sha: string): string {
  if (!SHA.test(sha)) refuse("bad-input", "That isn't a file's SHA-256.", "Use the sha256 an attachment's listing gives.");
  return join(storeDir(), repo.replace("/", "__"), sha.slice(0, 2), sha);
}

function writeStore(repo: string, sha: string, bytes: Uint8Array): void {
  const path = storePath(repo, sha);
  try {
    // already kept: made fresh, so a prune running now leaves it for this attach
    const now = new Date();
    utimesSync(path, now, now);
    return;
  } catch {
    // not there (or gone just now, under a prune): write it
  }
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    chmodSync(tmp, 0o600); // only the user that serves the web UI reads it
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function isAttachment(v: unknown): v is Attachment {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.id === "string" && ATTACHMENT_ID.test(a.id) && typeof a.sha256 === "string" && SHA.test(a.sha256) &&
    typeof a.name === "string" && typeof a.size === "number" && typeof a.at === "string" && typeof a.target === "object" && a.target !== null;
}

/** The project's attachments (on one target, or all), oldest first, leaving out those past the retention. */
export async function listAttachments(board: Board, repo: string, target?: Target, retentionDays = DEFAULT_LIMITS.retentionDays): Promise<Attachment[]> {
  const r = repoKey(repo);
  const since = Date.now() - retentionDays * 86_400_000;
  // an entry under this project's key must also say it is this project's: its bytes are found by the project it names
  return (await board.values(prefixOf(r, target))).map((x) => x.value).filter(isAttachment)
    .filter((a) => a.project === r && Date.parse(a.at) >= since).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** One attachment of the project by its id, or null. */
export async function attachmentById(board: Board, repo: string, id: string, retentionDays = DEFAULT_LIMITS.retentionDays): Promise<Attachment | null> {
  if (!ATTACHMENT_ID.test(id)) return null;
  return (await listAttachments(board, repo, undefined, retentionDays)).find((a) => a.id === id) ?? null;
}

/** A file's last change in ms, or now when it is gone (so a prune never trips on a file another removed). */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** How long a new file or new bytes are safe from a prune. */
const FRESH_MS = 10 * 60_000;

/** Drops what is past the retention, the bytes on the board nothing points to, and on the hub the files nothing points
 *  to (older than FRESH_MS). Returns how many attachments it dropped. */
export async function pruneAttachments(board: Board, repo: string, retentionDays: number, hub = isHub()): Promise<number> {
  const r = repoKey(repo);
  const since = Date.now() - retentionDays * 86_400_000;
  let dropped = 0;
  const keep = new Set<string>();
  for (const row of await board.values(prefixOf(r))) {
    const a = row.value;
    if (!isAttachment(a) || Date.parse(a.at) < since) {
      if (await board.dropValue(row.key)) dropped++;
    } else keep.add(a.sha256);
  }
  // bytes and files written in the last minutes are left alone: an attach writes them just before its metadata
  const settled = Date.now() - FRESH_MS;
  for (const row of await board.values(`attachment-bytes:${r}:`)) {
    const sha = row.key.slice(`attachment-bytes:${r}:`.length);
    if (!keep.has(sha) && row.updatedAt.getTime() < settled) await board.dropValue(row.key);
  }
  if (hub) {
    const root = join(storeDir(), r.replace("/", "__"));
    for (const two of existsSync(root) ? readdirSync(root) : []) {
      for (const f of readdirSync(join(root, two))) {
        const path = join(root, two, f);
        if (!keep.has(f) && mtimeOf(path) < settled) rmSync(path, { force: true });
      }
    }
  }
  return dropped;
}

export interface NewFile {
  name: string;
  bytes: Uint8Array;
}

const FILE_FIX = "Attach a screenshot, report or log saved inside this checkout (for example tmp/design-check/home-phone.png), " +
  "never a secret, a file outside it, or a link to one.";

/** The checkout's top folder for `cwd` (its real path), or null outside a git checkout. */
export function checkoutRoot(cwd: string, projectDir = process.env.CLAUDE_PROJECT_DIR): { ok: true; root: string } | { ok: false; why: string } {
  // the folder the session runs in (Claude's project folder, else where it was started), never what git says alone:
  // an agent can write its worktree's .git file and point it at a git folder whose core.worktree is the home folder
  let root: string;
  try {
    root = realpathSync(projectDir || cwd);
  } catch {
    return { ok: false, why: `${projectDir || cwd} isn't there` };
  }
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const top = p.exitCode === 0 ? p.stdout.toString().trim() : "";
  let real = "";
  try {
    real = top ? realpathSync(top) : "";
  } catch {
    real = top;
  }
  if (!real) return { ok: false, why: `${root} isn't a git checkout` };
  if (real !== root) {
    return { ok: false, why: `git says the checkout is ${real}, which isn't the checkout this runs in (${root})` };
  }
  return { ok: true, root };
}

/** Why `path` (from `cwd`) may not be attached, or its real path and size. Only a regular file inside `root` (links
 *  followed to where they really point) may be, and never a .env file or anything in .git or .claude. Read by an agent's
 *  attach on its own machine, outside Claude's permission rules, so this is what keeps a secret off the hub (#637). */
export function confine(path: string, cwd: string, root: string): { ok: true; real: string; size: number; dev: number; ino: number } | { ok: false; why: string } {
  let real: string;
  try {
    // the folder's real path, then the file's own name, followed only when it is a link: so its size is known without
    // opening it
    const abs = resolve(cwd, path);
    const inDir = join(realpathSync(dirname(abs)), basename(abs));
    real = lstatSync(inDir).isSymbolicLink() ? realpathSync(inDir) : inDir;
  } catch {
    return { ok: false, why: "it isn't there" };
  }
  const rel = relative(root, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, why: "it is outside this checkout (a link is followed to where it points)" };
  const parts = rel.split(sep);
  if (parts.includes(".git") || parts.includes(".claude")) return { ok: false, why: "files in .git and .claude are never attached" };
  if (parts.some((x) => /^\.env/i.test(x))) return { ok: false, why: ".env files are never attached" };
  const st = statSync(real);
  if (!st.isFile()) return { ok: false, why: "it isn't a regular file" };
  if (st.nlink > 1) return { ok: false, why: "it is a hard link, which may be to a file outside this checkout" };
  return { ok: true, real, size: st.size, dev: st.dev, ino: st.ino };
}

/** The message for a file past the cap. */
export function tooBigMessage(name: string, size: number, limits: AttachLimits): string {
  return `${name} is ${mb(size)}; one file may be at most ${mb(limits.maxFileBytes)}.`;
}
export const TOO_BIG_FIX = "Make it smaller (a phone and a desktop screenshot, a shorter log), or raise attachments.maxFileMb in the project's settings.";

/** The files at `paths`, each checked (confine, then its size) before any is read; `refuse` says why one can't be. */
export function readConfined(paths: string[], cwd: string, limits: AttachLimits, refuseWith: (message: string, fix: string) => never): NewFile[] {
  const at = checkoutRoot(cwd);
  if (!at.ok) refuseWith(`Files can't be attached from here: ${at.why}.`, "Run it from the top folder of the project's checkout or the agent's worktree.");
  const root = at.root;
  const checked = paths.map((p) => {
    const c = confine(p, cwd, root);
    if (!c.ok) return refuseWith(`${p} can't be attached: ${c.why}.`, FILE_FIX);
    if (c.size > limits.maxFileBytes) return refuseWith(tooBigMessage(safeName(c.real), c.size, limits), TOO_BIG_FIX);
    return c;
  });
  return checked.map((c) => {
    // the file read is the one checked: opened, then its handle's device and inode compared, so nothing swapped in
    // between the check and the read is read
    const fd = openSync(c.real, "r");
    try {
      const now = fstatSync(fd);
      if (now.dev !== c.dev || now.ino !== c.ino || !now.isFile() || now.size > limits.maxFileBytes) {
        return refuseWith(`${c.real} changed between the check and the read.`, "Attach it again once nothing is writing it.");
      }
      return { name: c.real, bytes: new Uint8Array(readFileSync(fd)) };
    } finally {
      closeSync(fd);
    }
  });
}

export interface AttachInput {
  target: Target;
  /** For a pull request: its head commit (7 to 64 hex digits). */
  head?: string | null;
  files: NewFile[];
  note?: string;
}

function mb(n: number): string {
  return `${Math.round((n / MB) * 10) / 10} MB`;
}

/** Attach `input.files` to its target as the board's actor, within `limits`. Every file is checked before anything is
 *  written; a refusal writes nothing. Returns the new attachments. */
export async function attach(board: Board, repo: string, input: AttachInput, limits: AttachLimits = DEFAULT_LIMITS, hub = isHub()): Promise<Attachment[]> {
  const r = repoKey(repo);
  const target = targetOf(input.target?.kind ?? "", input.target?.id ?? "");
  const head = input.head ? String(input.head).trim().toLowerCase() : null;
  if (target.kind === "pr" && !head) refuse("bad-input", `An attachment to PR #${target.id} needs its head commit.`, "Pass the head commit's SHA (git rev-parse HEAD on the pushed branch).");
  if (head && !HEAD.test(head)) refuse("bad-input", `${JSON.stringify(input.head)} isn't a commit's SHA.`, "Pass the head commit's SHA, 7 to 40 hex digits.");
  if (!input.files.length) refuse("bad-input", "There is no file to attach.", "Name one or more files.");
  if (input.files.length > MAX_FILES) refuse("bad-input", `That is ${input.files.length} files; one attach takes at most ${MAX_FILES}.`, "Attach them in smaller groups.");
  const note = (input.note ?? "").trim();
  if (note.length > NOTE_MAX) refuse("bad-input", `The note is ${note.length} characters; the most is ${NOTE_MAX}.`, "Shorten the note.");
  await pruneAttachments(board, r, limits.retentionDays, hub);
  const files = input.files.map((f) => ({ name: safeName(f.name), bytes: f.bytes, sha: createHash("sha256").update(f.bytes).digest("hex") }));
  for (const f of files) {
    if (f.bytes.byteLength > limits.maxFileBytes) {
      refuse("bad-input", tooBigMessage(f.name, f.bytes.byteLength, limits), TOO_BIG_FIX);
    }
  }
  const kept = await listAttachments(board, r, undefined, limits.retentionDays);
  const sizes = new Map(kept.map((a) => [a.sha256, a.size]));
  for (const f of files) sizes.set(f.sha, f.bytes.byteLength);
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  if (total > limits.maxProjectBytes) {
    refuse("bad-input", `The project would keep ${mb(total)} of attachments; the most is ${mb(limits.maxProjectBytes)}.`,
      "Attach fewer or smaller files, wait for old ones to pass attachments.retentionDays, or raise attachments.maxProjectMb.");
  }
  const have = new Set(kept.map((a) => a.sha256));
  const at = new Date().toISOString();
  const out: Attachment[] = [];
  for (const f of files) {
    const { type, kind } = classify(f.name, f.bytes);
    if (hub) writeStore(r, f.sha, f.bytes);
    else if (!have.has(f.sha) && !existsSync(storePath(r, f.sha))) await board.setValue(bytesKey(r, f.sha), { base64: Buffer.from(f.bytes).toString("base64") });
    have.add(f.sha);
    const a: Attachment = { id: randomBytes(6).toString("hex"), project: r, target, head, name: f.name, type, kind,
      size: f.bytes.byteLength, sha256: f.sha, note, by: board.as, at };
    await board.setValue(`${prefixOf(r, target)}${a.id}`, a, [{ name: "attachment", payload: { project: r, target: `${target.kind}:${target.id}`, id: a.id } }]);
    out.push(a);
  }
  return out;
}

/** The bytes of an attachment: from this machine's store, else from the board (moved into the store when this is the
 *  hub). Null when neither has them (kept on another machine's store). */
export async function readBytes(board: Board, a: Attachment, hub = isHub()): Promise<Uint8Array | null> {
  const r = repoKey(a.project);
  const path = storePath(r, a.sha256);
  try {
    if (statSync(path).isFile()) return new Uint8Array(readFileSync(path));
  } catch {
    // not in this store (or gone just now): the board may still have it
  }
  const v = await board.value(bytesKey(r, a.sha256));
  const b64 = typeof v === "object" && v !== null ? (v as { base64?: unknown }).base64 : null;
  if (typeof b64 !== "string") return null;
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (createHash("sha256").update(bytes).digest("hex") !== a.sha256) return null;
  if (hub) {
    writeStore(r, a.sha256, bytes);
    await board.dropValue(bytesKey(r, a.sha256));
  }
  return bytes;
}
