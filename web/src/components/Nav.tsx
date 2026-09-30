import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "wouter";

export interface NavLink {
  href: string;
  label: string;
}

const isActive = (loc: string, href: string): boolean => {
  const path = href.split("?")[0] ?? href;
  return path === "/" || path === "/admin" || path === "/green" ? loc === path : loc === path || loc.startsWith(`${path}/`);
};

const MenuIcon = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    {open ? (
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    ) : (
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    )}
  </svg>
);

/**
 * Top bar: brand, scope chip, links. Below 860 px the links move into a
 * drawer behind a hamburger that closes on route change, Escape and a tap on
 * the scrim (`data-scrim`).
 */
export const Nav = ({
  scope,
  scopeTone = "plain",
  links,
  onSignOut,
}: {
  scope?: string;
  /** Crew scope chips carry the red-shirt colour. */
  scopeTone?: "crew" | "plain";
  links: readonly NavLink[];
  onSignOut?: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [loc] = useLocation();
  const menuId = useId();
  const drawer = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [loc]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    drawer.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const inlineCls = (active: boolean): string =>
    `inline-flex min-h-10 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors ${
      active ? "bg-brand text-on-brand" : "text-bar-text/85 hover:bg-white/10 hover:text-bar-text"
    }`;

  return (
    <header className="no-print sticky top-0 z-[1500] bg-bar text-bar-text shadow-sm pt-[env(safe-area-inset-top)] dark:ring-1 dark:ring-line">
      <div className="flex h-14 items-center gap-3 px-3 nav:px-5">
        <Link href={links[0]?.href ?? "/"} className="flex shrink-0 items-center gap-2 text-lg font-extrabold tracking-tight">
          <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-brand" />
          LR Buddy
        </Link>
        <span className="min-w-0 flex-1">
          {scope && (
            <span
              className={`inline-block max-w-full truncate rounded-full px-2.5 py-0.5 align-middle text-sm font-semibold ring-1 ring-inset ${
                scopeTone === "crew" ? "ring-2 ring-crew" : "ring-white/30"
              }`}
            >
              {scope}
            </span>
          )}
        </span>
        <nav aria-label="Main" className="hidden min-w-0 items-center gap-1 overflow-x-auto nav:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={inlineCls(isActive(loc, l.href))} aria-current={isActive(loc, l.href) ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
          {onSignOut && (
            <button type="button" onClick={onSignOut} className={inlineCls(false)}>
              Sign out
            </button>
          )}
        </nav>
        <button
          type="button"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl hover:bg-white/10 nav:hidden"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((v) => !v)}
        >
          <MenuIcon open={open} />
        </button>
      </div>
      {open &&
        createPortal(
          <div className="nav:hidden">
            <div data-scrim className="fixed inset-0 z-[1600] bg-black/50" onClick={() => setOpen(false)} aria-hidden="true" />
            <div
              ref={drawer}
              id={menuId}
              className="fixed inset-y-0 right-0 z-[1700] flex w-[min(20rem,82vw)] flex-col bg-bar text-bar-text shadow-2xl pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
            >
              <div className="flex h-14 items-center justify-between px-4">
                <span className="text-lg font-extrabold tracking-tight">LR Buddy</span>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-xl hover:bg-white/10">
                  <MenuIcon open />
                </button>
              </div>
              <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-3">
                <ul className="flex flex-col gap-1">
                  {links.map((l) => {
                    const active = isActive(loc, l.href);
                    return (
                      <li key={l.href}>
                        <Link
                          href={l.href}
                          className={`flex min-h-12 items-center rounded-xl px-4 text-base font-semibold ${
                            active ? "bg-brand text-on-brand" : "text-bar-text hover:bg-white/10"
                          }`}
                          aria-current={active ? "page" : undefined}
                        >
                          {l.label}
                        </Link>
                      </li>
                    );
                  })}
                  {onSignOut && (
                    <li className="mt-2 border-t border-white/15 pt-2">
                      <button type="button" onClick={onSignOut} className="flex min-h-12 w-full items-center rounded-xl px-4 text-left text-base font-semibold text-bar-text hover:bg-white/10">
                        Sign out
                      </button>
                    </li>
                  )}
                </ul>
              </nav>
            </div>
          </div>,
          document.body,
        )}
    </header>
  );
};
