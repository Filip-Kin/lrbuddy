import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmSheet } from "../../components/ConfirmSheet.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";
import { LocationRow, NameForm, NotificationsRow, SettingsRow } from "../../components/Settings.tsx";
import { Switch } from "../../components/Switch.tsx";
import { setWakePreference, wakePreference } from "../../components/driver/hooks.ts";
import { logout, useMe } from "../../lib/session.ts";
import { trpc } from "../../lib/trpc.ts";

const ScreenRow = () => {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  const [on, setOn] = useState(wakePreference);
  if (!supported) return <SettingsRow label="Keep screen on" sub="Not supported on this browser" tone="muted" />;
  return (
    <SettingsRow label="Keep screen on" labelId="lrb-wake" sub={on ? "While open" : "Off"} tone={on ? "green" : "muted"}>
      <Switch
        labelledBy="lrb-wake"
        checked={on}
        onChange={(v) => {
          setWakePreference(v);
          setOn(v);
        }}
      />
    </SettingsRow>
  );
};

export const SettingsPage = () => {
  const me = useMe();
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = me.data && me.data.role === "driver" ? me.data : null;
  const truckName = data?.truck?.name ?? "Truck";
  const initialName = data?.displayName ?? data?.truck?.driverName ?? "";
  const utils = trpc.useUtils();
  const setName = trpc.driver.setName.useMutation();
  const saveName = async (name: string): Promise<boolean> => {
    await setName.mutateAsync({ name });
    void utils.shared.me.invalidate();
    void utils.driver.queue.invalidate();
    return true;
  };

  return (
    <Page title="Settings">
      <div className="space-y-4">
        <Panel>
          <NameForm initial={initialName} save={saveName} />
        </Panel>

        <Panel title="This phone">
          <div className="-my-2 divide-y divide-line">
            <NotificationsRow onLabel="New stops and broadcasts" />
            <LocationRow />
            <ScreenRow />
          </div>
        </Panel>

        <Panel title="Truck">
          <div className="-mt-2 divide-y divide-line">
            <SettingsRow label={truckName} sub={data?.cc ? `CC ${data.cc.name}${data.day ? `, ${data.day.label}` : ""}` : null} />
            <div className="pt-4">
              <Button variant="danger" size="lg" block onClick={() => setLeaving(true)}>
                Leave truck
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <ConfirmSheet
        open={leaving}
        title={`Leave ${truckName}`}
        body="Truck code needed to rejoin"
        action="Leave truck"
        dismiss="Stay"
        busy={busy}
        onConfirm={() => {
          setBusy(true);
          void logout();
        }}
        onClose={() => setLeaving(false)}
      />
    </Page>
  );
};
