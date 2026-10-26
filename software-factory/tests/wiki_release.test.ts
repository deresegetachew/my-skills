// The release archive carries the wiki beside the README, so the links work there too (#242).
import { expect, test } from "bun:test";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { classify } from "../hooks/factory_release.ts";
import { type TarEntry, tarEntries } from "../hooks/factory_tar.ts";
import { BUN, git, ROOT, sh, tmp, WIKI } from "./support.ts";

let archiveCache: TarEntry[] | null = null;

/** The members of an archive built from the tracked files of this checkout, copied into a scratch git repo. */
function realArchive(): TarEntry[] {
  if (archiveCache) return archiveCache;
  const d = tmp();
  for (const rel of git(ROOT, "ls-files", "-z").split("\0").filter(Boolean)) {
    const src = join(ROOT, rel);
    const st = lstatSync(src, { throwIfNoEntry: false });
    if (!st) continue;
    const dst = join(d, rel);
    mkdirSync(dirname(dst), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
    else copyFileSync(src, dst);
  }
  git(d, "init", "-q", "-b", "main");
  git(d, "add", "-f", "-A");
  git(d, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x");
  const out = tmp();
  const p = sh([...BUN, join(ROOT, "tools", "build_release.ts"), "--root", d, "--out", out]);
  expect(p.code, p.stderr).toBe(0);
  const name = readdirSync(out).find((n) => /^software-factory-.*\.tar\.gz$/.test(n)) as string;
  archiveCache = [...tarEntries(new Uint8Array(gunzipSync(readFileSync(join(out, name)))))];
  return archiveCache;
}

const pages = (): string[] => readdirSync(WIKI).filter((f) => f.endsWith(".md")).sort();

test("the archive holds every wiki page with the same mode as the readme", () => {
  expect(pages().length, "no wiki pages").toBeGreaterThan(0);
  const members = realArchive();
  const top = (members[0] as TarEntry).name.split("/")[0] + "/";
  const get = (name: string): TarEntry => {
    const m = members.find((x) => x.name === name);
    expect(m, name).toBeDefined();
    return m as TarEntry;
  };
  for (const page of pages()) {
    const m = get(top + "docs/wiki/" + page);
    expect(m.mode === 0o644 && m.kind === "file", page).toBe(true);
  }
  expect(get(top + "README.md").mode).toBe(0o644);
  expect(Buffer.from(get(top + "docs/wiki/settings.md").data).equals(readFileSync(join(WIKI, "settings.md")))).toBe(true);
});

test("the relative links of the readme and the wiki resolve inside the archive", () => {
  const members = realArchive();
  const names = new Set(members.map((m) => m.name));
  const top = (members[0] as TarEntry).name.split("/")[0] + "/";
  const docs = [...names].filter((n) => n === top + "README.md" || new RegExp("^" + top.replace(/[.]/g, "\\.") + "docs/wiki/[^/]+\\.md$").test(n)).sort();
  for (const name of docs) {
    const text = new TextDecoder().decode((members.find((m) => m.name === name) as TarEntry).data);
    for (const match of text.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
      const target = match[1] as string;
      if (/^[a-z][a-z0-9+.-]*:/.test(target)) continue;
      const dest = posix.normalize(posix.join(posix.dirname(name), target));
      if (!dest.startsWith(top)) continue; // leaves the archive: the my-skills README at the repo root, which a release does not ship
      expect(names.has(dest) || [...names].some((n) => n.startsWith(dest + "/")), `${name}: ${target}`).toBe(true);
    }
  }
});

test("a project is given the wiki the same way it is given the readme", () => {
  expect(classify("README.md")).toBeNull();
  for (const page of pages()) expect(classify("docs/wiki/" + page)).toEqual(classify("README.md"));
});
