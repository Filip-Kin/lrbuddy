import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FilterSelect } from "../../components/green/ui.tsx";
import { PhotoGallery } from "../../components/photos/Gallery.tsx";
import { MissingAfterToggle } from "../../components/photos/PairPill.tsx";
import { STATUS_LABEL, STATUS_ORDER, type LotStatus } from "../../lib/lotStatus.ts";
import { trpc } from "../../lib/trpc.ts";

type Status = LotStatus;
const STATUS_OPTIONS: ReadonlyArray<{ value: Status; label: string }> = STATUS_ORDER.filter((s) => s !== "not_todo").map((s) => ({ value: s, label: STATUS_LABEL[s] }));

const idOrNull = (v: string): number | null => (v === "" ? null : Number(v));

export const PhotosPage = () => {
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [crewId, setCrewId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [missingAfter, setMissingAfter] = useState(false);
  const q = trpc.green.photos.useQuery({ companyId, crewId, status, missingAfter }, { placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const d = q.data;
  const crews = useMemo(() => (d?.crews ?? []).filter((c) => companyId === null || c.companyId === companyId), [d, companyId]);
  const clear = (): void => {
    setCompanyId(null);
    setCrewId(null);
    setStatus(null);
    setMissingAfter(false);
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4 nav:px-6 nav:py-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Photos</h1>
        {d && d.total > 0 && <span className="text-sm font-semibold text-muted tabular-nums">{`${d.pairs.length} of ${d.total}`}</span>}
      </div>
      {d && d.total > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
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
            {d.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Crew" value={crewId ?? ""} onChange={(e) => setCrewId(idOrNull(e.target.value))} className="sm:w-40">
            <option value="">All crews</option>
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Status" value={status ?? ""} onChange={(e) => setStatus(e.target.value === "" ? null : (e.target.value as Status))} className="sm:w-44">
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
          <MissingAfterToggle on={missingAfter} onChange={setMissingAfter} />
        </div>
      )}
      <PhotoGallery
        pairs={d?.pairs}
        total={d?.total ?? 0}
        isLoading={q.isLoading}
        isError={q.isError}
        onRetry={() => void q.refetch()}
        onClearFilters={clear}
      />
    </div>
  );
};
