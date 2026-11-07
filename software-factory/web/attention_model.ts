// Needs attention (#579): what the server found stuck (GET /api/projects/:p/attention, Home's `attention`, and the
// WebSocket's {type: "attention"}), as the page shows it: the list at the top of Home, the count beside Home in the
// sidebar, and a small "stuck" mark with the reason on a card or an agent. No React here, so
// tests/web_ui_attention_model.test.ts runs it as it is. The server's rules are in hooks/factory_ui_attention.ts.

export interface AttentionAction {
  kind: "release" | "close" | "start" | "open";
  label: string;
  task?: string;
  agent?: string;
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
}

/** The marks for cards and agents: each task's and each agent's first reason. An agent is marked for what it is
 *  (down while holding work, working too long, a role that should run), a task for what is wrong with it. */
export function stuckMarks(items: AttentionItem[]): { tasks: Record<string, string>; agents: Record<string, string> } {
  const tasks: Record<string, string> = {};
  const agents: Record<string, string> = {};
  for (const i of items) {
    if ((i.kind === "task-quiet" || i.kind === "task-pr-gone") && i.task && !(i.task in tasks)) tasks[i.task] = i.reason;
    if (i.kind === "epic-done" && i.epic && !(i.epic in tasks)) tasks[i.epic] = i.reason;
    if ((i.kind === "agent-down" || i.kind === "session-long" || i.kind === "role-down") && i.agent && !(i.agent in agents)) agents[i.agent] = i.reason;
  }
  return { tasks, agents };
}

/** The dot of an item: red for what is down or only a person can fix, yellow for what is slow. */
export function attentionDot(i: AttentionItem): "red" | "waiting" {
  return ["board-down", "runners-down", "agent-down", "role-down", "task-pr-gone"].includes(i.kind) ? "red" : "waiting";
}

/** Home's line above the list. */
export function attentionLine(items: AttentionItem[]): string {
  if (!items.length) return "Nothing is stuck.";
  return `${items.length} ${items.length === 1 ? "thing is" : "things are"} stuck or waiting too long.`;
}

/** What the page does for an item's action: a task's confirm (release, close), an agent's start confirm, or a page. */
export function actionOf(i: AttentionItem): { do: "task"; action: "release" | "close"; task: string } | { do: "start"; agent: string }
  | { do: "open"; link: string } {
  const a = i.action;
  if ((a.kind === "release" || a.kind === "close") && a.task) return { do: "task", action: a.kind, task: a.task };
  if (a.kind === "start" && a.agent) return { do: "start", agent: a.agent };
  return { do: "open", link: a.link ?? "page:home" };
}
