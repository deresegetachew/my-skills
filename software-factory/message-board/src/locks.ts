// The board's own locks (#514): a row each in mb_locks ('logins' for login changes, 'migrate' for the migrations), taken
// with SELECT ... FOR UPDATE. Only the board's own user may read or write mb_locks (FOR UPDATE needs UPDATE), so no login
// and no join code can take or hold these locks. (Advisory locks were used before; any role can take any advisory lock.)
// Every wait on them is bounded: `busy` after that.
import type { SQL } from "bun";
import { refuse } from "./errors.ts";

export type LockName = "logins" | "migrate";

type Row = Record<string, unknown>;

/** mb_locks with its rows. Safe to run twice and at once: a create that crosses another is taken as done. Needs the
 * board's own user. */
export async function ensureLocks(sql: SQL): Promise<void> {
  const exists = Boolean(((await sql`SELECT to_regclass('mb_locks') IS NOT NULL AS ok`) as Row[])[0]?.ok);
  if (!exists) {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("CREATE TABLE IF NOT EXISTS mb_locks (name text PRIMARY KEY)");
        await tx.unsafe("REVOKE ALL ON mb_locks FROM PUBLIC");
        // tables the board's user makes are granted to the logins group by default (logins.ts): not this one
        const groups = (await tx`SELECT rolname FROM pg_roles WHERE rolname = current_database() || '_logins'`) as Row[];
        for (const g of groups) await tx.unsafe(`REVOKE ALL ON mb_locks FROM "${String(g.rolname).replace(/"/g, "\"\"")}"`);
      });
    } catch (e) {
      const state = (e as { errno?: string }).errno ?? "";
      if (state !== "23505" && state !== "42P07") throw e; // another made it at the same moment
    }
  }
  const missing = ((await sql`SELECT count(*)::int AS n FROM mb_locks WHERE name IN ('logins', 'migrate')`) as Row[])[0]?.n !== 2;
  if (missing) await sql`INSERT INTO mb_locks (name) VALUES ('logins'), ('migrate') ON CONFLICT DO NOTHING`;
}

/** Takes lock `name` in transaction `tx`, waiting at most `seconds` (then `busy`); the statements after it have the
 * session's lock_timeout again. */
export async function takeLock(tx: SQL, name: LockName, seconds: number): Promise<void> {
  await tx.unsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.round(seconds))}s'`);
  try {
    await tx`SELECT 1 FROM mb_locks WHERE name = ${name} FOR UPDATE`;
    await tx.unsafe("SET LOCAL lock_timeout TO DEFAULT");
  } catch (e) {
    if ((e as { errno?: string }).errno === "55P03") {
      refuse("busy", `Another ${name === "migrate" ? "migration" : "change to the board's logins"} kept the board's ${name} lock for ${seconds} s.`,
        "Run it again in a minute.");
    }
    throw e;
  }
}
