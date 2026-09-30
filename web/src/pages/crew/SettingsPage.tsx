import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { Field } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { LOCATION_LABELS, locationPermission, useLocationStatus, type LocationPermission } from "../../lib/position.ts";
import { disablePush, enablePush, PUSH_LABELS, pushState, type PushState } from "../../lib/push.ts";
import { logout, setDisplayName, useMe } from "../../lib/session.ts";
import { trpc } from "../../lib/trpc.ts";

const Row = ({ label, children, id }: { label: string; children: ReactNode; id?: string }) => (
  <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
    <span id={id} className="font-semibold">
      {label}
    </span>
    <div className="flex min-w-0 items-center gap-2 text-right">{children}</div>
  </div>
);

const Dot = ({ tone }: { tone: "green" | "warn" | "muted" }) => (
  <span
    aria-hidden="true"
    className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone === "green" ? "bg-brand-green" : tone === "warn" ? "bg-warn" : "bg-muted"}`}
  />
);

/** Big on/off switch; `role="switch"` so screen readers announce the state. */
const Switch = ({ on, busy, onChange, labelledBy }: { on: boolean; busy: boolean; onChange: (v: boolean) => void; labelledBy: string }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-labelledby={labelledBy}
    aria-busy={busy || undefined}
    disabled={busy}
    onClick={() => onChange(!on)}
    className={`relative h-11 w-[4.5rem] shrink-0 rounded-full ring-1 ring-inset transition-colors disabled:opacity-60 ${
      on ? "bg-brand-green ring-brand-green" : "bg-surface-2 ring-line"
    }`}
  >
    <span
      aria-hidden="true"
      className={`absolute top-1 left-1 h-9 w-9 rounded-full bg-white shadow transition-transform ${on ? "translate-x-7" : ""}`}
    />
  </button>
);

const NameRow = ({ current }: { current: string | null }) => {
  const utils = trpc.useUtils();
  const [name, setName] = useState(current ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => setName(current ?? ""), [current]);
  const dirty = name.trim() !== "" && name.trim() !== (current ?? "");
  const save = async (): Promise<void> => {
    setState("saving");
    const ok = await setDisplayName(name.trim()).catch(() => false);
    setState(ok ? "saved" : "error");
    if (ok) void utils.shared.me.invalidate();
  };
  return (
    <form
      className="space-y-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) void save();
      }}
    >
      <div className="flex items-end gap-2">
        <Field
          label="Name"
          className="min-w-0 flex-1"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setState("idle");
          }}
          autoComplete="given-name"
          maxLength={60}
          error={state === "error" ? "Not saved. Try again." : null}
        />
        <Button type="submit" variant={dirty ? "primary" : "secondary"} disabled={!dirty} busy={state === "saving"} className="shrink-0">
          {state === "saved" && !dirty ? "Saved" : "Save"}
        </Button>
      </div>
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
  const toggle = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      setState(on ? await enablePush() : await disablePush());
    } catch {
      setState(await pushState().catch((): PushState => "unavailable"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row label="Notifications" id="lrb-push">
      {state === null ? (
        <span className="h-11 w-[4.5rem] animate-pulse rounded-full bg-surface-2" aria-hidden="true" />
      ) : state === "on" || state === "off" ? (
        <Switch on={state === "on"} busy={busy} onChange={(v) => void toggle(v)} labelledBy="lrb-push" />
      ) : (
        <span className="flex items-center gap-2 text-muted">
          <Dot tone={state === "denied" ? "warn" : "muted"} />
          {PUSH_LABELS[state]}
        </span>
      )}
    </Row>
  );
};

const PERMISSION_LABEL: Record<LocationPermission, string | null> = {
  granted: "Allowed",
  prompt: "Not asked yet",
  denied: "Blocked",
  unknown: null,
};

const LocationRow = () => {
  const status = useLocationStatus();
  const [perm, setPerm] = useState<LocationPermission>("unknown");
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
  const denied = status === "denied" || perm === "denied";
  const label = denied ? LOCATION_LABELS.denied : LOCATION_LABELS[status];
  const tone = status === "on" ? "green" : denied ? "warn" : "muted";
  const permLabel = PERMISSION_LABEL[perm];
  return (
    <Row label="Location">
      <span className="flex flex-col items-end">
        <span className="flex items-center gap-2 font-semibold">
          <Dot tone={tone} />
          {label}
        </span>
        {permLabel && !denied && <span className="text-sm text-muted">{`Browser: ${permLabel}`}</span>}
      </span>
    </Row>
  );
};

export const SettingsPage = () => {
  const me = useMe();
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = me.data && me.data.role === "crew" ? me.data : null;
  const crew = data?.crew ?? null;

  return (
    <Page title="Settings">
      <div className="space-y-5">
        <section aria-label="Crew" className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
          <NameRow current={data?.displayName ?? null} />
          {crew && (
            <Row label="Crew">
              <span className="break-words">{[`Crew ${crew.number}`, crew.company?.name].filter(Boolean).join(", ")}</span>
            </Row>
          )}
          {crew?.leadName && (
            <Row label="Red shirt">
              <span className="break-words">{crew.leadName}</span>
            </Row>
          )}
          {data?.cc && (
            <Row label="Command center">
              <span className="break-words">{[`CC ${data.cc.name}`, data.day?.label].filter(Boolean).join(", ")}</span>
            </Row>
          )}
        </section>

        <section aria-label="Device" className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
          <NotificationsRow />
          <LocationRow />
        </section>

        <section aria-label="Leave" className="rounded-2xl bg-surface p-4 ring-1 ring-line">
          <Button variant="danger" size="lg" block onClick={() => setLeaving(true)}>
            Leave crew
          </Button>
        </section>
      </div>

      <Sheet
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Leave crew"
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
              Leave
            </Button>
          </div>
        }
      >
        <div className="space-y-1 pb-2">
          {crew && <p className="text-lg font-bold">{[`Crew ${crew.number}`, crew.company?.name].filter(Boolean).join(", ")}</p>}
          <p className="text-muted">Rejoin: crew QR code</p>
        </div>
      </Sheet>
    </Page>
  );
};
