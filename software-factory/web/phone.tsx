// The app on a phone (#458), from the owner's design (docs/design/web-ui/PhoneHome.dc.html, PhoneInbox.dc.html): under
// 760 px a tab bar at the bottom (Home, Inbox, Board, Team, the Inbox with its count), big buttons for what needs the
// owner, and every page in one column. The rules are in phone_model.ts; this is the look.
import type { ReactNode } from "react";
import type { PhoneTab } from "./phone_model.ts";

const ICON: Record<PhoneTab["id"], string> = {
  home: "M3 11l9-7 9 7M5 10v10h14V10",
  inbox: "M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z",
  board: "M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z",
  team: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-4 3-6 7-6s7 2 7 6M16 3.5a4 4 0 0 1 0 7.5M18 15c2.5.5 4 2.5 4 6",
};

/** The phone's tab bar: shown only under 760 px (the sidebar's menu stays for every other page). */
export function TabBar({ tabs, open }: { tabs: PhoneTab[]; open: (channel: string) => void }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {tabs.map((t) => (
        <button key={t.id} className="tab" aria-current={t.on ? "page" : undefined} onClick={() => open(t.channel)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"><path d={ICON[t.id]} /></svg>
          <span>{t.label}</span>
          {t.badge !== null && <span className="tab-badge" aria-label={`${t.badge} need you`}>{t.badge}</span>}
        </button>
      ))}
    </nav>
  );
}

/** A card that opens another page, the whole card one target: Home's "2 need you" on a phone. */
export function LinkCard({ title, line, onOpen, className }: { title: ReactNode; line: ReactNode; onOpen: () => void; className?: string }) {
  return (
    <button className={`link-card${className ? ` ${className}` : ""}`} onClick={onOpen}>
      <span className="dot" style={{ background: "var(--red-dot)" }} aria-hidden="true" />
      <span className="link-card-text"><strong>{title}</strong><span>{line}</span></span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
    </button>
  );
}

export const PHONE_CSS = String.raw`
.tabbar { display: none; }
.phone-only { display: none !important; }
.link-card { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--text); padding: 14px 16px; min-height: 60px; cursor: pointer; font: inherit; }
.link-card-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.link-card-text span { font-size: 13px; color: var(--text-2); }
.link-card svg { color: var(--text-3); flex: none; }

@media (max-width: 760px) {
  .phone-only { display: block !important; }
  .desk-only { display: none !important; }
  .main { padding-bottom: 84px; }
  .tabbar { display: grid; grid-template-columns: repeat(4, 1fr); position: fixed; left: 0; right: 0; bottom: 0; z-index: 9;
    border-top: 1px solid var(--border); background: var(--surface); padding: 6px 8px calc(8px + env(safe-area-inset-bottom)); }
  .tab { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-height: 52px;
    border: 0; background: none; cursor: pointer; color: var(--text-3); font-size: 11px; font-weight: 500; }
  .tab[aria-current="page"] { color: var(--text); font-weight: 700; }
  .tab-badge { position: absolute; top: 4px; left: 54%; min-width: 18px; height: 18px; border-radius: 999px; background: var(--badge); color: #FFFFFF;
    font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; padding: 0 5px; }
  .toast { bottom: 92px; }
  /* big buttons for what needs the owner: one under another, 52 px high */
  .ask .options { flex-direction: column; align-items: stretch; }
  .ask .options .btn, .merge-card .btn, .own .btn { height: 52px; font-size: 15px; white-space: normal; }
  .own input { height: 52px; }
}
`;
