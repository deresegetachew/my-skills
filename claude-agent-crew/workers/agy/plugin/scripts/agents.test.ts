import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// agy gives an agent without a `tools:` list only a small hosted set (no terminal, no file edits),
// so every crew agent must name its tools, and the hook must find bun outside a login shell.
const PLUGIN = resolve(import.meta.dir, "..");
const WRITE_ROLES = ["builder", "test-writer", "journey-tester", "designer"];

function tools(name: string): string[] {
  const front = readFileSync(join(PLUGIN, "agents", `${name}.md`), "utf8").split("---")[1] ?? "";
  const block = /\ntools:\n((?:\s+- \S+\n)+)/.exec(front)?.[1] ?? "";
  return block.split("\n").map((l) => l.replace(/^\s+- /, "").trim()).filter(Boolean);
}

describe("crew agents", () => {
  test("every agent declares its tools", () => {
    for (const file of readdirSync(join(PLUGIN, "agents")).filter((f) => f.endsWith(".md"))) {
      expect({ agent: file, tools: tools(file.replace(/\.md$/, "")).length > 0 }).toEqual({ agent: file, tools: true });
    }
  });

  test("roles that change code can run commands and edit files", () => {
    for (const role of WRITE_ROLES) {
      expect(tools(role)).toEqual(expect.arrayContaining(["read_file", "edit_file", "write_file", "run_command"]));
    }
  });

  test("review roles cannot edit files or run commands", () => {
    for (const role of ["reviewer", "security-reviewer", "architecture-reviewer", "design-check", "researcher"]) {
      const t = tools(role);
      expect(t).not.toContain("edit_file");
      expect(t).not.toContain("write_file");
      expect(t).not.toContain("run_command");
    }
  });

  test("the guard hook puts bun's default folder on PATH", () => {
    const hooks = readFileSync(join(PLUGIN, "hooks.json"), "utf8");
    expect(hooks).toContain('PATH=\\"$HOME/.bun/bin:$PATH\\" bun ./scripts/guard.ts');
  });
});
