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
// A join code's login (#514) is made to expire (`validFor`: the role's VALID UNTIL, so Postgres itself refuses its
// password after that) and is redeemed once: mb_redeem_login(), a SECURITY DEFINER function the logins may call, makes
// a fresh role for the caller's login (<code role>_<random>, a new random password, no expiry, in the logins group),
// points mb_logins at it (the login keeps its name), makes the code's role NOLOGIN and returns the new role and
// password. A copy of the code can then do nothing: the code's role can't log in, and it can only ever change its own
// password, never the fresh role's. Postgres checks NOLOGIN after the password, so a copy that started its login
// handshake before the redeem and finishes it afterwards is refused too ("not permitted to log in"). The redeem runs in
// the caller's transaction: `redeemLogin` hands the new role and password to `keep` (the caller writes them) before
// the commit, so nothing is spent when that fails. After the commit it ends the code role's other sessions (waiting up
// to 5 s for each) and connects as the fresh role: if either fails, the code may have been copied
// (`login-compromised`). The spent code role is dropped by the board's own user at the next `login ls`, `login
// remove` or `factory board sweep`. A session opened before VALID UNTIL outlives it (Postgres checks it only when
// connecting): `dropExpiredLogins` (the sweep) drops an expired, unredeemed login and ends its sessions.
//
// Roles belong to the whole server, so the names carry the database's: <db>_logins (the group) and <db>_l_<name>.
import { SQL } from "bun";
import { BoardError, refuse } from "./errors.ts";

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
  /** When its join code was redeemed (`redeemLogin`); null while it hasn't been. */
  redeemedAt: Date | null;
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

/** mb_logins.redeemed_at and code_role (#514), added to a table made before them. A login used before then counts as
 * redeemed: it joined the old way. */
async function upgrade(sql: SQL): Promise<void> {
  if (await hasRedeemed(sql)) return;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
    await addRedeemed(tx);
  });
}

async function hasRedeemed(sql: SQL): Promise<boolean> {
  return ((await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
    AND table_name = 'mb_logins' AND column_name IN ('redeemed_at', 'code_role')`) as Row[]).length === 2;
}

/** Inside a transaction that holds the lock. */
async function addRedeemed(tx: SQL): Promise<void> {
  if (await hasRedeemed(tx)) return;
  const had = ((await tx`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
    AND table_name = 'mb_logins' AND column_name = 'redeemed_at'`) as Row[]).length > 0;
  if (!had) {
    await tx.unsafe("ALTER TABLE mb_logins ADD COLUMN redeemed_at timestamptz");
    await tx.unsafe("UPDATE mb_logins SET redeemed_at = first_seen WHERE first_seen IS NOT NULL");
  }
  await tx.unsafe("ALTER TABLE mb_logins ADD COLUMN IF NOT EXISTS code_role text");
}

// The redeem. It runs as its owner (the board's user, a superuser) for the login that called it (session_user): only that
// login's row is touched, and only its role and the fresh one; the code role's name comes from mb_logins (which the
// logins can't write), the fresh one is that plus random hex, and both go into the statements through format's %I and
// %L. The search_path is pinned, pg_catalog first, so no object a caller could make stands in for a built-in. The
// SQLSTATEs MB001 to MB004 are its refusals (MB004: the code's role can't log in any more, as a remove is under way) (redeemLogin turns them into errors).
const REDEEM = `CREATE FUNCTION mb_redeem_login(OUT login_role text, OUT login_password text) LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp AS $f$
  DECLARE
    login public.mb_logins%ROWTYPE;
    valid_to timestamptz;
    fresh text;
    pw text;
  BEGIN
    SELECT * INTO login FROM public.mb_logins WHERE role = session_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'the user % is not a board login', session_user USING ERRCODE = 'MB003'; END IF;
    IF login.redeemed_at IS NOT NULL THEN
      RAISE EXCEPTION 'the login % was already redeemed', login.name USING ERRCODE = 'MB001';
    END IF;
    IF NOT coalesce((SELECT rolcanlogin FROM pg_roles WHERE rolname = login.role), false) THEN
      RAISE EXCEPTION 'the login % can''t log in any more (it is being removed)', login.name USING ERRCODE = 'MB004';
    END IF;
    SELECT rolvaliduntil INTO valid_to FROM pg_roles WHERE rolname = login.role;
    IF valid_to IS NOT NULL AND valid_to <= now() THEN
      RAISE EXCEPTION 'the login % expired', login.name USING ERRCODE = 'MB002';
    END IF;
    pw := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    fresh := left(login.role, 54) || '_' || left(replace(gen_random_uuid()::text, '-', ''), 8);
    EXECUTE format('CREATE ROLE %I LOGIN INHERIT PASSWORD %L VALID UNTIL %L IN ROLE %I', fresh, pw, 'infinity',
      current_database() || '_logins');
    EXECUTE format('ALTER ROLE %I NOLOGIN', login.role);
    UPDATE public.mb_logins SET role = fresh, code_role = login.role, redeemed_at = now(),
      first_seen = coalesce(first_seen, now()), last_seen = now()
     WHERE name = login.name;
    login_role := fresh;
    login_password := pw;
  END $f$`;

/** The logins table, the group with the board's rights, and the trigger that notes a login's first use. Safe to run
 * again: each `add` runs it, so tables a later migration adds are granted too. */
async function ensure(tx: SQL, db: string): Promise<void> {
  const group = groupOf(db);
  await tx.unsafe(`CREATE TABLE IF NOT EXISTS mb_logins (
    name text PRIMARY KEY, role text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
    first_seen timestamptz, last_seen timestamptz, redeemed_at timestamptz, code_role text)`);
  await addRedeemed(tx);
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
    SET search_path = public, pg_temp SET lock_timeout = '1s' AS $f$
    BEGIN
      UPDATE mb_logins SET first_seen = coalesce(first_seen, now()), last_seen = now()
       WHERE role = session_user AND (last_seen IS NULL OR last_seen < now() - interval '1 minute');
    EXCEPTION WHEN OTHERS THEN NULL;
    END $f$`);
  const trigger = ((await tx`SELECT 1 FROM pg_event_trigger WHERE evtname = 'mb_login_seen'`) as Row[]).length > 0;
  if (!trigger) await tx.unsafe("CREATE EVENT TRIGGER mb_login_seen ON login EXECUTE FUNCTION mb_login_seen()");
  await tx.unsafe("DROP FUNCTION IF EXISTS mb_redeem_login()"); // its result changed (#514): CREATE OR REPLACE can't
  await tx.unsafe(REDEEM);
  await tx.unsafe("REVOKE ALL ON FUNCTION mb_redeem_login() FROM PUBLIC");
  await tx.unsafe(`GRANT EXECUTE ON FUNCTION mb_redeem_login() TO ${ident(group)}`);
}

/** Makes login `name` with `password`; returns its role. With `validFor` (seconds), the login expires that long
 * from now by the server's clock, unless it is redeemed first. Refuses `login-exists` when the name is taken. */
export async function addLogin(sql: SQL, name: string, password: string, options: { validFor?: number } = {}): Promise<{ name: string; role: string }> {
  const db = await database(sql);
  const role = roleOf(db, name);
  const { validFor } = options;
  if (validFor !== undefined && !(Number.isInteger(validFor) && validFor > 0)) {
    refuse("bad-input", `A login's validity is a whole number of seconds above 0, not ${validFor}.`, "For example: factory board login add laptop --valid-for 900");
  }
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
    await ensure(tx, db);
    const taken = ((await tx`SELECT 1 FROM mb_logins WHERE name = ${name}`) as Row[]).length > 0 ||
      ((await tx`SELECT 1 FROM pg_roles WHERE rolname = ${role}`) as Row[]).length > 0;
    if (taken) refuse("login-exists", `There is already a login called ${name}.`, `Remove it first with \`factory board login remove ${name}\`, or choose another name.`);
    // The statement holds the password: keep it out of the server's log, even if it fails.
    await tx.unsafe("SET LOCAL log_statement = 'none'");
    await tx.unsafe("SET LOCAL log_min_error_statement = 'panic'");
    const until = validFor === undefined ? "" :
      ` VALID UNTIL ${literal(String(((await tx`SELECT (now() + make_interval(secs => ${validFor}))::text AS t`) as Row[])[0]?.t))}`;
    await tx.unsafe(`CREATE ROLE ${ident(role)} LOGIN INHERIT PASSWORD ${literal(password)}${until} IN ROLE ${ident(groupOf(db))}`);
    await tx`INSERT INTO mb_logins (name, role) VALUES (${name}, ${role})`;
  });
  return { name, role };
}

/** Every login, by name. A login connected now that has no first use yet gets it now. */
export async function listLogins(sql: SQL): Promise<Login[]> {
  if (!(await tableExists(sql, "mb_logins"))) return [];
  await upgrade(sql);
  try { // noting first use waits on no row (a session may hold one): it is done next time
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT_SECONDS}s'`);
      await tx`UPDATE mb_logins SET first_seen = now(), last_seen = now()
        WHERE first_seen IS NULL AND role IN (SELECT usename FROM pg_stat_activity WHERE usename IS NOT NULL)`;
    });
  } catch (e) {
    if ((e as { errno?: string }).errno !== "55P03") throw e;
  }
  const rows = (await sql`SELECT l.name, l.role, l.created_at, l.first_seen, l.last_seen, l.redeemed_at,
      EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.usename = l.role) AS connected
    FROM mb_logins l ORDER BY l.name`) as Row[];
  return rows.map((r) => ({
    name: String(r.name), role: String(r.role), createdAt: r.created_at as Date,
    firstSeen: (r.first_seen as Date | null) ?? null, lastSeen: (r.last_seen as Date | null) ?? null, connected: Boolean(r.connected),
    redeemedAt: (r.redeemed_at as Date | null) ?? null,
  }));
}

/** Drops login `name` and ends its connections. With `unused`, only a login that was never used (`login-used`
 * otherwise); with `unredeemed`, only one whose join code wasn't redeemed (`login-redeemed` otherwise). Refuses
 * `not-found` for a name that isn't a login. */
export async function removeLogin(sql: SQL, name: string, options: { unused?: boolean; unredeemed?: boolean } = {}): Promise<{ name: string; role: string }> {
  roleOf(await database(sql), name); // checks the name
  if (!(await tableExists(sql, "mb_logins"))) refuse("not-found", `There is no login called ${name}.`, "`factory board login ls` lists them.");
  await upgrade(sql);
  // Every role the login has had: read under the row's lock, as a redeem may have given it a fresh one meanwhile (one
  // waiting on that lock sees the redeem's row once it commits), and read again under the lock before the drop.
  const roles = new Set<string>();
  const add = (r: unknown): void => {
    if (typeof r === "string" && r) roles.add(r);
  };
  let role = "";
  const what = `Removing the login ${name}`;
  const unconditional = !options.unused && !options.unredeemed;
  await underLock(sql, what, () => rolesOfLogin(sql, name), async (tx) => {
    const found = (await tx`SELECT first_seen, redeemed_at, role, code_role FROM mb_logins WHERE name = ${name} FOR UPDATE`) as Row[];
    if (!found.length) refuse("not-found", `There is no login called ${name}.`, "`factory board login ls` lists them.");
    role = String(found[0]?.role ?? "");
    if (options.unused) {
      const live = ((await tx`SELECT 1 FROM pg_stat_activity WHERE usename = ${role}`) as Row[]).length > 0;
      if (found[0]?.first_seen || live) {
        refuse("login-used", `The login ${name} has been used, so it was kept.`, `Remove it anyway with \`factory board login remove ${name}\`.`);
      }
    }
    if (options.unredeemed && found[0]?.redeemed_at) {
      refuse("login-redeemed", `The login ${name} was redeemed (its machine joined), so it was kept.`, `Remove it anyway with \`factory board login remove ${name}\`.`);
    }
    add(found[0]?.role);
    add(found[0]?.code_role);
    for (const r of roles) await disable(tx, r); // committed first, so an ended session can't log in again (nor redeem)
  }, unconditional);
  const oids = new Set<unknown>(await oidsOf(sql, roles)); // pg_stat_activity names a role by oid once it is dropped
  try {
    await endSessions(sql, [...oids]);
    await underLock(sql, what, async () => [...roles, ...(await rolesOfLogin(sql, name))], async (tx) => {
      const now = (await tx`SELECT role, code_role FROM mb_logins WHERE name = ${name} FOR UPDATE`) as Row[];
      add(now[0]?.role);
      add(now[0]?.code_role);
      for (const oid of await oidsOf(tx, roles)) oids.add(oid);
      for (const r of roles) await disable(tx, r);
      for (const r of roles) await disown(tx, r);
      await tx`DELETE FROM mb_logins WHERE name = ${name}`;
    }, true);
  } finally {
    // even when the drop failed: the roles can't log in, and nothing of them stays connected (a backend shows in
    // pg_stat_activity a little after its login check, so this looks again until it finds none)
    await endSessionsUntilQuiet(sql, [...oids]);
  }
  return { name, role };
}

const LOCK_WAIT_SECONDS = 2;
const LOCK_BOUND_MS = 15_000;

/** The login's roles now (read without waiting on its row). */
async function rolesOfLogin(sql: SQL, name: string): Promise<string[]> {
  const r = ((await sql`SELECT role, code_role FROM mb_logins WHERE name = ${name}`) as Row[])[0];
  return [r?.role, r?.code_role].filter((x): x is string => typeof x === "string" && x !== "");
}

/** Runs `fn` in a transaction that holds the login changes' lock and waits at most 2 s for any lock. A session of a login
 * (a copy of a join code, say) can hold the login's row in a redeem it never finishes, and nothing would end it: so when
 * the wait times out, the sessions of `rolesNow()` are ended (which rolls their transaction back and frees the row),
 * with `disableOnWait` those roles are made NOLOGIN first so they can't come back, and it runs again, for up to 15 s in
 * all (`busy` then). */
async function underLock<T>(sql: SQL, what: string, rolesNow: () => Promise<string[]>, fn: (tx: SQL) => Promise<T>, disableOnWait = false): Promise<T> {
  const deadline = Date.now() + LOCK_BOUND_MS;
  for (;;) {
    try {
      return await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT_SECONDS}s'`);
        await tx`SELECT pg_advisory_xact_lock(${LOCK})`;
        return await fn(tx);
      });
    } catch (e) {
      if ((e as { errno?: string }).errno !== "55P03") throw e;
      if (Date.now() >= deadline) {
        refuse("busy", `${what} waited ${LOCK_BOUND_MS / 1000} s for the login's record, which another session kept; this step changed nothing.`,
          "Run it again in a minute; if it keeps happening, `factory board login ls` shows who is connected.");
      }
      const roles = await rolesNow();
      await endSessions(sql, await oidsOf(sql, roles));
      if (disableOnWait) {
        for (const r of roles) {
          await sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT_SECONDS}s'`);
            await disable(tx, r);
          }).catch(() => {}); // the next round tries again
        }
      }
    }
  }
}

/** Ends the sessions of the roles with these oids, looking again every 200 ms for at least 600 ms and until a look finds
 * none (up to 3 s): a backend shows in pg_stat_activity a little after its login check. */
async function endSessionsUntilQuiet(sql: SQL, oids: unknown[]): Promise<void> {
  const started = Date.now();
  for (;;) {
    let found = 0;
    for (const oid of oids) {
      found += ((await sql`SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usesysid = ${oid} AND pid <> pg_backend_pid()`) as Row[]).length;
    }
    const spent = Date.now() - started;
    if ((found === 0 && spent >= 600) || spent >= 3000) return;
    await Bun.sleep(200);
  }
}

async function oidsOf(sql: SQL, roles: Iterable<string>): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const r of roles) out.push(...((await sql`SELECT oid FROM pg_roles WHERE rolname = ${r}`) as Row[]).map((x) => x.oid));
  return out;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\/\/[^@\s]*@/g, "//***@");

/** No new logins for `role` (it can't take effect inside an open transaction for others, so commit it first). */
async function disable(sql: SQL, role: string): Promise<void> {
  if (((await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`) as Row[]).length) await sql.unsafe(`ALTER ROLE ${ident(role)} NOLOGIN`);
}

/** Ends the sessions of the roles with these oids, waiting up to 5 s for each. */
async function endSessions(sql: SQL, oids: unknown[]): Promise<void> {
  for (const oid of oids) await sql`SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE usesysid = ${oid} AND pid <> pg_backend_pid()`;
}

/** Drops `role` with what it owns. Any role may make a large object or set its default privileges without CREATE, and
 * DROP ROLE alone refuses a role that owns anything: so what it owns goes to the board's user and is dropped first (in
 * the board's database, the only one a login reaches). */
async function disown(tx: SQL, role: string): Promise<void> {
  if (!((await tx`SELECT 1 FROM pg_roles WHERE rolname = ${role}`) as Row[]).length) return;
  await tx.unsafe(`REASSIGN OWNED BY ${ident(role)} TO CURRENT_USER`);
  await tx.unsafe(`DROP OWNED BY ${ident(role)}`);
  await tx.unsafe(`DROP ROLE ${ident(role)}`);
}

/** Drops the code roles of redeemed logins (NOLOGIN since the redeem), ending any session they still have; one that
 * can't be dropped is a warning and the others go on. Only the board's own user can; for anyone else it does nothing. */
async function dropSpentRoles(sql: SQL): Promise<string[]> {
  if (!(await superuser(sql))) return [];
  const warnings: string[] = [];
  const spent = (await sql`SELECT l.name, l.code_role, r.oid FROM mb_logins l LEFT JOIN pg_roles r ON r.rolname = l.code_role
    WHERE l.code_role IS NOT NULL`) as Row[];
  for (const sp of spent) {
    const role = String(sp.code_role);
    const oids = sp.oid === null || sp.oid === undefined ? [] : [sp.oid];
    try {
      const what = `Dropping ${role}`;
      await underLock(sql, what, async () => [role], (tx) => disable(tx, role), true);
      await endSessions(sql, oids);
      await underLock(sql, what, async () => [role], async (tx) => {
        await disown(tx, role);
        await tx`UPDATE mb_logins SET code_role = NULL WHERE name = ${sp.name} AND code_role = ${role}`;
      }, true);
    } catch (e) {
      warnings.push(`Couldn't drop ${role}, the spent join code role of the login ${String(sp.name)} (it can't log in): ${errText(e)}`);
    } finally {
      await endSessions(sql, oids).catch(() => {});
    }
  }
  return warnings;
}

/** Drops the spent join code roles (dropSpentRoles); warnings for the ones that couldn't be. */
export async function tidyLogins(sql: SQL): Promise<string[]> {
  if (!(await tableExists(sql, "mb_logins"))) return [];
  await upgrade(sql);
  return dropSpentRoles(sql);
}

async function superuser(sql: SQL): Promise<boolean> {
  return Boolean(((await sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`) as Row[])[0]?.rolsuper);
}

/** Redeems the join code of the login this connection is (mb_redeem_login): `keep` gets the login's fresh role and
 * its password inside the transaction, and the redeem is committed only when it returns. Refuses `login-redeemed` (already redeemed),
 * `login-expired`, `not-found` (the connection isn't a login's) and `schema-old` (the board has no redeem yet). */
export async function redeemLogin(sql: SQL, url: string, keep: (login: { role: string; password: string }) => Promise<void> | void): Promise<void> {
  let role = "";
  let password = "";
  await sql.begin(async (tx) => {
    try {
      const got = ((await tx`SELECT login_role, login_password FROM mb_redeem_login()`) as Row[])[0];
      role = String(got?.login_role ?? "");
      password = String(got?.login_password ?? "");
    } catch (e) {
      const state = (e as { errno?: string }).errno ?? "";
      const msg = (e as { message?: string }).message ?? String(e);
      if (state === "MB001") refuse("login-redeemed", `This join code was already used: ${msg}.`, "Ask the machine that runs the board for a new code (`factory machine add`).");
      if (state === "MB004") refuse("login-expired", `This join code's login was taken away: ${msg}.`, "Ask the machine that runs the board for a new code (`factory machine add`).");
      if (state === "MB002") refuse("login-expired", `This join code expired: ${msg}.`, "Ask the machine that runs the board for a new code (`factory machine add`).");
      if (state === "MB003") refuse("not-found", `Only a login made by \`factory board login add\` is redeemed: ${msg}.`, "Redeem with the URL from the join code.");
      if (state === "42883") refuse("schema-old", "The board can't redeem a join code yet (it has no mb_redeem_login).", "On the machine that runs the board, update the factory and make a new code with `factory machine add`.");
      throw e;
    }
    if (!password || !role) refuse("bad-input", "The board's redeem gave no login.", "Make a new code with `factory machine add` and try again.");
    await keep({ role, password });
  });
  // Committed: the code's role can't log in any more. End the sessions a copy may have opened before the commit (each
  // must be gone within 5 s), then check that the fresh role connects with its password.
  const copied = (why: string): never => refuse("login-compromised",
    `The join code's login didn't hold after the redeem (${why.replace(/\/\/[^@\s]*@/g, "//***@").slice(0, 200)}): this code may have been copied.`,
    "Run `factory machine remove <name>` on the hub and make a new code (`factory machine add <name> --agent ...`).");
  // A backend that passed the login check just before the commit may show in pg_stat_activity a moment later, so scan
  // (every 200 ms) for at least 600 ms and until a scan finds none, for up to 3 s.
  const started = Date.now();
  for (let quiet = false; ;) {
    let rows: Row[] = [];
    try {
      rows = (await sql`SELECT pg_terminate_backend(pid, 5000) AS ok FROM pg_stat_activity
        WHERE usesysid = (SELECT oid FROM pg_roles WHERE rolname = session_user) AND pid <> pg_backend_pid()`) as Row[];
    } catch (e) {
      copied(e instanceof Error ? e.message : String(e));
    }
    if (rows.some((r) => r.ok !== true)) copied("a session of the code's login didn't end");
    quiet = rows.length === 0;
    const spent = Date.now() - started;
    if (quiet && spent >= 600) break;
    if (spent >= 3000) {
      if (!quiet) copied("sessions of the code's login kept appearing");
      break;
    }
    await Bun.sleep(200);
  }
  const u = new URL(url);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  const check = new SQL(u.toString(), { max: 1, connectionTimeout: 10 });
  try {
    await check`SELECT 1`;
  } catch (e) {
    copied(e instanceof Error ? e.message : String(e));
  } finally {
    await check.close().catch(() => {});
  }
}

/** Drops each join code's login that expired unredeemed and ends its sessions (VALID UNTIL stops only new ones), and the
 * spent code roles; the names dropped, and a warning for each that couldn't be (the others go on). Only the board's own
 * user (a superuser) can: for anyone else it does nothing. */
export async function dropExpiredLogins(sql: SQL): Promise<{ dropped: string[]; warnings: string[] }> {
  if (!(await tableExists(sql, "mb_logins"))) return { dropped: [], warnings: [] };
  if (!(await superuser(sql))) return { dropped: [], warnings: [] };
  await upgrade(sql);
  const warnings = await dropSpentRoles(sql);
  const due = (await sql`SELECT l.name FROM mb_logins l JOIN pg_roles r ON r.rolname = l.role
    WHERE l.redeemed_at IS NULL AND r.rolvaliduntil IS NOT NULL AND r.rolvaliduntil <= now() ORDER BY l.name`) as Row[];
  const dropped: string[] = [];
  for (const { name } of due) {
    try {
      await removeLogin(sql, String(name), { unredeemed: true });
      dropped.push(String(name));
    } catch (e) {
      if (e instanceof BoardError && ["login-redeemed", "not-found"].includes(e.code)) continue; // redeemed just now, or gone
      warnings.push(`Couldn't drop the expired login ${String(name)} (it can't log in, and its sessions were ended): ${errText(e)}`);
    }
  }
  return { dropped, warnings };
}
