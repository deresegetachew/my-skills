// my-skills builds itself with its own factory (#112): its CLAUDE.md, its .claude/factory.json and the links that make
// `./factory` work in this repo.
import { expect, test } from "bun:test";
import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { HOOKS, read, ROOT as REPO, runBun, SF, sh } from "./support.ts";

interface Cfg {
  tasks: { source: string };
  commands: Record<string, string>;
  protected: string[];
  notes?: string;
}

function config(): Cfg {
  return JSON.parse(read(join(REPO, ".claude", "factory.json"))) as Cfg;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

test("the repo has a claude md that names the commands that check it", () => {
  const text = read(join(REPO, "CLAUDE.md"));
  for (const needle of ["tools/run_tests.ts", "tools/check_skills.ts", "software-factory/README.md", "factory:ready", "#114"]) {
    expect(text).toContain(needle);
  }
  expect(isFile(join(REPO, "tools", "run_tests.ts")) && isFile(join(REPO, "tools", "check_skills.ts"))).toBe(true);
});

test("the factory settings of this repo are valid and take tasks from issues", () => {
  const p = runBun(join(HOOKS, "factory_settings.ts"), ["validate"], { cwd: REPO, env: { ...process.env, CLAUDE_PROJECT_DIR: REPO } });
  expect(p.code === 0 && p.stdout.includes("valid"), p.out).toBe(true);
  const cfg = config();
  expect(cfg.tasks.source).toBe("issues");
  expect(cfg.commands.test).toBe("bun tools/run_tests.ts");
});

test("what governs the agents is protected and the notes folder exists", () => {
  const cfg = config();
  for (const path of ["CLAUDE.md", ".claude/factory.json", ".github/workflows/check.yml", "software-factory/hooks/pr-gate.ts",
    "software-factory/hooks/factory_guard.ts", "software-factory/kit/.claude/settings.json",
    "software-factory/kit/.claude/agents/reviewer.md", "tools/build_release.ts", "software-factory/VERSION"]) {
    expect(cfg.protected.some((rx) => new RegExp(rx).test(path)), path).toBe(true);
  }
  // ordinary code can self-merge
  expect(cfg.protected.some((rx) => new RegExp(rx).test("software-factory/hooks/factory_doctor.ts"))).toBe(false);
  expect(statSync(join(REPO, cfg.notes ?? ".claude/factory/notes")).isDirectory()).toBe(true);
});

test("every link the repo uses for its own factory points at a real file inside software factory", () => {
  const links = [join(REPO, "factory"), join(REPO, "factory-loop.sh")];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) links.push(p);
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(join(REPO, ".claude"));
  expect(links.length, links.join("\n")).toBeGreaterThan(20);
  for (const link of links) {
    const rel = relative(REPO, link);
    expect(lstatSync(link).isSymbolicLink(), link).toBe(true);
    expect(existsSync(link) && isFile(realpathSync(link)), `${rel} is a dangling link`).toBe(true);
    const target = realpathSync(link);
    expect(target.startsWith(SF + sep), `${rel} leaves software-factory/`).toBe(true);
    expect(!target.includes("/kit/.claude/hooks/") && !target.includes("/kit/.claude/ci/"), `${link} goes through a forwarder`).toBe(true);
  }
  accessSync(join(REPO, "factory"), constants.X_OK);
});

test("the repos own factory command runs from its root", () => {
  const p = sh(["bash", join(REPO, "factory"), "help"], { cwd: REPO });
  expect(p.code === 0 && p.stdout.includes("update"), p.stderr).toBe(true);
});
