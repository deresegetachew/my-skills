#!/usr/bin/env python3
"""`factory artifacts` (#104): the project's artifacts and designs, as reviewed copies in the repo.

Artifacts (a PRD page, a design canvas, a design system) are where they are written. The **repo holds the reviewed copy**,
and the roles read that: a role's `reads.md` names the copy's path like any other document. This command brings a copy
into the project and keeps a manifest of where each came from, so anyone can tell which copy is older than its artifact.

  factory artifacts pull <url|id> [dest] [--from DIR] [--title T] [--version V] [--force] [--dry-run]
        copy the artifact's published files into the project (default dest: <artifacts.dir>/<id>) and record it in the
        manifest. The files come from `artifacts.fetch` (a command, below), or from DIR, an export made by hand.
  factory artifacts status [--json]     per copy: up to date, OLDER than its artifact, edited locally, missing, or can't tell
  factory artifacts list                the manifest

Two settings tell the factory how to reach an artifact; both are commands, empty by default, because how a terminal session
may read an artifact is not settled (see "Spike" in the README):
  artifacts.fetch   writes the artifact `{url}` into the folder `{out}`; exit 0 when it did
  artifacts.info    prints JSON {"title": ..., "updated": ..., "version": ...} for `{url}`; used by `status` and `doctor`
With neither, `pull --from DIR` imports an export, and `status` says it can't tell.

The manifest (`artifacts.manifest`, default docs/artifacts.json) is committed with the copies:
  {"version": 1, "artifacts": [{"id", "url", "title", "dest", "updated", "version", "pulledAt", "pulledBy", "files"}]}
`files` maps each file to its sha256, so a copy someone edited by hand is noticed and `pull` will not overwrite it without
--force. Errors are {code, message, fix} JSON on stderr, exit 1.
"""
import argparse, hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402
from factory_machine import refuse  # noqa: E402

URL_ID = re.compile(r"^(?:https?://)?(?:www\.)?claude\.ai/(?:code/)?artifact/([A-Za-z0-9][\w-]{2,80})/?(?:[?#].*)?$")
BARE_ID = re.compile(r"^[A-Za-z0-9][\w-]{2,80}$")
from factory_config import DEFAULTS as CONFIG_DEFAULTS  # noqa: E402
DEFAULTS = CONFIG_DEFAULTS["artifacts"]


def setting(cfg, key):
    return str(((cfg.get("artifacts") or {}).get(key)) or DEFAULTS[key])


def identify(text):
    """(id, url) from an artifact link or a bare id."""
    m = URL_ID.match((text or "").strip())
    if m:
        return m.group(1), text.strip().split("#")[0].split("?")[0].rstrip("/")
    if BARE_ID.match((text or "").strip()):
        return text.strip(), f"https://claude.ai/artifact/{text.strip()}"
    refuse("not-an-artifact", f"'{text}' is not an artifact link or id.",
           "Pass the link (https://claude.ai/artifact/<id>) or the id.")


def inside(path):
    """The path under the project, else refuse: a copy never lands outside the repo."""
    root = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(root, path))
    if os.path.isabs(path) or full == root or not full.startswith(root + os.sep):
        refuse("outside-project", f"'{path}' is not a folder inside the project.", "Pick a relative folder such as docs/artifacts/prd.")
    return full


def read_manifest(cfg):
    path = setting(cfg, "manifest")
    if not os.path.isfile(path):
        return {"version": 1, "artifacts": []}
    try:
        data = json.load(open(path, encoding="utf-8"))
        assert isinstance(data.get("artifacts"), list)
        return data
    except (ValueError, AssertionError, AttributeError):
        refuse("bad-manifest", f"{path} is not a valid artifacts manifest.", "Fix the JSON, or delete it and pull the copies again.")


def write_manifest(cfg, data):
    path = setting(cfg, "manifest")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    data["artifacts"] = sorted(data["artifacts"], key=lambda a: a["id"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")


def digest(folder):
    """{relative file: sha256} for every file under folder."""
    out = {}
    for base, _, names in os.walk(folder):
        for n in names:
            full = os.path.join(base, n)
            out[os.path.relpath(full, folder).replace(os.sep, "/")] = hashlib.sha256(open(full, "rb").read()).hexdigest()
    return out


def run_command(template, url, out=""):
    """Runs a configured command with {url} and {out} filled in (quoted). Returns (exit code, stdout)."""
    cmd = template.replace("{url}", shlex.quote(url)).replace("{out}", shlex.quote(out))
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout, p.stderr.strip()


def info(cfg, url):
    """{"title", "updated", "version"} from `artifacts.info`, or None when it isn't set or doesn't answer."""
    cmd = setting(cfg, "info")
    if not cmd:
        return None
    try:
        rc, out, _ = run_command(cmd, url)
        data = json.loads(out) if rc == 0 else None
    except (ValueError, subprocess.TimeoutExpired, OSError):
        return None
    return data if isinstance(data, dict) else None


def who():
    return os.environ.get("FACTORY_AGENT") or os.environ.get("USER") or "unknown"


def now_iso():
    import factory_clock
    return datetime.fromtimestamp(factory_clock.now(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_edits(entry):
    """The files under the copy that differ from what was pulled (changed, added or removed)."""
    if not os.path.isdir(entry["dest"]):
        return None
    have, was = digest(entry["dest"]), entry.get("files") or {}
    return sorted(f for f in set(have) | set(was) if have.get(f) != was.get(f))


def pull(cfg, a):
    aid, url = identify(a.artifact)
    dest = a.dest or f"{setting(cfg, 'dir')}/{aid}"
    full = inside(dest)
    manifest = read_manifest(cfg)
    entry = next((e for e in manifest["artifacts"] if e["id"] == aid), None)
    if entry and entry["dest"] != dest:
        refuse("moved", f"{aid} is already in the project at {entry['dest']}.", f"Pull it there, or remove its entry from {setting(cfg, 'manifest')} first.")
    if entry and not a.force and local_edits(entry):
        refuse("edited-locally", f"The copy at {dest} was edited since it was pulled ({', '.join(local_edits(entry)[:3])}).",
               "Keep your edits by putting them in the artifact, or pull again with --force to replace the copy.")
    if not entry and os.path.exists(full) and os.listdir(full) and not a.force:
        refuse("not-empty", f"{dest} already has files that are not a pulled copy.", "Pick an empty folder, or use --force.")
    tmp = tempfile.mkdtemp(prefix="factory-artifact-")
    try:
        if a.from_dir:
            if not os.path.isdir(a.from_dir):
                refuse("no-export", f"{a.from_dir} is not a folder.", "Export the artifact's files into a folder and pass it with --from.")
            shutil.copytree(a.from_dir, tmp, dirs_exist_ok=True)
        elif setting(cfg, "fetch"):
            rc, _, err = run_command(setting(cfg, "fetch"), url, tmp)
            if rc != 0:
                refuse("fetch-failed", f"artifacts.fetch failed for {url}: {err[:200] or 'exit ' + str(rc)}.",
                       "Run the command by hand to see why, or export the artifact and use --from <folder>.")
        else:
            refuse("no-fetcher", "This project has no way to fetch an artifact yet (artifacts.fetch is empty).",
                   "Export the artifact's published files into a folder and run: factory artifacts pull "
                   f"{url} {dest} --from <folder>")
        files = digest(tmp)
        if not files:
            refuse("empty", "The export has no files.", "Check that the artifact was exported, then try again.")
        meta = info(cfg, url) or {}
        row = {"id": aid, "url": url, "title": a.title or meta.get("title") or (entry or {}).get("title") or aid, "dest": dest,
               "updated": meta.get("updated") or a.updated or "", "version": str(meta.get("version") or a.version or ""),
               "pulledAt": now_iso(), "pulledBy": who(), "files": files}
        if a.dry_run:
            print(f"would copy {len(files)} file(s) of {aid} into {dest} and record it in {setting(cfg, 'manifest')}")
            return
        if os.path.isdir(full):
            shutil.rmtree(full)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        shutil.copytree(tmp, full)
        manifest["artifacts"] = [e for e in manifest["artifacts"] if e["id"] != aid] + [row]
        write_manifest(cfg, manifest)
        print(f"pulled {aid} into {dest} ({len(files)} file(s)); recorded in {setting(cfg, 'manifest')}. "
              "Review it and commit both in a pull request.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def judge(cfg, entry):
    """(state, detail) for one copy: missing, edited, older, current or unknown."""
    if not os.path.isdir(entry["dest"]):
        return "missing", f"{entry['dest']} does not exist: pull it again"
    edits = local_edits(entry)
    if edits:
        return "edited", f"edited locally ({', '.join(edits[:3])}{', ...' if len(edits) > 3 else ''})"
    meta = info(cfg, entry["url"])
    if not meta or not (meta.get("updated") or meta.get("version")):
        return "unknown", "can't tell whether the artifact changed (artifacts.info is not set or did not answer)"
    newer = (meta.get("updated") and entry.get("updated") and str(meta["updated"]) > str(entry["updated"])) or \
            (meta.get("version") and entry.get("version") and str(meta["version"]) != str(entry["version"]))
    if newer:
        return "older", f"OLDER than the artifact (pulled {entry['pulledAt']}, artifact updated {meta.get('updated') or meta.get('version')})"
    return "current", "up to date"


def status(cfg, a):
    rows = [dict(entry, state=judge(cfg, entry)) for entry in read_manifest(cfg)["artifacts"]]
    if a.json:
        print(json.dumps([{"id": r["id"], "dest": r["dest"], "state": r["state"][0], "detail": r["state"][1]} for r in rows], indent=2))
    else:
        print("\n".join(f"{r['id']:<28} {r['dest']:<36} {r['state'][1]}" for r in rows) or "no artifacts are pulled into this project")


def listing(cfg):
    for e in read_manifest(cfg)["artifacts"]:
        print(f"{e['id']:<28} {e['dest']:<36} {e['title']}  (pulled {e['pulledAt']} by {e['pulledBy']})")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="factory artifacts", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pull")
    p.add_argument("artifact")
    p.add_argument("dest", nargs="?")
    p.add_argument("--from", dest="from_dir")
    p.add_argument("--title")
    p.add_argument("--version")
    p.add_argument("--updated")
    p.add_argument("--force", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    s = sub.add_parser("status")
    s.add_argument("--json", action="store_true")
    sub.add_parser("list")
    a = ap.parse_args(argv)
    cfg = load()
    {"pull": lambda: pull(cfg, a), "status": lambda: status(cfg, a), "list": lambda: listing(cfg)}[a.cmd]()


if __name__ == "__main__":
    main()
