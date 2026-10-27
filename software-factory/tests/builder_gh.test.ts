// The gh commands a builder is told to run must be ones the agents' settings let it run (#182). The settings deny
// `gh api` (it would merge or post review markers around the PR gate, #260), so the builder's skill and the agents'
// definitions never send it there: when `gh pr create` fails, it stops and reports. The manager's and the product
// owner's skills run with their own profiles and are not read here.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { shQuote } from "../hooks/factory_lib.ts";
import { simpleCommands } from "../hooks/factory_shell.ts";
import { KIT_AGENT_SETTINGS } from "./loop_support.ts";
import { allowedBy, type Permissions } from "./manager_support.ts";
import { KIT } from "./support.ts";

const BUILDER_TEXTS = ["skills/next-task", "skills/design-check", "skills/eval", "agents"].map((p) => join(KIT, ".claude", p));

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? markdown(p) : p.endsWith(".md") ? [p] : [];
  });
}

/** Every `gh ...` simple command inside an inline code span of the builder's texts, with where it is. */
function ghCommands(): [string, string][] {
  const out: [string, string][] = [];
  for (const file of BUILDER_TEXTS.flatMap(markdown)) {
    for (const m of readFileSync(file, "utf8").matchAll(/`([^`\n]*\bgh [a-z][^`\n]*)`/g)) {
      for (const tokens of simpleCommands(m[1] as string)) {
        if (tokens[0] !== "gh" || tokens.length < 3) continue; // `gh api` alone names the tool; a command has more
        out.push([relative(KIT, file), tokens.map((t) => (/^[\w@%+=:,./{}-]+$/.test(t) ? t : shQuote(t))).join(" ")]);
      }
    }
  }
  return out;
}

const agents = (): Permissions => (JSON.parse(readFileSync(KIT_AGENT_SETTINGS, "utf8")) as { permissions: Permissions }).permissions;

test("every gh command the builder is told to run is allowed by the agents' settings", () => {
  const found = ghCommands();
  expect(found.length, "the skill names its gh commands").toBeGreaterThan(5);
  const refused = found.filter(([, cmd]) => !allowedBy(agents(), cmd));
  expect(refused, "commands the agents' settings would refuse or ask about").toEqual([]);
});

test("the agents' settings still deny gh api, and no builder text tells an agent to use it", () => {
  expect(agents().deny).toContain("Bash(gh api *)");
  expect(ghCommands().filter(([, cmd]) => cmd.startsWith("gh api"))).toEqual([]);
});
