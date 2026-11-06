// An agent's avatar in the page (#437), the same everywhere it is shown: the channel list, the channel's header, the chat,
// the task board and pull requests, and the machines channel. The rules are in avatar.ts; app.tsx provides the project's
// agents (their roles and the owner's images from the channels' API) through AgentsContext.
import { createContext, useContext, useState } from "react";
import { avatarSrc, initialsSrc } from "./avatar.ts";
import type { Tone } from "./model.ts";

/** The current project's agents by name: their role and the owner's image, when there is one. */
export const AgentsContext = createContext<Record<string, { role?: string; avatar?: string }>>({});

/** `name`'s avatar, `size` pixels across, with its state as a dot on the corner when `tone` is given. Decorative: the
 * name is always written beside it. `image` (an agent of another project, found by the search) stands in for the
 * project's. An owner's image that won't show falls back to the initials in the agent's colour. */
export function Avatar({ name, role, size = 24, tone, image }: { name: string; role?: string; size?: number; tone?: Tone;
  image?: string }) {
  const known = useContext(AgentsContext)[name];
  const src = avatarSrc(name, role ?? known?.role ?? "coding-agent", image ?? known?.avatar ?? null);
  const [broken, setBroken] = useState("");
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      <img src={broken === src ? initialsSrc(name) : src} width={size} height={size} alt="" draggable={false}
        onError={() => setBroken(src)} />
      {tone && <span className={`dot ${tone}`} aria-hidden="true" />}
    </span>
  );
}

export const AVATAR_CSS = String.raw`
.avatar { position: relative; display: inline-block; flex: none; vertical-align: middle; }
.avatar img { display: block; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; background: var(--bg-subtle); }
.avatar .dot { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; border: 2px solid var(--bg); box-sizing: content-box; }
.agent-link { display: inline-flex; align-items: center; gap: 6px; }
.msg-head .avatar { align-self: center; }
`;
