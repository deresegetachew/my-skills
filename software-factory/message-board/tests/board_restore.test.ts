// `factory board backup` then `factory board restore <file> --yes` (#515): a round trip on a throwaway board. The board's
// container is stood in for by a `docker` on PATH that runs each `docker compose exec -T db <pg_dump|psql> ...` with the
// real tool from postgres:17-alpine against the test database (the tests' own Postgres, pg.ts), so the dump and the
// restore are the real ones. What is checked: the dump has no owner and no grants, a restore needs --yes, and after it
// the tasks, messages and events are those of the backup, the schema is migrated, and the logins note is shown.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, migrationNames } from "../src/index.ts";
import { freshDatabase, type Server, startServer } from "./pg.ts";

setDefaultTimeout(180_000);

const BIN = join(import.meta.dir, "..", "bin.ts");
let server: Server | null = null;
let db: { url: string; drop(): Promise<void> } | null = null;

beforeAll(async () => {
  server = await startServer();
  db = await freshDatabase(server);
}, 600_000);

afterAll(async () => {
  await db?.drop().catch(() => {});
  server?.stop();
});

/** Runs the Postgres tool of `docker compose ... exec -T db <tool> -U <user> -d <db> <args>` in a throwaway
 * postgres:17-alpine container against $FWD_URL, with stdin passed through; anything else succeeds and does nothing. */
const FORWARDING_DOCKER = `#!/usr/bin/env bash
[ "$1" = info ] && exit 0
args=("$@"); at=""
for i in "\${!args[@]}"; do [ "\${args[$i]}" = exec ] && at=$i; done
[ -n "$at" ] || exit 0
rest=("\${args[@]:$((at + 3))}")
tool="\${rest[0]}"; out=(); skip=0
for a in "\${rest[@]:1}"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in -U|-d) skip=1 ;; *) out+=("$a") ;; esac
done
exec "$REAL_DOCKER" run --rm -i $FWD_NET postgres:17-alpine "$tool" "\${out[@]}" "$FWD_URL"
`;

/** The test database's URL as a container reaches it: the host's address from inside Docker. */
function forwarded(url: string): { url: string; net: string } {
  const u = new URL(url);
  if (process.platform === "darwin") {
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") u.hostname = "host.docker.internal";
    return { url: u.toString(), net: "" };
  }
  return { url: u.toString(), net: "--network host" };
}

function world(url: string): { root: string; dir: string; env: Record<string, string> } {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mb-restore-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FORWARDING_DOCKER, { mode: 0o755 });
  const dir = join(root, "cfg", "message-board");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "compose.yaml"), "name: factory-message-board\n");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MB_") && !k.startsWith("FACTORY_")) env[k] = v;
  const fwd = forwarded(url);
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, FACTORY_CONFIG_DIR: join(root, "cfg"), MB_URL: url, REAL_DOCKER: Bun.which("docker") ?? "docker",
    FWD_URL: fwd.url, FWD_NET: fwd.net });
  return { root, dir, env };
}

function board(env: Record<string, string>, args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 170_000 });
  return { code: p.exitCode ?? 124, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

test("a backup restores into the running board after --yes: its tasks, messages and events, migrated, with the logins note", async () => {
  const url = (db as { url: string }).url;
  const w = world(url);
  const po = await Board.open(url, { as: "po", max: 1 });
  await po.migrate();
  const a = await po.create({ title: "Before the backup", ref: "github:o/r#3" });
  const b = await po.create({ title: "Also before" });
  await po.link(a.id, b.id, "blocks");
  await po.post({ task: a.id, kind: "question", to: "haile", body: "Which issues first?" });
  await po.note(a.id, { kind: "decision", body: "Keep the issue number" });
  const eventsBefore = (await po.events(0, 500)).length;
  await po.end();

  const file = join(w.root, "board.sql");
  const backup = board(w.env, ["backup", "--out", file]);
  expect(backup.code, backup.stdout + backup.stderr).toBe(0);
  const dump = readFileSync(file, "utf8");
  expect(dump).toContain("CREATE TABLE public.tasks");
  expect(dump).not.toMatch(/OWNER TO|^GRANT /m);

  // the board moves on after the backup
  const later = await Board.open(url, { as: "po", max: 1 });
  await later.create({ title: "After the backup" });
  await later.end();

  const refused = board(w.env, ["restore", file]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("needs-yes");
  const check = await Board.open(url, { as: "check", max: 1 });
  expect((await check.tasks()).map((t) => t.title)).toContain("After the backup");
  await check.end();

  const r = board(w.env, ["restore", file, "--yes"]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain(`Restored the message board from ${file}`);
  expect(r.stdout).toContain("logins");
  expect(r.stdout).toContain("factory machine join");
  expect(r.stdout + r.stderr).not.toContain("does not exist");

  const after = await Board.open(url, { as: "check", max: 1 });
  try {
    expect((await after.tasks()).map((t) => t.title).sort()).toEqual(["Also before", "Before the backup"]);
    expect((await after.get(b.id)).blockedBy).toEqual([a.id]);
    expect((await after.thread({ task: a.id })).map((m) => m.body)).toEqual(["Which issues first?"]);
    expect((await after.contextFor(a.id)).map((c) => c.body)).toEqual(["Keep the issue number"]);
    expect((await after.events(0, 500)).length).toBe(eventsBefore);
    expect((await after.info()).migrations).toEqual(migrationNames());
    // the board still writes after a restore: its ids go on from the backup's
    const next = await after.create({ title: "Written after the restore" });
    expect(next.id).toBeGreaterThan(b.id);
  } finally {
    await after.end();
  }
});
