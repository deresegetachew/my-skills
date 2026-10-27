#!/usr/bin/env -S bun --no-env-file
// The release client (#113): a project gets the software factory from numbered GitHub releases of my-skills.
//
//   factory version              installed release, the one main pins, the newest, and what changed since
//   factory releases [--all]     the releases that exist, with dates and a one-line note
//   factory update [version]     newest release (or the named one): download, check the checksum, install into the
//                                project, refresh this machine's runner services, verify. Leaves the change uncommitted.
//                                --tasks plan|issues on a first install: where the tasks come from (#245)
//   factory update --archive F [--sums S]
//                                the same from a release archive on disk (no network); only writes the archive's files
//   factory rollback             back to the release that was installed before (offline, from the download cache)
//   factory migrate-to-release   a project linked to the my-skills submodule: replace the links the release owns with the
//                                release's files, keep the links it does not ship, print the steps for the pull request
//
// The installed factory is committed in the project (decision in #113): hooks/ and ci/ go to .claude/hooks and
// .claude/ci, `factory` and `factory-loop.sh` to the project root, the agents, skills and settings.json to .claude/.
// `.claude/factory/release.json` is the pin: the release, its archive's SHA-256, the previous release and the hash of
// every installed file. Changing it is how the whole team ends up on one release.
//
// Bun and its built-ins only, so it also installs the first release into a project that has no factory yet:
//   bun --no-env-file <unpacked release>/hooks/factory_release.ts update
//
// Every error is `[code] message` and `Fix: ...`. Tests point FACTORY_RELEASE_API at a local fake of GitHub's API.
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { Exit, FactoryError, pyDumps, pyRepr, run, runMain, splitLines } from "./factory_lib.ts";
import { tarEntries } from "./factory_tar.ts";
import { fixWorkflows, lines as workflowLines } from "./factory_workflow.ts";

export { FactoryError };

export const DEFAULT_REPO = "deresegetachew/my-skills";
export const PIN_PATH = ".claude/factory/release.json";
export const PIN_SCHEMA = "factory-pin/1";
export const MANIFEST_SCHEMA = "factory-release/1";
export const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.]*))?$/;
const SUM_RE = /^([0-9a-fA-F]{64}) [ *](\S.*)$/;
const AGENT_ENV = ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"];
const MAX_MEMBERS = 5000;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const TEMPLATE_GITIGNORE = ["tmp/", "__pycache__/"];
const TIMEOUT_MS = 30_000;

type JsonObj = Record<string, unknown>;

export interface Release {
  tag: string;
  version: string;
  date: string;
  notes: string;
  pre: boolean;
  assets: Record<string, string>;
}

export interface PinRef {
  tag: string;
  version: string;
  sha256: string;
}

export interface Pin {
  schema: string;
  repo?: string;
  tag: string;
  version: string;
  sha256: string;
  source_commit?: string;
  previous?: PinRef | null;
  templates?: string[];
  executable?: string[];
  files: Record<string, string>;
}

function obj(v: unknown): JsonObj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObj) : null;
}

function errnoOf(e: unknown): string | null {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- versions and checksums ---------------------------------------------------------------------------------------

export function normalizeTag(text: string | null | undefined): string {
  let t = (text ?? "").trim();
  t = t.startsWith("v") ? t : "v" + t;
  if (!TAG_RE.test(t)) {
    throw new FactoryError("bad_version", `'${text}' is not a release like v1.4.0.`,
      "name a release as MAJOR.MINOR.PATCH, with or without the v (`factory releases` lists them).");
  }
  return t;
}

type SortKey = [number, number, number, number, string];

export function sortKey(tag: string): SortKey {
  const m = TAG_RE.exec(tag) as RegExpExecArray;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : 0, m[4] ?? ""];
}

/** <0, 0 or >0, as Python compares the sort keys (tuples). */
export function compareTags(a: string, b: string): number {
  const x = sortKey(a);
  const y = sortKey(b);
  for (let i = 0; i < x.length; i++) {
    const p = x[i] as number | string;
    const q = y[i] as number | string;
    if (p < q) return -1;
    if (p > q) return 1;
  }
  return 0;
}

export function versionOf(tag: string): string {
  return tag.slice(1);
}

export function checksumFor(text: string, name: string): string {
  const found: Record<string, string> = {};
  for (const line of splitLines(text)) {
    const m = SUM_RE.exec(line.replace(/^\r+|\r+$/g, ""));
    if (m) found[m[2] as string] = (m[1] as string).toLowerCase();
  }
  if (!Object.keys(found).length) {
    throw new FactoryError("bad_checksum", "SHA256SUMS has no readable checksum line.",
      "do not install this release; tell the owner, who can cut it again.");
  }
  if (!(name in found)) {
    throw new FactoryError("bad_checksum", `SHA256SUMS has no checksum for ${name}.`,
      "do not install this release; tell the owner, who can cut it again.");
  }
  return found[name] as string;
}

export function sha256Bytes(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

// --- GitHub: the list of releases and the downloads --------------------------------------------------------------

function apiBase(): string {
  return (process.env.FACTORY_RELEASE_API || "https://api.github.com").replace(/\/+$/, "");
}

function token(): string {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

function noNetwork(reason: string): FactoryError {
  return new FactoryError("no_network", `could not reach GitHub (${reason}).`,
    "check the connection and run it again. `factory rollback`, and `factory update <version>` for a release " +
    "this machine already downloaded, need no network.");
}

/** GET `url`, following redirects by hand: a redirect to another host (GitHub's file storage) must not carry the
 * token along. The headers are back within 30 seconds or the request fails. */
async function openUrl(url: string, accept: string): Promise<Response> {
  let current = url;
  let auth = token();
  for (let hop = 0; hop < 10; hop++) {
    const headers: Record<string, string> = { Accept: accept, "User-Agent": "software-factory-client" };
    if (auth) headers.Authorization = "Bearer " + auth;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(current, { headers, redirect: "manual", signal: ctl.signal });
    } catch (e) {
      throw noNetwork(ctl.signal.aborted ? "timed out" : errText(e));
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get("location")) {
      const next = new URL(r.headers.get("location") as string, current).toString();
      if (new URL(next).host !== new URL(current).host) auth = "";
      await r.body?.cancel();
      current = next;
      continue;
    }
    if (r.status >= 400) {
      await r.body?.cancel();
      if ((r.status === 403 || r.status === 429) && r.headers.get("x-ratelimit-remaining") === "0") {
        throw new FactoryError("rate_limited", "GitHub is limiting requests from this machine.",
          "wait a few minutes, or set GH_TOKEN (for example `export GH_TOKEN=$(gh auth token)`) and try again.");
      }
      throw new FactoryError("http_error", `GitHub answered ${r.status} for ${url}.`,
        "check the repository name (release.repo in .claude/factory.json) and try again.");
    }
    return r;
  }
  throw new FactoryError("http_error", `GitHub redirected too many times for ${url}.`, "try again in a minute.");
}

/** Published releases that carry a version tag, newest first (a draft is invisible to everyone but the owner). */
export async function listReleases(repo: string): Promise<Release[]> {
  const out: Release[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await openUrl(`${apiBase()}/repos/${repo}/releases?per_page=100&page=${page}`, "application/vnd.github+json");
    let batch: unknown;
    try {
      batch = JSON.parse(await r.text());
    } catch {
      batch = null;
    }
    if (!Array.isArray(batch)) throw new FactoryError("http_error", "GitHub's answer was not a list of releases.", "try again in a minute.");
    for (const raw of batch) {
      const item = obj(raw) ?? {};
      const tag = typeof item.tag_name === "string" ? item.tag_name : "";
      if (item.draft || !TAG_RE.test(tag)) continue;
      const assets: Record<string, string> = {};
      for (const a of Array.isArray(item.assets) ? item.assets : []) {
        const asset = obj(a);
        if (asset && typeof asset.name === "string") assets[asset.name] = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
      }
      out.push({
        tag, version: versionOf(tag), date: (typeof item.published_at === "string" ? item.published_at : "").slice(0, 10),
        notes: typeof item.body === "string" ? item.body : "", pre: Boolean(item.prerelease), assets,
      });
    }
    if (batch.length < 100) break;
  }
  return out.sort((a, b) => compareTags(b.tag, a.tag));
}

export function newest(releases: Release[]): Release {
  const full = releases.filter((r) => !r.pre);
  if (!full.length) {
    const pre = releases.find((r) => r.pre)?.tag;
    if (pre) {
      throw new FactoryError("no_releases", `there is no full release yet, only the pre-release ${pre} (pre-releases are only used when named).`,
        `install the pre-release by naming it: \`factory update ${pre}\`.`);
    }
    throw new FactoryError("no_releases", "there is no published release yet (pre-releases are only used when named).",
      "ask the owner to cut one, or name a pre-release: `factory update v1.0.0-rc.1`.");
  }
  return full[0] as Release;
}

export function findRelease(releases: Release[], tag: string): Release {
  const r = releases.find((x) => x.tag === tag);
  if (r) return r;
  const have = releases.slice(0, 8).map((x) => x.tag).join(", ") || "none";
  throw new FactoryError("no_such_release", `there is no release ${tag}.`, `pick one that exists (${have}); \`factory releases\` lists them.`);
}

export function noteLine(notes: string): string {
  const lines = splitLines(notes).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) if (l.startsWith("- ")) return l.slice(2);
  return lines[0] ?? "";
}

export function noteBullets(notes: string): string[] {
  return splitLines(notes).filter((l) => l.trim().startsWith("- ")).map((l) => l.trim().slice(2));
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Stream `url` to `dest` through a .part file; a short or failed transfer leaves nothing behind. */
async function download(url: string, dest: string): Promise<void> {
  const part = dest + ".part";
  try {
    const r = await openUrl(url, "application/octet-stream");
    const want = r.headers.get("content-length");
    let got = 0;
    const fd = openSync(part, "w");
    try {
      if (r.body) {
        const reader = r.body.getReader();
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS);
              }),
            ]);
          } catch (e) {
            await reader.cancel().catch(() => undefined);
            throw new FactoryError("download_interrupted", `the download stopped part way (${errText(e)}).`, "run the command again.");
          } finally {
            clearTimeout(timer);
          }
          if (chunk.done) break;
          writeSync(fd, chunk.value);
          got += chunk.value.length;
        }
      }
    } finally {
      closeSync(fd);
    }
    if (want !== null && got !== Number(want)) {
      throw new FactoryError("download_interrupted", `the download stopped part way (${got} of ${want} bytes).`, "run the command again.");
    }
    renameSync(part, dest);
  } catch (e) {
    remove(part);
    if (e instanceof FactoryError) throw e;
    throw new FactoryError("download_interrupted", `the download could not be saved (${errText(e)}).`, "check the disk space and run the command again.");
  }
}

export function cacheFolder(repo: string, tag: string): string {
  const base = process.env.FACTORY_CACHE_DIR ||
    join(process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), ".cache"), "software-factory");
  return join(base, repo.replace(/\//g, "__"), tag);
}

export function archiveName(tag: string): string {
  return `software-factory-${versionOf(tag)}.tar.gz`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The downloaded archive when it is there and its checksum holds, else null. A cache that disagrees with the pin's
 * recorded checksum is an error, never silently replaced. */
function cachedArchive(folder: string, tag: string, expectSha: string | null): string | null {
  const name = archiveName(tag);
  const path = join(folder, name);
  const sums = join(folder, "SHA256SUMS");
  if (!(isFile(path) && isFile(sums))) return null;
  let want: string | null;
  try {
    want = checksumFor(readFileSync(sums, "utf8"), name);
  } catch {
    want = null;
  }
  const have = sha256File(path);
  if (want === null || have !== want) {
    rmSync(folder, { recursive: true, force: true }); // a damaged cache: download it again
    return null;
  }
  if (expectSha && have !== expectSha) {
    throw new FactoryError("bad_checksum", `the downloaded ${name} does not match the checksum this project's pin records for ${tag}.`,
      `delete ${folder} and try again; if it repeats, do not install and tell the owner.`);
  }
  return path;
}

/** [path of the verified archive, release or null]. Uses the download cache when it holds the release. */
async function fetchArchive(repo: string, tag: string, release: Release | null, expectSha: string | null): Promise<[string, Release | null]> {
  const folder = cacheFolder(repo, tag);
  const hit = cachedArchive(folder, tag, expectSha);
  if (hit) return [hit, release];
  const rel = release ?? findRelease(await listReleases(repo), tag);
  const name = archiveName(tag);
  for (const need of [name, "SHA256SUMS"]) {
    if (!rel.assets[need]) {
      throw new FactoryError("incomplete_release", `release ${tag} has no ${need}.`,
        "do not install it; tell the owner, who can fix or cut the release again.");
    }
  }
  mkdirSync(folder, { recursive: true });
  const sumsPath = join(folder, "SHA256SUMS");
  const archivePath = join(folder, name);
  try {
    await download(rel.assets.SHA256SUMS as string, sumsPath + ".new");
    await download(rel.assets[name] as string, archivePath + ".new");
    const want = checksumFor(readFileSync(sumsPath + ".new", "utf8"), name);
    const have = sha256File(archivePath + ".new");
    if (have !== want) {
      throw new FactoryError("bad_checksum", `the downloaded ${name} (${tag}) has checksum ${have.slice(0, 12)}..., SHA256SUMS says ${want.slice(0, 12)}...`,
        "the download is damaged or was changed. Nothing was installed. Run it again; if it repeats, tell the owner.");
    }
    if (expectSha && have !== expectSha) {
      throw new FactoryError("bad_checksum", `${name} does not match the checksum this project's pin records for ${tag}.`, "do not install it; tell the owner.");
    }
    renameSync(sumsPath + ".new", sumsPath);
    renameSync(archivePath + ".new", archivePath);
  } catch (e) {
    remove(sumsPath + ".new");
    remove(archivePath + ".new");
    try {
      rmdirSync(folder);
    } catch {
      // not empty: an earlier download is kept
    }
    throw e;
  }
  return [archivePath, rel];
}

const ARCHIVE_NAME = /^software-factory-(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?)\.tar\.gz$/;

/** [tag, path] of a release archive given as a file (#175), after the same checksum check a download gets: the
 * SHA256SUMS file (default: the one beside the archive) must list the archive's name with its digest. Reads files only. */
export function localArchive(archive: string, sums: string | null, version: string | null): [string, string] {
  const name = basename(archive);
  if (!isFile(archive)) {
    throw new FactoryError("missing_file", `the archive ${archive} does not exist.`,
      "give the real file: `factory update --archive <software-factory-X.tar.gz> --sums <SHA256SUMS>`.");
  }
  const m = ARCHIVE_NAME.exec(name);
  if (!m) {
    throw new FactoryError("bad_archive_name", `'${name}' is not named like a release archive.`,
      "name it software-factory-MAJOR.MINOR.PATCH.tar.gz, as the release's asset is; the version is read from the name.");
  }
  const tag = "v" + m[1];
  if (version && normalizeTag(version) !== tag) {
    throw new FactoryError("version_mismatch", `you asked for ${normalizeTag(version)}, but the archive is ${tag}.`,
      "leave the version out (it is read from the archive's name) or give the archive of that version.");
  }
  const sumsPath = sums || join(dirname(resolve(archive)), "SHA256SUMS");
  for (const [path, what] of [[archive, "the archive"], [sumsPath, "the SHA256SUMS file"]] as const) {
    if (!isFile(path)) {
      throw new FactoryError("missing_file", `${what} ${path} does not exist.`,
        "give the real files: `factory update --archive <software-factory-X.tar.gz> --sums <SHA256SUMS>` " +
        "(SHA256SUMS is looked for beside the archive when --sums is left out).");
    }
  }
  let text: string;
  try {
    text = readFileSync(sumsPath, "utf8");
  } catch (e) {
    throw new FactoryError("missing_file", `${sumsPath} cannot be read (${errText(e)}).`, "check the file and its permissions.");
  }
  const want = checksumFor(text, name);
  const have = sha256File(archive);
  if (have !== want) {
    throw new FactoryError("bad_checksum", `${name} has checksum ${have.slice(0, 12)}..., ${basename(sumsPath)} says ${want.slice(0, 12)}...`,
      "the archive is damaged or was changed. Nothing was installed. Get the files again from the release; if it repeats, tell the owner.");
  }
  return [tag, archive];
}

// --- unpacking: nothing leaves the archive's own folder ------------------------------------------------------------

export type Files = Map<string, [Uint8Array, number]>;

export interface Manifest {
  schema?: unknown;
  version?: unknown;
  source_commit?: unknown;
  files: { path: string; sha256?: unknown }[];
}

function unsafe(message: string): FactoryError {
  return new FactoryError("unsafe_archive", message, "do not install it; tell the owner.");
}

/** The files of a release archive ({relative path: [bytes, mode]}), after checking every member and the manifest. */
export function unpack(path: string, tag: string): [Files, Manifest] {
  const version = versionOf(tag);
  const top = `software-factory-${version}`;
  const files: Files = new Map();
  let total = 0;
  try {
    let count = 0;
    for (const m of tarEntries(new Uint8Array(gunzipSync(readFileSync(path))))) {
      if (count++ >= MAX_MEMBERS) throw unsafe(`the archive has more than ${MAX_MEMBERS} entries.`);
      const name = m.name;
      const parts = name.split("/");
      if (name.startsWith("/") || name.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) {
        throw unsafe(`the archive holds the path '${name}', which could leave its folder.`);
      }
      if (parts[0] !== top) throw unsafe(`'${name}' is outside the folder ${top}/.`);
      if (m.kind === "dir") continue;
      if (m.kind !== "file") throw unsafe(`'${name}' is a link or special file; a release holds only plain files.`);
      if (m.size > MAX_FILE || total + m.size > MAX_TOTAL) throw unsafe(`'${name}' makes the archive larger than the limit.`);
      const rel = name.slice(top.length + 1);
      if (files.has(rel)) throw unsafe(`'${name}' appears twice.`);
      total += m.data.length;
      files.set(rel, [new Uint8Array(m.data), m.mode & 0o111 ? 0o755 : 0o644]);
    }
  } catch (e) {
    if (e instanceof FactoryError) throw e;
    throw new FactoryError("bad_archive", `the archive cannot be read (${errText(e)}).`, "do not install it; tell the owner, who can cut it again.");
  }
  return [files, readManifest(files, version)];
}

function pyList(items: string[]): string {
  return "[" + items.map(pyRepr).join(", ") + "]";
}

function badArchive(message: string): FactoryError {
  return new FactoryError("bad_archive", message, "do not install it; tell the owner.");
}

export function readManifest(files: Files, version: string): Manifest {
  const entry = files.get("MANIFEST.json");
  if (!entry) throw badArchive("the archive has no MANIFEST.json.");
  let manifest: JsonObj;
  const listed = new Map<string, JsonObj>();
  try {
    manifest = obj(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry[0]))) as JsonObj;
    if (!manifest || !Array.isArray(manifest.files)) throw new Error("no files");
    for (const f of manifest.files) {
      const o = obj(f);
      if (!o || !("path" in o)) throw new Error("no path");
      listed.set(String(o.path), o);
    }
  } catch {
    throw badArchive("MANIFEST.json cannot be read.");
  }
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.version !== version) {
    const show = (v: unknown): string => (v === undefined || v === null ? "None" : String(v));
    throw badArchive(`MANIFEST.json is for ${show(manifest.schema)} ${show(manifest.version)}, not ${MANIFEST_SCHEMA} ${version}.`);
  }
  const present = new Set([...files.keys()].filter((k) => k !== "MANIFEST.json"));
  const extra = [...present].filter((p) => !listed.has(p)).sort();
  const missing = [...listed.keys()].filter((p) => !present.has(p)).sort();
  if (extra.length || missing.length) {
    throw badArchive(`the files do not match MANIFEST.json (not listed: ${pyList(extra.slice(0, 3))}, missing: ${pyList(missing.slice(0, 3))}).`);
  }
  for (const [rel, e] of listed) {
    if (sha256Bytes((files.get(rel) as [Uint8Array, number])[0]) !== e.sha256) throw badArchive(`${rel} does not match the checksum in MANIFEST.json.`);
  }
  return manifest as unknown as Manifest;
}

// --- what goes where in a project --------------------------------------------------------------------------------------

/** ["engine", target] for what the factory owns in a project, ["template", target] for what a project fills in and is
 * only given on a first install, null for what is not installed (docs, the installer, the kit/ forwarders). */
export function classify(rel: string): ["engine" | "template", string] | null {
  if (rel === "factory" || rel === "factory-loop.sh") return ["engine", rel];
  for (const [src, dst] of [["hooks/", ".claude/hooks/"], ["ci/", ".claude/ci/"]] as const) {
    if (rel.startsWith(src)) return ["engine", dst + rel.slice(src.length)];
  }
  if (rel.startsWith("kit/.claude/")) {
    const sub = rel.slice("kit/.claude/".length);
    if (sub.startsWith("hooks/") || sub.startsWith("ci/")) return null; // the forwarders to the folders above
    if (sub.startsWith("agents/") || sub.startsWith("skills/") || sub === "settings.json" || sub === "manager/settings.json") {
      return ["engine", ".claude/" + sub];
    }
    return ["template", ".claude/" + sub];
  }
  if (rel === "kit/factory" || rel === "kit/factory-loop.sh") return null;
  if (rel.endsWith(".yml.template")) return null; // a CI template install.sh chooses from (ci-python.yml.template), not a workflow to install
  if (rel.startsWith("kit/")) return ["template", rel.slice("kit/".length)];
  return null;
}

export function plan(files: Files): [Map<string, string>, Map<string, string>] {
  const engine = new Map<string, string>();
  const templates = new Map<string, string>();
  for (const rel of [...files.keys()].sort()) {
    const c = classify(rel);
    if (c) (c[0] === "engine" ? engine : templates).set(c[1], rel);
  }
  return [engine, templates];
}

// --- the project ---------------------------------------------------------------------------------------------------------

function git(root: string, args: string[], check = true): { code: number; stdout: string; stderr: string } {
  const p = run(["git", "-C", root, ...args]);
  if (check && p.code) {
    throw new FactoryError("git_failed", `git ${args.join(" ")} failed: ${p.stderr.trim()}`, "run this inside the project's git repository.");
  }
  return p;
}

export function projectRoot(): string {
  const p = run(["git", "rev-parse", "--show-toplevel"]);
  if (p.code) throw new FactoryError("not_a_repo", "this is not inside a git repository.", "run it inside the project's folder.");
  return p.stdout.trim();
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new FactoryError("bad_pin", `${path} is not valid JSON (${errText(e)}).`,
      "restore it from git (`git checkout -- " + basename(path) + "`) or delete it and name a release.");
  }
}

export function readPin(root: string): Pin | null {
  const raw = readJsonFile(join(root, PIN_PATH));
  if (raw === null) return null;
  const pin = obj(raw);
  if (!pin || pin.schema !== PIN_SCHEMA || !TAG_RE.test(String(pin.tag ?? "")) || !obj(pin.files)) {
    throw new FactoryError("bad_pin", `${PIN_PATH} is not a pin this client understands.`, "restore it from git, or run `factory update <version>` after deleting it.");
  }
  return pin as unknown as Pin;
}

function repoName(root: string, pin: Pin | null): string {
  if (process.env.FACTORY_RELEASE_REPO) return process.env.FACTORY_RELEASE_REPO;
  if (pin && pin.repo) return pin.repo;
  let cfg: JsonObj = {};
  try {
    cfg = obj(readJsonFile(join(root, ".claude", "factory.json"))) ?? {};
  } catch (e) {
    if (!(e instanceof FactoryError)) throw e;
  }
  const rel = obj(cfg.release);
  const repo = rel && typeof rel.repo === "string" ? rel.repo : "";
  return repo || DEFAULT_REPO;
}

/** my-skills builds itself with its own factory: the real files are in software-factory/, and the releases come from
 * here, so a release must never be pulled over them (#162). */
export function refuseFactoryRepo(root: string): void {
  const builder = isFile(join(root, "tools", "build_release.ts")) || isFile(join(root, "tools", "build_release.py"));
  if (isFile(join(root, "software-factory", "VERSION")) && builder) {
    throw new FactoryError("factory_repo", "this is the factory's own repository, where the releases come from.",
      "edit the real files in software-factory/ (never through the .claude links), then cut a release " +
      "with tools/build_release.ts. Nothing was changed.");
  }
}

function refuseAgent(): void {
  for (const v of AGENT_ENV) {
    if (v in process.env) {
      throw new FactoryError("agent_session", "an agent session cannot change the factory (the PR gate reads these files).",
        "run `factory update` yourself in a terminal, then commit it in a pull request.");
    }
  }
}

function dirtyPaths(root: string): string[] {
  const out = git(root, ["status", "--porcelain", "--untracked-files=all"]).stdout;
  return splitLines(out).map((line) => {
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ")[1] as string;
    return path.replace(/^"+|"+$/g, "");
  });
}

function isSymlinked(root: string, rel: string): boolean {
  let cur = root;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    if (isLink(cur)) return true;
  }
  return false;
}

const SETTINGS_REL = ".claude/settings.json";

/** The allow entries the project adds in .claude/factory.json (`permissions.allow`, #198). The release owns
 * settings.json, so these are merged in when it is installed instead of being typed into it by hand. */
export function projectAllow(root: string): string[] {
  const cfg = obj(readJsonFile(join(root, ".claude", "factory.json"))) ?? {};
  const perms = obj(cfg.permissions);
  const allow = perms ? (perms.allow ?? []) : [];
  if (!Array.isArray(allow) || !allow.every((a) => typeof a === "string" && a.trim())) {
    throw new FactoryError("bad_allow_list", "`permissions.allow` in .claude/factory.json must be a list of rule strings, like \"Edit(tmp/**)\".",
      "fix that list (`factory settings help permissions.allow` shows an example), then run it again. Nothing was changed.");
  }
  return (allow as string[]).map((a) => a.trim());
}

/** The release's settings.json bytes with the project's allow entries added after the release's own (no repeats). */
export function withAllow(data: Uint8Array, extras: string[]): Uint8Array {
  if (!extras.length) return data;
  let doc: JsonObj | null;
  try {
    doc = obj(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
  } catch {
    return data; // verification reports a settings.json that is not JSON
  }
  if (!doc) return data;
  const perms = obj(doc.permissions) ?? (doc.permissions = {}) as JsonObj;
  const allow = (Array.isArray(perms.allow) ? perms.allow : (perms.allow = [])) as unknown[];
  const add = [...new Set(extras)].filter((e) => !allow.includes(e));
  if (!add.length) return data;
  allow.push(...add);
  return new TextEncoder().encode(pyDumps(doc, { indent: 2, ensureAscii: false }) + "\n");
}

/** Allow entries the project asks for that settings.json does not have yet (an update puts them there). */
function allowProblems(root: string): string[] {
  let extras: string[];
  let have: unknown[];
  try {
    extras = projectAllow(root);
    const doc = obj(JSON.parse(readFileSync(join(root, SETTINGS_REL), "utf8")));
    const perms = doc ? obj(doc.permissions ?? {}) : null;
    if (!doc || !perms) return [];
    have = Array.isArray(perms.allow) ? perms.allow : [];
  } catch {
    return [];
  }
  return extras.filter((e) => !have.includes(e)).map((e) => `${e} is in permissions.allow in .claude/factory.json but not in ${SETTINGS_REL}`);
}

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Why the files on disk are not what the pin says: missing, changed, or not executable. Empty when they match.
 * The pin's hash of settings.json is of the release's own part plus the project's allow entries, so those entries
 * are not drift; an entry in factory.json that settings.json lacks is. */
export function pinnedProblems(root: string, pin: Pin): string[] {
  const bad = allowProblems(root);
  for (const [rel, sha] of Object.entries(pin.files).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const path = join(root, rel);
    if (!isFile(path)) bad.push(`${rel} is missing`);
    else if (sha256File(path) !== sha) bad.push(`${rel} differs from ${pin.tag}`);
    else if ((pin.executable ?? []).includes(rel) && !isExecutable(path)) bad.push(`${rel} is not executable`);
  }
  return bad;
}

function writeFile(path: string, data: Uint8Array, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), "." + basename(path) + ".factory-tmp");
  writeFileSync(tmp, data);
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

const PYTHON_CI_TEMPLATE = "kit/.github/workflows/ci-python.yml.template";
const PYTHON_CI_TARGET = ".github/workflows/ci.yml";

type StackModule = typeof import("./factory_stack.ts");
type Found = import("./factory_stack.ts").Found;

/** The stack detector beside this client (never code from the archive: a release is only written, not run, until a
 * person has reviewed the pull request). On a first install the client runs from the checksum-checked archive, so
 * the file is next to it; later it is the project's own reviewed copy. null when it is missing. */
async function stackModule(): Promise<StackModule | null> {
  const path = join(import.meta.dir, "factory_stack.ts");
  if (!isFile(path)) return null;
  return (await import(path)) as StackModule;
}

const NO_DETECTOR: Found = { stack: "unknown", reason: "no detector beside the release client", commands: {}, notes: [] };
const UNKNOWN_LINES = ["Stack: could not tell (no package.json, no Python files). CI keeps the pnpm template.",
  "Note: edit .github/workflows/ci.yml and the commands in .claude/factory.json to match your project."];

async function stackLines(found: Found): Promise<string[]> {
  const mod = await stackModule();
  return mod ? mod.lines(found) : UNKNOWN_LINES;
}

export const TASK_SOURCES = ["plan", "issues"];

/** `--tasks` is plan or issues (#245); anything else is refused before any work is done. */
function checkTasks(value: string | null): void {
  if (value !== null && !TASK_SOURCES.includes(value)) {
    throw new FactoryError("bad_tasks", `--tasks takes plan or issues, not '${value}'.`,
      "use `--tasks plan` (the build plan, docs/build-plan.md) or `--tasks issues` (GitHub issues). Nothing was changed.");
  }
}

/** factory.json's text with tasks.source set (the install's own change, written once, on a first install). */
function withTasks(data: Uint8Array, value: string): Uint8Array {
  const cfg = JSON.parse(new TextDecoder().decode(data)) as JsonObj;
  const tasks = obj(cfg.tasks) ?? (cfg.tasks = {}) as JsonObj;
  tasks.source = value;
  return new TextEncoder().encode(pyDumps(cfg, { indent: 2, ensureAscii: false }) + "\n");
}

/** What a first install says about where the tasks come from. */
function tasksLines(value: string | null): string[] {
  if (value === "issues") {
    return ["Tasks: from GitHub issues (tasks.source is issues in .claude/factory.json). Next: run `factory issues setup` to make the " +
      "labels. The install does not run it, because it writes to GitHub."];
  }
  if (value === "plan") {
    return ["Tasks: from the build plan (docs/build-plan.md; tasks.source is plan). For GitHub issues, run `factory settings set " +
      "tasks.source issues`, then `factory issues setup` for the labels."];
  }
  return ["Tasks: from the build plan (docs/build-plan.md). For GitHub issues: run again with --tasks issues, or " +
    "`factory settings set tasks.source issues`, then `factory issues setup` for the labels."];
}

export interface Installed {
  added: string[];
  changed: string[];
  removed: string[];
  kept_local: string[];
  unlinked: string[];
  stack?: Found;
}

type Backup = null | { link: string } | { data: Uint8Array; mode: number };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Write the release into the project. Returns {added, changed, removed, kept_local}; undoes its work on a failure.
 * With `migrate`, a file that is a link into the my-skills submodule is replaced by the release's file (the link is put
 * back on a failure); any other link, and a link in a parent folder, still refuses. */
export async function installFiles(root: string, files: Files, manifest: Manifest, tag: string, archiveSha: string,
  oldPin: Pin | null, repo: string, migrate = false, tasks: string | null = null): Promise<Installed> {
  const [engine, templates] = plan(files);
  const targets = [...engine.keys()].sort();
  for (const target of targets) {
    if (migrate && isLink(join(root, target)) && !isSymlinked(root, dirname(target)) && intoSubmodule(root, target)) continue;
    if (isSymlinked(root, target)) {
      throw new FactoryError("linked_install", `${target} is a link (this project takes the factory from the my-skills submodule).`,
        "a release does not overwrite links. Move this project off the submodule first (the migration is a separate reviewed pull request); " +
        "until then keep using `factory update`.");
    }
  }
  const first = !lexists(join(root, ".claude", "factory.json"));
  const extras = projectAllow(root);
  const merged = new Map<string, Uint8Array>();
  const oldFiles = oldPin?.files ?? {};
  const backups = new Map<string, Backup>();
  const writtenTemplates: string[] = [];
  const result: Installed = { added: [], changed: [], removed: [], kept_local: [], unlinked: [] };
  // A first install detects the stack before writing settings.json, so the allow rules the detected test command needs
  // (written to factory.json's permissions.allow, #249) are merged into settings.json in the same install.
  const mod = first ? await stackModule() : null;
  const found = first ? (mod ? mod.detect(root) : NO_DETECTOR) : null;
  if (found && mod && found.stack === "python") extras.push(...mod.allowRules(found));

  const remember = (path: string): void => {
    if (backups.has(path)) return;
    if (isLink(path)) backups.set(path, { link: readlinkSync(path) });
    else if (lexists(path)) backups.set(path, { data: new Uint8Array(readFileSync(path)), mode: statSync(path).mode & 0o7777 });
    else backups.set(path, null);
  };

  try {
    for (const target of targets) {
      let [data, mode] = files.get(engine.get(target) as string) as [Uint8Array, number];
      if (target === SETTINGS_REL) {
        data = withAllow(data, extras);
        merged.set(target, data);
      }
      const path = join(root, target);
      if (migrate && isLink(path)) {
        remember(path);
        unlinkSync(path); // the link goes; the submodule's file is never written through
        result.unlinked.push(target);
      }
      const exists = isFile(path);
      const current = exists ? new Uint8Array(readFileSync(path)) : null;
      if (current && sameBytes(current, data) && isExecutable(path) === Boolean(mode & 0o111)) continue;
      if (current && oldFiles[target] && sha256Bytes(current) !== oldFiles[target]) {
        result.kept_local.push(target); // replaced; reported so the reviewer sees it in the diff
      }
      remember(path);
      writeFile(path, data, mode);
      (exists ? result.changed : result.added).push(target);
    }
    for (const target of Object.keys(oldFiles).filter((t) => !engine.has(t)).sort()) {
      const path = join(root, target);
      if (isFile(path) && !isSymlinked(root, target)) {
        remember(path);
        unlinkSync(path);
        result.removed.push(target);
        let folder = dirname(path);
        while (folder !== root && readdirSync(folder).length === 0) {
          rmdirSync(folder);
          folder = dirname(folder);
        }
      }
    }
    if (first && found) {
      result.stack = found;
      for (const target of [...templates.keys()].sort()) {
        let [data, mode] = files.get(templates.get(target) as string) as [Uint8Array, number];
        const path = join(root, target);
        if (found.stack === "python" && target === PYTHON_CI_TARGET && files.has(PYTHON_CI_TEMPLATE)) {
          data = (files.get(PYTHON_CI_TEMPLATE) as [Uint8Array, number])[0]; // the Python workflow stands in for the pnpm one
        } else if (target === ".claude/factory.json" && found.stack === "python" && mod) {
          data = new TextEncoder().encode(mod.commandsText(new TextDecoder().decode(data), found));
        }
        if (target === ".claude/factory.json" && tasks) data = withTasks(data, tasks);
        if (target === ".gitignore") {
          remember(path);
          const have = isFile(path) ? readFileSync(path, "utf8") : "";
          const lines = have.split(/\s+/).filter(Boolean);
          const add = [...new TextDecoder().decode(data).split(/\s+/).filter(Boolean), ...TEMPLATE_GITIGNORE].filter((l) => !lines.includes(l));
          if (add.length) {
            const text = have + (!have || have.endsWith("\n") ? "" : "\n") + [...new Set(add)].join("\n") + "\n";
            writeFile(path, new TextEncoder().encode(text), 0o644);
            writtenTemplates.push(target);
          }
        } else if (!lexists(path)) {
          remember(path);
          writeFile(path, data, mode);
          result.added.push(target);
          writtenTemplates.push(target);
        }
      }
    }
    const pin: Pin = {
      schema: PIN_SCHEMA, repo, tag, version: versionOf(tag), sha256: archiveSha,
      source_commit: typeof manifest.source_commit === "string" ? manifest.source_commit : "",
      previous: oldPin && oldPin.tag !== tag ? { tag: oldPin.tag, version: oldPin.version, sha256: oldPin.sha256 } : (oldPin?.previous ?? null),
      templates: [...new Set([...(oldPin?.templates ?? []), ...writtenTemplates])].sort(),
      executable: targets.filter((t) => ((files.get(engine.get(t) as string) as [Uint8Array, number])[1] & 0o111) !== 0),
      files: Object.fromEntries(targets.map((t) => [t, sha256Bytes(merged.get(t) ?? (files.get(engine.get(t) as string) as [Uint8Array, number])[0])])),
    };
    const pinPath = join(root, PIN_PATH);
    remember(pinPath);
    writeFile(pinPath, new TextEncoder().encode(pyDumps(pin, { indent: 2, sortKeys: true }) + "\n"), 0o644);
  } catch (e) {
    for (const [path, saved] of backups) {
      try {
        if (saved === null) remove(path);
        else if ("link" in saved) {
          remove(path);
          mkdirSync(dirname(path), { recursive: true });
          symlinkSync(saved.link, path);
        } else writeFile(path, saved.data, saved.mode);
      } catch {
        // put back what can be put back
      }
    }
    if (!(e instanceof FactoryError) && !(e instanceof Exit) && errnoOf(e)) {
      throw new FactoryError("install_failed", `could not write the files (${errText(e)}); the project was put back as it was.`,
        "check the disk space and permissions, then run it again.");
    }
    throw e;
  }
  return result;
}

// --- this machine ----------------------------------------------------------------------------------------------------------

function runCi(root: string, args: string[], timeoutMs = 900_000): [number, string] {
  const p = run(["bash", join(root, ".claude", "ci", "ci.sh"), ...args], { cwd: root, timeoutMs });
  return [p.code, (p.stdout + p.stderr).trim()];
}

/** Restart the heartbeat daemon when it is installed here: it is one long-running process, so it keeps running the
 * code it started with until it is restarted. Says nothing when there is none. */
function refreshHeartbeat(root: string): string[] {
  const script = join(import.meta.dir, "factory_heartbeat_service.ts");
  if (!isFile(script)) return [];
  const p = run([process.execPath, "--no-env-file", script, "restart"], { cwd: root, timeoutMs: 120_000 });
  if (p.code !== 0) {
    const tail = splitLines((p.stdout + p.stderr).trim()).slice(-6).map((l) => "    " + l).join("\n");
    throw new FactoryError("services_failed", "restarting the heartbeat daemon failed:\n" + tail,
      "run `factory heartbeat install`, then `factory update` again.");
  }
  return splitLines(p.stdout).map((l) => l.trim()).filter(Boolean);
}

function refreshServices(root: string): string[] {
  return [...refreshRunners(root), ...refreshHeartbeat(root)];
}

/** Reinstall the CI runner services when this machine has some and they are older than the checkout. */
function refreshRunners(root: string): string[] {
  if (!isFile(join(root, ".claude", "ci", "ci.sh"))) return ["runner services: this release has none to refresh"];
  let [rc, out] = runCi(root, ["names"], 120_000);
  if (rc !== 0) return [`runner services: not checked here (${out ? splitLines(out)[0] : "ci.sh names failed"})`];
  [rc, out] = runCi(root, ["stale"]);
  if (rc === 0) return ["runner services: nothing to refresh"];
  if (rc !== 3) {
    throw new FactoryError("services_failed", `could not tell whether the runner services are older (${out.slice(0, 300)}).`, "run `factory ci status` to see why.");
  }
  const older = splitLines(out).map((l) => l.trim()).filter(Boolean);
  [rc, out] = runCi(root, ["install"]);
  if (rc !== 0) {
    throw new FactoryError("services_failed", "refreshing the runner services failed:\n" + splitLines(out).slice(-8).map((l) => "    " + l).join("\n"),
      "run `factory ci install` and read what it says; then run `factory update` again.");
  }
  return ["runner services: refreshed with `factory ci install` (" + older.slice(0, 4).join("; ") + ")"];
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Why a TypeScript file does not parse, or null when it does. */
function tsProblem(path: string): string | null {
  try {
    transpiler.transformSync(readFileSync(path, "utf8"));
    return null;
  } catch (e) {
    return errText(e).split("\n")[0] ?? "a syntax error";
  }
}

/** What must be true before saying the update worked. A list of problems; empty means verified. The factory is
 * TypeScript on Bun (#252): each installed .ts must parse and each shell script must pass `bash -n`. A .py file a pin
 * still lists (one from a release before Bun) is only checked against its hash: it is not run any more. */
export function verifyMachine(root: string, pin: Pin, runScripts = true): string[] {
  const problems = pinnedProblems(root, pin);
  const settings = join(root, ".claude", "settings.json");
  if (isFile(settings)) {
    const text = readFileSync(settings, "utf8");
    try {
      JSON.parse(text);
    } catch (e) {
      problems.push(`.claude/settings.json is not valid JSON (${errText(e)})`);
    }
    const hooks = [...new Set([...text.matchAll(/\.claude\/hooks\/[\w.-]+/g)].map((m) => m[0]))].sort();
    for (const hook of hooks) if (!isFile(join(root, hook))) problems.push(`.claude/settings.json runs ${hook}, which is not there`);
  }
  for (const rel of Object.keys(pin.files).sort()) {
    const path = join(root, rel);
    if (!isFile(path)) continue;
    if (rel.endsWith(".ts")) {
      const why = tsProblem(path);
      if (why) problems.push(`${rel} does not parse (${why})`);
    } else if (rel.endsWith(".sh") || rel === "factory" || rel === "factory-loop.sh") {
      if (run(["bash", "-n", path]).code) problems.push(`${rel} does not parse as bash`);
    }
  }
  if (runScripts && isFile(join(root, ".claude", "ci", "ci.sh")) && runCi(root, ["names"], 120_000)[0] === 0) {
    const [rc, out] = runCi(root, ["check"], 120_000);
    if (rc !== 0) {
      const lines = splitLines(out).map((l) => l.trim()).filter(Boolean);
      problems.push(...(lines.length ? lines : ["factory ci check failed"]));
    }
  }
  return problems;
}

// --- commands ---------------------------------------------------------------------------------------------------------------

function say(text = ""): void {
  console.log(text);
}

function submoduleLine(root: string): string | null {
  const p = git(root, ["config", "-f", ".gitmodules", "--get-regexp", "submodule\\..*\\.path"], false);
  for (const line of splitLines(p.stdout)) {
    const path = line.includes(" ") ? line.split(/\s+/).slice(1).join(" ") : "";
    if (path.includes("my-skills")) {
      const sha = isDir(join(root, path)) ? git(join(root, path), ["rev-parse", "--short", "HEAD"], false).stdout.trim() : "";
      return `${path} at ${sha || "not checked out"}`;
    }
  }
  return null;
}

function pinnedOnMain(root: string): [Pin | null, string | null] {
  let cfg: JsonObj = {};
  try {
    cfg = obj(readJsonFile(join(root, ".claude", "factory.json"))) ?? {};
  } catch (e) {
    if (!(e instanceof FactoryError)) throw e;
    cfg = {};
  }
  const ref = `origin/${typeof cfg.mainBranch === "string" ? cfg.mainBranch : "main"}`;
  if (git(root, ["rev-parse", "--verify", "-q", ref], false).code) return [null, `unknown (${ref} is not here; run \`git fetch\`)`];
  const p = git(root, ["show", `${ref}:${PIN_PATH}`], false);
  if (p.code) return [null, `none yet on ${ref}`];
  try {
    const pin = obj(JSON.parse(p.stdout));
    return pin ? [pin as unknown as Pin, null] : [null, `unreadable on ${ref}`];
  } catch {
    return [null, `unreadable on ${ref}`];
  }
}

/** Notes bullets of the releases after oldTag up to newTag, newest first (empty when going back). */
function changesBetween(releases: Release[], oldTag: string | null, newTag: string): [string, string][] {
  const out: [string, string][] = [];
  for (const r of releases) {
    // a first install shows only its own release's notes
    const inside = oldTag === null ? compareTags(r.tag, newTag) === 0 : compareTags(oldTag, r.tag) < 0 && compareTags(r.tag, newTag) <= 0;
    if (!inside) continue;
    const bullets = noteBullets(r.notes);
    out.push(...(bullets.length ? bullets.map((b): [string, string] => [r.tag, b]) : [[r.tag, noteLine(r.notes)] as [string, string]]));
  }
  return out;
}

interface Args {
  cmd: string;
  json: boolean;
  all: boolean;
  version: string | null;
  release: boolean;
  archive: string | null;
  sums: string | null;
  tasks: string | null;
  verbose: boolean;
}

async function cmdVersion(args: Args): Promise<number> {
  const root = projectRoot();
  const pin = readPin(root);
  const info: Record<string, unknown> = { installed: null, pinned: null, newest: null, prerelease: null, submodule: null };
  const emit = args.json ? (_text = ""): void => undefined : (text = ""): void => console.log(text); // --json prints only the JSON
  emit("Software factory");
  if (pin) {
    const bad = pinnedProblems(root, pin);
    info.installed = { tag: pin.tag, ok: !bad.length, differs: bad };
    emit(`  Installed  ${pin.tag}` + (!bad.length ? "  (the files match the pin)" : `  (${bad.length} file(s) differ from the pin)`));
    for (const b of bad.slice(0, 8)) emit(`             - ${b}`);
    if (pin.previous) emit(`  Before     ${pin.previous.tag}  (factory rollback)`);
  } else {
    const sub = submoduleLine(root);
    info.submodule = sub;
    emit("  Installed  no release pin yet" + (sub ? `: this project takes the factory from the submodule ${sub}` : " (the factory files here were copied or linked by install.sh)"));
  }
  const [mainPin, why] = pinnedOnMain(root);
  info.pinned = mainPin ? { tag: mainPin.tag } : null;
  emit("  Pinned     " + (mainPin ? `${mainPin.tag}  (on origin/main)` : why));
  let newestRelease: Release | null = null;
  let releases: Release[] = [];
  try {
    releases = await listReleases(repoName(root, pin));
    newestRelease = newest(releases);
    info.newest = { tag: newestRelease.tag, date: newestRelease.date };
    emit(`  Newest     ${newestRelease.tag}  (${newestRelease.date})`);
  } catch (e) {
    if (!(e instanceof FactoryError)) throw e;
    emit(`  Newest     unknown (${e.message.replace(/\.+$/, "")})`);
  }
  // A pre-release newer than the newest full release is never installed unasked: show it, and how to take it.
  const pre = releases.find((r) => r.pre && (!newestRelease || compareTags(r.tag, newestRelease.tag) > 0));
  if (pre) {
    info.prerelease = { tag: pre.tag, date: pre.date };
    emit(`  Pre-release ${pre.tag}  (${pre.date}); take it by naming it: factory update ${pre.tag}`);
  }
  if (args.json) {
    console.log(pyDumps(info, { indent: 2, sortKeys: true }));
    return 0;
  }
  if (newestRelease && pin && compareTags(newestRelease.tag, pin.tag) > 0) {
    emit();
    emit(`Since ${pin.tag}:`);
    for (const [tag, line] of changesBetween(releases, pin.tag, newestRelease.tag).slice(0, 15)) emit(`  - ${line}  (${tag})`);
    emit("Update this project with: factory update");
  } else if (newestRelease && !pin) {
    emit();
    emit("To take the factory from releases instead: factory update --release");
  } else if (newestRelease) {
    emit();
    emit("This project has the newest release.");
  }
  if (mainPin && pin && mainPin.tag !== pin.tag) emit(`\nmain pins ${mainPin.tag} but this checkout has ${pin.tag}: pull, then run \`factory update\`.`);
  return 0;
}

async function cmdReleases(args: Args): Promise<number> {
  const root = projectRoot();
  const pin = readPin(root);
  const releases = await listReleases(repoName(root, pin));
  if (!releases.length) {
    say("There is no published release yet.");
    return 0;
  }
  const [mainPin] = pinnedOnMain(root);
  const top = releases.find((r) => !r.pre)?.tag ?? null;
  const shown = args.all ? releases : releases.slice(0, 15);
  for (const r of shown) {
    const marks = ([["installed", pin && pin.tag === r.tag], ["pinned on main", mainPin && mainPin.tag === r.tag],
      ["newest", r.tag === top], ["pre-release", r.pre]] as [string, unknown][]).filter(([, on]) => on).map(([m]) => m);
    say((pin && pin.tag === r.tag ? "* " : "  ") + r.tag.padEnd(14) + r.date.padEnd(12) + noteLine(r.notes).slice(0, 70) +
      (marks.length ? `  (${marks.join(", ")})` : ""));
  }
  if (releases.length > shown.length) say(`  ... ${releases.length - shown.length} older (factory releases --all)`);
  return 0;
}

/** Refuse a dirty tree, except one that only holds the factory files a first run just wrote (a repeat is safe). */
function checkClean(root: string, pin: Pin | null): boolean {
  const dirty = dirtyPaths(root);
  if (!dirty.length) return false;
  const managed = pin ? new Set([...Object.keys(pin.files), ...(pin.templates ?? []), PIN_PATH]) : new Set<string>();
  if (pin && dirty.every((p) => managed.has(p))) return true; // only the factory's own files: fine if this turns out to be a repeat
  const shown = dirty.slice(0, 6).join(", ") + (dirty.length > 6 ? ` and ${dirty.length - 6} more` : "");
  throw new FactoryError("dirty_tree", `the working tree has uncommitted changes (${shown}).`,
    "commit them, or put them aside with `git stash -u`, then run it again. Nothing was changed.");
}

/** The paths of the my-skills submodule(s) in .gitmodules (empty when there is none). */
function submodulePaths(root: string): string[] {
  const p = git(root, ["config", "-f", ".gitmodules", "--get-regexp", "submodule\\..*\\.(path|url)"], false);
  const paths = new Set<string>();
  for (const line of splitLines(p.stdout)) {
    if (!line.includes("my-skills")) continue;
    const key = (line.split(/\s+/)[0] as string).replace(/\.[^.]*$/, "");
    const q = git(root, ["config", "-f", ".gitmodules", "--get", key + ".path"], false).stdout.trim();
    if (q) paths.add(q);
  }
  return [...paths].sort();
}

function realpath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Is the link at `rel` one that points into the my-skills submodule? */
function intoSubmodule(root: string, rel: string): boolean {
  const target = realpath(join(root, rel));
  const subs = submodulePaths(root).map((q) => realpath(join(root, q)));
  if (subs.length) return subs.some((q) => target.startsWith(q + sep));
  return target.includes(sep + "software-factory" + sep);
}

/** The links in .claude/ and the two entry points that point into the submodule, as project-relative paths. */
function submoduleLinks(root: string): string[] {
  const found: string[] = [];
  for (const rel of ["factory", "factory-loop.sh"]) if (isLink(join(root, rel)) && intoSubmodule(root, rel)) found.push(rel);
  const walk = (folder: string): void => {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const n of names) {
      const path = join(folder, n);
      if (isLink(path)) {
        if (intoSubmodule(root, relative(root, path))) found.push(relative(root, path));
      } else if (isDir(path)) walk(path);
    }
  };
  walk(join(root, ".claude"));
  return found.sort();
}

/** Take a submodule-linked project onto a release (#170). Refuses a dirty tree and changes nothing on a refusal; the
 * install undoes itself on a failure. It runs nothing from the release: files are only written. */
async function cmdMigrate(args: Args): Promise<number> {
  const root = projectRoot();
  refuseFactoryRepo(root);
  refuseAgent();
  const pin = readPin(root);
  if (pin) {
    say(`factory migrate-to-release\n  This project is already on ${pin.tag}; nothing to migrate.`);
    return 0;
  }
  const links = submoduleLinks(root);
  if (!links.length) {
    throw new FactoryError("nothing_to_migrate", "no file in this project is a link into the my-skills submodule.",
      "to take the factory from a release without a submodule, run `factory update --release`. Nothing was changed.");
  }
  checkClean(root, null);
  const repo = repoName(root, null);
  let tag: string;
  let release: Release | null = null;
  if (args.version) tag = normalizeTag(args.version);
  else {
    release = newest(await listReleases(repo));
    tag = release.tag;
  }
  say("factory migrate-to-release" + (args.verbose ? `  (${repo})` : ""));
  const [archive] = await fetchArchive(repo, tag, release, null);
  const [files, manifest] = unpack(archive, tag);
  const installed = await installFiles(root, files, manifest, tag, sha256File(archive), null, repo, true);
  const [engine] = plan(files);
  const kept = links.filter((l) => !engine.has(l));
  say(`  Replaced ${installed.unlinked.length} link(s) with ${tag}'s files; installed ${installed.added.length} new, ` +
    `${installed.changed.length} changed file(s).`);
  for (const t of installed.unlinked.slice(0, 8)) say(`    unlinked ${t}`);
  for (const t of kept.slice(0, 8)) say(`    kept link ${t} (this release does not ship it)`);
  for (const line of workflowLines(fixWorkflows(root))) say("  " + line);
  const newPin = readPin(root) as Pin;
  say("This machine");
  for (const line of refreshServices(root)) say("  " + line);
  const problems = verifyMachine(root, newPin);
  if (problems.length) {
    throw new FactoryError("verification_failed", `${tag} is installed here, but the checks after it failed:\n` + problems.map((p) => "    - " + p).join("\n"),
      "fix what the lines above say (each names the file), then run `factory update`; it is safe to repeat.");
  }
  say("  checks: the files match the pin, every hook in settings.json exists, the scripts parse, the runner files are readable (verified)");
  say();
  say(`Done. This project is on ${tag}. Nothing is committed for you. The steps for the pull request:`);
  say(`  1. git add -A && git commit -m "Take the software factory from release ${tag}, not the submodule"`);
  const subs = submodulePaths(root);
  if (kept.length) {
    say(`  2. The submodule stays: ${kept.length} link(s) still point into it (${kept.slice(0, 3).join(", ")}${kept.length > 3 ? ", ..." : ""}).`);
  } else {
    for (const q of subs) say(`  2. When you no longer need the submodule ${q}: git submodule deinit -f ${q} && git rm -f ${q} && rm -rf .git/modules/${q}`);
  }
  say("  3. Open the pull request. Everyone else runs `git pull`, then `factory update` from then on.");
  return 0;
}

async function cmdUpdate(args: Args, rollback = false): Promise<number> {
  const root = projectRoot();
  const command = rollback ? "rollback" : "update";
  checkTasks(args.tasks);
  refuseFactoryRepo(root);
  refuseAgent();
  const pin = readPin(root);
  const repo = repoName(root, pin);
  const dirtyOk = checkClean(root, pin);
  const oldTag = pin ? pin.tag : null;
  let release: Release | null = null;
  let releases: Release[] = [];
  let expect: string | null = null;
  let local: string | null = null;
  let tag: string;
  if (args.sums && !args.archive) {
    throw new FactoryError("missing_archive", "--sums goes with --archive, and no archive was given.",
      "add `--archive <software-factory-X.tar.gz>`, or leave --sums out to download the release.");
  }
  if (rollback) {
    if (!pin || !pin.previous) {
      throw new FactoryError("no_previous", "there is no earlier release recorded to go back to.",
        "name the one you want: `factory update v1.3.2` (`factory releases` lists them).");
    }
    tag = pin.previous.tag;
    expect = pin.previous.sha256 ?? null;
  } else if (args.archive) {
    [tag, local] = localArchive(args.archive, args.sums, args.version);
  } else if (args.version) {
    tag = normalizeTag(args.version);
  } else {
    releases = await listReleases(repo);
    release = newest(releases);
    tag = release.tag;
  }
  const same = Boolean(pin) && (pin as Pin).tag === tag;
  const drift = same ? pinnedProblems(root, pin as Pin) : [];
  if (dirtyOk && (!same || drift.length)) {
    throw new FactoryError("dirty_tree", "the working tree has uncommitted changes to the factory's own files.",
      "commit them (or `git checkout -- .claude factory factory-loop.sh` to drop them), then run it again. Nothing was changed.");
  }
  say(`factory ${command}` + (args.verbose ? `  (${repo})` : ""));
  if (same && !drift.length) {
    say(`  This project is already on ${tag}; nothing to install.`);
  } else {
    const [archive] = local ? [local] : await fetchArchive(repo, tag, release, expect);
    const [files, manifest] = unpack(archive, tag);
    const installed = await installFiles(root, files, manifest, tag, sha256File(archive), pin, repo, false, args.tasks);
    const goingBack = oldTag !== null && compareTags(tag, oldTag) < 0;
    if (same) {
      say(`  ${tag} was already installed; ${drift.length} file(s) differed from the pin and were repaired:`);
      for (const d of drift.slice(0, 8)) say(`    - ${d}`);
    } else {
      say(`  ${oldTag || "no release"} -> ${tag}` + (goingBack ? "  (going back)" : ""));
      if (local) say(`    (from the local archive ${basename(local)}; no release notes without the network)`);
      else if (!releases.length) {
        try {
          releases = await listReleases(repo);
        } catch (e) {
          if (!(e instanceof FactoryError)) throw e;
          releases = [];
        }
      }
      if (releases.length && !goingBack) {
        for (const [rtag, line] of changesBetween(releases, oldTag, tag).slice(0, 15)) say(`    - ${line}  (${rtag})`);
      } else if (!releases.length && !local) say("    (the release notes need the network; `factory releases` shows them later)");
    }
    say(`  Installed ${tag}: ${installed.added.length} new, ${installed.changed.length} changed, ${installed.removed.length} removed file(s).`);
    if (installed.stack) {
      for (const line of await stackLines(installed.stack)) say("  " + line);
      for (const line of tasksLines(args.tasks)) say("  " + line);
    } else if (args.tasks) {
      say(`  note: --tasks ${args.tasks} only applies to a first install; here, run \`factory settings set tasks.source ${args.tasks}\`.`);
    }
    for (const t of installed.removed.slice(0, 8)) say(`    removed ${t}`);
    for (const t of installed.kept_local.slice(0, 8)) say(`    note: ${t} had local changes; the release's version replaced them (see the diff)`);
  }
  // The workflows' steps that call a hook the release removed (a Python one, #254) are rewritten in this same change:
  // a pull request runs the workflow from its own merge ref, so a later fix could never make it green.
  for (const line of workflowLines(fixWorkflows(root))) say("  " + line);
  const newPin = readPin(root) as Pin;
  say("This machine");
  if (local) { // a file nobody published: its own scripts are not run on this machine
    say("  runner services: not refreshed from a local archive. If they are installed here, run `factory ci install` yourself.");
  } else {
    for (const line of refreshServices(root)) say("  " + line);
  }
  const problems = verifyMachine(root, newPin, !local);
  if (problems.length) {
    throw new FactoryError("verification_failed", `${tag} is installed here, but the checks after it failed:\n` + problems.map((p) => "    - " + p).join("\n"),
      "fix what the lines above say (each names the file), then run `factory update` again; it is safe to repeat.");
  }
  say("  checks: the files match the pin, every hook in settings.json exists, the scripts parse" +
    (local ? "" : ", the runner files are readable") + " (verified)");
  const changed = git(root, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim();
  say();
  say(`Done. This project is on ${tag}.`);
  if (changed) {
    say("Nothing is committed for you. Review it, then:");
    say(`  git add -A && git commit -m "Update the software factory to ${tag}"`);
    say("and open a pull request. Everyone else catches up with `factory update` after pulling it.");
  }
  return 0;
}

const COMMANDS = ["version", "releases", "update", "rollback", "migrate-to-release", "check-own-repo"];
const USAGE = "usage: factory [-h] {version,releases,update,rollback,migrate-to-release,check-own-repo} ...";

function usageError(text: string, sub?: string): never {
  process.stderr.write((sub ? `usage: factory ${sub} [-h] ...` : USAGE) + `\nfactory${sub ? " " + sub : ""}: error: ${text}\n`);
  throw new Exit(2);
}

/** argparse by hand: the subcommands and their flags, as the Python client took them. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: "", json: false, all: false, version: null, release: false, archive: null, sums: null, tasks: null, verbose: false };
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    if (argv.length) {
      console.log(USAGE + "\n\nthe software factory's release client");
      throw new Exit(0);
    }
    usageError("the following arguments are required: cmd");
  }
  const cmd = argv[0] as string;
  if (!COMMANDS.includes(cmd)) usageError(`argument cmd: invalid choice: ${pyRepr(cmd)} (choose from ${COMMANDS.map(pyRepr).join(", ")})`);
  args.cmd = cmd;
  const flags: Record<string, string[]> = {
    version: ["--json"], releases: ["--all"], update: ["--release", "--verbose"], rollback: ["--verbose"],
    "migrate-to-release": ["--verbose"], "check-own-repo": [],
  };
  const valued = cmd === "update" ? ["--archive", "--sums", "--tasks"] : [];
  const positional = cmd === "update" || cmd === "migrate-to-release";
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (valued.includes(flag)) {
      let v: string;
      if (eq > 0) v = a.slice(eq + 1);
      else {
        if (i + 1 >= rest.length || (rest[i + 1] as string).startsWith("-")) usageError(`argument ${flag}: expected one argument`, cmd);
        v = rest[++i] as string;
      }
      if (flag === "--archive") args.archive = v;
      else if (flag === "--sums") args.sums = v;
      else args.tasks = v;
    } else if ((flags[cmd] as string[]).includes(a)) {
      if (a === "--json") args.json = true;
      else if (a === "--all") args.all = true;
      else if (a === "--release") args.release = true;
      else args.verbose = true;
    } else if (positional && !a.startsWith("-") && args.version === null) {
      args.version = a;
    } else {
      usageError(`unrecognized arguments: ${rest.slice(i).join(" ")}`);
    }
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    if (args.cmd === "version") return await cmdVersion(args);
    if (args.cmd === "releases") return await cmdReleases(args);
    if (args.cmd === "check-own-repo") {
      refuseFactoryRepo(projectRoot());
      return 0;
    }
    if (args.cmd === "migrate-to-release") return await cmdMigrate(args);
    return await cmdUpdate(args, args.cmd === "rollback");
  } catch (e) {
    if (e instanceof FactoryError) {
      process.stderr.write(`factory ${args.cmd}: [${e.code}] ${e.message}\nFix: ${e.fix}\n`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
