// The web UI covers every command (#446): each command `factory help` lists has one row in the parity list
// (docs/design/web-ui/PARITY.md) that says where the UI covers it, or that it stays a tool for agents or the terminal.
// A new command fails here until it has its row; a row for a command that is gone fails too.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { read, SF, sh } from "./support.ts";

const DESIGN = join(SF, "docs", "design", "web-ui");
const PARITY = join(DESIGN, "PARITY.md");
const STATES = ["built", "planned", "agents only", "terminal only"];
const DESCRIPTION_COLUMN = 25; // where `factory help` starts a command's description

interface Row { command: string; state: string; where: string; task: string }

/** The commands an entry of `factory help` names: its plain words (`ci use`, `cockpit --prs`), and one per choice when a
 * word lists them (`rereview plan|prompt` gives `rereview plan` and `rereview prompt`). It stops at an argument (`<n>`,
 * `[--json]`) or at the description. */
function commandsOf(line: string): string[] {
  const words: string[] = [];
  let at = 2;
  for (const w of line.slice(2).split(" ")) {
    if (w === "" || (at >= DESCRIPTION_COLUMN && words.length > 0)) break;
    if (/^(--)?[a-z][a-z0-9-]*$/.test(w)) {
      words.push(w);
      at += w.length + 1;
      continue;
    }
    if (words.length > 0 && /^[a-z][a-z0-9-]*(\|[a-z][a-z0-9-]*)+$/.test(w)) return w.split("|").map((c) => [...words, c].join(" "));
    break;
  }
  return words.length > 0 ? [words.join(" ")] : [];
}

function helpCommands(): string[] {
  const p = sh(["bash", join(SF, "factory"), "help"], { cwd: SF });
  expect(p.code).toBe(0);
  const all = p.stdout.split("\n").filter((l) => /^ {2}\S/.test(l)).flatMap(commandsOf);
  return [...new Set(all)];
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const line of read(PARITY).split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const [state = "", where = "", task = ""] = (m[2] ?? "").split("|").map((c) => c.trim());
    out.push({ command: m[1] ?? "", state, where, task });
  }
  return out;
}

test("the help lists commands this test can read", () => {
  const cmds = helpCommands();
  for (const c of ["loop", "settings pr", "ci use local","owner merge", "rereview plan", "cockpit --prs", "doctor", "update"]) {
    expect(cmds).toContain(c);
  }
  expect(cmds.length).toBeGreaterThan(60);
});

test("every command in factory help has a row in the parity list", () => {
  const listed = new Set(rows().map((r) => r.command));
  const missing = helpCommands().filter((c) => !listed.has(c));
  expect(missing, `Add a row to docs/design/web-ui/PARITY.md for: ${missing.join(", ")}`).toEqual([]);
});

test("the parity list has no row for a command factory help no longer lists, and none twice", () => {
  const cmds = new Set(helpCommands());
  const all = rows().map((r) => r.command);
  expect(all.filter((c) => !cmds.has(c)), "Remove these rows from PARITY.md, or bring the command back").toEqual([]);
  expect(all.filter((c, i) => all.indexOf(c) !== i), "These commands have more than one row").toEqual([]);
});

test("each row says how the UI covers it: built, planned with its task, or why it stays off the UI", () => {
  const bad: string[] = [];
  for (const r of rows()) {
    if (!STATES.includes(r.state)) bad.push(`${r.command}: "${r.state}" is not one of ${STATES.join(", ")}`);
    if (r.where === "") bad.push(`${r.command}: say where the UI covers it, or why it stays off the UI`);
    if (r.state === "planned" && !/#\d+/.test(r.task)) bad.push(`${r.command}: a planned row names its task (#n)`);
    for (const f of r.where.match(/[A-Za-z]+\.dc\.html/g) ?? []) {
      if (!existsSync(join(DESIGN, f))) bad.push(`${r.command}: there is no design file ${f}`);
    }
  }
  expect(bad).toEqual([]);
});

test("the design README points builders at the parity list", () => {
  expect(read(join(DESIGN, "README.md"))).toContain("PARITY.md");
});
