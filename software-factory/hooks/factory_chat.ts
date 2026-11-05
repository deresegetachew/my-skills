// `factory owner chat <role> <message>` (#395): the owner talks to the dev manager or the product owner. Neither is a
// session to type into (the dev manager starts a short Claude session per item), so each message starts a fresh one,
// as the role, on its settings profile: it reads its own context (open pull requests, the owner queue, its notes),
// answers in a few lines and acts within its rules. The cockpit's chat pane (TALK TO in its list) runs this command.
//
// The conversation is kept per role in this machine's state folder (`chat-<role>.json`), and the last turns go into
// the next prompt, so the role knows what was said. Each answer ends with a `Summary:` line; that summary goes to the
// owner queue issue ("Dev manager: needs the owner") under `<!-- factory-owner-chat role=<role> -->`, so what was agreed
// is on record next to the asks. With no open owner queue issue, nothing is posted.
//
// Prints one JSON line: {answer, summary, posted} (posted: the comment's link, or null). Errors are one JSON line
// {code, message, fix} on stderr.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, load, roleNames } from "./factory_config.ts";
import { Exit, pyDumps, run } from "./factory_lib.ts";
import { stateDir } from "./factory_machine.ts";
import { OWNER_QUEUE_TITLE } from "./factory_prs.ts";
import { permissionFlags, sessionFlags } from "./factory_roles.ts";

export const CHAT_ROLES = ["dev-manager", "product-owner"];
const SKILL: Record<string, string> = { "dev-manager": "manage-pass", "product-owner": "product-pass" };
const TITLE: Record<string, string> = { "dev-manager": "dev manager", "product-owner": "product owner" };
const KEPT = 20; // turns kept in the file
const IN_PROMPT = 6; // turns the next prompt carries
const CHAT_MINUTES = 15; // one answer's longest run
const SUMMARY_CHARS = 200;

export type Turn = { you: string; answer: string; at: string };

function refuse(code: string, message: string, fix: string): never {
  process.stderr.write(pyDumps({ code, message, fix }) + "\n");
  throw new Exit(1);
}

function historyPath(role: string): string {
  return join(stateDir(), `chat-${role}.json`);
}

/** The turns so far with `role`, oldest first; none when there is no file or it can't be read. */
export function history(role: string): Turn[] {
  try {
    const data = JSON.parse(readFileSync(historyPath(role), "utf8")) as unknown;
    const turns = typeof data === "object" && data !== null ? (data as { turns?: unknown }).turns : null;
    return (Array.isArray(turns) ? turns : []).filter((t): t is Turn =>
      typeof t === "object" && t !== null && typeof t.you === "string" && typeof t.answer === "string");
  } catch {
    return [];
  }
}

function save(role: string, turns: Turn[]): void {
  const path = historyPath(role);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pyDumps({ turns: turns.slice(-KEPT) }, { indent: 1 }));
  renameSync(tmp, path);
}

/** The prompt for one message: who the role is, what was said before, the owner's message, and the summary line. */
export function prompt(role: string, turns: Turn[], message: string): string {
  const before = turns.slice(-IN_PROMPT).map((t) => `The owner: ${t.you}\nYou: ${t.answer}`).join("\n\n");
  return [
    `You are this project's ${TITLE[role]}. The owner is talking to you in the factory's cockpit (factory owner chat).`,
    `Your rules are in .claude/skills/${SKILL[role]}/SKILL.md: read them, and act only within them.`,
    "Read what you need to answer (open pull requests with `factory prs`, the owner queue, your notes) and do what the " +
      "owner asks when your rules allow it; say plainly when they don't, and what the owner can do instead.",
    "Answer in a few short lines, plain text. End with one line that starts `Summary:` and says in one sentence what was " +
      "asked and what you did or will do; it goes to the owner queue, on record for your next passes.",
    ...(before ? [`The conversation so far:\n\n${before}`] : []),
    `The owner says:\n\n${message}`,
  ].join("\n\n");
}

/** The answer's `Summary:` line, else its first line, at most SUMMARY_CHARS long. */
export function summaryOf(answer: string): string {
  const lines = answer.split(/\r?\n/).map((l) => l.trim());
  const marked = lines.find((l) => /^summary:/i.test(l));
  const text = marked !== undefined ? marked.replace(/^summary:\s*/i, "") : lines.find((l) => l) ?? "";
  return text.slice(0, SUMMARY_CHARS);
}

function gh(args: string[], input?: string): { code: number; out: string; err: string } {
  const p = run(["gh", "api", ...args, "-H", "Accept: application/vnd.github+json"], input === undefined ? {} : { input });
  return { code: p.code, out: p.stdout, err: (p.stderr || p.stdout).trim() };
}

/** The open owner queue issue's number, or null when there is none. */
function ownerQueue(): number | null {
  for (let page = 1; ; page++) {
    const p = gh(["-X", "GET", `repos/{owner}/{repo}/issues?state=open&per_page=100&page=${page}`]);
    if (p.code !== 0) {
      refuse("github_failed", `The owner queue could not be read: ${p.err.slice(0, 300)}`,
        "Check `gh auth status` and the network, then send the message again.");
    }
    const chunk = JSON.parse(p.out || "[]") as unknown;
    const issues = Array.isArray(chunk) ? (chunk as Record<string, unknown>[]) : [];
    const queue = issues.find((i) => i.state !== "closed" && !i.pull_request && String(i.title ?? "").startsWith(OWNER_QUEUE_TITLE));
    if (queue) return Number(queue.number);
    if (issues.length < 100) return null;
  }
}

/** Posts the summary on the owner queue; the comment's link, or null when there is no queue issue. */
function post(role: string, message: string, summary: string): string | null {
  const n = ownerQueue();
  if (n === null) return null;
  const said = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  const body = `<!-- factory-owner-chat role=${role} -->\n\n**The owner, in the cockpit:** ${said}\n\n**The ${TITLE[role]}:** ${summary}`;
  const p = gh(["-X", "POST", `repos/{owner}/{repo}/issues/${n}/comments`, "--input", "-"], JSON.stringify({ body }));
  if (p.code !== 0) {
    refuse("github_failed", `The answer came, but its summary could not be posted on #${n}: ${p.err.slice(0, 300)}`,
      "Check `gh auth status`, then send the message again, or write the summary on the owner queue issue yourself.");
  }
  const got = JSON.parse(p.out || "{}") as { html_url?: unknown };
  return typeof got.html_url === "string" ? got.html_url : `#${n}`;
}

/** Runs the role's fresh session on the message; its answer, trimmed. */
function ask(cfg: Config, role: string, text: string): string {
  const name = roleNames(cfg, role)[0] || role;
  const env = { ...process.env, FACTORY_ROLE: role, FACTORY_AGENT: `${name}-chat`, FACTORY_LOOP: "1", TMUX: undefined };
  const p = run(["claude", ...sessionFlags(cfg, role), ...permissionFlags(cfg), "-p", text],
    { env, timeoutMs: CHAT_MINUTES * 60_000 });
  const answer = p.stdout.trim();
  if (p.code !== 0 || !answer) {
    const why = p.timedOut ? `it gave no answer in ${CHAT_MINUTES} minutes` : `it ended with ${p.code}` +
      (p.stderr.trim() ? `: ${p.stderr.trim().split("\n").pop()?.slice(0, 200)}` : "");
    refuse("chat_failed", `The ${TITLE[role]}'s session did not answer (${why}).`,
      "Run `claude` once in this folder to check it starts and is signed in, then send the message again.");
  }
  return answer;
}

/** `factory owner chat <role> <message>`: the answer, its summary and where the summary was posted, as one JSON line. */
export function chat(role: string | undefined, message: string): void {
  if (!role || !CHAT_ROLES.includes(role)) {
    refuse("unknown_role", `Say who to talk to: ${CHAT_ROLES.join(" or ")} (got ${role ? `\`${role}\`` : "nothing"}).`,
      'factory owner chat dev-manager "how is #12 going?"');
  }
  if (!message.trim()) refuse("needs_text", `Write what to say to the ${TITLE[role]}.`, `factory owner chat ${role} "how is #12 going?"`);
  const cfg = load();
  const turns = history(role);
  const answer = ask(cfg, role, prompt(role, turns, message.trim()));
  const summary = summaryOf(answer);
  save(role, [...turns, { you: message.trim(), answer, at: new Date().toISOString() }]);
  const posted = post(role, message.trim(), summary);
  console.log(JSON.stringify({ answer, summary, posted }));
}
