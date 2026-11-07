// The web app's rules that aren't drawing (#421, #422): the search across channels, the words and tone of an agent's
// state, and a channel's address in the page's hash. No React here, so tests/web_ui_model.test.ts runs it as it is.

export interface ChannelView {
  id: string;
  kind: "agent" | "view";
  name: string;
  title: string;
  role?: string;
  /** The owner's image for the agent (#437), as the server read it. */
  avatar?: string;
}

export interface ProjectView {
  id: string;
  name: string;
  channels: ChannelView[];
}

export interface Hit {
  project: string;
  projectName: string;
  channel: ChannelView;
}

export type Tone = "good" | "warn" | "bad" | "quiet";

export interface LimitView {
  reset: number;
  message: string;
}

/** Each channel whose words hold every word of `query` (any case): its project, name, title, role, and the live words
 * `live[project][name]` (an agent's state). An empty query finds nothing. */
export function searchChannels(projects: ProjectView[], query: string, live: Record<string, Record<string, string>> = {}): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: Hit[] = [];
  for (const p of projects) {
    for (const c of p.channels) {
      const role = c.role ?? "";
      const text = [p.id, p.name, c.name, c.title, role, role.replace(/-/g, " "), live[p.id]?.[c.name] ?? ""].join(" ").toLowerCase();
      if (words.every((w) => text.includes(w))) hits.push({ project: p.id, projectName: p.name, channel: c });
    }
  }
  return hits;
}

/** "14:30" for a time in seconds since 1970, in UTC. */
export function hhmm(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(11, 16);
}

/** An agent's state as words and a tone. While GitHub's limit is used up, an agent at work waits on it. */
export function agentState(agent: { state: string; detail: string } | undefined, limit: LimitView | null): { text: string; tone: Tone } {
  if (!agent) return { text: "not reported", tone: "quiet" };
  const text = agent.detail || agent.state;
  if (limit && (agent.state === "working" || agent.state === "waiting")) {
    return { text: `waiting on the GitHub limit (back at ${hhmm(limit.reset)} UTC)`, tone: "warn" };
  }
  if (agent.state === "working") return { text, tone: "good" };
  if (agent.state === "waiting") return { text, tone: "warn" };
  if (agent.state === "down") return { text, tone: "bad" };
  return { text, tone: "quiet" };
}

/** The hash that opens `channel` of `project`. */
export function channelHash(project: string, channel: string): string {
  return `#/${encodeURIComponent(project)}/${channel}`;
}

/** A task opened on the Board page has its own address (#543): `view:tasks/task:b3`, so it can be shared and Back
 *  closes it. The channel with the task left off, and the task (null with none). */
export function splitTask(channel: string): { channel: string; task: string | null } {
  const m = /^(.+)\/task:([A-Za-z0-9._-]{1,40})$/.exec(channel);
  return m ? { channel: m[1] as string, task: m[2] as string } : { channel, task: null };
}

/** The channel that opens task `id` on `channel` (view:tasks). */
export function taskChannel(channel: string, id: string): string {
  return `${channel}/task:${id}`;
}

/** The project to show (#545): the one the address names, else the one last opened on this browser, else the first
 *  listed. So a page opened with no address lands where you were, not on the serving project by default. */
export function pickProject<P extends { id: string }>(projects: P[], named: string | null | undefined, last: string | null | undefined): P | undefined {
  return projects.find((p) => p.id === named) ?? projects.find((p) => p.id === last) ?? projects[0];
}

/** The project and channel a hash names, or null. */
export function parseHash(hash: string): { project: string; channel: string } | null {
  const m = /^#\/([^/]+)\/(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return { project: decodeURIComponent(m[1] as string), channel: decodeURIComponent(m[2] as string) };
  } catch {
    return null;
  }
}

/** "3 min ago", "2 h ago", "just now" for an ISO time; "" when there is none. */
export function ago(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(Math.round((nowMs - t) / 1000), 0);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export const ROLE_TITLE: Record<string, string> = {
  "coding-agent": "Coding agent",
  "dev-manager": "Dev manager",
  "product-owner": "Product owner",
};
