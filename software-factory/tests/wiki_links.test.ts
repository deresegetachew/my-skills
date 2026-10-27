// The README is a front page and the long text lives in wiki pages (#242). Every relative link and every heading anchor
// in the README and the wiki pages resolves, every page has its navigation, and no heading of the old README was lost.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize, relative } from "node:path";
import { SF, tmp, WIKI } from "./support.ts";

// The `##` headings of the README before it became a front page, in their old order. "Contents" is now "Wiki".
const OLD_HEADINGS = [
  "The idea in one picture", "Why it is built this way", "Who does what", "One task, start to finish",
  "What stops bad work", "Where the machines and GitHub meet", "Where things stand", "Contents", "Quick start",
  "Where things live", "Updating from releases", "The `factory` command", "Agent loops",
  "Roles: coding agent, dev manager, product owner", "Tasks", "Live agents (issues mode)", "Messages between agents",
  "Watch and talk to an agent: `factory follow`", "After a reboot: `factory autostart`", "Reviews and gates",
  "The dev manager", "CI: GitHub's runners or your own Mac", "A shared build cache",
  "A sandboxed machine: `factory bootstrap`", "Security notes", "Style guides", "factory.json settings",
  "The files in the kit", "Appendix: projects that use the submodule",
  "Installed as a submodule: what's shared and what's yours", "Updating the factory",
];
const RENAMED: Record<string, string> = { Contents: "Wiki" };

const wikiPages = (): string[] => readdirSync(WIKI).filter((f) => f.endsWith(".md")).sort().map((f) => join(WIKI, f));
const pages = (): string[] => [join(SF, "README.md"), ...wikiPages()];
const read = (p: string): string => readFileSync(p, "utf8");

function linesOutsideFences(text: string): string[] {
  let fenced = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

/** GitHub's anchor for a heading: lower case, formatting and punctuation dropped, spaces to hyphens. */
function slug(title: string): string {
  let t = title.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/`/g, "").replace(/\*/g, "").trim().toLowerCase();
  return t.replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
}

/** Every anchor a page offers: its headings (with GitHub's -1, -2 for repeats) and its <a id="..."> tags. */
function anchors(path: string): Set<string> {
  const seen: Record<string, number> = {};
  const found = new Set<string>();
  for (const line of linesOutsideFences(read(path))) {
    const m = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (m) {
      const base = slug(m[1] as string);
      const n = seen[base] ?? 0;
      seen[base] = n + 1;
      found.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const a of line.matchAll(/<a id="([^"]+)"/g)) found.add(a[1] as string);
  }
  return found;
}

function links(path: string): string[] {
  const out: string[] = [];
  for (let line of linesOutsideFences(read(path))) {
    line = line.replace(/`[^`]*`/g, ""); // a link shown as code is not a link
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1] as string);
  }
  return out;
}

function deadLinks(paths: string[]): string[] {
  const bad: string[] = [];
  const cache = new Map<string, Set<string>>();
  for (const page of paths) {
    for (const target of links(page)) {
      if (/^[a-z][a-z0-9+.-]*:/.test(target)) continue;
      const hash = target.indexOf("#");
      const filePart = hash < 0 ? target : target.slice(0, hash);
      const frag = hash < 0 ? "" : target.slice(hash + 1);
      const dest = filePart ? normalize(join(dirname(page), filePart)) : page;
      if (!existsSync(dest)) {
        bad.push(`${relative(SF, page)}: ${target} (no such file)`);
        continue;
      }
      if (frag && dest.endsWith(".md")) {
        if (!cache.has(dest)) cache.set(dest, anchors(dest));
        if (!(cache.get(dest) as Set<string>).has(frag)) bad.push(`${relative(SF, page)}: ${target} (no such heading)`);
      }
    }
  }
  return bad;
}

function h2Titles(path: string): string[] {
  return linesOutsideFences(read(path)).flatMap((line) => {
    const m = /^## (.+)$/.exec(line);
    return m ? [(m[1] as string).trim()] : [];
  });
}

test("the slug follows githubs rules", () => {
  expect(slug("CI: GitHub's runners or your own Mac")).toBe("ci-githubs-runners-or-your-own-mac");
  expect(slug("A sandboxed machine: `factory bootstrap`")).toBe("a-sandboxed-machine-factory-bootstrap");
  expect(slug("factory.json settings")).toBe("factoryjson-settings");
});

test("every relative link and heading anchor in the readme and the wiki resolves", () => {
  const bad = deadLinks(pages());
  expect(bad, "dead links:\n" + bad.join("\n")).toEqual([]);
});

test("the wiki has pages and the checker would notice a dead link", () => {
  expect(wikiPages().length, "docs/wiki/ has no pages").toBeGreaterThan(0);
  const d = tmp();
  const p = join(d, "a.md");
  writeFileSync(p, "# A\n\n[x](#nope) [y](missing.md) [z](#a) [w](https://example.com/#q)\n```\n[v](#in-a-fence)\n```\n");
  const bad = deadLinks([p]);
  expect(bad.length === 2 && bad.some((b) => b.includes("#nope")) && bad.some((b) => b.includes("missing.md")), bad.join("\n")).toBe(true);
});

test("every h2 heading of the old readme exists in exactly one place now", () => {
  const where: Record<string, string[]> = {};
  for (const page of pages()) for (const title of h2Titles(page)) (where[title] ??= []).push(relative(SF, page));
  for (const old of OLD_HEADINGS) {
    const now = RENAMED[old] ?? old;
    expect((where[now] ?? []).length, `'${old}' is in ${JSON.stringify(where[now] ?? [])}`).toBe(1);
  }
});

test("the front page is short and lists every wiki page under wiki", () => {
  const text = read(join(SF, "README.md"));
  expect(text.split("\n").length - 1, "the front page should be about 400 lines").toBeLessThan(430);
  expect(text.split("\n")).toContain("## Wiki");
  let toc = text.slice(text.indexOf("\n## Wiki"));
  toc = toc.slice(0, toc.indexOf("\n## ", 5));
  for (const page of wikiPages()) expect(toc, `${basename(page)} is not in the README's wiki list`).toContain(`docs/wiki/${basename(page)}`);
});

test("each wiki page opens with a title a way back and on this page and ends with previous and next links", () => {
  for (const page of wikiPages()) {
    const text = read(page);
    const name = basename(page);
    const head = text.split("\n").slice(0, 12).join("\n");
    expect(text.startsWith("# "), name).toBe(true);
    expect(head, name).toContain("Back to the [wiki home](../../README.md#wiki)");
    expect(head, name).toContain("On this page");
    const tail = text.trimEnd().split("\n").pop() as string;
    expect(tail.includes("Next:") || tail.includes("Previous:"), `${name} ends with: ${tail}`).toBe(true);
    // every heading of the page is in its "On this page" list
    const intro = text.split("\n## ")[0] as string;
    for (const title of h2Titles(page)) expect(intro, `${name}: '${title}' is not in 'On this page'`).toContain(`(#${slug(title)})`);
  }
});
