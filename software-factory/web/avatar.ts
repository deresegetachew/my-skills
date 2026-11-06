// Every agent's avatar in the web app (#437): an original illustration drawn here as SVG from the agent's name and role
// (a builder wears a hard hat, the dev manager a headset, the product owner a pin with a star), in a colour of its own,
// so a project installs nothing. The owner's own image (.claude/factory/avatars/<name>.<ext>, read by the server) wins;
// when it can't be shown, the agent's initials in its colour. No React here, so tests/web_ui_avatar_model.test.ts runs it
// as it is.

/** FNV-1a: a small, stable hash of `text`. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hex(n: number): string {
  return Math.round(Math.min(Math.max(n, 0), 1) * 255).toString(16).padStart(2, "0");
}

/** `#rrggbb` for a hue (degrees), saturation and lightness (0 to 1). */
function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** The agent's colour: from its name, dark enough for white initials on it. */
export function agentColor(name: string): string {
  const h = hash(name);
  return hsl(h % 360, 0.5 + ((h >>> 9) % 20) / 100, 0.36 + ((h >>> 14) % 8) / 100);
}

const SKIN = ["#f6d5b8", "#e8b98f", "#c98e62", "#a8693f", "#7a4a2a", "#5a3620"];
const HAIR = ["#2b1d14", "#4a2f1d", "#7a4e2a", "#b7793e", "#d9b26f", "#3b3b3b", "#8c8c8c"];
const ROLES = ["coding-agent", "dev-manager", "product-owner"];

/** The hair, by style: drawn over the top of the head (centre 32,30, radius 13). */
function hairOf(style: number, c: string): string {
  switch (style) {
    case 0: // short
      return `<path d="M19 29c0-9 6-14 13-14s13 5 13 14c-3-4-7-6-13-6s-10 2-13 6z" fill="${c}"/>`;
    case 1: // a side part
      return `<path d="M19 30c-1-10 6-16 14-16 7 0 12 5 12 13-6 0-13-2-17-7-2 4-5 7-9 10z" fill="${c}"/>`;
    case 2: // long
      return `<path d="M18 44V29c0-9 6-15 14-15s14 6 14 15v15h-5V29c-3-3-6-4-9-4s-6 1-9 4v15z" fill="${c}"/>`;
    case 3: // curls
      return `<g fill="${c}"><circle cx="21" cy="25" r="5"/><circle cx="27" cy="19" r="5.5"/><circle cx="34" cy="18" r="5.5"/>` +
        `<circle cx="41" cy="22" r="5"/><circle cx="44" cy="28" r="3.5"/><circle cx="19" cy="31" r="3.5"/></g>`;
    default: // a bun on top
      return `<g fill="${c}"><circle cx="32" cy="13" r="5"/><path d="M19 29c0-9 6-13 13-13s13 4 13 13c-4-3-8-5-13-5s-9 2-13 5z"/></g>`;
  }
}

/** The eyes and mouth, by style. */
function faceOf(style: number): string {
  const ink = "#2a2320";
  const eyes = style === 0 ? `<circle cx="27" cy="31" r="1.6" fill="${ink}"/><circle cx="37" cy="31" r="1.6" fill="${ink}"/>`
    : style === 1 ? `<path d="M25 31.5q2-2 4 0M35 31.5q2-2 4 0" stroke="${ink}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    : `<rect x="25.5" y="29.5" width="3" height="3" rx="1" fill="${ink}"/><rect x="35.5" y="29.5" width="3" height="3" rx="1" fill="${ink}"/>` +
      `<path d="M28.5 31h7" stroke="${ink}" stroke-width="1"/><circle cx="27" cy="31" r="3.2" stroke="${ink}" stroke-width="1" fill="none"/>` +
      `<circle cx="37" cy="31" r="3.2" stroke="${ink}" stroke-width="1" fill="none"/>`;
  return `${eyes}<path d="M28.5 37q3.5 3 7 0" stroke="${ink}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
}

/** What the role wears: a builder a hard hat, the dev manager a headset, the product owner a pin with a star. */
function roleMark(role: string): string {
  if (role === "dev-manager") {
    return `<path d="M18 31a14 14 0 0 1 28 0" stroke="#1f2937" stroke-width="2.5" fill="none"/>` +
      `<rect x="15.5" y="28" width="5" height="8" rx="2" fill="#1f2937"/><rect x="43.5" y="28" width="5" height="8" rx="2" fill="#1f2937"/>` +
      `<path d="M18 36q1 6 8 6" stroke="#1f2937" stroke-width="1.8" fill="none"/><circle cx="27" cy="42" r="1.8" fill="#1f2937"/>`;
  }
  if (role === "product-owner") {
    return `<circle cx="42" cy="54" r="5" fill="#fff"/>` +
      `<path d="m42 50.6 1 2.2 2.4.3-1.8 1.6.5 2.4-2.1-1.2-2.1 1.2.5-2.4-1.8-1.6 2.4-.3z" fill="#f59e0b"/>`;
  }
  return `<path d="M17 26c0-9 7-14 15-14s15 5 15 14z" fill="#facc15"/><rect x="14" y="25" width="36" height="4" rx="2" fill="#eab308"/>` +
    `<rect x="30" y="12" width="4" height="13" rx="1.5" fill="#eab308"/>`;
}

/** The agent's illustration, as SVG: the same for the same name and role. An unknown role draws as a coding agent. */
export function avatarSvg(name: string, role: string): string {
  const r = ROLES.includes(role) ? role : "coding-agent";
  const h = hash(`${name}\u0000avatar`);
  const color = agentColor(name);
  const skin = SKIN[h % SKIN.length] as string;
  const hair = HAIR[(h >>> 4) % HAIR.length] as string;
  const hairStyle = (h >>> 8) % 5;
  const face = (h >>> 12) % 3;
  const shirt = hsl(hash(name) % 360, 0.35, 0.85);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="32" fill="${color}"/>` +
    `<path d="M12 64c0-12 9-19 20-19s20 7 20 19z" fill="${shirt}"/>` +
    `<rect x="28" y="40" width="8" height="7" fill="${skin}"/>` +
    `<circle cx="32" cy="30" r="13" fill="${skin}"/>` +
    (r === "coding-agent" ? "" : hairOf(hairStyle, hair)) +
    faceOf(face) +
    roleMark(r) +
    `</svg>`;
}

/** Where the page reads the avatar from: the owner's image when the server sent one (a data address of an image), else
 * the drawn illustration. */
export function avatarSrc(name: string, role: string, custom: string | null = null): string {
  if (custom && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(custom)) return custom;
  return `data:image/svg+xml,${encodeURIComponent(avatarSvg(name, role))}`;
}

/** The first letter of each of the first two parts of `name`, else its first two letters, in capitals. */
export function initials(name: string): string {
  const parts = name.split(/[-_ .]+/).filter(Boolean);
  if (!parts.length) return "?";
  const two = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : (parts[0] as string).slice(0, 2);
  return two.toUpperCase();
}

function escapeXml(text: string): string {
  const named: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return text.replace(/[&<>"']/g, (c) => named[c] as string);
}

/** The fallback when the owner's image can't be shown: the initials on the agent's colour. */
export function initialsSrc(name: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${agentColor(name)}"/>` +
    `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-size="26" ` +
    `font-weight="600" fill="#fff">${escapeXml(initials(name))}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
