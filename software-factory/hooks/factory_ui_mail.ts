// The web UI's mail sender (#542): its settings, the adapter they pick, and `factory ui mail set|show|test`.
//
// The settings, the key or password with them, live in <machine settings folder>/ui/mail.json (mode 600, its folder
// 700): this machine's, never the repo's or the project settings', and never printed (`show` says only whether the
// secret is set). `set` checks everything first and changes nothing on a refusal; the secret is asked for without
// echo, or read from stdin when it isn't a terminal, never taken as an argument (it would stay in the shell's history).
//
//   factory ui mail set http --preset resend|postmark --from ADDRESS
//   factory ui mail set http --url URL --header 'Name: value with {{secret}}' --body JSON-TEMPLATE --from ADDRESS
//   factory ui mail set smtp --host HOST [--port N] [--security starttls|tls] [--user USER] [--auth plain|login]
//                            [--ca-file PEM] --from ADDRESS
//   factory ui mail show
//   factory ui mail test <address>
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CoreError } from "./core/domain/error.ts";
import { httpMailProblem as httpProblem, MAIL_PRESETS as PRESETS, notifierFor, smtpMailProblem as smtpProblem } from "./core/compose.ts";
import type { Notifier } from "./core/ports/notifications.ts";
import { writePrivate } from "./factory_ui_auth.ts";
import { configDir } from "./factory_machine.ts";
import { FactoryError } from "./factory_lib.ts";

export interface HttpSettings {
  kind: "http";
  preset: string;
  url: string;
  header: string;
  body: string;
  from: string;
  secret: string;
}

export interface SmtpSettings {
  kind: "smtp";
  host: string;
  port: number;
  security: "starttls" | "tls";
  user: string;
  auth: "plain" | "login" | "";
  caFile: string;
  from: string;
  secret: string;
}

export type MailSettings = HttpSettings | SmtpSettings;

export const MAIL_USAGE = `usage: factory ui mail set http --preset resend|postmark --from ADDRESS
       factory ui mail set http --url URL --header 'Name: value' --body JSON --from ADDRESS
       factory ui mail set smtp --host HOST [--port N] [--security starttls|tls] [--user USER] [--auth plain|login] [--ca-file PEM] --from ADDRESS
       factory ui mail show
       factory ui mail test <address>

  The mail sender for the web UI's sign-in codes, kept on this machine only (mode 600), never in the repo.
  The API key or password is asked for without echo, or read from stdin; it is never printed.
  In --header (or --url), {{secret}} is the key; in --body, {{from}}, {{to}}, {{subject}} and {{text}} are filled in.`;

function fail(code: string, message: string, fix: string): never {
  throw new FactoryError(code, message, fix);
}

export function mailFile(): string {
  return join(configDir(), "ui", "mail.json");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The settings in `data`, or what is wrong with them (said without the secret). */
export function parseSettings(data: unknown): MailSettings | string {
  if (typeof data !== "object" || data === null) return "the file isn't a JSON object";
  const d = data as Record<string, unknown>;
  if (d.kind === "http") {
    const m: HttpSettings = { kind: "http", preset: str(d.preset), url: str(d.url), header: str(d.header), body: str(d.body), from: str(d.from), secret: str(d.secret) };
    const bad = httpProblem(m);
    if (bad) return bad;
    return m.secret ? m : "the API key isn't set";
  }
  if (d.kind === "smtp") {
    const m: SmtpSettings = { kind: "smtp", host: str(d.host), port: typeof d.port === "number" ? d.port : Number.NaN,
      security: d.security === "tls" ? "tls" : d.security === "starttls" ? "starttls" : ("" as "tls"), user: str(d.user),
      auth: d.auth === "plain" || d.auth === "login" ? d.auth : "", caFile: str(d.caFile), from: str(d.from), secret: str(d.secret) };
    const bad = smtpProblem(m);
    if (bad) return bad;
    return m.user && !m.secret ? "the password isn't set" : m;
  }
  return "kind must be http or smtp";
}

/** This machine's mail settings: null when none are set, else the settings or what is wrong with them. */
export function readSettings(): MailSettings | string | null {
  const file = mailFile();
  if (!existsSync(file)) return null;
  try {
    return parseSettings(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return "the file isn't JSON";
  }
}

export function notifierOf(m: MailSettings): Notifier {
  return notifierFor(m);
}

/** The mail sender the server uses: null when none is set up or its settings can't be used. */
export function notifier(): Notifier | null {
  const m = readSettings();
  return m === null || typeof m === "string" ? null : notifierOf(m);
}

/** Where the mail goes through, in words, with no secret. */
export function describe(m: MailSettings): string {
  if (m.kind === "smtp") return `SMTP ${m.host}:${m.port} (${m.security}${m.user ? `, user ${m.user}` : ", no login"})`;
  let host = m.url;
  try {
    host = new URL(m.url.split("{{secret}}").join("x")).host;
  } catch {
    // shown as written
  }
  return `the mail API at ${host}${m.preset ? ` (${m.preset})` : ""}`;
}

// --- the command ------------------------------------------------------------------------------------------------------

type Flags = Record<string, string>;

function flags(argv: string[], allowed: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i] as string;
    const eq = x.indexOf("=");
    const [name, inline] = x.startsWith("--") && eq > 0 ? [x.slice(0, eq), x.slice(eq + 1)] : [x, null];
    if (!allowed.includes(name)) {
      if (/^--?(secret|password|key|token)/.test(name)) {
        fail("ui_mail_secret_argument", "The key or password is never given as an argument: it would stay in the shell's history.",
          "Leave it out: `factory ui mail set` asks for it, or pipe it in (for example `pass mail/key | factory ui mail set ...`).");
      }
      fail("ui_mail_usage", `factory ui mail set doesn't take ${name}.`, "See `factory ui mail --help`.");
    }
    const v = inline ?? argv[++i];
    if (v === undefined) fail("ui_mail_usage", `${name} needs a value.`, "See `factory ui mail --help`.");
    out[name.slice(2)] = v;
  }
  return out;
}

/** The secret: asked for without echo on a terminal, else the first line of stdin. */
async function secret(label: string): Promise<string> {
  if (!process.stdin.isTTY) return ((await Bun.stdin.text()).split(/\r?\n/)[0] ?? "").trim();
  process.stderr.write(`${label} (not shown): `);
  return await new Promise<string>((done) => {
    let text = "";
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (d: Buffer): void => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          return done(text.trim());
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function set(argv: string[]): Promise<number> {
  const kind = argv[0];
  let m: MailSettings;
  if (kind === "http") {
    const f = flags(argv.slice(1), ["--preset", "--url", "--header", "--body", "--from"]);
    const preset = f.preset ?? "";
    if (preset && !PRESETS[preset]) fail("ui_mail_preset", `There is no preset ${preset}.`, `Use one of ${Object.keys(PRESETS).join(", ")}, or --url, --header and --body.`);
    const base = preset ? PRESETS[preset] : undefined;
    m = { kind: "http", preset, url: f.url ?? base?.url ?? "", header: f.header ?? base?.header ?? "", body: f.body ?? base?.body ?? "", from: f.from ?? "", secret: "" };
    if (!m.url || !m.header || !m.body) fail("ui_mail_usage", "An HTTP mail API needs --preset, or --url, --header and --body.", "See `factory ui mail --help`.");
    const bad = httpProblem(m);
    if (bad) fail("ui_mail_bad", `Those mail API settings can't be used: ${bad}.`, "Fix it and run `factory ui mail set http ...` again; nothing was saved.");
    m.secret = await secret("API key");
    if (!m.secret) fail("ui_mail_secret_missing", "No API key was given; nothing was saved.", "Run it again and type the key, or pipe it in.");
  } else if (kind === "smtp") {
    const f = flags(argv.slice(1), ["--host", "--port", "--security", "--user", "--auth", "--ca-file", "--from"]);
    const security = (f.security ?? "starttls") as SmtpSettings["security"];
    const port = f.port === undefined ? (security === "tls" ? 465 : 587) : /^\d+$/.test(f.port) ? Number(f.port) : Number.NaN;
    m = { kind: "smtp", host: f.host ?? "", port, security, user: f.user ?? "", auth: (f.auth ?? "") as SmtpSettings["auth"],
      caFile: f["ca-file"] ?? "", from: f.from ?? "", secret: "" };
    const bad = smtpProblem(m);
    if (bad) fail("ui_mail_bad", `Those SMTP settings can't be used: ${bad}.`, "Fix it and run `factory ui mail set smtp ...` again; nothing was saved.");
    if (m.caFile && !existsSync(m.caFile)) fail("ui_mail_bad", `The CA file ${m.caFile} isn't there.`, "Give the path of a PEM file; nothing was saved.");
    if (m.user) {
      m.secret = await secret(`Password for ${m.user}`);
      if (!m.secret) fail("ui_mail_secret_missing", "No password was given; nothing was saved.", "Run it again and type the password, or pipe it in.");
    }
  } else {
    fail("ui_mail_usage", "factory ui mail set takes http or smtp.", "See `factory ui mail --help`.");
  }
  writePrivate(mailFile(), JSON.stringify(m, null, 1) + "\n");
  console.log(`Saved: sign-in codes go through ${describe(m)}, from ${m.from}. Kept in ${mailFile()} (mode 600, this machine only).`);
  console.log("Next: `factory ui mail test <your address>`, then add it with `factory settings --local set ui.signIn.allowed '[\"<your address>\"]'`.");
  return 0;
}

function show(): number {
  const m = readSettings();
  if (m === null) {
    console.log("No mail sender is set up on this machine: the web UI's sign-in is by token only.");
    console.log("Set one with `factory ui mail set http --preset resend --from ...` or `factory ui mail set smtp --host ... --from ...`.");
    return 0;
  }
  if (typeof m === "string") fail("ui_mail_bad", `The mail settings in ${mailFile()} can't be used: ${m}.`, "Set them again with `factory ui mail set`.");
  const rows: [string, string][] = m.kind === "http"
    ? [["kind", "http"], ["preset", m.preset || "(none)"], ["url", m.url], ["header", m.header], ["body", m.body], ["from", m.from]]
    : [["kind", "smtp"], ["host", m.host], ["port", String(m.port)], ["security", m.security], ["user", m.user || "(none)"],
      ["auth", m.auth || "(as offered)"], ["caFile", m.caFile || "(system)"], ["from", m.from]];
  rows.push([m.kind === "http" ? "key" : "password", m.secret ? "set (not shown)" : "not set"]);
  for (const [k, v] of rows) console.log(`${k.padEnd(9)} ${v}`);
  console.log(`(${mailFile()}, mode ${(statSync(mailFile()).mode & 0o777).toString(8)})`);
  return 0;
}

async function test(argv: string[]): Promise<number> {
  const to = (argv[0] ?? "").trim();
  if (!to || argv.length > 1 || !/^[^\s<>@]+@[^\s<>@]+$/.test(to)) fail("ui_mail_usage", "factory ui mail test takes one email address.", "factory ui mail test me@example.com");
  const m = readSettings();
  if (m === null) fail("ui_mail_unset", "No mail sender is set up on this machine.", "Set one with `factory ui mail set` (see `factory ui mail --help`).");
  if (typeof m === "string") fail("ui_mail_bad", `The mail settings in ${mailFile()} can't be used: ${m}.`, "Set them again with `factory ui mail set`.");
  try {
    await notifierOf(m).send(to, "Factory: test mail", `This is a test from \`factory ui mail test\` on ${hostname()}.\n\n` +
      "Mail works: the web UI's sign-in codes will come the same way.\n");
  } catch (e) {
    if (e instanceof CoreError) fail(e.code, e.message, e.fix);
    throw e;
  }
  console.log(`Sent a test mail to ${to} through ${describe(m)}.`);
  return 0;
}

export async function mailCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || rest.includes("--help") || rest.includes("-h")) {
    console.log(MAIL_USAGE);
    return cmd ? 0 : 2;
  }
  if (cmd === "set") return set(rest);
  if (cmd === "show") return show();
  if (cmd === "test") return test(rest);
  fail("ui_mail_usage", `factory ui mail has no ${cmd}.`, "Use set, show or test (see `factory ui mail --help`).");
}

/** For `factory doctor`: the mail settings' check, as [level, what, how]; null when none are set. */
export function doctorLine(): ["ok" | "fix", string, string] | null {
  const m = readSettings();
  if (m === null) return null;
  const mode = statSync(mailFile()).mode & 0o777;
  if (mode & 0o077) return ["fix", "web UI mail settings", `${mailFile()} is mode ${mode.toString(8)}, readable by others: run \`chmod 600 ${mailFile()}\``];
  if (typeof m === "string") return ["fix", "web UI mail settings", `${m}: set them again with \`factory ui mail set\``];
  return ["ok", `web UI mail: ${describe(m)}, from ${m.from}`, ""];
}
