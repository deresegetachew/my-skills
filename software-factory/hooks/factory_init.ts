#!/usr/bin/env -S bun --no-env-file
// `factory init` (#103): the project's own scaffold, after `install.sh` has put the kit in the folder.
//
//   factory init [--dry-run]
//
// Makes what is missing, and says what it made (running it again adds nothing and posts nothing twice):
//   - the role folders and their reads.md (`factory init-roles`)
//   - the labels the factory uses (`factory issues setup`)
//   - the owner queue issue, "Dev manager: needs the owner", where the roles ask the owner (stage approvals too)
//   - a starter PRD at the `prd` path, with the story format `factory prd` reads
//   - the pull request template for a PRD change (`.github/PULL_REQUEST_TEMPLATE/prd-change.md`; `install.sh` adds it too)
// It never overwrites a file. Then it prints the next steps from an empty folder to a first milestone. Needs `gh` signed in.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, load, ROLE_NAMES, rolesDir } from "./factory_config.ts";
import { ghAll, setupLabels } from "./factory_issues.ts";
import { ownerQueue } from "./factory_orchestrator.ts";
import { init as initRoles } from "./factory_roles.ts";
import { die, runMain } from "./factory_lib.ts";

const DOC = `\`factory init\` (#103): the project's own scaffold, after \`install.sh\` has put the kit in the folder.

  factory init [--dry-run]

Makes what is missing, and says what it made (running it again adds nothing and posts nothing twice):
  - the role folders and their reads.md (\`factory init-roles\`)
  - the labels the factory uses (\`factory issues setup\`)
  - the owner queue issue, "Dev manager: needs the owner", where the roles ask the owner (stage approvals too)
  - a starter PRD at the \`prd\` path, with the story format \`factory prd\` reads
  - the pull request template for a PRD change (\`.github/PULL_REQUEST_TEMPLATE/prd-change.md\`; \`install.sh\` adds it too)
It never overwrites a file. Then it prints the next steps from an empty folder to a first milestone. Needs \`gh\` signed in.
`;

export const PRD_STUB = `# Product requirements

## Vision

<!-- Who it is for, what they can do that they could not, and why now. A short paragraph. -->

## Users

## User stories

<!-- One line each, numbered once and never reused: \`- US-1: <what the person can do>\`. Tasks say \`PRD: US-1\`. -->

- US-1: 

## Rules that must never break

## Out of scope
`;
export const PR_TEMPLATE = join(".github", "PULL_REQUEST_TEMPLATE", "prd-change.md");
/** The same text as kit/.github/PULL_REQUEST_TEMPLATE/prd-change.md (a test checks). */
export const PR_TEXT = `## What changes in the PRD

<!-- Why now (the user need or what the sign-off and testing queue showed), in two or three lines. Never a number you did not read from \`factory prd\`, the usage log or a test result. -->

## Stories this touches

<!-- One line each: added, changed, removed or split. Keep the numbers (US-<n>); a removed story keeps its number. -->

- 

## Tasks that move

<!-- One line each, with the issue number: added (new issue), changed (what in "Done when"), frozen (\`factory-hold\`) or closed as not planned. Running agents pick this up from the issues, so say it here and in the issue. -->

- 

## Decision record

<!-- The new file in docs/decisions/ (take the next free number on main and in open PRs), or "none: nothing to decide". -->

## Owner's yes

<!-- Scope and order are the owner's. Link the owner-queue reply or say who agreed and where. -->

- [ ] The owner agreed to this scope and order
- [ ] \`factory prd\` run after the change: no story used twice, no task naming a missing story
`;

export const NEXT = `Next, from here to a first milestone (each gate is the owner's yes):
  1. factory product-owner loop -i        the product owner interviews you and writes the vision and the PRD
  2. factory prd --stage --ask vision      then design, then plan: \`factory prd --stage\` shows where you are
  3. factory dev-manager loop              the orchestrator and its sub-managers, once the plan is approved
  4. factory coding-agent loop             the builders take the ready tasks
Change direction later with a pull request from the PRD-change template; \`factory prd\` shows what moves.`;

export function writeOnce(path: string, text: string, dry: boolean): string {
  if (existsSync(path)) return `exists   ${path}`;
  if (!dry) {
    mkdirSync(dirname(path) || ".", { recursive: true });
    writeFileSync(path, text);
  }
  return `${dry ? "would add" : "added   "} ${path}`;
}

export function init(cfg: Config, dry = false): string[] {
  const out: string[] = [];
  for (const role of ROLE_NAMES) {
    const folder = join(rolesDir(cfg), role);
    for (const name of ["README.md", "reads.md"]) {
      if (existsSync(join(folder, name))) continue;
      if (dry) out.push(`would add ${join(folder, name)}`);
    }
  }
  if (!dry) out.push(...initRoles(cfg).map((p) => `added    ${p}`));
  else if (!out.length) out.push(`exists   ${rolesDir(cfg)}/ (the role folders)`);
  const have = new Set(ghAll<{ name: string }>("repos/{owner}/{repo}/labels").map((x) => x.name));
  const labels = !dry ? setupLabels(cfg) : null;
  if (dry) out.push(have.size ? "would create the factory labels that are missing" : "would create the factory labels");
  else out.push(labels && labels.length ? `created  ${labels.length} labels` : "exists   the factory labels");
  const queue = ownerQueue(cfg, false);
  if (queue) out.push(`exists   owner queue #${queue}`);
  else if (dry) out.push("would make the owner queue issue");
  else out.push(`made     owner queue #${ownerQueue(cfg, true)}`);
  out.push(writeOnce(cfg.prd || "docs/PRD.md", PRD_STUB, dry));
  out.push(writeOnce(PR_TEMPLATE, PR_TEXT, dry));
  return out;
}

export function main(a: string[]): void {
  if (a.some((x) => x !== "--dry-run")) die(DOC);
  const cfg = load();
  console.log(init(cfg, a.includes("--dry-run")).join("\n"));
  console.log("\n" + NEXT);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
