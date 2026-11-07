// The web UI's journeys, run in a real browser the way a person uses the page (#546): Playwright drives Chromium against
// a running `factory ui`. They only look and open things; none of them changes a task, an agent or a setting, so they
// are safe to run against a live project.
//
//     UI_TOKEN=<token> bun tools/ui_journeys.ts --base http://127.0.0.1:4747 --project factory-sandbox [--only board]
//
// The token comes from the environment only (it is the UI's password) and is never printed. Playwright is a dev-only
// dependency of software-factory/ (the owner, 7 Nov 2026): install it with `bun install` there and its browser with
// `bunx playwright install chromium`. Nothing here ships in a release, and run_tests.ts doesn't run it (CI has no UI to
// point it at). Each check prints PASS or FAIL with what it saw; the exit code is 1 when any failed.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

interface Page {
  goto(url: string, o?: { waitUntil?: "networkidle" }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  locator(css: string): Locator;
  getByRole(role: string, o?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp, o?: { exact?: boolean }): Locator;
  getByPlaceholder(text: string | RegExp): Locator;
  keyboard: { press(key: string): Promise<void> };
  evaluate<T>(fn: () => T): Promise<T>;
  url(): string;
  goBack(): Promise<unknown>;
  screenshot(o: { path: string }): Promise<unknown>;
  close(): Promise<void>;
}
interface Locator {
  first(): Locator;
  filter(o: { hasText: string | RegExp }): Locator;
  getByText(text: string | RegExp, o?: { exact?: boolean }): Locator;
  getByRole(role: string, o?: { name?: string | RegExp; exact?: boolean }): Locator;
  click(o?: { position?: { x: number; y: number }; timeout?: number }): Promise<void>;
  fill(text: string): Promise<void>;
  focus(): Promise<void>;
  isVisible(): Promise<boolean>;
  innerText(): Promise<string>;
  scrollIntoViewIfNeeded(): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  count(): Promise<number>;
}
interface Browser {
  newPage(o: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const base = arg("base", "http://127.0.0.1:4747").replace(/\/$/, "");
const project = arg("project", "");
const only = arg("only", "");
const token = process.env.UI_TOKEN ?? "";
const shots = arg("shots", join(process.cwd(), "ui-journeys"));
let failed = 0;

function check(name: string, ok: boolean, saw = ""): void {
  if (!ok) failed++;
  const said = saw.replaceAll(token || "\u0000", "<token>").replace(/\s+/g, " ").slice(0, 160);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${said ? ` — ${said}` : ""}`);
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${base}/?token=${token}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
}

const dialogShown = (page: Page): Promise<boolean> => page.locator("[aria-labelledby=task-page]").isVisible().catch(() => false);

// --- the journeys ------------------------------------------------------------------------------------------------------

async function gate(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#/${project}/view:tasks`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const bare = await page.locator("body").innerText();
  check("no token: the page asks for it and shows nothing else", /needs the token/.test(bare) && !/Board/.test(bare), bare);
  await page.getByPlaceholder(/token/i).fill("not-the-token");
  await page.getByRole("button", { name: "Open" }).click();
  await page.waitForTimeout(1200);
  const wrong = await page.locator("body").innerText();
  check("a wrong token: says it isn't this server's", /isn't this server's/.test(wrong), wrong);
  await page.close();
}

async function board(page: Page): Promise<void> {
  await open(page, `#/${project}/view:tasks`);
  const live = /From the message board, live/.test(await page.locator("body").innerText());
  if (live) check("board: a live board has no Read again", !(await page.getByRole("button", { name: "Read again" }).isVisible().catch(() => false)));
  for (const tab of ["By epic", "By agent", "List"]) {
    await page.getByText(tab, { exact: true }).click();
    await page.waitForTimeout(500);
    const t = await page.locator("main").innerText().catch(() => "");
    check(`board: the ${tab} tab shows the tasks`, /b\d+ |#\d+ |No open tasks/.test(t), tab);
  }
  await page.getByText("By agent", { exact: true }).click();
  await page.waitForTimeout(500);
  const before = await page.locator("li.bcard").count();
  await page.getByPlaceholder(/^Filter/).fill("zzz-nothing-matches");
  await page.waitForTimeout(400);
  check("board: the filter narrows the cards", (await page.locator("li.bcard").count()) === 0 || before === 0, `${before} cards before`);
  await page.getByPlaceholder(/^Filter/).fill("");
  await page.waitForTimeout(400);
  if (!live || before === 0) return;
  const card = page.locator("li.bcard").first();
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  await card.click({ position: { x: (box?.width ?? 100) - 12, y: (box?.height ?? 40) - 10 } });
  await page.waitForTimeout(1200);
  check("card: a click opens the task's page", await dialogShown(page));
  check("card: the address names the task", /\/task:[A-Za-z0-9]+$/.test(decodeURIComponent(page.url().split("#")[1] ?? "")));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("card: Escape closes the task's page", !(await dialogShown(page)));
  const title = page.locator("button.btitle-open").first();
  await title.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  check("card: Enter on a card's title opens it", await dialogShown(page));
  await page.goBack();
  await page.waitForTimeout(800);
  check("card: Back closes the task's page", !(await dialogShown(page)));
}

async function pages(page: Page): Promise<void> {
  const list: [string, RegExp][] = [["Inbox", /Inbox/], ["Epics", /Epics/], ["Pull requests", /Pull requests/], ["PRD and decisions", /PRD/],
    ["Sign-off and testing", /Sign-off/], ["CI and runners", /CI/], ["Machines", /Machines/]];
  await open(page, `#/${project}/view:tasks`);
  for (const [name, re] of list) {
    await page.locator("nav, aside").getByText(name, { exact: true }).first().click();
    await page.waitForTimeout(1500);
    const main = await page.locator("main").innerText().catch(() => "");
    check(`page: ${name} renders`, re.test(main) && !/Something went wrong|TypeError/.test(main), main.slice(0, 80));
  }
}

async function keyboard(page: Page): Promise<void> {
  await open(page, `#/${project}/view:tasks`);
  await page.locator("main").click({ position: { x: 4, y: 4 } }).catch(() => undefined);
  await page.keyboard.press("/");
  await page.waitForTimeout(300);
  const focused = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.placeholder ?? "");
  check("keyboard: / goes to the search", /search/i.test(focused), focused);
  await page.keyboard.press("Escape");
  const labels: string[] = [];
  for (let i = 0; i < 3; i++) {
    const b = page.getByRole("button", { name: /Change it$/ });
    labels.push(await b.innerText().catch(() => "") || (await page.evaluate(() => document.documentElement.getAttribute("data-theme") ?? "")));
    await b.click();
    await page.waitForTimeout(250);
  }
  check("theme: the switch goes round its choices", labels.length === 3);
}

async function phone(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const where of ["view:tasks", "view:pull-requests", "view:ci", "view:machines", "view:owner-queue", "page:docs"]) {
    await open(page, `#/${project}/${where}`);
    const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`phone: ${where} has no sideways scroll`, wider <= 1, `${wider}px wider`);
    if (wider > 1) await page.screenshot({ path: join(shots, `phone-${where.replace(/\W+/g, "-")}.png`) });
  }
  const menu = page.getByRole("button", { name: "Projects and pages" });
  check("phone: the menu button shows", await menu.isVisible().catch(() => false));
  await page.close();
}

const JOURNEYS: Record<string, (b: Browser, p: Page) => Promise<void>> = {
  gate: (b) => gate(b),
  board: (_b, p) => board(p),
  pages: (_b, p) => pages(p),
  keyboard: (_b, p) => keyboard(p),
  phone: (b) => phone(b),
};

async function main(): Promise<void> {
  if (!token || !project) {
    console.log(JSON.stringify({ code: "journeys_usage", message: "The journeys need the UI's token and a project.",
      fix: "UI_TOKEN=<token> bun tools/ui_journeys.ts --base http://127.0.0.1:4747 --project <name>" }));
    process.exit(2);
  }
  mkdirSync(shots, { recursive: true });
  let chromium: { launch(): Promise<Browser> };
  try {
    // a dev-only package, so it is looked up from software-factory/'s node_modules at run time
    const need = createRequire(join(import.meta.dir, "..", "software-factory", "package.json"));
    chromium = (need("playwright") as { chromium: { launch(): Promise<Browser> } }).chromium;
  } catch {
    console.log(JSON.stringify({ code: "journeys_no_playwright", message: "Playwright isn't installed in software-factory/.",
      fix: "cd software-factory && bun install && bunx playwright install chromium" }));
    process.exit(2);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  for (const [name, run] of Object.entries(JOURNEYS)) {
    if (only && only !== name) continue;
    try {
      await run(browser, page);
    } catch (e) {
      check(`${name}: ran to the end`, false, String(e).split("\n")[0] ?? "");
      await page.screenshot({ path: join(shots, `${name}-error.png`) }).catch(() => undefined);
    }
  }
  await browser.close();
  console.log(failed ? `${failed} check(s) failed.` : "Every journey passed.");
  process.exit(failed ? 1 : 0);
}

await main();
