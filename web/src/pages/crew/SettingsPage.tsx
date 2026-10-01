import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { ConfirmSheet } from "../../components/ConfirmSheet.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";
import { LocationRow, NameForm, NotificationsRow, SettingsRow } from "../../components/Settings.tsx";
import { leave, setDisplayName, useMe } from "../../lib/session.ts";
import { trpc } from "../../lib/trpc.ts";

export const SettingsPage = () => {
  const me = useMe();
  const utils = trpc.useUtils();
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = me.data && me.data.role === "crew" ? me.data : null;
  const crew = data?.crew ?? null;
  const crewName = crew ? [crew.name, crew.company?.name].filter(Boolean).join(", ") : "Crew";

  const saveName = async (name: string): Promise<boolean> => {
    const ok = await setDisplayName(name);
    if (ok) void utils.shared.me.invalidate();
    return ok;
  };

  return (
    <Page title="Settings">
      <div className="space-y-4">
        <Panel>
          <NameForm initial={data?.displayName ?? ""} save={saveName} />
        </Panel>

        <Panel title="This phone">
          <div className="-my-2 divide-y divide-line">
            <NotificationsRow onLabel="Deliveries and broadcasts" />
            <LocationRow />
          </div>
        </Panel>

        <Panel title="Crew">
          <div className="-mt-2 divide-y divide-line">
            <SettingsRow label={crewName} sub={crew?.leadName ? `Red shirt: ${crew.leadName}` : null} />
            {data?.cc && <SettingsRow label={`CC ${data.cc.name}`} sub={data.day?.label ?? null} />}
            <div className="pt-4">
              <Button variant="danger" size="lg" block onClick={() => setLeaving(true)}>
                Leave crew
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <ConfirmSheet
        open={leaving}
        title={`Leave ${crewName}`}
        body="Rejoin: crew QR code"
        action="Leave crew"
        dismiss="Stay"
        busy={busy}
        onConfirm={() => {
          setBusy(true);
          void leave();
        }}
        onClose={() => setLeaving(false)}
      />
    </Page>
  );
};
