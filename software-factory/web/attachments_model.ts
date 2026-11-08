// Attachments on a task, a pull request or a sign-off item (#637): the rules of the Attachments section (web/
// attachments.tsx), with no React, so tests/web_ui_attachments_model.test.ts runs them as they are. The data is GET
// /api/projects/:p/attachments?target=... (hooks/factory_ui_attachments.ts).

export interface JunitFailure {
  suite: string;
  name: string;
  classname: string;
  kind: string;
  message: string;
  text: string;
}

export interface JunitSummary {
  ok: boolean;
  why: string;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  seconds: number | null;
  failures: JunitFailure[];
}

export interface AttachmentRow {
  id: string;
  name: string;
  kind: "image" | "video" | "junit" | "html" | "log" | "file";
  type: string;
  size: number;
  note: string;
  by: string;
  at: string;
  head: string | null;
  /** For a pull request's other head than the one shown. */
  old: boolean;
  inline: boolean;
  /** The address of its bytes (behind the same sign-in as the API). */
  file: string;
  summary?: JunitSummary;
}

export interface AttachmentGroups {
  images: AttachmentRow[];
  videos: AttachmentRow[];
  results: AttachmentRow[];
  logs: AttachmentRow[];
  files: AttachmentRow[];
}

/** The target as the API takes it: `pr:12`, `task:b3` (a task's "#12" is "12"), `signoff:login-flow`. */
export function targetParam(kind: "task" | "pr" | "signoff" | "epic", id: string): string {
  return `${kind}:${id.replace(/^#/, "")}`;
}

/** The listing's address for a target, with the pull request's head when there is one. */
export function listAddress(project: string, target: string, head?: string | null): string {
  const q = new URLSearchParams({ target });
  if (head) q.set("head", head);
  return `/api/projects/${encodeURIComponent(project)}/attachments?${q.toString()}`;
}

/** The rows in their sections, newest first in each; those for an older head after the current ones. */
export function groupsOf(rows: AttachmentRow[]): AttachmentGroups {
  const order = [...rows].sort((a, b) => Number(a.old) - Number(b.old) || b.at.localeCompare(a.at));
  return {
    images: order.filter((r) => r.kind === "image" && r.inline),
    videos: order.filter((r) => r.kind === "video" && r.inline),
    results: order.filter((r) => r.kind === "junit"),
    logs: order.filter((r) => r.kind === "log"),
    files: order.filter((r) => !(r.kind === "image" && r.inline) && !(r.kind === "video" && r.inline) && r.kind !== "junit" && r.kind !== "log"),
  };
}

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

/** "by taytu, for abc1234 (an older head)" under a row. */
export function whoLine(r: AttachmentRow): string {
  const parts = [`by ${r.by}`];
  if (r.head) parts.push(`for ${r.head.slice(0, 7)}${r.old ? " (an older head)" : ""}`);
  return parts.join(", ");
}

/** What the section's heading says: how many, and how many are for an older head. */
export function countText(rows: AttachmentRow[]): string {
  if (!rows.length) return "Nothing attached yet.";
  const old = rows.filter((r) => r.old).length;
  const n = `${rows.length} file${rows.length === 1 ? "" : "s"}`;
  return old ? `${n}, ${old} for an older head` : n;
}

/** A test report's one line: "12 passed, 1 failed, 2 skipped". */
export function resultLine(s: JunitSummary | undefined): string {
  if (!s) return "Not read yet.";
  if (!s.ok) return `It can't be read: ${s.why}`;
  const parts = [`${s.passed} passed`, `${s.failed} failed`, `${s.skipped} skipped`];
  return parts.join(", ") + (s.seconds !== null ? ` in ${Math.round(s.seconds * 10) / 10} s` : "");
}

/** The dot of a test report: red-free (ink) when something failed, so the one red stays for what needs the owner. */
export function resultTone(s: JunitSummary | undefined): "working" | "ink" | "idle" {
  if (!s || !s.ok) return "idle";
  return s.failed ? "ink" : "working";
}

/** Why a file is a download and not shown: said once, so nobody wonders. */
export function downloadWhy(r: AttachmentRow): string {
  if (r.kind === "html") return "An HTML report is a download: agent-made pages never open on this page's address.";
  if (r.type === "image/svg+xml") return "An SVG is a download: it can carry script.";
  return "";
}

/** The lines of a log that hold `q` (any case), with their numbers; every line when `q` is empty. At most `most`. */
export function searchLog(text: string, q: string, most = 2000): { n: number; line: string }[] {
  const lines = text.split(/\r?\n/);
  const want = q.trim().toLowerCase();
  const out: { n: number; line: string }[] = [];
  for (let i = 0; i < lines.length && out.length < most; i++) {
    const line = lines[i] as string;
    if (!want || line.toLowerCase().includes(want)) out.push({ n: i + 1, line });
  }
  return out;
}

/** The parts of `line` split around each `q` (any case), so the page can mark them; [] parts never. */
export function marks(line: string, q: string): { text: string; hit: boolean }[] {
  const want = q.trim().toLowerCase();
  if (!want) return [{ text: line, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const low = line.toLowerCase();
  let at = 0;
  for (let i = low.indexOf(want); i >= 0; i = low.indexOf(want, at)) {
    if (i > at) out.push({ text: line.slice(at, i), hit: false });
    out.push({ text: line.slice(i, i + want.length), hit: true });
    at = i + want.length;
  }
  if (at < line.length) out.push({ text: line.slice(at), hit: false });
  return out;
}

/** The gallery's next image (wrapping), for the arrows and the keys. */
export function step(index: number, count: number, by: 1 | -1): number {
  return count ? (index + by + count) % count : 0;
}

export const ZOOMS = [1, 1.5, 2, 3, 4] as const;

/** An image's width at `zoom` times its fitted size: fitted is the most of `box` it fills keeping its shape, never
 *  bigger than the image itself. */
export function zoomedWidth(nat: { w: number; h: number }, box: { w: number; h: number }, zoom: number): number {
  if (nat.w <= 0 || nat.h <= 0) return 0;
  const fit = Math.min(box.w > 0 ? box.w / nat.w : 1, box.h > 0 ? box.h / nat.h : 1, 1);
  return Math.round(nat.w * fit * zoom);
}

/** The next zoom level in or out, from the fitted size (1) to 4 times. */
export function zoomStep(z: number, by: 1 | -1): number {
  const i = ZOOMS.findIndex((x) => x >= z);
  const at = i < 0 ? ZOOMS.length - 1 : i;
  return ZOOMS[Math.min(Math.max(at + by, 0), ZOOMS.length - 1)] as number;
}
