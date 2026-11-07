// Signing in to the web UI with a code sent by email (#542), beside the token (which keeps working, for scripts and as
// the fallback). The server (factory_ui_server.ts) answers these before it asks for the token:
//
//   GET  /api/auth           {signedIn, email?, mail, codeMinutes}: whether this browser has a session, and whether codes
//                            can be mailed here (mail set up and someone allowed); no address is ever named but the
//                            session's own
//   POST /api/auth/code      {email}: an allowed address gets a 6-digit code by mail, good for 10 minutes and once. Every
//                            address gets the same answer at once (the mail goes out after it), so neither the answer
//                            nor its time says who is allowed
//   POST /api/auth/verify    {email, code}: the right code opens a session, set as a cookie
//   POST /api/auth/signout   ends this browser's session
//
// Codes are kept in memory only, as an HMAC under a key made at start. Asking for codes is limited per address and per
// address of the asker (IP), and so are wrong codes: after `ui.signIn.maxWrongCodes` wrong codes an address (or an IP,
// at four times that) is locked for `ui.signIn.lockoutMinutes`, and its code is gone.
//
// A session is a random id in an HttpOnly, SameSite=Strict cookie (Secure over HTTPS) named for the server's port, with
// Path=/api: the page itself needs none, and a preview served on another port of the same host (cookies ignore ports)
// never gets it, since it answers only /preview/... Only its SHA-256 is kept, in <machine settings folder>/ui/sessions.json
// (mode 600), for `ui.signIn.sessionDays`. `factory ui sessions ls` and `revoke <id|all>` read and change that file, and
// the server reads it on each request, so a revoke takes effect at once. A request that comes with the cookie must come
// from the UI's own page: one with another Origin, or that the browser marks as sent from another site, is refused.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Notifier } from "./core/ports/notifications.ts";
import { configDir, machineSettings } from "./factory_machine.ts";

export const CODE_MINUTES = 10;

export interface Limits {
  sessionDays: number;
  maxWrongCodes: number;
  lockoutMinutes: number;
  codesPerHour: number;
}

export const LIMIT_DEFAULTS: Limits = { sessionDays: 30, maxWrongCodes: 5, lockoutMinutes: 15, codesPerHour: 5 };

/** What an IP may do, as a multiple of what one address may. */
const IP_FACTOR = 4;

function whole(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : dflt;
}

/** This machine's sign-in settings (`factory settings --local`), read each time so a change needs no restart. */
export function settings(): { allowed: string[]; limits: Limits } {
  const m = machineSettings();
  const list = Array.isArray(m["ui.signIn.allowed"]) ? m["ui.signIn.allowed"] : [];
  return {
    allowed: list.filter((x): x is string => typeof x === "string").map(normal).filter(Boolean),
    limits: {
      sessionDays: whole(m["ui.signIn.sessionDays"], LIMIT_DEFAULTS.sessionDays),
      maxWrongCodes: whole(m["ui.signIn.maxWrongCodes"], LIMIT_DEFAULTS.maxWrongCodes),
      lockoutMinutes: whole(m["ui.signIn.lockoutMinutes"], LIMIT_DEFAULTS.lockoutMinutes),
      codesPerHour: whole(m["ui.signIn.codesPerHour"], LIMIT_DEFAULTS.codesPerHour),
    },
  };
}

export function normal(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL = /^[^\s<>@"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;

// --- the sessions file ------------------------------------------------------------------------------------------------

export interface Session {
  /** What `factory ui sessions` shows and revokes; not the cookie, and nothing can be worked out from it. */
  id: string;
  /** SHA-256 (hex) of the cookie's value. */
  hash: string;
  email: string;
  created: string;
  expires: string;
  ip: string;
}

export function sessionsFile(): string {
  return join(configDir(), "ui", "sessions.json");
}

/** The sessions in the file, expired ones left out. */
export function readSessions(now = Date.now()): Session[] {
  try {
    const data = JSON.parse(readFileSync(sessionsFile(), "utf8")) as { sessions?: unknown };
    const list = Array.isArray(data.sessions) ? data.sessions : [];
    return list.filter((s): s is Session => typeof s === "object" && s !== null && typeof (s as Session).hash === "string" &&
      typeof (s as Session).id === "string" && Date.parse(String((s as Session).expires)) > now);
  } catch {
    return [];
  }
}

/** Writes `list` (mode 600, in a folder of mode 700), all at once. */
export function writeSessions(list: Session[]): void {
  writePrivate(sessionsFile(), JSON.stringify({ sessions: list }, null, 1) + "\n");
}

/** Writes `text` to `file` through a temporary file, mode 600 in a mode-700 folder; nothing half written is left. */
export function writePrivate(file: string, text: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// --- the requests -----------------------------------------------------------------------------------------------------

export interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

function problem(status: number, code: string, message: string, fix: string): Answer {
  return { status, body: { code, message, fix } };
}

/** True for a request a browser sent from another origin, or marked as sent from another site (#599's check, kept for
 * the cookie): the cookie alone never opens the API to another page. */
export function foreign(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== (req.headers.get("host") ?? "")) return true;
    } catch {
      return true;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

export const FOREIGN = problem(403, "ui_cross_origin", "The web UI's API answers its own page only, not a page from another address.",
  "Open the web UI's own address.");

interface Pending {
  hash: Buffer;
  expires: number;
}

export interface SignInOptions {
  /** The server's port: the cookie is named for it, so two servers on one host keep their own. */
  port: number;
  /** The mail sender, or null when none is set up (factory_ui_mail.ts). Asked each time. */
  notifier: () => Notifier | null;
  /** Allowed addresses and limits; default: this machine's settings, read each time. */
  settings?: () => { allowed: string[]; limits: Limits };
  /** Where a mail that could not be sent is told (never the code). */
  log?: (line: string) => void;
  now?: () => number;
}

export class SignIn {
  readonly cookie: string;
  private readonly key = randomBytes(32);
  private readonly pending = new Map<string, Pending>();
  private readonly asked = new Map<string, number[]>(); // code requests, by "a:<address>" and "ip:<ip>"
  private readonly wrong = new Map<string, number[]>(); // wrong codes, likewise
  private readonly locked = new Map<string, number>(); // until when
  private readonly settings: () => { allowed: string[]; limits: Limits };
  private readonly now: () => number;

  constructor(private readonly o: SignInOptions) {
    this.cookie = `factory_session_${o.port}`;
    this.settings = o.settings ?? settings;
    this.now = o.now ?? Date.now;
  }

  private mac(email: string, code: string): Buffer {
    return createHmac("sha256", this.key).update(`${email}\n${code}`).digest();
  }

  /** The times in `map[key]` within the last `ms`, kept; with `add`, now added. */
  private recent(map: Map<string, number[]>, key: string, ms: number, add = false): number {
    const t = this.now();
    const list = (map.get(key) ?? []).filter((x) => t - x < ms);
    if (add) list.push(t);
    if (list.length) map.set(key, list);
    else map.delete(key);
    return list.length;
  }

  private isLocked(key: string): boolean {
    const until = this.locked.get(key);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.locked.delete(key);
    return false;
  }

  /** Forgets what is old, so asking with ever new addresses can't fill the memory. */
  private prune(): void {
    if (this.asked.size + this.wrong.size + this.pending.size + this.locked.size < 5000) return;
    const t = this.now();
    for (const [k, p] of this.pending) if (p.expires <= t) this.pending.delete(k);
    for (const [k, u] of this.locked) if (u <= t) this.locked.delete(k);
    for (const k of [...this.asked.keys()]) this.recent(this.asked, k, 3_600_000);
    for (const k of [...this.wrong.keys()]) this.recent(this.wrong, k, 3_600_000);
  }

  /** The session the request's cookie names, when it is valid now. */
  session(req: Request): Session | null {
    const value = cookieOf(req, this.cookie);
    if (!value || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) return null;
    const hash = sha256(value);
    return readSessions(this.now()).find((s) => s.hash === hash) ?? null;
  }

  /** True when the request carries this server's cookie at all (valid or not). */
  hasCookie(req: Request): boolean {
    return cookieOf(req, this.cookie) !== null;
  }

  private setCookie(value: string, maxAge: number, secure: boolean): string {
    return `${this.cookie}=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  /** The answer to /api/auth[/...], or null for any other path. `ip` is the asker's address. */
  async api(req: Request, url: URL, ip: string): Promise<Answer | null> {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "auth" || parts.length > 3) return null;
    const what = parts[2] ?? "";
    if (foreign(req)) return FOREIGN;
    if (what === "") {
      if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
      const s = this.session(req);
      const { allowed } = this.settings();
      return { status: 200, body: { signedIn: s !== null, ...(s ? { email: s.email } : {}), mail: this.o.notifier() !== null && allowed.length > 0,
        codeMinutes: CODE_MINUTES } };
    }
    if (!["code", "verify", "signout"].includes(what)) return null;
    if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST.");
    const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
    if (what === "signout") {
      const s = this.session(req);
      if (s) writeSessions(readSessions(this.now()).filter((x) => x.id !== s.id));
      return { status: 200, body: { ok: true }, headers: { "set-cookie": this.setCookie("", 0, secure) } };
    }
    const body = (await req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
    const email = normal(typeof body?.email === "string" ? body.email : "");
    if (!EMAIL.test(email)) return problem(400, "ui_email_bad", "That isn't an email address.", "Type the address the code should go to, like me@example.com.");
    this.prune();
    return what === "code" ? this.askCode(email, ip) : this.verify(email, typeof body?.code === "string" ? body.code.trim() : "", ip, secure);
  }

  private askCode(email: string, ip: string): Answer {
    const notifier = this.o.notifier();
    if (!notifier) {
      return problem(503, "ui_mail_unset", "Codes can't be mailed from this machine: no mail sender is set up.",
        "Sign in with the token: open the address `factory ui` printed (it ends in ?token=...). The owner sets mail up with `factory ui mail set`.");
    }
    const { allowed, limits } = this.settings();
    const hour = 3_600_000;
    if (this.recent(this.asked, `a:${email}`, hour) >= limits.codesPerHour || this.recent(this.asked, `ip:${ip}`, hour) >= limits.codesPerHour * IP_FACTOR) {
      return problem(429, "ui_codes_limit", "Too many codes were asked for in the last hour.", "Wait an hour, or sign in with the token.");
    }
    this.recent(this.asked, `a:${email}`, hour, true);
    this.recent(this.asked, `ip:${ip}`, hour, true);
    // the same work for every address, and the mail after the answer: neither the answer nor its time says who is allowed
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const hash = this.mac(email, code);
    if (allowed.includes(email) && !this.isLocked(`a:${email}`)) {
      this.pending.set(email, { hash, expires: this.now() + CODE_MINUTES * 60_000 });
      setTimeout(() => {
        notifier.send(email, `Factory sign-in code: ${code}`, `Your code to sign in to the factory's web UI is ${code}.\n\n` +
          `It works once, for ${CODE_MINUTES} minutes. If you didn't ask for it, ignore this mail: nothing happens without the code.\n`)
          .catch((e: unknown) => {
            const code = e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : "mail_failed";
            this.o.log?.(`factory ui: a sign-in code could not be mailed (${code}: ${e instanceof Error ? e.message : String(e)})`);
          });
      }, 0);
    }
    return { status: 202, body: { ok: true, message: `If this address is allowed, a code is on its way. It works for ${CODE_MINUTES} minutes.` } };
  }

  private verify(email: string, code: string, ip: string, secure: boolean): Answer {
    const { limits } = this.settings();
    if (this.isLocked(`a:${email}`) || this.isLocked(`ip:${ip}`)) {
      return problem(429, "ui_signin_locked", "Too many wrong codes: signing in is locked for a while.",
        `Wait ${limits.lockoutMinutes} minutes, then ask for a new code; or sign in with the token.`);
    }
    const p = this.pending.get(email);
    const given = this.mac(email, /^\d{6}$/.test(code) ? code : "x");
    const live = p !== undefined && p.expires > this.now();
    const right = timingSafeEqual(given, p?.hash ?? this.mac(email, "none")) && live;
    if (right) {
      this.pending.delete(email); // once
      this.wrong.delete(`a:${email}`);
      const value = randomBytes(32).toString("base64url");
      const created = new Date(this.now());
      const s: Session = { id: randomBytes(5).toString("hex"), hash: sha256(value), email, created: created.toISOString(),
        expires: new Date(created.getTime() + limits.sessionDays * 86_400_000).toISOString(), ip };
      writeSessions([...readSessions(this.now()), s]);
      return { status: 200, body: { ok: true, email }, headers: { "set-cookie": this.setCookie(value, limits.sessionDays * 86_400, secure) } };
    }
    if (p && !live) this.pending.delete(email);
    const window = limits.lockoutMinutes * 60_000;
    const byAddress = this.recent(this.wrong, `a:${email}`, window, true);
    const byIp = this.recent(this.wrong, `ip:${ip}`, window, true);
    if (byAddress >= limits.maxWrongCodes || byIp >= limits.maxWrongCodes * IP_FACTOR) {
      if (byAddress >= limits.maxWrongCodes) {
        this.locked.set(`a:${email}`, this.now() + window);
        this.pending.delete(email); // its code is gone too
        this.wrong.delete(`a:${email}`);
      }
      if (byIp >= limits.maxWrongCodes * IP_FACTOR) {
        this.locked.set(`ip:${ip}`, this.now() + window);
        this.wrong.delete(`ip:${ip}`);
      }
      return problem(429, "ui_signin_locked", "Too many wrong codes: signing in is locked for a while.",
        `Wait ${limits.lockoutMinutes} minutes, then ask for a new code; or sign in with the token.`);
    }
    return problem(401, "ui_code_wrong", "That code isn't right, or it was used or has run out.", "Check the newest mail, or ask for a new code.");
  }
}

/** The value of cookie `name` in the request, or null. */
export function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// --- `factory ui sessions ls|revoke` ----------------------------------------------------------------------------------

export const SESSIONS_USAGE = `usage: factory ui sessions ls [--json]
       factory ui sessions revoke <id|all>

  The web UI's sign-in sessions on this machine (made by a code sent by email): ls lists them (id, address, from where,
  made, ends); revoke ends one by its id, or every one. A revoked session is refused at once, even in an open page.`;

export interface Refusal {
  code: string;
  message: string;
  fix: string;
}

/** Runs `factory ui sessions ...`; a refusal is thrown as `refuse` makes it. */
export function sessionsCli(argv: string[], refuse: (r: Refusal) => never): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(SESSIONS_USAGE);
    return cmd ? 0 : 2;
  }
  const list = readSessions();
  if (cmd === "ls") {
    if (rest.length && !(rest.length === 1 && rest[0] === "--json")) {
      refuse({ code: "ui_sessions_usage", message: `factory ui sessions ls doesn't take ${rest.join(" ")}.`, fix: "factory ui sessions ls [--json]" });
    }
    const shown = list.map(({ hash: _hash, ...s }) => s); // the hash stays in the file
    if (rest[0] === "--json") {
      console.log(JSON.stringify({ sessions: shown }, null, 1));
      return 0;
    }
    if (!shown.length) {
      console.log("No sign-in sessions on this machine.");
      return 0;
    }
    const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");
    console.log(`${"id".padEnd(12)}${"address".padEnd(32)}${"from".padEnd(17)}${"made".padEnd(18)}ends (UTC)`);
    for (const s of shown) console.log(`${s.id.padEnd(12)}${s.email.padEnd(32)}${(s.ip || "-").padEnd(17)}${when(s.created).padEnd(18)}${when(s.expires)}`);
    return 0;
  }
  if (cmd === "revoke") {
    const id = rest[0] ?? "";
    if (!id || rest.length > 1) refuse({ code: "ui_sessions_usage", message: "factory ui sessions revoke takes one id, or all.", fix: "`factory ui sessions ls` lists the ids." });
    if (id === "all") {
      writeSessions([]);
      console.log(`Revoked ${list.length} session${list.length === 1 ? "" : "s"}.`);
      return 0;
    }
    const left = list.filter((s) => s.id !== id);
    if (left.length === list.length) refuse({ code: "ui_session_unknown", message: `There is no session ${id} on this machine.`, fix: "`factory ui sessions ls` lists them." });
    writeSessions(left);
    console.log(`Revoked session ${id}.`);
    return 0;
  }
  refuse({ code: "ui_sessions_usage", message: `factory ui sessions has no ${cmd}.`, fix: "Use ls or revoke (see `factory ui sessions --help`)." });
}
