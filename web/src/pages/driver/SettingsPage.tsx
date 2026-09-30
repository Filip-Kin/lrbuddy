import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { Field } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { ErrorLine } from "../../components/driver/StopCard.tsx";
import { setWakePreference, wakePreference } from "../../components/driver/hooks.ts";
import { LOCATION_LABELS, locationPermission, useLocationStatus, type LocationPermission } from "../../lib/position.ts";
import { disablePush, enablePush, pushState, PUSH_LABELS, type PushState } from "../../lib/push.ts";
import { logout, useMe } from "../../lib/session.ts";
import { trpc } from "../../lib/trpc.ts";

// #region parts
const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <section aria-label={title} className="rounded-3xl bg-surface p-4 ring-1 ring-line ring-inset">
    <h2 className="mb-3 text-sm font-bold text-muted">{title}</h2>
    {children}
  </section>
);

const Row = ({ label, sub, children }: { label: string; sub?: string | null; children?: ReactNode }) => (
  <div className="flex min-h-14 items-center justify-between gap-3 py-2">
    <div className="min-w-0">
      <div className="text-base font-semibold">{label}</div>
      {sub && <div className="text-sm text-muted">{sub}</div>}
    </div>
    {children && <div className="shrink-0">{children}</div>}
  </div>
);

const Switch = ({ label, on, busy, onChange }: { label: string; on: boolean; busy?: boolean; onChange: (next: boolean) => void }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    disabled={busy}
    onClick={() => onChange(!on)}
    className="grid min-h-11 min-w-16 place-items-center disabled:opacity-50"
  >
    <span className={`relative block h-8 w-14 rounded-full ring-1 ring-inset transition-colors ${on ? "bg-brand ring-on-brand/30" : "bg-surface-2 ring-line"}`}>
      <span
        className={`absolute top-1 left-1 block h-6 w-6 rounded-full shadow transition-transform ${on ? "translate-x-6 bg-on-brand" : "bg-muted"}`}
      />
    </span>
  </button>
);
// #endregion

// #region rows
const NameForm = ({ initial }: { initial: string }) => {
  const [name, setName] = useState(initial);
  const utils = trpc.useUtils();
  const save = trpc.driver.setName.useMutation({
    onSuccess: () => {
      void utils.shared.me.invalidate();
      void utils.driver.queue.invalidate();
    },
  });
  useEffect(() => setName(initial), [initial]);
  const dirty = name.trim() !== "" && name.trim() !== initial;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (dirty) save.mutate({ name: name.trim() });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} />
      <div className="flex items-center justify-end gap-3">
        {save.isSuccess && !dirty && <span className="text-sm font-semibold text-muted">Saved</span>}
        <Button type="submit" disabled={!dirty} busy={save.isPending}>
          Save
        </Button>
      </div>
      <ErrorLine text={save.error ? "Not saved. Try again" : null} />
    </form>
  );
};

const NotificationsRow = () => {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    pushState()
      .then((s) => live && setState(s))
      .catch(() => live && setState("unavailable"));
    return () => {
      live = false;
    };
  }, []);
  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    const s = await (next ? enablePush() : disablePush()).catch((): PushState => "unavailable");
    setState(s);
    setBusy(false);
  };
  if (state === null) return <Row label="Notifications" />;
  if (state === "on" || state === "off") {
    return (
      <Row label="Notifications" sub={state === "on" ? "New stops" : "Off"}>
        <Switch label="Notifications" on={state === "on"} busy={busy} onChange={(v) => void toggle(v)} />
      </Row>
    );
  }
  return <Row label="Notifications" sub={PUSH_LABELS[state]} />;
};

const LocationRow = () => {
  const status = useLocationStatus();
  const [perm, setPerm] = useState<LocationPermission | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void locationPermission().then((p) => live && setPerm(p));
    };
    read();
    const t = window.setInterval(read, 10_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);
  // The permission is the truth on iOS, which re-asks per site; the watcher status covers the rest.
  const sub = perm === "denied" ? "Blocked in browser settings" : perm === "prompt" ? "Not allowed yet" : LOCATION_LABELS[status];
  const ask = (): void => {
    if (!("geolocation" in navigator)) return;
    setAsking(true);
    navigator.geolocation.getCurrentPosition(
      () => {
        setAsking(false);
        void locationPermission().then(setPerm);
      },
      () => {
        setAsking(false);
        void locationPermission().then(setPerm);
      },
      { enableHighAccuracy: true, timeout: 20_000 },
    );
  };
  return (
    <Row label="Location" sub={sub}>
      {perm === "prompt" && (
        <Button variant="secondary" busy={asking} onClick={ask}>
          Allow
        </Button>
      )}
    </Row>
  );
};

const ScreenRow = () => {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  const [on, setOn] = useState(wakePreference);
  if (!supported) return <Row label="Keep screen on" sub="Not supported on this browser" />;
  return (
    <Row label="Keep screen on" sub={on ? "While open" : "Off"}>
      <Switch
        label="Keep screen on"
        on={on}
        onChange={(v) => {
          setWakePreference(v);
          setOn(v);
        }}
      />
    </Row>
  );
};
// #endregion

export const SettingsPage = () => {
  const me = useMe();
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = me.data && me.data.role === "driver" ? me.data : null;
  const truckName = data?.truck?.name ?? "Truck";
  const initialName = data?.displayName ?? data?.truck?.driverName ?? "";

  return (
    <Page title="Settings">
      <div className="space-y-4">
        <Panel title="Driver">
          <NameForm initial={initialName} />
        </Panel>

        <Panel title="This phone">
          <div className="divide-y divide-line">
            <NotificationsRow />
            <LocationRow />
            <ScreenRow />
          </div>
        </Panel>

        <Panel title="Truck">
          <div className="divide-y divide-line">
            <Row label={truckName} sub={data?.cc ? `CC ${data.cc.name}${data.day ? `, ${data.day.label}` : ""}` : null} />
            <div className="pt-3">
              <Button variant="danger" size="lg" block onClick={() => setLeaving(true)}>
                Leave truck
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <Sheet
        open={leaving}
        onClose={() => setLeaving(false)}
        title={`Leave ${truckName}`}
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" onClick={() => setLeaving(false)}>
              Stay
            </Button>
            <Button
              variant="danger"
              size="lg"
              busy={busy}
              onClick={() => {
                setBusy(true);
                void logout();
              }}
            >
              Leave truck
            </Button>
          </div>
        }
      >
        <p className="pb-2 text-base">Truck code needed to rejoin</p>
      </Sheet>
    </Page>
  );
};
