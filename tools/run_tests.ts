#!/usr/bin/env -S bun --no-env-file
// Run the software factory's tests: each software-factory/tests/*.test.ts file with `bun test`, in its own process,
// with its own scratch folders. Exits 1 if any test fails, so CI goes red.
//
// Files run in parallel (--jobs N, or FACTORY_TEST_JOBS, default min(CPU count, 8)), biggest first. Each file's report
// is printed whole when it finishes, so output never interleaves. Arguments that are not options pick files by name
// (`bun tools/run_tests.ts issues` runs tests/issues.test.ts).
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TESTS = join(ROOT, "software-factory", "tests");
const TIMEOUT_MS = 600_000;

interface Result {
  rel: string;
  code: number;
  out: string;
  seconds: number;
}

function jobCount(argv: string[]): number {
  let value: string | undefined;
  argv.forEach((arg, i) => {
    if (arg === "--jobs" && i + 1 < argv.length) value = argv[i + 1];
    else if (arg.startsWith("--jobs=")) value = arg.slice(7);
  });
  value = value || process.env.FACTORY_TEST_JOBS;
  if (!value) return Math.min(availableParallelism() || 1, 8);
  const n = Number(value);
  if (!Number.isInteger(n)) {
    process.stderr.write(`jobs must be a whole number, got '${value}'\n`);
    process.exit(1);
  }
  return Math.max(1, n);
}

function testFiles(argv: string[]): string[] {
  const picks: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--jobs") i++;
    else if (!a.startsWith("-")) picks.push(a.replace(/^.*\//, "").replace(/(\.test)?\.ts$/, ""));
  }
  const all = readdirSync(TESTS).filter((f) => f.endsWith(".test.ts")).sort();
  return (picks.length ? all.filter((f) => picks.includes(f.replace(/\.test\.ts$/, ""))) : all).map((f) => join(TESTS, f));
}

/** "N passed, M failed" from bun test's own summary lines (" 12 pass", " 1 fail"). */
function summary(out: string): string {
  const pass = /^\s*(\d+) pass\s*$/m.exec(out);
  const failN = /^\s*(\d+) fail\s*$/m.exec(out);
  if (!pass && !failN) {
    const lines = out.trim().split("\n");
    return lines[lines.length - 1] || "no output";
  }
  return `${pass ? pass[1] : 0} passed, ${failN ? failN[1] : 0} failed`;
}

async function runFile(path: string): Promise<Result> {
  const start = Date.now();
  const rel = relative(ROOT, path);
  // Files run side by side, so none may write to the real machine-wide places (the machine id, the boot log): each
  // gets its own. The tests make their folders under TMPDIR and do not remove them: the scratch folder goes at the end.
  const scratch = mkdtempSync(join(tmpdir(), "factory-test-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, {
    FACTORY_CONFIG_DIR: join(scratch, "config"),
    XDG_STATE_HOME: join(scratch, "state"),
    TMPDIR: join(scratch, "tmp"),
    // `pick` waits 2 s after claiming for a simultaneous claim; the tests' claims are made up in advance.
    FACTORY_CLAIM_SETTLE_SECONDS: "0",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  });
  mkdirSync(env.TMPDIR as string);
  let code = 1;
  let out = "";
  try {
    // Output goes to files, not pipes: a test that leaves a background process behind would hold a pipe open.
    const outFile = join(scratch, "out.txt");
    const proc = Bun.spawn([process.execPath, "--no-env-file", "test", "--timeout", "120000", path], {
      cwd: ROOT,
      env,
      stdin: "ignore",
      stdout: Bun.file(outFile),
      stderr: Bun.file(outFile),
    });
    const timer = setTimeout(() => proc.kill(9), TIMEOUT_MS);
    code = await proc.exited;
    clearTimeout(timer);
    out = await Bun.file(outFile).text();
    if (proc.signalCode === "SIGKILL") out += `\ntimed out after ${TIMEOUT_MS / 1000} s\n`;
  } catch (e) {
    out = "test runner error:\n" + (e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { rel, code, out, seconds: (Date.now() - start) / 1000 };
}

function annotate(rel: string, out: string): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const lines = out.trim().split("\n").filter((l) => l.trim());
  const text = lines.slice(0, 25).join("\n").slice(0, 1800).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::error file=${rel},title=test failure::${text}`);
}

async function main(argv: string[]): Promise<number> {
  const files = testFiles(argv);
  if (!files.length) {
    console.log("no test files found");
    return 1;
  }
  const jobs = jobCount(argv);
  const queue = [...files].sort((a, b) => statSync(b).size - statSync(a).size);
  const failed: string[] = [];
  const start = Date.now();
  const worker = async (): Promise<void> => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await runFile(f);
      console.log(`${r.rel}: ${summary(r.out)} (${r.seconds.toFixed(0)} s)`);
      if (r.code !== 0) {
        failed.push(r.rel);
        console.log(r.out);
        annotate(r.rel, r.out);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
  console.log(`${files.length - failed.length} of ${files.length} test files passed`);
  console.log(`${jobs} jobs, ${((Date.now() - start) / 1000).toFixed(0)} s in all`);
  return failed.length ? 1 : 0;
}

process.exit(await main(process.argv.slice(2)));
