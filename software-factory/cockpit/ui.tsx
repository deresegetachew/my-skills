#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The cockpit's Ink UI (decision 0002, #365). A release carries it as one JavaScript file, built with `bun build`
// (cockpit/build.ts), installed as .claude/hooks/factory_cockpit_ink.js: a project runs it with Bun and needs no
// node_modules. In this repo it runs from this source.
//
//   ui.tsx --data <file>   draw the snapshot in <file> (`factory cockpit --json`); on a terminal q or Esc leaves,
//                          off one it draws once and exits
//   ui.tsx --check         print "ok": every module loaded (`factory doctor` runs it)
import { readFileSync } from "node:fs";
import { render, useApp, useInput } from "ink";
import type { ReactElement } from "react";
import { App } from "./app.tsx";

function Interactive({ snapshot }: { snapshot: unknown }): ReactElement {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
  });
  return <App snapshot={snapshot} />;
}

function fail(code: string, message: string, fix: string): number {
  process.stderr.write(JSON.stringify({ code, message, fix }) + "\n");
  return 2;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--check") {
    console.log("ok");
    return 0;
  }
  const file = argv[0] === "--data" && argv.length === 2 ? argv[1] : undefined;
  if (file === undefined) {
    return fail("cockpit_ui_usage", "The cockpit UI takes --data <file> or --check.", "Run `factory cockpit --ink`; it passes the snapshot.");
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (e) {
    return fail("cockpit_ui_data", `The snapshot ${file} can't be read (${e instanceof Error ? e.message : String(e)}).`,
      "Run `factory cockpit --json` to see what the snapshot holds, then `factory cockpit --ink` again.");
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await render(<Interactive snapshot={snapshot} />).waitUntilExit();
    return 0;
  }
  const ink = render(<App snapshot={snapshot} />, { patchConsole: false });
  ink.unmount();
  await ink.waitUntilExit();
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
