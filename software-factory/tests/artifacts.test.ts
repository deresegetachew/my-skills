// The project's artifacts and designs as reviewed copies in the repo (#104): `factory artifacts pull|status|list` and
// the manifest. Runs the real factory in a throwaway project (a bare origin and a clone with the hooks copied in). The
// fetcher and the version lookup are fake commands (shell scripts the test writes), so nothing here talks to a network.
// (test_doctor_flags_a_copy_that_is_older_than_its_artifact_or_missing and
// test_a_role_reads_md_names_an_artifact_through_its_repo_copy stay in test_artifacts.py until factory_doctor is ported.)
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, type Proc, read, readJson, SF, sh, tmp, write, writeExe } from "./support.ts";

const URL = "https://claude.ai/artifact/SMWHUKAEcqo6VtbTzYrTZj";
const FETCH = '#!/bin/sh\n# usage: fetch <url> <out>   (the fake exporter)\nmkdir -p "$2"; printf "<h1>PRD v$VERSION</h1>" > "$2/index.html"; printf "body{}" > "$2/style.css"\n';
const INFO = '#!/bin/sh\necho "{\\"title\\": \\"MVP PRD\\", \\"updated\\": \\"$UPDATED\\", \\"version\\": \\"$VERSION\\"}"\n';
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

type Env = Record<string, string | undefined>;

function must(cmd: string[], cwd?: string): void {
  const p = sh(cmd, { cwd, env: { ...process.env, ...GIT_ENV } });
  if (p.code !== 0) throw new Error(`${cmd.join(" ")}: ${p.out}`);
}

/** A bare origin and a clone with the factory's hooks and command, as test_roles.project made it. */
function project(files: Record<string, string> = {}): [string, string, Env] {
  const d = tmp();
  const origin = join(d, "origin.git");
  const work = join(d, "work");
  must(["git", "init", "-q", "--bare", "-b", "main", origin]);
  must(["git", "clone", "-q", origin, work]);
  cpSync(HOOKS, join(work, ".claude", "hooks"), { recursive: true });
  for (const f of ["factory", "factory-loop.sh"]) cpSync(join(SF, f), join(work, f));
  write(join(work, ".claude", "factory.json"), JSON.stringify({ waitMinutes: 0, agents: ["menelik", "taytu"] }));
  write(join(work, "docs", "build-plan.md"), "# Plan\n\n- [ ] **1.1 First task**\n");
  write(join(work, "CLAUDE.md"), "rules\n");
  for (const [name, text] of Object.entries(files)) write(join(work, name), text);
  must(["git", "add", "-A"], work);
  must(["git", "commit", "-qm", "start"], work);
  const env: Env = { ...process.env, ...GIT_ENV, HOME: d, FACTORY_REMOTE_CONTROL: "0" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_ROLE", "FACTORY_NAME", "CLAUDE_PROJECT_DIR"]) delete env[k];
  return [d, work, env];
}

function artProject(o: { fetch?: boolean; info?: boolean; files?: Record<string, string> } = {}): [string, string, Env] {
  const [d, work, env] = project(o.files);
  const tools = join(d, "tools");
  writeExe(join(tools, "fetch.sh"), FETCH);
  writeExe(join(tools, "info.sh"), INFO);
  const cfgPath = join(work, ".claude", "factory.json");
  const cfg = readJson<Record<string, unknown>>(cfgPath);
  const art: Record<string, string> = {};
  if (o.fetch ?? true) art.fetch = `sh ${tools}/fetch.sh {url} {out}`;
  if (o.info ?? true) art.info = `sh ${tools}/info.sh {url}`;
  cfg.artifacts = art;
  write(cfgPath, JSON.stringify(cfg));
  return [d, work, { ...env, VERSION: "3", UPDATED: "2026-10-20T10:00:00Z" }];
}

function art(work: string, env: Env, args: string[], over: Env = {}): Proc {
  return sh(["bash", "./factory", "artifacts", ...args], { cwd: work, env: { ...env, ...over }, timeoutMs: 90_000 });
}

interface Entry {
  id: string; url: string; dest: string; title: string; updated: string; version: string; pulledBy: string; pulledAt: string;
  files: Record<string, string>;
}

function manifest(work: string): { artifacts: Entry[] } {
  return readJson(join(work, "docs", "artifacts.json"));
}

function error(p: Proc): { code: string; message: string; fix: string } {
  const lines = p.stderr.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string);
}

test("pull copies the published files and records where they came from", () => {
  const [, work, env] = artProject();
  const p = art(work, env, ["pull", URL, "docs/prd"]);
  expect(p.code, p.out).toBe(0);
  expect(read(join(work, "docs", "prd", "index.html"))).toBe("<h1>PRD v3</h1>");
  expect(existsSync(join(work, "docs", "prd", "style.css"))).toBe(true);
  const all = manifest(work).artifacts;
  expect(all.length).toBe(1);
  const e = all[0] as Entry;
  expect(e.id).toBe("SMWHUKAEcqo6VtbTzYrTZj");
  expect(e.url).toBe(URL);
  expect(e.dest).toBe("docs/prd");
  expect(e.title).toBe("MVP PRD");
  expect(e.updated).toBe("2026-10-20T10:00:00Z");
  expect(e.version).toBe("3");
  expect(new Set(Object.keys(e.files))).toEqual(new Set(["index.html", "style.css"]));
  expect((e.files["index.html"] as string).length).toBe(64);
  expect(e.pulledBy).toBeTruthy();
  expect(e.pulledAt.endsWith("Z")).toBe(true);
  expect(p.stdout).toContain("Review it and commit both");
});

test("pull takes a bare id and the default folder and pulling again replaces the copy", () => {
  const [, work, env] = artProject();
  expect(art(work, env, ["pull", "SMWHUKAEcqo6VtbTzYrTZj"]).code).toBe(0);
  expect(existsSync(join(work, "docs", "artifacts", "SMWHUKAEcqo6VtbTzYrTZj", "index.html"))).toBe(true);
  const p = art(work, env, ["pull", "https://claude.ai/code/artifact/SMWHUKAEcqo6VtbTzYrTZj?x=1"], { VERSION: "4" });
  expect(p.code, p.stderr).toBe(0);
  expect(read(join(work, "docs", "artifacts", "SMWHUKAEcqo6VtbTzYrTZj", "index.html"))).toContain("v4");
  expect(manifest(work).artifacts.length).toBe(1); // one entry per artifact
});

test("a copy edited by hand is not overwritten without force", () => {
  const [, work, env] = artProject();
  art(work, env, ["pull", URL, "docs/prd"]);
  const page = join(work, "docs", "prd", "index.html");
  write(page, read(page) + "<p>my edit</p>");
  const p = art(work, env, ["pull", URL, "docs/prd"], { VERSION: "4" });
  const e = error(p);
  expect(p.code).toBe(1);
  expect(e.code).toBe("edited-locally");
  expect(e.message).toContain("index.html");
  expect(e.fix).toContain("--force");
  expect(read(page)).toContain("my edit");
  const forced = art(work, env, ["pull", URL, "docs/prd", "--force"], { VERSION: "4" });
  expect(forced.code).toBe(0);
  expect(read(page)).not.toContain("my edit");
});

test("pull refuses a folder outside the project or one that holds other files", () => {
  const [, work, env] = artProject({ files: { "docs/other/readme.md": "x" } });
  for (const dest of ["../elsewhere", "/tmp/elsewhere", "."]) {
    const p = art(work, env, ["pull", URL, dest]);
    expect(p.code, dest).toBe(1);
    expect(error(p).code, dest).toBe("outside-project");
  }
  const p = art(work, env, ["pull", URL, "docs/other"]);
  expect(error(p).code).toBe("not-empty");
  expect(existsSync(join(work, "docs", "artifacts.json"))).toBe(false);
  const bad = art(work, env, ["pull", "not an artifact"]);
  expect(error(bad).code).toBe("not-an-artifact");
  expect(error(bad).fix).toContain("claude.ai/artifact");
});

test("without a fetcher pull says how to import an export made by hand", () => {
  const [d, work, env] = artProject({ fetch: false, info: false });
  const p = art(work, env, ["pull", URL, "docs/prd"]);
  const e = error(p);
  expect(p.code).toBe(1);
  expect(e.code).toBe("no-fetcher");
  expect(e.fix).toContain(`factory artifacts pull ${URL} docs/prd --from <folder>`);
  const exported = join(d, "export");
  write(join(exported, "page.html"), "<p>exported</p>");
  const ok = art(work, env, ["pull", URL, "docs/prd", "--from", exported, "--title", "MVP PRD", "--version", "7"]);
  expect(ok.code, ok.stderr).toBe(0);
  const all = manifest(work).artifacts;
  expect(all.length).toBe(1);
  const entry = all[0] as Entry;
  expect(entry.title).toBe("MVP PRD");
  expect(entry.version).toBe("7");
  expect(Object.keys(entry.files)).toEqual(["page.html"]);
  const empty = join(d, "empty");
  mkdirSync(empty);
  expect(error(art(work, env, ["pull", "ZZZzzz111", "docs/z", "--from", empty])).code).toBe("empty");
});

test("a failing fetcher leaves the project as it was", () => {
  const [, work, env] = artProject();
  const cfgPath = join(work, ".claude", "factory.json");
  const cfg = readJson<{ artifacts: Record<string, string> }>(cfgPath);
  cfg.artifacts.fetch = "sh -c 'echo no network >&2; exit 4' x {url} {out}";
  write(cfgPath, JSON.stringify(cfg));
  const p = art(work, env, ["pull", URL, "docs/prd"]);
  const e = error(p);
  expect(p.code).toBe(1);
  expect(e.code).toBe("fetch-failed");
  expect(e.message).toContain("no network");
  expect(existsSync(join(work, "docs", "prd"))).toBe(false);
  expect(existsSync(join(work, "docs", "artifacts.json"))).toBe(false);
});

test("dry run writes nothing", () => {
  const [, work, env] = artProject();
  const p = art(work, env, ["pull", URL, "docs/prd", "--dry-run"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("would copy 2 file(s)");
  expect(existsSync(join(work, "docs", "prd"))).toBe(false);
  expect(existsSync(join(work, "docs", "artifacts.json"))).toBe(false);
});

test("status says which copy is older than its artifact", () => {
  const [, work, env] = artProject();
  art(work, env, ["pull", URL, "docs/prd"]);
  const now = art(work, env, ["status"]);
  expect(now.code).toBe(0);
  expect(now.stdout).toContain("up to date");
  const newer = art(work, env, ["status"], { UPDATED: "2026-10-24T09:00:00Z", VERSION: "4" });
  expect(newer.stdout).toContain("OLDER than the artifact");
  expect(newer.stdout).toContain("docs/prd");
  const js = JSON.parse(art(work, env, ["status", "--json"], { VERSION: "4" }).stdout) as { state: string; dest: string }[];
  expect(js[0]?.state).toBe("older");
  expect(js[0]?.dest).toBe("docs/prd");
  const css = join(work, "docs", "prd", "style.css");
  write(css, read(css) + "x");
  expect(art(work, env, ["status"]).stdout).toContain("edited locally (style.css)");
  rmSync(join(work, "docs", "prd"), { recursive: true });
  expect(art(work, env, ["status"]).stdout).toContain("does not exist: pull it again");
});

test("status without a way to ask says it cannot tell", () => {
  const [, work, env] = artProject({ info: false });
  art(work, env, ["pull", URL, "docs/prd"]);
  const out = art(work, env, ["status"]).stdout;
  expect(out).toContain("can't tell whether the artifact changed");
  expect(out).not.toContain("OLDER");
});

test("list and an empty project", () => {
  const [, work, env] = artProject();
  expect(art(work, env, ["status"]).stdout).toContain("no artifacts are pulled into this project");
  art(work, env, ["pull", URL, "docs/prd"]);
  const out = art(work, env, ["list"]).stdout;
  expect(out).toContain("SMWHUKAEcqo6VtbTzYrTZj");
  expect(out).toContain("MVP PRD");
  expect(out).toContain("docs/prd");
});
