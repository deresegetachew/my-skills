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
  /** Shown in place of the fix button while the page checks that its fix took (#589), such as "Checking…". */
  waiting?: string;
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
  /** A dev manager's sub-manager (#585): its dev manager, its item, and whether its session can be reached to end it. */
  sub?: { parent: string; item: string; stoppable: boolean } | null;
  /** A coding agent's start on a machine with a limit (#581): the limit and the coding agents running here now. */
  atOnce?: { max: number; running: string[] } | null;
}

/** "menelik", "menelik and taytu", "menelik, taytu and haile". */
export function andList(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/** Stopping an agent: it must be running, on this machine. Its session ends; its task, branch and pull request stay.
 * A sub-manager's session must also be one this machine can reach; when it can't, the confirm says so and stays off. */
export function stopAgentAsk(a: AgentFacts): ConfirmSpec {
  const running = a.state !== "down";
  const where = a.machineName ?? "this machine";
  const sub = a.sub ?? null;
  if (sub) {
    return {
      title: `Stop ${a.name}?`,
      checks: [
        { title: `${a.name} is running`, met: running, ...(running ? {} : { sub: "There is nothing to stop." }) },
        { title: `${a.name} runs on this machine`, met: a.here,
          ...(a.here ? {} : { sub: `It runs on ${a.machineName ?? "another machine"}: stop it from a page served there.` }) },
        { title: `Its session can be reached`, met: sub.stoppable,
          ...(sub.stoppable ? {} : { sub: `Its Claude session can't be found (an older release started it). Stop ${sub.parent} ` +
            "instead, or wait for manager.subManagerMinutes to end it." }) },
      ],
      happens: `${sub.parent}'s sub-manager on ${sub.item} ends, mid-step if it is working. ${sub.parent} goes on with its pass.`,
      doesNot: `${sub.parent} keeps running, and ${sub.item} comes back at a later pass. Nothing on GitHub or the board changes.`,
      action: `Stop ${a.name}`,
      tone: "danger",
    };
  }
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
  const cap = a.atOnce ?? null;
  const room = !cap || cap.running.filter((n) => n !== a.name).length < cap.max;
  const capCheck = cap ? [{ title: `This machine runs fewer than ${cap.max} coding agent${cap.max === 1 ? "" : "s"} now`, met: room,
    ...(room ? {} : { sub: `${andList(cap.running)} ${cap.running.length === 1 ? "runs" : "run"} here. Stop one first, or raise the limit on the Team page.` }) }] : [];
  return {
    title: `Start ${a.name}?`,
    checks: [{ title: `${a.name} isn't running yet`, met: down,
      ...(down ? {} : { sub: `It is already running on ${a.machineName ?? "a machine"}.` }) }, ...capCheck],
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
