#!/usr/bin/env python3
"""The README is a front page and the long text lives in wiki pages (#242). Every relative link and every heading anchor in
the README and the wiki pages resolves, every page has its navigation, and no heading of the old README was lost.
python3 software-factory/tests/test_wiki_links.py"""
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
WIKI = os.path.join(SF, "docs", "wiki")

# The `##` headings of the README before it became a front page, in their old order. "Contents" is now "Wiki".
OLD_HEADINGS = [
    "The idea in one picture", "Why it is built this way", "Who does what", "One task, start to finish",
    "What stops bad work", "Where the machines and GitHub meet", "Where things stand", "Contents", "Quick start",
    "Where things live", "Updating from releases", "The `factory` command", "Agent loops",
    "Roles: coding agent, dev manager, product owner", "Tasks", "Live agents (issues mode)", "Messages between agents",
    "Watch and talk to an agent: `factory follow`", "After a reboot: `factory autostart`", "Reviews and gates",
    "The dev manager", "CI: GitHub's runners or your own Mac", "A shared build cache",
    "A sandboxed machine: `factory bootstrap`", "Security notes", "Style guides", "factory.json settings",
    "The files in the kit", "Appendix: projects that use the submodule",
    "Installed as a submodule: what's shared and what's yours", "Updating the factory",
]
RENAMED = {"Contents": "Wiki"}


def pages():
    return [os.path.join(SF, "README.md")] + sorted(glob.glob(os.path.join(WIKI, "*.md")))


def lines_outside_fences(text):
    fenced = False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            yield line


def slug(title):
    """GitHub's anchor for a heading: lower case, formatting and punctuation dropped, spaces to hyphens."""
    title = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", title)
    title = title.replace("`", "").replace("*", "").strip().lower()
    return re.sub(r"[^\w\- ]", "", title).replace(" ", "-")


def anchors(path):
    """Every anchor a page offers: its headings (with GitHub's -1, -2 for repeats) and its <a id="..."> tags."""
    seen, found = {}, set()
    with open(path, encoding="utf-8") as f:
        text = f.read()
    for line in lines_outside_fences(text):
        m = re.match(r"^#{1,6}\s+(.*?)\s*#*$", line)
        if m:
            base = slug(m.group(1))
            n = seen.get(base, 0)
            seen[base] = n + 1
            found.add(base if n == 0 else f"{base}-{n}")
        found.update(re.findall(r'<a id="([^"]+)"', line))
    return found


def links(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    out = []
    for line in lines_outside_fences(text):
        line = re.sub(r"`[^`]*`", "", line)  # a link shown as code is not a link
        out += re.findall(r"\]\(([^)\s]+)\)", line)
    return out


def dead_links(paths):
    bad = []
    cache = {}
    for page in paths:
        for target in links(page):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target):
                continue
            file_part, _, frag = target.partition("#")
            dest = page if not file_part else os.path.normpath(os.path.join(os.path.dirname(page), file_part))
            if not os.path.exists(dest):
                bad.append(f"{os.path.relpath(page, SF)}: {target} (no such file)")
                continue
            if frag and dest.endswith(".md"):
                if dest not in cache:
                    cache[dest] = anchors(dest)
                if frag not in cache[dest]:
                    bad.append(f"{os.path.relpath(page, SF)}: {target} (no such heading)")
    return bad


def h2_titles(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return [m.group(1).strip() for line in lines_outside_fences(text) for m in [re.match(r"^## (.+)$", line)] if m]


def test_the_slug_follows_githubs_rules():
    assert slug("CI: GitHub's runners or your own Mac") == "ci-githubs-runners-or-your-own-mac"
    assert slug("A sandboxed machine: `factory bootstrap`") == "a-sandboxed-machine-factory-bootstrap"
    assert slug("factory.json settings") == "factoryjson-settings"


def test_every_relative_link_and_heading_anchor_in_the_readme_and_the_wiki_resolves():
    bad = dead_links(pages())
    assert not bad, "dead links:\n" + "\n".join(bad)


def test_the_wiki_has_pages_and_the_checker_would_notice_a_dead_link():
    assert glob.glob(os.path.join(WIKI, "*.md")), "docs/wiki/ has no pages"
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "a.md")
        with open(p, "w") as f:
            f.write("# A\n\n[x](#nope) [y](missing.md) [z](#a) [w](https://example.com/#q)\n```\n[v](#in-a-fence)\n```\n")
        bad = dead_links([p])
        assert len(bad) == 2 and any("#nope" in b for b in bad) and any("missing.md" in b for b in bad), bad


def test_every_h2_heading_of_the_old_readme_exists_in_exactly_one_place_now():
    where = {}
    for page in pages():
        for title in h2_titles(page):
            where.setdefault(title, []).append(os.path.relpath(page, SF))
    for old in OLD_HEADINGS:
        now = RENAMED.get(old, old)
        assert len(where.get(now, [])) == 1, f"{old!r} is in {where.get(now, [])}"


def test_the_front_page_is_short_and_lists_every_wiki_page_under_wiki():
    readme = os.path.join(SF, "README.md")
    with open(readme, encoding="utf-8") as f:
        text = f.read()
    assert text.count("\n") < 430, "the front page should be about 400 lines"
    assert "## Wiki" in text.split("\n")
    toc = text[text.index("\n## Wiki"):]
    toc = toc[:toc.index("\n## ", 5)]
    for page in sorted(glob.glob(os.path.join(WIKI, "*.md"))):
        assert f"docs/wiki/{os.path.basename(page)}" in toc, f"{os.path.basename(page)} is not in the README's wiki list"


def test_each_wiki_page_opens_with_a_title_a_way_back_and_on_this_page_and_ends_with_previous_and_next_links():
    for page in sorted(glob.glob(os.path.join(WIKI, "*.md"))):
        with open(page, encoding="utf-8") as f:
            text = f.read()
        name = os.path.basename(page)
        head = "\n".join(text.split("\n")[:12])
        assert text.startswith("# "), name
        assert "Back to the [wiki home](../../README.md#wiki)" in head, name
        assert "On this page" in head, name
        tail = text.rstrip().split("\n")[-1]
        assert "Next:" in tail or "Previous:" in tail, f"{name} ends with: {tail}"
        # every heading of the page is in its "On this page" list
        for title in h2_titles(page):
            assert f"(#{slug(title)})" in text.split("\n## ")[0], f"{name}: {title!r} is not in 'On this page'"


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
