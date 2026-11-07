// Signing in to the web UI (#542): the page holds either the token (as before) or SESSION, which means "this browser's
// session cookie" (made by a code sent by email). With SESSION no Authorization header and no ?token= is sent: the
// browser sends the cookie itself, to /api only.

/** The value the page holds when it is signed in with a session cookie; no token looks like it (they are base64url). */
export const SESSION = "(session)";

/** What GET /api/auth says. */
export interface AuthInfo {
  signedIn: boolean;
  email?: string;
  /** Codes can be mailed from this machine (a mail sender is set up and someone is allowed). */
  mail: boolean;
  codeMinutes: number;
}

/** The headers that carry `token` (none for a session: the cookie goes by itself). */
export function authHeaders(token: string): Record<string, string> {
  return token && token !== SESSION ? { authorization: `Bearer ${token}` } : {};
}

/** The WebSocket's address for `token`. */
export function wsAddress(proto: string, host: string, token: string): string {
  return token === SESSION ? `${proto}://${host}/api/ws` : `${proto}://${host}/api/ws?token=${encodeURIComponent(token)}`;
}

/** The sign-in page's first words: with mail, the code; without, how to use the token. */
export function gateLead(info: AuthInfo | null, wrong: boolean): string {
  if (wrong) return "That sign-in isn't valid any more (the token is wrong, or the session ended or was revoked).";
  if (info?.mail) return `Type your email address: if it is allowed here, a 6-digit code comes by mail. It works once, for ${info.codeMinutes} minutes.`;
  return "Sign in with the token the server printed when it started: open the address it printed (it ends in ?token=…), or paste " +
    "the token kept in .git/factory/ui-token. Signing in with a code by email works once mail is set up on that machine and " +
    "your address is allowed there.";
}
