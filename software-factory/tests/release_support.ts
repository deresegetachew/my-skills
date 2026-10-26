// Shared pieces of the release client's tests (#113): a fake GitHub on 127.0.0.1 that serves real archives built by
// tools/build_release.ts (from tiny fake repos), the client run as a subprocess, and project helpers. Not a test file.
//
// The client runs with Bun.spawn (not spawnSync) so this process keeps answering the fake GitHub while it waits.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, relative } from "node:path";
import { build } from "../../tools/build_release.ts";
import { gzipFixed, tarCreate, type TarInput } from "../hooks/factory_tar.ts";
import { git as gitOk, HOOKS, sh, tmp } from "./support.ts";

export const CLIENT = join(HOOKS, "factory_release.ts");
export const PIN = join(".claude", "factory", "release.json");
export type Env = Record<string, string | undefined>;

export const FAKE_CI = `#!/usr/bin/env bash
# fake ci.sh {v}: records what the client asks, answers from flag files
echo "$*" >>"$FAKE_CI_LOG"
case "$1" in
  stale) [ -f "$FAKE_CI_STALE" ] && { echo "older compose.yaml"; exit 3; }; exit 0 ;;
  install) rm -f "$FAKE_CI_STALE"; exit 0 ;;
  check) [ -f "$FAKE_CI_BROKEN" ] && { echo "can't read entrypoint.sh: the runner container's user needs mode 644"; exit 1; }; exit 0 ;;
esac
`;

/** git with a user set; throws on a failure unless check is false. */
export function git(d: string, ...a: string[]): string {
  return gitOk(d, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a);
}

/** The files of a fake software-factory at `version`. A value of null in `files` leaves that file out. */
export function tree(version: string, files: Record<string, string | null> = {}): Record<string, string> {
  const base: Record<string, string | null> = {
    VERSION: version + "\n",
    "README.md": "readme\n",
    factory: "#!/usr/bin/env bash\n# factory " + version + "\necho factory\n",
    "factory-loop.sh": "#!/usr/bin/env bash\n# loop " + version + "\n",
    "hooks/factory_x.ts": `export const VERSION = "${version}";\n`,
    "hooks/factory_old.ts": "export const OLD = 1;\n",
    "ci/ci.sh": FAKE_CI.replace("{v}", version),
    "kit/.claude/agents/a.md": "agent " + version + "\n",
    "kit/.claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command",
      command: "bun --no-env-file \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/factory_x.ts" }] }] } }) + "\n",
    "kit/.claude/factory.json": "{}\n",
    "kit/docs/blocked.md": "# blocked\n",
    "kit/.gitignore": "tmp/\n",
    ...files,
  };
  return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== null));
}

/** Build a real release archive from a throwaway git repo shaped like my-skills; returns the dist folder. */
export function buildRelease(version: string, files: Record<string, string | null> = {}): string {
  const d = tmp();
  const t = tree(version, files);
  for (const [rel, body] of Object.entries(t)) {
    const p = join(d, "software-factory", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  for (const x of ["factory", "factory-loop.sh", "ci/ci.sh"]) chmodSync(join(d, "software-factory", x), 0o755);
  // the forwarders step 1 of #112 left at the old kit/ paths: the release packs them as files, and the client skips them
  symlinkSync("../factory", join(d, "software-factory", "kit", "factory"));
  for (const hook of ["factory_x.ts", "factory_x.py"]) {
    if (`hooks/${hook}` in t) {
      mkdirSync(join(d, "software-factory", "kit", ".claude", "hooks"), { recursive: true });
      symlinkSync(`../../../hooks/${hook}`, join(d, "software-factory", "kit", ".claude", "hooks", hook));
    }
  }
  git(d, "init", "-q", "-b", "main");
  git(d, "add", "-A", "-f");
  git(d, "commit", "-q", "-m", "release " + version);
  const out = tmp();
  build(d, out, "v" + version);
  return out;
}

interface FakeRelease {
  tag: string;
  date: string;
  body: string;
  pre: boolean;
}

/** GET /repos/<repo>/releases and /dl/<tag>/<asset>, like GitHub's API and download URLs. */
export class FakeGitHub {
  url = "";
  releases: FakeRelease[] = [];
  assets: Record<string, Record<string, Uint8Array>> = {};
  hits: string[] = [];
  corrupt = new Set<string>();
  truncate = new Set<string>();
  private server: Server;

  constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<FakeGitHub> {
    let fake: FakeGitHub | null = null;
    const server = createServer((sock) => fake?.serve(sock));
    fake = new FakeGitHub(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    fake.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    server.unref();
    return fake;
  }

  listing(): unknown[] {
    return this.releases.map((r) => ({
      tag_name: r.tag, name: r.tag, published_at: r.date, body: r.body, draft: false, prerelease: r.pre,
      assets: Object.keys(this.assets[r.tag] ?? {}).map((n) => ({
        name: n, browser_download_url: `${this.url}/dl/${r.tag}/${n}`, size: (this.assets[r.tag] as Record<string, Uint8Array>)[n]?.length,
      })),
    }));
  }

  add(version: string, o: { files?: Record<string, string | null>; date?: string; notes?: string; pre?: boolean;
    assets?: Record<string, Uint8Array> } = {}): string {
    const tag = "v" + version;
    let dist = "";
    if (o.assets) this.assets[tag] = o.assets;
    else {
      dist = buildRelease(version, o.files);
      this.assets[tag] = Object.fromEntries(readdirSync(dist).map((n) => [n, new Uint8Array(readFileSync(join(dist, n)))]));
    }
    const body = o.notes ?? `Software factory ${tag}.\n\nChanges:\n\n- change in ${version} (abc${version.replace(/\./g, "")})\n`;
    this.releases.unshift({ tag, date: o.date ?? "2026-11-01T10:00:00Z", body, pre: o.pre ?? false });
    return dist;
  }

  private serve(sock: Socket): void {
    let buf = "";
    sock.on("error", () => undefined);
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      const path = (buf.split(" ")[1] ?? "/");
      this.hits.push(path);
      this.answer(sock, path);
    });
  }

  private send(sock: Socket, code: number, body: Uint8Array, kind: string): void {
    sock.write(`HTTP/1.1 ${code} ${code === 200 ? "OK" : "Not Found"}\r\nContent-Type: ${kind}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
    sock.end(Buffer.from(body));
  }

  private answer(sock: Socket, full: string): void {
    const path = full.split("?")[0] as string;
    if (path.endsWith("/releases")) {
      const page = full.includes("page=1") || !full.includes("page=") ? 1 : 2;
      return this.send(sock, 200, new TextEncoder().encode(JSON.stringify(page === 1 ? this.listing() : [])), "application/json");
    }
    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    if (parts[0] === "dl") {
      const tag = parts[1] as string;
      const name = parts[2] as string;
      let data = (this.assets[tag] ?? {})[name];
      if (!data) return this.send(sock, 404, new TextEncoder().encode("{}"), "application/json");
      if (this.corrupt.has(name)) data = new Uint8Array([(data[0] as number) ^ 1, ...data.subarray(1)]);
      if (this.truncate.has(name)) {
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${data.length}\r\nConnection: close\r\n\r\n`);
        sock.write(Buffer.from(data.subarray(0, Math.floor(data.length / 2))), () => sock.destroy());
        return;
      }
      return this.send(sock, 200, data, "application/octet-stream");
    }
    this.send(sock, 404, new TextEncoder().encode("{}"), "application/json");
  }

  stop(): void {
    this.server.close();
  }
}

/** [fake github, an empty project with one commit, its environment]. */
export async function world(...versions: string[]): Promise<[FakeGitHub, string, Env]> {
  const gh = await FakeGitHub.start();
  versions.forEach((v, i) => gh.add(v, { date: i < 3 ? `2026-1${i}-01T10:00:00Z` : "2026-12-01T10:00:00Z" }));
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "README.md"), "project\n");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "start");
  const scratch = tmp();
  const env: Env = { ...process.env };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[k];
  Object.assign(env, {
    HOME: tmp(), FACTORY_RELEASE_API: gh.url, FACTORY_CACHE_DIR: join(scratch, "cache"),
    FAKE_CI_LOG: join(scratch, "ci.log"), FAKE_CI_STALE: join(scratch, "stale"), FAKE_CI_BROKEN: join(scratch, "broken"),
  });
  return [gh, d, env];
}

function clean(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Run a command without blocking this process (the fake GitHub lives here): [exit code, stdout + stderr]. */
export async function spawn(cmd: string[], cwd: string, env: Env): Promise<[number, string]> {
  const p = Bun.spawn(cmd, { cwd, env: clean(env), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(9), 120_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return [code, out + err];
}

/** The release client, run as `factory_release.ts <args>` in the project. */
export function fac(d: string, env: Env, ...args: string[]): Promise<[number, string]> {
  return spawn([process.execPath, "--no-env-file", CLIENT, ...args], d, env);
}

/** The client rewrites files with the archive's fixed times, often with the same size as the old version. Git trusts a
 * file whose size, times and inode are unchanged (inodes get reused), so on a busy machine `add -A` could miss the new
 * content. Emptying the index first makes it read every file again. */
export function commit(d: string, msg = "factory"): void {
  git(d, "rm", "-r", "--cached", "-q", "--ignore-unmatch", ".");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", msg);
}

export interface PinData {
  tag: string;
  version: string;
  sha256: string;
  previous: { tag: string } | null;
  files: Record<string, string>;
}

export function pin(d: string): PinData {
  return JSON.parse(readFileSync(join(d, PIN), "utf8")) as PinData;
}

/** Every file in the project (not .git) with its bytes and mode, to prove a refused command changed nothing. */
export function snapshot(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      if (n === ".git") continue;
      const p = join(dir, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isSymbolicLink()) {
        if (!statSync(p, { throwIfNoEntry: false })?.isDirectory()) out[relative(d, p)] = "link:" + readlinkSync(p); // os.walk lists a link to a folder as a folder
      } else out[relative(d, p)] = createHash("sha256").update(readFileSync(p)).digest("hex") + ":" + st.mode.toString(8);
    }
  };
  walk(d);
  return out;
}

export function ciLog(env: Env): string[] {
  try {
    return readFileSync(env.FAKE_CI_LOG as string, "utf8").split("\n");
  } catch {
    return [];
  }
}

export function cached(env: Env): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (lstatSync(p).isDirectory()) walk(p);
      else out.push(n);
    }
  };
  walk(env.FACTORY_CACHE_DIR as string);
  return out;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** An archive with exactly these members: [name, bytes (or a link's target), "file" | "link"]. */
export function rawTar(entries: [string, Uint8Array | string, "file" | "link"][]): Uint8Array {
  const items: TarInput[] = entries.map(([name, data, kind]) => kind === "link"
    ? { name, mode: 0o644, data: new Uint8Array(), symlink: data as string }
    : { name, mode: 0o644, data: typeof data === "string" ? new TextEncoder().encode(data) : data });
  return gzipFixed(tarCreate(items));
}

/** A release whose archive is `entries`, with a correct checksum for it. */
export function evilRelease(gh: FakeGitHub, entries: [string, Uint8Array | string, "file" | "link"][]): void {
  const archive = rawTar(entries);
  const sums = new TextEncoder().encode(`${sha256(archive)}  software-factory-6.6.6.tar.gz\n`);
  gh.add("6.6.6", { assets: { "software-factory-6.6.6.tar.gz": archive, SHA256SUMS: sums } });
}

/** A release that carries the real stack detector, both CI workflows and a pnpm factory.json template. */
export async function stackWorld(projectFiles: Record<string, string>): Promise<[FakeGitHub, string, Env]> {
  const [gh, d, env] = await world();
  gh.add("1.0.0", { files: {
    "kit/.github/workflows/ci.yml": "name: CI\n# pnpm template\n",
    "kit/.github/workflows/ci-python.yml.template": "name: CI\n# python template\n",
    "kit/.claude/factory.json": JSON.stringify({ commands: { install: "pnpm install", test: "pnpm -s test", build: "pnpm -s build" } }) + "\n",
  } });
  for (const [rel, body] of Object.entries(projectFiles)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  commit(d, "the project");
  return [gh, d, env];
}

export const UNITTEST_TESTS = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n";

/** Run a shell command in a folder (sh with cwd). */
export function shIn(d: string, ...cmd: string[]): ReturnType<typeof sh> {
  return sh(cmd, { cwd: d });
}
