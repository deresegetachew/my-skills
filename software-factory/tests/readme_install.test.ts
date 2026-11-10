// The README's install section (#541): step 2 installs the archive that was downloaded and checked, not a fresh download.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SF } from "./support.ts";

const README = readFileSync(join(SF, "README.md"), "utf8");

function installSection(): string {
  const m = /^### 1\. Install the factory in the project\n([\s\S]*?)(?:^##+ |(?![\s\S]))/m.exec(README);
  expect(m, "the README has no '### 1. Install the factory in the project' section").toBeTruthy();
  return (m as RegExpExecArray)[1] as string;
}

test("the first command of the install section installs the checked archive with its checksums", () => {
  const block = /```bash\n([\s\S]*?)```/.exec(installSection());
  expect(block, "the install section has no bash block").toBeTruthy();
  const cmd = (block as RegExpExecArray)[1] as string;
  expect(cmd).toContain("bun --no-env-file --config=/dev/null");
  expect(cmd).toMatch(/hooks\/factory_release\.ts update --archive \S+/);
  expect(cmd).toContain("--sums SHA256SUMS");
  expect(cmd, "the command must not download by version").not.toMatch(/factory_release\.ts update <version>/);
});

test("downloading by version is still mentioned as the online alternative", () => {
  expect(installSection()).toContain("update <version>");
});
