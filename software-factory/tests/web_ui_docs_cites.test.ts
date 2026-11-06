// The citations a task or pull request body carries, turned into links to the Docs pages that exist (#438); the same
// targets `citations()` gives for a title.
import { expect, test } from "bun:test";
import { citeLinks, type DocPage } from "../web/docs_model.ts";

const PAGES: DocPage[] = [
  { id: "prd", title: "PRD", path: "docs/PRD.md" },
  { id: "decisions/0004-agent-messaging-nats", title: "0004: Agent messaging over NATS", path: "docs/decisions/0004-agent-messaging-nats.md" },
  { id: "decisions/0005-web-ui", title: "0005: Web UI", path: "docs/decisions/0005-web-ui.md" },
];

test("each cite with a page links to it, in order; a cite with no page is dropped", () => {
  expect(citeLinks(["decision 0004", "US-12", "ADR 5", "decision 0099"], PAGES)).toEqual([
    { text: "decision 0004", link: { id: "decisions/0004-agent-messaging-nats", anchor: "" } },
    { text: "US-12", link: { id: "prd", anchor: "us-12" } },
    { text: "ADR 5", link: { id: "decisions/0005-web-ui", anchor: "" } }]);
});

test("a story cite is dropped when there is no PRD page, and no cites gives no links", () => {
  expect(citeLinks(["US-12"], PAGES.slice(1))).toEqual([]);
  expect(citeLinks([], PAGES)).toEqual([]);
});
