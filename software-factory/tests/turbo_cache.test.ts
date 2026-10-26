// The shared self-hosted Turborepo remote cache (#59): the compose file, `factory turbo`, the environment agents and
// CI get, and what happens without a token or when the cache is down.
//
// Docker cannot run in the tests, so the compose file is checked as text and `docker` and `gh` are fakes on PATH that
// log what they were given. The cache itself is a small HTTP server (its own process) that answers like the real
// one's /v8/artifacts/status. The token below is made up for the test; it must never show up in any output, argument
// or log.
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CI, KIT, read, readmeAndWiki, runHook, SF, sh, type Proc, tmp, write, writeExe } from "./support.ts";

const COMPOSE = join(CI, "compose-turbo.yaml");
const TOKEN = "tkn-7f3a9c1e5b2d4f60a8c9e1d3b5f7a901";
const SIGKEY = "sig-0123456789abcdef0123456789abcdef0123";

// ---------- a fake cache ----------
const CACHE = String.raw`import { appendFileSync } from "node:fs";
const token = process.argv[2]; const log = process.argv[3] as string;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const u = new URL(req.url); const auth = req.headers.get("authorization");
  appendFileSync(log, JSON.stringify([u.pathname + u.search, auth]) + "\n");
  const ok = auth === "Bearer " + token && u.pathname.startsWith("/v8/artifacts/status");
  return new Response(ok ? '{"status":"enabled"}' : '{"message":"no"}', { status: ok ? 200 : 401 });
} });
console.log(server.port);
`;

interface Cache { url: string; seen(): [string, string | null][]; stop(): void }
const servers: Cache[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

function serve(): Cache {
  const d = tmp();
  const script = write(join(d, "cache.ts"), CACHE);
  const log = join(d, "seen.log");
  const portFile = join(d, "port");
  write(log, "");
  const p = Bun.spawn(["sh", "-c", 'exec "$0" --no-env-file "$1" "$2" "$3" > "$4"', process.execPath, script, TOKEN, log, portFile],
    { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 10_000;
  while (!(existsSync(portFile) && read(portFile).includes("\n")) && Date.now() < deadline) Bun.sleepSync(20);
  const port = Number(read(portFile).trim());
  const cache: Cache = { url: `http://127.0.0.1:${port}`, stop: () => p.kill(9),
    seen: () => read(log).trim().split("\n").filter((l) => l).map((l) => JSON.parse(l) as [string, string | null]) };
  servers.push(cache);
  return cache;
}

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.docker"
[ "\${TURBO_TOKEN:-}" = "$EXPECT_TOKEN" ] && echo "token-in-env" >>"$FAKE_LOG.docker"
echo "bind=\${TURBO_CACHE_BIND:-} port=\${TURBO_CACHE_PORT:-}" >>"$FAKE_LOG.docker"
[ "\${FAKE_DOCKER_DOWN:-0}" = 1 ] && [ "$1" = info ] && exit 1
exit 0
`;
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.gh"
case "$1 $2" in
  "secret set") echo "stdin:$(cat)" >>"$FAKE_LOG.gh-stdin" ;;
esac
[ "\${FAKE_GH_FAILS:-0}" = 1 ] && { echo "HTTP 403: Resource not accessible" >&2; exit 1; }
exit 0
`;

type Env = Record<string, string | undefined>;

function project(turbo: Record<string, unknown> | null = null, remote = "git@github.com:acme/Widget.git"): [string, Env] {
  const root = tmp();
  const d = join(root, "work");
  const bin = join(root, "bin");
  sh(["git", "init", "-q", "-b", "main", d]);
  sh(["git", "-C", d, "remote", "add", "origin", remote]);
  const cfg: Record<string, unknown> = {};
  if (turbo !== null) cfg.turbo = turbo;
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  writeExe(join(bin, "docker"), FAKE_DOCKER);
  writeExe(join(bin, "gh"), FAKE_GH);
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!["TURBO_", "FACTORY_", "GITHUB_", "CLAUDE"].some((p) => k.startsWith(p))) env[k] = v;
  }
  // The test runner's own machine-wide folders stay (they keep a test from writing to the real ones).
  for (const k of ["FACTORY_CONFIG_DIR", "FACTORY_CLAIM_SETTLE_SECONDS"]) env[k] = process.env[k];
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, HOME: root, FAKE_LOG: join(root, "log"), EXPECT_TOKEN: TOKEN,
    FACTORY_TURBO_WAIT: "2" });
  return [d, env];
}

function turbo(d: string, env: Env, args: string[], extra: Env = {}): Proc {
  return runHook("factory_turbo", args, { cwd: d, env: { ...env, ...extra }, timeoutMs: 60_000 });
}

function log(env: Env, suffix: string): string {
  try {
    return read((env.FAKE_LOG as string) + suffix);
  } catch {
    return "";
  }
}

function nowhereLeaks(p: Proc, env: Env): void {
  const everything = p.stdout + p.stderr + log(env, ".docker") + log(env, ".gh");
  expect(everything).not.toContain(TOKEN); // a secret was printed or passed as an argument
  expect(everything).not.toContain(SIGKEY);
}

function exportsOf(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/^export (\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
}

// ---------- the compose file ----------
test("the compose file pins the image and listens on loopback unless told otherwise", () => {
  const text = read(COMPOSE);
  const image = (/image:\s*(\S+)/.exec(text) as RegExpExecArray)[1] as string;
  expect(image.startsWith("ducktors/turborepo-remote-cache:")).toBe(true);
  expect(image).toMatch(/:\$\{TURBO_CACHE_VERSION:-\d+\.\d+\.\d+\}$/); // a pinned version, never latest
  expect(text).toContain("${TURBO_CACHE_BIND:-127.0.0.1}"); // reachable only where the owner chose: loopback by default
  expect(text).not.toContain("0.0.0.0");
});

test("the compose file takes the token from the environment and holds none", () => {
  const text = read(COMPOSE);
  expect(text).toMatch(/TURBO_TOKEN:\s*['"]?\$\{TURBO_TOKEN:\?[^}]+\}/); // required, with a message, never a value
  expect(text).not.toMatch(/TURBO_TOKEN:\s*['"]?[A-Za-z0-9]{8,}/);
});

test("the compose file is a small unprivileged service with a named volume and nothing mounted from the host", () => {
  const text = read(COMPOSE);
  expect(text).toContain("restart: unless-stopped"); // it comes back after a reboot
  for (const bad of ["privileged", "network_mode", "pid: host", "/var/run/docker.sock"]) expect(text).not.toContain(bad);
  expect(text).not.toMatch(/^\s*-\s*['"]?(\.|~|\/[^:\s]*:)/m); // no bind mounts: ci.sh would have to copy them (#111's class)
  expect(text).toMatch(/^\s*-\s*turbo-cache-data:\/data/m);
  expect(text).toContain("STORAGE_PROVIDER: local");
  for (const w of ["cap_drop", "no-new-privileges", "read_only: true"]) expect(text).toContain(w);
});

// ---------- settings and defaults ----------
test("the template factory json has the turbo block with no secret in it", () => {
  const cfg = JSON.parse(read(join(KIT, ".claude", "factory.json"))) as { turbo: Record<string, unknown> };
  expect(Object.keys(cfg.turbo).sort()).toEqual(["api", "bind", "port", "secretsCommand", "team"]);
  expect(cfg.turbo.api).toBe(""); // off until the owner sets an address
  expect(cfg.turbo.bind).toBe("127.0.0.1");
});

// ---------- what agent sessions get ----------
test("nothing is printed while the cache is not set up", () => {
  const [d, env] = project();
  const p = turbo(d, env, ["env"]);
  expect([p.code, p.stdout, p.stderr]).toEqual([0, "", ""]);
});

test("agents get the cache address team token and signature key when it answers", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  const p = turbo(d, env, ["env"], { TURBO_TOKEN: TOKEN, TURBO_REMOTE_CACHE_SIGNATURE_KEY: SIGKEY });
  expect(p.code, p.out).toBe(0);
  const got = exportsOf(p.stdout);
  expect(got.TURBO_API).toBe(cache.url);
  expect(got.TURBO_TEAM).toBe("widget");
  expect(got.TURBO_TOKEN).toBe(TOKEN);
  expect(got.TURBO_REMOTE_CACHE_SIGNATURE_KEY).toBe(SIGKEY);
  expect("TURBO_REMOTE_CACHE_TIMEOUT" in got).toBe(true); // a slow cache must not stall a build for long
  const seen = cache.seen();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[seen.length - 1]?.[1]).toBe(`Bearer ${TOKEN}`); // it asked the cache before promising it
  expect(p.stderr).toBe("");
});

test("the token can come from a command the owner sets and the environment wins", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url, secretsCommand: `printf '# a comment\\nexport TURBO_TOKEN="${TOKEN}"\\n` +
    `TURBO_REMOTE_CACHE_SIGNATURE_KEY=${SIGKEY}\\nOTHER=ignored\\n'` });
  let p = turbo(d, env, ["env"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`export TURBO_TOKEN=${TOKEN}`);
  expect(p.stdout).toContain(`export TURBO_REMOTE_CACHE_SIGNATURE_KEY=${SIGKEY}`);
  expect(p.stdout).not.toContain("OTHER");
  const [d2, env2] = project({ api: cache.url, secretsCommand: "echo TURBO_TOKEN=from-the-command-not-used" });
  p = turbo(d2, env2, ["env"], { TURBO_TOKEN: TOKEN });
  expect(p.stdout).toContain(`export TURBO_TOKEN=${TOKEN}`);
  expect(p.stdout).not.toContain("not-used");
});

test("without a token nothing breaks and the message says how to supply one", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  const p = turbo(d, env, ["env"]);
  expect(p.code).toBe(0);
  expect(p.stdout).not.toContain("export");
  for (const w of ["TURBO_TOKEN", "turbo.secretsCommand", "local cache"]) expect(p.stderr).toContain(w);
  expect(p.stdout).toContain("unset TURBO_TOKEN"); // a stale token from an earlier shell is not left behind
});

test("a cache that is down is skipped quickly with a note", () => {
  const [d, env] = project({ api: "http://127.0.0.1:9" });
  const p = turbo(d, env, ["env"], { TURBO_TOKEN: TOKEN });
  expect(p.code).toBe(0);
  expect(p.stdout).not.toContain("export");
  expect(p.stdout).toContain("unset TURBO_API");
  expect(p.stderr).toContain("can't be reached");
  expect(p.stderr).toContain("local cache");
  nowhereLeaks(p, env);
});

test("a rejected token is said and not used", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  const p = turbo(d, env, ["env"], { TURBO_TOKEN: "a-different-token-0000000000000000" });
  expect(p.stdout).not.toContain("export");
  expect(p.stderr).toContain("rejected");
  expect(p.stdout + p.stderr).not.toContain("a-different-token");
});

test("a failing secrets command degrades and its output is not shown", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url, secretsCommand: `echo ${TOKEN}; echo 'no key file' >&2; exit 3` });
  const p = turbo(d, env, ["env"]);
  expect(p.code).toBe(0);
  expect(p.stdout).not.toContain("export");
  for (const w of ["secretsCommand", "exit 3", "no key file"]) expect(p.stderr).toContain(w);
  nowhereLeaks(p, env);
});

test("an address that is not http is refused without stopping anything", () => {
  const [d, env] = project({ api: "file:///etc/passwd" });
  const p = turbo(d, env, ["env"], { TURBO_TOKEN: TOKEN });
  expect(p.code).toBe(0);
  expect(p.stdout).not.toContain("export");
  expect(p.stderr).toContain("http");
});

test("status shows where each part comes from and never a secret", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  let p = turbo(d, env, ["status"], { TURBO_TOKEN: TOKEN, TURBO_REMOTE_CACHE_SIGNATURE_KEY: SIGKEY });
  expect(p.code, p.out).toBe(0);
  for (const word of ["address", "team", "widget", "token", "environment", "signature", "answers"]) expect(p.stdout).toContain(word);
  nowhereLeaks(p, env);
  p = turbo(d, env, ["status"]);
  expect(p.code).toBe(1);
  expect(p.stdout).toContain("missing");
  expect(p.stdout).toContain("turbo.secretsCommand");
});

// ---------- the session hook and the loop ----------
test("a plain session gets the cache in its env file and the token is not printed", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  sh(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
  const envfile = write(join(d, "..", "claude-env"), "");
  const p = runHook("factory_session", [], { cwd: d, input: "{}", timeoutMs: 60_000,
    env: { ...env, CLAUDE_ENV_FILE: envfile, CLAUDE_PROJECT_DIR: d, TURBO_TOKEN: TOKEN } });
  expect(p.code, p.out).toBe(0);
  const written = read(envfile);
  expect(written).toContain(`export TURBO_API=${cache.url}`);
  expect(written).toContain(`export TURBO_TOKEN=${TOKEN}`);
  expect(p.stdout + p.stderr).not.toContain(TOKEN); // the hook prints to the agent's context
});

test("the loop asks for the cache before every task so a late cache is picked up", () => {
  const text = read(join(SF, "factory-loop.sh"));
  const isolate = (text.split("isolate() {")[1] as string).split("\n}\n")[0] as string;
  expect(isolate).toContain('factory_turbo" env'); // inside isolate(), which runs before each task
  expect(sh(["bash", "-n", join(SF, "factory-loop.sh")]).code).toBe(0);
});

// ---------- install and down ----------
test("install starts the service with the token in the environment never in an argument", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url, bind: "127.0.0.1", port: 3401 });
  const p = turbo(d, env, ["install", "--no-github"], { TURBO_TOKEN: TOKEN });
  expect(p.code, p.out).toBe(0);
  const docker = log(env, ".docker");
  for (const w of ["compose --file", "compose-turbo.yaml", "--project-name widget-turbo-cache", "up -d", "token-in-env",
    "bind=127.0.0.1 port=3401"]) expect(docker).toContain(w);
  nowhereLeaks(p, env);
  expect(log(env, ".gh")).toBe(""); // --no-github leaves the repository alone
});

test("install gives ci the same cache through repo variables and secrets sent on stdin", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  const p = turbo(d, env, ["install"], { TURBO_TOKEN: TOKEN, TURBO_REMOTE_CACHE_SIGNATURE_KEY: SIGKEY });
  expect(p.code, p.out).toBe(0);
  const gh = log(env, ".gh");
  for (const w of [`variable set TURBO_API --body ${cache.url}`, "variable set TURBO_TEAM --body widget", "secret set TURBO_TOKEN",
    "secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY"]) expect(gh).toContain(w);
  expect(log(env, ".gh-stdin")).toContain(`stdin:${TOKEN}`);
  expect(log(env, ".gh-stdin")).toContain(`stdin:${SIGKEY}`);
  nowhereLeaks(p, env);
});

test("install without a token stops before docker and says how to supply one", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  const p = turbo(d, env, ["install"]);
  expect(p.code, p.out).toBe(1);
  for (const w of ["TURBO_TOKEN", "turbo.secretsCommand", "openssl rand"]) expect(p.stderr).toContain(w);
  expect(log(env, ".docker")).toBe("");
  expect(log(env, ".gh")).toBe("");
});

test("install without an address stops and names the setting", () => {
  const [d, env] = project();
  const p = turbo(d, env, ["install"], { TURBO_TOKEN: TOKEN });
  expect(p.code).toBe(1);
  expect(p.stderr).toContain("turbo.api");
  expect(log(env, ".docker")).toBe("");
});

test("install says so when docker is not running", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  const p = turbo(d, env, ["install"], { TURBO_TOKEN: TOKEN, FAKE_DOCKER_DOWN: "1" });
  expect(p.code).toBe(1);
  expect(p.stderr).toContain("Docker");
  expect(log(env, ".docker")).not.toContain("compose");
});

test("install warns when the address cannot be reached from other machines or runners", () => {
  const cache = serve();
  let [d, env] = project({ api: "http://100.64.0.7:3335", bind: "127.0.0.1" });
  let p = turbo(d, env, ["install", "--no-github"], { TURBO_TOKEN: TOKEN });
  expect(p.out).toContain("turbo.bind");
  expect(p.out).toContain("Tailscale");
  [d, env] = project({ api: cache.url, bind: "0.0.0.0" });
  p = turbo(d, env, ["install", "--no-github"], { TURBO_TOKEN: TOKEN });
  expect(p.out).toContain("every network");
}, 30_000);

test("a github failure after the service is up is reported with the fix and no secret", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  const p = turbo(d, env, ["install"], { TURBO_TOKEN: TOKEN, FAKE_GH_FAILS: "1" });
  expect(p.code).toBe(1);
  expect(p.out).toContain("admin");
  expect(log(env, ".docker")).toContain("up -d");
  nowhereLeaks(p, env);
});

test("down stops it and purge also removes the stored artifacts", () => {
  const [d, env] = project({ api: "http://127.0.0.1:9" });
  expect(turbo(d, env, ["down"]).code).toBe(0);
  expect(log(env, ".docker").split("\n")[0]).toMatch(/--project-name widget-turbo-cache down( --remove-orphans)?$/);
  expect(turbo(d, env, ["down", "--purge"]).code).toBe(0);
  const docker = log(env, ".docker");
  expect(docker.includes("down --remove-orphans --volumes") || docker.includes("down --volumes")).toBe(true);
});

// ---------- CI ----------
test("ci env prints github env lines only when everything is there and the cache answers", () => {
  const cache = serve();
  const [d, env] = project();
  let p = turbo(d, env, ["ci-env"], { TURBO_API: cache.url, TURBO_TEAM: "widget", TURBO_TOKEN: TOKEN });
  const lines = Object.fromEntries(p.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  expect(p.code).toBe(0);
  expect(Object.keys(lines).sort()).toEqual(["TURBO_API", "TURBO_REMOTE_CACHE_TIMEOUT", "TURBO_TEAM", "TURBO_TOKEN"]);
  expect([lines.TURBO_API, lines.TURBO_TEAM, lines.TURBO_TOKEN]).toEqual([cache.url, "widget", TOKEN]);
  p = turbo(d, env, ["ci-env"], { TURBO_API: cache.url, TURBO_TEAM: "widget", TURBO_TOKEN: TOKEN, TURBO_REMOTE_CACHE_SIGNATURE_KEY: SIGKEY });
  expect(p.stdout.split("\n")).toContain(`TURBO_REMOTE_CACHE_SIGNATURE_KEY=${SIGKEY}`);
});

test("ci env prints nothing for a job without secrets with no variables or with the cache down", () => {
  const cache = serve();
  const [d, env] = project();
  for (const extra of [{}, { TURBO_API: cache.url, TURBO_TOKEN: "" }, { TURBO_API: "", TURBO_TOKEN: TOKEN },
    { TURBO_API: "http://127.0.0.1:9", TURBO_TEAM: "widget", TURBO_TOKEN: TOKEN }]) {
    const p = turbo(d, env, ["ci-env"], extra);
    expect([p.code, p.stdout], JSON.stringify(extra)).toEqual([0, ""]);
  }
  let p = turbo(d, env, ["ci-env"], { TURBO_API: "http://127.0.0.1:9", TURBO_TEAM: "widget", TURBO_TOKEN: TOKEN });
  expect(p.stderr).toContain("can't be reached");
  expect(p.stderr).not.toContain(TOKEN);
  p = turbo(d, env, ["ci-env"], { TURBO_API: cache.url, TURBO_TOKEN: "" }); // a fork's pull request: secrets come in empty
  expect(p.stderr).toContain("no token");
});

function marker(): string {
  return join(process.env.TMPDIR || "/tmp", "factory-turbo-test-marker-ran");
}

test("ci env never runs a command from the settings in a job", () => {
  const cache = serve();
  if (existsSync(marker())) rmSync(marker());
  const [d, env] = project({ api: cache.url, secretsCommand: `touch ${marker()}; echo TURBO_TOKEN=${TOKEN}` });
  turbo(d, env, ["ci-env"], { TURBO_API: cache.url, TURBO_TEAM: "widget" });
  expect(existsSync(marker())).toBe(false);
});

test("ci env refuses a value that could inject another variable", () => {
  const cache = serve();
  const [d, env] = project();
  const p = turbo(d, env, ["ci-env"], { TURBO_API: cache.url, TURBO_TEAM: "widget\nGITHUB_PATH=/tmp/x", TURBO_TOKEN: TOKEN });
  // As the Python test read it: (stdout empty and "newline" said) or "letters" said.
  expect((p.stdout === "" && p.stderr.includes("newline")) || p.stderr.includes("letters")).toBe(true);
});

test("the workflow template uses the cache for the heavy job and never for a fork", () => {
  const text = read(join(KIT, ".github", "workflows", "ci.yml"));
  const step = (text.split("Shared remote cache")[1] as string).split("\n      - ")[0] as string;
  expect(step).toContain("if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository");
  for (const want of ["TURBO_API: ${{ vars.TURBO_API }}", "TURBO_TEAM: ${{ vars.TURBO_TEAM }}", "TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}",
    "TURBO_REMOTE_CACHE_SIGNATURE_KEY: ${{ secrets.TURBO_REMOTE_CACHE_SIGNATURE_KEY }}",
    'factory_turbo.ts ci-env >> "$GITHUB_ENV"']) expect(step).toContain(want);
  const heavy = text.split("  check:")[1] as string;
  expect(heavy.indexOf("Shared remote cache")).toBeLessThan(heavy.indexOf("pnpm install")); // before the first build
  expect(text).not.toContain("pull_request_target");
  expect(text).toMatch(/permissions:\s*\n\s+contents: read/);
});

// ---------- help, files ----------
test("factory help lists the turbo commands and the command is wired", () => {
  const text = read(join(SF, "factory"));
  expect(text).toContain("turbo)");
  expect(text).toContain("factory_turbo");
  const out = sh(["bash", join(SF, "factory"), "help"], { cwd: SF }).stdout;
  for (const want of ["turbo status", "turbo install", "turbo down"]) expect(out).toContain(want);
});

test("the new files reach projects through the old kit paths too", () => {
  // The compose file still has its forwarder from the move (#112). The hook is now factory_turbo.ts, which projects
  // reach through .claude/hooks (install.sh links the hooks folder); the .py forwarder went with the .py (#252).
  const old = join(KIT, ".claude", "ci", "compose-turbo.yaml");
  expect(lstatSync(old).isSymbolicLink()).toBe(true);
  expect(realpathSync(old)).toBe(realpathSync(join(SF, "ci", "compose-turbo.yaml")));
  expect(existsSync(join(SF, "hooks", "factory_turbo.ts"))).toBe(true);
  expect(existsSync(join(KIT, ".claude", "hooks", "factory_turbo.py"))).toBe(false);
});

test("the docs cover setup security signing and the open owner item", () => {
  const readme = readmeAndWiki();
  for (const want of ["factory turbo install", "turbo.secretsCommand", "TURBO_REMOTE_CACHE_SIGNATURE_KEY", "Tailscale",
    "openssl rand", "fork", "FULL TURBO", "remoteCache"]) expect(readme).toContain(want);
});

test("the turbo settings are listed with defaults and checked", () => {
  const [d, env] = project();
  const settings = (...a: string[]): Proc => runHook("factory_settings", a, { cwd: d, env });
  const out = settings().stdout;
  for (const key of ["turbo.api", "turbo.team", "turbo.bind", "turbo.port", "turbo.secretsCommand"]) expect(out).toContain(key);
  expect(settings("set", "turbo.port", "3400").code).toBe(0);
  expect(settings("set", "turbo.port", "many").code).not.toBe(0);
  expect(JSON.parse(read(join(d, ".claude", "factory.json"))).turbo).toEqual({ port: 3400 });
});

// ---------- factory doctor ----------
function doctorRun(d: string, env: Env): Proc {
  return runHook("factory_doctor", [], { cwd: d, env, timeoutMs: 120_000 });
}

test("doctor notes an unreachable cache never fails on it and never runs the secrets command", () => {
  if (existsSync(marker())) rmSync(marker());
  const [d, env] = project({ api: "http://127.0.0.1:9", secretsCommand: `touch ${marker()}` });
  const p = doctorRun(d, env);
  const ls = p.stdout.split("\n").filter((l) => l.toLowerCase().includes("turbo") && l.toLowerCase().includes("cache"));
  expect(ls.some((l) => l.startsWith("note") && l.includes("can't be reached")), p.stdout).toBe(true);
  expect(p.stdout.split("\n").some((l) => l.startsWith("fix") && l.toLowerCase().includes("turbo")), p.stdout).toBe(false);
  expect(existsSync(marker()), "doctor never decrypts or runs the owner's secrets command").toBe(false);
});

test("doctor says when turbo json does not sign artifacts but a key is set", () => {
  const cache = serve();
  const [d, env] = project({ api: cache.url });
  write(join(d, "turbo.json"), '{"tasks": {}}');
  const p = doctorRun(d, { ...env, TURBO_REMOTE_CACHE_SIGNATURE_KEY: SIGKEY });
  expect(p.stdout, p.stdout).toMatch(/note .*signature/);
  expect(p.stdout).not.toContain(SIGKEY);
});
