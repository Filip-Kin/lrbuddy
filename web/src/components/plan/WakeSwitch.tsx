import { useState } from "react";
import { Switch } from "../Switch.tsx";
import { setWakePreference, wakePreference } from "../driver/hooks.ts";

/**
 * Keep screen on, for Survey drive mode on a phone. Shares the driver pages'
 * preference, so one phone has one answer. Hidden where the browser has no
 * wake lock.
 */
export const WakeSwitch = () => {
  const [on, setOn] = useState(wakePreference);
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return null;
  return (
    <Switch
      label="Keep screen on"
      checked={on}
      onChange={(v) => {
        setWakePreference(v);
        setOn(v);
      }}
    />
  );
};
