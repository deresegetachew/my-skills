// A join code (#445, #504): what `factory machine add` prints on the hub and `factory machine join` redeems on the new
// machine. FM1- then base64url JSON: the board's URL for the machine's own login (password included), the machine's name,
// its agents and when the code expires. Here only the code itself, with no import of the message board, so the web UI's
// Join (#457, factory_ui_setup.ts) reads it in a project whose hooks don't carry the board.

export const PREFIX = "FM1-";
export const VERSION = 2; // 1 carried NATS keys (#445); 2 carries a board login (#504)
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A board login's name: the message board's LOGIN_NAME (message-board/src/logins.ts); tests/machine_join.test.ts checks they agree. */
export const LOGIN_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const ROLES = ["builder", "manager", "po", "owner"] as const;
export type Role = (typeof ROLES)[number];
const ROLE_ALIASES: Record<string, Role> = { "coding-agent": "builder", "dev-manager": "manager", "product-owner": "po" };

export interface AgentName { name: string; role: Role }
export interface Payload {
  v: typeof VERSION;
  id: string;
  name: string;
  exp: number;
  url: string; // the board for this machine's login, password included
  agents: AgentName[];
}

export function roleOf(text: string): Role | null {
  if ((ROLES as readonly string[]).includes(text)) return text as Role;
  return ROLE_ALIASES[text] ?? null;
}

export function encodeCode(p: Payload): string {
  return PREFIX + Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function boardUrlOk(text: unknown): boolean {
  try {
    const u = new URL(String(text));
    return (u.protocol === "postgres:" || u.protocol === "postgresql:") && Boolean(u.hostname && u.username && u.password);
  } catch {
    return false;
  }
}

/** The code's content, or null for anything that isn't one (a code from before #504 included). Prints nothing. */
export function parseCode(text: string): Payload | null {
  const t = text.trim();
  if (!t.startsWith(PREFIX)) return null;
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(t.slice(PREFIX.length), "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  const ok = p && p.v === VERSION && typeof p.id === "string" && LOGIN_NAME.test(String(p.name)) && typeof p.exp === "number" &&
    boardUrlOk(p.url) && Array.isArray(p.agents) && p.agents.length > 0 &&
    p.agents.every((a) => AGENT_NAME.test(String(a.name)) && roleOf(String(a.role)));
  return ok ? p : null;
}
