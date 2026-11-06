// The Docs section's rules that aren't the API's (#438): Markdown read into headings, paragraphs, lists, tables and links;
// links between pages; and the citations (`decision 0004`, `US-12`) that link straight to a page. web/docs_model.ts holds
// them, with no React in it.
import { expect, test } from "bun:test";
import { citations, headingId, linkTarget, parseMarkdown, type DocPage } from "../web/docs_model.ts";

const PAGES: DocPage[] = [
  { id: "prd", title: "PRD", path: "docs/PRD.md" },
  { id: "decisions/0004-agent-messaging-nats", title: "0004: Agent messaging over NATS", path: "docs/decisions/0004-agent-messaging-nats.md" },
  { id: "decisions/0005-web-ui", title: "0005: Web UI", path: "docs/decisions/0005-web-ui.md" },
  { id: "wiki/commands", title: "Commands", path: "docs/wiki/commands.md" },
];

test("headings, paragraphs, lists, tables, code and quotes become blocks; inline code, bold and links inside text", () => {
  const md = "# Title\n\nSome **bold** and `code` and [a link](./x.md#top).\n\n- one\n- two\n\n1. first\n2. second\n\n" +
    "| Name | Value |\n|---|---|\n| a | 1 |\n| b | `2` |\n\n```ts\nconst a = 1;\n```\n\n> quoted\n";
  const b = parseMarkdown(md);
  expect(b.map((x) => x.type)).toEqual(["heading", "paragraph", "list", "list", "table", "code", "quote"]);
  expect(b[0]).toMatchObject({ type: "heading", level: 1, id: "title" });
  expect(b[1]).toMatchObject({ type: "paragraph", inlines: [{ text: "Some " }, { bold: "bold" }, { text: " and " }, { code: "code" },
    { text: " and " }, { text: "a link", href: "./x.md#top" }, { text: "." }] });
  expect(b[2]).toMatchObject({ type: "list", ordered: false });
  expect((b[3] as { items: unknown[] }).items).toHaveLength(2);
  expect(b[4]).toMatchObject({ type: "table", head: ["Name", "Value"] });
  expect((b[4] as { rows: unknown[][] }).rows).toHaveLength(2);
  expect(b[5]).toMatchObject({ type: "code", lang: "ts", text: "const a = 1;" });
});

test("a heading's id is its text in lower case with dashes, and a story's bullet gets the id of its US number", () => {
  expect(headingId("4.5 The owner")).toBe("4-5-the-owner");
  expect(headingId("Use `Bun`!")).toBe("use-bun");
  const b = parseMarkdown("- **US-12.** As the owner, I see it.\n- plain\n");
  expect((b[0] as { items: { id: string | null }[] }).items.map((i) => i.id)).toEqual(["us-12", null]);
});

test("nothing in a page is run: raw HTML is text, and only http, https, mailto, page and # links are links", () => {
  const b = parseMarkdown("<script>alert(1)</script> [x](javascript:alert(1)) [y](https://e.com)\n");
  const p = b[0] as { inlines: { text?: string; href?: string }[] };
  expect(p.inlines.some((i) => i.href?.startsWith("javascript"))).toBe(false);
  expect(p.inlines.find((i) => i.href)?.href).toBe("https://e.com");
  expect(p.inlines.map((i) => i.text ?? "").join("")).toContain("<script>");
});

test("a link goes to a page of the docs (relative to the page it is in), to the web, or nowhere", () => {
  expect(linkTarget("decisions/0005-web-ui", "./0004-agent-messaging-nats.md", PAGES)).toEqual({ kind: "page", id: "decisions/0004-agent-messaging-nats", anchor: "" });
  expect(linkTarget("decisions/0005-web-ui", "../PRD.md#5-out-of-scope", PAGES)).toEqual({ kind: "page", id: "prd", anchor: "5-out-of-scope" });
  expect(linkTarget("wiki/commands", "#usage", PAGES)).toEqual({ kind: "page", id: "wiki/commands", anchor: "usage" });
  expect(linkTarget("wiki/commands", "https://example.com/a", PAGES)).toEqual({ kind: "web", url: "https://example.com/a" });
  expect(linkTarget("wiki/commands", "../../../etc/passwd.md", PAGES)).toEqual({ kind: "none" });
  expect(linkTarget("wiki/commands", "javascript:alert(1)", PAGES)).toEqual({ kind: "none" });
});

test("text that cites a decision or a PRD story links straight to it; what isn't a page stays text", () => {
  const t = "Per decision 0004 and ADR 5, see PRD: US-12 (and US-3); decision 0099 is not here.";
  const parts = citations(t, PAGES);
  expect(parts.filter((p) => p.link).map((p) => [p.text, p.link])).toEqual([
    ["decision 0004", { id: "decisions/0004-agent-messaging-nats", anchor: "" }],
    ["ADR 5", { id: "decisions/0005-web-ui", anchor: "" }],
    ["US-12", { id: "prd", anchor: "us-12" }],
    ["US-3", { id: "prd", anchor: "us-3" }]]);
  expect(parts.map((p) => p.text).join("")).toBe(t);
  expect(citations("no citation here", PAGES)).toEqual([{ text: "no citation here" }]);
  expect(citations("US-1", PAGES.slice(1)).every((p) => !p.link)).toBe(true); // no PRD: no link
});
