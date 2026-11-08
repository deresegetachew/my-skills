// The Attachments section's rules (#637), from web/attachments_model.ts as it is (no React): the listing's address,
// the sections (images and video shown, test results, logs, the rest as downloads), the words under each, a test
// report's line, why a file is a download, the log's search and its marks, and the gallery's steps and zoom.
import { expect, test } from "bun:test";
import { type AttachmentRow, countText, downloadWhy, groupsOf, listAddress, marks, resultLine, resultTone, searchLog, sizeText, step,
  targetParam, whoLine, zoomedWidth, zoomStep } from "../web/attachments_model.ts";

function row(over: Partial<AttachmentRow> = {}): AttachmentRow {
  return { id: "aaaaaaaaaaaa", name: "a.png", kind: "image", type: "image/png", size: 2048, note: "", by: "taytu", at: "2026-11-08T10:00:00Z",
    head: "abc1234def", old: false, inline: true, file: "/api/projects/work/attachments/aaaaaaaaaaaa/file", ...over };
}

test("the listing's address names the target and the head; a task's #12 is 12", () => {
  expect(targetParam("task", "#12")).toBe("task:12");
  expect(targetParam("pr", "7")).toBe("pr:7");
  expect(listAddress("my work", "pr:7", "abc1234")).toBe("/api/projects/my%20work/attachments?target=pr%3A7&head=abc1234");
  expect(listAddress("work", "task:b3")).toBe("/api/projects/work/attachments?target=task%3Ab3");
});

test("sections: images and video shown, test results, logs, the rest as files; the current head first, newest first", () => {
  const rows = [
    row({ id: "1", name: "old.png", old: true, at: "2026-11-08T12:00:00Z" }),
    row({ id: "2", name: "new.png", at: "2026-11-08T11:00:00Z" }),
    row({ id: "3", name: "newer.png", at: "2026-11-08T11:30:00Z" }),
    row({ id: "4", name: "r.xml", kind: "junit", type: "application/xml", inline: false }),
    row({ id: "5", name: "run.log", kind: "log", type: "text/plain; charset=utf-8", inline: false }),
    row({ id: "6", name: "v.webm", kind: "video", type: "video/webm" }),
    row({ id: "7", name: "r.html", kind: "html", type: "text/html; charset=utf-8", inline: false }),
    row({ id: "8", name: "x.svg", kind: "file", type: "image/svg+xml", inline: false }),
  ];
  const g = groupsOf(rows);
  expect(g.images.map((r) => r.name)).toEqual(["newer.png", "new.png", "old.png"]);
  expect(g.videos.map((r) => r.name)).toEqual(["v.webm"]);
  expect(g.results.map((r) => r.name)).toEqual(["r.xml"]);
  expect(g.logs.map((r) => r.name)).toEqual(["run.log"]);
  expect(g.files.map((r) => r.name)).toEqual(["r.html", "x.svg"]);
});

test("the words: sizes, who and for which head, how many and how many for an older head", () => {
  expect([sizeText(500), sizeText(2048), sizeText(5 * 1024 * 1024 + 300_000)]).toEqual(["500 B", "2 KB", "5.3 MB"]);
  expect(whoLine(row())).toBe("by taytu, for abc1234");
  expect(whoLine(row({ old: true }))).toBe("by taytu, for abc1234 (an older head)");
  expect(whoLine(row({ head: null }))).toBe("by taytu");
  expect(countText([])).toBe("Nothing attached yet.");
  expect(countText([row(), row({ old: true })])).toBe("2 files, 1 for an older head");
  expect(countText([row()])).toBe("1 file");
});

test("a test report's line and dot: ink when something failed, so the one red stays for what needs the owner", () => {
  const s = { ok: true, why: "", tests: 4, passed: 2, failed: 1, skipped: 1, seconds: 1.234, failures: [] };
  expect(resultLine(s)).toBe("2 passed, 1 failed, 1 skipped in 1.2 s");
  expect(resultLine({ ...s, seconds: null })).toBe("2 passed, 1 failed, 1 skipped");
  expect(resultLine({ ...s, ok: false, why: "It isn't well-formed XML." })).toBe("It can't be read: It isn't well-formed XML.");
  expect([resultTone(s), resultTone({ ...s, failed: 0 }), resultTone(undefined)]).toEqual(["ink", "working", "idle"]);
});

test("an HTML report and an SVG say why they are downloads", () => {
  expect(downloadWhy(row({ kind: "html", type: "text/html; charset=utf-8" }))).toContain("never open on this page's address");
  expect(downloadWhy(row({ kind: "file", type: "image/svg+xml" }))).toContain("can carry script");
  expect(downloadWhy(row({ kind: "file", type: "application/zip" }))).toBe("");
});

test("a log's search keeps the lines with the words (any case) and their numbers, and marks each hit", () => {
  const text = "start\nError: login failed\nretry\nerror again\n";
  expect(searchLog(text, "ERROR")).toEqual([{ n: 2, line: "Error: login failed" }, { n: 4, line: "error again" }]);
  expect(searchLog(text, "").length).toBe(5);
  expect(searchLog(text, "", 2).length).toBe(2);
  expect(marks("Error: an error", "error")).toEqual([{ text: "Error", hit: true }, { text: ": an ", hit: false }, { text: "error", hit: true }]);
  expect(marks("plain", "")).toEqual([{ text: "plain", hit: false }]);
});

test("the gallery steps round, and zooms from fitted up to four times", () => {
  expect([step(0, 3, 1), step(2, 3, 1), step(0, 3, -1), step(0, 0, 1)]).toEqual([1, 0, 2, 0]);
  expect([zoomStep(1, 1), zoomStep(1.5, 1), zoomStep(4, 1), zoomStep(1, -1), zoomStep(3, -1)]).toEqual([1.5, 2, 4, 1, 2]);
  // a phone screenshot on a desktop: fitted to the height, then twice that; a small image is never blown up to fit
  expect(zoomedWidth({ w: 390, h: 844 }, { w: 1400, h: 844 / 2 }, 1)).toBe(195);
  expect(zoomedWidth({ w: 390, h: 844 }, { w: 1400, h: 844 / 2 }, 2)).toBe(390);
  expect(zoomedWidth({ w: 100, h: 50 }, { w: 1400, h: 900 }, 1.5)).toBe(150);
  expect(zoomedWidth({ w: 0, h: 0 }, { w: 1400, h: 900 }, 2)).toBe(0);
});
