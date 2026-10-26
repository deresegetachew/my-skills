#!/usr/bin/env -S bun --no-env-file
// CI check: every top-level skill folder is well formed.
//
// - SKILL.md exists, with frontmatter: `name:` matching the folder and a non-empty `description:`.
// - Every .sh parses (bash -n), every .ts parses (and uses no `any`), every .json loads, and there is no .py file.
// - No compiled .pyc file is tracked by git.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const errors: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue; // a dangling link
    }
    if (st.isDirectory()) {
      if (!lstatSync(p).isSymbolicLink()) walk(p, out); // linked folders are checked where they really are
    }
    else out.push(p);
  }
  return out;
}

const skills = readdirSync(root).filter(
  (d) => !d.startsWith(".") && d !== "tools" && d !== "node_modules" && statSync(join(root, d)).isDirectory(),
);
if (!skills.length) errors.push("no skill folders found");
for (const d of skills) {
  const md = join(root, d, "SKILL.md");
  if (!existsSync(md)) {
    errors.push(`${d}: no SKILL.md`);
    continue;
  }
  const m = /^---\nname: (\S+)\ndescription: ([\s\S]+?)\n---\n/.exec(readFileSync(md, "utf8"));
  if (!m) errors.push(`${d}/SKILL.md: frontmatter must be ---\\nname: ...\\ndescription: ...\\n---`);
  else if (m[1] !== d) errors.push(`${d}/SKILL.md: name "${m[1]}" must match the folder name`);
  else if (!(m[2] ?? "").trim()) errors.push(`${d}/SKILL.md: empty description`);
}

const files = walk(root);
const rel = (f: string): string => relative(root, f);
const transpiler = new Bun.Transpiler({ loader: "ts" });
const pyFiles: string[] = [];
for (const f of files) {
  if (f.endsWith(".sh")) {
    if (Bun.spawnSync(["bash", "-n", f], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) errors.push(`${rel(f)}: bash -n fails`);
  } else if (f.endsWith(".ts") && !f.endsWith(".d.ts")) {
    const text = readFileSync(f, "utf8");
    // #252: strict TypeScript and no `any` in the factory's code (test fakes written inside strings are not code).
    if (!rel(f).includes("/tests/") && rel(f) !== "tools/check_skills.ts" && /(:\s*any\b|\bas any\b|<any>|\bany\[\])/.test(text)) errors.push(`${rel(f)}: uses \`any\`; use unknown and narrow it`);
    try {
      transpiler.transformSync(text);
    } catch (e) {
      errors.push(`${rel(f)}: does not parse: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  } else if (f.endsWith(".json")) {
    try {
      JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      errors.push(`${rel(f)}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (f.endsWith(".py")) pyFiles.push(f);
}
// #252: the factory is Bun only. No Python file may come back.
for (const f of pyFiles) errors.push(`${rel(f)}: a Python file; the factory is TypeScript on Bun (#252)`);
const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "ignore" });
for (const name of tracked.exitCode === 0 ? tracked.stdout.toString().split("\0") : []) {
  if (name.endsWith(".pyc") || name.includes("__pycache__/")) errors.push(`${name}: compiled file is tracked; run: git rm --cached ${name}`);
}
console.log(errors.length ? errors.join("\n") : `ok: ${skills.length} skills checked`);
process.exit(errors.length ? 1 : 0);
