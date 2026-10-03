import { useEffect, useState } from "react";
import { enablePush, pushState, type PushState } from "../lib/push.ts";
import { storageGet, storageSet } from "../lib/safe.ts";
import { BellIcon, CloseIcon } from "./crew/Icons.tsx";

/** A closed prompt stays closed until the next day. */
const KEY = "lrb.pushPrompt";
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Bar under the broadcast banner on the crew and truck screens while notifications are off
 * (Filip, 2026-10-03: "The app should prompt you to turn on notifications"). Turn on asks the
 * browser right there; on an iPhone outside a Home Screen app it names that step instead. Close
 * hides it for the day; Settings keeps the toggle.
 */
export const PushPrompt = () => {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(() => storageGet("local", KEY) === today());
  useEffect(() => {
    let live = true;
    pushState()
      .then((s) => live && setState(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (closed || (state !== "off" && state !== "install")) return null;
  const close = (): void => {
    storageSet("local", KEY, today());
    setClosed(true);
  };
  return (
    <div role="region" aria-label="Notifications" data-push-prompt className="flex items-center gap-2 bg-surface-2 py-1.5 pl-4 text-ink shadow-sm ring-1 ring-line">
      <BellIcon size={22} className="shrink-0" />
      <span className="min-w-0 flex-1 font-semibold">{state === "install" ? "Notifications: Add to Home Screen" : "Notifications"}</span>
      {state === "off" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void enablePush()
              .catch(() => pushState().catch((): PushState => "unavailable"))
              .then((s) => {
                setState(s);
                setBusy(false);
              });
          }}
          className="min-h-11 shrink-0 rounded-xl bg-brand px-4 text-sm font-bold text-on-brand"
        >
          Turn on
        </button>
      )}
      <button type="button" onClick={close} aria-label="Close" className="grid min-h-11 w-12 shrink-0 place-items-center">
        <CloseIcon size={22} />
      </button>
    </div>
  );
};
