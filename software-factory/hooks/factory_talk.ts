#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory talk <dev-manager|product-owner> <text> [<history-json>]` (#395, #425): one turn of a talk with the dev
// manager or the product owner, which the web UI's chat runs (factory_ui_chat.ts).
//
// The dev manager is a program that starts a short Claude session per item, so there is no session to type into; this
// gives the owner one turn at a time instead. A fresh session of the role (its skill, profile, model and permissions, as
// the orchestrator starts a sub-manager) reads its context and answers <text>, with the conversation so far
// (`[{who: owner|role, text}]`) in its prompt. It prints {answer, summary}; the summary of the turn is posted on the owner
// queue ("Dev manager: needs the owner") marked `factory-cockpit-chat` (the marker the readers know, factory_prs.ts),
// which no reader takes as the owner's answer to an ask, so the next pass sees it as context. `summary.posted` is false
// when there is no queue or GitHub refused. A session that fails is `chat_failed` and posts nothing. It is the owner's:
// it refuses in an agent session. While the session runs, a file in this machine's state folder (factory_talks.ts) says
// so, and `factory agents ls` shows the role as working, "talking with the owner", rather than down.
import { claudeBin } from "./factory_claude.ts";
import { load, roleNames, toFloat } from "./factory_config.ts";
import { gh } from "./factory_issues.ts";
import { run, runMain } from "./factory_lib.ts";
import { refuse } from "./factory_machine.ts";
import { ownerQueue } from "./factory_orchestrator.ts";
import { contextLine, MARK, need, permissionFlags, sessionFlags } from "./factory_roles.ts";
import { talkBegin, talkEnd } from "./factory_talks.ts";

type Obj = { [key: string]: unknown };

const ROLES = ["dev-manager", "product-owner"];
const ANSWER_MAX = 6000; // what the chat shows of one answer
const SUMMARY_MAX = 1500; // what the owner queue gets of it
const MINUTES = 15;
const MAX_MINUTES = 19;
const TURNS = 10; // the turns of the conversation so far that go in the prompt
const USAGE = "Run `factory talk dev-manager <text>` or `factory talk product-owner <text>`, or talk to them in `factory ui`.";

type Turn = { who: "owner" | "role"; text: string };

/** `v` as text, without escape sequences or control characters. */
function plain(v: unknown): string {
  return (typeof v === "string" ? v : "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** The role named, or a refusal: only the dev manager and the product owner are talked to here. */
function roleOf(role: string | undefined): string {
  if (!role || !ROLES.includes(role)) {
    refuse("talk_usage", `factory talk talks to ${ROLES.join(" or ")}, not ${role ? `\`${plain(role)}\`` : "nothing"}.`, USAGE, 2);
  }
  return role;
}

/** Refuses in an agent session: a role must not talk to another role as the owner. */
function ownerOnly(): void {
  for (const name of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"]) {
    if (name in process.env) {
      refuse("talk_agent_session", `Talking to a role is the owner's, and ${name} is set, so this looks like an agent session.`,
        "Run `factory talk` in your own terminal, or talk in `factory ui`.");
    }
  }
}

/** The name the role's answers carry: its first name in `roles.<role>.names`, else the role. */
function nameOf(role: string): string {
  return roleNames(load(), role)[0] ?? role;
}

function turnsOf(json: string | undefined): Turn[] {
  if (!json) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    refuse("talk_usage", "The conversation so far isn't JSON: a list of {who: owner|role, text}.", USAGE, 2);
  }
  const list = Array.isArray(data) ? data.map((t): Obj => (typeof t === "object" && t !== null ? (t as Obj) : {})) : [];
  return list.map((t): Turn => ({ who: t.who === "role" ? "role" : "owner", text: typeof t.text === "string" ? t.text : "" })).slice(-TURNS);
}

/** The turn's prompt: who it is, the rules it acts within, the conversation so far and the owner's line. */
function prompt(role: string, name: string, text: string, history: Turn[]): string {
  const d = need(role);
  const said = history.map((t) => `${t.who === "owner" ? "Owner" : name}: ${t.text}`).join("\n\n");
  return [
    `You are ${name}, this project's ${d.title}. The owner is talking to you (\`factory talk\`, from the web UI or a ` +
      "terminal); this is one turn of that conversation, in a fresh session.",
    `Your standing rules are the ${d.skill} skill: read .claude/skills/${d.skill}/SKILL.md for what you may do on your own ` +
      "and what only the owner decides. Do not run a whole pass: answer the owner.",
    contextLine(load(), role),
    "Read what the answer needs and no more: the open pull requests (`factory prs`), the owner queue (the issue \"Dev " +
      "manager: needs the owner\"), your notes. When the owner asks you to do something your rules allow, do it and say " +
      "what you did; when they don't, say so and what the owner can do instead.",
    said ? `The conversation so far:\n\n${said}` : "",
    `The owner says now:\n\n${text}`,
    "Reply in plain words, in a few short lines: it is shown to the owner, and a summary is posted on the owner queue.",
    `<!-- ${MARK} role=${role} name=${name} -->`,
  ].filter(Boolean).join("\n\n");
}

/** The summary posted on the owner queue: marked, so no reader takes it for the owner's answer to an ask. It goes out
 *  with the owner's login, so a marker in the owner's line or the role's answer (`<!-- factory-owner-ask ...`) is broken
 *  (`&lt;!--`, which GitHub still shows as `<!--`): only the summary's own marker is read. */
function summaryBody(role: string, name: string, text: string, answer: string): string {
  const cut = (s: string) => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s).replace(/<!--/g, "&lt;!--");
  return `<!-- factory-cockpit-chat role=${role} -->\nThe owner talked to the ${need(role).title} (${name}). ` +
    `A summary for the next pass; it answers no ask.\n\n**Owner:** ${cut(text)}\n\n**${name}:** ${cut(answer)}`;
}

/** One turn, printed as JSON. */
export function main(args: string[]): number {
  ownerOnly();
  const role = roleOf(args[0]);
  const text = (args[1] ?? "").trim();
  if (!text || args.length > 3) {
    refuse("talk_usage", "factory talk takes the role, the owner's line and, optionally, the conversation so far.", USAGE, 2);
  }
  const history = turnsOf(args[2]);
  const cfg = load();
  const name = nameOf(role);
  // the web UI waits 20 minutes for an answer (factory_ui_chat.ts): a session never runs past it, so none posts after
  const minutes = Math.min(Math.max(toFloat(process.env.FACTORY_CHAT_MINUTES) ?? MINUTES, 1), MAX_MINUTES);
  const claude = claudeBin(); // PATH, else ~/.local/bin, else ~/.claude/local (#568): `factory ui` may run from a short PATH
  const env = { ...process.env, FACTORY_AGENT: name, FACTORY_ROLE: role, FACTORY_LOOP: "1" };
  const mark = talkBegin(role, name); // while it runs, `factory agents ls` shows the role as working, talking with the owner
  let p: ReturnType<typeof run>;
  try {
    p = run([claude, ...sessionFlags(cfg, role, name), ...permissionFlags(cfg), "-p", prompt(role, name, text, history)],
      { env, timeoutMs: minutes * 60_000 });
  } finally {
    talkEnd(mark);
  }
  const answer = p.stdout.trim().slice(0, ANSWER_MAX);
  if (p.code !== 0 || !answer) {
    const why = p.code === 0 ? "it gave no answer" : p.stderr.trim().split("\n").filter(Boolean).pop() || `it exited ${p.code}`;
    refuse("chat_failed", `The ${need(role).title}'s session failed (${plain(why).slice(0, 200)}); nothing was posted.`,
      "Run `factory doctor` to check Claude Code and the role's settings, then send the line again.");
  }
  let summary: Obj;
  try {
    const queue = ownerQueue(cfg, false);
    if (queue === null) summary = { posted: false, why: "there is no owner queue issue yet" };
    else {
      gh("POST", `repos/{owner}/{repo}/issues/${queue}/comments`, { body: summaryBody(role, name, text, answer) });
      summary = { posted: true, issue: queue };
    }
  } catch (e) {
    summary = { posted: false, why: `GitHub refused it (${(e instanceof Error ? e.message : String(e)).slice(0, 160)})` };
  }
  console.log(JSON.stringify({ answer, summary }));
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
