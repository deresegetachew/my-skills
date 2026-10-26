// The release build (#113): deterministic archive, manifest, checksum, refusals.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { tarEntries, type TarEntry } from "../hooks/factory_tar.ts";
import { BUN, git, ROOT, sh, tmp, type Proc } from "./support.ts";

const SCRIPT = join(ROOT, "tools", "build_release.ts");

/** A tiny git repo shaped like my-skills: software-factory with a kit, a test, a cache file and an executable. */
function repo(version = "1.2.3"): string {
  const d = tmp();
  const files: Record<string, string> = {
    "software-factory/VERSION": version + "\n", "software-factory/README.md": "readme\n",
    "software-factory/kit/factory": "#!/bin/sh\n", "software-factory/kit/.claude/hooks/a.ts": "console.log(1)\n",
    "software-factory/tests/x.test.ts": "x\n", "software-factory/kit/__pycache__/a.pyc": "c\n",
    "other-skill/SKILL.md": "not shipped\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  chmodSync(join(d, "software-factory/kit/factory"), 0o755);
  git(d, "init", "-q", "-b", "main");
  git(d, "add", "-f", "-A");
  git(d, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return d;
}

function run(root: string, out: string, ...extra: string[]): Proc {
  return sh([...BUN, SCRIPT, "--root", root, "--out", out, ...extra]);
}

function members(path: string): TarEntry[] {
  return [...tarEntries(gunzipSync(readFileSync(path)))];
}

function member(list: TarEntry[], name: string): TarEntry {
  const m = list.find((e) => e.name === name);
  if (!m) throw new Error(`${name} is not in the archive`);
  return m;
}

const text = (e: TarEntry) => new TextDecoder().decode(e.data);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("same commit gives identical bytes", async () => {
  const d = repo();
  const a = tmp();
  const b = tmp();
  expect(run(d, a).code).toBe(0);
  await Bun.sleep(1100); // a timestamp in the output would differ now
  expect(run(d, b).code).toBe(0);
  const name = "software-factory-1.2.3.tar.gz";
  expect(Buffer.compare(readFileSync(join(a, name)), readFileSync(join(b, name)))).toBe(0);
  expect(readFileSync(join(a, "SHA256SUMS"), "utf8")).toBe(readFileSync(join(b, "SHA256SUMS"), "utf8"));
});

test("archive contents owners and times are fixed", () => {
  const d = repo();
  const out = tmp();
  run(d, out);
  const path = join(out, "software-factory-1.2.3.tar.gz");
  const list = members(path);
  const names = list.map((m) => m.name);
  expect(names).toEqual([...names].sort());
  expect(names).toEqual(["software-factory-1.2.3/MANIFEST.json", "software-factory-1.2.3/README.md",
    "software-factory-1.2.3/VERSION", "software-factory-1.2.3/kit/.claude/hooks/a.ts", "software-factory-1.2.3/kit/factory"]);
  // owner, group, names and times are fixed: read from the raw headers
  const raw = gunzipSync(readFileSync(path));
  for (let at = 0; at + 512 <= raw.length && raw[at] !== 0; ) {
    const h = raw.subarray(at, at + 512);
    const field = (o: number, n: number) => new TextDecoder().decode(h.subarray(o, o + n)).replace(/\0.*$/s, "").trim();
    expect([parseInt(field(108, 8), 8), parseInt(field(116, 8), 8), field(265, 32), field(297, 32), parseInt(field(136, 12), 8)])
      .toEqual([0, 0, "", "", 0]);
    at += 512 + Math.ceil(parseInt(field(124, 12), 8) / 512) * 512;
  }
  expect(member(list, "software-factory-1.2.3/kit/factory").mode).toBe(0o755);
  expect(member(list, "software-factory-1.2.3/README.md").mode).toBe(0o644);
  // an independent reader agrees: the system's tar lists the same files, owned by 0/0
  const t = sh(["tar", "--numeric-owner", "-tvzf", path]);
  expect(t.code, t.out).toBe(0);
  expect(t.stdout.trim().split("\n").map((l) => l.split(/\s+/).pop())).toEqual(names);
  expect(t.stdout.trim().split("\n").every((l) => l.split(/\s+/)[1] === "0/0")).toBe(true);
  const gz = readFileSync(path);
  expect([...gz.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // gzip header mtime is zero
});

test("manifest matches files and commit", () => {
  const d = repo();
  const out = tmp();
  run(d, out);
  const commit = git(d, "rev-parse", "HEAD").trim();
  const list = members(join(out, "software-factory-1.2.3.tar.gz"));
  const m = JSON.parse(text(member(list, "software-factory-1.2.3/MANIFEST.json")));
  expect([m.version, m.tag, m.source_commit, m.schema]).toEqual(["1.2.3", "v1.2.3", commit, "factory-release/1"]);
  expect(m.files.map((f: { path: string }) => f.path)).toEqual(["README.md", "VERSION", "kit/.claude/hooks/a.ts", "kit/factory"]);
  for (const f of m.files as { path: string; sha256: string; size: number }[]) {
    const data = member(list, "software-factory-1.2.3/" + f.path).data;
    expect([f.sha256, f.size]).toEqual([sha(data), data.length]);
  }
});

test("sha256sums checks out", () => {
  const d = repo();
  const out = tmp();
  run(d, out);
  const [digest, name] = readFileSync(join(out, "SHA256SUMS"), "utf8").split(/\s+/);
  expect(digest).toBe(sha(readFileSync(join(out, name as string))));
  expect(name).toBe("software-factory-1.2.3.tar.gz");
  // and with the system's own tool, as the release notes tell people to check it
  expect(sh(["sha256sum", "-c", "SHA256SUMS"], { cwd: out }).code).toBe(0);
});

function commitAll(d: string): void {
  git(d, "add", "-f", "-A");
  git(d, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "links");
}

function archive(d: string): TarEntry[] {
  const out = tmp();
  const p = run(d, out);
  expect(p.code, p.stderr).toBe(0);
  return members(join(out, "software-factory-1.2.3.tar.gz"));
}

function assertNoLinks(list: TarEntry[]): void {
  expect(list.filter((m) => m.kind !== "file" && m.kind !== "dir").map((m) => m.name)).toEqual([]);
}

test("a symlink forwarder is archived as a real file with its target's content and mode", () => {
  const d = repo();
  mkdirSync(join(d, "software-factory", "hooks"));
  writeFileSync(join(d, "software-factory", "hooks", "b.ts"), "console.log(2)\n");
  chmodSync(join(d, "software-factory", "hooks", "b.ts"), 0o755);
  symlinkSync("../../../hooks/b.ts", join(d, "software-factory", "kit", ".claude", "hooks", "b.ts"));
  commitAll(d);
  const list = archive(d);
  assertNoLinks(list);
  const fwd = member(list, "software-factory-1.2.3/kit/.claude/hooks/b.ts");
  expect(fwd.kind).toBe("file");
  expect(fwd.mode).toBe(0o755);
  expect(text(fwd)).toBe("console.log(2)\n");
  expect(text(member(list, "software-factory-1.2.3/hooks/b.ts"))).toBe("console.log(2)\n");
  const m = JSON.parse(text(member(list, "software-factory-1.2.3/MANIFEST.json")));
  expect(m.files.map((f: { path: string }) => f.path)).toContain("kit/.claude/hooks/b.ts");
});

test("a symlink that leaves the factory folder or points at unshipped code is refused", () => {
  let d = repo();
  symlinkSync("../../other-skill/SKILL.md", join(d, "software-factory", "kit", "escape.md"));
  commitAll(d);
  refused(run(d, tmp()), "symlink");
  d = repo();
  symlinkSync("../tests/x.test.ts", join(d, "software-factory", "kit", "t.ts"));
  commitAll(d);
  refused(run(d, tmp()), "symlink");
});

test("the dev-only type-check files are not shipped", () => {
  const d = repo();
  writeFileSync(join(d, "software-factory", "package.json"), "{}\n");
  writeFileSync(join(d, "software-factory", "tsconfig.json"), "{}\n");
  commitAll(d);
  const names = archive(d).map((m) => m.name);
  expect(names).not.toContain("software-factory-1.2.3/package.json");
  expect(names).not.toContain("software-factory-1.2.3/tsconfig.json");
});

test("the real checkout builds an archive with the moved folders and no links", () => {
  // Builds from the working tree as it is now (copied into a scratch git repo), so a new forwarder or moved file that
  // would put a link into a release fails here, not at the first release.
  const d = tmp();
  for (const rel of git(ROOT, "ls-files", "-z").split("\0").filter(Boolean)) {
    const src = join(ROOT, rel);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue;
    }
    const dst = join(d, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
    else {
      copyFileSync(src, dst);
      chmodSync(dst, st.mode & 0o777);
    }
  }
  git(d, "init", "-q", "-b", "main");
  commitAll(d);
  const out = tmp();
  const p = run(d, out);
  expect(p.code, p.stderr).toBe(0);
  const version = readFileSync(join(ROOT, "software-factory", "VERSION"), "utf8").trim();
  const list = members(join(out, `software-factory-${version}.tar.gz`));
  assertNoLinks(list);
  const names = new Set(list.map((m) => m.name));
  const top = `software-factory-${version}/`;
  for (const must of ["hooks/factory_config.ts", "hooks/factory_lib.ts", "ci/ci.sh", "ci/entrypoint.sh", "factory",
    "factory-loop.sh", "install.sh", "kit/.claude/settings.json", "kit/.claude/ci/ci.sh", "kit/factory"]) {
    expect(names.has(top + must), must).toBe(true);
  }
  expect(member(list, top + "factory").mode).toBe(0o755);
  expect(member(list, top + "kit/factory").mode).toBe(0o755);
  expect(member(list, top + "kit/.claude/ci/entrypoint.sh").mode).toBe(member(list, top + "ci/entrypoint.sh").mode);
  expect([...names].filter((n) => n.includes("/tests/"))).toEqual([]);
  expect(text(member(list, top + "kit/factory"))).toBe(text(member(list, top + "factory")));
});

function refused(p: Proc, code: string): void {
  expect(p.code, p.stdout).toBe(1);
  const err = JSON.parse(p.stderr);
  expect(err.code).toBe(code);
  expect(err.message).toBeTruthy();
  expect(err.fix).toBeTruthy();
}

test("refuses a dirty tree", () => {
  const d = repo();
  const out = tmp();
  writeFileSync(join(d, "software-factory", "README.md"), "readme\nedit\n");
  refused(run(d, out), "dirty_tree");
  expect(readdirSync(out)).toEqual([]);
});

test("refuses an untracked file", () => {
  const d = repo();
  writeFileSync(join(d, "software-factory", "new.txt"), "x");
  refused(run(d, tmp()), "dirty_tree");
});

test("refuses a tag that does not match the version", () => {
  const d = repo("1.2.3");
  refused(run(d, tmp(), "--tag", "v1.2.4"), "tag_mismatch");
  expect(run(d, tmp(), "--tag", "v1.2.3").code).toBe(0);
});

test("refuses a bad or missing version", () => {
  refused(run(repo("one"), tmp()), "bad_version");
  const d = repo();
  git(d, "rm", "-q", "software-factory/VERSION");
  git(d, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x");
  refused(run(d, tmp()), "no_version");
});

test("real checkout has a valid version", async () => {
  const mod = await import(SCRIPT);
  expect(existsSync(join(ROOT, "software-factory", "VERSION"))).toBe(true);
  expect(/^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.]*)?$/.test(mod.readVersion(ROOT))).toBe(true);
});
