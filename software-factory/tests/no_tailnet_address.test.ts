// A machine's real Tailscale address is never committed (owner, 7 Nov 2026, #293): it is per-machine config, kept in
// MB_URL or <machine settings folder>/message-board/url. Docs and designs write the placeholder 100.x.y.z.
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git, ROOT } from "./support.ts";

// Tailscale hands out addresses in 100.64.0.0/10: second number 64 to 127.
const TAILNET = /(?<![\d.])100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(\d{1,3})\.(\d{1,3})(?![\d])/g;

// Addresses that are no machine's: the range's own start (100.64.0.0/10), Tailscale's fixed DNS address, and the two
// example addresses the tests and the wiki use for a made-up machine.
const ALLOWED = new Set(["100.64.0.0", "100.100.100.100", "100.64.0.1", "100.64.0.7"]);

function tailnetAddresses(text: string): string[] {
  return [...text.matchAll(TAILNET)].map((m) => m[0]).filter((a) => !ALLOWED.has(a));
}

test("the check finds a real tailnet address and lets the placeholder and the allowed ones through", () => {
  // built from parts, so this file itself holds no address
  const a = ["100", "101", "22", "3"].join(".");
  const b = ["100", "127", "0", "9"].join(".");
  expect(tailnetAddresses(`hub at ${a}:4222, also ${b}`)).toEqual([a, b]);
  expect(tailnetAddresses("hub at 100.x.y.z:4222; range 100.64.0.0/10; dns 100.100.100.100; 100.63.1.1; 1100.70.1.1")).toEqual([]);
});

test("no tracked file holds a real Tailscale address", () => {
  const found: string[] = [];
  for (const rel of git(ROOT, "ls-files", "-z").split("\0").filter(Boolean)) {
    const path = join(ROOT, rel);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    for (const a of tailnetAddresses(readFileSync(path, "utf8"))) found.push(`${rel}: ${a}`);
  }
  expect(found, "write 100.x.y.z instead; the real address lives only on the machine (MB_URL or its url file)").toEqual([]);
});
