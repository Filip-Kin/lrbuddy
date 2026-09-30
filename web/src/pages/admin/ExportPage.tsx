import { useCallback, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { downloadText, slug } from "../../components/admin/download.ts";
import { plural } from "../../components/admin/format.ts";
import { DownloadIcon } from "../../components/admin/icons.tsx";
import { errorText, Notice, type NoticeValue } from "../../components/admin/Notice.tsx";
import { Panel, Skeleton } from "../../components/admin/Panel.tsx";
import { useMe } from "../../lib/session.ts";
import { trpc } from "../../lib/trpc.ts";

type Key = "requests" | "lots" | "positions" | "stockMoves";

const ROWS: ReadonlyArray<{ key: Key; label: string; file: string }> = [
  { key: "requests", label: "Requests", file: "requests" },
  { key: "lots", label: "Lots", file: "lots" },
  { key: "positions", label: "Positions", file: "positions" },
  { key: "stockMoves", label: "Stock moves", file: "stock-moves" },
];

export const ExportPage = () => {
  const counts = trpc.admin.export.counts.useQuery(undefined, { retry: false });
  const me = useMe();
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState<Key | null>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const clear = useCallback(() => setNotice(null), []);
  const eventName = me.data && me.data.role === "admin" ? (me.data.event?.name ?? "") : "";
  const noEvent = counts.error?.data?.code === "PRECONDITION_FAILED";

  const download = async (key: Key, file: string): Promise<void> => {
    setBusy(key);
    try {
      const csv = await utils.admin.export[key].fetch(undefined, { staleTime: 0 });
      const stamp = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Detroit" });
      downloadText(`lrbuddy-${slug(eventName)}-${file}-${stamp}.csv`, csv);
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e, "Download stopped. Try again.") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page title="Export">
      <div className="space-y-4">
        <Notice value={notice} onClear={clear} />
        <Panel flush title={eventName || undefined}>
          {counts.isLoading ? (
            <Skeleton rows={4} className="p-4" />
          ) : noEvent ? (
            <EmptyState title="No active event" />
          ) : (
            <ul className="divide-y divide-line">
              {ROWS.map((r) => {
                const n = counts.data?.[r.key] ?? 0;
                return (
                  <li key={r.key} className="flex min-h-16 items-center gap-3 px-4 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{r.label}</span>
                      <span className="block text-sm text-muted">{n === 0 ? "No rows yet" : plural(n, "row")}</span>
                    </span>
                    <Button variant={n === 0 ? "secondary" : "primary"} busy={busy === r.key} onClick={() => void download(r.key, r.file)} aria-label={`Download ${r.label} CSV`}>
                      <DownloadIcon />
                      CSV
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </Page>
  );
};
