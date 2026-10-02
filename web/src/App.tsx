import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Redirect, Route, Switch, useLocation, useSearch } from "wouter";
import { Button } from "./components/Button.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Field } from "./components/Field.tsx";
import { Nav, type NavLink } from "./components/Nav.tsx";
import { ScreenLoading } from "./components/ScreenLoading.tsx";
import { Sheet } from "./components/Sheet.tsx";
import { setReportRole } from "./lib/clientErrors.ts";
import { useLiveInvalidation } from "./lib/live.ts";
import { usePositionReporter } from "./lib/position.ts";
import { usePrefetchRole } from "./lib/prefetch.ts";
import { isSignedIn, logout, setDisplayName, useMe, type NoRole, type SignedIn } from "./lib/session.ts";
import { getCcOverride, setCcOverride, trpc } from "./lib/trpc.ts";
import { useAdminLinks } from "./pages/admin/links.ts";
import { crewLinks } from "./pages/crew/links.ts";
import { driverLinks } from "./pages/driver/links.ts";
import { useGreenLinks } from "./pages/green/links.ts";
import { LoginPage } from "./pages/join/LoginPage.tsx";
import { PlanLayout } from "./components/plan/PlanLayout.tsx";
import { AccessHome, AdminRoutes, CrewRoutes, DriverRoutes, GreenRoutes, PlanRoutes } from "./routeChunks.ts";

// #region route chunks
/** A screen's chunk, with the error panel if it or its download fails. Reset on every route change. */
const Screen = ({ children }: { children: ReactNode }) => {
  const [loc] = useLocation();
  return (
    <ErrorBoundary resetKey={loc}>
      <Suspense fallback={<ScreenLoading />}>{children}</Suspense>
    </ErrorBoundary>
  );
};
// #endregion

const Shell = ({
  scope,
  scopeShort,
  scopeTone,
  links,
  onSignOut,
  children,
}: {
  scope?: string;
  scopeShort?: string;
  scopeTone?: "crew" | "plain";
  links: readonly NavLink[];
  onSignOut?: () => void;
  children: ReactNode;
}) => (
  <div className="flex h-dvh flex-col">
    <Nav scope={scope} scopeShort={scopeShort} scopeTone={scopeTone} links={links} onSignOut={onSignOut} />
    <main className="relative min-h-0 flex-1 overflow-y-auto">
      <Screen>{children}</Screen>
    </main>
  </div>
);

const Splash = () => (
  <div className="grid h-dvh place-items-center" aria-busy="true">
    <span className="text-lg font-extrabold tracking-tight text-ink">LR Buddy</span>
  </div>
);

const Offline = ({ onRetry, busy }: { onRetry: () => void; busy: boolean }) => (
  <div className="grid h-dvh place-items-center p-6" role="alert">
    <div className="grid justify-items-center gap-4">
      <span className="text-lg font-extrabold tracking-tight text-ink">No connection</span>
      <Button busy={busy} onClick={onRetry}>
        Retry
      </Button>
    </div>
  </div>
);

const LINK_STATES: Record<string, string> = {
  used: "Invite used",
  expired: "Invite expired",
  revoked: "Invite revoked",
  unknown: "Unknown invite",
};

/** `/link?state=`: an invite link the server refused (SPEC 26), whatever the session. */
const LinkRefused = () => {
  const state = new URLSearchParams(useSearch()).get("state") ?? "unknown";
  return (
    <main className="grid h-dvh place-items-center bg-surface-2 p-6">
      <div className="grid w-full max-w-sm justify-items-center gap-4 rounded-3xl bg-surface p-6 shadow-xl ring-1 ring-line">
        <h1 role="alert" className="text-lg font-extrabold tracking-tight text-ink">
          {LINK_STATES[state] ?? LINK_STATES.unknown}
        </h1>
        <Button size="lg" block onClick={() => window.location.assign("/")}>
          Continue
        </Button>
      </div>
    </main>
  );
};

const phoneDigits = (v: string): number => v.replace(/\D/g, "").length;

/**
 * Crews name themselves once and leave a mobile number; the name shows on
 * requests and in green views, the number lets greens call and text the red shirt.
 */
const NamePrompt = ({ me }: { me: SignedIn }) => {
  const [dismissed, setDismissed] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const phoneOk = phoneDigits(phone) >= 7 && phoneDigits(phone) <= 15;
  const save = async (): Promise<void> => {
    setBusy(true);
    const ok = await setDisplayName(name, phone).catch(() => false);
    setBusy(false);
    if (ok) {
      void utils.shared.me.invalidate();
      void utils.crew.invalidate();
    }
  };
  const open = me.role === "crew" && !me.displayName && !dismissed;
  return (
    <Sheet
      open={open}
      onClose={() => setDismissed(true)}
      title={me.scope}
      footer={
        <Button block size="lg" busy={busy} disabled={!name.trim() || !phoneOk} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" maxLength={60} />
        <Field
          label="Mobile"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
          maxLength={40}
          error={phone.trim() !== "" && !phoneOk && phoneDigits(phone) > 15 ? "Too many digits" : null}
        />
      </div>
    </Sheet>
  );
};

/** Admin inside a green view: `/green?cc=<id>`, remembered for the tab. */
const AdminGreen = ({ me }: { me: SignedIn }) => {
  const search = new URLSearchParams(useSearch());
  const fromUrl = Number(search.get("cc"));
  const cc = Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : getCcOverride();
  // Set before children render so their first queries carry the header.
  if (cc !== null && cc !== getCcOverride()) setCcOverride(cc);
  const utils = trpc.useUtils();
  useEffect(() => {
    void utils.invalidate();
  }, [cc, utils]);
  const links = useGreenLinks("/green", `?cc=${cc ?? ""}`);
  if (cc === null) return <Redirect to="/admin/green" />;
  return (
    <Shell scope={me.scope} scopeShort={me.scopeShort} links={[...links, { href: "/admin", label: "Admin" }]} onSignOut={() => void logout()}>
      <Route path="/green" nest>
        <GreenRoutes />
      </Route>
    </Shell>
  );
};

/** `/login?next=/plan/...`: where an admin sign-in goes back to. Only portal paths are honoured. */
const planNext = (): string | null => {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && /^\/plan(\/[a-z/]*)?$/.test(next) ? next : null;
};

const GreenShell = ({ me }: { me: SignedIn }) => (
  <Shell scope={me.scope} scopeShort={me.scopeShort} links={useGreenLinks()} onSignOut={() => void logout()}>
    <GreenRoutes />
  </Shell>
);

const AdminShell = ({ me }: { me: SignedIn }) => (
  <Shell scope={me.scope} scopeShort={me.scopeShort} links={useAdminLinks()} onSignOut={() => void logout()}>
    <AdminRoutes />
  </Shell>
);

const ACCESS_LINKS: readonly NavLink[] = [{ href: "/", label: "Access" }];

/** Signed in through Firebase, no role yet (SPEC 18): every path is the access screen. */
const NoRoleApp = ({ me }: { me: NoRole }) => {
  const [loc] = useLocation();
  if (loc !== "/") return <Redirect to="/" />;
  return (
    <Shell links={ACCESS_LINKS} onSignOut={() => void logout()}>
      <AccessHome name={me.displayName} />
    </Shell>
  );
};

const SignedInApp = ({ me }: { me: SignedIn }) => {
  const [loc] = useLocation();
  const adminInGreen = me.role === "admin" && (loc === "/green" || loc.startsWith("/green/"));
  usePositionReporter(me.role === "crew" || me.role === "driver", me.role === "driver");
  useLiveInvalidation(me.role, me.role !== "admin" || (adminInGreen && getCcOverride() !== null));

  const inPlan = loc === "/plan" || loc.startsWith("/plan/");
  // The portal is for admin sessions; every other role goes to the sign-in page, which returns to the portal.
  if (me.role !== "admin" && inPlan) return <Redirect to={`/login?next=${encodeURIComponent(loc)}`} />;
  if (me.role !== "admin" && loc === "/login" && planNext() !== null) return <LoginPage />;
  if (loc === "/login") return <Redirect to={me.role === "admin" ? (planNext() ?? "/admin") : "/"} />;

  switch (me.role) {
    case "crew":
      return (
        <Shell scope={me.scope} scopeShort={me.scopeShort} scopeTone="crew" links={crewLinks}>
          <CrewRoutes />
          <NamePrompt me={me} />
        </Shell>
      );
    case "driver":
      return (
        <Shell scope={me.scope} scopeShort={me.scopeShort} links={driverLinks}>
          <DriverRoutes />
        </Shell>
      );
    case "green":
      return <GreenShell me={me} />;
    case "admin":
      if (adminInGreen) return <AdminGreen me={me} />;
      if (inPlan) {
        return (
          <PlanLayout me={me}>
            <Screen>
              <PlanRoutes />
            </Screen>
          </PlanLayout>
        );
      }
      if (!loc.startsWith("/admin")) return <Redirect to="/admin" />;
      return <AdminShell me={me} />;
    default:
      return <Redirect to="/login" />;
  }
};

export const App = () => {
  const me = useMe();
  const [loc] = useLocation();
  const role = me.data?.role ?? null;
  useEffect(() => setReportRole(role), [role]);
  usePrefetchRole(me.data);
  if (loc === "/link") return <LinkRefused />;
  if (me.isLoading) return <Splash />;
  // No answer at all (no signal at app open, a restart) is not "signed out": the session
  // cookie is still good, so the app waits here instead of sending the phone to /login.
  // React Query refetches `me` when the browser comes back online.
  if (!me.data && me.isError) return <Offline onRetry={() => void me.refetch()} busy={me.isFetching} />;
  if (me.data?.role === "none") return <NoRoleApp me={me.data} />;
  if (!isSignedIn(me.data)) {
    return (
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route>{() => <Redirect to={window.location.pathname.startsWith("/plan") ? `/login?next=${encodeURIComponent(window.location.pathname)}` : "/login"} />}</Route>
      </Switch>
    );
  }
  return <SignedInApp me={me.data} />;
};
