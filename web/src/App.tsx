import { useEffect, useState, type ReactNode } from "react";
import { Redirect, Route, Switch, useLocation, useSearch } from "wouter";
import { Button } from "./components/Button.tsx";
import { Field } from "./components/Field.tsx";
import { Nav, type NavLink } from "./components/Nav.tsx";
import { Sheet } from "./components/Sheet.tsx";
import { useLiveInvalidation } from "./lib/live.ts";
import { usePositionReporter } from "./lib/position.ts";
import { isSignedIn, logout, setDisplayName, useMe, type SignedIn } from "./lib/session.ts";
import { getCcOverride, setCcOverride, trpc } from "./lib/trpc.ts";
import { AdminRoutes, adminLinks } from "./pages/admin/index.tsx";
import { CrewRoutes, crewLinks } from "./pages/crew/index.tsx";
import { DriverRoutes, driverLinks } from "./pages/driver/index.tsx";
import { GreenRoutes, greenLinks } from "./pages/green/index.tsx";
import { LoginPage } from "./pages/join/LoginPage.tsx";

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
    <main className="relative min-h-0 flex-1 overflow-y-auto">{children}</main>
  </div>
);

const Splash = () => (
  <div className="grid h-dvh place-items-center" aria-busy="true">
    <span className="text-lg font-extrabold tracking-tight text-ink">LR Buddy</span>
  </div>
);

/** Crews name themselves once; the name shows on requests and in green views. */
const NamePrompt = ({ me }: { me: SignedIn }) => {
  const [dismissed, setDismissed] = useState(false);
  const [name, setName] = useState("");
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    const ok = await setDisplayName(name).catch(() => false);
    setBusy(false);
    if (ok) void utils.shared.me.invalidate();
  };
  const open = me.role === "crew" && !me.displayName && !dismissed;
  return (
    <Sheet
      open={open}
      onClose={() => setDismissed(true)}
      title={me.scope}
      footer={
        <Button block size="lg" busy={busy} disabled={!name.trim()} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" maxLength={60} />
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
  if (cc === null) return <Redirect to="/admin/green" />;
  return (
    <Shell scope={me.scope} scopeShort={me.scopeShort} links={[...greenLinks("/green", `?cc=${cc}`), { href: "/admin", label: "Admin" }]} onSignOut={() => void logout()}>
      <Route path="/green" nest>
        <GreenRoutes />
      </Route>
    </Shell>
  );
};

const SignedInApp = ({ me }: { me: SignedIn }) => {
  const [loc] = useLocation();
  const adminInGreen = me.role === "admin" && (loc === "/green" || loc.startsWith("/green/"));
  usePositionReporter(me.role === "crew" || me.role === "driver");
  useLiveInvalidation(me.role, me.role !== "admin" || (adminInGreen && getCcOverride() !== null));

  if (loc === "/login") return <Redirect to={me.role === "admin" ? "/admin" : "/"} />;

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
      return (
        <Shell scope={me.scope} scopeShort={me.scopeShort} links={greenLinks()} onSignOut={() => void logout()}>
          <GreenRoutes />
        </Shell>
      );
    case "admin":
      if (adminInGreen) return <AdminGreen me={me} />;
      if (!loc.startsWith("/admin")) return <Redirect to="/admin" />;
      return (
        <Shell scope={me.scope} scopeShort={me.scopeShort} links={adminLinks} onSignOut={() => void logout()}>
          <AdminRoutes />
        </Shell>
      );
    default:
      return <Redirect to="/login" />;
  }
};

export const App = () => {
  const me = useMe();
  if (me.isLoading) return <Splash />;
  if (!isSignedIn(me.data)) {
    return (
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route>
          <Redirect to="/login" />
        </Route>
      </Switch>
    );
  }
  return <SignedInApp me={me.data} />;
};
