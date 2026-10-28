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

// The v0.2.0 audit's finding 2 (#260): `docker compose *` let an agent run any container with the host's files
// (`docker compose -f tmp/x.yaml run -v "$HOME/.config/gh:/root/.config/gh" ...`). Only the dev stack's forms are allowed.
test("only the dev stack's docker compose forms are allowed", () => {
  for (const c of ["docker compose up -d", "docker compose up -d postgres", "docker compose ps", "docker compose ps -a",
    "docker compose logs postgres", "docker compose logs --tail 50 api", "docker compose exec -T postgres psql -U app -c 'select 1'",
    "docker compose down"]) {
    expect(allowedBy(agents(), c), c).toBe(true);
  }
  for (const c of ["docker compose -f tmp/x.yaml run --rm x sh", "docker compose --file tmp/x.yaml up -d",
    "docker compose up -d -f tmp/x.yaml", "docker compose up -d --file=tmp/x.yaml", "docker compose run --rm x sh",
    "docker compose up -d x && docker compose run x", "docker compose exec -T postgres -v /:/h sh",
    "docker compose down -v", "docker compose down --volumes", "docker compose cp tmp/x postgres:/x",
    "docker compose --project-directory tmp up -d", "docker compose up -d --project-directory tmp",
    "docker compose exec api sh", "docker compose -p other up -d", "docker compose up -d --env-file tmp/e"]) {
    expect(allowedBy(agents(), c), c).toBe(false);
  }
});
