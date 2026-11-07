// Migrations: the numbered .sql files in migrations/, applied in order, each in one transaction, and recorded in
// mb_migrations. The board's migrate lock (locks.ts: a row only the board's user can lock, so no login can hold it) lets
// two processes migrate at once without applying a file twice. Running them again changes nothing, and with nothing to
// apply nothing is locked.
import type { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureLocks, takeLock } from "./locks.ts";

const DIR = join(import.meta.dir, "migrations");
const LOCK_SECONDS = 60; // the longest a migration waits for another one
/** The migration files, in order: 001_init.sql, 002_... */
export function migrationNames(): string[] {
  return readdirSync(DIR).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
}

async function ensureTable(sql: SQL): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS mb_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
}

/** The names already applied, oldest first; [] when the table isn't there yet. */
export async function applied(sql: SQL): Promise<string[]> {
  const exists = await sql`SELECT to_regclass('mb_migrations') IS NOT NULL AS ok`;
  if (!(exists[0] as { ok: boolean }).ok) return [];
  const rows = (await sql`SELECT name FROM mb_migrations ORDER BY name`) as { name: string }[];
  return rows.map((r) => r.name);
}

/** Apply what isn't applied yet; returns the names applied now. */
export async function migrate(sql: SQL): Promise<string[]> {
  const before = await applied(sql);
  if (migrationNames().every((n) => before.includes(n))) return [];
  await ensureLocks(sql);
  await sql.begin(async (tx) => {
    await takeLock(tx, "migrate", LOCK_SECONDS);
    await ensureTable(tx);
  });
  const done: string[] = [];
  for (const name of migrationNames()) {
    const text = readFileSync(join(DIR, name), "utf8");
    const ran = await sql.begin(async (tx) => {
      await takeLock(tx, "migrate", LOCK_SECONDS);
      const seen = await tx`SELECT 1 FROM mb_migrations WHERE name = ${name}`;
      if (seen.length) return false;
      await tx.unsafe(text);
      await tx`INSERT INTO mb_migrations (name) VALUES (${name})`;
      return true;
    });
    if (ran) done.push(name);
  }
  return done;
}
