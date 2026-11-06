// The citations in a text (#438): a decision (`decision 0004`, `ADR 5`, `ADR #5`) or a PRD story (`US-12`). The task
// trackers and `factory prs` read them from a body, and the web UI links each one that has a Docs page. One rule for all.

export const CITE = /\b(?:decision|ADR)\s+#?(\d{1,4})\b|\bUS-(\d+)\b/gi;

const MAX_CITES = 20;

/** The distinct citations in `text` as written, in the order they first appear, at most 20. */
export function citesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITE)) {
    if (!out.includes(m[0])) out.push(m[0]);
    if (out.length >= MAX_CITES) break;
  }
  return out;
}
