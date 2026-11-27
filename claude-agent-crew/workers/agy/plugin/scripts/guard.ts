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
  "coproc",
  "nocorrect",
  "noglob",
]);

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
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

const SHELL_NO_ARG_SHORT_FLAGS = new Set([
  "a",
  "b",
  "e",
  "f",
  "h",
  "i",
  "k",
  "l",
  "m",
  "n",
  "p",
  "r",
  "s",
  "t",
  "u",
  "v",
  "x",
  "B",
  "C",
  "E",
  "H",
  "P",
  "T",
]);

const SHELL_NO_ARG_LONG_FLAGS = new Set([
  "--login",
  "--noprofile",
  "--norc",
  "--posix",
  "--restricted",
  "--verbose",
  "--noediting",
  "--help",
  "--version",
  "--debugger",
]);

const SHELL_VALUE_LONG_FLAGS = new Set(["--rcfile", "--init-file"]);

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

export interface HereDocSpec {
  body: string;
  quoted: boolean;
}

export interface ParsedCommand {
  argv: string[];
  argvCmdSub: boolean[];
  pipedIn: boolean;
  hasHereDoc: boolean;
  hasHereString: boolean;
  hereDocs: HereDocSpec[];
  hereStrings: string[];
}

export interface ParsedShell {
  commands: ParsedCommand[];
  embeddedScripts: string[];
  refusalReason: string | null;
}

interface PendingHereDoc {
  targetCmd: ParsedCommand;
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
}

interface CaseFrame {
  baseDepth: number;
  phase: "header" | "pattern" | "body";
  patternParen: boolean;
}

const CASE_CMD_PREFIX_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
]);

function extractBalancedParen(
  input: string,
  contentStartIdx: number,
  allowCaseSyntax: boolean
): { content: string; nextIdx: number; unclosed: boolean } {
  let i = contentStartIdx;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let atCmdStart = true;
  let currentWord = "";
  let wordHadQuote = false;
  let wordAtCmdStart = true;
  const caseStack: CaseFrame[] = [];
  const pendingHereDocs: Array<{ delimiter: string; stripTabs: boolean }> = [];

  const finishWord = () => {
    if (currentWord.length === 0) return;
    if (!wordHadQuote && allowCaseSyntax) {
      const top = caseStack[caseStack.length - 1];
      if (currentWord === "case" && wordAtCmdStart) {
        caseStack.push({ baseDepth: depth, phase: "header", patternParen: false });
        atCmdStart = false;
      } else if (top && top.baseDepth === depth && top.phase === "header" && currentWord === "in") {
        top.phase = "pattern";
        atCmdStart = false;
      } else if (
        top &&
        top.baseDepth === depth &&
        (top.phase === "body" || top.phase === "pattern") &&
        currentWord === "esac"
      ) {
        caseStack.pop();
        atCmdStart = false;
      } else if (wordAtCmdStart && CASE_CMD_PREFIX_KEYWORDS.has(currentWord)) {
        atCmdStart = true;
      } else {
        atCmdStart = false;
      }
    } else {
      atCmdStart = false;
    }
    currentWord = "";
    wordHadQuote = false;
  };

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
        if (input[i + 2] === "(") {
          const arith = parseArithmetic(input, i);
          if (arith.isArithmetic) {
            i = arith.nextIdx;
            continue;
          }
        }
        const nested = extractBalancedParen(input, i + 2, true);
        i = nested.nextIdx;
        continue;
      }
      if (ch === "`") {
        const bt = extractBacktick(input, i);
        i = bt.nextIdx;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      if (currentWord.length === 0) wordAtCmdStart = atCmdStart;
      wordHadQuote = true;
      currentWord += input[i + 1];
      i += 2;
      continue;
    }

    if (ch === "$" && input[i + 1] === "'") {
      if (currentWord.length === 0) wordAtCmdStart = atCmdStart;
      wordHadQuote = true;
      i += 2;
      while (i < input.length && input[i] !== "'") {
        if (input[i] === "\\" && i + 1 < input.length) i += 2;
        else i++;
      }
      if (i < input.length) i++;
      continue;
    }

    if (ch === "$" && input[i + 1] === '"') {
      if (currentWord.length === 0) wordAtCmdStart = atCmdStart;
      wordHadQuote = true;
      inDouble = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      if (currentWord.length === 0) wordAtCmdStart = atCmdStart;
      wordHadQuote = true;
      inSingle = true;
      i++;
      continue;
    }

    if (ch === '"') {
      if (currentWord.length === 0) wordAtCmdStart = atCmdStart;
      wordHadQuote = true;
      inDouble = true;
      i++;
      continue;
    }

    if (ch === "#" && currentWord.length === 0) {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (ch === "$" && input[i + 1] === "(") {
      if (currentWord.length === 0) wordAtCmdStart = atCmdStart;
      wordHadQuote = true;
      if (input[i + 2] === "(") {
        const arith = parseArithmetic(input, i);
        if (arith.isArithmetic) {
          i = arith.nextIdx;
          continue;
        }
      }
      const nested = extractBalancedParen(input, i + 2, true);
      i = nested.nextIdx;
      continue;
    }

    if (ch === "`") {
      if (currentWord.length === 0) wordAtCmdStart = atCmdStart;
      wordHadQuote = true;
      const bt = extractBacktick(input, i);
      i = bt.nextIdx;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      finishWord();
      i++;
      continue;
    }

    if (ch === "\n") {
      finishWord();
      atCmdStart = true;
      i++;
      if (pendingHereDocs.length > 0) {
        for (const h of pendingHereDocs) {
          while (i < input.length) {
            const nlIdx = input.indexOf("\n", i);
            const lineEnd = nlIdx === -1 ? input.length : nlIdx;
            const rawLine = input.slice(i, lineEnd);
            const normalizedLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            const comparable = h.stripTabs ? normalizedLine.replace(/^\t+/, "") : normalizedLine;
            i = nlIdx === -1 ? input.length : nlIdx + 1;
            if (comparable === h.delimiter) {
              break;
            }
          }
        }
        pendingHereDocs.length = 0;
      }
      continue;
    }

    if (ch === "<" && input[i + 1] === "<") {
      if (input[i + 2] === "<") {
        finishWord();
        i += 3;
        continue;
      }
      finishWord();
      const stripTabs = input[i + 2] === "-";
      i += stripTabs ? 3 : 2;
      const delim = scanHereDocDelimiter(input, i);
      if (!delim.delimiter) {
        return {
          content: input.slice(contentStartIdx),
          nextIdx: input.length,
          unclosed: true,
        };
      }
      pendingHereDocs.push({ delimiter: delim.delimiter, stripTabs });
      i = delim.nextIdx;
      continue;
    }

    if (ch === "|" || ch === "&" || ch === "{") {
      finishWord();
      atCmdStart = true;
      i++;
      continue;
    }

    if (ch === ";") {
      finishWord();
      const top = caseStack[caseStack.length - 1];
      if (
        top &&
        top.baseDepth === depth &&
        top.phase === "body" &&
        (input[i + 1] === ";" || input[i + 1] === "&")
      ) {
        top.phase = "pattern";
        top.patternParen = false;
        i += input[i + 1] === ";" && input[i + 2] === "&" ? 3 : 2;
        atCmdStart = true;
        continue;
      }
      atCmdStart = true;
      i++;
      continue;
    }

    if (ch === "(") {
      const hadWord = currentWord.length > 0;
      finishWord();
      const top = caseStack[caseStack.length - 1];
      if (
        allowCaseSyntax &&
        top &&
        top.baseDepth === depth &&
        top.phase === "pattern" &&
        !top.patternParen &&
        !hadWord
      ) {
        top.patternParen = true;
        i++;
        continue;
      }
      depth++;
      atCmdStart = true;
      i++;
      continue;
    }

    if (ch === ")") {
      finishWord();
      const top = caseStack[caseStack.length - 1];
      if (allowCaseSyntax && top && top.baseDepth === depth && top.phase === "pattern") {
        top.phase = "body";
        top.patternParen = false;
        atCmdStart = true;
        i++;
        continue;
      }
      depth--;
      if (depth === 0) {
        return {
          content: input.slice(contentStartIdx, i),
          nextIdx: i + 1,
          unclosed: false,
        };
      }
      atCmdStart = true;
      i++;
      continue;
    }

    if (currentWord.length === 0) wordAtCmdStart = atCmdStart;
    currentWord += ch;
    i++;
  }

  return {
    content: input.slice(contentStartIdx),
    nextIdx: input.length,
    unclosed: depth > 0 || inSingle || inDouble,
  };
}

function extractDollarParen(
  input: string,
  startIdx: number
): { content: string; nextIdx: number; unclosed: boolean } {
  return extractBalancedParen(input, startIdx + 2, true);
}

function extractBacktick(
  input: string,
  startIdx: number
): { content: string; nextIdx: number; ambiguous: boolean } {
  let i = startIdx + 1;
  let content = "";
  let inSingle = false;
  let inDouble = false;
  let ambiguous = false;

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

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else if (ch === "`") {
        ambiguous = true;
      }
      content += ch;
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "`") {
        ambiguous = true;
      }
      content += ch;
      i++;
      continue;
    }

    if (ch === "`") {
      return { content, nextIdx: i + 1, ambiguous };
    }

    if (ch === "'") {
      inSingle = true;
      content += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      content += ch;
      i++;
      continue;
    }

    content += ch;
    i++;
  }

  return { content, nextIdx: input.length, ambiguous: true };
}

type ArithmeticParseResult =
  | { isArithmetic: true; hasCmdSub: boolean; nextIdx: number }
  | { isArithmetic: false };

function parseArithmetic(input: string, startIdx: number): ArithmeticParseResult {
  if (!input.startsWith("$((", startIdx)) {
    return { isArithmetic: false };
  }
  let k = startIdx + 3;
  let parenDepth = 0;
  let hasCmdSub = false;

  while (k < input.length) {
    const ch = input[k];
    if (ch === "\\" && k + 1 < input.length) {
      k += 2;
      continue;
    }
    if (ch === "'") {
      k++;
      while (k < input.length && input[k] !== "'") k++;
      if (k < input.length) k++;
      continue;
    }
    if (ch === '"') {
      k++;
      while (k < input.length && input[k] !== '"') {
        if (input[k] === "\\" && k + 1 < input.length) {
          k += 2;
          continue;
        }
        if (input[k] === "$" && input[k + 1] === "(") {
          if (input[k + 2] === "(") {
            const inner = parseArithmetic(input, k);
            if (inner.isArithmetic) {
              if (inner.hasCmdSub) hasCmdSub = true;
              k = inner.nextIdx;
              continue;
            }
          }
          hasCmdSub = true;
          const nested = extractDollarParen(input, k);
          k = nested.nextIdx;
          continue;
        }
        if (input[k] === "`") {
          hasCmdSub = true;
          const bt = extractBacktick(input, k);
          k = bt.nextIdx;
          continue;
        }
        k++;
      }
      if (k < input.length) k++;
      continue;
    }
    if (ch === "$" && input[k + 1] === "(") {
      if (input[k + 2] === "(") {
        const inner = parseArithmetic(input, k);
        if (inner.isArithmetic) {
          if (inner.hasCmdSub) hasCmdSub = true;
          k = inner.nextIdx;
          continue;
        }
      }
      hasCmdSub = true;
      const nested = extractDollarParen(input, k);
      k = nested.nextIdx;
      continue;
    }
    if (ch === "`") {
      hasCmdSub = true;
      const bt = extractBacktick(input, k);
      k = bt.nextIdx;
      continue;
    }
    if (ch === "(") {
      parenDepth++;
      k++;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) {
        parenDepth--;
        k++;
        continue;
      }
      if (input[k + 1] === ")") {
        return { isArithmetic: true, hasCmdSub, nextIdx: k + 2 };
      }
      return { isArithmetic: false };
    }
    k++;
  }

  return { isArithmetic: false };
}

function parseLegacyBracketArithmetic(
  input: string,
  startIdx: number
): { hasCmdSub: boolean; nextIdx: number } {
  let k = startIdx + 2;
  let depth = 1;
  let hasCmdSub = false;

  while (k < input.length && depth > 0) {
    const ch = input[k];
    if (ch === "\\" && k + 1 < input.length) {
      k += 2;
      continue;
    }
    if (ch === "'") {
      k++;
      while (k < input.length && input[k] !== "'") k++;
      if (k < input.length) k++;
      continue;
    }
    if (ch === '"') {
      k++;
      while (k < input.length && input[k] !== '"') {
        if (input[k] === "\\" && k + 1 < input.length) {
          k += 2;
          continue;
        }
        if (input[k] === "$" && input[k + 1] === "(") hasCmdSub = true;
        if (input[k] === "`") hasCmdSub = true;
        k++;
      }
      if (k < input.length) k++;
      continue;
    }
    if (ch === "$" && input[k + 1] === "(") {
      if (input[k + 2] === "(") {
        const inner = parseArithmetic(input, k);
        if (inner.isArithmetic) {
          if (inner.hasCmdSub) hasCmdSub = true;
          k = inner.nextIdx;
          continue;
        }
      }
      hasCmdSub = true;
      const nested = extractDollarParen(input, k);
      k = nested.nextIdx;
      continue;
    }
    if (ch === "`") {
      hasCmdSub = true;
      const bt = extractBacktick(input, k);
      k = bt.nextIdx;
      continue;
    }
    if (ch === "[") {
      depth++;
      k++;
      continue;
    }
    if (ch === "]") {
      depth--;
      k++;
      continue;
    }
    k++;
  }

  return { hasCmdSub, nextIdx: k };
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
    ch === ")" ||
    ch === "<" ||
    ch === ">"
  );
}

interface RedirectTargetResult {
  nextIdx: number;
  text: string;
  hasCmdSub: boolean;
  hasAnsiOrLocaleQuote: boolean;
  hasUnclosedQuote: boolean;
}

function scanRedirectTarget(input: string, startIdx: number): RedirectTargetResult {
  let i = startIdx;
  while (i < input.length && (input[i] === " " || input[i] === "\t")) {
    i++;
  }
  let text = "";
  let hasCmdSub = false;
  let hasAnsiOrLocaleQuote = false;
  let hasUnclosedQuote = false;

  while (i < input.length && !isSeparatorStart(input, i)) {
    const ch = input[i];
    if (ch === "$" && (input[i + 1] === "'" || input[i + 1] === '"')) {
      hasAnsiOrLocaleQuote = true;
      const quote = input[i + 1];
      i += 2;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          text += input[i + 1];
          i += 2;
        } else {
          text += input[i];
          i++;
        }
      }
      if (i < input.length) i++;
      else hasUnclosedQuote = true;
    } else if (ch === "'") {
      i++;
      while (i < input.length && input[i] !== "'") {
        text += input[i];
        i++;
      }
      if (i < input.length) i++;
      else hasUnclosedQuote = true;
    } else if (ch === '"') {
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
            text += next;
            i += 2;
            continue;
          }
          text += inner;
          i++;
          continue;
        }
        if (inner === "$" && input[i + 1] === "(") {
          if (input[i + 2] === "(") {
            const arith = parseArithmetic(input, i);
            if (arith.isArithmetic) {
              if (arith.hasCmdSub) hasCmdSub = true;
              text += input.slice(i, arith.nextIdx);
              i = arith.nextIdx;
              continue;
            }
          }
          hasCmdSub = true;
          const nested = extractDollarParen(input, i);
          text += input.slice(i, nested.nextIdx);
          i = nested.nextIdx;
          continue;
        }
        if (inner === "`") {
          hasCmdSub = true;
          const bt = extractBacktick(input, i);
          text += input.slice(i, bt.nextIdx);
          i = bt.nextIdx;
          continue;
        }
        text += inner;
        i++;
      }
      if (i < input.length) i++;
      else hasUnclosedQuote = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      text += input[i + 1];
      i += 2;
    } else if (ch === "$" && input[i + 1] === "(") {
      if (input[i + 2] === "(") {
        const arith = parseArithmetic(input, i);
        if (arith.isArithmetic) {
          if (arith.hasCmdSub) hasCmdSub = true;
          text += input.slice(i, arith.nextIdx);
          i = arith.nextIdx;
          continue;
        }
      }
      hasCmdSub = true;
      const nested = extractDollarParen(input, i);
      text += input.slice(i, nested.nextIdx);
      i = nested.nextIdx;
    } else if (ch === "$" && input[i + 1] === "[") {
      const bracket = parseLegacyBracketArithmetic(input, i);
      if (bracket.hasCmdSub) hasCmdSub = true;
      text += input.slice(i, bracket.nextIdx);
      i = bracket.nextIdx;
    } else if (ch === "`") {
      hasCmdSub = true;
      const bt = extractBacktick(input, i);
      text += input.slice(i, bt.nextIdx);
      i = bt.nextIdx;
    } else {
      text += ch;
      i++;
    }
  }

  return { nextIdx: i, text, hasCmdSub, hasAnsiOrLocaleQuote, hasUnclosedQuote };
}

function scanHereDocDelimiter(
  input: string,
  startIdx: number
): { delimiter: string; quoted: boolean; nextIdx: number } {
  let i = startIdx;
  while (i < input.length && (input[i] === " " || input[i] === "\t")) {
    i++;
  }
  let delimiter = "";
  let quoted = false;

  while (i < input.length && !isSeparatorStart(input, i)) {
    const ch = input[i];
    if (ch === "'" || ch === '"') {
      quoted = true;
      const quote = ch;
      i++;
      while (i < input.length && input[i] !== quote) {
        if (quote === '"' && input[i] === "\\" && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            delimiter += next;
            i += 2;
            continue;
          }
        }
        delimiter += input[i];
        i++;
      }
      if (i >= input.length) {
        return { delimiter: "", quoted, nextIdx: i };
      }
      i++;
    } else if (ch === "\\" && i + 1 < input.length) {
      quoted = true;
      delimiter += input[i + 1];
      i += 2;
    } else {
      delimiter += ch;
      i++;
    }
  }

  return { delimiter, quoted, nextIdx: i };
}

function scanUnquotedHereDocBody(
  body: string,
  embeddedScripts: string[]
): string | null {
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      i += 2;
      continue;
    }
    if (ch === "$" && body[i + 1] === "(") {
      if (body[i + 2] === "(") {
        const arith = parseArithmetic(body, i);
        if (arith.isArithmetic) {
          if (arith.hasCmdSub) {
            return "command substitution inside arithmetic expansion is not allowed";
          }
          i = arith.nextIdx;
          continue;
        }
      }
      const { content, nextIdx, unclosed } = extractDollarParen(body, i);
      embeddedScripts.push(content);
      if (unclosed) {
        return UNREADABLE_REASON;
      }
      i = nextIdx;
      continue;
    }
    if (ch === "$" && body[i + 1] === "[") {
      const bracket = parseLegacyBracketArithmetic(body, i);
      if (bracket.hasCmdSub) {
        return "command substitution inside arithmetic expansion is not allowed";
      }
      i = bracket.nextIdx;
      continue;
    }
    if (ch === "`") {
      const { content, nextIdx, ambiguous } = extractBacktick(body, i);
      embeddedScripts.push(content);
      if (ambiguous) {
        return "ambiguous backtick quoting is not allowed";
      }
      i = nextIdx;
      continue;
    }
    i++;
  }
  return null;
}

function makeEmptyCommand(pipedIn: boolean): ParsedCommand {
  return {
    argv: [],
    argvCmdSub: [],
    pipedIn,
    hasHereDoc: false,
    hasHereString: false,
    hereDocs: [],
    hereStrings: [],
  };
}

export function parseShellCommands(input: string): ParsedShell {
  const commands: ParsedCommand[] = [];
  const embeddedScripts: string[] = [];
  let refusalReason: string | null = null;

  const setRefusal = (reason: string) => {
    if (refusalReason === null) {
      refusalReason = reason;
    }
  };

  let nextCommandPipedIn = false;
  let currentCmd: ParsedCommand = makeEmptyCommand(false);
  let currentToken = "";
  let currentTokenCmdSub = false;
  let hasToken = false;
  const pendingHereDocs: PendingHereDoc[] = [];

  const flushToken = () => {
    if (hasToken) {
      currentCmd.argv.push(currentToken);
      currentCmd.argvCmdSub.push(currentTokenCmdSub);
      currentToken = "";
      currentTokenCmdSub = false;
      hasToken = false;
    }
  };

  const hasCmdContent = () =>
    currentCmd.argv.length > 0 || currentCmd.hasHereDoc || currentCmd.hasHereString;

  const flushCmd = (nextPipedIn: boolean) => {
    flushToken();
    if (hasCmdContent()) {
      commands.push(currentCmd);
      currentCmd = makeEmptyCommand(nextPipedIn);
    } else {
      currentCmd.pipedIn = nextPipedIn;
    }
    nextCommandPipedIn = nextPipedIn;
  };

  const consumePendingHereDocs = (startAfterNewline: number): number => {
    let idx = startAfterNewline;
    for (const h of pendingHereDocs) {
      let body = "";
      while (idx < input.length) {
        const nlIdx = input.indexOf("\n", idx);
        const lineEnd = nlIdx === -1 ? input.length : nlIdx;
        const rawLine = input.slice(idx, lineEnd);
        const normalizedLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const comparable = h.stripTabs ? normalizedLine.replace(/^\t+/, "") : normalizedLine;
        idx = nlIdx === -1 ? input.length : nlIdx + 1;
        if (comparable === h.delimiter) {
          break;
        }
        body += rawLine + (nlIdx === -1 ? "" : "\n");
      }
      h.targetCmd.hereDocs.push({ body, quoted: h.quoted });
      if (!h.quoted) {
        const err = scanUnquotedHereDocBody(body, embeddedScripts);
        if (err !== null) {
          setRefusal(err);
        }
      }
    }
    pendingHereDocs.length = 0;
    return idx;
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

    if (ch === "\n") {
      const keepPipe = nextCommandPipedIn && !hasToken && !hasCmdContent();
      flushCmd(keepPipe);
      i++;
      if (pendingHereDocs.length > 0) {
        i = consumePendingHereDocs(i);
      }
      continue;
    }

    if (ch === ";") {
      flushCmd(false);
      i++;
      continue;
    }

    if (
      (ch === "&" && input[i + 1] === "&") ||
      (ch === "|" && input[i + 1] === "|")
    ) {
      flushCmd(false);
      i += 2;
      continue;
    }

    if (ch === "|" && input[i + 1] === "&") {
      flushCmd(true);
      i += 2;
      continue;
    }

    if (ch === "|") {
      flushCmd(true);
      i++;
      continue;
    }

    if (ch === "&" && input[i + 1] === ">") {
      flushToken();
      i += input[i + 2] === ">" ? 3 : 2;
      const redir = scanRedirectTarget(input, i);
      if (redir.hasCmdSub) setRefusal("command substitution in redirect target is not allowed");
      if (redir.hasAnsiOrLocaleQuote) {
        setRefusal("ANSI-C ($'...') and locale ($\"...\") quoting are not allowed");
      }
      if (redir.hasUnclosedQuote) {
        setRefusal(UNREADABLE_REASON);
      }
      i = redir.nextIdx;
      continue;
    }

    if (ch === "&" || ch === ")") {
      flushCmd(false);
      i++;
      continue;
    }

    if (ch === "(") {
      const keepPipe = nextCommandPipedIn && !hasToken && !hasCmdContent();
      flushCmd(keepPipe);
      i++;
      continue;
    }

    if ((ch === "{" || ch === "}") && !hasToken && isSeparatorStart(input, i + 1)) {
      const keepPipe = ch === "{" && nextCommandPipedIn && !hasCmdContent();
      flushCmd(keepPipe);
      i++;
      continue;
    }

    if ((ch === "<" || ch === ">") && input[i + 1] === "(") {
      if (hasToken) {
        flushToken();
      }
      hasToken = true;
      const { content, nextIdx, unclosed } = extractBalancedParen(input, i + 2, true);
      embeddedScripts.push(content);
      if (unclosed) {
        setRefusal(UNREADABLE_REASON);
      }
      currentToken += input.slice(i, nextIdx);
      i = nextIdx;
      continue;
    }

    if (ch === "<" || ch === ">" || !hasToken) {
      const slice = input.slice(i);
      const redirMatch = hasToken
        ? slice.match(/^()(<<<|<<-|<<|>>|>&|<&|<>|\>\||>|<)/)
        : slice.match(/^(\d*)(<<<|<<-|<<|>>|>&|<&|<>|\>\||>|<)/);
      if (redirMatch) {
        const op = redirMatch[2];
        flushToken();
        i += redirMatch[0].length;
        if (op === "<<<") {
          currentCmd.hasHereString = true;
          const target = scanRedirectTarget(input, i);
          if (target.hasCmdSub) {
            setRefusal("command substitution in redirect target is not allowed");
          }
          if (target.hasAnsiOrLocaleQuote) {
            setRefusal("ANSI-C ($'...') and locale ($\"...\") quoting are not allowed");
          }
          if (target.hasUnclosedQuote) {
            setRefusal(UNREADABLE_REASON);
          }
          currentCmd.hereStrings.push(target.text);
          i = target.nextIdx;
        } else if (op === "<<" || op === "<<-") {
          currentCmd.hasHereDoc = true;
          const delim = scanHereDocDelimiter(input, i);
          if (!delim.delimiter) {
            setRefusal(UNREADABLE_REASON);
          } else {
            pendingHereDocs.push({
              targetCmd: currentCmd,
              delimiter: delim.delimiter,
              stripTabs: op === "<<-",
              quoted: delim.quoted,
            });
          }
          i = delim.nextIdx;
        } else {
          const target = scanRedirectTarget(input, i);
          if (target.hasCmdSub) {
            setRefusal("command substitution in redirect target is not allowed");
          }
          if (target.hasAnsiOrLocaleQuote) {
            setRefusal("ANSI-C ($'...') and locale ($\"...\") quoting are not allowed");
          }
          if (target.hasUnclosedQuote) {
            setRefusal(UNREADABLE_REASON);
          }
          i = target.nextIdx;
        }
        continue;
      }
    }

    if (ch === "$" && input[i + 1] === "'") {
      setRefusal("ANSI-C ($'...') quoting is not allowed");
      hasToken = true;
      i += 2;
      while (i < input.length && input[i] !== "'") {
        if (input[i] === "\\" && i + 1 < input.length) {
          currentToken += input[i + 1];
          i += 2;
        } else {
          currentToken += input[i];
          i++;
        }
      }
      if (i < input.length) i++;
      continue;
    }

    if (ch === "$" && input[i + 1] === '"') {
      setRefusal('locale ($"...") quoting is not allowed');
      hasToken = true;
      i += 2;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          currentToken += input[i + 1];
          i += 2;
        } else {
          currentToken += input[i];
          i++;
        }
      }
      if (i < input.length) i++;
      continue;
    }

    if (ch === "'") {
      hasToken = true;
      i++;
      while (i < input.length && input[i] !== "'") {
        currentToken += input[i];
        i++;
      }
      if (i < input.length && input[i] === "'") {
        i++;
      } else {
        setRefusal(UNREADABLE_REASON);
      }
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
          if (input[i + 2] === "(") {
            const arith = parseArithmetic(input, i);
            if (arith.isArithmetic) {
              if (arith.hasCmdSub) {
                setRefusal("command substitution inside arithmetic expansion is not allowed");
                currentTokenCmdSub = true;
              }
              currentToken += input.slice(i, arith.nextIdx);
              i = arith.nextIdx;
              continue;
            }
          }
          currentTokenCmdSub = true;
          const { content, nextIdx, unclosed } = extractDollarParen(input, i);
          embeddedScripts.push(content);
          if (unclosed) {
            setRefusal(UNREADABLE_REASON);
          }
          currentToken += input.slice(i, nextIdx);
          i = nextIdx;
          continue;
        }
        if (inner === "$" && input[i + 1] === "[") {
          const bracket = parseLegacyBracketArithmetic(input, i);
          if (bracket.hasCmdSub) {
            setRefusal("command substitution inside arithmetic expansion is not allowed");
            currentTokenCmdSub = true;
          }
          currentToken += input.slice(i, bracket.nextIdx);
          i = bracket.nextIdx;
          continue;
        }
        if (inner === "`") {
          currentTokenCmdSub = true;
          const { content, nextIdx, ambiguous } = extractBacktick(input, i);
          embeddedScripts.push(content);
          if (ambiguous) {
            setRefusal("ambiguous backtick quoting is not allowed");
          }
          currentToken += input.slice(i, nextIdx);
          i = nextIdx;
          continue;
        }
        currentToken += inner;
        i++;
      }
      if (i < input.length && input[i] === '"') {
        i++;
      } else {
        setRefusal(UNREADABLE_REASON);
      }
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
      if (input[i + 2] === "(") {
        const arith = parseArithmetic(input, i);
        if (arith.isArithmetic) {
          if (arith.hasCmdSub) {
            setRefusal("command substitution inside arithmetic expansion is not allowed");
            currentTokenCmdSub = true;
          }
          currentToken += input.slice(i, arith.nextIdx);
          i = arith.nextIdx;
          continue;
        }
      }
      currentTokenCmdSub = true;
      const { content, nextIdx, unclosed } = extractDollarParen(input, i);
      embeddedScripts.push(content);
      if (unclosed) {
        setRefusal(UNREADABLE_REASON);
      }
      currentToken += input.slice(i, nextIdx);
      i = nextIdx;
      continue;
    }

    if (ch === "$" && input[i + 1] === "[") {
      hasToken = true;
      const bracket = parseLegacyBracketArithmetic(input, i);
      if (bracket.hasCmdSub) {
        setRefusal("command substitution inside arithmetic expansion is not allowed");
        currentTokenCmdSub = true;
      }
      currentToken += input.slice(i, bracket.nextIdx);
      i = bracket.nextIdx;
      continue;
    }

    if (ch === "`") {
      hasToken = true;
      currentTokenCmdSub = true;
      const { content, nextIdx, ambiguous } = extractBacktick(input, i);
      embeddedScripts.push(content);
      if (ambiguous) {
        setRefusal("ambiguous backtick quoting is not allowed");
      }
      currentToken += input.slice(i, nextIdx);
      i = nextIdx;
      continue;
    }

    hasToken = true;
    currentToken += ch;
    i++;
  }

  flushCmd(false);
  if (pendingHereDocs.length > 0) {
    consumePendingHereDocs(input.length);
  }
  return { commands, embeddedScripts, refusalReason };
}

function isProtectedBranch(ref: string): boolean {
  const normalized = ref.replace(/^refs\/heads\//, "");
  return normalized === "main" || normalized === "master";
}

function isMainOrRemoteMainRef(ref: string): boolean {
  const baseRef = ref.replace(/[~^@:].*$/, "");
  const normalized = baseRef.replace(/^refs\/(heads|remotes\/[^/]+)\//, "");
  if (normalized === "main" || normalized === "master") return true;
  return /^(origin|upstream)\/(main|master)$/.test(baseRef);
}

function checkGitConfigEntry(
  entry: string | undefined,
  hasCmdSub = false
): GuardDecision | null {
  if (entry === undefined) return null;
  if (hasCmdSub) {
    return deny("command substitution in git -c/--config-env entry is not allowed");
  }
  const eqIdx = entry.indexOf("=");
  const key = (eqIdx === -1 ? entry : entry.slice(0, eqIdx)).trim();
  if (/^alias\./i.test(key)) {
    return deny("configuring git aliases via -c is not allowed");
  }
  if (/^remote\..+\.push$/i.test(key)) {
    return deny("configuring remote.<name>.push via -c is not allowed");
  }
  if (/^remote\..+\.mirror$/i.test(key)) {
    return deny("configuring remote.<name>.mirror via -c is not allowed");
  }
  if (/^core\.hooksPath$/i.test(key)) {
    return deny("overriding core.hooksPath via -c is not allowed");
  }
  return null;
}

function checkGitPush(pushArgs: string[], pushCmdSub: boolean[]): GuardDecision | null {
  const positionals: Array<{ value: string; hasCmdSub: boolean }> = [];
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

      if (arg === "--all" || arg === "--branches" || arg === "--mirror") {
        return deny(`git push ${arg} is not allowed because it targets protected branches`);
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
        const flags = arg.slice(1);
        for (let k = 0; k < flags.length; k++) {
          const flag = flags[k];
          if (flag === "o") {
            if (k + 1 === flags.length) j++;
            break;
          }
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

    positionals.push({ value: arg, hasCmdSub: pushCmdSub[j] ?? false });
  }

  const refspecs = hasRepoFlag ? positionals : positionals.slice(1);

  for (const { value: spec, hasCmdSub } of refspecs) {
    if (hasCmdSub) {
      return deny("command substitution in git push refspec is not allowed");
    }

    if (spec.startsWith("+")) {
      return deny(`force-pushing with +refspec (${spec}) is not allowed`);
    }

    if (spec.includes("*")) {
      return deny(`wildcard refspec (${spec}) in git push is not allowed`);
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

function checkGitReset(resetArgs: string[], resetCmdSub: boolean[]): GuardDecision | null {
  let hasHard = false;
  const positionals: Array<{ value: string; hasCmdSub: boolean }> = [];
  let afterDoubleDash = false;

  for (let j = 0; j < resetArgs.length; j++) {
    const arg = resetArgs[j];
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
    positionals.push({ value: arg, hasCmdSub: resetCmdSub[j] ?? false });
  }

  if (hasHard) {
    if (positionals.some((ref) => ref.hasCmdSub)) {
      return deny("command substitution in git reset --hard target is not allowed");
    }
    if (positionals.some((ref) => isMainOrRemoteMainRef(ref.value))) {
      return deny("hard-resetting to main/master is not allowed");
    }
  }

  return null;
}

const GIT_BRANCH_VALUE_FLAGS = new Set([
  "-u",
  "--set-upstream-to",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--sort",
  "--points-at",
  "--format",
]);

function checkGitBranch(branchArgs: string[], branchCmdSub: boolean[]): GuardDecision | null {
  let hasDelete = false;
  let hasForce = false;
  let hasMove = false;
  let hasCopy = false;
  const positionals: Array<{ value: string; hasCmdSub: boolean }> = [];
  let afterDoubleDash = false;

  for (let j = 0; j < branchArgs.length; j++) {
    const arg = branchArgs[j];
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (arg === "--delete") {
        hasDelete = true;
        continue;
      }
      if (arg === "--force") {
        hasForce = true;
        continue;
      }
      if (arg === "--move") {
        hasMove = true;
        continue;
      }
      if (arg === "--copy") {
        hasCopy = true;
        continue;
      }
      if (GIT_BRANCH_VALUE_FLAGS.has(arg)) {
        j++;
        continue;
      }
      if (arg.startsWith("--")) {
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        const flags = arg.slice(1);
        for (let k = 0; k < flags.length; k++) {
          const ch = flags[k];
          if (ch === "d" || ch === "D") hasDelete = true;
          else if (ch === "f") hasForce = true;
          else if (ch === "m") hasMove = true;
          else if (ch === "M") {
            hasMove = true;
            hasForce = true;
          } else if (ch === "c") hasCopy = true;
          else if (ch === "C") {
            hasCopy = true;
            hasForce = true;
          } else if (ch === "u") {
            if (k + 1 === flags.length) j++;
            break;
          }
        }
        continue;
      }
    }
    positionals.push({ value: arg, hasCmdSub: branchCmdSub[j] ?? false });
  }

  if (hasDelete) {
    if (positionals.some((ref) => ref.hasCmdSub)) {
      return deny("command substitution in git branch delete target is not allowed");
    }
    if (positionals.some((ref) => isProtectedBranch(ref.value))) {
      return deny("deleting protected branch main/master is not allowed");
    }
  }

  if (hasMove) {
    if (positionals.some((ref) => ref.hasCmdSub)) {
      return deny("command substitution in git branch move target is not allowed");
    }
    if (positionals.some((ref) => isProtectedBranch(ref.value))) {
      return deny("moving or overwriting protected branch main/master is not allowed");
    }
  }

  if (hasCopy && hasForce) {
    const target = positionals.length >= 2 ? positionals[1] : positionals[0];
    if (target !== undefined) {
      if (target.hasCmdSub) {
        return deny("command substitution in git branch -C target is not allowed");
      }
      if (isProtectedBranch(target.value)) {
        return deny("overwriting protected branch main/master via git branch -C is not allowed");
      }
    }
  }

  if (hasForce && !hasDelete && !hasMove && !hasCopy) {
    const target = positionals[0];
    if (target !== undefined) {
      if (target.hasCmdSub) {
        return deny("command substitution in git branch -f target is not allowed");
      }
      if (isProtectedBranch(target.value)) {
        return deny("force-updating protected branch main/master is not allowed");
      }
    }
  }

  return null;
}

const GIT_CHECKOUT_SWITCH_VALUE_FLAGS = new Set([
  "-b",
  "-c",
  "--create",
  "--orphan",
  "--conflict",
  "-U",
  "--unified",
  "--inter-hunk-context",
  "--pathspec-from-file",
]);

function checkGitCheckoutOrSwitch(
  subcommand: "checkout" | "switch",
  subArgs: string[],
  subCmdSub: boolean[]
): GuardDecision | null {
  let hasForceCreate = false;
  let forceCreateTarget: { value: string; hasCmdSub: boolean } | null = null;
  let awaitingTarget = false;
  const positionals: Array<{ value: string; hasCmdSub: boolean }> = [];
  let afterDoubleDash = false;

  for (let j = 0; j < subArgs.length; j++) {
    const arg = subArgs[j];
    const hasCmdSub = subCmdSub[j] ?? false;
    if (awaitingTarget && arg !== "--") {
      forceCreateTarget = { value: arg, hasCmdSub };
      awaitingTarget = false;
      positionals.push({ value: arg, hasCmdSub });
      continue;
    }

    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (subcommand === "switch" && arg === "--force-create") {
        hasForceCreate = true;
        awaitingTarget = true;
        continue;
      }
      if (subcommand === "switch" && arg.startsWith("--force-create=")) {
        hasForceCreate = true;
        forceCreateTarget = { value: arg.slice("--force-create=".length), hasCmdSub };
        continue;
      }
      if (GIT_CHECKOUT_SWITCH_VALUE_FLAGS.has(arg)) {
        j++;
        continue;
      }
      if (arg.startsWith("--")) {
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        const forceLetter = subcommand === "checkout" ? "B" : "C";
        const createLetter = subcommand === "checkout" ? "b" : "c";
        const flags = arg.slice(1);
        for (let k = 0; k < flags.length; k++) {
          const ch = flags[k];
          if (ch === forceLetter) {
            hasForceCreate = true;
            const attached = flags.slice(k + 1);
            if (attached.length > 0) {
              forceCreateTarget = { value: attached, hasCmdSub };
            } else {
              awaitingTarget = true;
            }
            break;
          }
          if (ch === createLetter) {
            if (k + 1 === flags.length) j++;
            break;
          }
        }
        continue;
      }
    }

    positionals.push({ value: arg, hasCmdSub });
    if (awaitingTarget) {
      forceCreateTarget = { value: arg, hasCmdSub };
      awaitingTarget = false;
    }
  }

  if (hasForceCreate) {
    const target = forceCreateTarget ?? positionals[0];
    if (target !== undefined) {
      if (target.hasCmdSub) {
        return deny(`command substitution in git ${subcommand} target is not allowed`);
      }
      if (isProtectedBranch(target.value)) {
        return deny("force-resetting protected branch main/master is not allowed");
      }
    }
  }

  return null;
}

const GIT_REBASE_VALUE_FLAGS = new Set([
  "--onto",
  "-C",
  "--whitespace",
  "--empty",
  "-x",
  "--exec",
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
]);

function checkGitRebase(
  rebaseArgs: string[],
  rebaseCmdSub: boolean[],
  depth: number
): GuardDecision | null {
  let hasRoot = false;
  const positionals: Array<{ value: string; hasCmdSub: boolean }> = [];
  let afterDoubleDash = false;

  for (let j = 0; j < rebaseArgs.length; j++) {
    const arg = rebaseArgs[j];
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (arg === "--root") {
        hasRoot = true;
        continue;
      }
      if (arg === "-x" || arg === "--exec") {
        const execCmd = rebaseArgs[j + 1];
        if (execCmd !== undefined) {
          const nested = checkCommand(execCmd, depth + 1);
          if (nested.decision === "deny") return nested;
        }
        j++;
        continue;
      }
      if (arg.startsWith("--exec=")) {
        const nested = checkCommand(arg.slice("--exec=".length), depth + 1);
        if (nested.decision === "deny") return nested;
        continue;
      }
      if (GIT_REBASE_VALUE_FLAGS.has(arg)) {
        j++;
        continue;
      }
      if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
        const flags = arg.slice(1);
        for (let k = 0; k < flags.length; k++) {
          const f = flags[k];
          if (f === "x") {
            const attached = flags.slice(k + 1);
            const execCmd = attached.length > 0 ? attached : rebaseArgs[++j];
            if (execCmd !== undefined) {
              const nested = checkCommand(execCmd, depth + 1);
              if (nested.decision === "deny") return nested;
            }
            break;
          }
          if (f === "C" || f === "s" || f === "X") {
            if (k + 1 === flags.length) j++;
            break;
          }
        }
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
    }
    positionals.push({ value: arg, hasCmdSub: rebaseCmdSub[j] ?? false });
  }

  const targetBranch = hasRoot ? positionals[0] : positionals[1];
  if (targetBranch !== undefined) {
    if (targetBranch.hasCmdSub) {
      return deny("command substitution in git rebase target is not allowed");
    }
    if (isProtectedBranch(targetBranch.value)) {
      return deny("rebasing protected branch main/master is not allowed");
    }
  }

  return null;
}

const GIT_FILTER_BRANCH_COMMAND_FLAGS = new Set([
  "--env-filter",
  "--tree-filter",
  "--index-filter",
  "--parent-filter",
  "--msg-filter",
  "--commit-filter",
  "--tag-name-filter",
]);

const GIT_FILTER_BRANCH_VALUE_FLAGS = new Set([
  "--env-filter",
  "--tree-filter",
  "--index-filter",
  "--parent-filter",
  "--msg-filter",
  "--commit-filter",
  "--tag-name-filter",
  "--subdirectory-filter",
  "-d",
  "--state-branch",
  "--original",
]);

function checkGitFilterBranch(
  filterArgs: string[],
  filterCmdSub: boolean[],
  depth: number
): GuardDecision | null {
  let afterDoubleDash = false;
  const revs: Array<{ value: string; hasCmdSub: boolean }> = [];

  for (let j = 0; j < filterArgs.length; j++) {
    const arg = filterArgs[j];
    const hasCmdSub = filterCmdSub[j] ?? false;
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (GIT_FILTER_BRANCH_VALUE_FLAGS.has(arg)) {
        const val = filterArgs[j + 1];
        if (val !== undefined && GIT_FILTER_BRANCH_COMMAND_FLAGS.has(arg)) {
          const nested = checkCommand(val, depth + 1);
          if (nested.decision === "deny") return nested;
        }
        j++;
        continue;
      }
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1 && GIT_FILTER_BRANCH_COMMAND_FLAGS.has(arg.slice(0, eqIdx))) {
        const nested = checkCommand(arg.slice(eqIdx + 1), depth + 1);
        if (nested.decision === "deny") return nested;
        continue;
      }
      if (arg.startsWith("-")) {
        if (arg === "--all" || arg === "--branches" || arg.startsWith("--branches=")) {
          revs.push({ value: arg, hasCmdSub });
        }
        continue;
      }
    }
    revs.push({ value: arg, hasCmdSub });
  }

  for (const { value: rev, hasCmdSub } of revs) {
    if (hasCmdSub) {
      return deny("command substitution in git filter-branch revision is not allowed");
    }
    if (rev.startsWith("--branches=")) {
      const pattern = rev.slice("--branches=".length);
      if (pattern === "" || /[*?[]/.test(pattern) || isProtectedBranch(pattern)) {
        return deny("rewriting protected branch main/master with git filter-branch is not allowed");
      }
      continue;
    }
    if (
      rev === "--all" ||
      rev === "--branches" ||
      isProtectedBranch(rev) ||
      /\.\.+(?:refs\/heads\/)?(main|master)$/.test(rev)
    ) {
      return deny("rewriting protected branch main/master with git filter-branch is not allowed");
    }
  }

  return null;
}

function checkGitUpdateRef(
  updateArgs: string[],
  updateCmdSub: boolean[],
  cmd: ParsedCommand
): GuardDecision | null {
  const positionals: Array<{ value: string; hasCmdSub: boolean }> = [];
  let afterDoubleDash = false;

  for (let j = 0; j < updateArgs.length; j++) {
    const arg = updateArgs[j];
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (arg === "--stdin") {
        return deny("updating refs via git update-ref --stdin is not allowed");
      }
      if (arg === "-m") {
        j++;
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
    }
    positionals.push({ value: arg, hasCmdSub: updateCmdSub[j] ?? false });
  }

  if (cmd.pipedIn && updateArgs.length === 0) {
    return deny("updating refs via piped git update-ref is not allowed");
  }

  if (positionals.some((p) => p.hasCmdSub)) {
    return deny("command substitution in git update-ref target is not allowed");
  }

  const targetRef = positionals[0]?.value;
  if (
    targetRef !== undefined &&
    (targetRef === "refs/heads/main" ||
      targetRef === "refs/heads/master" ||
      targetRef === "main" ||
      targetRef === "master")
  ) {
    return deny("updating refs/heads/main or refs/heads/master directly is not allowed");
  }

  if (updateArgs.some((arg) => arg === "refs/heads/main" || arg === "refs/heads/master")) {
    return deny("updating refs/heads/main or refs/heads/master directly is not allowed");
  }

  return null;
}

function checkGit(
  args: string[],
  cmdSub: boolean[],
  cmd: ParsedCommand,
  depth: number
): GuardDecision | null {
  let i = 0;
  let subcommand: string | null = null;
  let subcommandCmdSub = false;

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-c") {
      const verdict = checkGitConfigEntry(args[i + 1], cmdSub[i + 1] ?? false);
      if (verdict !== null) return verdict;
      i += 2;
      continue;
    }
    if (arg.startsWith("-c") && arg.length > 2) {
      const verdict = checkGitConfigEntry(arg.slice(2), cmdSub[i] ?? false);
      if (verdict !== null) return verdict;
      i++;
      continue;
    }
    if (arg === "--config-env") {
      const verdict = checkGitConfigEntry(args[i + 1], cmdSub[i + 1] ?? false);
      if (verdict !== null) return verdict;
      i += 2;
      continue;
    }
    if (arg.startsWith("--config-env=")) {
      const verdict = checkGitConfigEntry(
        arg.slice("--config-env=".length),
        cmdSub[i] ?? false
      );
      if (verdict !== null) return verdict;
      i++;
      continue;
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
    subcommandCmdSub = cmdSub[i] ?? false;
    i++;
    break;
  }

  if (subcommandCmdSub) {
    return deny("command substitution in git subcommand is not allowed");
  }

  const rest = args.slice(i);
  const restCmdSub = cmdSub.slice(i);
  if (subcommand === "push") return checkGitPush(rest, restCmdSub);
  if (subcommand === "reset") return checkGitReset(rest, restCmdSub);
  if (subcommand === "branch") return checkGitBranch(rest, restCmdSub);
  if (subcommand === "checkout" || subcommand === "switch") {
    return checkGitCheckoutOrSwitch(subcommand, rest, restCmdSub);
  }
  if (subcommand === "rebase") return checkGitRebase(rest, restCmdSub, depth);
  if (subcommand === "filter-branch") return checkGitFilterBranch(rest, restCmdSub, depth);
  if (subcommand === "update-ref") return checkGitUpdateRef(rest, restCmdSub, cmd);

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
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
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

function isGraphqlEndpoint(endpoint: string): boolean {
  const path = normalizeGhApiPath(endpoint);
  return /(^|\/)graphql$/i.test(path);
}

function checkGh(args: string[], cmdSub: boolean[]): GuardDecision | null {
  let i = 0;
  const subcommands: Array<{ value: string; hasCmdSub: boolean }> = [];

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
    subcommands.push({ value: arg, hasCmdSub: cmdSub[i] ?? false });
    i++;
    if (subcommands[0].value === "api") {
      break;
    }
  }

  if (subcommands.some((s) => s.hasCmdSub)) {
    return deny("command substitution in gh subcommand is not allowed");
  }

  const cmd = subcommands[0]?.value;
  const sub = subcommands[1]?.value;

  if (cmd === "pr" && sub === "merge") {
    return deny("merging pull requests via gh pr merge is not allowed");
  }

  if (cmd === "repo" && sub === "delete") {
    return deny("deleting repositories via gh repo delete is not allowed");
  }

  if (cmd === "api") {
    const apiArgs = args.slice(i);
    const apiCmdSub = cmdSub.slice(i);
    let afterDoubleDash = false;
    let hasInputFlag = false;
    let hasAtFileQuery = false;
    const positionals: Array<{ value: string; hasCmdSub: boolean }> = [];
    const fieldValues: Array<{ value: string; hasCmdSub: boolean }> = [];

    for (let j = 0; j < apiArgs.length; j++) {
      const arg = apiArgs[j];
      const hasCmdSub = apiCmdSub[j] ?? false;
      if (!afterDoubleDash) {
        if (arg === "--") {
          afterDoubleDash = true;
          continue;
        }
        if (arg === "--input" || arg.startsWith("--input=")) {
          hasInputFlag = true;
          if (arg === "--input") j++;
          continue;
        }
        if (arg.startsWith("-f") && arg.length > 2) {
          fieldValues.push({ value: arg.slice(2), hasCmdSub });
          continue;
        }
        if (arg.startsWith("-F") && arg.length > 2) {
          const val = arg.slice(2);
          if (/^query=@/i.test(val)) hasAtFileQuery = true;
          fieldValues.push({ value: val, hasCmdSub });
          continue;
        }
        if (GH_API_VALUE_FLAGS.has(arg)) {
          const val = apiArgs[j + 1];
          const valCmdSub = apiCmdSub[j + 1] ?? false;
          if (
            val !== undefined &&
            (arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field")
          ) {
            if ((arg === "-F" || arg === "--field") && /^query=@/i.test(val)) {
              hasAtFileQuery = true;
            }
            fieldValues.push({ value: val, hasCmdSub: valCmdSub });
          }
          j++;
          continue;
        }
        if (arg.startsWith("--field=") || arg.startsWith("--raw-field=")) {
          const val = arg.slice(arg.indexOf("=") + 1);
          if (arg.startsWith("--field=") && /^query=@/i.test(val)) {
            hasAtFileQuery = true;
          }
          fieldValues.push({ value: val, hasCmdSub });
          continue;
        }
        if (arg.startsWith("-")) {
          continue;
        }
      }
      positionals.push({ value: arg, hasCmdSub });
    }

    for (const { value: endpoint, hasCmdSub } of positionals) {
      if (hasCmdSub) {
        return deny("command substitution in gh api endpoint is not allowed");
      }
      if (isProtectedGhApiEndpoint(endpoint)) {
        return deny(
          "calling GitHub branch protection or rulesets API endpoints is not allowed"
        );
      }
      if (isGraphqlEndpoint(endpoint)) {
        if (hasInputFlag) {
          return deny(
            "passing --input to gh api graphql is not allowed because the payload cannot be inspected"
          );
        }
        if (hasAtFileQuery) {
          return deny(
            "passing query=@file to gh api graphql is not allowed because the query cannot be inspected"
          );
        }
        if (fieldValues.some((f) => f.hasCmdSub)) {
          return deny(
            "command substitution in gh api graphql query fields is not allowed"
          );
        }
        const joined = fieldValues.map((f) => f.value).join(" ");
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

function hasForbiddenAgySlashCommand(text: string): boolean {
  return /^\s*\/(teamwork|swarm|boost)(?:[\s:]|$)/i.test(text);
}

function hasLeadingCommandSub(text: string): boolean {
  return /^\s*(?:\$\(|`)/.test(text);
}

const AGY_VALUE_FLAGS = new Set([
  "--agent",
  "--model",
  "--settings",
  "--output-format",
  "--cwd",
  "--dir",
  "--session",
  "--resume",
  "--max-turns",
  "-a",
  "-m",
  "-s",
  "-o",
]);

function extractPipedTextFromPrev(prevCmd: ParsedCommand | null): string | null {
  if (prevCmd === null || prevCmd.argv.length === 0) return null;
  if (prevCmd.argvCmdSub.some(Boolean)) return null;
  const prevBin = basename(prevCmd.argv[0]);
  if (prevBin === "echo") {
    let idx = 1;
    let enableEscapes = false;
    while (idx < prevCmd.argv.length && /^-[neE]+$/.test(prevCmd.argv[idx])) {
      for (const flag of prevCmd.argv[idx].slice(1)) {
        if (flag === "e") enableEscapes = true;
        else if (flag === "E") enableEscapes = false;
      }
      idx++;
    }
    const text = prevCmd.argv.slice(idx).join(" ");
    if (enableEscapes && text.includes("\\")) {
      return null;
    }
    return text;
  }
  if (prevBin === "printf") {
    if (prevCmd.argv.length < 2) return "";
    const fmt = prevCmd.argv[1];
    // Reject format specifiers other than %s / %% or escapes other than \n / \t
    const strippedFmt = fmt.replace(/%%|%s/g, "").replace(/\\n|\\t/g, "");
    if (strippedFmt.includes("%") || strippedFmt.includes("\\")) {
      return null;
    }
    let argIdx = 2;
    const out = fmt.replace(/%%|%s/g, (match) => {
      if (match === "%%") return "%";
      const replacement = prevCmd.argv[argIdx] ?? "";
      argIdx++;
      return replacement;
    });
    return out.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }
  if (prevBin === "cat" && prevCmd.argv.length === 1) {
    if (prevCmd.hereStrings.length > 0) {
      return prevCmd.hereStrings.join("\n");
    }
    if (prevCmd.hereDocs.length > 0) {
      return prevCmd.hereDocs.map((h) => h.body).join("\n");
    }
  }
  return null;
}

function checkAgy(
  args: string[],
  cmdSub: boolean[],
  cmd: ParsedCommand,
  prevCmd: ParsedCommand | null
): GuardDecision | null {
  if (cmd.hasHereString) {
    for (const hs of cmd.hereStrings) {
      if (hasForbiddenAgySlashCommand(hs)) {
        return deny("starting /teamwork, /swarm, or /boost via agy is not allowed");
      }
    }
  }
  if (cmd.hasHereDoc) {
    for (const hd of cmd.hereDocs) {
      if (hasForbiddenAgySlashCommand(hd.body)) {
        return deny("starting /teamwork, /swarm, or /boost via agy is not allowed");
      }
    }
  }
  if (cmd.pipedIn) {
    const pipedText = extractPipedTextFromPrev(prevCmd);
    if (pipedText === null) {
      return deny("piping unreadable input into agy is not allowed");
    }
    if (hasForbiddenAgySlashCommand(pipedText)) {
      return deny("starting /teamwork, /swarm, or /boost via agy is not allowed");
    }
  }

  let afterDoubleDash = false;
  const positionals: Array<{ value: string; hasCmdSub: boolean }> = [];

  for (let j = 0; j < args.length; j++) {
    const arg = args[j];
    const argCmdSub = cmdSub[j] ?? false;
    if (!afterDoubleDash) {
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (arg === "-p" || arg === "--prompt") {
        const promptVal = args[j + 1];
        const promptCmdSub = cmdSub[j + 1] ?? false;
        if (promptVal !== undefined) {
          if (promptCmdSub && hasLeadingCommandSub(promptVal)) {
            return deny("command substitution at start of agy prompt is not allowed");
          }
          if (hasForbiddenAgySlashCommand(promptVal)) {
            return deny("starting /teamwork, /swarm, or /boost via agy is not allowed");
          }
        }
        j++;
        continue;
      }
      if (arg.startsWith("--prompt=")) {
        const promptVal = arg.slice("--prompt=".length);
        if (argCmdSub && hasLeadingCommandSub(promptVal)) {
          return deny("command substitution at start of agy prompt is not allowed");
        }
        if (hasForbiddenAgySlashCommand(promptVal)) {
          return deny("starting /teamwork, /swarm, or /boost via agy is not allowed");
        }
        continue;
      }
      if (arg.startsWith("-p") && arg.length > 2) {
        const promptVal = arg.slice(2);
        if (argCmdSub && hasLeadingCommandSub(promptVal)) {
          return deny("command substitution at start of agy prompt is not allowed");
        }
        if (hasForbiddenAgySlashCommand(promptVal)) {
          return deny("starting /teamwork, /swarm, or /boost via agy is not allowed");
        }
        continue;
      }
      if (AGY_VALUE_FLAGS.has(arg)) {
        j++;
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
    }
    positionals.push({ value: arg, hasCmdSub: argCmdSub });
  }

  const firstPos = positionals[0]?.value;
  if (firstPos !== "plugin" && firstPos !== "help" && firstPos !== "version") {
    for (const pos of positionals) {
      if (pos.hasCmdSub && hasLeadingCommandSub(pos.value)) {
        return deny("command substitution at start of agy prompt is not allowed");
      }
      if (hasForbiddenAgySlashCommand(pos.value)) {
        return deny("starting /teamwork, /swarm, or /boost via agy is not allowed");
      }
    }
  }

  return null;
}

type ShellInspectResult =
  | { kind: "unrecognized"; flag: string }
  | { kind: "dash_c"; script: string | null }
  | { kind: "dash_s" }
  | { kind: "script_or_interactive" };

function inspectShellInvocation(args: string[]): ShellInspectResult {
  let hasDashC = false;
  let hasDashS = false;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-") {
      i++;
      break;
    }
    if (!arg.startsWith("-") && !arg.startsWith("+")) {
      break;
    }

    if (arg === "-o" || arg === "+o" || arg === "-O" || arg === "+O") {
      if (i + 1 >= args.length) {
        return { kind: "unrecognized", flag: arg };
      }
      i += 2;
      continue;
    }

    if (SHELL_VALUE_LONG_FLAGS.has(arg)) {
      if (i + 1 >= args.length) {
        return { kind: "unrecognized", flag: arg };
      }
      i += 2;
      continue;
    }

    if (arg.startsWith("--rcfile=") || arg.startsWith("--init-file=")) {
      i++;
      continue;
    }

    if (SHELL_NO_ARG_LONG_FLAGS.has(arg)) {
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      return { kind: "unrecognized", flag: arg };
    }

    const isPlus = arg.startsWith("+");
    const flags = arg.slice(1);
    for (const flag of flags) {
      if (flag === "c" && !isPlus) {
        hasDashC = true;
      } else if (flag === "s" && !isPlus) {
        hasDashS = true;
      } else if (!SHELL_NO_ARG_SHORT_FLAGS.has(flag)) {
        return { kind: "unrecognized", flag: arg };
      }
    }
    i++;
  }

  if (hasDashC) {
    return { kind: "dash_c", script: args[i] ?? null };
  }
  if (hasDashS) {
    return { kind: "dash_s" };
  }
  return { kind: "script_or_interactive" };
}

const ENV_NO_ARG_SHORT = new Set(["i", "0", "v"]);
const ENV_VALUE_SHORT = new Set(["u", "C", "P", "a", "L", "U"]);
const ENV_NO_ARG_LONG = new Set([
  "--ignore-environment",
  "--null",
  "--list-signal-handling",
  "--debug",
  "--help",
  "--version",
]);
const ENV_VALUE_LONG = new Set([
  "--unset",
  "--chdir",
  "--argv0",
  "--block-signal",
  "--default-signal",
  "--ignore-signal",
]);

function stripEnvPrefix(
  argv: string[],
  cmdSub: boolean[],
  depth: number,
  allowSplitFlag = true
): { nextArgv: string[]; nextCmdSub: boolean[]; denyDecision?: GuardDecision } {
  let idx = 1;
  while (idx < argv.length) {
    const a = argv[idx];
    if (a === "--") {
      idx++;
      break;
    }
    if (a === "-S" || a === "--split-string") {
      if (!allowSplitFlag) {
        return {
          nextArgv: [],
          nextCmdSub: [],
          denyDecision: deny("nested env -S is not allowed"),
        };
      }
      const splitArg = argv[idx + 1];
      if (splitArg === undefined) {
        return {
          nextArgv: [],
          nextCmdSub: [],
          denyDecision: deny("env -S without command string is not allowed"),
        };
      }
      return expandEnvSplitString(splitArg, argv.slice(idx + 2), cmdSub.slice(idx + 2), depth);
    }
    if (a.startsWith("--split-string=")) {
      if (!allowSplitFlag) {
        return {
          nextArgv: [],
          nextCmdSub: [],
          denyDecision: deny("nested env -S is not allowed"),
        };
      }
      return expandEnvSplitString(
        a.slice("--split-string=".length),
        argv.slice(idx + 1),
        cmdSub.slice(idx + 1),
        depth
      );
    }
    if (ENV_NO_ARG_LONG.has(a)) {
      idx++;
      continue;
    }
    if (ENV_VALUE_LONG.has(a)) {
      idx += 2;
      continue;
    }
    if (
      a.startsWith("--unset=") ||
      a.startsWith("--chdir=") ||
      a.startsWith("--argv0=") ||
      a.startsWith("--block-signal=") ||
      a.startsWith("--default-signal=") ||
      a.startsWith("--ignore-signal=")
    ) {
      idx++;
      continue;
    }
    if (a.startsWith("--")) {
      return {
        nextArgv: [],
        nextCmdSub: [],
        denyDecision: deny(`env with unrecognized option (${a}) is not allowed`),
      };
    }
    if (a.startsWith("-") && a.length > 1) {
      const flags = a.slice(1);
      let consumedNext = false;
      let hitSplit: string | null = null;
      let restAfterSplit: string[] = [];
      let restCmdSubAfterSplit: boolean[] = [];

      for (let k = 0; k < flags.length; k++) {
        const f = flags[k];
        if (f === "S") {
          if (!allowSplitFlag) {
            return {
              nextArgv: [],
              nextCmdSub: [],
              denyDecision: deny("nested env -S is not allowed"),
            };
          }
          const attached = flags.slice(k + 1);
          if (attached.length > 0) {
            hitSplit = attached;
            restAfterSplit = argv.slice(idx + 1);
            restCmdSubAfterSplit = cmdSub.slice(idx + 1);
          } else {
            const nextVal = argv[idx + 1];
            if (nextVal === undefined) {
              return {
                nextArgv: [],
                nextCmdSub: [],
                denyDecision: deny("env -S without command string is not allowed"),
              };
            }
            hitSplit = nextVal;
            restAfterSplit = argv.slice(idx + 2);
            restCmdSubAfterSplit = cmdSub.slice(idx + 2);
          }
          break;
        }
        if (ENV_VALUE_SHORT.has(f)) {
          if (k + 1 === flags.length) {
            consumedNext = true;
          }
          break;
        }
        if (!ENV_NO_ARG_SHORT.has(f)) {
          return {
            nextArgv: [],
            nextCmdSub: [],
            denyDecision: deny(`env with unrecognized option (${a}) is not allowed`),
          };
        }
      }

      if (hitSplit !== null) {
        return expandEnvSplitString(hitSplit, restAfterSplit, restCmdSubAfterSplit, depth);
      }
      idx += consumedNext ? 2 : 1;
      continue;
    }
    break;
  }
  return { nextArgv: argv.slice(idx), nextCmdSub: cmdSub.slice(idx) };
}

function expandEnvSplitString(
  splitArg: string,
  remainingArgv: string[],
  remainingCmdSub: boolean[],
  depth: number
): { nextArgv: string[]; nextCmdSub: boolean[]; denyDecision?: GuardDecision } {
  if (splitArg.includes("${") || splitArg.includes("\\")) {
    return {
      nextArgv: [],
      nextCmdSub: [],
      denyDecision: deny("env -S with escape or variable expansion is not allowed"),
    };
  }
  const parsed = parseShellCommands(splitArg);
  if (parsed.refusalReason !== null) {
    return { nextArgv: [], nextCmdSub: [], denyDecision: deny(parsed.refusalReason) };
  }
  for (const script of parsed.embeddedScripts) {
    const verdict = checkCommand(script, depth + 1);
    if (verdict.decision === "deny") {
      return { nextArgv: [], nextCmdSub: [], denyDecision: verdict };
    }
  }
  if (parsed.commands.length === 0) {
    return { nextArgv: remainingArgv, nextCmdSub: remainingCmdSub };
  }
  if (parsed.commands.length === 1) {
    const first = parsed.commands[0];
    if (first.hasHereDoc || first.hasHereString) {
      const nested = checkCommand(splitArg, depth + 1);
      if (nested.decision === "deny") {
        return { nextArgv: [], nextCmdSub: [], denyDecision: nested };
      }
    }
    return stripEnvPrefix(
      ["env", ...first.argv, ...remainingArgv],
      [false, ...first.argvCmdSub, ...remainingCmdSub],
      depth,
      false
    );
  }
  return {
    nextArgv: [],
    nextCmdSub: [],
    denyDecision: deny("env -S with shell separators or multiple commands is not allowed"),
  };
}

function stripTimeoutPrefix(
  argv: string[],
  cmdSub: boolean[]
): { nextArgv: string[]; nextCmdSub: boolean[]; denyDecision?: GuardDecision } {
  let idx = 1;
  while (idx < argv.length) {
    const a = argv[idx];
    if (a === "--") {
      idx++;
      break;
    }
    if (
      a === "--preserve-status" ||
      a === "--foreground" ||
      a === "-v" ||
      a === "--verbose" ||
      a === "--help" ||
      a === "--version"
    ) {
      idx++;
      continue;
    }
    if (a === "-k" || a === "--kill-after" || a === "-s" || a === "--signal") {
      idx += 2;
      continue;
    }
    if (
      a.startsWith("--kill-after=") ||
      a.startsWith("--signal=") ||
      ((a.startsWith("-k") || a.startsWith("-s")) && a.length > 2)
    ) {
      idx++;
      continue;
    }
    if (a.startsWith("-")) {
      return {
        nextArgv: [],
        nextCmdSub: [],
        denyDecision: deny(`timeout with unrecognized option (${a}) is not allowed`),
      };
    }
    break;
  }
  // Skip DURATION positional
  if (idx < argv.length) {
    idx++;
  }
  return { nextArgv: argv.slice(idx), nextCmdSub: cmdSub.slice(idx) };
}

function stripNicePrefix(
  argv: string[],
  cmdSub: boolean[]
): { nextArgv: string[]; nextCmdSub: boolean[]; denyDecision?: GuardDecision } {
  let idx = 1;
  while (idx < argv.length) {
    const a = argv[idx];
    if (a === "--") {
      idx++;
      break;
    }
    if (a === "--help" || a === "--version") {
      idx++;
      continue;
    }
    if (a === "-n" || a === "--adjustment") {
      idx += 2;
      continue;
    }
    if (
      a.startsWith("--adjustment=") ||
      (a.startsWith("-n") && a.length > 2) ||
      /^-\d+$/.test(a)
    ) {
      idx++;
      continue;
    }
    if (a.startsWith("-")) {
      return {
        nextArgv: [],
        nextCmdSub: [],
        denyDecision: deny(`nice with unrecognized option (${a}) is not allowed`),
      };
    }
    break;
  }
  return { nextArgv: argv.slice(idx), nextCmdSub: cmdSub.slice(idx) };
}

function unwrapPrefixChain(
  rawArgv: string[],
  rawCmdSub: boolean[],
  depth: number
): { argv: string[]; cmdSub: boolean[]; earlyReturn?: GuardDecision | null } {
  let argv = rawArgv.slice();
  let cmdSub = rawCmdSub.slice();

  while (argv.length > 0) {
    if (SHELL_KEYWORDS.has(argv[0]) || isEnvAssignment(argv[0])) {
      argv = argv.slice(1);
      cmdSub = cmdSub.slice(1);
      continue;
    }

    if (cmdSub[0]) {
      return {
        argv: [],
        cmdSub: [],
        earlyReturn: deny("command substitution in command name is not allowed"),
      };
    }

    const bin = basename(argv[0]);

    if (bin === "env") {
      const stripped = stripEnvPrefix(argv, cmdSub, depth);
      if (stripped.denyDecision !== undefined) {
        return { argv: [], cmdSub: [], earlyReturn: stripped.denyDecision };
      }
      argv = stripped.nextArgv;
      cmdSub = stripped.nextCmdSub;
      continue;
    }

    if (bin === "timeout" || bin === "gtimeout") {
      const stripped = stripTimeoutPrefix(argv, cmdSub);
      if (stripped.denyDecision !== undefined) {
        return { argv: [], cmdSub: [], earlyReturn: stripped.denyDecision };
      }
      argv = stripped.nextArgv;
      cmdSub = stripped.nextCmdSub;
      continue;
    }

    if (bin === "nice") {
      const stripped = stripNicePrefix(argv, cmdSub);
      if (stripped.denyDecision !== undefined) {
        return { argv: [], cmdSub: [], earlyReturn: stripped.denyDecision };
      }
      argv = stripped.nextArgv;
      cmdSub = stripped.nextCmdSub;
      continue;
    }

    if (bin === "command") {
      let idx = 1;
      let isQuery = false;
      while (idx < argv.length) {
        const a = argv[idx];
        if (a === "--") {
          idx++;
          break;
        }
        if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) {
          for (const f of a.slice(1)) {
            if (f === "v" || f === "V") {
              isQuery = true;
            } else if (f !== "p") {
              return {
                argv: [],
                cmdSub: [],
                earlyReturn: deny(`command with unrecognized option (${a}) is not allowed`),
              };
            }
          }
          idx++;
          continue;
        }
        if (a.startsWith("-")) {
          return {
            argv: [],
            cmdSub: [],
            earlyReturn: deny(`command with unrecognized option (${a}) is not allowed`),
          };
        }
        break;
      }
      if (isQuery) {
        return { argv: [], cmdSub: [], earlyReturn: null };
      }
      argv = argv.slice(idx);
      cmdSub = cmdSub.slice(idx);
      continue;
    }

    if (bin === "exec") {
      let idx = 1;
      while (idx < argv.length) {
        const a = argv[idx];
        if (a === "--") {
          idx++;
          break;
        }
        if (a === "-a") {
          idx += 2;
          continue;
        }
        if ((a.startsWith("-a") && a.length > 2) || a === "-c" || a === "-l") {
          idx++;
          continue;
        }
        if (a.startsWith("-")) {
          return {
            argv: [],
            cmdSub: [],
            earlyReturn: deny(`exec with unrecognized option (${a}) is not allowed`),
          };
        }
        break;
      }
      argv = argv.slice(idx);
      cmdSub = cmdSub.slice(idx);
      continue;
    }

    if (bin === "nohup" || bin === "builtin") {
      let idx = 1;
      while (idx < argv.length) {
        const a = argv[idx];
        if (a === "--") {
          idx++;
          break;
        }
        if (bin === "nohup" && (a === "--help" || a === "--version")) {
          idx++;
          continue;
        }
        if (a.startsWith("-")) {
          return {
            argv: [],
            cmdSub: [],
            earlyReturn: deny(`${bin} with unrecognized option (${a}) is not allowed`),
          };
        }
        break;
      }
      argv = argv.slice(idx);
      cmdSub = cmdSub.slice(idx);
      continue;
    }

    if (bin === "time") {
      let idx = 1;
      while (idx < argv.length) {
        const a = argv[idx];
        if (a === "--") {
          idx++;
          break;
        }
        if (
          a === "-p" ||
          a === "-v" ||
          a === "--verbose" ||
          a === "-a" ||
          a === "--append" ||
          a === "-q" ||
          a === "--quiet" ||
          a === "--portability" ||
          a.startsWith("--format=") ||
          a.startsWith("--output=")
        ) {
          idx++;
          continue;
        }
        if (a === "-f" || a === "--format" || a === "-o" || a === "--output") {
          idx += 2;
          continue;
        }
        if (a.startsWith("-")) {
          return {
            argv: [],
            cmdSub: [],
            earlyReturn: deny(`time with unrecognized option (${a}) is not allowed`),
          };
        }
        break;
      }
      argv = argv.slice(idx);
      cmdSub = cmdSub.slice(idx);
      continue;
    }

    if (bin === "setsid") {
      let idx = 1;
      while (idx < argv.length) {
        const a = argv[idx];
        if (a === "--") {
          idx++;
          break;
        }
        if (
          a === "-c" ||
          a === "--ctty" ||
          a === "-f" ||
          a === "--fork" ||
          a === "-w" ||
          a === "--wait" ||
          a === "--help" ||
          a === "--version"
        ) {
          idx++;
          continue;
        }
        if (a.startsWith("-")) {
          return {
            argv: [],
            cmdSub: [],
            earlyReturn: deny(`setsid with unrecognized option (${a}) is not allowed`),
          };
        }
        break;
      }
      argv = argv.slice(idx);
      cmdSub = cmdSub.slice(idx);
      continue;
    }

    if (bin === "stdbuf") {
      let idx = 1;
      while (idx < argv.length) {
        const a = argv[idx];
        if (a === "--") {
          idx++;
          break;
        }
        if (a === "-i" || a === "--input" || a === "-o" || a === "--output" || a === "-e" || a === "--error") {
          idx += 2;
          continue;
        }
        if (
          a.startsWith("--input=") ||
          a.startsWith("--output=") ||
          a.startsWith("--error=") ||
          ((a.startsWith("-i") || a.startsWith("-o") || a.startsWith("-e")) && a.length > 2) ||
          a === "--help" ||
          a === "--version"
        ) {
          idx++;
          continue;
        }
        if (a.startsWith("-")) {
          return {
            argv: [],
            cmdSub: [],
            earlyReturn: deny(`stdbuf with unrecognized option (${a}) is not allowed`),
          };
        }
        break;
      }
      argv = argv.slice(idx);
      cmdSub = cmdSub.slice(idx);
      continue;
    }

    break;
  }

  return { argv, cmdSub };
}

function isDisallowedBatchTarget(bin: string): boolean {
  return (
    bin === "git" ||
    bin === "gh" ||
    bin === "sudo" ||
    bin === "eval" ||
    bin === "agy" ||
    bin === "xargs" ||
    bin === "parallel" ||
    SHELL_BINARIES.has(bin)
  );
}

function isUnreadableBatchTarget(
  bin: string,
  hasCmdSub: boolean,
  replaceToken: string | null
): boolean {
  if (hasCmdSub) return true;
  if (/[{}$(`]/.test(bin)) return true;
  if (replaceToken !== null && replaceToken.length > 0 && bin.includes(replaceToken)) {
    return true;
  }
  return false;
}

const XARGS_NO_ARG_SHORT = new Set(["0", "p", "r", "t", "x", "o", "h"]);
const XARGS_VALUE_SHORT = new Set(["a", "d", "E", "I", "L", "n", "P", "s"]);
const XARGS_OPT_ATTACHED_SHORT = new Set(["e", "i", "l"]);
const XARGS_NO_ARG_LONG = new Set([
  "--null",
  "--interactive",
  "--no-run-if-empty",
  "--verbose",
  "--exit",
  "--open-tty",
  "--show-limits",
  "--help",
  "--version",
  "--eof",
  "--replace",
  "--max-lines",
]);
const XARGS_VALUE_LONG = new Set([
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--process-slot-var",
]);

function checkXargs(rest: string[], restCmdSub: boolean[], depth: number): GuardDecision | null {
  let idx = 0;
  let replaceToken: string | null = null;
  while (idx < rest.length) {
    const a = rest[idx];
    if (a === "--") {
      idx++;
      break;
    }
    if (a === "--replace") {
      replaceToken = "{}";
      idx++;
      continue;
    }
    if (XARGS_NO_ARG_LONG.has(a)) {
      idx++;
      continue;
    }
    if (a.startsWith("--replace=")) {
      replaceToken = a.slice("--replace=".length) || "{}";
      idx++;
      continue;
    }
    if (XARGS_VALUE_LONG.has(a)) {
      idx += 2;
      continue;
    }
    if (
      a.startsWith("--arg-file=") ||
      a.startsWith("--delimiter=") ||
      a.startsWith("--eof=") ||
      a.startsWith("--max-lines=") ||
      a.startsWith("--max-args=") ||
      a.startsWith("--max-procs=") ||
      a.startsWith("--max-chars=") ||
      a.startsWith("--process-slot-var=")
    ) {
      idx++;
      continue;
    }
    if (a.startsWith("--")) {
      return deny(`xargs with unrecognized option (${a}) is not allowed`);
    }
    if (a.startsWith("-") && a.length > 1) {
      const flags = a.slice(1);
      let consumedNext = false;
      for (let k = 0; k < flags.length; k++) {
        const f = flags[k];
        if (f === "I") {
          const attached = flags.slice(k + 1);
          if (attached.length > 0) {
            replaceToken = attached;
          } else {
            replaceToken = rest[idx + 1] ?? "{}";
            consumedNext = true;
          }
          break;
        }
        if (f === "i") {
          const attached = flags.slice(k + 1);
          replaceToken = attached.length > 0 ? attached : "{}";
          break;
        }
        if (XARGS_VALUE_SHORT.has(f)) {
          if (k + 1 === flags.length) consumedNext = true;
          break;
        }
        if (XARGS_OPT_ATTACHED_SHORT.has(f)) {
          break;
        }
        if (!XARGS_NO_ARG_SHORT.has(f)) {
          return deny(`xargs with unrecognized option (${a}) is not allowed`);
        }
      }
      idx += consumedNext ? 2 : 1;
      continue;
    }
    break;
  }

  const targetArgv = rest.slice(idx);
  const targetCmdSub = restCmdSub.slice(idx);
  if (targetArgv.length === 0) return null;

  const unwrapped = unwrapPrefixChain(targetArgv, targetCmdSub, depth);
  if (unwrapped.earlyReturn !== undefined) {
    return unwrapped.earlyReturn;
  }
  if (unwrapped.argv.length === 0) return null;

  const targetBin = basename(unwrapped.argv[0]);
  if (isUnreadableBatchTarget(targetBin, unwrapped.cmdSub[0] ?? false, replaceToken)) {
    return deny("running unreadable target command via xargs is not allowed");
  }
  if (isDisallowedBatchTarget(targetBin)) {
    return deny(`running ${targetBin} via xargs is not allowed`);
  }
  return null;
}

const PARALLEL_NO_ARG_FLAGS = new Set([
  "-k",
  "--keep-order",
  "--tag",
  "-t",
  "--bar",
  "--eta",
  "--progress",
  "--dry-run",
  "-v",
  "--verbose",
  "-q",
  "--quote",
  "--no-notice",
  "--will-cite",
  "-0",
  "--null",
  "--pipe",
  "--pipepart",
  "--xargs",
  "-X",
  "-m",
  "--plus",
  "--shellquote",
  "--ungroup",
  "-u",
  "--group",
  "-h",
  "--help",
  "--version",
  "--citation",
  "--bibtex",
  "-i",
]);

const PARALLEL_VALUE_FLAGS = new Set([
  "-j",
  "--jobs",
  "-P",
  "--max-procs",
  "-I",
  "--replace",
  "-n",
  "-N",
  "-L",
  "-l",
  "--max-lines",
  "-a",
  "--arg-file",
  "-d",
  "--delimiter",
  "--colsep",
  "-C",
  "-S",
  "--sshlogin",
  "--sshloginfile",
  "--workdir",
  "--wd",
  "--results",
  "--res",
  "--tagstring",
  "--halt",
  "--timeout",
  "--retries",
  "--delay",
  "--memfree",
  "--load",
  "--noswap",
  "--rpl",
  "--slf",
  "--tmpdir",
  "--joblog",
]);

function checkParallel(rest: string[], restCmdSub: boolean[], depth: number): GuardDecision | null {
  let idx = 0;
  let replaceToken: string | null = "{}";
  while (idx < rest.length) {
    const a = rest[idx];
    if (a === "--") {
      idx++;
      break;
    }
    if (a === ":::" || a === "::::") {
      return deny("running commands via parallel without an explicit safe command is not allowed");
    }
    if (PARALLEL_NO_ARG_FLAGS.has(a)) {
      idx++;
      continue;
    }
    if (a === "-I" || a === "--replace") {
      replaceToken = rest[idx + 1] ?? "{}";
      idx += 2;
      continue;
    }
    if (PARALLEL_VALUE_FLAGS.has(a)) {
      idx += 2;
      continue;
    }
    if (a.startsWith("--replace=")) {
      replaceToken = a.slice("--replace=".length) || "{}";
      idx++;
      continue;
    }
    if (a.startsWith("-I") && a.length > 2) {
      replaceToken = a.slice(2);
      idx++;
      continue;
    }
    if (
      /^--[a-z-]+=/i.test(a) ||
      /^-[jPnNLladCS].+/.test(a)
    ) {
      idx++;
      continue;
    }
    if (a.startsWith("-")) {
      return deny(`parallel with unrecognized option (${a}) is not allowed`);
    }
    break;
  }

  const sepIdx = rest.findIndex((t, pos) => pos >= idx && (t === ":::" || t === "::::"));
  const cmdTokens = sepIdx === -1 ? rest.slice(idx) : rest.slice(idx, sepIdx);
  const cmdTokensSub = sepIdx === -1 ? restCmdSub.slice(idx) : restCmdSub.slice(idx, sepIdx);
  if (cmdTokens.length === 0) {
    return deny("running commands via parallel without an explicit safe command is not allowed");
  }

  const unwrapped = unwrapPrefixChain(cmdTokens, cmdTokensSub, depth);
  if (unwrapped.earlyReturn !== undefined) {
    return unwrapped.earlyReturn;
  }
  if (unwrapped.argv.length > 0) {
    const targetBin = basename(unwrapped.argv[0]);
    const hasInnerShell = /[\s;|&$`<>()]/.test(cmdTokens[0]);
    if (!hasInnerShell && isUnreadableBatchTarget(targetBin, unwrapped.cmdSub[0] ?? false, replaceToken)) {
      return deny("running unreadable target command via parallel is not allowed");
    }
    if (isDisallowedBatchTarget(targetBin)) {
      return deny(`running ${targetBin} via parallel is not allowed`);
    }
  }

  if (/[\s;|&$`<>()]/.test(cmdTokens[0])) {
    const parsedInner = parseShellCommands(cmdTokens[0]);
    if (parsedInner.refusalReason !== null) {
      return deny(parsedInner.refusalReason);
    }
    for (const innerCmd of parsedInner.commands) {
      const innerUnwrapped = unwrapPrefixChain(innerCmd.argv, innerCmd.argvCmdSub, depth + 1);
      if (innerUnwrapped.earlyReturn !== undefined) {
        return innerUnwrapped.earlyReturn;
      }
      if (innerUnwrapped.argv.length > 0) {
        const innerBin = basename(innerUnwrapped.argv[0]);
        if (isUnreadableBatchTarget(innerBin, innerUnwrapped.cmdSub[0] ?? false, replaceToken)) {
          return deny("running unreadable target command via parallel is not allowed");
        }
        if (isDisallowedBatchTarget(innerBin)) {
          return deny(`running ${innerBin} via parallel is not allowed`);
        }
      }
    }
  }

  return null;
}

function checkSimpleCommand(
  cmd: ParsedCommand,
  prevCmd: ParsedCommand | null,
  depth: number
): GuardDecision | null {
  const unwrapped = unwrapPrefixChain(cmd.argv, cmd.argvCmdSub, depth);
  if (unwrapped.earlyReturn !== undefined) {
    return unwrapped.earlyReturn;
  }

  const argv = unwrapped.argv;
  const cmdSub = unwrapped.cmdSub;
  if (argv.length === 0) {
    return null;
  }

  const bin = basename(argv[0]);
  const rest = argv.slice(1);
  const restCmdSub = cmdSub.slice(1);

  if (bin === "sudo") {
    return deny("running commands with sudo is not allowed");
  }

  if (bin === "eval") {
    return deny("using eval is not allowed");
  }

  if (bin === "alias") {
    if (rest.some((arg) => arg.includes("="))) {
      return deny("defining shell aliases is not allowed");
    }
    return null;
  }

  if (bin === "source" || bin === ".") {
    if (cmd.hasHereDoc || cmd.hasHereString) {
      return deny("sourcing from here-doc or here-string is not allowed");
    }
    if (cmd.pipedIn) {
      return deny("sourcing from piped input is not allowed");
    }
    if (rest.some((arg) => arg.includes("<(") || arg.includes(">("))) {
      return deny("sourcing process substitution is not allowed");
    }
    return null;
  }

  if (bin === "xargs") {
    return checkXargs(rest, restCmdSub, depth);
  }

  if (bin === "parallel") {
    return checkParallel(rest, restCmdSub, depth);
  }

  if (SHELL_BINARIES.has(bin)) {
    if (cmd.pipedIn) {
      return deny("piping input into a shell is not allowed");
    }
    if (cmd.hasHereDoc || cmd.hasHereString) {
      return deny("feeding here-docs or here-strings to a shell is not allowed");
    }
    if (rest.some((arg) => arg.includes("<(") || arg.includes(">("))) {
      return deny("passing process substitution to a shell is not allowed");
    }
    const inspected = inspectShellInvocation(rest);
    if (inspected.kind === "unrecognized") {
      return deny(`shell invocation with unrecognized option (${inspected.flag}) is not allowed`);
    }
    if (inspected.kind === "dash_s") {
      return deny("reading shell commands from stdin (-s) is not allowed");
    }
    if (inspected.kind === "dash_c") {
      if (inspected.script === null) {
        return deny("shell -c without a readable script argument is not allowed");
      }
      const nested = checkCommand(inspected.script, depth + 1);
      if (nested.decision === "deny") {
        return nested;
      }
    }
    return null;
  }

  if (bin === "git") {
    return checkGit(rest, restCmdSub, cmd, depth);
  }

  if (bin === "gh") {
    return checkGh(rest, restCmdSub);
  }

  if (bin === "agy") {
    return checkAgy(rest, restCmdSub, cmd, prevCmd);
  }

  return null;
}

export function checkCommand(commandLine: string, depth = 0): GuardDecision {
  if (depth > MAX_RECURSION_DEPTH) {
    return deny("command nesting exceeded guard recursion limit");
  }

  const { commands, embeddedScripts, refusalReason } = parseShellCommands(commandLine);

  if (refusalReason !== null) {
    return deny(refusalReason);
  }

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const prevCmd = cmd.pipedIn && i > 0 ? commands[i - 1] : null;
    const verdict = checkSimpleCommand(cmd, prevCmd, depth);
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
