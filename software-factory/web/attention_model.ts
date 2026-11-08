// Needs attention (#579): what the server found stuck (GET /api/projects/:p/attention, Home's `attention`, and the
// WebSocket's {type: "attention"}), as the page shows it: the list at the top of Home, the count beside Home in the
// sidebar, and a small "stuck" mark with the reason on a card or an agent. No React here, so
// tests/web_ui_attention_model.test.ts runs it as it is. The server's rules are in hooks/factory_ui_attention.ts.

export interface AttentionAction {
  /** none: nothing to do, it ends by itself (Claude's usage limit, #614); the row has no button. choose: one answer to a
   *  question an agent asks in its picker (#644), typed into its session. */
  kind: "release" | "close" | "start" | "say" | "choose" | "open" | "none";
  label: string;
  task?: string;
  agent?: string;
  /** For say: the one line sent to the agent's session (`/next-task`). */
  text?: string;
  /** For start: save the agent's leftover changes aside first (#640). */
  stash?: boolean;
  /** For choose: the key typed into the agent's picker (the option's number). */
  key?: string;
  link?: string;
}

export interface AttentionItem {
  id: string;
  kind: string;
  title: string;
  reason: string;
  task: string | null;
  agent: string | null;
  pr: number | null;
  epic: string | null;
  action: AttentionAction;
  /** A question's options (#644): one button each. */
  options?: AttentionAction[];
}

const AGENT_KINDS = ["agent-asks", "agent-cant-start", "agent-down", "session-long", "role-down", "idle-ready"];

/** The marks for cards and agents: each task's and each agent's first reason. An agent is marked for what it is
 *  (asking a question, unable to start, down while holding work, working too long, a role that should run), a task for
 *  what is wrong with it. */
export function stuckMarks(items: AttentionItem[]): { tasks: Record<string, string>; agents: Record<string, string> } {
  const tasks: Record<string, string> = {};
  const agents: Record<string, string> = {};
  for (const i of items) {
    if ((i.kind === "task-quiet" || i.kind === "task-pr-gone" || i.kind === "task-spinning") && i.task && !(i.task in tasks)) tasks[i.task] = i.reason;
    if (i.kind === "epic-done" && i.epic && !(i.epic in tasks)) tasks[i.epic] = i.reason;
    if (AGENT_KINDS.includes(i.kind) && i.agent && !(i.agent in agents)) agents[i.agent] = i.kind === "agent-asks" ? i.title : i.reason;
  }
  return { tasks, agents };
}

/** The dot of an item: red for what is down or only a person can fix, yellow for what is slow. */
export function attentionDot(i: AttentionItem): "red" | "waiting" {
  return ["board-down", "runners-down", "agent-asks", "agent-cant-start", "agent-down", "role-down", "task-pr-gone"].includes(i.kind) ? "red" : "waiting";
}

/** Home's line above the list. */
export function attentionLine(items: AttentionItem[]): string {
  if (!items.length) return "Nothing is stuck.";
  return `${items.length} ${items.length === 1 ? "thing is" : "things are"} stuck or waiting too long.`;
}

export type ActionDo = { do: "task"; action: "release" | "close"; task: string } | { do: "start"; agent: string; stash?: true }
  | { do: "say"; agent: string; text: string } | { do: "choose"; agent: string; key: string; label: string } | { do: "open"; link: string }
  | { do: "none" };

/** What the page does for an action: a task's confirm (release, close), an agent's start confirm (also the one that saves
 *  its leftover changes aside first, #640), the confirm that sends one line to an agent's session (say), the confirm that
 *  types one answer into its picker (choose, #644), or a page. */
export function doOf(a: AttentionAction): ActionDo {
  if (a.kind === "none") return { do: "none" };
  if ((a.kind === "release" || a.kind === "close") && a.task) return { do: "task", action: a.kind, task: a.task };
  if (a.kind === "start" && a.agent) return a.stash ? { do: "start", agent: a.agent, stash: true } : { do: "start", agent: a.agent };
  if (a.kind === "say" && a.agent && a.text) return { do: "say", agent: a.agent, text: a.text };
  if (a.kind === "choose" && a.agent && a.key && /^\d{1,2}$/.test(a.key)) return { do: "choose", agent: a.agent, key: a.key, label: a.label };
  return { do: "open", link: a.link ?? "page:home" };
}

/** What the page does for an item's (first) action. */
export function actionOf(i: AttentionItem): ActionDo {
  return doOf(i.action);
}

/** The buttons a row shows: one per option of a question (#644), else its one action; none for an item that ends by itself. */
export function buttonsOf(i: AttentionItem): AttentionAction[] {
  if (i.options?.length) return i.options;
  return i.action.kind === "none" ? [] : [i.action];
}

/** What Start work's confirm says (#591): the line goes to the agent's session as the chat sends it (`factory say`). */
export function sayAsk(agent: string, text: string): { happens: string; doesNot: string } {
  return { happens: `${text} is sent to ${agent}'s session, as if typed there, and it looks for the next ready task.`,
    doesNot: "Nothing is claimed for it here. If the same text is already typed in its prompt box, it is sent, not typed again." };
}

/** What an answer's confirm says (#644): the option's number is typed into the agent's picker (`factory say --choose`). */
export function chooseAsk(agent: string, key: string, label: string): { happens: string; doesNot: string } {
  return { happens: `${key} (${label}) is typed into the question on ${agent}'s screen, as if you chose it there, and it carries on.`,
    doesNot: "Nothing is typed when the question is no longer on its screen: it says so instead. Nothing else is sent." };
}

/** What Save them aside and start's confirm says (#640). */
export function stashAsk(agent: string): { happens: string; doesNot: string } {
  return { happens: `The leftover changes in ${agent}'s folder are saved aside with git stash (untracked files too), then ${agent} starts.`,
    doesNot: "Nothing is deleted: `git stash list` in its folder shows them, and `git stash apply` brings them back. Other folders are not touched." };
}
