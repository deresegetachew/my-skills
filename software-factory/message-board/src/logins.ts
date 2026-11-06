// Logins (#504): a Postgres role of its own for each machine (or person) that uses the board from elsewhere, so one can
// be taken away without touching the others. A login is a member of the database's logins group, which holds only
// what a user of the board needs: connect to this database, and read and write the board's tables (not mb_logins, and
// mb_migrations only to read). It can't create tables, roles or anything else. Making logins needs the board's own
// user (a superuser: the one `factory board up` made), because of the roles and the login event trigger.
//
// The board notes when a login is first used: a login event trigger (Postgres 17) stamps mb_logins.first_seen and
// last_seen, and a login connected right now counts too (pg_stat_activity). Nothing else is recorded about a login;
// its password is shown once, when it is made, and Postgres keeps only its hash.
//
// Roles belong to the whole server, so the names carry the database's: <db>_logins (the group) and <db>_l_<name>.
import type { SQL } from "bun";
import { refuse } from "./errors.ts";

export const LOGIN_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const LOCK = 4_891_008; // the advisory lock login changes take (the migrations take 4_891_007)

export interface Login {
  name: string;
  role: string;
  createdAt: Date;
  /** When the login first connected; null while it never has. */
  firstSeen: Date | null;
  lastSeen: Date | null;
  /** Whether it is connected now. */
  connected: boolean;
}

type Row = Record<string, unknown>;

const ident = (s: string): string => `"${s.replace(/"/g, "\"\"")}"`;
const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;

async function database(sql: SQL): Promise<string> {
  return String(((await sql`SELECT current_database() AS db`) as Row[])[0]?.db);
}

function groupOf(db: string): string {
  return `${db}_logins`;
}

function roleOf(db: string, name: string): string {
  if (!LOGIN_NAME.test(name)) {
    refuse("bad-input", `A login's name must be lowercase letters, digits and dashes (up to 40), starting with a letter; not ${JSON.stringify(name)}.`,
      "For example: factory board login add laptop");
  }
  const role = `${db}_l_${name.replace(/-/g, "_")}`;
  if (role.length > 63) refuse("bad-input", `The login's role name ${role} is longer than Postgres allows (63).`, "Choose a shorter name.");
  return role;
}

async function tableExists(sql: SQL, name: string): Promise<boolean> {
  return Boolean(((await sql`SELECT to_regclass(${name}) IS NOT NULL AS ok`) as Row[])[0]?.ok);
}

/** The logins table, the group with the board's rights, and the trigger that notes a login's first use. Safe to run
 * again: each `add` runs it, so tables a later migration adds are granted too. */
async function ensure(tx: SQL, db: string): Promise<void> {
  const group = groupOf(db);
  await tx.unsafe(`CREATE TABLE IF NOT EXISTS mb_logins (
    name text PRIMARY KEY, role text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
    first_seen timestamptz, last_seen timestamptz)`);
  const exists = ((await tx`SELECT 1 FROM pg_roles WHERE rolname = ${group}`) as Row[]).length > 0;
  if (!exists) await tx.unsafe(`CREATE ROLE ${ident(group)} NOLOGIN`);
  // Only the board's own user (a superuser, unaffected by these) and the logins reach the board's database, and no login
  // reaches the server's maintenance databases. The board's server holds only those (factory board up), so nobody else
  // needs PUBLIC's CONNECT there; on a server shared with other databases, those are left as they are.
  await tx.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(db)} FROM PUBLIC`);
  for (const other of ["postgres", "template1"]) {
    if (other !== db && ((await tx`SELECT 1 FROM pg_database WHERE datname = ${other}`) as Row[]).length) {
      await tx.unsafe(`REVOKE CONNECT ON DATABASE ${ident(other)} FROM PUBLIC`);
    }
  }
  await tx.unsafe(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(group)}`);
  await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${ident(group)}`);
  await tx.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident(group)}`);
  await tx.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(group)}`);
  await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(group)}`);
  await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident(group)}`);
  await tx.unsafe(`REVOKE ALL ON mb_logins FROM ${ident(group)}`);
  if (await tableExists(tx, "mb_migrations")) {
    await tx.unsafe(`REVOKE ALL ON mb_migrations FROM ${ident(group)}`);
    await tx.unsafe(`GRANT SELECT ON mb_migrations TO ${ident(group)}`);
  }
  // Runs as its owner on every connection to this database; a failure in it must never stop a login.
  await tx.unsafe(`CREATE OR REPLACE FUNCTION mb_login_seen() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp AS $f$
    BEGIN
      UPDATE mb_logins SET first_seen = coalesce(first_seen, now()), last_seen = now()
       WHERE role = session_user AND (last_seen IS NULL OR last_seen < now() - interval '1 minute');
    EXCEPTION WHEN OTHERS THEN NULL;
    END $f$`);
  const trigger = ((await tx`SELECT 1 FROM pg_event_trigger WHERE evtname = 'mb_login_seen'`) as Row[]).length > 0;
  if (!trigger) await tx.unsafe("CREATE EVENT TRIGGER mb_login_seen ON login EXECUTE FUNCTION mb_login_seen()");
}

/** Makes login `name` with `password`; returns its role. Refuses `login-exists` when the name is taken. */
export async function addLogin(sql: SQL, name: string, password: string): Promise<{ name: string; role: string }> {
  const db = await database(sql);
  const role = roleOf(db, name);
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
    await ensure(tx, db);
    const taken = ((await tx`SELECT 1 FROM mb_logins WHERE name = ${name}`) as Row[]).length > 0 ||
      ((await tx`SELECT 1 FROM pg_roles WHERE rolname = ${role}`) as Row[]).length > 0;
    if (taken) refuse("login-exists", `There is already a login called ${name}.`, `Remove it first with \`factory board login remove ${name}\`, or choose another name.`);
    // The statement holds the password: keep it out of the server's log, even if it fails.
    await tx.unsafe("SET LOCAL log_statement = 'none'");
    await tx.unsafe("SET LOCAL log_min_error_statement = 'panic'");
    await tx.unsafe(`CREATE ROLE ${ident(role)} LOGIN INHERIT PASSWORD ${literal(password)} IN ROLE ${ident(groupOf(db))}`);
    await tx`INSERT INTO mb_logins (name, role) VALUES (${name}, ${role})`;
  });
  return { name, role };
}

/** Every login, by name. A login connected now that has no first use yet gets it now. */
export async function listLogins(sql: SQL): Promise<Login[]> {
  if (!(await tableExists(sql, "mb_logins"))) return [];
  await sql`UPDATE mb_logins SET first_seen = now(), last_seen = now()
    WHERE first_seen IS NULL AND role IN (SELECT usename FROM pg_stat_activity WHERE usename IS NOT NULL)`;
  const rows = (await sql`SELECT l.name, l.role, l.created_at, l.first_seen, l.last_seen,
      EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.usename = l.role) AS connected
    FROM mb_logins l ORDER BY l.name`) as Row[];
  return rows.map((r) => ({
    name: String(r.name), role: String(r.role), createdAt: r.created_at as Date,
    firstSeen: (r.first_seen as Date | null) ?? null, lastSeen: (r.last_seen as Date | null) ?? null, connected: Boolean(r.connected),
  }));
}

/** Drops login `name` and ends its connections. With `unused`, only a login that was never used (`login-used`
 * otherwise). Refuses `not-found` for a name that isn't a login. */
export async function removeLogin(sql: SQL, name: string, options: { unused?: boolean } = {}): Promise<{ name: string; role: string }> {
  const db = await database(sql);
  const role = roleOf(db, name);
  if (!(await tableExists(sql, "mb_logins"))) refuse("not-found", `There is no login called ${name}.`, "`factory board login ls` lists them.");
  const oid = ((await sql`SELECT oid FROM pg_roles WHERE rolname = ${role}`) as Row[])[0]?.oid ?? null; // pg_stat_activity names it by oid once it is dropped
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
    const found = (await tx`SELECT first_seen FROM mb_logins WHERE name = ${name} FOR UPDATE`) as Row[];
    if (!found.length) refuse("not-found", `There is no login called ${name}.`, "`factory board login ls` lists them.");
    if (options.unused) {
      const live = ((await tx`SELECT 1 FROM pg_stat_activity WHERE usename = ${role}`) as Row[]).length > 0;
      if (found[0]?.first_seen || live) {
        refuse("login-used", `The login ${name} has been used, so it was kept.`, `Remove it anyway with \`factory board login remove ${name}\`.`);
      }
    }
    await tx`DELETE FROM mb_logins WHERE name = ${name}`;
    await tx.unsafe(`DROP ROLE IF EXISTS ${ident(role)}`);
  });
  if (oid !== null) await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usesysid = ${oid}`;
  return { name, role };
}
