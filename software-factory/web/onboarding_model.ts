// The first-launch screens' rules (#457), from the owner's design (docs/design/web-ui/Welcome, MachineCheck and JoinHub):
// Welcome's three ways in and when it opens by itself, the Machine check's rows from the Health answer
// (GET /api/projects/:p/health, `factory doctor --json`), and what a join code connects to (POST /api/setup/join/preview).
// No React here, so tests/web_ui_onboarding_model.test.ts runs it as it is.
import type { HealthData } from "./ops_model.ts";

export interface WelcomeChoice {
  id: "start" | "join" | "open";
  title: string;
  body: string;
  cta: string;
  /** The address it opens. */
  hash: string;
  primary: boolean;
  /** The icon's path (24 viewBox, stroked). */
  icon: string;
}

export const WELCOME_CHOICES: WelcomeChoice[] = [
  { id: "start", title: "Start the factory here", primary: true, cta: "Start here", hash: "#/setup/machine",
    body: "This machine becomes the hub that the agents and your other machines talk to. We check git, GitHub, Docker and Tailscale first.",
    icon: "M4 7h16v10H4zM8 21h8M12 17v4M7 11h2M11 11h2" },
  { id: "join", title: "Join my factory", primary: false, cta: "Paste a join code", hash: "#/setup/join",
    body: "Your factory already runs on another machine. Paste the join code from Machines › Add machine on the hub.",
    icon: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" },
  { id: "open", title: "Open a project", primary: false, cta: "Choose a folder", hash: "#/add-project",
    body: "Pick a project on GitHub or a folder on this machine. Nothing changes until you press Create.",
    icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
];

export type OnboardingPage = "welcome" | "machine" | "join";

const ROUTES: Record<string, OnboardingPage> = { "#/welcome": "welcome", "#/setup/machine": "machine", "#/setup/join": "join" };

/** The onboarding page an address opens, or null. */
export function onboardingRoute(hash: string): OnboardingPage | null {
  return ROUTES[hash] ?? null;
}

/** Welcome opens by itself in a browser that has never opened a project nor left Welcome, unless the address names a page. */
export function firstLaunch(storedProject: string | null, welcomed: boolean, hash: string): boolean {
  return !storedProject && !welcomed && (hash === "" || hash === "#");
}

// --- Machine check -------------------------------------------------------------------------------------------------------

/** The Health groups that are about this machine (the project's own checks are on Health). */
const MACHINE_GROUPS: Record<string, string> = { machine: "Tools and sign-ins", board: "Where the agents talk", github: "Sign-in and limits" };

export interface MachineRow {
  name: string;
  state: "Ready" | "Needs a fix" | "Needs you" | "Worth a look";
  tone: "good" | "warn" | "bad";
  /** The fix in words (empty when ready). */
  fix: string;
  /** The one admin step to type in a terminal with sudo (RULES.md's one exception), else null. */
  admin: string | null;
}

export interface MachineCheck {
  summary: string;
  /** Nothing failed: Continue is on. */
  ready: boolean;
  groups: { id: string; title: string; note: string; rows: MachineRow[] }[];
}

function rowOf(c: { level: string; what: string; fix: string }): MachineRow {
  const lines = c.fix.split("\n");
  const sudo = lines.filter((l) => l.trim().startsWith("sudo "));
  const fix = lines.filter((l) => !l.trim().startsWith("sudo ")).join("\n").trim();
  const admin = sudo.length ? sudo.map((l) => l.trim()).join("\n") : null;
  if (c.level === "ok") return { name: c.what, state: "Ready", tone: "good", fix: "", admin: null };
  if (c.level === "warning") return { name: c.what, state: "Worth a look", tone: "warn", fix, admin };
  return admin ? { name: c.what, state: "Needs you", tone: "bad", fix, admin } : { name: c.what, state: "Needs a fix", tone: "warn", fix, admin };
}

/** The Machine check from the Health answer. */
export function machineCheck(h: HealthData | null): MachineCheck {
  if (!h || (!h.ranAt && (h.running || !h.problems.length))) return { summary: "Checking this machine…", ready: false, groups: [] };
  const groups = h.groups.filter((g) => g.id in MACHINE_GROUPS)
    .map((g) => ({ id: g.id, title: g.title, note: MACHINE_GROUPS[g.id] ?? "", rows: g.checks.map(rowOf) }));
  const rows = groups.flatMap((g) => g.rows);
  if (!h.ranAt && h.problems.length) {
    const p = h.problems[0];
    return { summary: `${p?.message ?? ""} ${p?.fix ?? ""}`.trim(), ready: false, groups };
  }
  const ready = rows.filter((r) => r.state === "Ready").length;
  return { summary: `${ready} of ${rows.length} ready. Checking changes nothing.`, ready: !rows.some((r) => r.state === "Needs a fix" || r.state === "Needs you"), groups };
}

// --- Join my factory -----------------------------------------------------------------------------------------------------

export interface JoinPreview {
  machine: string;
  hub: string;
  agents: { name: string; role: string }[];
  /** Seconds since 1970. */
  expiresAt: number;
}

/** What stops Join with the pasted text, or null. */
export function joinProblem(code: string): string | null {
  const t = code.trim();
  if (!t) return "Paste the join code from the hub's Machines › Add machine.";
  if (!t.startsWith("FM1-")) return "That isn't a join code: copy the whole code, it starts with FM1-.";
  return null;
}

const ROLE_WORDS: Record<string, string> = { builder: "Builder", manager: "Dev manager", po: "Product owner", owner: "Owner" };

/** "This code connects you to": the hub, this machine, its agents and when the code expires. */
export function joinHolds(p: JoinPreview, now = Date.now()): { label: string; value: string; sub: string }[] {
  const left = Math.round((p.expiresAt * 1000 - now) / 60_000);
  return [
    { label: "Hub", value: p.hub, sub: "The message board" },
    { label: "This machine", value: p.machine, sub: "Its own board login, kept here only" },
    { label: "Agents", value: p.agents.map((a) => a.name).join(", "), sub: p.agents.map((a) => ROLE_WORDS[a.role] ?? a.role).join(", ") },
    { label: "Expires", value: left > 0 ? `in ${left} min` : "expired", sub: "The code works once" },
  ];
}
