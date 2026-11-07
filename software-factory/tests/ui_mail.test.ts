// `factory ui mail set|show|test` and `factory ui sessions` as commands (#542): the help, the HTTP mail API adapter
// against a fake API in this process, the settings file (mode 600, this machine's only), the refusals that save
// nothing, `factory doctor`'s check, and the secret, which never appears in any output: not from set, show, test, the
// doctor, nor the server's log when the mail service refuses and echoes it back.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { doctor, lines, machine, project as doctorProject } from "./doctor_support.ts";
import { project, type Project, type Row, startUi } from "./web_ui_support.ts";
import { BUN, HOOKS, readmeAndWiki, SF, sh, write } from "./support.ts";

const SECRET = "re_SECRET_key_4242_never_printed";
const roots: string[] = [];
const got: { headers: Record<string, string>; body: Row }[] = [];
let refuse = false;
const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const headers = Object.fromEntries(req.headers.entries());
  got.push({ headers, body: (await req.json()) as Row });
  // a refusing service that echoes the key back, as some do
  return refuse ? Response.json({ message: `invalid key ${headers.authorization}` }, { status: 401 }) : Response.json({ id: "1" });
} });
const URL_ = `http://127.0.0.1:${fake.port}/emails`;
afterAll(() => {
  fake.stop(true);
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function fresh(): Project {
  const p = project();
  roots.push(p.root);
  return p;
}

function mailFile(p: Project): string {
  return join(p.root, "config", "software-factory", "ui", "mail.json");
}

/** `factory ui ...` without blocking this process, so the fake API can answer. */
async function ui(p: Project, args: string[], input = "", env: Record<string, string | undefined> = {}) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...p.env, ...env })) if (v !== undefined) clean[k] = v;
  const proc = Bun.spawn([...BUN, join(HOOKS, "factory_ui.ts"), ...args], { cwd: p.d, env: clean, stdin: new TextEncoder().encode(input),
    stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr, out: stdout + stderr };
}

const GENERIC = ["mail", "set", "http", "--url", URL_, "--header", "Authorization: Bearer {{secret}}",
  "--body", '{"from": {{from}}, "to": [{{to}}], "subject": {{subject}}, "text": {{text}}}', "--from", "Factory <factory@example.com>"];

test("factory help, the commands page and factory ui --help name the sessions and mail commands", async () => {
  const p = fresh();
  const help = sh(["bash", join(SF, "factory"), "help"], { cwd: p.d, env: p.env });
  expect(help.code, help.out).toBe(0);
  expect(help.stdout).toContain("ui sessions ls|revoke <id|all>");
  expect(help.stdout).toContain("ui mail set|show|test");
  const commands = readmeAndWiki("commands.md");
  expect(commands).toContain("| `factory ui sessions ls\\|revoke <id\\|all>` |");
  expect(commands).toContain("| `factory ui mail set\\|show\\|test` |");
  const usage = await ui(p, ["--help"]);
  expect(usage.stdout).toContain("factory ui sessions ls|revoke <id|all>");
  expect(usage.stdout).toContain("factory ui mail set|show|test");
  const mail = await ui(p, ["mail", "--help"]);
  expect(mail.code).toBe(0);
  expect(mail.stdout).toContain("factory ui mail set http --preset resend|postmark --from ADDRESS");
  expect(mail.stdout).toContain("factory ui mail set smtp --host HOST");
  const sessions = await ui(p, ["sessions", "--help"]);
  expect(sessions.code).toBe(0);
  expect(sessions.stdout).toContain("factory ui sessions revoke <id|all>");
  const settings = readmeAndWiki("settings.md");
  for (const key of ["ui.signIn.allowed", "ui.signIn.sessionDays", "ui.signIn.codesPerHour", "ui.signIn.maxWrongCodes", "ui.signIn.lockoutMinutes"]) {
    expect(settings).toContain(`| \`${key}\` |`);
  }
});

test("mail set with a preset saves this machine's file, mode 600, with the key from stdin, and never prints it", async () => {
  const p = fresh();
  const set = await ui(p, ["mail", "set", "http", "--preset", "resend", "--from", "Factory <factory@example.com>"], SECRET + "\n");
  expect(set.code, set.out).toBe(0);
  expect(set.stdout).toContain("Saved: sign-in codes go through the mail API at api.resend.com (resend)");
  expect(set.out).not.toContain(SECRET);
  const file = mailFile(p);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
  const saved = JSON.parse(readFileSync(file, "utf8")) as Row;
  expect(saved).toMatchObject({ kind: "http", preset: "resend", url: "https://api.resend.com/emails", secret: SECRET });
  expect(existsSync(join(p.d, ".claude", "ui"))).toBe(false);
  expect(readFileSync(join(p.d, ".claude", "factory.json"), "utf8")).not.toContain(SECRET);
  const show = await ui(p, ["mail", "show"]);
  expect(show.code).toBe(0);
  expect(show.stdout).toContain("key       set (not shown)");
  expect(show.stdout).toContain("mode 600");
  expect(show.out).not.toContain(SECRET);
});

test("a key given as an argument, or settings that can't be used, are refused and nothing is saved or changed", async () => {
  const p = fresh();
  const arg = await ui(p, ["mail", "set", "http", "--preset", "resend", "--from", "f@example.com", "--secret", SECRET]);
  expect(arg.code).toBe(1);
  expect(arg.stderr).toContain('"code": "ui_mail_secret_argument"');
  expect(arg.out).not.toContain(SECRET);
  expect(existsSync(mailFile(p))).toBe(false);
  const plain = await ui(p, ["mail", "set", "http", "--url", "http://mail.example.com/send", "--header", "Authorization: Bearer {{secret}}",
    "--body", '{"to": {{to}}}', "--from", "f@example.com"], SECRET);
  expect(plain.code).toBe(1);
  expect(plain.stderr).toContain('"code": "ui_mail_bad"');
  expect(plain.stderr).toContain("https://");
  expect(existsSync(mailFile(p))).toBe(false);
  expect((await ui(p, GENERIC, SECRET)).code).toBe(0);
  const before = readFileSync(mailFile(p), "utf8");
  const badBody = await ui(p, ["mail", "set", "http", "--url", URL_, "--header", "Authorization: Bearer {{secret}}", "--body", "{to: {{to}}",
    "--from", "f@example.com"], "other-key");
  expect(badBody.code).toBe(1);
  expect(badBody.stderr).toContain("isn't JSON");
  const noKey = await ui(p, ["mail", "set", "smtp", "--host", "smtp.example.com", "--user", "bot", "--from", "f@example.com"], "");
  expect(noKey.code).toBe(1);
  expect(noKey.stderr).toContain('"code": "ui_mail_secret_missing"');
  expect(readFileSync(mailFile(p), "utf8")).toBe(before);
});

test("mail test sends one mail through the API; a refusal is {code, message, fix} without the key, even when the API echoes it", async () => {
  const p = fresh();
  expect((await ui(p, ["mail", "test", "owner@example.com"])).stderr).toContain('"code": "ui_mail_unset"');
  expect((await ui(p, GENERIC, SECRET)).code).toBe(0);
  const since = got.length;
  refuse = false;
  const ok = await ui(p, ["mail", "test", "owner@example.com"]);
  expect(ok.code, ok.out).toBe(0);
  expect(ok.stdout).toContain(`Sent a test mail to owner@example.com through the mail API at 127.0.0.1:${fake.port}.`);
  expect(got.length).toBe(since + 1);
  expect(got[since]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  expect(got[since]?.body).toMatchObject({ from: "Factory <factory@example.com>", to: ["owner@example.com"], subject: "Factory: test mail" });
  refuse = true;
  const no = await ui(p, ["mail", "test", "owner@example.com"]);
  refuse = false;
  expect(no.code).toBe(1);
  const e = JSON.parse(no.stderr) as Row;
  expect(Object.keys(e).sort()).toEqual(["code", "fix", "message"]);
  expect(e.code).toBe("mail_api_refused");
  expect(String(e.message)).toContain("401");
  expect(no.out).not.toContain(SECRET);
});

test("the server's log of a mail that failed never holds the key", async () => {
  const p = fresh();
  expect((await ui(p, GENERIC, SECRET)).code).toBe(0);
  write(join(p.root, "config", "software-factory", "work.json"), JSON.stringify({ "ui.signIn.allowed": ["owner@example.com"] }));
  const server = await startUi(p);
  refuse = true;
  const since = got.length;
  const r = await fetch(server.url + "/api/auth/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.com" }) });
  expect(r.status).toBe(202);
  for (let i = 0; i < 100 && got.length <= since; i++) await Bun.sleep(50);
  await Bun.sleep(300);
  refuse = false;
  server.proc.kill();
  const reader = (server.proc.stdout as ReadableStream<Uint8Array>).getReader();
  let rest = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    rest += new TextDecoder().decode(next.value);
  }
  await server.stop();
  expect(rest).toContain("a sign-in code could not be mailed (mail_api_refused");
  expect(server.out + rest).not.toContain(SECRET);
  expect(rest).not.toMatch(/\b\d{6}\b/); // nor the code
});

test("an agent session can't read or change the sign-in or the mail settings", async () => {
  const p = fresh();
  for (const args of [["mail", "show"], ["sessions", "ls"], ["sessions", "revoke", "all"]]) {
    const r = await ui(p, args, "", { FACTORY_AGENT: "menelik" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('"code": "owner_only"');
  }
});

test("factory doctor checks the mail settings' mode and shape, notes nobody allowed, and never prints the key", () => {
  const d = doctorProject();
  roots.push(d);
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  const config = join(env.HOME, ".config", "software-factory");
  const file = join(config, "ui", "mail.json");
  write(file, JSON.stringify({ kind: "http", preset: "", url: "https://api.example.com/send", header: "X-Key: {{secret}}", body: '{"to": {{to}}}',
    from: "f@example.com", secret: SECRET }), 0o600);
  chmodSync(join(config, "ui"), 0o700);
  const okRun = doctor(d, env);
  expect(lines(okRun, "ok").some((l) => l.includes("web UI mail: the mail API at api.example.com, from f@example.com")), okRun.stdout).toBe(true);
  expect(lines(okRun, "note").some((l) => l.includes("nobody is allowed")), okRun.stdout).toBe(true);
  expect(okRun.out).not.toContain(SECRET);
  write(join(config, `${basename(d)}.json`), JSON.stringify({ "ui.signIn.allowed": ["owner@example.com"] }));
  chmodSync(file, 0o644);
  const loose = doctor(d, env);
  expect(lines(loose, "fix").some((l) => l.includes("readable by others") && l.includes("chmod 600")), loose.stdout).toBe(true);
  expect(lines(loose, "note").some((l) => l.includes("nobody is allowed"))).toBe(false);
  expect(loose.out).not.toContain(SECRET);
  rmSync(file);
  const none = doctor(d, env);
  expect(lines(none, "note").some((l) => l.includes("no mail sender is set up")), none.stdout).toBe(true);
});
