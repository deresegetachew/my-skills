// The Notifications port (#542, the plugins decision #538): how the factory tells a person something outside the web
// UI. Mail is its first adapter, in two kinds (adapters/mail/http.ts, an HTTP mail API through fetch; adapters/mail/smtp.ts,
// SMTP over node:tls). Slack and others can come later behind the same call. A failure is a CoreError {code, message,
// fix} whose text never carries a secret.

export interface Notifier {
  /** Sends `text` with `subject` to `to` (one address). Resolves once the service took it; rejects with a CoreError. */
  send(to: string, subject: string, text: string): Promise<void>;
}
