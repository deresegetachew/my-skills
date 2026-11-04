// What the cockpit's command bar offers, and how what was typed matches it (#309, #367). No I/O and no imports, so the
// bar's Ink screen (cockpit/command-bar.tsx) and `factory cockpit --bar` off a terminal rank the same way.

/** The read-only commands the `:` bar offers (the owner's actions are ACTIONS_OFFERED). */
export const OFFERED = ["status", "prs", "next", "claims list", "agents ls", "messages ls", "issues list", "issues show",
  "ci status", "ci log", "ci runners", "settings list", "settings show", "settings get", "settings help", "settings diff",
  "usage", "report", "lessons show", "doctor", "version", "env", "machine show", "remote list", "help"];

/** The owner's actions (#309, US-11), each the factory command the command line runs, and what it changes. The bar asks
 *  before it runs one; the rest of the line (flags too, such as `--remove` or `--head`) goes to that command as typed. */
export const ACTIONS_OFFERED: Record<string, string> = {
  "owner merge": "GitHub: it merges the pull request",
  "owner label": "GitHub: it adds or removes a label",
  "owner answer": "GitHub: it posts the answer in the owner queue",
  "owner release": "GitHub: it tags main and pushes the tag, which publishes a release",
  "owner start": "this machine: it starts a session in tmux",
  "owner stop": "this machine: it ends that session",
  say: "a session: it types the message into it",
};

export const ACTION_NAMES = Object.keys(ACTIONS_OFFERED);

/** How well `name` matches what was typed: lower is better, null for no match (start, then letters in order). */
export function rank(name: string, typed: string): number | null {
  if (!typed) return 0;
  if (name.startsWith(typed)) return name.length - typed.length;
  let at = 0;
  for (const ch of typed) {
    at = name.indexOf(ch, at) + 1;
    if (at === 0) return null;
  }
  return 1000 + at;
}

/** Everything the bar offers that matches `typed`, best first. */
export function matches(typed: string): string[] {
  const ranked = [...OFFERED, ...ACTION_NAMES].map((n) => [n, rank(n, typed)] as const).filter((x): x is readonly [string, number] => x[1] !== null);
  return ranked.sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}
