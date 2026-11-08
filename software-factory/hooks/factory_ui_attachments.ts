// The web UI's attachments (#637), served by factory_ui_server.ts behind the same token or sign-in as the rest of the API.
// The files are untrusted (an agent made them), so:
//
//   GET /api/projects/:p/attachments[?target=pr:12][&head=<sha>]
//       {project, target, head, attachments, limits, used, problems}: the project's attachments (on one target, or all),
//       oldest first. Each has its name, kind (image, video, junit, html, log, file), size, who attached it and when, its
//       note, the head it was taken for, `old` (a pull request's attachment for another head than `head`), `inline`
//       (shown in the page) and `file`, the address of its bytes. A JUnit report also has `summary`: passed, failed,
//       skipped and the failures (factory_junit.ts).
//   GET /api/projects/:p/attachments/:id/file[?download=1]
//       the bytes, with the content type worked out again here from its name and first bytes (never what was stored),
//       `X-Content-Type-Options: nosniff`, a `sandbox` content security policy, and `Content-Disposition: inline` only
//       for a PNG, JPEG, GIF or WebP image or a WebM or MP4 video. Everything else, SVG and HTML included, is
//       `attachment` (a download): agent-made HTML or script never runs on the UI's address. There is no separate
//       preview address yet (#599 is not merged), so an HTML report is a download.
//
// The metadata is on the message board and the bytes in the hub's store (message-board/src/attachments.ts); without a
// board this answers 404 attachments_no_board with the fix. On the hub a listing also drops what is past the retention
// (at most once a minute).
import type { Attachment, Board } from "../message-board/src/index.ts";
import { junitSummary, type JunitSummary } from "./factory_junit.ts";
import type { Obj, Problem, UiProject } from "./factory_ui_data.ts";

type BoardModule = typeof import("../message-board/src/index.ts");

export type AttachmentAnswer =
  | { kind: "json"; status: number; body: Obj }
  | { kind: "file"; bytes: Uint8Array; type: string; inline: boolean; name: string };

let mod: BoardModule | null = null;
async function board(): Promise<BoardModule> {
  mod ??= await import("../message-board/src/index.ts");
  return mod;
}

function problem(status: number, code: string, message: string, fix: string): AttachmentAnswer {
  return { kind: "json", status, body: { code, message, fix } satisfies Problem };
}

const NO_BOARD: [string, string] = ["Attachments are kept with the message board, and this server has none open.",
  "Start the board on the hub (`factory board up`) or join it (`factory machine join`), then start `factory ui` again."];

/** The project's attachment settings, from its factory.json. */
function settingsOf(p: UiProject, m: BoardModule): ReturnType<BoardModule["limitsOf"]> {
  const a = p.config?.attachments;
  return m.limitsOf(typeof a === "object" && a !== null && !Array.isArray(a) ? (a as Obj) : {});
}

const summaries = new Map<string, JunitSummary>();
const pruned = new Map<string, number>();
const PRUNE_MS = 60_000;

async function summaryOf(b: Board, m: BoardModule, a: Attachment): Promise<JunitSummary> {
  const kept = summaries.get(a.sha256);
  if (kept) return kept;
  const bytes = await m.readBytes(b, a);
  const s = bytes ? junitSummary(new TextDecoder().decode(bytes)) : { ok: false, why: "Its file isn't on this machine.", tests: 0, passed: 0,
    failed: 0, skipped: 0, seconds: null, failures: [] };
  if (bytes) {
    if (summaries.size > 500) summaries.clear();
    summaries.set(a.sha256, s);
  }
  return s;
}

function fileAddress(p: UiProject, id: string): string {
  return `/api/projects/${encodeURIComponent(p.id)}/attachments/${id}/file`;
}

/** The answer to `/api/projects/:p/attachments[/:id/file]` (`rest` starts with "attachments"); `open` is the board the
 *  server has open (null with none), `repo` the project's owner/name. */
export async function attachmentsApi(req: Request, url: URL, p: UiProject, rest: string[], open: Board | null, repo: string): Promise<AttachmentAnswer> {
  if (req.method !== "GET" && req.method !== "HEAD") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
  if (rest.length !== 1 && !(rest.length === 3 && rest[2] === "file")) {
    return problem(404, "not_found", `There is no /attachments/${rest.slice(1).join("/")}.`, "Use /attachments or /attachments/<id>/file.");
  }
  if (!open) return problem(404, "attachments_no_board", ...NO_BOARD);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return problem(404, "attachments_no_repo", `${p.name} has no GitHub repo known here, and attachments are kept by repo.`,
      "Add the GitHub remote as origin in the project's checkout, then reload.");
  }
  const m = await board();
  const limits = settingsOf(p, m);
  if (rest.length === 3) return file(open, m, p, repo, rest[1] ?? "", url, limits.retentionDays);
  let target: ReturnType<BoardModule["targetOf"]> | undefined;
  const t = url.searchParams.get("target");
  if (t) {
    const [kind = "", ...id] = t.split(":");
    try {
      target = m.targetOf(kind, id.join(":"));
    } catch (e) {
      const why = e instanceof m.BoardError ? e : null;
      return problem(400, "attachments_bad_input", why?.message ?? "That isn't a target.", why?.fix ?? "Use target=pr:12, task:b3, signoff:<id> or epic:12.");
    }
  }
  const head = (url.searchParams.get("head") ?? "").trim().toLowerCase();
  if (head && !/^[0-9a-f]{7,64}$/.test(head)) return problem(400, "attachments_bad_input", "head isn't a commit's SHA.", "Pass the pull request's head SHA, or leave it out.");
  try {
    const hub = m.isHub();
    if (hub && Date.now() - (pruned.get(repo) ?? 0) > PRUNE_MS) {
      pruned.set(repo, Date.now());
      await m.pruneAttachments(open, repo, limits.retentionDays, hub);
    }
    const all = await m.listAttachments(open, repo, undefined, limits.retentionDays);
    const used = [...new Map(all.map((a) => [a.sha256, a.size])).values()].reduce((x, y) => x + y, 0);
    const list = target ? all.filter((a) => a.target.kind === target.kind && a.target.id === target.id) : all;
    const attachments: Obj[] = [];
    for (const a of list) {
      const row: Obj = { id: a.id, name: a.name, kind: a.kind, type: a.type, size: a.size, sha256: a.sha256, note: a.note, by: a.by, at: a.at,
        target: a.target, head: a.head, old: Boolean(head && a.head && !head.startsWith(a.head) && !a.head.startsWith(head)),
        inline: m.INLINE_TYPES.has(a.type) && (a.kind === "image" || a.kind === "video"), file: fileAddress(p, a.id) };
      if (a.kind === "junit") row.summary = await summaryOf(open, m, a);
      attachments.push(row);
    }
    const MB = 1024 * 1024;
    return { kind: "json", status: 200, body: { project: p.id, target: target ? `${target.kind}:${target.id}` : null, head: head || null, attachments,
      limits: { maxFileMb: limits.maxFileBytes / MB, maxProjectMb: limits.maxProjectBytes / MB, retentionDays: limits.retentionDays }, used, problems: [] } };
  } catch (e) {
    return problem(503, "attachments_unreadable", `The attachments can't be read from the message board: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
      "Check the board (`factory board status`, or the Health page), then reload.");
  }
}

async function file(open: Board, m: BoardModule, p: UiProject, repo: string, id: string, url: URL, retentionDays: number): Promise<AttachmentAnswer> {
  if (!m.ATTACHMENT_ID.test(id)) return problem(404, "attachment_unknown", "That isn't an attachment's id.", "Open it from its page's Attachments.");
  const a = await m.attachmentById(open, repo, id, retentionDays);
  if (!a) {
    return problem(404, "attachment_unknown", `${p.name} has no attachment ${id} (it may be past attachments.retentionDays).`,
      "Reload the page to see the attachments kept now.");
  }
  const bytes = await m.readBytes(open, a);
  if (!bytes) {
    return problem(404, "attachment_elsewhere", `${a.name} is kept in the hub's store, not on this machine.`,
      "Open the web UI on the hub (the machine that runs `factory board up`).");
  }
  const { type } = m.classify(a.name, bytes); // worked out again: what the board says is never trusted
  const inline = url.searchParams.get("download") !== "1" && m.INLINE_TYPES.has(type);
  return { kind: "file", bytes, type, inline, name: a.name };
}

/** The response for a file: its exact type, nosniff, a sandbox policy, and inline only for the image and video types. */
export function fileResponse(f: { bytes: Uint8Array; type: string; inline: boolean; name: string }, base: Record<string, string>): Response {
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = `${f.inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`;
  return new Response(new Uint8Array(f.bytes), { headers: { ...base, "content-type": f.type, "x-content-type-options": "nosniff",
    "content-disposition": disposition, "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store",
    "content-length": String(f.bytes.byteLength) } });
}
