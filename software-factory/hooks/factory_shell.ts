// The command reader the gates share: a Bash command split into simple commands and gh-style arguments, ported
// exactly from pr-gate.py (#252). manager_gate.ts imports it from here, and pr-gate.ts will import it from here too
// when it is ported, so both gates read a command the same way.
//
// simpleCommands is Python's shlex.shlex(posix=True, punctuation_chars=";&|()<>") with whitespace_split on and no
// comment characters, the tokenizer pr-gate.py used; parseArgs is its parse_args.

export const GH_COMMANDS = new Set(["api", "attestation", "auth", "browse", "cache", "codespace", "completion", "config",
  "copilot", "extension", "gist", "gpg-key", "help", "issue", "label", "org", "pr", "preview", "project", "release", "repo",
  "ruleset", "run", "search", "secret", "ssh-key", "status", "variable", "workflow", "version"]);
export const GLOBAL_WITH_VALUE = new Set(["-R", "--repo", "--hostname"]);
/** Flags of the gh subcommands the gate reads that take a value. */
export const VALUE_FLAGS = new Set([
  "-t", "--title", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email",
  "--match-head-commit", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label", "-m",
  "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "--add-label", "--remove-label",
  "--add-assignee", "--remove-assignee", "--add-reviewer", "--remove-reviewer", "--add-project",
  "--remove-project", "-c", "--comment", "-R", "--repo", "-q", "--jq", "--json", "-S", "--search", "-L",
  "--limit", "-s", "--state"]);
/** gh pr merge: -s, -m, -r and -d are booleans there (squash, merge, rebase, delete branch), not values. */
export const MERGE_VALUE_FLAGS = new Set(["-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email",
  "--match-head-commit", "-R", "--repo"]);
/** Text the gate can't see because the shell would expand it first: $(...), `...`, ${...} and $NAME. */
export const SHELL_EXPANSION = /\$\(|`|\$\{|\$[A-Za-z_]/;
export const SEPARATORS = new Set(";&|()<>");
/** Prefixes that run the next word as the program, so `env gh pr merge` and `sudo gh ...` are still gh. */
export const PREFIXES = new Set(["env", "command", "builtin", "exec", "sudo", "nohup", "time", "nice", "doas",
  // shell words that start a command list: `if gh pr merge ...; then`, `! gh ...`, `{ gh ...; }`
  "if", "then", "else", "elif", "while", "until", "do", "!", "{", "}"]);
/** Programs that run a command given as text; a gh command inside their arguments can't be checked. */
export const WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "xargs", "env", "nohup", "time",
  "timeout", "sudo", "script", "watch", "nice", "python", "python3", "node", "perl", "ruby",
  // package runners run the next words as a program: `pnpm exec gh pr merge 7` is gh, unchecked
  "pnpm", "pnpx", "npx", "npm", "yarn", "bunx", "bun", "corepack"]);
/** "$(gh pr merge 7)", `gh ...` */
export const GH_IN_SUBSTITUTION = /(\$\(|`)\s*(\S*\/)?gh(\s|[`)]|$)/;
// [^\w.-] as Python's re has it (\w is Unicode there).
export const GH_IN_TEXT = /(^|[^\p{L}\p{N}_.-])gh\s+(-\S+\s+)*[a-z]/u;
/** A refspec that deletes a remote branch: `git push origin :task/1-x` or `+:x` (#47). */
export const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
  "--config-env"]);
export const PUSH_DELETE_IN_TEXT = /(^|[^\p{L}\p{N}_.-])git\b[^;&|]*\bpush\b[^;&|]*\s\+?:/u;

const WHITESPACE = " \t\r\n";
const QUOTES = "'\"";

/** shlex.shlex(text, posix=True, punctuation_chars=";&|()<>") with whitespace_split and no commenters, as a list of
 * tokens. Throws Error("No closing quotation" / "No escaped character") like shlex's ValueError. */
export function shlexTokens(text: string): string[] {
  const out: string[] = [];
  let pos = 0;
  let state: string | null = " ";
  const pushback: string[] = [];
  const next = (): string => (pushback.length ? (pushback.pop() as string) : pos < text.length ? (text[pos++] as string) : "");
  const read = (): string | null => {
    let quoted = false;
    let escapedState = " ";
    let token = "";
    for (;;) {
      const c = next();
      if (state === null) {
        token = "";
        break;
      } else if (state === " ") {
        if (!c) {
          state = null;
          break;
        } else if (WHITESPACE.includes(c)) {
          if (token || quoted) break;
          continue;
        } else if (c === "\\") {
          escapedState = "a";
          state = c;
        } else if (SEPARATORS.has(c)) {
          token = c;
          state = "c";
        } else if (QUOTES.includes(c)) {
          state = c;
        } else {
          token = c;
          state = "a";
        }
      } else if (QUOTES.includes(state)) {
        quoted = true;
        if (!c) throw new Error("No closing quotation");
        if (c === state) state = "a";
        else if (c === "\\" && state === '"') {
          escapedState = state;
          state = c;
        } else token += c;
      } else if (state === "\\") {
        if (!c) throw new Error("No escaped character");
        if (QUOTES.includes(escapedState) && c !== state && c !== escapedState) token += state;
        token += c;
        state = escapedState;
      } else if (state === "a" || state === "c") {
        if (!c) {
          state = null;
          break;
        } else if (WHITESPACE.includes(c)) {
          state = " ";
          if (token || quoted) break;
          continue;
        } else if (state === "c") {
          if (SEPARATORS.has(c)) token += c;
          else {
            pushback.push(c);
            state = " ";
            break;
          }
        } else if (QUOTES.includes(c)) {
          state = c;
        } else if (c === "\\") {
          escapedState = "a";
          state = c;
        } else if (!SEPARATORS.has(c)) {
          token += c;
        } else {
          pushback.push(c);
          state = " ";
          if (token || quoted) break;
          continue;
        }
      }
    }
    return !quoted && token === "" ? null : token;
  };
  for (let t = read(); t !== null; t = read()) out.push(t);
  return out;
}

/** The command split into simple commands (on ; & | && || newlines and brackets), each a token list. Throws on a
 * command it can't read (unbalanced quotes), like pr-gate.py's ValueError. */
export function simpleCommands(cmd: string): string[][] {
  cmd = cmd.replaceAll("\\\r\n", " ").replaceAll("\\\n", " "); // a backslash-newline continues the line in bash
  const out: string[][] = [];
  let cur: string[] = [];
  for (const tok of shlexTokens(cmd.replaceAll("\n", " ; "))) {
    if (tok && [...tok].every((c) => SEPARATORS.has(c))) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(tok);
  }
  if (cur.length) out.push(cur);
  return out;
}

export type Flags = Record<string, string[]>;

/** [flags {name: [values]}, positionals] for gh-style arguments. */
export function parseArgs(args: readonly string[], valueFlags: ReadonlySet<string> = VALUE_FLAGS): [Flags, string[]] {
  const flags: Flags = {};
  const pos: string[] = [];
  const add = (name: string, value: string): void => {
    (flags[name] ??= []).push(value);
  };
  for (let k = 0; k < args.length; k++) {
    const t = args[k] as string;
    if (t.startsWith("--") && t.includes("=")) {
      const i = t.indexOf("=");
      add(t.slice(0, i), t.slice(i + 1));
    } else if (valueFlags.has(t) && k + 1 < args.length) {
      add(t, args[k + 1] as string);
      k++;
    } else if (t.length > 2 && !t.startsWith("--") && valueFlags.has(t.slice(0, 2))) { // -F/tmp/x.md, -b'text'
      add(t.slice(0, 2), t.slice(2));
    } else if (t.startsWith("-") && t.length > 1) {
      add(t, "");
    } else pos.push(t);
  }
  return [flags, pos];
}
