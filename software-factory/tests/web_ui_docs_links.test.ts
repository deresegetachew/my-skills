// Links between pages stay on their own side (#438): the wiki is the factory's, the PRD and decisions are the project's,
// so a wiki page's `../decisions/...` is the factory's decision, not the project's page with the same path.
import { expect, test } from "bun:test";
import { type DocPage, linkTarget } from "../web/docs_model.ts";

const PAGES: DocPage[] = [
  { id: "prd", title: "PRD", path: "docs/PRD.md" },
  { id: "decisions/0005-web-ui", title: "0005: Web UI", path: "docs/decisions/0005-web-ui.md" },
  { id: "wiki/commands", title: "Commands", path: "docs/wiki/commands.md" },
  { id: "wiki/settings", title: "Settings", path: "docs/wiki/settings.md" },
];

test("a wiki page's link to the factory's decisions or PRD is no page of the project's", () => {
  expect(linkTarget("wiki/commands", "../decisions/0005-web-ui.md", PAGES)).toEqual({ kind: "none" });
  expect(linkTarget("wiki/commands", "../PRD.md#scope", PAGES)).toEqual({ kind: "none" });
});

test("a wiki page still links to another wiki page, and a project page never opens a wiki page", () => {
  expect(linkTarget("wiki/commands", "settings.md#ui", PAGES)).toEqual({ kind: "page", id: "wiki/settings", anchor: "ui" });
  expect(linkTarget("decisions/0005-web-ui", "../wiki/commands.md", PAGES)).toEqual({ kind: "none" });
  expect(linkTarget("decisions/0005-web-ui", "../PRD.md", PAGES)).toEqual({ kind: "page", id: "prd", anchor: "" });
});
