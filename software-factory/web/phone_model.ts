// The app on a phone (#458), from the owner's design (docs/design/web-ui/PhoneHome.dc.html, PhoneInbox.dc.html): the tab
// bar at the bottom (Home, Inbox, Board, Team), the Inbox's count, the pull requests only the owner may merge as cards
// in the Inbox, and Home's one card for what needs the owner. No React here, so tests/web_ui_phone_model.test.ts runs it.
import type { QueueView } from "./chat_model.ts";
import { channelOf } from "./nav_model.ts";
import type { NeedRow } from "./ops_model.ts";
import type { PullRow } from "./views_model.ts";

export interface PhoneTab {
  id: "home" | "inbox" | "board" | "team";
  label: string;
  /** The address it opens, the same as the sidebar's. */
  channel: string;
  on: boolean;
  /** Only the Inbox has one: how many things need the owner. */
  badge: number | null;
}

const TABS: Array<{ id: PhoneTab["id"]; label: string }> = [
  { id: "home", label: "Home" },
  { id: "inbox", label: "Inbox" },
  { id: "board", label: "Board" },
  { id: "team", label: "Team" },
];

/** The tab bar for the page shown: an agent's page is part of Team; any other page selects none. */
export function phoneTabs(o: { page: string; team?: string[]; inbox?: number }): PhoneTab[] {
  const page = (o.team ?? []).includes(o.page) ? "team" : o.page;
  const n = o.inbox ?? 0;
  return TABS.map((t) => ({ id: t.id, label: t.label, channel: channelOf(t.id), on: t.id === page, badge: t.id === "inbox" && n > 0 ? n : null }));
}

export interface MergeCard {
  number: number;
  title: string;
  /** Its checks and review in plain words: "Checks passed · approved". */
  sub: string;
  /** What it is and why only the owner merges it. */
  why: string;
  /** The pull request's page, which asks first with the preconditions. */
  channel: string;
  find: string;
}

const CHECKS: Record<string, string> = { green: "Checks passed", red: "Checks failing", running: "Checks running", pending: "Checks running" };
const HEAD_RULE = "It merges only while its head is still the one you saw.";

function isOwnerMerge(p: PullRow): boolean {
  return p.next.action === "owner-merges";
}

/** The pull requests only the owner may merge, as the Inbox's cards. */
export function ownerMerges(pulls: PullRow[]): MergeCard[] {
  return pulls.filter(isOwnerMerge).map((p) => ({
    number: p.number,
    title: `Merge PR #${p.number}`,
    sub: [CHECKS[p.checks.state] ?? "No checks yet", p.review.text].filter(Boolean).join(" · "),
    why: `${p.title}. ${p.protected === true ? "It changes protected files, so only you can merge it." : "Only you can merge it."} ${HEAD_RULE}`,
    channel: `pr:${p.number}`,
    find: "merge",
  }));
}

/** The Inbox's count: the asks nobody has answered, and the pull requests only the owner may merge. */
export function inboxCount(queue: QueueView | null, pulls: PullRow[]): number {
  const asks = queue && !queue.problem ? queue.asks.filter((a) => a.state === "open").length : 0;
  return asks + pulls.filter(isOwnerMerge).length;
}

/** Home's needs that the Inbox answers (an ask, a merge); the rest (blocked, CI, health) stay on Home. */
export function inInbox(kind: string): boolean {
  return kind === "ask" || kind === "merge";
}

/** Home's one card on a phone: "2 need you", "Merge PR #402 · answer 1 ask"; null when nothing does. */
export function needsCard(needs: NeedRow[]): { title: string; line: string } | null {
  const merges = needs.filter((n) => n.kind === "merge");
  const asks = needs.filter((n) => n.kind === "ask").length;
  const all = merges.length + asks;
  if (!all) return null;
  const parts = merges.map((n) => n.title.split("?")[0]?.trim() ?? n.title);
  if (asks) parts.push(`answer ${asks} ask${asks === 1 ? "" : "s"}`);
  return { title: `${all} ${all === 1 ? "needs" : "need"} you`, line: parts.join(" · ") };
}
