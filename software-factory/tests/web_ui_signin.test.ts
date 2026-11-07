// Signing in to the web UI with a code sent by email (#542). Two halves:
//
// - The sign-in's own answers (factory_ui_auth.ts's SignIn, as the server asks it), with a fake mail adapter that
//   records what it was asked to send and a clock the test moves: one mail for an allowed address and none for
//   another, the same answer for both; a code right once, then refused reused, expired and wrong; the limits and the
//   lockout; the cookie's flags.
// - The real server (`factory ui`, on a free port) with its mail going to a fake HTTP mail API in this process: the
//   session opens the API and the WebSocket, a cross-origin request with the cookie is refused, `factory ui sessions`
//   lists and revokes, and the token still works.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notifier } from "../hooks/core/ports/notifications.ts";
import { type Limits, LIMIT_DEFAULTS, SignIn } from "../hooks/factory_ui_auth.ts";
import { api, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { BUN, HOOKS, sh, write } from "./support.ts";

const T = 60_000;
const roots: string[] = [];
const running: Running[] = [];
let configDir = "";
const before = process.env.FACTORY_CONFIG_DIR;
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "signin-config-"));
  process.env.FACTORY_CONFIG_DIR = configDir; // the sessions file of the in-process half
});
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of [...roots, configDir]) rmSync(d, { recursive: true, force: true });
  if (before === undefined) delete process.env.FACTORY_CONFIG_DIR;
  else process.env.FACTORY_CONFIG_DIR = before;
});

// --- the sign-in's answers, with a fake mail adapter ------------------------------------------------------------------

interface Mail {
  to: string;
  subject: string;
  text: string;
}

class FakeMail implements Notifier {
  sent: Mail[] = [];
  hold: Promise<void> | null = null;
  async send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text });
    if (this.hold) await this.hold;
  }
}

const OWNER = "owner@example.com";

function signIn(o: { mail?: FakeMail | null; limits?: Partial<Limits>; allowed?: string[] } = {}) {
  let t = Date.parse("2026-11-07T10:00:00Z");
  const mail = o.mail === undefined ? new FakeMail() : o.mail;
  const s = new SignIn({ port: 4747, notifier: () => mail, now: () => t,
    settings: () => ({ allowed: o.allowed ?? [OWNER], limits: { ...LIMIT_DEFAULTS, ...o.limits } }) });
  const ask = async (path: string, body: unknown, more: { ip?: string; url?: string; headers?: Record<string, string> } = {}) => {
    const url = new URL((more.url ?? "http://127.0.0.1:4747") + path);
    const req = new Request(url, { method: "POST", headers: { host: url.host, "content-type": "application/json", ...more.headers }, body: JSON.stringify(body) });
    const a = await s.api(req, url, more.ip ?? "10.0.0.1");
    if (!a) throw new Error(`no answer for ${path}`);
    return a;
  };
  return { s, mail, ask, move: (ms: number) => { t += ms; } };
}

/** Lets the mail that goes out after the answer go. */
const settle = (): Promise<void> => Bun.sleep(20);

function codeIn(m: Mail | undefined): string {
  return /\b(\d{6})\b/.exec(m?.text ?? "")?.[1] ?? "";
}

test("an allowed address gets exactly one mail with a 6-digit code; another gets none; both get the same answer", async () => {
  const { mail, ask } = signIn();
  const allowed = await ask("/api/auth/code", { email: "Owner@Example.com " });
  const other = await ask("/api/auth/code", { email: "stranger@example.com" });
  await settle();
  expect(allowed.status).toBe(202);
  expect(other.status).toBe(allowed.status);
  expect(other.body).toEqual(allowed.body);
  expect(String(allowed.body.message)).toContain("If this address is allowed, a code is on its way");
  expect(mail?.sent.length).toBe(1);
  expect(mail?.sent[0]?.to).toBe(OWNER);
  expect(codeIn(mail?.sent[0])).toMatch(/^\d{6}$/);
  expect(mail?.sent[0]?.text).toContain("10 minutes");
});

test("the answer doesn't wait for the mail, so its time doesn't say whether the address is allowed", async () => {
  const fake = new FakeMail();
  let release = (): void => {};
  fake.hold = new Promise<void>((done) => { release = done; }); // the mail service never answers while we look
  const { ask } = signIn({ mail: fake });
  const started = performance.now();
  const a = await ask("/api/auth/code", { email: OWNER });
  const took = performance.now() - started;
  expect(a.status).toBe(202);
  expect(took).toBeLessThan(500);
  await settle();
  expect(fake.sent.length).toBe(1); // it went out after the answer
  release();
});

test("the right code works once; then it is refused reused, and a wrong or expired code is refused", async () => {
  const { mail, ask, move } = signIn();
  await ask("/api/auth/code", { email: OWNER });
  await settle();
  const code = codeIn(mail?.sent[0]);
  const wrongCode = code === "000000" ? "111111" : "000000";
  const wrong = await ask("/api/auth/verify", { email: OWNER, code: wrongCode });
  expect(wrong.status).toBe(401);
  expect(wrong.body.code).toBe("ui_code_wrong");
  const right = await ask("/api/auth/verify", { email: OWNER, code });
  expect(right.status).toBe(200);
  expect(right.body).toMatchObject({ ok: true, email: OWNER });
  const reused = await ask("/api/auth/verify", { email: OWNER, code });
  expect(reused.status).toBe(401);
  expect(reused.body.code).toBe("ui_code_wrong");

  await ask("/api/auth/code", { email: OWNER });
  await settle();
  const late = codeIn(mail?.sent[1]);
  move(10 * 60_000 + 1000);
  const expired = await ask("/api/auth/verify", { email: OWNER, code: late });
  expect(expired.status).toBe(401);
  expect(expired.body).toMatchObject({ code: "ui_code_wrong" });
  expect(Object.keys(expired.body).sort()).toEqual(["code", "fix", "message"]);
});

test("a code for an address that isn't allowed never works, and the refusal is the same as for a wrong one", async () => {
  const { ask } = signIn();
  await ask("/api/auth/code", { email: "stranger@example.com" });
  const r = await ask("/api/auth/verify", { email: "stranger@example.com", code: "123456" });
  expect(r.status).toBe(401);
  expect(r.body.code).toBe("ui_code_wrong");
});

test("too many wrong codes lock the address, even for the right code, until the lockout ends", async () => {
  const { mail, ask, move } = signIn({ limits: { maxWrongCodes: 3, lockoutMinutes: 15 } });
  await ask("/api/auth/code", { email: OWNER });
  await settle();
  const code = codeIn(mail?.sent[0]);
  const bad = code === "999999" ? "888888" : "999999";
  expect((await ask("/api/auth/verify", { email: OWNER, code: bad })).status).toBe(401);
  expect((await ask("/api/auth/verify", { email: OWNER, code: bad }, { ip: "10.0.0.2" })).status).toBe(401);
  const third = await ask("/api/auth/verify", { email: OWNER, code: bad }, { ip: "10.0.0.3" }); // per address, from any IP
  expect(third.status).toBe(429);
  expect(third.body.code).toBe("ui_signin_locked");
  const locked = await ask("/api/auth/verify", { email: OWNER, code });
  expect(locked.status).toBe(429);
  expect(locked.body.code).toBe("ui_signin_locked");
  move(15 * 60_000 + 1000);
  const after = await ask("/api/auth/verify", { email: OWNER, code }); // the lock threw that code away
  expect(after.status).toBe(401);
  await ask("/api/auth/code", { email: OWNER });
  await settle();
  expect((await ask("/api/auth/verify", { email: OWNER, code: codeIn(mail?.sent.at(-1)) })).status).toBe(200);
});

test("wrong codes from one IP across many addresses lock that IP", async () => {
  const { ask } = signIn({ limits: { maxWrongCodes: 2 } }); // an IP: 4 times that
  for (let i = 0; i < 7; i++) expect((await ask("/api/auth/verify", { email: `x${i}@example.com`, code: "123456" }, { ip: "10.9.9.9" })).status).toBe(401);
  const eighth = await ask("/api/auth/verify", { email: "x8@example.com", code: "123456" }, { ip: "10.9.9.9" });
  expect(eighth.status).toBe(429);
  expect((await ask("/api/auth/verify", { email: "y@example.com", code: "123456" }, { ip: "10.9.9.9" })).status).toBe(429);
  expect((await ask("/api/auth/verify", { email: "y@example.com", code: "123456" }, { ip: "10.1.1.1" })).status).toBe(401);
});

test("asking for codes is limited per address, allowed or not alike, and per IP", async () => {
  const { mail, ask } = signIn({ limits: { codesPerHour: 2 } });
  for (const email of [OWNER, "stranger@example.com"]) {
    expect((await ask("/api/auth/code", { email }, { ip: `10.0.1.${email.length}` })).status).toBe(202);
    expect((await ask("/api/auth/code", { email }, { ip: `10.0.2.${email.length}` })).status).toBe(202);
    const third = await ask("/api/auth/code", { email }, { ip: `10.0.3.${email.length}` });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("ui_codes_limit");
  }
  await settle();
  expect(mail?.sent.length).toBe(2);
  for (let i = 0; i < 8; i++) expect((await ask("/api/auth/code", { email: `n${i}@example.com` }, { ip: "10.7.7.7" })).status).toBe(202);
  expect((await ask("/api/auth/code", { email: "n9@example.com" }, { ip: "10.7.7.7" })).status).toBe(429);
});

test("the session cookie is HttpOnly, SameSite=Strict, for /api only, lasts the set days, and is Secure over HTTPS", async () => {
  for (const [url, secure] of [["http://127.0.0.1:4747", false], ["https://hub.example.ts.net", true]] as const) {
    const { mail, ask } = signIn({ limits: { sessionDays: 7 } });
    await ask("/api/auth/code", { email: OWNER }, { url });
    await settle();
    const r = await ask("/api/auth/verify", { email: OWNER, code: codeIn(mail?.sent[0]) }, { url });
    expect(r.status).toBe(200);
    const cookie = r.headers?.["set-cookie"] ?? "";
    expect(cookie).toMatch(/^factory_session_4747=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain("; Path=/api;");
    expect(cookie).toContain(`; Max-Age=${7 * 86_400};`);
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; SameSite=Strict");
    expect(cookie.includes("; Secure")).toBe(secure);
  }
});

test("a sign-in request from another origin is refused, and nothing is mailed", async () => {
  const { mail, ask } = signIn();
  const r = await ask("/api/auth/code", { email: OWNER }, { headers: { origin: "http://127.0.0.1:4748" } });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe("ui_cross_origin");
  await settle();
  expect(mail?.sent.length).toBe(0);
});

test("with no mail set up, asking for a code says to sign in with the token", async () => {
  const { s, ask } = signIn({ mail: null });
  const r = await ask("/api/auth/code", { email: OWNER });
  expect(r.status).toBe(503);
  expect(r.body.code).toBe("ui_mail_unset");
  expect(String(r.body.fix)).toContain("?token=");
  const url = new URL("http://127.0.0.1:4747/api/auth");
  const info = await s.api(new Request(url, { headers: { host: url.host } }), url, "10.0.0.1");
  expect(info?.body).toMatchObject({ signedIn: false, mail: false });
});

// --- the real server, its mail going to a fake HTTP mail API ----------------------------------------------------------

interface Got {
  headers: Record<string, string>;
  body: Row;
}

const got: Got[] = [];
let fakeApi: ReturnType<typeof Bun.serve> | null = null;
function mailApi(): string {
  fakeApi ??= Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    got.push({ headers: Object.fromEntries(req.headers.entries()), body: (await req.json()) as Row });
    return Response.json({ id: "fake" });
  } });
  return `http://127.0.0.1:${fakeApi.port}/emails`;
}
afterAll(() => {
  fakeApi?.stop(true);
});

const SECRET = "re_fake_key_never_printed_42";

/** A project whose machine has mail set (to the fake API) and OWNER allowed; its server started. */
async function hub(): Promise<{ p: Project; ui: Running; config: string }> {
  const p = project();
  roots.push(p.root);
  const config = join(p.root, "config", "software-factory");
  write(join(config, "ui", "mail.json"), JSON.stringify({ kind: "http", preset: "", url: mailApi(), header: "Authorization: Bearer {{secret}}",
    body: '{"from": {{from}}, "to": [{{to}}], "subject": {{subject}}, "text": {{text}}}', from: "Factory <factory@example.com>", secret: SECRET }), 0o600);
  write(join(config, "work.json"), JSON.stringify({ "ui.signIn.allowed": [OWNER] }));
  const ui = await startUi(p);
  running.push(ui);
  return { p, ui, config };
}

async function post(ui: Running, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Row; cookie: string }> {
  const r = await fetch(ui.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Row, cookie: r.headers.get("set-cookie") ?? "" };
}

async function codeFor(email: string, since: number): Promise<string> {
  for (let i = 0; i < 100 && got.length <= since; i++) await Bun.sleep(50);
  const text = String(got[since]?.body.text ?? "");
  expect(got[since]?.body.to).toEqual([email]);
  return /\b(\d{6})\b/.exec(text)?.[1] ?? "";
}

/** Signs OWNER in on `ui`; the cookie as a browser sends it back. */
async function signedIn(ui: Running): Promise<string> {
  const since = got.length;
  expect((await post(ui, "/api/auth/code", { email: OWNER })).status).toBe(202);
  const code = await codeFor(OWNER, since);
  const r = await post(ui, "/api/auth/verify", { email: OWNER, code });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.cookie.split(";")[0] ?? "";
}

async function get(ui: Running, path: string, headers: Record<string, string>): Promise<{ status: number; json: Row }> {
  const r = await fetch(ui.url + path, { headers });
  return { status: r.status, json: (await r.json()) as Row };
}

function wsHello(ui: Running, headers: Record<string, string>, query = ""): Promise<string> {
  return new Promise((done) => {
    const ws = new WebSocket(ui.url.replace("http", "ws") + "/api/ws" + query, { headers } as unknown as string[]);
    const timer = setTimeout(() => { ws.close(); done("timeout"); }, 10_000);
    ws.onmessage = (e) => {
      clearTimeout(timer);
      ws.close();
      done(String((JSON.parse(String(e.data)) as Row).type));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done("refused");
    };
  });
}

test("the page learns that codes can be mailed; the mail goes to the API with the key, which is never in the answer", async () => {
  const { ui } = await hub();
  const info = await get(ui, "/api/auth", {});
  expect(info.status).toBe(200);
  expect(info.json).toMatchObject({ signedIn: false, mail: true, codeMinutes: 10 });
  expect(JSON.stringify(info.json)).not.toContain(OWNER);
  const since = got.length;
  const r = await post(ui, "/api/auth/code", { email: OWNER });
  expect(r.status).toBe(202);
  await codeFor(OWNER, since);
  expect(got[since]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  expect(got[since]?.body.from).toBe("Factory <factory@example.com>");
  const other = await post(ui, "/api/auth/code", { email: "stranger@example.com" });
  expect(other.json).toEqual(r.json);
  await Bun.sleep(300);
  expect(got.length).toBe(since + 1);
  expect(ui.out).not.toContain(SECRET);
}, T);

test("the session opens the API and the WebSocket; without it both are refused; GET /api/auth says who is signed in", async () => {
  const { ui } = await hub();
  const cookie = await signedIn(ui);
  expect(cookie).toMatch(/^factory_session_\d+=/);
  const projects = await get(ui, "/api/projects", { cookie });
  expect(projects.status).toBe(200);
  expect((projects.json.projects as Row[])[0]?.name).toBe("work");
  expect((await get(ui, "/api/auth", { cookie })).json).toMatchObject({ signedIn: true, email: OWNER });
  expect(await wsHello(ui, { cookie })).toBe("hello");
  expect((await get(ui, "/api/projects", {})).status).toBe(401);
  expect(await wsHello(ui, {})).toBe("refused");
  const forged = await get(ui, "/api/projects", { cookie: cookie.replace(/=.*/, "=" + "A".repeat(43)) });
  expect(forged.status).toBe(401);
}, T);

test("a cross-origin request with the cookie is refused, over HTTP and the WebSocket", async () => {
  const { ui } = await hub();
  const cookie = await signedIn(ui);
  const port = new URL(ui.url).port;
  const preview = `http://127.0.0.1:${Number(port) + 1}`; // another port of the same host: the same site, another origin
  const r = await get(ui, "/api/projects", { cookie, origin: preview });
  expect(r.status).toBe(403);
  expect(r.json.code).toBe("ui_cross_origin");
  expect((await get(ui, "/api/projects", { cookie, "sec-fetch-site": "same-site" })).status).toBe(403);
  const posted = await fetch(`${ui.url}/api/projects/work/agents/menelik/stop`, { method: "POST", headers: { cookie, origin: preview,
    "content-type": "text/plain" }, body: '{"confirm": true}' });
  expect(posted.status).toBe(403);
  expect(await wsHello(ui, { cookie, origin: preview })).toBe("refused");
  expect((await get(ui, "/api/projects", { cookie, origin: ui.url, "sec-fetch-site": "same-origin" })).status).toBe(200);
}, T);

function factoryUi(p: Project, args: string[]) {
  return sh([...BUN, join(HOOKS, "factory_ui.ts"), ...args], { cwd: p.d, env: p.env, timeoutMs: 30_000 });
}

test("factory ui sessions ls lists the session without its secret; revoke ends it at once; revoke all ends every one", async () => {
  const { p, ui, config } = await hub();
  const cookie = await signedIn(ui);
  const file = join(config, "ui", "sessions.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(config, "ui")).mode & 0o777).toBe(0o700);
  const value = cookie.split("=")[1] ?? "";
  expect(readFileSync(file, "utf8")).not.toContain(value); // only its hash is kept
  const ls = factoryUi(p, ["sessions", "ls", "--json"]);
  expect(ls.code, ls.out).toBe(0);
  const sessions = (JSON.parse(ls.stdout) as { sessions: Row[] }).sessions;
  expect(sessions.length).toBe(1);
  expect(sessions[0]).toMatchObject({ email: OWNER, ip: "127.0.0.1" });
  expect(Object.keys(sessions[0] as Row)).not.toContain("hash");
  const text = factoryUi(p, ["sessions", "ls"]);
  expect(text.stdout).toContain(OWNER);
  expect(text.stdout).toContain(String(sessions[0]?.id));
  expect(text.out).not.toContain(value);

  const revoked = factoryUi(p, ["sessions", "revoke", String(sessions[0]?.id)]);
  expect(revoked.code, revoked.out).toBe(0);
  expect(revoked.stdout).toContain(`Revoked session ${sessions[0]?.id}.`);
  const after = await get(ui, "/api/projects", { cookie });
  expect(after.status).toBe(401);
  expect(after.json.code).toBe("ui_session_ended");
  expect(await wsHello(ui, { cookie })).toBe("refused");

  const unknown = factoryUi(p, ["sessions", "revoke", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('"code": "ui_session_unknown"');
  const a = await signedIn(ui);
  const b = await signedIn(ui);
  const all = factoryUi(p, ["sessions", "revoke", "all"]);
  expect(all.stdout).toContain("Revoked 2 sessions.");
  for (const c of [a, b]) expect((await get(ui, "/api/projects", { cookie: c })).status).toBe(401);
  expect(factoryUi(p, ["sessions", "ls"]).stdout).toContain("No sign-in sessions on this machine.");
}, T);

test("signing out ends the session and clears the cookie", async () => {
  const { ui } = await hub();
  const cookie = await signedIn(ui);
  const r = await post(ui, "/api/auth/signout", {}, { cookie });
  expect(r.status).toBe(200);
  expect(r.cookie).toContain("Max-Age=0");
  expect((await get(ui, "/api/projects", { cookie })).status).toBe(401);
}, T);

test("the token still works for the API and the WebSocket, beside sign-in", async () => {
  const { ui } = await hub();
  const r = await api(ui, "/api/projects");
  expect(r.status).toBe(200);
  expect(await wsHello(ui, {}, `?token=${ui.token}`)).toBe("hello");
  expect((await api(ui, "/api/projects", { token: "wrong".repeat(10) })).json.code).toBe("ui_token_wrong");
}, T);

test("with no mail set up the server says so, and the token is the way in", async () => {
  const p = project();
  roots.push(p.root);
  const ui = await startUi(p);
  running.push(ui);
  expect((await get(ui, "/api/auth", {})).json).toMatchObject({ signedIn: false, mail: false });
  const r = await post(ui, "/api/auth/code", { email: OWNER });
  expect(r.status).toBe(503);
  expect(r.json.code).toBe("ui_mail_unset");
  expect((await api(ui, "/api/projects")).status).toBe(200);
}, T);
