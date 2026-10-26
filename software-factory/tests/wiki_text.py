"""The factory's README is a front page and the long text lives in wiki pages (#242). Tests that look for a phrase in the
documentation read it through here, so they do not care which page holds it."""
import glob
import os

SF = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
WIKI = os.path.join(SF, "docs", "wiki")


def readme_and_wiki(page=None):
    """The README and every wiki page as one text; with a page name such as "settings.md", only that page."""
    if page:
        with open(os.path.join(WIKI, page), encoding="utf-8") as f:
            return f.read()
    paths = [os.path.join(SF, "README.md")] + sorted(glob.glob(os.path.join(WIKI, "*.md")))
    out = []
    for path in paths:
        with open(path, encoding="utf-8") as f:
            out.append(f.read())
    return "\n".join(out)
