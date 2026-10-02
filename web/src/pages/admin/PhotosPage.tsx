import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button, buttonClass } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { DownloadIcon } from "../../components/admin/icons.tsx";
import { FilterSelect } from "../../components/green/ui.tsx";
import { PhotoGallery } from "../../components/photos/Gallery.tsx";
import { MissingAfterToggle } from "../../components/photos/PairPill.tsx";
import { PairsZipButton } from "../../components/photos/PairsZipButton.tsx";
import { STATUS_LABEL, STATUS_ORDER, type LotStatus } from "../../lib/lotStatus.ts";
import { trpc } from "../../lib/trpc.ts";

type Status = LotStatus;
const STATUS_OPTIONS: ReadonlyArray<{ value: Status; label: string }> = STATUS_ORDER.filter((s) => s !== "not_todo").map((s) => ({ value: s, label: STATUS_LABEL[s] }));

const idOrNull = (v: string): number | null => (v === "" ? null : Number(v));

/** Every CC and day: the green gallery with Day and CC filters and the zip download. */
export const PhotosPage = () => {
  const [dayId, setDayId] = useState<number | null>(null);
  const [ccId, setCcId] = useState<number | null>(null);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [crewId, setCrewId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [missingAfter, setMissingAfter] = useState(false);
  const utils = trpc.useUtils();
  const days = trpc.admin.days.list.useQuery(undefined, { retry: false });
  const ccs = trpc.admin.ccs.list.useQuery(undefined, { retry: false });
  const companies = trpc.admin.companies.list.useQuery(undefined, { retry: false });
  const crews = trpc.admin.crews.list.useQuery({ dayId: dayId ?? 0 }, { enabled: dayId !== null });
  const q = trpc.admin.photos.list.useQuery({ dayId, ccId, companyId, crewId, status, missingAfter }, { placeholderData: keepPreviousData, retry: false });
  const d = q.data;
  const noEvent = q.error?.data?.code === "PRECONDITION_FAILED";

  const ccOptions = useMemo(() => (ccs.data ?? []).filter((c) => dayId === null || c.dayId === dayId), [ccs.data, dayId]);
  const crewOptions = useMemo(
    () => (crews.data ?? []).filter((c) => (ccId === null || c.ccId === ccId) && (companyId === null || c.companyId === companyId)),
    [crews.data, ccId, companyId],
  );
  const zipHref = useMemo(() => {
    const p = new URLSearchParams();
    if (dayId !== null) p.set("day", String(dayId));
    if (ccId !== null) p.set("cc", String(ccId));
    const qs = p.toString();
    return `/admin/photos.zip${qs ? `?${qs}` : ""}`;
  }, [dayId, ccId]);

  const clear = (): void => {
    setDayId(null);
    setCcId(null);
    setCompanyId(null);
    setCrewId(null);
    setStatus(null);
    setMissingAfter(false);
  };

  const download =
    d && d.total > 0 ? (
      <a href={zipHref} download className={buttonClass("primary", "md")}>
        <DownloadIcon />
        Download zip
      </a>
    ) : (
      <Button disabled>
        <DownloadIcon />
        Download zip
      </Button>
    );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4 nav:px-6 nav:py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Photos</h1>
        {!noEvent && (
          <div className="flex flex-wrap items-center gap-2">
            {d && d.total > 0 && <PairsZipButton load={() => utils.client.admin.photos.pairsZip.query({ dayId, ccId })} />}
            {download}
          </div>
        )}
      </div>
      {!noEvent && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <FilterSelect
            label="Day"
            value={dayId ?? ""}
            onChange={(e) => {
              setDayId(idOrNull(e.target.value));
              setCcId(null);
              setCrewId(null);
            }}
            className="sm:w-36"
          >
            <option value="">All days</option>
            {(days.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Command center"
            value={ccId ?? ""}
            onChange={(e) => {
              setCcId(idOrNull(e.target.value));
              setCrewId(null);
            }}
            className="sm:w-48"
          >
            <option value="">All CCs</option>
            {ccOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {dayId === null ? `${c.dayLabel}, CC ${c.name}` : `CC ${c.name}`}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Company"
            value={companyId ?? ""}
            onChange={(e) => {
              setCompanyId(idOrNull(e.target.value));
              setCrewId(null);
            }}
            className="sm:w-48"
          >
            <option value="">All companies</option>
            {(companies.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </FilterSelect>
          {dayId !== null && (
            <FilterSelect label="Crew" value={crewId ?? ""} onChange={(e) => setCrewId(idOrNull(e.target.value))} className="sm:w-40">
              <option value="">All crews</option>
              {crewOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </FilterSelect>
          )}
          <FilterSelect label="Status" value={status ?? ""} onChange={(e) => setStatus(e.target.value === "" ? null : (e.target.value as Status))} className="sm:w-44">
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
          <MissingAfterToggle on={missingAfter} onChange={setMissingAfter} />
          {d && d.total > 0 && <span className="col-span-2 text-sm font-semibold text-muted tabular-nums sm:ml-auto">{`${d.pairs.length} of ${d.total}`}</span>}
        </div>
      )}
      {noEvent ? (
        <EmptyState title="No active event" />
      ) : (
        <PhotoGallery pairs={d?.pairs} total={d?.total ?? 0} isLoading={q.isLoading} isError={q.isError} onRetry={() => void q.refetch()} onClearFilters={clear} />
      )}
    </div>
  );
};
