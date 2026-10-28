#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Build a software-factory release: a deterministic .tar.gz, its manifest, and SHA256SUMS (#113).
//
//     bun tools/build_release.ts [--out dist] [--tag v1.2.3] [--root <checkout>]
//
// Runs offline from a git checkout. Reads software-factory/VERSION; with --tag, refuses unless the tag is "v" + that
// version. Refuses a checkout with uncommitted or untracked changes, so the archive always equals a commit. The same
// commit gives byte-identical output: files are the git-tracked ones, sorted; owner, group and mtime are fixed; gzip
// stores no timestamp or name.
//
// Writes into --out:
//   software-factory-<version>.tar.gz   everything under one folder, software-factory-<version>/
//   SHA256SUMS                          `sha256sum -c` format, for the archive
// Tracked symlinks are stored as regular files with their target's content and mode: the archive holds no links, so
// unpacking it never depends on symlink support. The archive holds MANIFEST.json (schema, version, source commit,
// every file with sha256, size, mode, and where a project gets it: install {kind, to}, or null for a file not
// installed). The rules are the classify() beside this builder (the checkout it builds, unless --root says another), so a
// client installs a release by that release's own rules, even when the client is older and would put a new file
// elsewhere (#278).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { FactoryError, pyDumps, run } from "../software-factory/hooks/factory_lib.ts";
import { classify } from "../software-factory/hooks/factory_release.ts";
import { gzipFixed, tarCreate, type TarInput } from "../software-factory/hooks/factory_tar.ts";

const SCHEMA = "factory-release/1";
const SRC = "software-factory";
// Excluded from the archive: the factory's own tests (they test my-skills, a project does not run them), caches and
// the dev-only files for type-checking the factory (#252: a project never installs them).
const EXCLUDE_PREFIXES = [`${SRC}/tests/`];
const EXCLUDE_PARTS = ["__pycache__", "node_modules"];
const EXCLUDE_FILES = [`${SRC}/package.json`, `${SRC}/tsconfig.json`, `${SRC}/bun.lock`, `${SRC}/bun.lockb`];
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.]*)?$/;

function git(root: string, ...args: string[]): string {
  const p = run(["git", "-C", root, ...args]);
  if (p.code !== 0) {
    throw new FactoryError("git_failed", `git ${args.join(" ")} failed: ${p.stderr.trim()}`, "run this from a git checkout of my-skills.");
  }
  return p.stdout;
}

export function readVersion(root: string): string {
  let version: string;
  try {
    version = readFileSync(join(root, SRC, "VERSION"), "utf8").trim();
  } catch {
    throw new FactoryError("no_version", `${SRC}/VERSION is missing.`, "create it with the release number, e.g. 1.0.0.");
  }
  if (!VERSION_RE.test(version)) {
    throw new FactoryError("bad_version", `${SRC}/VERSION is '${version}', not a version like 1.2.3.`,
      "write MAJOR.MINOR.PATCH (a -suffix such as -rc.1 is allowed).");
  }
  return version;
}

function checkTag(tag: string, version: string): void {
  if (tag !== "v" + version) {
    throw new FactoryError("tag_mismatch", `tag ${tag} does not match ${SRC}/VERSION (${version}).`,
      `bump ${SRC}/VERSION to ${tag.replace(/^v+/, "")} in a merged PR, then tag again; or tag v${version}.`);
  }
}

function checkClean(root: string): void {
  if (git(root, "status", "--porcelain", "--untracked-files=all").trim()) {
    throw new FactoryError("dirty_tree", "the working tree has uncommitted or untracked changes.",
      "commit or remove them (git status shows which); a release is built from a commit only.");
  }
}

function shipped(path: string): boolean {
  return !(EXCLUDE_PREFIXES.some((p) => path.startsWith(p)) || EXCLUDE_FILES.includes(path) ||
    path.split("/").some((p) => EXCLUDE_PARTS.includes(p)));
}

/** [path, mode, source] for each tracked file that goes into the archive, sorted by path. `source` is the file whose
 * bytes are archived. A tracked symlink is archived as a regular file holding what it points to, so the archive never
 * contains a link; a link that leaves software-factory/ or points at something that is not shipped is refused. */
export function releaseFiles(root: string): [string, number, string][] {
  const tracked = new Map<string, string>();
  for (const rec of git(root, "ls-files", "-s", "-z", "--", SRC).split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t");
    tracked.set(rec.slice(tab + 1), rec.slice(0, tab).split(" ")[0] as string);
  }
  const files: [string, number, string][] = [];
  for (const [path, mode0] of tracked) {
    let mode = mode0;
    if (mode === "160000" || !shipped(path)) continue;
    let source = path;
    if (mode === "120000") {
      const real = realpathSync(join(root, path));
      source = relative(realpathSync(root), real).split("\\").join("/");
      const target = tracked.get(source);
      if (!source.startsWith(SRC + "/") || (target !== "100644" && target !== "100755") || !shipped(source)) {
        throw new FactoryError("symlink", `${path} is a symlink to ${source}, which is not a regular file shipped in the release.`,
          `point it at a regular file inside ${SRC}/ (not tests/), or remove the link.`);
      }
      mode = target;
    }
    files.push([path, mode === "100755" ? 0o755 : 0o644, source]);
  }
  return files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface Built {
  archive: string;
  sha256: string;
  version: string;
  commit: string;
  files: number;
}

export function build(root: string, outDir: string, tag?: string | null): Built {
  const version = readVersion(root);
  if (tag) checkTag(tag, version);
  checkClean(root);
  const commit = git(root, "rev-parse", "HEAD").trim();
  const top = `${SRC}-${version}`;
  const entries: TarInput[] = [];
  const manifestFiles: { path: string; sha256: string; size: number; mode: string; install: { kind: string; to: string } | null }[] = [];
  for (const [path, mode, source] of releaseFiles(root)) {
    const data = new Uint8Array(readFileSync(join(root, source)));
    const rel = path.slice(SRC.length + 1);
    entries.push({ name: `${top}/${rel}`, mode, data });
    const rule = classify(rel);
    manifestFiles.push({ path: rel, sha256: sha256(data), size: data.length, mode: mode.toString(8), install: rule ? { kind: rule[0], to: rule[1] } : null });
  }
  const manifest = { schema: SCHEMA, name: SRC, version, tag: "v" + version, source_commit: commit, files: manifestFiles };
  entries.push({ name: `${top}/MANIFEST.json`, mode: 0o644,
    data: new TextEncoder().encode(pyDumps(manifest, { indent: 2, sortKeys: true }) + "\n") });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const gz = gzipFixed(tarCreate(entries));
  mkdirSync(outDir, { recursive: true });
  const name = `${top}.tar.gz`;
  writeFileSync(join(outDir, name), gz);
  const digest = sha256(gz);
  writeFileSync(join(outDir, "SHA256SUMS"), `${digest}  ${name}\n`);
  return { archive: join(outDir, name), sha256: digest, version, commit, files: manifestFiles.length };
}

const USAGE = "usage: build_release.ts [-h] [--out OUT] [--tag TAG] [--root ROOT]";

function main(argv: string[]): number {
  let out = "dist";
  let tag: string | null = null;
  let root = resolve(import.meta.dir, "..");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
    const value = (): string => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) {
        process.stderr.write(`${USAGE}\nbuild_release.ts: error: argument ${flag}: expected one argument\n`);
        process.exit(2);
      }
      return argv[++i] as string;
    };
    if (flag === "--out") out = value();
    else if (flag === "--tag") tag = value();
    else if (flag === "--root") root = value();
    else if (flag === "-h" || flag === "--help") {
      console.log(`${USAGE}\n\nBuild a software-factory release: a deterministic .tar.gz, its manifest, and SHA256SUMS (#113).`);
      return 0;
    } else {
      process.stderr.write(`${USAGE}\nbuild_release.ts: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
  }
  let r: Built;
  try {
    r = build(resolve(root), out, tag);
  } catch (e) {
    if (e instanceof FactoryError) {
      process.stderr.write(pyDumps(e.toJSON()) + "\n");
      return 1;
    }
    throw e;
  }
  console.log(`built ${r.archive} (${r.files} files, version ${r.version}, commit ${r.commit.slice(0, 12)})`);
  console.log(`sha256 ${r.sha256}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
