// Every agent's avatar in the web app (#437): an original illustration drawn in the page as SVG from the agent's name and
// role, in a colour of its own, so a project installs nothing; the owner's own image when the project has one; and the
// agent's initials in its colour when that image can't be shown. web/avatar.ts holds the rules, with no React in it.
import { expect, test } from "bun:test";
import { agentColor, avatarSrc, avatarSvg, initials, initialsSrc } from "../web/avatar.ts";

const NAMES = ["menelik", "taytu", "haile", "fasil", "mentewab", "tewodros", "zara", "yohannes"];

function svgOf(src: string): string {
  expect(src.startsWith("data:image/svg+xml,")).toBe(true);
  return decodeURIComponent(src.slice("data:image/svg+xml,".length));
}

test("an agent's colour is its own: the same each time, and different agents differ", () => {
  for (const n of NAMES) expect(agentColor(n)).toBe(agentColor(n));
  expect(new Set(NAMES.map(agentColor)).size).toBe(NAMES.length);
  for (const n of NAMES) expect(agentColor(n)).toMatch(/^#[0-9a-f]{6}$/);
});

test("the illustration is the same for the same name and role, and differs by name and by role", () => {
  expect(avatarSvg("haile", "coding-agent")).toBe(avatarSvg("haile", "coding-agent"));
  expect(new Set(NAMES.map((n) => avatarSvg(n, "coding-agent"))).size).toBe(NAMES.length);
  const byRole = ["coding-agent", "dev-manager", "product-owner"].map((r) => avatarSvg("haile", r));
  expect(new Set(byRole).size).toBe(3);
});

test("the illustration is an SVG in the agent's colour, with no script, no link out and no text from the name", () => {
  const svg = avatarSvg("taytu", "dev-manager");
  expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
  expect(svg).toContain(agentColor("taytu"));
  expect(svg).not.toMatch(/<script|href=|<text|<image|<foreignObject/i);
  expect(svg).not.toContain("taytu");
});

test("an unknown role draws as a coding agent", () => {
  expect(avatarSvg("haile", "")).toBe(avatarSvg("haile", "coding-agent"));
  expect(avatarSvg("haile", "night-watch")).toBe(avatarSvg("haile", "coding-agent"));
});

test("the avatar's address: the owner's image when there is one, else the drawn illustration", () => {
  expect(svgOf(avatarSrc("haile", "coding-agent"))).toBe(avatarSvg("haile", "coding-agent"));
  expect(svgOf(avatarSrc("haile", "coding-agent", null))).toBe(avatarSvg("haile", "coding-agent"));
  expect(avatarSrc("haile", "coding-agent", "data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
  // only an image the server read is taken: anything else draws the illustration
  expect(svgOf(avatarSrc("haile", "coding-agent", "javascript:alert(1)"))).toBe(avatarSvg("haile", "coding-agent"));
  expect(svgOf(avatarSrc("haile", "coding-agent", "https://example.com/a.png"))).toBe(avatarSvg("haile", "coding-agent"));
});

test("initials: the first letter of each of the first two parts, else the first two letters", () => {
  expect(initials("haile")).toBe("HA");
  expect(initials("dev-manager")).toBe("DM");
  expect(initials("my_skills.agents")).toBe("MS");
  expect(initials("x")).toBe("X");
  expect(initials("")).toBe("?");
});

test("the fallback: the initials on the agent's colour, with the name's characters escaped", () => {
  const svg = svgOf(initialsSrc("haile"));
  expect(svg).toContain(agentColor("haile"));
  expect(svg).toContain(">HA</text>");
  const odd = svgOf(initialsSrc("<b"));
  expect(odd).toContain("&lt;B");
  expect(odd).not.toContain("<b");
  expect(odd).not.toMatch(/<script/i);
});
