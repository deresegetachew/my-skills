// The shared parts' rules (#450) that aren't drawing: the confirm-with-preconditions dialog (a checklist that keeps the
// button off until each is met, what happens and what doesn't, the name typed for serious ones), what stopping and
// starting an agent ask, and the "Talk about this" box's words and thread. No command is shown on screen (the owner's
// rule), so none is written here. No React here, so tests/web_ui_parts.test.ts runs it as it is.
import type { ChatItemView } from "./chat_model.ts";

export interface Check {
  title: string;
  met: boolean;
  /** A line under the title: why it isn't met, or what it means. */
  sub?: string;
  /** The label of the button that meets it, when the page has one. */
  fix?: string;
}

export interface ConfirmSpec {
  title: string;
  checks: Check[];
  /** What will happen, in plain words. */
  happens: string;
  /** What will not happen. */
  doesNot: string;
  /** The button's words ("Stop haile"). */
  action: string;
  tone: "primary" | "danger";
  /** For serious ones: the name to type before the button turns on. */
  typeName?: string;
}

/** Whether the button is on: every check met and, for a serious one, its name typed exactly (spaces around aside). */
export function confirmState(spec: ConfirmSpec, typed: string): { ready: boolean; unmet: Check[]; nameOk: boolean } {
  const unmet = spec.checks.filter((c) => !c.met);
  const nameOk = spec.typeName === undefined || typed.trim() === spec.typeName;
  return { ready: unmet.length === 0 && nameOk, unmet, nameOk };
}

export interface AgentFacts {
  name: string;
  /** It runs on the machine that serves the page. */
  here: boolean;
  state: string;
  machineName: string | null;
  task: string | null;
}

/** Stopping an agent: it must be running, on this machine. Its session ends; its task, branch and pull request stay. */
export function stopAgentAsk(a: AgentFacts): ConfirmSpec {
  const running = a.state !== "down";
  const where = a.machineName ?? "this machine";
  return {
    title: `Stop ${a.name}?`,
    checks: [
      { title: `${a.name} is running`, met: running, ...(running ? {} : { sub: "There is nothing to stop." }) },
      { title: `${a.name} runs on this machine`, met: a.here,
        ...(a.here ? {} : { sub: `It runs on ${a.machineName ?? "another machine"}: stop it from a page served there.` }) },
    ],
    happens: `${a.name}'s session on ${a.here ? where : "this machine"} ends, mid-step if it is working.`,
    doesNot: `${a.task ? `Task #${a.task} stays claimed for ${a.name}, so starting it again goes on where it was. ` : ""}`
      + "Its branch, its pull requests and its messages are kept, and nothing on GitHub changes.",
    action: `Stop ${a.name}`,
    tone: "danger",
  };
}

/** Starting an agent: only one that isn't running already. It starts on this machine and takes up its work. */
export function startAgentAsk(a: AgentFacts): ConfirmSpec {
  const down = a.state === "down";
  return {
    title: `Start ${a.name}?`,
    checks: [{ title: `${a.name} isn't running yet`, met: down,
      ...(down ? {} : { sub: `It is already running on ${a.machineName ?? "a machine"}.` }) }],
    happens: `${a.name} starts on this machine and picks up its task, or the next one.`,
    doesNot: "Nothing else is started or stopped, and nothing on GitHub changes until it works.",
    action: `Start ${a.name}`,
    tone: "primary",
  };
}

// --- Talk about this ----------------------------------------------------------------------------------------------------

/** What a box is about: an epic, a task, a pull request, a decision or a sign-off item. */
export interface TalkItem {
  kind: string;
  id: string;
  title: string;
}

const KIND_WORD: Record<string, string> = { epic: "epic #", task: "task #", pr: "PR #", decision: "decision ", signoff: "sign-off #" };

function tag(item: { kind: string; id: string }): string {
  return `About ${KIND_WORD[item.kind] ?? `${item.kind} #`}${item.id} (`;
}

/** The line the box sends: the owner's words, led by the item they are about, so the answerer knows. */
export function talkText(item: TalkItem, text: string): string {
  return `${tag(item)}${item.title.replace(/\s+/g, " ").trim()}): ${text.trim()}`;
}

/** The item's thread out of a chat: the owner's lines about it, and the answers after each, up to the owner's next line
 * about something else. */
export function itemThread(items: ChatItemView[], item: { kind: string; id: string; title?: string }): ChatItemView[] {
  const out: ChatItemView[] = [];
  let inside = false;
  for (const x of items) {
    if (x.kind === "owner") inside = x.text.startsWith(tag(item));
    if (inside) out.push(x);
  }
  return out;
}

const TALK_ROLES: Record<string, string> = { "product-owner": "product owner", "dev-manager": "dev manager" };

/** Whom the box can talk to: the product owner first, then the dev manager. */
export function talkTargets(agents: Array<{ name: string; role?: string }>): Array<{ name: string; role: string; words: string }> {
  return Object.keys(TALK_ROLES).flatMap((role) => agents.filter((a) => a.role === role)
    .map((a) => ({ name: a.name, role, words: TALK_ROLES[role] as string })));
}
