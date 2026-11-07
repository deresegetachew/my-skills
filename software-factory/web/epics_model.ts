// The rules of an epic's page (#440) that aren't drawing: the stage bar, the words that put a message on the epic's
// thread, and the thread itself. No React here, so tests/epic_detail.test.ts runs it as it is.
import type { ChatItemView } from "./chat_model.ts";
import { citeLinks, type DocPage } from "./docs_model.ts";
import { itemThread, talkBody, talkText as itemTalkText } from "./parts_model.ts";

/** The stages in the order an epic walks them (a parked epic is none of them), with the words the page shows. */
export const STAGE_FLOW: Array<[string, string]> = [["investigating", "Investigating"], ["prd", "PRD written"], ["decision", "Decision"],
  ["planned", "Planned"], ["building", "Building"], ["done", "Done"]];

export interface StageStep {
  stage: string;
  name: string;
  /** Before the epic's stage (done), its stage (now), or after it (later). */
  state: "done" | "now" | "later";
}

export function stageSteps(stage: string): StageStep[] {
  const at = STAGE_FLOW.findIndex(([s]) => s === stage);
  return STAGE_FLOW.map(([s, name], i) => ({ stage: s, name, state: at < 0 || i > at ? "later" : i === at ? "now" : "done" }));
}

export interface Written {
  name: string;
  tag: string;
  /** The channel that opens it (`doc:<id>`), or null when the Docs have no page for it. */
  channel: string | null;
}

/** Where an epic is written down: its PRD file, its decisions, and what its title and body cite (`citeLinks`, the rule the
 * tasks use), each once and linked to its Docs page when there is one. */
export function writtenDown(e: { title: string; prd: string; decisions: string[]; cites?: string[] }, pages: DocPage[]): Written[] {
  const out: Written[] = [];
  const seen = new Set<string>();
  const add = (w: Written): void => {
    const key = w.channel ?? `${w.tag}:${w.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };
  const norm = (p: string): string => p.replace(/^\.?\//, "");
  if (e.prd) {
    const page = pages.find((p) => norm(p.path) === norm(e.prd) || p.path.endsWith(`/${norm(e.prd)}`));
    add({ name: page?.title ?? e.prd, tag: "PRD", channel: page ? `doc:${page.id}` : null });
  }
  const cites = [...e.decisions.map((d) => `decision ${d.replace(/^#/, "")}`), ...(e.cites ?? [])];
  for (const c of cites) {
    const link = citeLinks([c], pages)[0]?.link;
    const page = link ? pages.find((p) => p.id === link.id) : undefined;
    if (!link) {
      if (e.decisions.some((d) => c === `decision ${d.replace(/^#/, "")}`)) add({ name: c.replace(/^decision /, "Decision "), tag: "Decision", channel: null });
      continue;
    }
    add({ name: link.id === "prd" ? `${page?.title ?? "PRD"}: ${c}` : page?.title ?? c, tag: link.id === "prd" ? "Story" : "Decision",
      channel: `doc:${link.id}${link.anchor ? `#${link.anchor}` : ""}` });
  }
  return out;
}

/** What the "Talk about this" box sends: the owner's line, led by the epic it is about (the shared box's rule, #450). */
export function talkText(epic: { id: string; title: string }, text: string): string {
  return itemTalkText({ kind: "epic", ...epic }, text);
}

/** The epic's thread out of a chat: the owner's messages about it, and the answers that follow each. */
export function epicThread(items: ChatItemView[], epicId: string): ChatItemView[] {
  return itemThread(items, { kind: "epic", id: epicId });
}

/** A thread line as the epic's page shows it: without the "About epic #n (title): " that leads the owner's lines (#464). */
export function threadText(epic: { id: string; title: string }, text: string): string {
  return talkBody({ kind: "epic", ...epic }, text);
}

export type EpicChoice<T> = { show: "list" } | { show: "page"; epic: T } | { show: "missing"; id: string };

/** What the epics channel shows for the epic it was asked for (`#n`, or a click): its page, a "not found" when no epic
 * has that number (#464), or the list when none was asked for. */
export function epicChoice<T extends { id: string }>(all: T[], chosen: string | null): EpicChoice<T> {
  if (chosen === null) return { show: "list" };
  const epic = all.find((e) => e.id === chosen);
  return epic ? { show: "page", epic } : { show: "missing", id: chosen };
}
