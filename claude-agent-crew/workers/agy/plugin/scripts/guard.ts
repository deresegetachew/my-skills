export type GuardDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

const UNREADABLE_REASON = "guard could not read the command";
const MAX_RECURSION_DEPTH = 8;

const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
]);

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--exec-path",
]);

const GIT_PUSH_VALUE_FLAGS = new Set([
  "--repo",
  "--receive-pack",
  "--exec",
  "-o",
  "--push-option",
  "--negotiation-tip",
]);

const GH_COMMON_VALUE_FLAGS = new Set(["-R", "--repo", "-H", "--hostname"]);

const GH_API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

function deny(reason: string): GuardDecision {
  return { decision: "deny", reason };
}

function allow(): GuardDecision {
  return { decision: "allow" };
}

function basename(cmd: string): string {
  const idx = cmd.lastIndexOf("/");
  return idx === -1 ? cmd : cmd.slice(idx + 1);
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

interface ParsedShell {
  commands: string[][];
  embeddedScripts: string[];
}

function extractDollarParen(
  input: string,
  startIdx: number
): { content: string; nextIdx: number } {
  let i = startIdx + 2;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;

  while (i < input.length && depth > 0) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < input.length) {
        i += 2;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        i++;
        continue;
      }
      if (ch === "$" && input[i + 1] === "(") {
        depth++;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        return {
          content: input.slice(startIdx + 2, i),
          nextIdx: i + 1,
        };
      }
      i++;
      continue;
    }
    i++;
  }

  return {
    content: input.slice(startIdx + 2),
    nextIdx: input.length,
  };
}

function extractBacktick(
  input: string,
  startIdx: number
): { content: string; nextIdx: number } {
  let i = startIdx + 1;
  let content = "";

  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === "`" || next === "\\" || next === "$") {
        content += next;
      } else {
        content += ch + next;
      }
      i += 2;
      continue;
    }
    if (ch === "`") {
      return { content, nextIdx: i + 1 };
    }
    content += ch;
    i++;
  }

  return { content, nextIdx: input.length };
}

function isSeparatorStart(input: string, idx: number): boolean {
  if (idx >= input.length) return true;
  const ch = input[idx];
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\r" ||
    ch === "\n" ||
    ch === ";" ||
    ch === "|" ||
    ch === "&" ||
    ch === "(" ||
    ch === ")"
  );
}

function skipRedirectTarget(input: string, startIdx: number): number {
  let i = startIdx;
  while (i < input.length && (input[i] === " " || input[i] === "\t")) {
    i++;
  }
  while (i < input.length && !isSeparatorStart(input, i)) {
    const ch = input[i];
    if (ch === "'") {
      i++;
      while (i < input.length && input[i] !== "'") i++;
      if (i < input.length) i++;
    } else if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) i += 2;
        else i++;
      }
      if (i < input.length) i++;
    } else if (ch === "\\" && i + 1 < input.length) {
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

export function parseShellCommands(input: string): ParsedShell {
  const commands: string[][] = [];
  const embeddedScripts: string[] = [];

  let currentCmd: string[] = [];
  let currentToken = "";
  let hasToken = false;

  const flushToken = () => {
    if (hasToken) {
      currentCmd.push(currentToken);
      currentToken = "";
      hasToken = false;
    }
  };

  const flushCmd = () => {
    flushToken();
    if (currentCmd.length > 0) {
      commands.push(currentCmd);
      currentCmd = [];
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\r") {
      flushToken();
      i++;
      continue;
    }

    if (ch === "#" && !hasToken) {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (ch === "\n" || ch === ";") {
      flushCmd();
      i++;
      continue;
    }

    if (
      (ch === "&" && input[i + 1] === "&") ||
      (ch === "|" && input[i + 1] === "|") ||
      (ch === "|" && input[i + 1] === "&")
    ) {
      flushCmd();
      i += 2;
      continue;
    }

    if (ch === "&" && input[i + 1] === ">") {
      flushToken();
      i += input[i + 2] === ">" ? 3 : 2;
      i = skipRedirectTarget(input, i);
      continue;
    }

    if (ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      flushCmd();
      i++;
      continue;
    }

    if ((ch === "{" || ch === "}") && !hasToken && isSeparatorStart(input, i + 1)) {
      flushCmd();
      i++;
      continue;
    }

    if (!hasToken) {
      const redirMatch = input.slice(i).match(/^(\d*)(>>|>&|<&|<>|>|<)/);
      if (redirMatch) {
        const op = redirMatch[2];
        i += redirMatch[0].length;
        if (op === ">&" || op === "<&") {
          while (i < input.length && /[0-9-]/.test(input[i])) i++;
        } else {
          i = skipRedirectTarget(input, i);
        }
        continue;
      }
    }

    if (ch === "'") {
      hasToken = true;
      i++;
      while (i < input.length && input[i] !== "'") {
        currentToken += input[i];
        i++;
      }
      if (i < input.length && input[i] === "'") i++;
      continue;
    }

    if (ch === '"') {
      hasToken = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        const inner = input[i];
        if (inner === "\\" && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === "\n") {
            i += 2;
            continue;
          }
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            currentToken += next;
            i += 2;
            continue;
          }
          currentToken += inner;
          i++;
          continue;
        }
        if (inner === "$" && input[i + 1] === "(") {
          const { content, nextIdx } = extractDollarParen(input, i);
          if (!content.startsWith("(")) {
            embeddedScripts.push(content);
          }
          currentToken += input.slice(i, nextIdx);
          i = nextIdx;
          continue;
        }
        if (inner === "`") {
          const { content, nextIdx } = extractBacktick(input, i);
          embeddedScripts.push(content);
          currentToken += input.slice(i, nextIdx);
          i = nextIdx;
          continue;
        }
        currentToken += inner;
        i++;
      }
      if (i < input.length && input[i] === '"') i++;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      hasToken = true;
      currentToken += input[i + 1];
      i += 2;
      continue;
    }

    if (ch === "$" && input[i + 1] === "(") {
      hasToken = true;
      const { content, nextIdx } = extractDollarParen(input, i);
      if (!content.startsWith("(")) {
        embeddedScripts.push(content);
      }
      currentToken += input.slice(i, nextIdx);
      i = nextIdx;
      continue;
    }

    if (ch === "`") {
      hasToken = true;
      const { content, nextIdx } = extractBacktick(input, i);
      embeddedScripts.push(content);
      currentToken += input.slice(i, nextIdx);
      i = nextIdx;
      continue;
    }

    hasToken = true;
    currentToken += ch;
    i++;
  }

  flushCmd();
  return { commands, embeddedScripts };
}

function isProtectedBranch(ref: string): boolean {
  const normalized = ref.replace(/^refs\/heads\//, "");
  return normalized === "main" || normalized === "master";
}

function isMainOrRemoteMainRef(ref: string): boolean {
  const normalized = ref.replace(/^refs\/(heads|remotes\/[^/]+)\//, "");
  if (normalized === "main" || normalized === "master") return true;
  return /^(origin|upstream)\/(main|master)$/.test(ref);
}

function checkGitPush(pushArgs: string[]): GuardDecision | null {
  const positionals: string[] = [];
  let hasRepoFlag = false;
  let afterDoubleDash = false;

  for (let j = 0; j < pushArgs.length; j++) {
    const arg = pushArgs[j];

    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }

      if (
        arg === "--force" ||
        arg === "--force-with-lease" ||
        arg.startsWith("--force-with-lease=")
      ) {
        return deny(`force-pushing (${arg}) is not allowed`);
      }

      if (arg === "--delete") {
        return deny("deleting remote branches via git push --delete is not allowed");
      }

      if (arg === "--repo" || arg.startsWith("--repo=")) {
        hasRepoFlag = true;
        if (arg === "--repo") j++;
        continue;
      }

      if (GIT_PUSH_VALUE_FLAGS.has(arg)) {
        j++;
        continue;
      }

      if (arg.startsWith("--")) {
        continue;
      }

      if (arg.startsWith("-") && arg.length > 1) {
        for (const flag of arg.slice(1)) {
          if (flag === "o") break;
          if (flag === "f") {
            return deny("force-pushing (-f) is not allowed");
          }
          if (flag === "d") {
            return deny("deleting remote branches (-d) is not allowed");
          }
        }
        continue;
      }
    }

    positionals.push(arg);
  }

  const refspecs = hasRepoFlag ? positionals : positionals.slice(1);

  for (const spec of refspecs) {
    if (spec.startsWith("+")) {
      return deny(`force-pushing with +refspec (${spec}) is not allowed`);
    }

    const colonIdx = spec.indexOf(":");
    if (colonIdx !== -1) {
      const src = spec.slice(0, colonIdx);
      const dst = spec.slice(colonIdx + 1);

      if (src === "") {
        if (isProtectedBranch(dst)) {
          return deny(`deleting protected branch ${dst} via :refspec is not allowed`);
        }
        return deny(`deleting remote branch via ${spec} is not allowed`);
      }

      if (isProtectedBranch(dst)) {
        return deny(`pushing to protected branch ${dst} is not allowed`);
      }
    } else if (isProtectedBranch(spec)) {
      return deny(`pushing to protected branch ${spec} is not allowed`);
    }
  }

  return null;
}

function checkGitReset(resetArgs: string[]): GuardDecision | null {
  let hasHard = false;
  const positionals: string[] = [];
  let afterDoubleDash = false;

  for (const arg of resetArgs) {
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (arg === "--hard") {
        hasHard = true;
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
    }
    positionals.push(arg);
  }

  if (hasHard && positionals.some((ref) => isMainOrRemoteMainRef(ref))) {
    return deny("hard-resetting to main/master is not allowed");
  }

  return null;
}

function checkGitBranch(branchArgs: string[]): GuardDecision | null {
  let hasMutatingFlag = false;
  const positionals: string[] = [];
  let afterDoubleDash = false;

  for (const arg of branchArgs) {
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (arg === "--force" || arg === "--delete" || arg === "-D") {
        hasMutatingFlag = true;
        continue;
      }
      if (arg.startsWith("-") && !arg.startsWith("--")) {
        if (arg.includes("f") || arg.includes("d") || arg.includes("D")) {
          hasMutatingFlag = true;
        }
        continue;
      }
      if (arg.startsWith("--")) {
        continue;
      }
    }
    positionals.push(arg);
  }

  if (hasMutatingFlag && positionals.some((ref) => isProtectedBranch(ref))) {
    return deny("forcing or deleting protected branch main/master is not allowed");
  }

  return null;
}

function checkGitCheckoutOrSwitch(
  subcommand: "checkout" | "switch",
  subArgs: string[]
): GuardDecision | null {
  let hasForceCreate = false;
  const positionals: string[] = [];
  let afterDoubleDash = false;

  for (const arg of subArgs) {
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (
        (subcommand === "checkout" && arg === "-B") ||
        (subcommand === "switch" && (arg === "-C" || arg === "--force-create"))
      ) {
        hasForceCreate = true;
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
    }
    positionals.push(arg);
  }

  if (hasForceCreate && positionals.some((ref) => isProtectedBranch(ref))) {
    return deny("force-resetting protected branch main/master is not allowed");
  }

  return null;
}

function checkGit(args: string[]): GuardDecision | null {
  let i = 0;
  let subcommand: string | null = null;

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i++;
      continue;
    }
    subcommand = arg;
    i++;
    break;
  }

  const rest = args.slice(i);
  if (subcommand === "push") return checkGitPush(rest);
  if (subcommand === "reset") return checkGitReset(rest);
  if (subcommand === "branch") return checkGitBranch(rest);
  if (subcommand === "checkout" || subcommand === "switch") {
    return checkGitCheckoutOrSwitch(subcommand, rest);
  }
  if (subcommand === "update-ref") {
    if (rest.some((arg) => arg === "refs/heads/main" || arg === "refs/heads/master")) {
      return deny("updating refs/heads/main or refs/heads/master directly is not allowed");
    }
  }

  return null;
}

function normalizeGhApiPath(endpoint: string): string {
  let path = endpoint;
  try {
    if (/^https?:\/\//i.test(endpoint)) {
      path = new URL(endpoint).pathname;
    }
  } catch {
    // Fall back to raw endpoint string
  }
  const qIdx = path.indexOf("?");
  if (qIdx !== -1) path = path.slice(0, qIdx);
  const hIdx = path.indexOf("#");
  if (hIdx !== -1) path = path.slice(0, hIdx);
  return path.replace(/^\/+/, "");
}

function isProtectedGhApiEndpoint(endpoint: string): boolean {
  const path = normalizeGhApiPath(endpoint);
  if (/(^|\/)branches\/[^/]+\/protection(\/|$)/i.test(path)) {
    return true;
  }
  if (/(^|\/)rulesets(\/|$)/i.test(path)) {
    return true;
  }
  if (/(^|\/)rules\/branches(\/|$)/i.test(path)) {
    return true;
  }
  return false;
}

function checkGh(args: string[]): GuardDecision | null {
  let i = 0;
  const subcommands: string[] = [];

  while (i < args.length && subcommands.length < 2) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (GH_COMMON_VALUE_FLAGS.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i++;
      continue;
    }
    subcommands.push(arg);
    i++;
    if (subcommands[0] === "api") {
      break;
    }
  }

  const [cmd, sub] = subcommands;

  if (cmd === "pr" && sub === "merge") {
    return deny("merging pull requests via gh pr merge is not allowed");
  }

  if (cmd === "repo" && sub === "delete") {
    return deny("deleting repositories via gh repo delete is not allowed");
  }

  if (cmd === "api") {
    const apiArgs = args.slice(i);
    let afterDoubleDash = false;
    const positionals: string[] = [];
    const fieldValues: string[] = [];

    for (let j = 0; j < apiArgs.length; j++) {
      const arg = apiArgs[j];
      if (!afterDoubleDash) {
        if (arg === "--") {
          afterDoubleDash = true;
          continue;
        }
        if (GH_API_VALUE_FLAGS.has(arg)) {
          const val = apiArgs[j + 1];
          if (
            val !== undefined &&
            (arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field")
          ) {
            fieldValues.push(val);
          }
          j++;
          continue;
        }
        if (arg.startsWith("--field=") || arg.startsWith("--raw-field=")) {
          fieldValues.push(arg.slice(arg.indexOf("=") + 1));
          continue;
        }
        if (arg.startsWith("-")) {
          continue;
        }
      }
      positionals.push(arg);
    }

    for (const endpoint of positionals) {
      if (isProtectedGhApiEndpoint(endpoint)) {
        return deny(
          "calling GitHub branch protection or rulesets API endpoints is not allowed"
        );
      }
      if (normalizeGhApiPath(endpoint).toLowerCase() === "graphql") {
        const joined = fieldValues.join(" ");
        if (
          /\b(create|update|delete)(BranchProtectionRule|RepositoryRuleset)\b/i.test(
            joined
          )
        ) {
          return deny(
            "modifying branch protection or rulesets via gh api graphql is not allowed"
          );
        }
      }
    }
  }

  return null;
}

function extractShellDashCScript(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg === "-o" || arg === "+o") {
      i++;
      continue;
    }
    if (arg === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
      return args[i + 1] ?? null;
    }
    if (!arg.startsWith("-") && !arg.startsWith("+")) {
      return null;
    }
  }
  return null;
}

function checkSimpleCommand(
  rawArgv: string[],
  depth: number
): GuardDecision | null {
  let argv = rawArgv.slice();

  let guardCounter = 0;
  while (argv.length > 0 && guardCounter < 16) {
    guardCounter++;

    if (SHELL_KEYWORDS.has(argv[0]) || isEnvAssignment(argv[0])) {
      argv = argv.slice(1);
      continue;
    }

    const bin = basename(argv[0]);

    if (bin === "env") {
      let idx = 1;
      while (idx < argv.length) {
        const a = argv[idx];
        if (a === "--") {
          idx++;
          break;
        }
        if (a === "-S" || a === "--split-string") {
          const splitArg = argv[idx + 1];
          if (splitArg !== undefined) {
            const nested = checkCommand(splitArg, depth + 1);
            if (nested.decision === "deny") {
              return nested;
            }
          }
          idx += 2;
          continue;
        }
        if (a.startsWith("--split-string=")) {
          const nested = checkCommand(a.slice("--split-string=".length), depth + 1);
          if (nested.decision === "deny") {
            return nested;
          }
          idx++;
          continue;
        }
        if (
          a === "-u" ||
          a === "--unset" ||
          a === "-C" ||
          a === "--chdir" ||
          a === "-P" ||
          a === "-a"
        ) {
          idx += 2;
          continue;
        }
        if (a.startsWith("-")) {
          idx++;
          continue;
        }
        break;
      }
      argv = argv.slice(idx);
      continue;
    }

    if (bin === "command" || bin === "exec" || bin === "nohup" || bin === "time") {
      let idx = 1;
      while (idx < argv.length) {
        const a = argv[idx];
        if (a === "--") {
          idx++;
          break;
        }
        if (bin === "exec" && a === "-a") {
          idx += 2;
          continue;
        }
        if (a.startsWith("-")) {
          idx++;
          continue;
        }
        break;
      }
      argv = argv.slice(idx);
      continue;
    }

    break;
  }

  if (argv.length === 0) {
    return null;
  }

  const bin = basename(argv[0]);
  const rest = argv.slice(1);

  if (bin === "sudo") {
    return deny("running commands with sudo is not allowed");
  }

  if (SHELL_BINARIES.has(bin)) {
    const script = extractShellDashCScript(rest);
    if (script !== null) {
      const nested = checkCommand(script, depth + 1);
      if (nested.decision === "deny") {
        return nested;
      }
    }
    return null;
  }

  if (bin === "git") {
    return checkGit(rest);
  }

  if (bin === "gh") {
    return checkGh(rest);
  }

  return null;
}

export function checkCommand(commandLine: string, depth = 0): GuardDecision {
  if (depth > MAX_RECURSION_DEPTH) {
    return deny("command nesting exceeded guard recursion limit");
  }

  const { commands, embeddedScripts } = parseShellCommands(commandLine);

  for (const argv of commands) {
    const verdict = checkSimpleCommand(argv, depth);
    if (verdict !== null) {
      return verdict;
    }
  }

  for (const script of embeddedScripts) {
    const verdict = checkCommand(script, depth + 1);
    if (verdict.decision === "deny") {
      return verdict;
    }
  }

  return allow();
}

export function evaluateHookInput(rawStdin: string): GuardDecision {
  try {
    const trimmed = rawStdin.trim();
    if (!trimmed) {
      return deny(UNREADABLE_REASON);
    }

    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) {
      return deny(UNREADABLE_REASON);
    }

    const toolCall = (parsed as Record<string, unknown>).toolCall;
    if (typeof toolCall !== "object" || toolCall === null) {
      return deny(UNREADABLE_REASON);
    }

    const args = (toolCall as Record<string, unknown>).args;
    if (typeof args !== "object" || args === null) {
      return deny(UNREADABLE_REASON);
    }

    const commandLine = (args as Record<string, unknown>).CommandLine;
    if (typeof commandLine !== "string") {
      return deny(UNREADABLE_REASON);
    }

    return checkCommand(commandLine);
  } catch {
    return deny(UNREADABLE_REASON);
  }
}

async function main(): Promise<void> {
  try {
    const raw = await Bun.stdin.text();
    const result = evaluateHookInput(raw);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(deny(UNREADABLE_REASON))}\n`);
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
