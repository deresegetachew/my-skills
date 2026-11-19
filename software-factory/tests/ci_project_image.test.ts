// The project image (ci.projectImage): project-image.sh, which the runner loop starts before each job, and
// project.Dockerfile. What is checked: what GitHub and docker were asked (fakes on PATH), the label that decides a
// rebuild, what a failed build leaves behind and logs, and the modes of what it writes. `ci.test.ts` covers the
// setting, the install and the loop. No real Docker or network is used.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SF, sh, tmp, writeExe } from "./support.ts";

const SCRIPT = join(SF, "ci", "project-image.sh");
const DOCKERFILE = join(SF, "ci", "project.Dockerfile");

// $FAKE/tree.json is the default branch's root tree; $FAKE/blobs/<sha> a file's bytes. --jq runs real jq, as gh does.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >>"$FAKE/gh.log"
[ ! -e "$FAKE/gh-down" ] || { echo "error connecting to api.github.com" >&2; exit 1; }
[ "$1" = api ] || exit 1
shift
jq=""; path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq="$2"; shift 2 ;;
    -H) shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
case "$path" in
  repos/acme/Widget/git/trees/HEAD) jq -r "$jq" "$FAKE/tree.json" ;;
  repos/acme/Widget/git/blobs/*) cat "$FAKE/blobs/\${path##*/}" ;;
  *) echo "fake gh: no answer for $path" >&2; exit 1 ;;
esac
`;

// An image is a file: $FAKE/images/<tag> holds its factory.project-key label ($FAKE/base-id is the base's id).
// A build that works writes that file, as `docker build --tag` tags only on success, and keeps a copy of its context.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE/docker.log"
img() { echo "$FAKE/images/\${1//[:\\/]/_}"; }
case "$1 $2" in
  "image inspect")
    last="\${@: -1}"
    case "$*" in
      *"{{.Id}}"*) [ -f "$FAKE/base-id" ] && [ "$last" = widget-ci-runner:latest ] || exit 1; cat "$FAKE/base-id" ;;
      *) [ -f "$(img "$last")" ] || exit 1; cat "$(img "$last")" ;;
    esac ;;
  "image prune") ;;
  build\\ *)
    ctx="\${@: -1}"; tag=""; key=""; prev=""
    for a in "$@"; do
      [ "$prev" = --tag ] && tag="$a"
      case "$a" in factory.project-key=*) key="\${a#factory.project-key=}" ;; esac
      prev="$a"
    done
    rm -rf "$FAKE/context"; cp -Rp "$ctx" "$FAKE/context"
    if [ -e "$FAKE/build-fails" ]; then echo "#7 ERROR: pnpm fetch: getaddrinfo EAI_AGAIN registry.npmjs.org" >&2; exit 1; fi
    mkdir -p "$FAKE/images"; echo "$key" >"$(img "$tag")"; echo "sha256:new" ;;
esac
exit 0
`;

interface World {
  fake: string;
  state: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

/** The git hash of a file's bytes, as GitHub lists it in a tree. */
function blobSha(text: string): string {
  const f = join(tmp(), "blob");
  writeFileSync(f, text);
  return sh(["git", "hash-object", f]).stdout.trim();
}

/** What main holds: the files at the root of its tree. A folder and another file are there too, and never asked for. */
function setMain(w: World, files: Record<string, string>): void {
  const tree: { path: string; type: string; sha: string }[] = [
    { path: "package.json", type: "blob", sha: blobSha("{}") },
    { path: "pnpm-lock.yaml", type: "tree", sha: "a".repeat(40) }, // a folder with that name is not the lockfile
  ];
  mkdirSync(join(w.fake, "blobs"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const sha = blobSha(text);
    writeFileSync(join(w.fake, "blobs", sha), text);
    tree.push({ path, type: "blob", sha });
  }
  writeFileSync(join(w.fake, "tree.json"), JSON.stringify({ tree: tree.filter((t) => t.type === "blob" || !(t.path in files)) }));
}

function world(files: Record<string, string> = { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# main\n" }): World {
  const root = tmp();
  const [fake, state, bin, cwd] = ["fake", "state", "bin", "checkout"].map((n) => join(root, n)) as [string, string, string, string];
  for (const d of [fake, state, bin, cwd]) mkdirSync(d);
  writeExe(join(bin, "gh"), FAKE_GH);
  writeExe(join(bin, "docker"), FAKE_DOCKER);
  writeFileSync(join(fake, "base-id"), "sha256:base1\n");
  // The checkout the service happens to sit in holds a pull request's lockfile: it must never be what is built.
  writeFileSync(join(cwd, "pnpm-lock.yaml"), "# a pull request's lockfile\n");
  writeFileSync(join(cwd, "package.json"), '{"scripts": {"postinstall": "curl evil"}}');
  const w: World = { fake, state, cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE: fake,
    CI_NAME: "widget-ci", RUNNER_REPO: "acme/Widget", CI_STATE: state, RUNNER_IMAGE: "widget-ci-runner:latest" } };
  delete w.env.CI_PROJECT_RETRY_MINUTES;
  setMain(w, files);
  return w;
}

function run(w: World, extra: Record<string, string> = {}): { code: number; out: string } {
  const p = sh(["/bin/bash", SCRIPT], { cwd: w.cwd, env: { ...w.env, ...extra }, timeoutMs: 60_000 });
  return { code: p.code, out: p.stdout + p.stderr };
}

function logOf(w: World, what: "gh" | "docker"): string[] {
  try {
    return readFileSync(join(w.fake, `${what}.log`), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const builds = (w: World): string[] => logOf(w, "docker").filter((l) => l.startsWith("build "));
const mode = (path: string): number => statSync(path).mode & 0o777;
const builtKey = (w: World): string => readFileSync(join(w.fake, "images", "widget-ci-runner_project"), "utf8").trim();

/** The {code, message, fix} lines in a run's output (each after the log's timestamp). */
function errors(out: string): { code: string; message: string; fix: string }[] {
  return out.split("\n").filter((l) => l.includes('{"code"')).map((l) => JSON.parse(l.slice(l.indexOf("{"))) as { code: string; message: string; fix: string });
}

test("the first round builds the image from mains lockfile only and labels it with the lockfiles hash", () => {
  const lockfile = "lockfileVersion: '9.0'\n# main\n";
  const w = world({ "pnpm-lock.yaml": lockfile, "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n" });
  const r = run(w);
  expect(r.code, r.out).toBe(0);
  const b = builds(w);
  expect(b.length).toBe(1);
  const sha = blobSha(lockfile);
  for (const part of ["--tag widget-ci-runner:project", `--file ${DOCKERFILE}`, "--build-arg BASE_IMAGE=widget-ci-runner:latest",
    `--label factory.lockfile=${sha}`, "--label factory.project=widget-ci",
    `--label factory.project-key=sha256:base1/${sha}/${blobSha("packages:\n  - 'apps/*'\n")}/none`]) {
    expect(b[0], part).toContain(part);
  }
  // The context docker was given: main's two files and nothing else. No package.json, so no script could run, and
  // not the checkout's lockfile.
  const context = join(w.fake, "context");
  expect(readdirSync(context).sort()).toEqual(["pnpm-lock.yaml", "pnpm-workspace.yaml"]);
  expect(readFileSync(join(context, "pnpm-lock.yaml"), "utf8")).toBe(lockfile);
  // Private to the loop's user: docker's client reads the context as that user (#111: the modes the reader needs).
  expect(mode(context)).toBe(0o700);
  expect(mode(join(context, "pnpm-lock.yaml"))).toBe(0o600);
  // GitHub was asked for the default branch's tree and those two files by hash; nothing else.
  const gh = logOf(w, "gh");
  expect(gh.length).toBe(3);
  expect(gh[0]).toContain("api repos/acme/Widget/git/trees/HEAD");
  expect(gh.slice(1).every((l) => l.includes("repos/acme/Widget/git/blobs/"))).toBe(true);
  expect(r.out).toContain(`built widget-ci-runner:project for main's lockfile ${sha.slice(0, 12)}`);
  // Nothing half done is left: no context folder, no lock.
  expect(readdirSync(w.state)).toEqual([]);
});

test("the same lockfile is not built again and a new one on main is", () => {
  const w = world();
  expect(run(w).code).toBe(0);
  const again = run(w);
  expect(again.code, again.out).toBe(0);
  expect(builds(w).length).toBe(1);
  expect(again.out).toBe(""); // nothing to say when it is up to date
  expect(logOf(w, "gh").filter((l) => l.includes("/git/blobs/")).length).toBe(1); // and nothing downloaded again
  const first = builtKey(w);

  setMain(w, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# main, one package newer\n" });
  expect(run(w).code).toBe(0);
  expect(builds(w).length).toBe(2);
  expect(builtKey(w)).not.toBe(first);
  expect(builds(w)[1]).toContain(`factory.lockfile=${blobSha("lockfileVersion: '9.0'\n# main, one package newer\n")}`);
  expect(run(w).code).toBe(0);
  expect(builds(w).length).toBe(2);
});

test("a new base image or a new npmrc on main also rebuilds", () => {
  const w = world();
  expect(run(w).code).toBe(0);
  writeFileSync(join(w.fake, "base-id"), "sha256:base2\n"); // `factory ci install` rebuilt the runner image
  expect(run(w).code).toBe(0);
  expect(builds(w).length).toBe(2);
  expect(builtKey(w).startsWith("sha256:base2/")).toBe(true);
  setMain(w, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# main\n", ".npmrc": "registry=https://registry.npmjs.org/\n" });
  expect(run(w).code).toBe(0);
  expect(builds(w).length).toBe(3);
  expect(readdirSync(join(w.fake, "context")).sort()).toEqual([".npmrc", "pnpm-lock.yaml"]);
  expect(run(w).code).toBe(0);
  expect(builds(w).length).toBe(3);
});

test("a failed build keeps the last good image and logs one code message fix line", () => {
  const w = world();
  expect(run(w).code).toBe(0);
  const good = builtKey(w);
  setMain(w, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# main, newer\n" });
  writeFileSync(join(w.fake, "build-fails"), "");
  const failed = run(w);
  expect(failed.code).toBe(1);
  expect(builtKey(w)).toBe(good); // the tag still names the last good image
  const errs = errors(failed.out);
  expect(errs.length).toBe(1);
  expect(errs[0]?.code).toBe("project_image_build_failed");
  expect(errs[0]?.message).toContain("getaddrinfo EAI_AGAIN");
  expect(errs[0]?.message).toContain("the last one that built (widget-ci-runner:project)");
  expect(errs[0]?.fix).toContain("docker build --file");
  expect(readdirSync(w.state)).toEqual(["project-image.failed"]); // no context folder or lock left

  // The next rounds don't hammer the registry or the log: the same failed build waits its ten minutes.
  const quiet = run(w);
  expect(quiet.code).toBe(1);
  expect(quiet.out).toBe("");
  expect(builds(w).length).toBe(2);
  // After the wait (0: no wait) it is tried again, and once it builds the failure is forgotten.
  expect(run(w, { CI_PROJECT_RETRY_MINUTES: "0" }).code).toBe(1);
  expect(builds(w).length).toBe(3);
  rmSync(join(w.fake, "build-fails"));
  const fixed = run(w, { CI_PROJECT_RETRY_MINUTES: "0" });
  expect(fixed.code, fixed.out).toBe(0);
  expect(builtKey(w)).not.toBe(good);
  expect(readdirSync(w.state)).toEqual([]);
});

test("a first build that fails says the runners use the base image", () => {
  const w = world();
  writeFileSync(join(w.fake, "build-fails"), "");
  const r = run(w);
  expect(r.code).toBe(1);
  expect(errors(r.out)[0]?.message).toContain("The runners use widget-ci-runner:latest");
  expect(existsSync(join(w.fake, "images", "widget-ci-runner_project"))).toBe(false);
});

test("no lockfile on main, github down or a broken download build nothing and say what to do", () => {
  let w = world({ "pnpm-workspace.yaml": "packages: []\n" });
  let r = run(w);
  expect(r.code).toBe(1);
  expect(errors(r.out)[0]?.code).toBe("project_image_no_lockfile");
  expect(errors(r.out)[0]?.fix).toContain("factory settings set ci.projectImage false");
  expect(builds(w)).toEqual([]);

  w = world();
  writeFileSync(join(w.fake, "gh-down"), "");
  r = run(w);
  expect(r.code).toBe(1);
  expect(errors(r.out)[0]?.code).toBe("project_image_github");
  expect(errors(r.out)[0]?.fix).toContain("gh auth status");
  expect(builds(w)).toEqual([]);

  // The bytes that arrive are not the file GitHub listed (a cut connection, or anything else): not built.
  w = world();
  const sha = blobSha("lockfileVersion: '9.0'\n# main\n");
  writeFileSync(join(w.fake, "blobs", sha), "lockfileVersion: '9.0'\n# ma");
  r = run(w);
  expect(r.code).toBe(1);
  expect(errors(r.out)[0]?.code).toBe("project_image_github");
  expect(errors(r.out)[0]?.message).toContain("git hash doesn't match");
  expect(builds(w)).toEqual([]);
  expect(readdirSync(w.state)).toEqual(["project-image.failed"]);
});

test("without the runner image there is nothing to build on", () => {
  const w = world();
  rmSync(join(w.fake, "base-id"));
  const r = run(w);
  expect(r.code).toBe(1);
  expect(errors(r.out)[0]?.code).toBe("project_image_no_base");
  expect(errors(r.out)[0]?.fix).toContain("factory ci install");
  expect(logOf(w, "gh")).toEqual([]);
  expect(builds(w)).toEqual([]);
});

test("only one loop builds at a time and a lock left by a killed loop is cleared", () => {
  const w = world();
  const lock = join(w.state, "project-image.lock");
  mkdirSync(lock);
  const r = run(w);
  expect(r.code).toBe(0);
  expect(r.out).toBe("");
  expect(logOf(w, "gh")).toEqual([]);
  expect(logOf(w, "docker")).toEqual([]);
  expect(existsSync(lock)).toBe(true); // the other loop's lock is left alone
  const old = new Date(Date.now() - 2 * 3600_000);
  utimesSync(lock, old, old);
  expect(run(w).code).toBe(0);
  expect(builds(w).length).toBe(1);
  expect(existsSync(lock)).toBe(false);
});

test("the dockerfile fetches without scripts and leaves the store to root read only for the jobs user", () => {
  const text = readFileSync(DOCKERFILE, "utf8");
  const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
  const stages = lines.filter((l) => l.startsWith("FROM "));
  expect(stages).toEqual(["FROM ${BASE_IMAGE} AS fetch", "FROM ${BASE_IMAGE}"]);
  const final = lines.slice(lines.indexOf("FROM ${BASE_IMAGE}"));
  const fetch = lines.slice(0, lines.indexOf("FROM ${BASE_IMAGE}"));
  expect(fetch.join("\n")).toContain("pnpm fetch --ignore-scripts --store-dir");
  expect(fetch.join("\n")).toContain("go-w");
  // Nothing runs in the final stage: it only copies the store, where remanual-style workflows look for it.
  expect(final.some((l) => l.startsWith("RUN "))).toBe(false);
  expect(final).toContain("COPY --from=fetch --chown=root:root /tmp/factory-store/ /opt/factory-ci/cache/pnpm-store/");
  expect(final.at(-1)).toBe("USER runner");
  expect(lines.join("\n")).not.toMatch(/pnpm install|npm install/);
});

test("the wiki says how the project image is built and why a job cannot poison it", () => {
  const page = readFileSync(join(SF, "docs", "wiki", "ci.md"), "utf8");
  for (const part of ["ci.projectImage", "/opt/factory-ci/cache/pnpm-store", "--ignore-scripts", "factory.lockfile", "project_image_build_failed"]) {
    expect(page, part).toContain(part);
  }
});
