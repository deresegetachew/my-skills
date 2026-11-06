// A page's header (title, one line, its actions on the right), for the pages that fill it from their own data (#454:
// sign-off and testing, designs and artifacts). The shell draws the others' the same way.
import type { ReactNode } from "react";

export function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function PageHead({ title, purpose, actions, onMenu, before }: { title: ReactNode; purpose?: ReactNode; actions?: ReactNode;
  onMenu: () => void; before?: ReactNode }) {
  return (
    <header className="page-head">
      <button className="menu" aria-label="Projects and pages" onClick={onMenu}><MenuIcon /></button>
      <div className="grow">
        {before}
        <h1>{title}</h1>
        {purpose && <p>{purpose}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
