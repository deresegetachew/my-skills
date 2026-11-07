// The sidebar's rules (#450), from the owner's design (docs/design/web-ui/Sidebar.dc.html): the pages in their order,
// Your team, Run the factory, and Factory settings with its tabs; which item is selected for an address, and the address
// each item opens. The views built before this page (tasks, epics, pull requests, CI, the owner queue, machines) keep
// their addresses; a page not built yet is `page:<id>`. No React here, so tests/web_ui_nav.test.ts runs it as it is.
import { agentState, type LimitView } from "./model.ts";

export interface NavItem {
  page: string;
  label: string;
  /** The address it opens (the hash's channel). */
  channel: string;
  on: boolean;
  /** A count: red for what needs the owner (the Inbox, and Home's Needs attention, #579), blue for the rest. */
  badge: { count: number; tone: "red" | "blue" } | null;
}

export type StateDot = "working" | "waiting" | "idle" | "down";

export interface TeamRow {
  name: string;
  /** The role in a word, shown in grey: Product, Manager, Builder. */
  role: string;
  roleId: string;
  dot: StateDot;
  /** "haile: working on #437", for a tooltip and a screen reader. */
  title: string;
  channel: string;
  on: boolean;
  /** Why it needs attention (#579), shown as a small "stuck" mark; null when nothing does. */
  stuck: string | null;
}

export interface TeamInput {
  name: string;
  role?: string;
  state?: string;
  detail?: string;
  /** Why it needs attention (#579), when it does. */
  stuck?: string | null;
}

export interface Sidebar {
  main: NavItem[];
  team: TeamRow[];
  ops: NavItem[];
}

/** Each page: its label in the sidebar, its address, and its header (title and one-line purpose). */
const PAGES: Record<string, { label: string; channel: string; title: string; purpose: string }> = {
  home: { label: "Home", channel: "page:home", title: "Home", purpose: "What the team is doing now, and what needs you." },
  inbox: { label: "Inbox", channel: "view:owner-queue", title: "Inbox", purpose: "What the agents asked you, and the answers to what you asked them." },
  board: { label: "Board", channel: "view:tasks", title: "Board", purpose: "Every task, in the order the builders take them." },
  epics: { label: "Epics", channel: "view:epics", title: "Epics", purpose: "The bigger pieces of work, each with its stage and its tasks." },
  prs: { label: "Pull requests", channel: "view:pull-requests", title: "Pull requests", purpose: "What the builders opened, its checks and its review." },
  docs: { label: "PRD and decisions", channel: "page:docs", title: "PRD and decisions", purpose: "What the product is for, and the decisions taken on the way." },
  artifacts: { label: "Designs and artifacts", channel: "page:artifacts", title: "Designs and artifacts",
    purpose: "The designs builders work from, kept as reviewed copies in the repo." },
  signoff: { label: "Sign-off and testing", channel: "page:signoff", title: "Sign-off and testing", purpose: "What was built and waits for you to try it." },
  activity: { label: "Activity", channel: "page:activity", title: "Activity", purpose: "Everything that happened, newest first." },
  ci: { label: "CI and runners", channel: "view:ci", title: "CI and runners", purpose: "Whether the checks pass, and the machines that run them." },
  machines: { label: "Machines", channel: "view:machines", title: "Machines", purpose: "The computers the agents run on, and who runs where." },
  health: { label: "Health", channel: "page:health", title: "Health", purpose: "Whether every part works, with a fix for what doesn't." },
  usage: { label: "Usage and cost", channel: "page:usage", title: "Usage and cost", purpose: "What each agent and task used, against its budget." },
  settings: { label: "Factory settings", channel: "page:settings", title: "Factory settings", purpose: "How this project and this machine are set up to run." },
  integrations: { label: "Integrations", channel: "page:integrations", title: "Factory settings", purpose: "The services the agents use, and whether each one works." },
  releases: { label: "Releases and updates", channel: "page:releases", title: "Factory settings", purpose: "The version this project runs, and the newer ones." },
  maintenance: { label: "Maintenance", channel: "page:maintenance", title: "Factory settings", purpose: "Clean-ups and repairs, each with what it will and won't touch." },
};

const MAIN = ["home", "inbox", "board", "epics", "prs", "docs", "signoff", "activity"];
const OPS = ["ci", "machines", "health", "usage", "settings"];
const SETTINGS = ["settings", "integrations", "releases", "maintenance"];

/** Factory settings' tabs, Settings first. */
export const SETTINGS_TABS: Array<{ page: string; label: string }> = SETTINGS.map((page) => ({ page, label: page === "settings" ? "Settings" : PAGES[page]?.label ?? page }));

/** The address a page opens. */
export function channelOf(page: string): string {
  return PAGES[page]?.channel ?? `page:${page}`;
}

/** The page an address shows: a doc page is PRD and decisions, an agent its team row (its name), anything unknown Home. */
export function pageOf(channel: string): string {
  if (channel.startsWith("agent:")) return channel.slice("agent:".length);
  if (channel.startsWith("doc:")) return "docs";
  if (channel.startsWith("signoff:")) return "signoff"; // an item's page (#454)
  if (channel.startsWith("pr:")) return "prs"; // a pull request's page (#453)
  for (const [page, p] of Object.entries(PAGES)) if (p.channel === channel) return page;
  return "home";
}

/** A page's header: its title and its one-line purpose. */
export function pageHead(page: string): { title: string; purpose: string } {
  const p = PAGES[page] ?? PAGES.home;
  return { title: p?.title ?? "", purpose: p?.purpose ?? "" };
}

const ROLE_WORD: Record<string, string> = { "product-owner": "Product", "dev-manager": "Manager", "coding-agent": "Builder" };
const ROLE_ORDER = ["product-owner", "dev-manager", "coding-agent"];
const DOT: Record<string, StateDot> = { good: "working", warn: "waiting", bad: "down", quiet: "idle" };

function rank(role: string): number {
  const i = ROLE_ORDER.indexOf(role);
  return i < 0 ? ROLE_ORDER.length : i;
}

function item(page: string, active: string, counts: Record<string, number>): NavItem {
  const p = PAGES[page];
  const on = page === "settings" ? SETTINGS.includes(active) : page === "docs" ? active === "docs" || active === "artifacts" : page === active;
  const n = counts[page] ?? 0;
  return { page, label: p?.label ?? page, channel: channelOf(page), on, badge: n > 0 ? { count: n, tone: page === "inbox" || page === "home" ? "red" : "blue" } : null };
}

/** The sidebar for the page shown, the project's agents (with their live state when known) and the counts known. */
export function sidebar(o: { page: string; team: TeamInput[]; counts?: Record<string, number>; limit?: LimitView | null }): Sidebar {
  const counts = o.counts ?? {};
  const team = [...o.team].sort((a, b) => rank(a.role ?? "") - rank(b.role ?? "") || a.name.localeCompare(b.name)).map((a): TeamRow => {
    const st = agentState(a.state === undefined ? undefined : { state: a.state, detail: a.detail ?? "" }, o.limit ?? null);
    const role = a.role ?? "coding-agent";
    const stuck = a.stuck || null;
    return { name: a.name, role: ROLE_WORD[role] ?? "Builder", roleId: role, dot: DOT[st.tone] ?? "idle",
      title: `${a.name}: ${st.text}${stuck ? `. Stuck: ${stuck}` : ""}`, channel: `agent:${a.name}`, on: o.page === a.name, stuck };
  });
  return { main: MAIN.map((p) => item(p, o.page, counts)), team, ops: OPS.map((p) => item(p, o.page, counts)) };
}

/** The address to show for one typed or linked: `page:<id>` of a page that is a view (`page:board`) opens that view
 *  (`view:tasks`), so a page's name always reaches it; any other address is kept as it is. */
export function addressOf(channel: string): string {
  if (!channel.startsWith("page:")) return channel;
  const page = channel.slice("page:".length);
  return PAGES[page] ? channelOf(page) : channel;
}
