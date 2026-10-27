// The agents' allow list names the package commands they need, not the package runners (#261). `pnpm *` or
// `npm run *` would let an agent run any code without a prompt (`pnpm exec node -e ...`, a script it wrote into
// package.json), around the PR gate. The commands the kit's factory.json runs stay allowed, so an unattended run never
// stops on them.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_AGENT_SETTINGS } from "./loop_support.ts";
import { allowedBy, type Permissions } from "./manager_support.ts";
import { KIT } from "./support.ts";

const agents = (): Permissions => (JSON.parse(readFileSync(KIT_AGENT_SETTINGS, "utf8")) as { permissions: Permissions }).permissions;

test("the commands the kit's factory.json runs are allowed without a prompt", () => {
  const cfg = JSON.parse(readFileSync(join(KIT, ".claude", "factory.json"), "utf8")) as { commands: Record<string, string> };
  const commands = Object.values(cfg.commands).filter((c) => c.trim());
  expect(commands.length).toBeGreaterThan(0);
  for (const c of [...commands, "pnpm install", "pnpm test", "pnpm lint", "pnpm typecheck", "pnpm build", "npm ci", "npm test"]) {
    expect(allowedBy(agents(), c), c).toBe(true);
  }
});

test("package runners that run any code are not allowed without a prompt", () => {
  for (const c of ['pnpm exec node -e "process.exit(0)"', "pnpm dlx some-tool", "pnpm run x", "pnpm x", "npm run x",
    "npm exec some-tool", "npx some-tool", "pnpm add left-pad"]) {
    expect(allowedBy(agents(), c), c).toBe(false);
  }
});
