// The Health & releases view (#367), towards its board (docs/artifacts/9ntScsF5dJGU6XQrQsvQi7/VHealth.dc.html): what
// `factory doctor` found (how many checks pass, and each one to fix) and the factory version installed here, from the
// cockpit's snapshot (`doctor`, `version`). r reads the snapshot again, which runs the doctor again. It only reads: the
// fixes, `factory update` and `factory rollback` run in a shell.
import { type Line, list, obj, plain, seg } from "./lines.tsx";
import { heading, para, wrapText } from "./doc.tsx";
import type { Got } from "./read.ts";

const SOURCE: Record<string, string> = { release: "from the release pin", linked: "a linked checkout (its VERSION file)" };

const KEYS = "r runs the doctor again · every check, ok and notes too: factory doctor · releases: factory releases · " +
  "update: factory update · back to the last release: factory rollback";

/** Every line of the Health & releases view for a snapshot (undefined: still reading), at most `w` wide. */
export function healthLines(snap: Got | undefined, repo: string, w: number): Line[] {
  const out: Line[] = [...heading([seg("factory", "amber"), seg(`  ${repo} · Health and releases`, "dim")],
    "factory doctor · factory version", w), []];
  if (snap === undefined) return [...out, [seg("Running the doctor…")]];
  if (snap === "late") return [...out, ...para("The doctor took too long: run `factory doctor` to see where it stops.", w)];
  if (snap === null) return [...out, ...para("No snapshot yet: `factory cockpit --json` reads one now.", w)];
  const doc = snap.doctor === null || snap.doctor === undefined ? null : obj(snap.doctor);
  if (doc === null) {
    out.push([seg("Doctor", "bold")]);
    const failed = list(snap.missing).filter((m) => plain(m.code) === "doctor_failed");
    for (const p of failed.length ? failed : [{ message: "The snapshot has no doctor part.", fix: "Run `factory doctor`." }]) {
      out.push(...para(plain(p.message), w, "red"), ...para(`fix: ${plain(p.fix)}`, w, "dim"));
    }
  } else {
    const fixes = Array.isArray(doc.fix) ? doc.fix.map(plain) : [];
    out.push([seg("Doctor", "bold"), seg(`  ${plain(doc.ok) || "0"} ok`, "green"),
      seg(`  ${plain(doc.fixes) || "0"} to fix`, fixes.length ? "amber" : "dim"), seg(`  ${plain(doc.notes) || "0"} notes`, "dim")]);
    for (const f of fixes) out.push(...wrapText(f, w - 5).map((t, i): Line => [seg(i ? "     " : "fix  ", "amber"), seg(t)]));
    out.push(...para(plain(doc.summary), w, fixes.length ? "amber" : "green"));
  }
  const v = obj(snap.version);
  const installed = plain(v.installed);
  out.push([], [seg("Factory version", "bold")]);
  out.push([seg("installed here   ", "dim"), seg(installed ? `v${installed.replace(/^v/, "")}` : "unknown", installed ? undefined : "red"),
    seg(SOURCE[plain(v.source)] ? `  ${SOURCE[plain(v.source)]}` : "", "dim")]);
  out.push([seg("newest release   ", "dim"), seg("factory releases lists them")], []);
  out.push(...para(KEYS, w, "dim", " · "));
  return out;
}
