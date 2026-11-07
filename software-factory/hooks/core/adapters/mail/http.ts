// The Notifications port's HTTP mail API adapter (#542): one POST through fetch, built from a URL, one header and a JSON
// body template. Presets fill those for Resend and Postmark; any other service takes the generic form.
//
// In the header and the URL, {{secret}} is the API key. In the body, {{from}}, {{to}}, {{subject}} and {{text}} are
// replaced by JSON strings (quotes included), so a value can't break out of the template. The URL must be https, except
// on this machine (127.0.0.1, localhost or [::1]). The key never shows in an error: the service's answer is cut short
// and the key taken out of it.
import { CoreError } from "../../domain/error.ts";
import type { Notifier } from "../../ports/notifications.ts";

export interface HttpMail {
  url: string;
  /** `Name: value`, for example `Authorization: Bearer {{secret}}`. */
  header: string;
  /** A JSON template with {{from}}, {{to}}, {{subject}} and {{text}}. */
  body: string;
  from: string;
  secret: string;
}

export const PRESETS: Record<string, Pick<HttpMail, "url" | "header" | "body">> = {
  resend: {
    url: "https://api.resend.com/emails",
    header: "Authorization: Bearer {{secret}}",
    body: '{"from": {{from}}, "to": [{{to}}], "subject": {{subject}}, "text": {{text}}}',
  },
  postmark: {
    url: "https://api.postmarkapp.com/email",
    header: "X-Postmark-Server-Token: {{secret}}",
    body: '{"From": {{from}}, "To": {{to}}, "Subject": {{subject}}, "TextBody": {{text}}, "MessageStream": "outbound"}',
  },
};

const FIX = "Check the mail settings with `factory ui mail show`, set them again with `factory ui mail set`, then `factory ui mail test <address>`.";

/** The template with each {{name}} replaced by its value as a JSON string. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(from|to|subject|text)\}\}/g, (_, k: string) => JSON.stringify(values[k] ?? ""));
}

/** Null when the settings can be used, else what is wrong (said without the key). */
export function problemOf(m: Pick<HttpMail, "url" | "header" | "body" | "from">): string | null {
  let u: URL;
  try {
    u = new URL(m.url);
  } catch {
    return "the URL isn't a web address";
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "the URL must start with https:// (http only on this machine)";
  const colon = m.header.indexOf(":");
  if (colon < 1 || !/^[A-Za-z0-9-]+$/.test(m.header.slice(0, colon).trim())) return "the header must be `Name: value`";
  if (!m.header.includes("{{secret}}") && !m.url.includes("{{secret}}")) return "the header (or the URL) must hold {{secret}}, where the key goes";
  try {
    JSON.parse(fill(m.body, { from: "a", to: "b", subject: "c", text: "d" }));
  } catch {
    return "the body template isn't JSON once {{from}}, {{to}}, {{subject}} and {{text}} are filled in";
  }
  if (!m.from.trim() || /[\r\n]/.test(m.from)) return "the from address is empty or has a line break";
  return null;
}

/** `text` with every copy of `secret` taken out, cut to `max` characters. */
export function scrub(text: string, secret: string, max = 200): string {
  let clean = text;
  for (const s of secret ? [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")] : []) clean = clean.split(s).join("[hidden]");
  return clean.replace(/\s+/g, " ").trim().slice(0, max);
}

export class HttpNotifier implements Notifier {
  constructor(private readonly m: HttpMail, private readonly timeoutMs = 15_000) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    const bad = problemOf(this.m);
    if (bad) throw new CoreError("mail_settings_bad", `The mail API settings can't be used: ${bad}.`, FIX);
    const colon = this.m.header.indexOf(":");
    const name = this.m.header.slice(0, colon).trim();
    const value = this.m.header.slice(colon + 1).trim().split("{{secret}}").join(this.m.secret);
    const url = this.m.url.split("{{secret}}").join(encodeURIComponent(this.m.secret));
    let r: Response;
    try {
      r = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json", [name]: value },
        body: fill(this.m.body, { from: this.m.from, to, subject, text }) });
    } catch (e) {
      const why = scrub(e instanceof Error ? e.message : String(e), this.m.secret);
      throw new CoreError("mail_api_unreachable", `The mail API at ${new URL(this.m.url).host} can't be reached (${why}).`,
        "Check this machine's network, then `factory ui mail test <address>`.");
    }
    if (r.ok) {
      await r.body?.cancel();
      return;
    }
    const answer = scrub(await r.text().catch(() => ""), this.m.secret);
    throw new CoreError("mail_api_refused", `The mail API answered ${r.status}${answer ? `: ${answer}` : ""}.`, FIX);
  }
}
