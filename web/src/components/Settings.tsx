import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { LOCATION_LABELS, locationPermission, useLocationStatus, type LocationPermission } from "../lib/position.ts";
import { disablePush, enablePush, pushState, PUSH_LABELS, type PushState } from "../lib/push.ts";
import { Button } from "./Button.tsx";
import { Field } from "./Field.tsx";
import { Switch } from "./Switch.tsx";

// Settings rows shared by the crew and driver settings pages.

type Tone = "green" | "warn" | "muted";

const Dot = ({ tone }: { tone: Tone }) => (
  <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone === "green" ? "bg-brand-green" : tone === "warn" ? "bg-warn" : "bg-muted"}`} />
);

/** Label on the left with an optional status line under it, the control on the right. */
export const SettingsRow = ({
  label,
  sub,
  tone,
  labelId,
  children,
}: {
  label: string;
  sub?: string | null;
  tone?: Tone;
  labelId?: string;
  children?: ReactNode;
}) => (
  <div className="flex min-h-14 items-center justify-between gap-3 py-2">
    <div className="min-w-0">
      <div id={labelId} className="text-base font-semibold">
        {label}
      </div>
      {sub && (
        <div className="flex items-center gap-1.5 text-sm text-muted">
          {tone && <Dot tone={tone} />}
          <span className="break-words">{sub}</span>
        </div>
      )}
    </div>
    {children && <div className="shrink-0">{children}</div>}
  </div>
);

/** Name field with Save; `save` resolves true when stored. */
export const NameForm = ({ initial, save }: { initial: string; save: (name: string) => Promise<boolean> }) => {
  const [name, setName] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => setName(initial), [initial]);
  const dirty = name.trim() !== "" && name.trim() !== initial;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!dirty) return;
    setState("saving");
    void save(name.trim())
      .catch(() => false)
      .then((ok) => setState(ok ? "saved" : "error"));
  };
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
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
    </form>
  );
};

/** Push on or off; on iPhone Safari outside the Home Screen app it says so instead of offering a switch. */
export const NotificationsRow = ({ onLabel }: { onLabel: string }) => {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
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
    const s = await (next ? enablePush() : disablePush()).catch(() => pushState().catch((): PushState => "unavailable"));
    setState(s);
    setBusy(false);
  };
  if (state === null) return <SettingsRow label="Notifications" />;
  if (state === "on" || state === "off") {
    return (
      <SettingsRow label="Notifications" labelId={id} sub={state === "on" ? onLabel : "Off"} tone={state === "on" ? "green" : "muted"}>
        <Switch labelledBy={id} checked={state === "on"} busy={busy} onChange={(v) => void toggle(v)} />
      </SettingsRow>
    );
  }
  return <SettingsRow label="Notifications" sub={PUSH_LABELS[state]} tone={state === "denied" ? "warn" : "muted"} />;
};

/** Browser permission first (iOS re-asks per site), then the watcher state. */
export const LocationRow = () => {
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
  // A prompt the user dismissed fails the watch with PERMISSION_DENIED but can still be asked again.
  const denied = perm === "denied" || (status === "denied" && perm !== "prompt");
  const sub = denied ? LOCATION_LABELS.denied : perm === "prompt" ? "Not allowed yet" : LOCATION_LABELS[status];
  const tone: Tone = denied ? "warn" : status === "on" ? "green" : "muted";
  const ask = (): void => {
    if (!("geolocation" in navigator)) return;
    setAsking(true);
    const done = (): void => {
      setAsking(false);
      void locationPermission().then(setPerm);
    };
    navigator.geolocation.getCurrentPosition(done, done, { enableHighAccuracy: true, timeout: 20_000 });
  };
  return (
    <SettingsRow label="Location" sub={sub} tone={tone}>
      {perm === "prompt" && (
        <Button variant="secondary" busy={asking} onClick={ask}>
          Allow
        </Button>
      )}
    </SettingsRow>
  );
};
