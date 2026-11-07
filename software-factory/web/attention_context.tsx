// Needs attention's marks (#579): the reasons the server gave, by task (or epic) and by agent, for the page shown, and the
// small "stuck" mark a card, an epic, a task's page or an agent shows with its reason. The app provides them from the
// WebSocket's {type: "attention"} (web/attention_model.ts stuckMarks).
import { createContext } from "react";

export const AttentionContext = createContext<{ tasks: Record<string, string>; agents: Record<string, string> }>({ tasks: {}, agents: {} });

/** "Stuck" and why, in one small line. */
export function StuckMark({ reason }: { reason: string }) {
  return <p className="stuck-mark" title={reason}><span className="stuck-tag">Stuck</span><span className="stuck-why">{reason}</span></p>;
}

export const STUCK_CSS = String.raw`
.stuck-mark { display: flex; align-items: baseline; gap: 6px; margin: 6px 0 0; font-size: 12px; color: var(--text-2); line-height: 1.4; }
.stuck-tag { flex: none; padding: 1px 6px; border-radius: 999px; background: var(--red-fill); color: var(--red-ink); font-size: 11px; font-weight: 700; }
.stuck-why { min-width: 0; }
.nav-item .stuck-tag { margin-left: 4px; }
`;
