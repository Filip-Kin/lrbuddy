import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { isActive, Nav, type NavLink } from "../Nav.tsx";
import { logout, type SignedIn } from "../../lib/session.ts";
import { EventPicker } from "./EventPicker.tsx";

export const planLinks: NavLink[] = [
  { href: "/plan/survey", label: "Survey" },
  { href: "/plan/blocks", label: "Blocks" },
  { href: "/plan/assignments", label: "Assignments" },
  { href: "/plan/print", label: "Print" },
];

/** Back to the field app's admin pages; last in the rail and the phone drawer. */
const FIELD_APP: NavLink = { href: "/admin", label: "Field app" };

const railLink = (active: boolean): string =>
  `flex min-h-11 items-center rounded-xl px-3 text-base font-semibold transition-colors ${
    active ? "bg-brand text-on-brand" : "text-ink hover:bg-surface"
  }`;

/**
 * Planning portal shell. From 860 px: a left rail with the event picker, the
 * portal pages and the way back to the field app. Below 860 px: the same top
 * bar and left drawer as every other screen, with the event picker at the top
 * of the drawer. `no-print` keeps the rail and the bar off paper.
 */
export const PlanLayout = ({ me, children }: { me: SignedIn; children: ReactNode }) => {
  const [loc] = useLocation();
  const eventName = me.event?.name ?? undefined;
  return (
    <div className="flex h-dvh flex-col nav:flex-row">
      <div className="nav:hidden">
        <Nav scope={eventName} links={[...planLinks, FIELD_APP]} onSignOut={() => void logout()} drawerTop={<EventPicker tone="bar" />} />
      </div>
      <aside aria-label="Planning" className="no-print hidden w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-surface-2 px-3 py-4 nav:flex">
        <Link href="/plan/survey" className="flex items-center gap-2 px-2 text-lg font-extrabold tracking-tight text-ink">
          <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-brand ring-1 ring-ink/30" />
          LR Buddy
          <span className="rounded-full px-2 py-0.5 text-xs font-bold tracking-wider text-muted uppercase ring-1 ring-line">Plan</span>
        </Link>
        <div className="px-1">
          <EventPicker />
        </div>
        <nav aria-label="Portal" className="flex flex-col gap-1">
          {planLinks.map((l) => {
            const active = isActive(loc, l.href);
            return (
              <Link key={l.href} href={l.href} className={railLink(active)} aria-current={active ? "page" : undefined}>
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3">
          <Link href={FIELD_APP.href} className={railLink(false)}>
            {FIELD_APP.label}
          </Link>
          <button type="button" onClick={() => void logout()} className={`${railLink(false)} w-full text-left`}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="relative min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
};
