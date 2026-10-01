import { useState } from "react";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { dateTime } from "../../lib/format.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Row = RouterOutputs["admin"]["clientErrors"][number];

/** "Chrome 129 · Android" from a user agent, else the first 40 characters. */
const browser = (ua: string | null): string => {
  if (!ua) return "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const b = /EdgA?\/(\d+)/.exec(ua) ?? /Firefox\/(\d+)/.exec(ua) ?? /(?:Chrome|CriOS)\/(\d+)/.exec(ua) ?? /Version\/(\d+).*Safari/.exec(ua);
  const name = /Edg/.test(ua) ? "Edge" : /Firefox/.test(ua) ? "Firefox" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";
  const label = [name && b ? `${name} ${b[1]}` : name, os].filter(Boolean).join(" · ");
  return label || ua.slice(0, 40);
};

const ErrorRow = ({ row }: { row: Row }) => {
  const [open, setOpen] = useState(false);
  return (
    <li className="space-y-1 px-4 py-3" data-client-error>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-muted">
        <span className="tabular-nums">{dateTime(row.at)}</span>
        {row.role && <span className="font-semibold text-ink">{row.role}</span>}
        {row.url && <span className="min-w-0 break-all">{row.url}</span>}
        <span>{browser(row.userAgent)}</span>
      </div>
      <p className="font-mono text-sm break-words">{row.message}</p>
      {row.stack && (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="min-h-10 text-sm font-semibold text-ink underline">
            Stack
          </button>
          {open && <pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-2 text-xs whitespace-pre-wrap">{row.stack}</pre>}
        </>
      )}
    </li>
  );
};

/** `/admin/client-errors`: the last 200 crash reports from phones and laptops. */
export const ClientErrorsPage = () => {
  const q = trpc.admin.clientErrors.useQuery(undefined, { refetchInterval: 30_000 });
  return (
    <Page title="Client errors" wide>
      <Panel flush>
        {q.isLoading ? (
          <div className="p-4">
            <SkeletonList rows={4} className="h-16" />
          </div>
        ) : (q.data ?? []).length === 0 ? (
          <EmptyState title="No client errors" />
        ) : (
          <ul className="divide-y divide-line">
            {(q.data ?? []).map((r) => (
              <ErrorRow key={r.id} row={r} />
            ))}
          </ul>
        )}
      </Panel>
    </Page>
  );
};

/** `/admin/client-errors/test`: throws while rendering, so the gate can see the error panel and the report. */
export const CrashTest = (): never => {
  throw new Error("Crash test");
};
