// The seed an agent connects with (#410 step 1): `factory nats user add <agent>` writes it where the composition root
// looks for it, <messaging.creds or ~/.secrets/nats/<project>>/<agent>.nk, for a creds folder written with ~/ and for a
// project run from a linked worktree. Against a real nats-server that takes only that agent's key.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { publicKeyOf } from "../../../hooks/factory_nats_keys.ts";
import { sh, write } from "../../../tests/support.ts";
import { hook, type Project, project } from "./project.ts";
import { MISSING, NATS_SERVER, type Server, startServer } from "./server.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
});

/** A server that takes only the key in `seedFile`. */
async function strictServer(seedFile: string): Promise<Server> {
  const nkey = publicKeyOf(readFileSync(seedFile, "utf8").trim());
  const s = await startServer(`authorization { users: [ { nkey: "${nkey}" } ] }`);
  servers.push(s);
  return s;
}

function addUser(p: Project, cwd = p.dir): void {
  const r = sh([process.execPath, "--no-env-file", join(import.meta.dir, "..", "..", "..", "hooks", "factory_nats.ts"), "user",
    "add", "haile", "--role", "builder"], { cwd, env: p.env, timeoutMs: 60_000 });
  expect(r.code, r.out).toBe(0);
}

/** `factory messages ls` as haile, with transport nats at `url`; its stderr. */
function lsAsHaile(p: Project, url: string, cwd = p.dir, creds?: string): string {
  write(join(p.dir, ".claude", "factory.json"), JSON.stringify({ messaging: { transport: "nats", url, kinds: ["question"],
    ...(creds ? { creds } : {}) } }));
  const r = sh([process.execPath, "--no-env-file", join(import.meta.dir, "..", "..", "..", "hooks", "factory_messages.ts"), "ls",
    "--fresh"], { cwd, env: { ...p.env, FACTORY_AGENT: "haile" }, timeoutMs: 60_000 });
  expect(r.code, r.out).toBe(0);
  return r.stderr;
}

if (!NATS_SERVER) {
  test.skip(MISSING, () => {});
} else {
  test("the default seed folder: user add writes ~/.secrets/nats/<project>/haile.nk and haile connects with it", async () => {
    const p = project("Shop", {});
    addUser(p);
    const s = await strictServer(join(p.home, ".secrets", "nats", "shop", "haile.nk"));
    expect(lsAsHaile(p, s.url)).not.toContain("nats-");
  });

  test("messaging.creds written with ~/ is the same folder for user add and for the agent", async () => {
    const p = project("Shop", { messaging: { creds: "~/keys" } });
    addUser(p);
    const s = await strictServer(join(p.home, "keys", "haile.nk"));
    expect(lsAsHaile(p, s.url, p.dir, "~/keys")).not.toContain("nats-");
  });

  test("a linked worktree of a project with no origin uses the project's name, not the worktree folder's", async () => {
    const p = project("Shop", {});
    sh(["git", "-C", p.dir, "remote", "remove", "origin"]);
    sh(["git", "-C", p.dir, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    const wt = join(p.home, "..", "wt-1");
    sh(["git", "-C", p.dir, "worktree", "add", "-q", wt]);
    mkdirSync(join(wt, ".claude"), { recursive: true });
    write(join(wt, ".claude", "factory.json"), "{}");
    addUser(p, wt);
    const s = await strictServer(join(p.home, ".secrets", "nats", "shop", "haile.nk"));
    write(join(wt, ".claude", "factory.json"), JSON.stringify({ messaging: { transport: "nats", url: s.url, kinds: ["question"] } }));
    const r = sh([process.execPath, "--no-env-file", join(import.meta.dir, "..", "..", "..", "hooks", "factory_messages.ts"), "ls",
      "--fresh"], { cwd: wt, env: { ...p.env, FACTORY_AGENT: "haile" }, timeoutMs: 60_000 });
    expect(r.code, r.out).toBe(0);
    expect(r.stderr).not.toContain("nats-");
  });
}

void hook;
