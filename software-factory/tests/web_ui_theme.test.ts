// The web app's look (#450): the owner's palette, docs/design/web-ui/theme.css, is the app's only colours, light and
// dark, and the page follows the system's setting until the owner picks one. Reads web/theme.ts and web/theme_model.ts
// as they are (no React), and the web app's sources as text, the way check_skills reads files.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_CSS } from "../web/theme.ts";
import { nextTheme, THEME_KEY, themeLabel, themeOf } from "../web/theme_model.ts";
import { SF } from "./support.ts";

const DESIGN = readFileSync(join(SF, "docs", "design", "web-ui", "theme.css"), "utf8");
const WEB = join(SF, "web");

/** The `--name: value` pairs of the block whose selector starts with `selector`, in order. */
function block(css: string, selector: string): Array<[string, string]> {
  const at = css.indexOf(selector);
  if (at < 0) return [];
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return [...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] as string, (m[2] as string).trim()]);
}

/** The app's own sources: what ends up in the page's bundle. */
function sources(): Array<[string, string]> {
  return readdirSync(WEB).filter((f) => /\.tsx?$/.test(f)).map((f) => [f, readFileSync(join(WEB, f), "utf8")]);
}

/** What in a source is style: each stylesheet string (`… CSS = \`…\``) and each line with an inline style. */
function styles(text: string): string[] {
  const sheets = [...text.matchAll(/CSS = (?:String\.raw)?`([^`]*)`/g)].map((m) => m[1] as string);
  return [...sheets, ...text.split("\n").filter((l) => /style=\{\{/.test(l))];
}

test("the app's palette is theme.css: every variable, the same value, in light and in dark", () => {
  const light = block(DESIGN, ":root, [data-theme=\"light\"]");
  const dark = block(DESIGN, "[data-theme=\"dark\"]");
  expect(light.length).toBeGreaterThan(30);
  expect(dark.length).toBeGreaterThan(20);
  expect(block(THEME_CSS, ":root, [data-theme=\"light\"]")).toEqual(light);
  expect(block(THEME_CSS, "[data-theme=\"dark\"]")).toEqual(dark);
});

test("no colour is written in the app's styles except through the palette (an avatar's drawing and white on a dot aside)", () => {
  const hex = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z])|rgba?\(|hsla?\(/g;
  const found: string[] = [];
  let sheets = 0;
  for (const [f, text] of sources()) {
    if (f === "theme.ts" || f === "avatar.ts") continue;
    for (const s of styles(text)) {
      sheets++;
      for (const m of s.match(hex) ?? []) if (!/^#fff(fff)?$/i.test(m)) found.push(`${f}: ${m}`);
    }
  }
  expect(sheets).toBeGreaterThan(5);
  expect(found).toEqual([]);
});

test("every colour variable the app's styles use is one of theme.css's", () => {
  const names = new Set([...block(DESIGN, ":root, [data-theme=\"light\"]"), ...block(DESIGN, "[data-theme=\"dark\"]")].map(([n]) => n));
  const layout = new Set(["--radius", "--font", "--mono", "--title-font"]); // sizes and type, not colours
  const unknown = new Set<string>();
  for (const [f, text] of sources()) {
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const name = m[1] as string;
      if (!names.has(name) && !layout.has(name)) unknown.add(`${f}: ${name}`);
    }
  }
  expect([...unknown]).toEqual([]);
});

test("no shadow anywhere: a card is a flat fill or a hairline", () => {
  const found: string[] = [];
  for (const [f, text] of sources()) {
    for (const m of text.matchAll(/box-shadow\s*:\s*([^;}`]+)/g)) if ((m[1] as string).trim() !== "none") found.push(`${f}: ${m[0]}`);
  }
  expect(found).toEqual([]);
});

test("the page follows the system's setting until the owner picks light or dark", () => {
  expect(themeOf(null, false)).toBe("light");
  expect(themeOf(null, true)).toBe("dark");
  expect(themeOf("system", true)).toBe("dark");
  expect(themeOf("system", false)).toBe("light");
  expect(themeOf("light", true)).toBe("light");
  expect(themeOf("dark", false)).toBe("dark");
  expect(themeOf("purple", true)).toBe("dark"); // a kept value it doesn't know follows the system
  expect(THEME_KEY).toBe("factory-ui-theme");
});

test("the switch goes system, light, dark and back, and says in words what it does now", () => {
  expect(nextTheme("system")).toBe("light");
  expect(nextTheme("light")).toBe("dark");
  expect(nextTheme("dark")).toBe("system");
  expect(nextTheme(null)).toBe("light");
  expect(themeLabel("system")).toBe("Theme: follows the system");
  expect(themeLabel("light")).toBe("Theme: light");
  expect(themeLabel("dark")).toBe("Theme: dark");
  expect(themeLabel(null)).toBe("Theme: follows the system");
});
