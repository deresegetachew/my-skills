// The designs and artifacts page's rules (#454), from the owner's design (docs/design/web-ui/Artifacts.dc.html): a row
// per copy with its status and one action (the first copy that has a newer version gets the primary button), the page's
// line, and the confirm for pulling a new copy. No command or setting is shown on screen (the owner's rule). No React
// here, so tests/web_ui_artifacts_model.test.ts runs it as it is.
import type { ConfirmSpec } from "./parts_model.ts";

/** One copy as GET /api/projects/:p/artifacts sends it. */
export interface Artifact {
  id: string;
  url: string;
  title: string;
  dest: string;
  pulledAt: string;
  pulledBy: string;
  state: string;
  detail: string;
  review: { number: number; url: string } | null;
}

export type Dot = "working" | "waiting" | "idle" | "down";

export interface ArtifactRow {
  id: string;
  name: string;
  sub: string;
  status: { text: string; dot: Dot };
  /** "Pull new copy", "Pull again", "Open the PR" or "Open". */
  action: string;
  primary: boolean;
}

const STATES: Record<string, { text: string; dot: Dot; action: string }> = {
  older: { text: "Newer version", dot: "waiting", action: "Pull new copy" },
  current: { text: "Up to date", dot: "working", action: "Open" },
  unknown: { text: "Can't tell", dot: "idle", action: "Open" },
  edited: { text: "Edited here", dot: "waiting", action: "Open" },
  missing: { text: "Missing", dot: "down", action: "Pull again" },
};
const REVIEW = { text: "New copy in review", dot: "idle" as Dot, action: "Open the PR" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function nameOf(a: Artifact): string {
  return a.title || a.id;
}

export function rowsOf(list: Artifact[]): ArtifactRow[] {
  let first = true;
  return list.map((a) => {
    const s = a.review ? REVIEW : STATES[a.state] ?? STATES.unknown as (typeof STATES)[string];
    const primary = first && s.action === "Pull new copy";
    if (primary) first = false;
    const copied = dayOf(a.pulledAt);
    return { id: a.id, name: nameOf(a), sub: [a.dest, copied ? `copied ${copied}` : ""].filter(Boolean).join(" · "),
      status: { text: s.text, dot: s.dot }, action: s.action, primary };
  });
}

/** The page's line: what it is, and how many copies have a newer version nobody is pulling yet. */
export function headLine(list: Artifact[]): string {
  const base = "The designs builders work from, kept as reviewed copies in the repo.";
  const n = list.filter((a) => a.state === "older" && !a.review).length;
  return n ? `${base} ${n} ${n === 1 ? "has" : "have"} a newer version.` : base;
}

/** The first precondition of any pull: this project knows how to fetch an artifact; when not, its fix opens Integrations. */
function fetchCheck(fetchSet: boolean): ConfirmSpec["checks"][number] {
  return { title: "This machine can fetch the artifact", met: fetchSet,
    ...(fetchSet ? {} : { sub: "Fetching artifacts isn't set up for this project yet. Set it up in Integrations, then try again.", fix: "Open Integrations" }) };
}

/** Pulling a new copy of `a`: this machine can fetch it, no new copy is in review, and the copy here wasn't edited. */
export function pullAsk(a: Artifact, fetchSet: boolean): ConfirmSpec {
  const name = nameOf(a);
  return {
    title: `Pull the new copy of ${name}?`,
    checks: [
      fetchCheck(fetchSet),
      { title: "No new copy is in review", met: !a.review,
        ...(a.review ? { sub: `Pull request #${a.review.number} already has one: review or close it first.` } : {}) },
      { title: "The copy here wasn't edited", met: a.state !== "edited",
        ...(a.state === "edited" ? { sub: "Someone changed the copy in the repo. Put those changes in the artifact first, so they aren't lost." } : {}) },
    ],
    happens: `The new files of ${name} go on a new branch with the list of copies, and a pull request opens; the dev manager reviews it.`,
    doesNot: "Your checkout doesn't change, and builders keep the copy they read now until the pull request merges.",
    action: "Pull the new copy",
    tone: "primary",
  };
}

/** Adding an artifact: the same pull, for a link not in the list yet. */
export function addAsk(link: string, fetchSet: boolean): ConfirmSpec {
  return {
    title: "Add this artifact?",
    checks: [fetchCheck(fetchSet)],
    happens: `A copy of ${link} goes on a new branch with the list of copies, and a pull request opens; the dev manager reviews it.`,
    doesNot: "Your checkout doesn't change, and builders don't see the copy until the pull request merges.",
    action: "Add it",
    tone: "primary",
  };
}
